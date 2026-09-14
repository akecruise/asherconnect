-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 — ย้าย SQL function ของ cloud เข้า schema inbox
--
-- ที่มา: Downloads/01_schedule_and_report.sql (ของจริงจาก cloud)
--        reference/cloud-functions.sql ที่ PLAN อ้างถึงยังหาไม่เจอ ดู docs/inventory.md
--
-- ★ ย้ายเฉพาะตัวที่ตารางปลายทางมีอยู่แล้วใน inbox
--   ตัวที่ต้องสร้างตารางใหม่ถูกกันไว้ให้คนตัดสินก่อน (ดูท้ายไฟล์)
--
-- ★ ไม่มี net.http_post ที่ไหนเลย งานตั้งเวลาที่ต้องส่งข้อความออก
--   จะหย่อนงานลงคิวขาออกอย่างเดียว (inbox.enqueue_daily_report)
--   ของเดิมบน cloud ยิง HTTP กลับไปหา edge function ซึ่งแปลว่า
--   "cron สำเร็จ" หมายถึงแค่คำขอถูกส่ง ไม่ได้แปลว่าทีมได้รับข้อความ
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1) reply_stats — สถิติผู้ตอบในช่วงเวลาหนึ่ง
--
-- ของเดิมนิยาม "รอบถาม" ซ้ำอีกรอบในตัวมันเอง ที่นี่เรียก inbox.reply_episodes()
-- แทนการคัดลอกตรรกะมาวาง เพราะนิยามของ "หนึ่งรอบ" ควรมีที่เดียวในระบบ
-- ถ้ามีสองที่ วันหนึ่งมันจะต่างกันแล้วไม่มีใครรู้ว่าอันไหนถูก
--
-- ผลลัพธ์เทียบเท่าของเดิมทุกคอลัมน์ (ชื่อคอลัมน์เวลาใช้ avg_min/median_min/max_min
-- ตามที่ตาราง inbox.sales_staff_kpi_daily ใช้อยู่)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.reply_stats(p_from timestamptz, p_to timestamptz)
returns table (
  responder text, replies int, first_responses int, conversations int,
  avg_min numeric, median_min numeric, max_min numeric
)
language sql stable
security definer
set search_path = pg_catalog, public
as $$
with eps as (
  -- รอบที่มีคนตอบเท่านั้น — รอบค้างไม่มีผู้ตอบให้นับ (ของเดิมใช้ cross join lateral
  -- ซึ่งตัดรอบค้างทิ้งไปเองโดยปริยาย)
  select * from inbox.reply_episodes(p_from, p_to) where responder is not null
),
first_resp as (
  select e.responder,
         count(*)::int as first_responses,
         count(distinct e.conversation_id)::int as conversations,
         round(avg(e.minutes), 1) as avg_min,
         round((percentile_cont(0.5) within group (order by e.minutes))::numeric, 1) as median_min,
         round(max(e.minutes), 1) as max_min
    from eps e group by e.responder
),
totals as (
  select case when m.sender_type = 'bot' then 'bot'
              else coalesce(st.name, u.email, 'unknown') end as responder,
         count(*)::int as replies
    from inbox.message m
    left join inbox.sales_staff st on st.user_id = m.sender_id
    left join core."user" u on u.id = m.sender_id
   where m.sender_type in ('agent','bot')
     and m.created_at >= p_from and m.created_at < p_to
   group by 1
)
-- ★ full outer join ไม่ใช่ left join อย่างของเดิม
--   ของเดิมตั้งต้นจาก "คนที่มีข้อความในช่วงนั้น" ซึ่งใช้ได้เพราะบน cloud
--   ทุกคำตอบมีข้อความเสมอ แต่ที่นี่มีทางที่ไม่มีข้อความ: LINE fallback
--   (ทีมตอบจาก chat.line.biz เรารู้แค่ว่ามีคนตอบ ไม่มีสำเนาข้อความ)
--   ใช้ left join แบบเดิม คนกลุ่มนั้นจะหายไปทั้งแถว = รายงานบอกว่าไม่มีใครตอบ
--   ทั้งที่ตอบไปแล้ว ซึ่งแย่กว่าตัวเลขไม่สวย
select coalesce(t.responder, f.responder) as responder,
       coalesce(t.replies, 0), coalesce(f.first_responses, 0), coalesce(f.conversations, 0),
       f.avg_min, f.median_min, f.max_min
  from totals t full outer join first_resp f on f.responder = t.responder
 order by coalesce(t.replies, 0) desc, 1
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 1b) ให้ตัวเก็บสถิติรายวันใช้ reply_stats ตัวเดียวกัน
--
-- ของเดิมใน 009 เขียนสูตรซ้ำไว้ในตัวเอง ซึ่งแปลว่ามีสองที่ที่ต้องแก้ให้ตรงกันตลอดไป
-- และมันต่างกันไปแล้วจริง ๆ (009 ใช้ left join จึงทิ้งคนที่ตอบแบบ LINE fallback)
-- ตรงนี้จึงรวมเหลือสูตรเดียว
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.refresh_sales_staff_kpi_daily(p_day date)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  v_from timestamptz := p_day::timestamp at time zone 'Asia/Bangkok';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'Asia/Bangkok';
  v_rows int;
begin
  delete from inbox.sales_staff_kpi_daily where report_date = p_day;
  insert into inbox.sales_staff_kpi_daily(report_date, responder, staff_id, replies,
                                          first_responses, conversations, avg_min, median_min, max_min)
  select p_day, s.responder,
         (select st.id from inbox.sales_staff st where st.name = s.responder limit 1),
         s.replies, s.first_responses, s.conversations, s.avg_min, s.median_min, s.max_min
    from inbox.reply_stats(v_from, v_to) s;
  get diagnostics v_rows = row_count;
  return v_rows;
end $fn$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) build_reply_report_daily — ชื่อเดิมของ cloud
--
-- ปลายทางคือ inbox.sales_staff_kpi_daily ซึ่งทำหน้าที่เดียวกับ reply_report_daily
-- ของเดิมทุกประการ จึงไม่สร้างตารางใหม่ซ้อน
--
-- เก็บชื่อเดิมไว้เพื่อให้คนที่คุ้นกับ cron ของ cloud ย้ายมาแล้วหาเจอ
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.build_reply_report_daily(
  p_date date default ((now() at time zone 'Asia/Bangkok')::date - 1))
returns int
language sql
security definer
set search_path = pg_catalog, public
as $$ select inbox.refresh_sales_staff_kpi_daily(p_date) $$;

revoke all on function inbox.reply_stats(timestamptz,timestamptz),
                      inbox.build_reply_report_daily(date)
  from public, anon;
grant execute on function inbox.reply_stats(timestamptz,timestamptz),
                          inbox.build_reply_report_daily(date)
  to service_role, authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) ตารางงาน — คงค่าเวลาเดิมของ cloud ไว้ทุกตัว ไม่แปลงโซนเวลา
--
--   asher-report-daily   10 17 * * *   (= 00:10 ไทย) คำนวณสถิติของเมื่อวาน
--   asher-daily-report    0 2 * * *    (= 09:00 ไทย) ทำรายงานแล้วหย่อนลงคิวส่ง
--   asher-watchdog        * * * * *    ไล่เคสค้างตอบ
--
-- ★ unschedule ก่อนเสมอ ไฟล์นี้จึงรันซ้ำได้โดยไม่เกิดงานซ้อน
-- ───────────────────────────────────────────────────────────────────────────
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job
 where jobname in ('asher-report-daily','asher-daily-report','asher-watchdog');

select cron.schedule('asher-report-daily', '10 17 * * *',
                     $cron$select inbox.build_reply_report_daily()$cron$);
select cron.schedule('asher-daily-report', '0 2 * * *',
                     $cron$select inbox.enqueue_daily_report()$cron$);
select cron.schedule('asher-watchdog',     '* * * * *',
                     $cron$select inbox.watchdog(now())$cron$);

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- ยังไม่ทำ — ต้องสร้างตารางใหม่ จึงหยุดถามก่อนตามที่สั่ง
--
--   build_reply_report_weekly   ต้องมี reply_report_weekly  (ยังไม่มีใน inbox)
--   build_reply_report_monthly  ต้องมี reply_report_monthly (ยังไม่มีใน inbox)
--   build_turn_quality          ไม่มีทั้งโค้ดและตาราง — ไม่รู้ว่ามันคำนวณอะไร
--
-- สองตัวแรกเป็นแค่การรวมช่วงเวลาที่กว้างขึ้นของ reply_stats ตัวเดียวกัน
-- ถ้าอนุมัติ จะสร้าง inbox.sales_staff_kpi_weekly / _monthly โครงเดียวกับรายวัน
-- แล้วต่อ cron '20 17 * * 0' กับ '30 17 * * *' ตามค่าเดิมของ cloud
--
-- ตัวที่สามต้องขอโค้ดก่อน เดาไม่ได้ว่า "turn quality" วัดอะไร
-- ═══════════════════════════════════════════════════════════════════════════
