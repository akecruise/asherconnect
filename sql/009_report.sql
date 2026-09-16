-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 — รายงานการตอบแชท
--
-- ★ การคำนวณทั้งหมดอยู่ในฐาน Node ไม่โหลดบทสนทนาหรือข้อความมานับเองแม้แต่แถวเดียว
--   ของเดิมโหลด conversations/customers ทั้งตาราง + messages 48 ชม. เข้า memory
--   แล้วคำนวณใน JS ซึ่งแปลว่าหน่วยความจำที่ใช้โตตามจำนวนลูกค้า ไม่ใช่ตามขนาดรายงาน
--   ที่นี่ Node ได้ JSON สรุปไม่กี่ KB แล้วแปลงเป็นข้อความไทยอย่างเดียว
--
-- ที่มาของนิยาม (สำคัญ — อย่าเปลี่ยนโดยไม่ตั้งใจ)
--   reply_stats() ใน Downloads/01_schedule_and_report.sql ของ cloud
--     "รอบถาม" = ข้อความลูกค้าที่ข้อความก่อนหน้าไม่ใช่ลูกค้า
--                (ลูกค้าพิมพ์ติดกันหลายข้อความ = รอบเดียว)
--     "เวลาตอบ" = จากรอบถาม → ข้อความแรกจากฝั่งเราหลังจากนั้น (คนหรือบอทก็ได้)
--     มองย้อนหลัง 2 วันก่อนช่วงรายงาน เพราะคำถามเมื่อวานอาจเพิ่งถูกตอบวันนี้
--
--   sendReplyDigest() ใน bot-webhook — รอบที่ยังไม่มีใครตอบต้องนับด้วย
--     (reply_stats ตัดทิ้งเพราะใช้ cross join lateral) รายงานที่ไม่บอกว่า "ค้างกี่ราย"
--     คือรายงานที่ซ่อนสิ่งที่สำคัญที่สุด
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── guard: ห้ามย้อนรุ่น inbox.refresh_sales_staff_kpi_daily ───────────
-- ★ ไฟล์นี้ create or replace refresh_sales_staff_kpi_daily ด้วย ทั้งที่
--   sql/011_cloud_functions.sql เป็นเจ้าของรุ่นล่าสุดตาม ORDER.txt
--   เกิดจริงแล้ว 2026-09-16: รัน 009 ทั้งไฟล์ (งาน is_test) แล้วรุ่นของ 011
--   ที่ delegate ให้ inbox.reply_stats() ถูกทับเงียบ ๆ กลับไปเป็นสูตรคำนวณเอง
--   ผลตัวเลขเท่ากันก็จริง แต่กลายเป็นสูตรสองที่ที่ต้องแก้พร้อมกันตลอดไป
--
-- ★ ถ้าคุณตั้งใจจะรัน 009 ซ้ำ (เช่น แก้ตัวรายงานให้ไม่นับแชททดสอบ):
--   ให้รัน sql/034_kpi_refresh_resync.sql ต่อทันทีหลังจากนั้น แล้ว guard นี้จะผ่านเอง
--   หรือลบ/คอมเมนต์นิยาม refresh_sales_staff_kpi_daily ในไฟล์นี้ทิ้ง
--   (พร้อมย้าย grant บรรทัด 260/263 ไปไว้กับ 011) เพื่อให้เหลือเจ้าของเดียวถาวร
do $guard$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'inbox' and p.proname = 'refresh_sales_staff_kpi_daily'
                and strpos(pg_get_functiondef(p.oid), 'reply_stats') > 0)
  then
    raise exception 'ฐานนี้มี inbox.refresh_sales_staff_kpi_daily รุ่นที่ delegate ให้ inbox.reply_stats (sql/011 + 034) อยู่แล้ว — ไฟล์นี้จะทับกลับเป็นสูตรคำนวณเองของ 009 จึงหยุดก่อนที่จะมีอะไร commit. ถ้าตั้งใจรัน 009 ซ้ำจริง ให้รัน sql/034_kpi_refresh_resync.sql ต่อทันที';
  end if;
end $guard$;


-- ───────────────────────────────────────────────────────────────────────────
-- 1) สถิติรายคนต่อวัน — เก็บไว้เพื่อไม่ต้องคำนวณย้อนหลังใหม่ทุกครั้ง
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists inbox.sales_staff_kpi_daily (
  report_date       date not null,
  responder         text not null,          -- 'bot' · ชื่อในทีม · 'unknown'
  staff_id          uuid references inbox.sales_staff(id) on delete set null,
  replies           int not null default 0, -- ข้อความที่คนนี้ตอบทั้งหมดในวันนั้น
  first_responses   int not null default 0, -- จำนวนรอบที่เป็นคนแรกที่ตอบ (ใช้วัดเวลา)
  conversations     int not null default 0,
  avg_min           numeric,
  median_min        numeric,
  max_min           numeric,
  computed_at       timestamptz not null default now(),
  primary key (report_date, responder)
);
alter table inbox.sales_staff_kpi_daily enable row level security;
revoke all on inbox.sales_staff_kpi_daily from public, anon, authenticated;
grant select, insert, update, delete on inbox.sales_staff_kpi_daily to service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) รอบการถาม-ตอบ
--
-- คืนทุกรอบในช่วง รวมรอบที่ยังไม่มีใครตอบ (answered_at เป็น null)
--
-- ★ LINE ไม่มี echo เหมือน Messenger
--   ทีมที่ตอบจาก chat.line.biz จะไม่มีข้อความโผล่ในฐานเราเลย รอบนั้นจะดูเหมือน "ค้าง"
--   ทั้งที่ลูกค้าได้คำตอบไปแล้ว — จึงใช้ conversation.last_human_reply_at เป็นตัวสำรอง
--   (ค่านี้มาจากคำสั่งในกลุ่ม หรือ endpoint human_reply)
--   รอบแบบนี้ responder = 'unknown' เพราะรู้แค่ว่ามีคนตอบ ไม่รู้ว่าใคร
--   และติดธง fallback ไว้ให้รายงานบอกจำนวนได้ ไม่ใช่กลืนหายไปในตัวเลขรวม
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.reply_episodes(p_from timestamptz, p_to timestamptz)
returns table (
  conversation_id uuid, channel text, customer_name text,
  asked_at timestamptz, asked_text text,
  answered_at timestamptz, responder text, minutes numeric, fallback boolean
)
language sql stable
set search_path = pg_catalog, public
as $$
with m as (
  select msg.id, msg.conversation_id, msg.created_at, msg.sender_type, msg.sender_id, msg.content,
         lag(msg.sender_type) over (partition by msg.conversation_id order by msg.created_at, msg.id) as prev
    from inbox.message msg
   where msg.created_at >= p_from - interval '2 days'
     and msg.created_at <  p_to
     -- 'system' คือบันทึกเหตุการณ์ (เพิ่มเพื่อน/บล็อก) ไม่ใช่บทสนทนา
     and msg.sender_type in ('contact','agent','bot')
),
episodes as (
  select m.conversation_id, m.created_at as asked_at, m.content as asked_text
    from m
   where m.sender_type = 'contact' and (m.prev is null or m.prev <> 'contact')
),
answered as (
  select e.*,
         r.created_at as answered_at,
         case when r.sender_type = 'bot' then 'bot'
              else coalesce(st.name, u.email, 'unknown') end as responder,
         false as fallback
    from episodes e
    left join lateral (
      select msg.created_at, msg.sender_type, msg.sender_id
        from inbox.message msg
       where msg.conversation_id = e.conversation_id
         and msg.sender_type in ('agent','bot')
         and msg.created_at > e.asked_at
       order by msg.created_at, msg.id
       limit 1
    ) r on true
    left join inbox.sales_staff st on st.user_id = r.sender_id
    left join core."user" u on u.id = r.sender_id
),
-- ตัวสำรองของ LINE: ไม่มีข้อความตอบ แต่มีบันทึกว่าคนตอบไปแล้วหลังรอบนี้
patched as (
  select a.conversation_id, a.asked_at, a.asked_text,
         coalesce(a.answered_at,
                  case when c.last_human_reply_at > a.asked_at then c.last_human_reply_at end) as answered_at,
         case when a.answered_at is not null then a.responder
              when c.last_human_reply_at > a.asked_at then 'unknown' end as responder,
         (a.answered_at is null and c.last_human_reply_at > a.asked_at) as fallback,
         i.channel, ct.display_name
    from answered a
    join inbox.conversation c on c.id = a.conversation_id and not c.is_test
    join inbox.inbox i on i.id = c.inbox_id
    join core.contact ct on ct.id = c.contact_id
)
select p.conversation_id, p.channel, p.display_name,
       p.asked_at, p.asked_text, p.answered_at, p.responder,
       case when p.answered_at is null then null
            else round((extract(epoch from (p.answered_at - p.asked_at)) / 60)::numeric, 1) end,
       p.fallback
  from patched p
 -- ตอบในช่วงรายงาน หรือยังไม่ถูกตอบแต่ถูกถามในช่วงรายงาน
 where (p.answered_at >= p_from and p.answered_at < p_to)
    or (p.answered_at is null and p.asked_at >= p_from and p.asked_at < p_to)
 order by p.asked_at
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) สถิติรายคน — ตรรกะเดียวกับ reply_stats() ของ cloud
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.refresh_sales_staff_kpi_daily(p_day date)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'Asia/Bangkok';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'Asia/Bangkok';
  v_rows int;
begin
  delete from inbox.sales_staff_kpi_daily where report_date = p_day;

  with eps as (
    select * from inbox.reply_episodes(v_from, v_to) where responder is not null
  ),
  first_resp as (
    select responder,
           count(*)::int as first_responses,
           count(distinct conversation_id)::int as conversations,
           round(avg(minutes), 1) as avg_min,
           round((percentile_cont(0.5) within group (order by minutes))::numeric, 1) as median_min,
           round(max(minutes), 1) as max_min
      from eps group by 1
  ),
  totals as (
    select case when msg.sender_type = 'bot' then 'bot'
                else coalesce(st.name, u.email, 'unknown') end as responder,
           count(*)::int as replies
      from inbox.message msg
      left join inbox.sales_staff st on st.user_id = msg.sender_id
      left join core."user" u on u.id = msg.sender_id
     where msg.sender_type in ('agent','bot')
       and msg.created_at >= v_from and msg.created_at < v_to
     group by 1
  )
  insert into inbox.sales_staff_kpi_daily(report_date, responder, staff_id, replies,
                                          first_responses, conversations, avg_min, median_min, max_min)
  select p_day, t.responder,
         (select st.id from inbox.sales_staff st where st.name = t.responder limit 1),
         t.replies, coalesce(f.first_responses,0), coalesce(f.conversations,0),
         f.avg_min, f.median_min, f.max_min
    from totals t left join first_resp f using (responder);

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 4) รายงานหนึ่งวัน เป็น JSON ก้อนเดียว
--
-- Node ได้ก้อนนี้ไปแปลงเป็นข้อความ — ไม่ต้องรู้จักตารางไหนเลย
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.reply_report(p_day date)
returns jsonb
language plpgsql stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'Asia/Bangkok';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'Asia/Bangkok';
  v_result jsonb;
begin
  with eps as (select * from inbox.reply_episodes(v_from, v_to)),
  by_channel as (
    select channel,
           count(*)::int as asked,
           count(*) filter (where responder is not null and responder <> 'bot')::int as human_first,
           count(*) filter (where responder = 'bot')::int as bot_first,
           count(*) filter (where answered_at is null)::int as unanswered,
           round(avg(minutes) filter (where responder is not null and responder <> 'bot'), 1) as human_avg_min,
           round((percentile_cont(0.5) within group (
             order by minutes) filter (where responder is not null and responder <> 'bot'))::numeric, 1) as human_median_min,
           round(avg(minutes) filter (where responder = 'bot'), 1) as bot_avg_min,
           count(*) filter (where responder is not null and responder <> 'bot' and minutes > 30)::int as over30
      from eps group by channel
  ),
  overall as (
    select count(*)::int as asked,
           count(*) filter (where responder is not null and responder <> 'bot')::int as human_first,
           count(*) filter (where responder = 'bot')::int as bot_first,
           count(*) filter (where answered_at is null)::int as unanswered,
           round(avg(minutes) filter (where responder is not null and responder <> 'bot'), 1) as human_avg_min,
           round((percentile_cont(0.5) within group (
             order by minutes) filter (where responder is not null and responder <> 'bot'))::numeric, 1) as human_median_min,
           round(avg(minutes) filter (where responder = 'bot'), 1) as bot_avg_min,
           count(*) filter (where responder is not null and responder <> 'bot' and minutes > 30)::int as over30,
           count(*) filter (where fallback)::int as line_fallback
      from eps
  ),
  -- ใช้ของที่คำนวณเก็บไว้ถ้ามี ไม่งั้นคำนวณสดจากรอบในวันนั้น
  people as (
    select coalesce(
      (select jsonb_agg(jsonb_build_object('responder', k.responder, 'replies', k.replies,
                'first_responses', k.first_responses, 'conversations', k.conversations,
                'avg_min', k.avg_min, 'median_min', k.median_min) order by k.replies desc)
         from inbox.sales_staff_kpi_daily k where k.report_date = p_day and k.responder <> 'bot'),
      (select jsonb_agg(x order by x->>'responder')
         from (select jsonb_build_object('responder', responder, 'replies', count(*)::int,
                        'first_responses', count(*)::int,
                        'conversations', count(distinct conversation_id)::int,
                        'avg_min', round(avg(minutes), 1),
                        'median_min', round((percentile_cont(0.5) within group (order by minutes))::numeric, 1)) as x
                 from eps where responder is not null and responder <> 'bot' group by responder) s),
      '[]'::jsonb) as rows
  ),
  pending as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', to_char(asked_at at time zone 'Asia/Bangkok', 'HH24:MI'),
             'name', coalesce(customer_name, 'ลูกค้าใหม่'),
             'channel', channel,
             'text', left(asked_text, 80)) order by asked_at), '[]'::jsonb) as rows
      from (select * from eps where answered_at is null order by asked_at limit 8) u
  )
  select jsonb_build_object(
    'date', p_day,
    'total', to_jsonb(o) - 'line_fallback',
    'line_fallback', o.line_fallback,
    'platforms', coalesce((select jsonb_agg(to_jsonb(b) order by b.channel) from by_channel b), '[]'::jsonb),
    'people', pe.rows,
    'pending', pd.rows)
    into v_result
    from overall o, people pe, pending pd;

  return v_result;
end $$;

revoke all on function inbox.reply_episodes(timestamptz,timestamptz), inbox.reply_report(date),
                      inbox.refresh_sales_staff_kpi_daily(date)
  from public, anon;
grant execute on function inbox.reply_episodes(timestamptz,timestamptz), inbox.reply_report(date),
                          inbox.refresh_sales_staff_kpi_daily(date)
  to service_role, authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- 5) งานตั้งเวลา — คำนวณ KPI แล้วเข้าคิวแจ้ง Telegram
--
-- ไม่มี HTTP call กลับไปหา Node เลย ฝั่งฐานแค่หย่อนงานลงคิว
-- Node จะมาหยิบไปแปลงเป็นข้อความและส่งเอง
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.enqueue_daily_report(p_day date default ((now() at time zone 'Asia/Bangkok')::date - 1))
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_report jsonb; v_inbox uuid; v_job bigint;
begin
  perform inbox.refresh_sales_staff_kpi_daily(p_day);
  v_report := inbox.reply_report(p_day);

  -- ผูกกับ inbox ตัวใดตัวหนึ่งเพื่อให้ worker ที่ดูแลช่องทางนั้นหยิบไปทำได้
  select id into v_inbox from inbox.inbox where is_active order by created_at limit 1;

  insert into connect_private.job(kind, channel, inbox_id, payload, send_after)
  values ('notify', 'telegram', v_inbox,
          jsonb_build_object('kind', 'daily_report', 'report', v_report), now())
  returning id into v_job;

  return jsonb_build_object('day', p_day, 'job_id', v_job,
                            'asked', v_report->'total'->>'asked');
end $$;

revoke all on function inbox.enqueue_daily_report(date) from public, anon, authenticated;
grant execute on function inbox.enqueue_daily_report(date) to service_role;

commit;
