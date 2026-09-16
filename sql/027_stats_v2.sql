-- =====================================================================
-- ASHER Connect — หน้าสถิติการตอบ (Sales Workspace)  /  027
-- =====================================================================
-- ต่อยอดจากชั้น stats เดิม (016–019) ไม่ได้เขียนใหม่ ไฟล์นี้ทำสี่อย่าง:
--
--   1. ตั้งกติกาเวลาให้ตรงกับที่ใช้จริง — 24 ชม. หัก 00:00–06:00
--      เตือน 5 นาที · เกิน SLA 10 นาที
--   2. ระบบคะแนน (ตารางปรับได้ ไม่ใช่เลขฝังในโค้ด)
--   3. ★ ปิดช่องโหว่สิทธิ์ — ตาราง stats ทั้งห้าใบใน 016 ไม่มี RLS เลยสักใบ
--      ต่างจากตาราง inbox อื่นทุกใบ (เทียบ sql/009_report.sql:41-42)
--   4. ยกด่านทุก RPC ของหน้าสถิติเป็น manager ขึ้นไป
--
-- ★ ตั้งใจ "ไม่แตะ" สองอย่างนี้ เพื่อให้ไฟล์นี้มีรัศมีทำลายแคบที่สุด:
--     - โครงตารางใน 016        (เพิ่มแค่ RLS/grant กับตารางใหม่หนึ่งใบ)
--     - ตัว ingest ใน 017       (stats_ingest / trigger / rebuild / rollup)
--   ที่แก้คือชั้น API ใน 018 กับ "ค่า" ใน sla_policy เท่านั้น
--
-- ★ และไม่แตะ connect_private.api เด็ดขาด — หน้าสถิติเรียก inbox.stats_*
--   ตรง ๆ ผ่าน rpcDirect เหมือน queue_counts ไม่ได้ผ่านประตูนั้น
--   (ตอนนี้มี 8 ไฟล์เขียนทับ connect_api อยู่แล้ว ดู node sql/run.mjs check)
-- =====================================================================

begin;

-- ═══════════════════════════════════════════ 1. กติกาเวลา
--
-- ★ ไม่ได้เขียนคณิตเวลาขึ้นใหม่ — ใช้ inbox.business_seconds() ของ 017 ที่มีอยู่แล้ว
--   แต่ "ตั้งค่า" ให้มันได้ผลเท่ากับกติกาจริง:
--     biz_open = 06:00, biz_close = 24:00  ->  นับ 06:00 ถึงเที่ยงคืน = หัก 00:00–06:00
--   (Postgres รับ time '24:00:00' และ date + time '24:00' = เที่ยงคืนของวันถัดไป)
--
-- ★★ ทำแบบนี้เพราะ inbox.sla_elapsed_minutes() ใน 023 ก็หักช่วงเดียวกันนี้อยู่แล้ว
--    ตัวเลขบนหน้าสถิติกับแท็ก SLA บนการ์ดในหน้าแชทจึงตรงกัน ไม่ใช่สองนิยาม
--    ที่มาบรรจบกันด้วยความบังเอิญ — ค่าที่ใส่ข้างล่างนี้อ่านมาจาก inbox.settings
--    ซึ่งเป็นที่เดียวกับที่ 023 อ่าน ถ้าวันหนึ่งย้ายช่วงหยุดนับ ให้แก้ที่ inbox.settings
--    แล้วรันไฟล์นี้ซ้ำ (รันซ้ำได้) ทั้งสองฝั่งจะขยับตามพร้อมกัน

-- ★ value เป็น jsonb ต้องห่อด้วย to_jsonb() เสมอ — เขียน '00:00' ตรง ๆ
--   จะพังด้วย invalid input syntax for type json เพราะมันไม่ใช่ JSON ที่ถูกต้อง
--   (ส่วน '10' ผ่านได้เพราะตัวเลขเปล่าเป็น JSON ที่ถูกต้อง — เขียนสองแบบปนกันกำกวมกว่าผิด)
insert into inbox.settings(key, value, note) values
  ('sla_minutes',      to_jsonb(10),               'เกินกี่นาทีถือว่าเกิน SLA'),
  ('sla_warn_minutes', to_jsonb(5),                'เกินกี่นาทีถือว่าต้องเตือน'),
  ('sla_pause_start',  to_jsonb('00:00'::text),    'เริ่มหยุดนับ SLA · เวลาไทย'),
  ('sla_pause_end',    to_jsonb('06:00'::text),    'เลิกหยุดนับ SLA · เวลาไทย')
on conflict (key) do nothing;

-- sla_status ใน 017 ตัดสินด้วย target_sec กับ breach_sec เท่านั้น (warn_sec ไม่ถูกใช้):
--   business_sec <= target_sec  -> met     (ตอบใน 5 นาที)
--   business_sec <= breach_sec  -> warn    (5–10 นาที)
--   นอกนั้น                      -> breach  (เกิน 10 นาที)
with v as (
  select inbox.setting_int('sla_warn_minutes', 5)  * 60 as target_sec,
         inbox.setting_int('sla_minutes',     10)  * 60 as breach_sec,
         inbox.setting_time('sla_pause_end',  time '06:00') as biz_open
)
insert into inbox.sla_policy
  (project, channel_key, target_sec, warn_sec, breach_sec, biz_open, biz_close, biz_days, tz, active)
select null, null, v.target_sec, v.target_sec, v.breach_sec, v.biz_open, time '24:00',
       '{1,2,3,4,5,6,7}', 'Asia/Bangkok', true
from v
on conflict do nothing;

update inbox.sla_policy p
   set target_sec = v.target_sec,
       warn_sec   = v.target_sec,
       breach_sec = v.breach_sec,
       biz_open   = v.biz_open,
       biz_close  = time '24:00',
       biz_days   = '{1,2,3,4,5,6,7}',
       tz         = 'Asia/Bangkok',
       updated_at = now()
  from (select inbox.setting_int('sla_warn_minutes', 5) * 60 as target_sec,
               inbox.setting_int('sla_minutes',     10) * 60 as breach_sec,
               inbox.setting_time('sla_pause_end', time '06:00') as biz_open) v
 where p.project is null and p.channel_key is null and p.active;

comment on column inbox.sla_policy.biz_close is
  'เที่ยงคืน = 24:00 คู่กับ biz_open 06:00 แปลว่า "นับ 24 ชม. ยกเว้น 00:00-06:00" ไม่ใช่เวลาทำการออฟฟิศ';


-- ═══════════════════════════════════════════ 2. ระบบคะแนน
--
-- ★ เก็บเป็นตาราง ไม่ใช่เลขในโค้ด เพราะกติกาคะแนนเป็นเรื่องนโยบายของทีม
--   ไม่ใช่ตรรกะของระบบ — วันที่อยากเปลี่ยนน้ำหนักต้องเปลี่ยนได้โดยไม่ deploy
-- ★ หนึ่งแถวเท่านั้น (check id = 1) เพราะยังไม่มีเหตุผลให้มีกติกาต่อทีม
--   ถ้าวันหนึ่งต้องมี ให้เพิ่มคอลัมน์ scope แล้วค่อยถอด check ออก

create table if not exists inbox.score_rule (
  id            smallint primary key default 1 check (id = 1),
  met_points    int not null default 3,   -- ตอบใน 5 นาที
  warn_points   int not null default 2,   -- 5–10 นาที
  breach_points int not null default 1,   -- เกิน 10 นาที  (ตอบช้ายังได้คะแนน)
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
insert into inbox.score_rule(id) values (1) on conflict (id) do nothing;

comment on table inbox.score_rule is
  'น้ำหนักคะแนนของตารางอันดับคนตอบ — ตอบช้ายังได้คะแนนแต่ได้น้อยลง';


-- ═══════════════════════════════════════════ 3. ปิดช่องโหว่สิทธิ์
--
-- ★★ ก่อนไฟล์นี้ ตารางทั้งห้าใบใน 016 ไม่มี RLS และไม่มี revoke เลย
--    แปลว่า sales ที่มี token ของตัวเอง ยิง PostgREST ตรงไปที่
--    inbox.response_window ก็อ่านได้ทั้งตาราง โดยไม่ต้องผ่าน stats_scope()
--    ซึ่งทำให้ด่านทั้งหมดที่เขียนไว้ใน 018 ไม่มีความหมาย
--
-- ★ ปิดแบบเดียวกับ sql/009_report.sql:41-42 คือ RLS + revoke ให้หมด
--   แล้วเปิดทางเดียวผ่าน security definer ข้างล่าง — ตารางไม่มี policy สักข้อ
--   โดยตั้งใจ เพราะไม่มีใครควรอ่านตรง ๆ ได้เลย

alter table inbox.response_window  enable row level security;
alter table inbox.agent_daily_stat enable row level security;
alter table inbox.sla_policy       enable row level security;
alter table inbox.signature_alias  enable row level security;
alter table inbox.stats_error_log  enable row level security;
alter table inbox.score_rule       enable row level security;

revoke all on inbox.response_window, inbox.agent_daily_stat, inbox.sla_policy,
              inbox.signature_alias, inbox.stats_error_log, inbox.score_rule
  from public, anon, authenticated;

-- worker กับสคริปต์รายงานยังต้องเขียน/อ่านได้ (service_role ข้าม RLS อยู่แล้ว
-- แต่ต้องมี grant ระดับตารางด้วย ไม่งั้นได้ 42501 ตั้งแต่ก่อนถึง RLS)
grant select, insert, update on
  inbox.response_window, inbox.agent_daily_stat, inbox.stats_error_log to service_role;
grant select on inbox.sla_policy, inbox.signature_alias, inbox.score_rule to service_role;


-- ═══════════════════════════════════════════ 4. ด่านสิทธิ์
--
-- ★★ จุดสำคัญที่สุดของไฟล์นี้: ยก "พื้น" เป็น manager ที่ฟังก์ชันเดียว
--    แทนที่จะไล่แก้ทุก RPC ทีละตัว — stats_agent_detail กับ stats_conversation
--    ใน 018 เรียก stats_scope('sales') ไว้ และไฟล์นี้ไม่ได้เขียนทับสองตัวนั้น
--    ถ้ายกด่านทีละตัว สองตัวที่ลืมจะกลายเป็นรูที่เปิดค้างไว้เงียบ ๆ
--    การบังคับพื้นที่นี่ทำให้ "ลืมแก้" เป็นไปไม่ได้โดยโครงสร้าง
--
-- ★ raise เป็นคำว่า not_allowed เป๊ะ ๆ เพราะ server.mjs:101 มีคำนี้ใน safeCodes
--   เบราว์เซอร์จึงได้ code ตรง ๆ ไปแปลเป็นภาษาไทยได้ ถ้าใช้ข้อความอื่น
--   จะถูกยุบเป็น request_rejected แล้วผู้ใช้จะเห็นแค่ "บันทึกไม่สำเร็จ"

create or replace function inbox.stats_scope(p_min_role text default 'manager')
returns uuid
language plpgsql
stable
security definer
set search_path = inbox, core, public, pg_temp
as $$
declare v_id uuid; v_role text; v_floor int;
begin
  select a.profile_id, a.role into v_id, v_role from inbox.stats_actor() a;
  if v_id is null then
    raise exception 'not_allowed' using errcode = '28000';
  end if;

  -- พื้นของทั้งหน้าสถิติคือ manager ไม่ว่าผู้เรียกจะส่งอาร์กิวเมนต์อะไรมา
  v_floor := greatest(inbox.role_rank(p_min_role), inbox.role_rank('manager'));
  if inbox.role_rank(v_role) < v_floor then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  -- manager ขึ้นไปเห็นทั้งคิวเสมอ (inbox เป็นคิวรวม ไม่มีเจ้าของเคส)
  return null;
end $$;

comment on function inbox.stats_scope(text) is
  'ด่านของหน้าสถิติ — manager ขึ้นไปเท่านั้น คืน null เพราะเห็นทั้งคิว';


-- ═══════════════════════════════════════════ 5. RPC ของหน้าสถิติ
--
-- ★ ทุกตัวเป็น security definer เพราะข้อ 3 ปิดตารางไปหมดแล้ว ฟังก์ชันพวกนี้
--   คือทางเข้าทางเดียว และ stats_scope() คือด่านของมัน
-- ★ set search_path ทุกตัว — security definer ที่ไม่ตั้ง search_path คือช่องโหว่

-- ตัวช่วย: ตัวกรองช่องทาง/โปรเจกต์ ใช้ร่วมกันทุก RPC
-- ★ ของเดิมมีตัวกรองนี้เฉพาะใน stats_overview — timeline กับ agents ไม่มี
--   ผลคือกดเปลี่ยนช่องทางแล้วการ์ดตัวเลขขยับ แต่กราฟกับตารางอันดับไม่ขยับ
--   สองส่วนบนหน้าจอเดียวกันเลยพูดคนละเรื่อง โดยไม่มีอะไรบอกว่าอันไหนถูก

create or replace function inbox.stats_overview(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = inbox, core, public, pg_temp
as $$
declare
  v_from timestamptz; v_to timestamptz; v_out jsonb; v_rule inbox.score_rule;
begin
  perform inbox.stats_scope('manager');
  v_from := inbox.stats_from(p);
  v_to   := inbox.stats_to(p);
  select * into v_rule from inbox.score_rule where id = 1;

  with w as (
    select * from inbox.response_window
     where inbound_at >= v_from and inbound_at < v_to
       and (p->>'project' is null or project     = p->>'project')
       and (p->>'channel' is null or channel_key = p->>'channel')
  ),
  answered as (select * from w where first_human_at is not null),
  judged   as (select * from w where sla_status <> 'open')
  select jsonb_build_object(
    'range',            jsonb_build_object('from', v_from, 'to', v_to),
    'windows_total',    (select count(*) from w),
    'windows_answered', (select count(*) from answered),
    'unanswered',       (select count(*) from w where first_human_at is null and closed_at is null),
    -- ★ "เกินกำหนดตอนนี้" อ่านจาก sla_status ไม่ใช่ due_at
    --   due_at ตั้งจาก target_sec (5 นาที) ซึ่งเป็นเกณฑ์ "เตือน"
    --   ส่วนคำว่าเกิน SLA ในกติกาคือ 10 นาที ซึ่งตรงกับที่ mark_overdue_windows()
    --   ใช้ (breach_sec) — ถ้าอ่านจาก due_at ตัวเลขนี้จะสูงกว่าความจริงเท่าตัว
    --   ★ ตามหลัง cron ได้ไม่เกิน 5 นาที ซึ่งเป็นรอบของ stats_mark_overdue
    'overdue_now',      (select count(*) from w
                          where first_human_at is null and closed_at is null and sla_status = 'breach'),
    'frt_p50_sec',      (select percentile_cont(0.5) within group (order by business_sec)::int from answered),
    'frt_p90_sec',      (select percentile_cont(0.9) within group (order by business_sec)::int from answered),
    'frt_avg_sec',      (select avg(business_sec)::int from answered),
    'bot_p50_sec',      (select percentile_cont(0.5) within group
                           (order by extract(epoch from (first_bot_at - inbound_at)))::int
                         from w where first_bot_at is not null),
    'sla_met',          (select count(*) from w where sla_status = 'met'),
    'sla_warn',         (select count(*) from w where sla_status = 'warn'),
    'sla_breach',       (select count(*) from w where sla_status = 'breach'),
    'within_target_pct',(select round(100.0 * count(*) filter (where sla_status='met')
                                     / nullif(count(*),0), 1) from judged),
    'over_breach_pct',  (select round(100.0 * count(*) filter (where sla_status='breach')
                                     / nullif(count(*),0), 1) from judged),
    -- ★ ไม่ใช่ error — คือสัดส่วนงานที่ยังตอบนอก Connect (ตอบจาก Page / ของเก่า)
    --   ทีมย้ายเข้ามาตอบในระบบมากขึ้นเมื่อไหร่ ตัวเลขนี้จะลดลงเอง
    'attribution_gap_pct', (select round(100.0 * count(*) filter (where responder_id is null)
                                         / nullif(count(*),0), 1) from answered),
    'thresholds',       jsonb_build_object(
                          'warn_minutes',   inbox.setting_int('sla_warn_minutes', 5),
                          'breach_minutes', inbox.setting_int('sla_minutes', 10)),
    'score_weights',    jsonb_build_object(
                          'met',    coalesce(v_rule.met_points, 3),
                          'warn',   coalesce(v_rule.warn_points, 2),
                          'breach', coalesce(v_rule.breach_points, 1)),
    'by_channel',       (select coalesce(jsonb_agg(x order by x->>'channel_key'), '[]'::jsonb) from (
                           select jsonb_build_object(
                             'channel_key', channel_key,
                             'windows', count(*),
                             'frt_p50_sec', percentile_cont(0.5) within group (order by business_sec)::int,
                             'sla_rate', round(100.0*count(*) filter (where sla_status='met')
                                               / nullif(count(*) filter (where sla_status<>'open'),0),1)
                           ) x from w group by channel_key) s),
    'by_project',       (select coalesce(jsonb_agg(x order by x->>'project'), '[]'::jsonb) from (
                           select jsonb_build_object(
                             'project', coalesce(project,'-'),
                             'windows', count(*),
                             'frt_p50_sec', percentile_cont(0.5) within group (order by business_sec)::int,
                             'sla_rate', round(100.0*count(*) filter (where sla_status='met')
                                               / nullif(count(*) filter (where sla_status<>'open'),0),1)
                           ) x from w group by project) s)
  ) into v_out;
  return v_out;
end $$;


-- ตารางอันดับคนตอบ
--
-- ★ group ด้วย (responder_id, responder_src) ไม่ใช่ responder_id อย่างเดียว
--   ของเดิมยุบ page กับ unassigned รวมเป็นแถว null แถวเดียว ทำให้
--   "ตอบจาก Facebook Page โดยตรง" ซึ่งเป็นข้อมูลที่ต้องเห็น หายไปกับของที่จับไม่ได้
-- ★ คนที่ตอบผ่าน Connect (workspace) เท่านั้นที่มีคะแนนและอันดับ
--   page/unassigned ไม่ใช่ "คน" จึงจัดอันดับไม่ได้ แต่ต้องแสดง เพราะมันคือ
--   ปริมาณงานที่หลุดออกนอกระบบ หน้าจอเป็นคนตัดสินว่าจะวางแถวพวกนี้ไว้ตรงไหน

create or replace function inbox.stats_agents(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = inbox, core, public, pg_temp
as $$
declare v_from timestamptz; v_to timestamptz; v_rule inbox.score_rule;
begin
  perform inbox.stats_scope('manager');
  v_from := inbox.stats_from(p);
  v_to   := inbox.stats_to(p);
  select * into v_rule from inbox.score_rule where id = 1;

  return (
    select coalesce(jsonb_agg(r order by r->'score' desc nulls last), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'responder_id',  w.responder_id,
        'responder_src', w.responder_src,
        -- ชื่อมีเฉพาะคนที่ระบุตัวได้ ที่เหลือคืน null ให้หน้าจอตั้งป้ายเอง
        'name',          coalesce(pr.signature, pu.email),
        'windows',       count(*),
        'frt_p50_sec',   percentile_cont(0.5) within group (order by w.business_sec)::int,
        'frt_p90_sec',   percentile_cont(0.9) within group (order by w.business_sec)::int,
        'sla_met',       count(*) filter (where w.sla_status = 'met'),
        'sla_warn',      count(*) filter (where w.sla_status = 'warn'),
        'sla_breach',    count(*) filter (where w.sla_status = 'breach'),
        'sla_rate',      round(100.0 * count(*) filter (where w.sla_status='met')
                               / nullif(count(*) filter (where w.sla_status<>'open'), 0), 1),
        -- ★ คะแนนคิดที่ฐาน ไม่ใช่ที่เบราว์เซอร์ เพราะรายงาน Telegram ต้องใช้เลขชุดเดียวกัน
        'score',         sum(case w.sla_status
                               when 'met'    then coalesce(v_rule.met_points, 3)
                               when 'warn'   then coalesce(v_rule.warn_points, 2)
                               when 'breach' then coalesce(v_rule.breach_points, 1)
                               else 0 end),
        'first_active',  min(w.first_human_at),
        'last_active',   max(w.first_human_at)
      ) r
      from inbox.response_window w
      left join core.profile pr on pr.user_id = w.responder_id
      left join core."user"  pu on pu.id      = w.responder_id
      where w.inbound_at >= v_from and w.inbound_at < v_to
        and w.first_human_at is not null
        and (p->>'project' is null or w.project     = p->>'project')
        and (p->>'channel' is null or w.channel_key = p->>'channel')
      group by w.responder_id, w.responder_src, pr.signature, pu.email
    ) s
  );
end $$;


-- กราฟตามเวลา — bucket: hour | day | week | month | dow_hour
-- ★ เพิ่มตัวกรอง project/channel ที่ของเดิมไม่มี (ทั้งสองสาขา)
create or replace function inbox.stats_timeline(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = inbox, core, public, pg_temp
as $$
declare
  v_from timestamptz; v_to timestamptz;
  v_b  text := coalesce(p->>'bucket', 'day');
  v_tz text := coalesce(p->>'tz', 'Asia/Bangkok');
  v_project text := p->>'project';
  v_channel text := p->>'channel';
begin
  perform inbox.stats_scope('manager');
  v_from := inbox.stats_from(p);
  v_to   := inbox.stats_to(p);

  if v_b not in ('hour','day','week','month','dow_hour') then
    raise exception 'stats: bucket ไม่ถูกต้อง (%)', v_b using errcode = '22023';
  end if;

  if v_b = 'dow_hour' then
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'dow', dow, 'hour', hr, 'windows', n, 'frt_p50_sec', p50)), '[]'::jsonb)
            from (
              select extract(isodow from inbound_at at time zone v_tz)::int as dow,
                     extract(hour   from inbound_at at time zone v_tz)::int as hr,
                     count(*) as n,
                     percentile_cont(0.5) within group (order by business_sec)::int as p50
                from inbox.response_window
               where inbound_at >= v_from and inbound_at < v_to
                 and (v_project is null or project     = v_project)
                 and (v_channel is null or channel_key = v_channel)
               group by 1,2) s);
  end if;

  return (select coalesce(jsonb_agg(jsonb_build_object(
            'bucket', bkt, 'windows', n, 'answered', ans,
            'frt_p50_sec', p50, 'sla_rate', rate) order by bkt), '[]'::jsonb)
          from (
            select to_char(date_trunc(v_b, inbound_at at time zone v_tz),
                     case when v_b='hour' then 'YYYY-MM-DD HH24:00' else 'YYYY-MM-DD' end) as bkt,
                   count(*) as n,
                   count(*) filter (where first_human_at is not null) as ans,
                   percentile_cont(0.5) within group (order by business_sec)::int as p50,
                   round(100.0*count(*) filter (where sla_status='met')
                         / nullif(count(*) filter (where sla_status<>'open'),0),1) as rate
              from inbox.response_window
             where inbound_at >= v_from and inbound_at < v_to
               and (v_project is null or project     = v_project)
               and (v_channel is null or channel_key = v_channel)
             group by 1) s);
end $$;


-- คิวค้างตอบแบบสด — ไฟล์นี้ไม่ได้เปลี่ยนตรรกะ แค่ห่อด่านกับ security definer
-- ให้เหมือนตัวอื่น (ของเดิมเป็น security invoker ซึ่งอ่านตารางไม่ได้แล้วหลังข้อ 3)
create or replace function inbox.stats_open_windows(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = inbox, core, public, pg_temp
as $$
begin
  perform inbox.stats_scope('manager');
  return (
    select coalesce(jsonb_agg(x order by x->>'due_at'), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'conversation_id', w.conversation_id,
        'channel_key',     w.channel_key,
        'project',         w.project,
        'inbound_at',      w.inbound_at,
        'inbound_count',   w.inbound_count,
        'due_at',          w.due_at,
        'waiting_minutes', inbox.sla_elapsed_minutes(w.inbound_at, now()),
        'sla_status',      w.sla_status
      ) x
      from inbox.response_window w
      where w.closed_at is null and w.first_human_at is null
        and (p->>'project' is null or w.project     = p->>'project')
        and (p->>'channel' is null or w.channel_key = p->>'channel')
      limit 200
    ) s
  );
end $$;


-- ═══════════════════════════════════════════ 6. สิทธิ์เรียกฟังก์ชัน
--
-- ★ ทางเข้าทางเดียวของหน้าสถิติ — ตารางปิดหมดแล้วในข้อ 3
--   ให้ authenticated เรียกได้ แล้วให้ stats_scope() เป็นคนปฏิเสธ
--   ไม่ใช่ปฏิเสธด้วยการไม่ grant เพราะถ้าไม่ grant จะได้ error คนละแบบ
--   (42883 function does not exist) ซึ่งอ่านแล้วเข้าใจผิดว่าระบบยังไม่ได้ลง

revoke all on function
  inbox.stats_overview(jsonb), inbox.stats_agents(jsonb),
  inbox.stats_timeline(jsonb), inbox.stats_open_windows(jsonb),
  inbox.stats_scope(text)
  from public, anon;

grant execute on function
  inbox.stats_overview(jsonb), inbox.stats_agents(jsonb),
  inbox.stats_timeline(jsonb), inbox.stats_open_windows(jsonb)
  to authenticated, service_role;

-- รายงาน Telegram ยิงด้วย service_role จากสคริปต์ Node ไม่ผ่านด่าน manager
-- (ตัวมันเองไม่ได้เรียก stats_scope อยู่แล้ว — ดู sql/018:290)
grant execute on function
  inbox.stats_telegram_daily(date), inbox.rollup_agent_daily(date, text)
  to service_role;


-- ═══════════════════════════════════════════ 7. รายงาน Telegram
--
-- ★ ใช้เลขชุดเดียวกับหน้าสถิติ — คะแนนคิดจาก inbox.score_rule ที่เดียวกัน
--   ถ้าคิดแยกกัน อันดับในกลุ่มกับอันดับบนหน้าจอจะไม่ตรงกัน แล้วไม่มีทางรู้ว่าอันไหนถูก
-- ★ อ่านจาก agent_daily_stat (rollup) ไม่คำนวณสดจาก response_window
--   เหมือนของเดิม — รายงานรายวันไม่ควรไปกวาดตารางหลักทุกเช้า

create or replace function inbox.stats_telegram_daily(
  p_date date default (now() at time zone 'Asia/Bangkok')::date - 1)
returns text
language plpgsql
stable
security definer
set search_path = inbox, core, public, pg_temp
as $$
declare v_txt text; r record; v_tot int; v_rate numeric; v_rule inbox.score_rule;
begin
  select * into v_rule from inbox.score_rule where id = 1;

  select sum(windows_handled),
         round(100.0*sum(sla_met)/nullif(sum(sla_met+sla_warn+sla_breach),0),1)
    into v_tot, v_rate
    from inbox.agent_daily_stat where stat_date = p_date;

  v_txt := format('📊 สรุปการตอบ %s'||E'
'||'รอบที่ตอบ: %s | ตอบใน %s นาที: %s%%'||E'
',
                  to_char(p_date,'DD/MM/YYYY'), coalesce(v_tot,0),
                  inbox.setting_int('sla_warn_minutes', 5), coalesce(v_rate,0));

  for r in
    select coalesce(coalesce(pr.signature, pu.email),'ยังระบุตัวไม่ได้') as name,
           a.responder_id,
           sum(a.windows_handled) w,
           max(a.frt_p50_sec) p50,
           round(100.0*sum(a.sla_met)/nullif(sum(a.sla_met+a.sla_warn+a.sla_breach),0),1) rate,
           sum(a.sla_met)    * coalesce(v_rule.met_points, 3)
         + sum(a.sla_warn)   * coalesce(v_rule.warn_points, 2)
         + sum(a.sla_breach) * coalesce(v_rule.breach_points, 1) as score
      from inbox.agent_daily_stat a
      left join core.profile pr on pr.user_id = a.responder_id
      left join core."user"  pu on pu.id      = a.responder_id
     where a.stat_date = p_date
     group by 1, 2
     -- ★ คนที่ระบุตัวได้ขึ้นก่อนเสมอ แถวที่ระบุไม่ได้ไปท้ายสุด
     --   เพราะมันไม่ใช่คน เอาไปปนในอันดับไม่ได้
     order by (a.responder_id is null), score desc nulls last
  loop
    v_txt := v_txt || format(E'
• %s — %s รอบ | ตอบกลาง %s นาที | SLA %s%% | %s คะแนน',
               r.name, r.w, round(coalesce(r.p50,0)/60.0,1), coalesce(r.rate,0), coalesce(r.score,0));
  end loop;
  return v_txt;
end $$;

commit;

-- =====================================================================
-- หลังลงไฟล์นี้ ต้องคำนวณตัวเลขเก่าใหม่ทั้งชุด เพราะนิยาม SLA เปลี่ยน
-- (ของเดิม met = 15 นาทีในเวลาทำการ 09:00–20:00 ของใหม่ = 5 นาทีแบบหัก 00:00–06:00)
-- แถวเก่าที่คำนวณด้วยนิยามเดิมจะค้างอยู่จนกว่าจะสั่ง rebuild:
--
--   select inbox.rebuild_windows('2026-08-01', now());
--   select inbox.rollup_agent_daily(d) from generate_series(
--            '2026-08-01'::date, current_date, interval '1 day') d;
--
-- ★ ถ้าไม่ทำ ตัวเลขบนหน้าสถิติจะเป็นของสองนิยามปนกัน โดยไม่มีอะไรบอก
-- =====================================================================
