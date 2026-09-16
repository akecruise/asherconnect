-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 (ต่อ) — สองเรื่องที่รออนุมัติแล้วได้ไฟเขียว
--
--   1. สถิติรายสัปดาห์ / รายเดือน  (build_reply_report_weekly / _monthly ของ cloud)
--   2. ของสามอย่างจาก edge function daily-report เอามารวมกับรายงานของเรา
--        SLA 5 นาที · P90 · งานค้างสะสมข้ามวัน
--      และรายงานกลางวัน 20:00 ที่สรุป "วันนี้เท่าที่ผ่านมา"
--
-- ที่มา: README ใน Downloads/asher-daily-report.zip
--   "SLA รวม 5 นาที: ตัวหารคือรอบที่ตอบแล้ว + รอบค้างที่รอเกินเป้า
--    รอบค้างที่ยังไม่เกินเป้าแสดงต่างหาก"
--   "ค่ากลาง/P90 ใช้รอบตอบแล้ว · P90 ใช้ nearest rank · ไม่ใช้ 0 แทนไม่มีข้อมูล"
--   "งานค้างมาจากทุกวันในประวัติที่ยังไม่มีคำตอบ ณ จุดตัด รวมรอบค้างก่อนวันรายงาน"
--
-- ★ สิ่งที่ไม่เอามาด้วยโดยตั้งใจ: ของเดิมโหลดได้ถึง 100,000 แถวเข้า memory แล้วนับใน JS
--   ที่นี่นับในฐานทั้งหมดเหมือนเดิม Node ยังได้แต่ JSON สรุป
--
-- ★ ของเดิมนับ "ภาพรวม" จากรอบที่ *เริ่ม* ในช่วงรายงาน ส่วนของเรานับจากรอบที่ *ถูกตอบ*
--   ในช่วงรายงาน (ตาม reply_stats ของ cloud ซึ่งเป็นตัวที่เทสต์ Phase 7 ตรึงไว้)
--   จึงไม่ไปแก้ของเดิม แต่เพิ่มตัวเลขใหม่เข้าไปโดยตั้งชื่อให้รู้ว่าวัดคนละอย่าง
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1) สถิติรายสัปดาห์ / รายเดือน — โครงเดียวกับรายวันเป๊ะ
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists inbox.sales_staff_kpi_weekly (
  week_start      date not null,
  responder       text not null,
  staff_id        uuid references inbox.sales_staff(id) on delete set null,
  replies         int not null default 0,
  first_responses int not null default 0,
  conversations   int not null default 0,
  avg_min         numeric,
  median_min      numeric,
  max_min         numeric,
  computed_at     timestamptz not null default now(),
  primary key (week_start, responder)
);

create table if not exists inbox.sales_staff_kpi_monthly (
  month_start     date not null,
  responder       text not null,
  staff_id        uuid references inbox.sales_staff(id) on delete set null,
  replies         int not null default 0,
  first_responses int not null default 0,
  conversations   int not null default 0,
  avg_min         numeric,
  median_min      numeric,
  max_min         numeric,
  computed_at     timestamptz not null default now(),
  primary key (month_start, responder)
);

alter table inbox.sales_staff_kpi_weekly  enable row level security;
alter table inbox.sales_staff_kpi_monthly enable row level security;
revoke all on inbox.sales_staff_kpi_weekly, inbox.sales_staff_kpi_monthly
  from public, anon, authenticated;
grant select, insert, update, delete
  on inbox.sales_staff_kpi_weekly, inbox.sales_staff_kpi_monthly to service_role;

-- ค่าเริ่มต้นเหมือนของ cloud: สัปดาห์ที่แล้ว / เดือนที่แล้ว นับจาก "เมื่อวาน"
create or replace function inbox.build_reply_report_weekly(
  p_week_start date default date_trunc('week', (now() at time zone 'Asia/Bangkok')::date - 1)::date)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz := p_week_start::timestamp at time zone 'Asia/Bangkok';
  v_to   timestamptz := (p_week_start + 7)::timestamp at time zone 'Asia/Bangkok';
  v_rows int;
begin
  delete from inbox.sales_staff_kpi_weekly where week_start = p_week_start;
  insert into inbox.sales_staff_kpi_weekly(week_start, responder, staff_id, replies,
                                           first_responses, conversations, avg_min, median_min, max_min)
  select p_week_start, s.responder,
         (select st.id from inbox.sales_staff st where st.name = s.responder limit 1),
         s.replies, s.first_responses, s.conversations, s.avg_min, s.median_min, s.max_min
    from inbox.reply_stats(v_from, v_to) s;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

create or replace function inbox.build_reply_report_monthly(
  p_month_start date default date_trunc('month', (now() at time zone 'Asia/Bangkok')::date - 1)::date)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz := p_month_start::timestamp at time zone 'Asia/Bangkok';
  v_to   timestamptz := (p_month_start + interval '1 month')::timestamp at time zone 'Asia/Bangkok';
  v_rows int;
begin
  delete from inbox.sales_staff_kpi_monthly where month_start = p_month_start;
  insert into inbox.sales_staff_kpi_monthly(month_start, responder, staff_id, replies,
                                            first_responses, conversations, avg_min, median_min, max_min)
  select p_month_start, s.responder,
         (select st.id from inbox.sales_staff st where st.name = s.responder limit 1),
         s.replies, s.first_responses, s.conversations, s.avg_min, s.median_min, s.max_min
    from inbox.reply_stats(v_from, v_to) s;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) รายงานรุ่นที่มี SLA · P90 · งานค้างสะสม และรองรับ "วันนี้เท่าที่ผ่านมา"
--
-- ต้อง drop ตัวเดิมก่อน ไม่งั้นจะกลายเป็น overload สองตัว
-- แล้วการเรียกด้วยอาร์กิวเมนต์เดียวจะกำกวมทันที
-- ───────────────────────────────────────────────────────────────────────────
drop function if exists inbox.reply_report(date);

create or replace function inbox.reply_report(p_day date, p_until timestamptz default null)
returns jsonb
language plpgsql stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from   timestamptz := p_day::timestamp at time zone 'Asia/Bangkok';
  v_to     timestamptz := coalesce(p_until, (p_day + 1)::timestamp at time zone 'Asia/Bangkok');
  v_target int := 5;                       -- เป้า SLA เป็นนาที ตามของเดิม
  v_backlog_days int := 30;                -- ย้อนหลังแค่ไหนถึงจะเรียกว่า "ประวัติ"
  v_result jsonb;
begin
  with eps as (select * from inbox.reply_episodes(v_from, v_to)),
  human as (select * from eps where responder is not null and responder <> 'bot'),
  -- งานค้างสะสม: ทุกรอบในประวัติที่ยังไม่มีคำตอบ ณ จุดตัด ไม่ใช่เฉพาะของวันนี้
  -- ของเดิมย้ำว่ารอบค้างก่อนวันรายงานต้องรวมด้วย ไม่งั้นรายงานจะดูดีขึ้นทุกวันทั้งที่งานกองอยู่
  backlog as (
    select * from inbox.reply_episodes(v_from - make_interval(days => v_backlog_days), v_to)
     where answered_at is null
  ),
  stat as (
    select count(*)::int as asked,
           count(*) filter (where responder is not null and responder <> 'bot')::int as human_first,
           count(*) filter (where responder = 'bot')::int as bot_first,
           count(*) filter (where answered_at is null)::int as unanswered,
           round(avg(minutes) filter (where responder is not null and responder <> 'bot'), 1) as human_avg_min,
           round((percentile_cont(0.5) within group (
             order by minutes) filter (where responder is not null and responder <> 'bot'))::numeric, 1) as human_median_min,
           -- P90 แบบ nearest rank = ค่าที่มีอยู่จริงในชุดข้อมูล ไม่ใช่ค่าที่ประมาณขึ้นมา
           round((percentile_disc(0.9) within group (
             order by minutes) filter (where responder is not null and responder <> 'bot'))::numeric, 1) as human_p90_min,
           round(avg(minutes) filter (where responder = 'bot'), 1) as bot_avg_min,
           count(*) filter (where responder is not null and responder <> 'bot' and minutes > 30)::int as over30,
           count(*) filter (where fallback)::int as line_fallback
      from eps
  ),
  by_channel as (
    select channel,
           count(*)::int as asked,
           count(*) filter (where responder is not null and responder <> 'bot')::int as human_first,
           count(*) filter (where responder = 'bot')::int as bot_first,
           count(*) filter (where answered_at is null)::int as unanswered,
           round(avg(minutes) filter (where responder is not null and responder <> 'bot'), 1) as human_avg_min,
           round((percentile_cont(0.5) within group (
             order by minutes) filter (where responder is not null and responder <> 'bot'))::numeric, 1) as human_median_min,
           round((percentile_disc(0.9) within group (
             order by minutes) filter (where responder is not null and responder <> 'bot'))::numeric, 1) as human_p90_min,
           round(avg(minutes) filter (where responder = 'bot'), 1) as bot_avg_min,
           count(*) filter (where responder is not null and responder <> 'bot' and minutes > 30)::int as over30
      from eps group by channel
  ),
  -- SLA: ตัวหารคือ "รอบที่ตัดสินได้แล้ว" = ตอบแล้ว + ค้างจนเกินเป้าไปแล้ว
  -- รอบที่ค้างอยู่แต่ยังไม่เกินเป้า ยังตัดสินไม่ได้ จึงแยกออกมาไม่เอาไปหาร
  -- (ถ้าเอาไปนับเป็น "ไม่ทัน" รายงานตอนบ่ายจะดูแย่กว่าความจริงเสมอ)
  sla as (
    select v_target as target_min,
           count(*) filter (where answered_at is not null and minutes <= v_target)::int as within,
           count(*) filter (where answered_at is not null and minutes >  v_target)::int as late,
           count(*) filter (where answered_at is null
                              and extract(epoch from (v_to - asked_at))/60 >  v_target)::int as waiting_over,
           count(*) filter (where answered_at is null
                              and extract(epoch from (v_to - asked_at))/60 <= v_target)::int as waiting_within
      from eps
  ),
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
                 from human group by responder) s),
      '[]'::jsonb) as rows
  ),
  pending as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'at', to_char(asked_at at time zone 'Asia/Bangkok', 'HH24:MI'),
             'name', coalesce(customer_name, 'ลูกค้าใหม่'),
             'channel', channel,
             'text', left(asked_text, 80)) order by asked_at), '[]'::jsonb) as rows
      from (select * from eps where answered_at is null order by asked_at limit 8) u
  ),
  backlog_sum as (
    select count(*)::int as total,
           to_char(min(asked_at) at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') as oldest_at,
           coalesce(jsonb_agg(jsonb_build_object(
             'at', to_char(asked_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI'),
             'name', coalesce(customer_name, 'ลูกค้าใหม่'),
             'channel', channel,
             'text', left(asked_text, 80)) order by asked_at)
             filter (where asked_at < v_from), '[]'::jsonb) as older_rows
      from backlog
  )
  select jsonb_build_object(
    'date', p_day,
    'partial', p_until is not null,
    'until', to_char(v_to at time zone 'Asia/Bangkok', 'HH24:MI'),
    'total', to_jsonb(s) - 'line_fallback',
    'line_fallback', s.line_fallback,
    'sla', to_jsonb(sl),
    'platforms', coalesce((select jsonb_agg(to_jsonb(b) order by b.channel) from by_channel b), '[]'::jsonb),
    'people', pe.rows,
    'pending', pd.rows,
    'backlog', jsonb_build_object('days', v_backlog_days, 'total', bl.total,
                                  'oldest_at', bl.oldest_at, 'older_than_today', bl.older_rows))
    into v_result
    from stat s, sla sl, people pe, pending pd, backlog_sum bl;

  return v_result;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) เข้าคิวรายงาน — รองรับทั้งรายงานเต็มวันและรายงานกลางวัน
-- ───────────────────────────────────────────────────────────────────────────
drop function if exists inbox.enqueue_daily_report(date);

create or replace function inbox.enqueue_daily_report(
  p_day date default ((now() at time zone 'Asia/Bangkok')::date - 1),
  p_partial boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_report jsonb; v_inbox uuid; v_job bigint;
begin
  -- รายงานกลางวันเป็นภาพ ณ ตอนนั้น ไม่ใช่ของที่จบแล้ว จึงไม่ไปทับสถิติรายวันที่เก็บไว้
  if not p_partial then perform inbox.refresh_sales_staff_kpi_daily(p_day); end if;

  v_report := inbox.reply_report(p_day, case when p_partial then now() end);

  select id into v_inbox from inbox.inbox where is_active order by created_at limit 1;

  insert into connect_private.job(kind, channel, inbox_id, payload, send_after)
  values ('notify', 'telegram', v_inbox,
          jsonb_build_object('kind', 'daily_report', 'report', v_report), now())
  returning id into v_job;

  return jsonb_build_object('day', p_day, 'partial', p_partial, 'job_id', v_job,
                            'asked', v_report->'total'->>'asked');
end $$;

revoke all on function inbox.reply_report(date,timestamptz), inbox.enqueue_daily_report(date,boolean),
                      inbox.build_reply_report_weekly(date), inbox.build_reply_report_monthly(date)
  from public, anon;
grant execute on function inbox.reply_report(date,timestamptz) to service_role, authenticated;
grant execute on function inbox.enqueue_daily_report(date,boolean),
                          inbox.build_reply_report_weekly(date), inbox.build_reply_report_monthly(date)
  to service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- 4) ตารางงาน — คงค่า UTC เดิมของ cloud ทุกตัว
--
--   asher-report-weekly   20 17 * * 0   (= จันทร์ 00:20 ไทย)
--   asher-report-monthly  30 17 * * *   (= 00:30 ไทย ทำจริงเฉพาะวันที่ 1 ตามเวลาไทย)
--   asher-report-2000      0 13 * * *   (= 20:00 ไทย) รายงานวันนี้เท่าที่ผ่านมา
-- ───────────────────────────────────────────────────────────────────────────
select cron.unschedule(jobid) from cron.job
 where jobname in ('asher-report-weekly','asher-report-monthly','asher-report-2000');

select cron.schedule('asher-report-weekly',  '20 17 * * 0',
                     $cron$select inbox.build_reply_report_weekly()$cron$);

-- เงื่อนไขวันที่ 1 ยกมาจากของเดิมทั้งบรรทัด — cron เดินทุกวันแต่ทำงานจริงเดือนละครั้ง
select cron.schedule('asher-report-monthly', '30 17 * * *',
                     $cron$select inbox.build_reply_report_monthly()
                            where extract(day from (now() at time zone 'Asia/Bangkok')) = 1$cron$);

select cron.schedule('asher-report-2000',    '0 13 * * *',
                     $cron$select inbox.enqueue_daily_report((now() at time zone 'Asia/Bangkok')::date, true)$cron$);

commit;
