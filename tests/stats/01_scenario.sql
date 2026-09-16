-- =====================================================================
-- ชุดทดสอบ: รันซ้ำได้ ถ้าขึ้น FAIL แปลว่านิยามเพี้ยน
-- psql -f tests/00_stubs.sql -f migrations/*.sql -f tests/01_scenario.sql
-- =====================================================================
\set ON_ERROR_STOP on
begin;                         -- ต้องอยู่ใน transaction เดียว เพราะเทสต์สิทธิ์ใช้ set local
set timezone = 'Asia/Bangkok';

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_got text default '')
returns void language plpgsql as $$
begin
  raise notice '% %  %', case when p_cond then 'PASS' else 'FAIL ❌' end, rpad(p_name, 46), p_got;
end $$;

-- ล้างข้อมูลทดสอบเก่า (เรียงตามสายอ้างอิง)
truncate inbox.response_window, inbox.agent_daily_stat, inbox.message,
         inbox.signature_alias, inbox.stats_error_log restart identity;
delete from inbox.conversation;
delete from inbox.inbox;
delete from core.contact_identity;
delete from core.contact;
delete from core.project;
delete from core.profile;
delete from core."user";
delete from inbox.sla_policy;

insert into inbox.sla_policy (project, channel_key, target_sec, warn_sec, breach_sec,
                              biz_open, biz_close, biz_days, tz)
values (null, null, 900, 1800, 3600, '09:00', '20:00', '{1,2,3,4,5,6,7}', 'Asia/Bangkok');

-- ★ ตัวตนของคนอยู่สองตาราง: core."user" เก็บอีเมล core.profile เก็บ role กับลายเซ็น
--   ชื่อบน leaderboard มาจาก profile.signature ก่อน ไม่มีค่อยใช้อีเมล (ของจริงไม่มี full_name)
insert into core."user"(id,email) values
  ('11111111-1111-1111-1111-111111111111','mint@asher.local'),
  ('22222222-2222-2222-2222-222222222222','koi@asher.local'),
  ('99999999-9999-9999-9999-999999999999','ake@asher.local');
insert into core.profile(user_id, role, signature) values
  ('11111111-1111-1111-1111-111111111111','sales','มิ้นท์'),
  ('22222222-2222-2222-2222-222222222222','sales','ก้อย'),
  ('99999999-9999-9999-9999-999999999999','admin','Ake');

insert into inbox.signature_alias (alias, profile_id) values ('-มิ้นท์','11111111-1111-1111-1111-111111111111');

-- ★ channel / project / customer_ref ไม่ได้อยู่บนแถวข้อความ ต้องมีสายให้ไล่จริง
--   message -> conversation -> inbox -> project   และ   conversation -> contact_identity
insert into core.project(id,code,name) values
  ('00000000-0000-0000-0000-0000000000a1','naii','ASHER Naii'),
  ('00000000-0000-0000-0000-0000000000a2','vibe','ASHER Vibe');

insert into inbox.inbox(id,channel,project_id,name) values
  ('00000000-0000-0000-0000-0000000000b1','line','00000000-0000-0000-0000-0000000000a1','LINE Naii'),
  ('00000000-0000-0000-0000-0000000000b2','messenger','00000000-0000-0000-0000-0000000000a2','Messenger Vibe');

insert into core.contact(id) values
  ('00000000-0000-0000-0000-0000000000c1'),('00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000c3'),('00000000-0000-0000-0000-0000000000c4');

insert into core.contact_identity(contact_id,channel,external_id) values
  ('00000000-0000-0000-0000-0000000000c1','line','U001'),
  ('00000000-0000-0000-0000-0000000000c2','messenger','U002'),
  ('00000000-0000-0000-0000-0000000000c3','line','U003'),
  ('00000000-0000-0000-0000-0000000000c4','line','U004');

insert into inbox.conversation(id,inbox_id,contact_id) values
  ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c4');

-- ตัวช่วยป้อนข้อความในรูปแบบของจริง
--   contact = ลูกค้า | bot = บอท | agent = คน | system = ประกาศของระบบ
--   agent ที่มี sender_id = ตอบผ่านหน้า Connect · agent ที่ไม่มี = ตอบจากแอปของช่องทางเอง
create or replace function pg_temp.say(p_conv uuid, p_sender text, p_text text, p_at timestamptz,
                                       p_by uuid default null, p_event text default 'message')
returns void language sql as $fn$
  insert into inbox.message(conversation_id, sender_type, sender_id, content, created_at, event_type)
  values (p_conv, p_sender, p_by, p_text, p_at, p_event);
$fn$;

-- ---------------------------------------------------------------------
-- A. คณิตศาสตร์เวลาทำการ
-- ---------------------------------------------------------------------
select pg_temp.ok('A1 ในเวลาทำการนับตรง',
  inbox.business_seconds('2026-09-01 10:00+07','2026-09-01 10:10+07',
                         '09:00','20:00','{1,2,3,4,5,6,7}','Asia/Bangkok') = 600);

select pg_temp.ok('A2 ข้ามคืนไม่นับเวลาปิด',
  inbox.business_seconds('2026-09-01 21:00+07','2026-09-02 09:05+07',
                         '09:00','20:00','{1,2,3,4,5,6,7}','Asia/Bangkok') = 300);

select pg_temp.ok('A3 ข้ามวันเต็ม = 11 ชม.',
  inbox.business_seconds('2026-09-01 19:00+07','2026-09-03 10:00+07',
                         '09:00','20:00','{1,2,3,4,5,6,7}','Asia/Bangkok') = 3600 + 39600 + 3600);

select pg_temp.ok('A4 ไม่ตั้งเวลาทำการ = นับ 24 ชม.',
  inbox.business_seconds('2026-09-01 21:00+07','2026-09-02 09:00+07',
                         null,null,'{1,2,3,4,5,6,7}','Asia/Bangkok') = 43200);

select pg_temp.ok('A5 deadline ข้ามคืนไปโผล่ 09:15',
  inbox.business_deadline('2026-09-01 21:00+07', 900,
                          '09:00','20:00','{1,2,3,4,5,6,7}','Asia/Bangkok')
  = '2026-09-02 09:15+07'::timestamptz,
  inbox.business_deadline('2026-09-01 21:00+07',900,'09:00','20:00','{1,2,3,4,5,6,7}','Asia/Bangkok')::text);

select pg_temp.ok('A6 ข้ามวันหยุด (เสาร์-อาทิตย์ปิด)',
  inbox.business_deadline('2026-09-04 19:50+07', 900,   -- ศุกร์ 19:50 เหลือ 10 นาที
                          '09:00','20:00','{1,2,3,4,5}','Asia/Bangkok')
  = '2026-09-07 09:05+07'::timestamptz);                -- ไปต่อเช้าจันทร์

-- ---------------------------------------------------------------------
-- B. วงจรชีวิตของ response window
-- ---------------------------------------------------------------------
-- B1 ลูกค้าทัก -> เปิดรอบ + ตั้ง due_at
select pg_temp.say('00000000-0000-0000-0000-000000000101','contact','สนใจห้องครับ','2026-09-01 10:00+07');

select pg_temp.ok('B1 เปิดรอบ + due_at = 10:15',
  (select count(*) = 1 and max(due_at) = '2026-09-01 10:15+07'::timestamptz
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000101'));

-- B2 bot ตอบ ไม่ปิดรอบ
select pg_temp.say('00000000-0000-0000-0000-000000000101','bot','สวัสดีค่ะ','2026-09-01 10:00:30+07');

select pg_temp.ok('B2 bot ตอบแล้วรอบยังเปิดอยู่',
  (select first_bot_at is not null and closed_at is null and sla_status='open'
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000101'));

-- B3 ลูกค้าทักซ้ำ ไม่เปิดรอบใหม่
select pg_temp.say('00000000-0000-0000-0000-000000000101','contact','มีห้องว่างไหม','2026-09-01 10:05+07');

select pg_temp.ok('B3 ทักซ้ำ = รอบเดิม นับ inbound_count',
  (select count(*) = 1 and max(inbound_count) = 2
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000101'));

-- B4 คนตอบจาก Workspace -> ปิดรอบ, met
select pg_temp.say('00000000-0000-0000-0000-000000000101','agent','มีค่ะ','2026-09-01 10:10+07','11111111-1111-1111-1111-111111111111');

select pg_temp.ok('B4 ปิดรอบ 600 วิ = met, src=workspace',
  (select business_sec = 600 and sla_status = 'met' and responder_src = 'workspace'
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000101'));

-- B5 รอบถัดไปในห้องเดิม
select pg_temp.say('00000000-0000-0000-0000-000000000101','contact','ราคาเท่าไหร่','2026-09-01 11:00+07');

select pg_temp.ok('B5 ห้องเดิมเปิดรอบที่ 2 ได้',
  (select count(*) = 2 from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000101'));

-- ---------------------------------------------------------------------
-- C. การระบุตัวคนตอบ (ช่วง transition)
-- ---------------------------------------------------------------------
select pg_temp.say('00000000-0000-0000-0000-000000000101','agent','เริ่มต้น 2.9 ล้านค่ะ -มิ้นท์','2026-09-01 11:05+07');

select pg_temp.ok('C1 จับคนตอบจากลายเซ็นได้',
  (select responder_src='signature' and responder_id='11111111-1111-1111-1111-111111111111'
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000101' order by inbound_at desc limit 1));

select pg_temp.say('00000000-0000-0000-0000-000000000102','contact','สอบถามครับ','2026-09-01 11:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000102','agent','สวัสดีครับ','2026-09-01 11:20+07');

select pg_temp.ok('C2 ตอบจาก Page ไม่มีลายเซ็น = page/ไม่ระบุตัว',
  (select responder_src='page' and responder_id is null and sla_status='warn'
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000102'));

-- ---------------------------------------------------------------------
-- D. breach + ข้ามคืน
-- ---------------------------------------------------------------------
select pg_temp.say('00000000-0000-0000-0000-000000000103','contact','ขอข้อมูลครับ','2026-09-01 11:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000103','agent','ขอโทษครับ','2026-09-01 13:30+07','22222222-2222-2222-2222-222222222222');

select pg_temp.ok('D1 เกิน 60 นาที = breach',
  (select sla_status='breach' and business_sec=9000
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000103'));

select pg_temp.say('00000000-0000-0000-0000-000000000104','contact','สนใจครับ','2026-09-01 21:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000104','agent','สวัสดีค่ะ','2026-09-02 09:05+07','11111111-1111-1111-1111-111111111111');

select pg_temp.ok('D2 ทักดึก ตอบเช้า = met (นับแค่ 5 นาทีทำการ)',
  (select sla_status='met' and business_sec=300 and raw_sec=43500
     from inbox.response_window where conversation_id = '00000000-0000-0000-0000-000000000104'));

-- ---------------------------------------------------------------------
-- E. trigger ต้องไม่ทำให้ insert ข้อความพัง
-- ---------------------------------------------------------------------
-- ★ ของจริง conversation_id เป็น NOT NULL + FK จึงว่างไม่ได้
--   "ข้อมูลพิกล" ตัวจริงคือแถวที่นั่งในตารางเดียวกันแต่ไม่ใช่บทสนทนา
select pg_temp.say('00000000-0000-0000-0000-000000000101','system','ข้อความพิกล','2026-09-03 10:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000101','contact','ข้อความพิกล','2026-09-03 10:01+07',null,'follow');
select pg_temp.ok('E1 ข้อมูลพิกลแล้ว insert ยังผ่าน',
  (select count(*) > 0 from inbox.message where content='ข้อความพิกล'));
select pg_temp.ok('E2 ไม่มี error ค้างใน stats_error_log',
  (select count(*) = 0 from inbox.stats_error_log),
  (select coalesce(string_agg(message,' | '),'-') from inbox.stats_error_log));

-- ---------------------------------------------------------------------
-- F. rollup + รายงาน Telegram
-- ---------------------------------------------------------------------
select inbox.rollup_agent_daily('2026-09-01');
select pg_temp.ok('F1 rollup มีแถวของมิ้นท์',
  (select sum(windows_handled) >= 2 from inbox.agent_daily_stat
    where responder_id='11111111-1111-1111-1111-111111111111' and stat_date='2026-09-01'));
select pg_temp.ok('F2 ข้อความรายงานสร้างได้',
  (select inbox.stats_telegram_daily('2026-09-01') like '%SLA%'),
  (select replace(inbox.stats_telegram_daily('2026-09-01'), E'\n', ' / ')));

-- ---------------------------------------------------------------------
-- G. backfill ต้องได้ผลเท่าเดิม
-- ---------------------------------------------------------------------
create temp table before_rebuild as
  select conversation_id, inbound_at, business_sec, sla_status, responder_src
    from inbox.response_window order by conversation_id, inbound_at;

select inbox.rebuild_windows('2026-08-01','2026-10-01');

select pg_temp.ok('G1 rebuild แล้วได้ตัวเลขชุดเดิม',
  not exists (
    select 1 from (
      select conversation_id, inbound_at, business_sec, sla_status, responder_src
        from inbox.response_window) a
    full join before_rebuild b using (conversation_id, inbound_at)
    where a.business_sec is distinct from b.business_sec
       or a.sla_status  is distinct from b.sla_status
       or a.responder_src is distinct from b.responder_src));

-- ---------------------------------------------------------------------
-- H. สิทธิ์ตาม role
-- ---------------------------------------------------------------------
set local "test.uid" = '99999999-9999-9999-9999-999999999999';   -- admin
select pg_temp.ok('H1 admin เห็นภาพรวมทั้งทีม',
  (inbox.stats_overview('{"from":"2026-08-01","to":"2026-10-01"}')->>'windows_total')::int >= 5,
  (inbox.stats_overview('{"from":"2026-08-01","to":"2026-10-01"}'))::text);

select pg_temp.ok('H2 leaderboard คืนรายคน',
  jsonb_array_length(inbox.stats_agents('{"from":"2026-08-01","to":"2026-10-01"}')) >= 2,
  (inbox.stats_agents('{"from":"2026-08-01","to":"2026-10-01"}'))::text);

set local "test.uid" = '22222222-2222-2222-2222-222222222222';   -- sales = ก้อย
-- ★ นโยบายเปลี่ยนที่ sql/027: หน้าสถิติเปิดให้ manager ขึ้นไปเท่านั้น
--   ข้อนี้เคยยืนยันว่า "sales เห็นเฉพาะของตัวเอง" ซึ่งเลิกใช้แล้ว
--   ไม่ได้ลบทิ้ง แต่สลับมายืนยันว่าถูกปฏิเสธแทน
do $$
begin
  perform inbox.stats_overview('{"from":"2026-08-01","to":"2026-10-01"}');
  raise notice 'FAIL ❌ H3 sales ต้องเปิดหน้าภาพรวมไม่ได้';
exception when insufficient_privilege then
  raise notice 'PASS H3 sales เปิดภาพรวมไม่ได้ (ถูกต้อง)';
end $$;

do $$
begin
  perform inbox.stats_agents('{}');
  raise notice 'FAIL ❌ H4 sales ต้องเปิด leaderboard ไม่ได้';
exception when insufficient_privilege then
  raise notice 'PASS H4 sales เปิด leaderboard ไม่ได้ (ถูกต้อง)';
end $$;

-- ★ กลับมาเป็น admin ก่อน — หลัง sql/027 หน้าสถิติเปิดให้ manager ขึ้นไปทั้งหมด
--   ข้อนี้วัดว่า "เรียกแล้วคืนโครงถูก" ไม่ได้วัดสิทธิ์ — ส่วนสิทธิ์อยู่ใน 04_stats_v2.sql (G3/G4)
set local "test.uid" = '99999999-9999-9999-9999-999999999999';   -- admin
select pg_temp.ok('H5 timeline/open_windows เรียกได้',
  jsonb_typeof(inbox.stats_timeline('{"bucket":"day"}')) = 'array'
  and jsonb_typeof(inbox.stats_open_windows('{}')) = 'array');

commit;
