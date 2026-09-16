-- =====================================================================
-- 034_kpi_refresh_resync.sql — คืน inbox.refresh_sales_staff_kpi_daily
--                              ให้เป็นรุ่นของ sql/011 (เจ้าของตาม ORDER.txt)
-- =====================================================================
-- เกิดอะไรขึ้น (2026-09-16)
--   วันนี้มีการรัน sql/009_report.sql ทั้งไฟล์ใส่โปรดักชัน (งาน is_test ของ
--   คำสั่ง test — ไฟล์นั้นเพิ่ม `and not c.is_test` ในตัวรายงาน)
--   แต่ 009 ก็ create or replace inbox.refresh_sales_staff_kpi_daily ด้วย
--   ทั้งที่ sql/011_cloud_functions.sql เป็นเจ้าของรุ่นล่าสุดตาม ORDER.txt
--   ผลคือฟังก์ชันนี้ย้อนกลับไปเป็นรุ่น "คำนวณเองในตัว" ของ 009
--   ส่วนรุ่นของ 011 ที่ delegate ให้ inbox.reply_stats() หายไป
--
-- ★ ผลลัพธ์ของสองรุ่น "เท่ากันทุกตัวเลข" — พิสูจน์แล้วก่อนลงไฟล์นี้
--   รันทั้งสองรุ่นกับ 2026-09-15 ในทรานแซกชันที่ถอยกลับ ได้ 5 แถวเท่ากัน
--   ค่า replies / first_responses / conversations / avg_min / median_min / max_min
--   ตรงกันทุกช่องทุกผู้ตอบ → การลงไฟล์นี้ไม่เปลี่ยนตัวเลขรายงานของใคร
--   ที่ได้คือแหล่งความจริงเดียว (inbox.reply_stats) ไม่ต้องดูแลสูตรสองที่
--
-- ★ ทำไมต้องรีบคืน: ฟังก์ชันนี้ไม่ได้นอนเฉย ๆ — inbox.build_reply_report_daily
--   (pg_cron 17:10 ทุกวัน) และ inbox.enqueue_daily_report (pg_cron 02:00/13:00)
--   เรียกมันทุกวัน ถ้าปล่อยให้สองสูตรลอยอยู่คู่กัน วันหนึ่งที่แก้ reply_stats
--   ตัวเลขจะเปลี่ยนแค่ครึ่งระบบแล้วไล่ไม่เจอ
--
-- สำรองของก่อนแก้: sql/_backup/refresh_sales_staff_kpi_daily_prod_20260916.sql
-- ★ 009 ได้ guard แล้ว (ที่หัว transaction) — รัน 009 ซ้ำจะหยุดดัง ๆ
--   พร้อมบอกให้รัน 034 ต่อ ไม่ย้อนรุ่นเงียบ ๆ อีก
-- =====================================================================

begin;

-- ── ด่านตรวจของที่ต้องมีก่อน ─────────────────────────────────────────
-- รุ่นนี้ delegate ให้ inbox.reply_stats() ถ้าฐานไหนยังไม่มีตัวนั้น การลงไฟล์นี้
-- จะทำให้รายงานประจำวันพังตอน pg_cron เรียก ไม่ใช่ตอนลง — จึงหยุดตั้งแต่ตอนนี้
-- (ไฟล์นี้เป็นเจ้าของรุ่นล่าสุดของฟังก์ชันนี้ จึงไม่ต้องมี guard กันย้อนรุ่นในตัวเอง
--  ตัวที่กันคือ guard ที่หัว transaction ของ sql/009_report.sql)
do $dep$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'inbox' and p.proname = 'reply_stats')
  then
    raise exception 'ไม่พบ inbox.reply_stats — ต้องลง sql/011_cloud_functions.sql ก่อน';
  end if;
end $dep$;

-- ยกมาจาก sql/011_cloud_functions.sql ทั้งตัว (ตัวเดียวกับที่ ORDER.txt บอกว่าควรชนะ)
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

-- create or replace ไม่ล้าง ACL เดิม บรรทัดนี้ไว้เผื่อฐานที่ตั้งใหม่
grant execute on function inbox.refresh_sales_staff_kpi_daily(date) to service_role;

commit;
