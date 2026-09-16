-- =====================================================================
-- ชุดทดสอบ: sql/027_stats_v2.sql — หน้าสถิติการตอบ
--   กติกาเวลา 24 ชม. หัก 00:00–06:00 · เตือน 5 นาที · เกิน SLA 10 นาที
--   ระบบคะแนน · แยก workspace/page/unassigned · ด่าน manager
-- รันซ้ำได้ ถ้าขึ้น FAIL แปลว่านิยามเพี้ยน
-- =====================================================================
\set ON_ERROR_STOP on
begin;
set timezone = 'Asia/Bangkok';

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_got text default '')
returns void language plpgsql as $$
begin
  raise notice '% %  %', case when p_cond then 'PASS' else 'FAIL ❌' end, rpad(p_name, 46), p_got;
end $$;

create or replace function pg_temp.say(p_conv uuid, p_sender text, p_text text, p_at timestamptz,
                                       p_by uuid default null, p_event text default 'message')
returns void language sql as $fn$
  insert into inbox.message(conversation_id, sender_type, sender_id, content, created_at, event_type)
  values (p_conv, p_sender, p_by, p_text, p_at, p_event);
$fn$;

truncate inbox.response_window, inbox.agent_daily_stat, inbox.message,
         inbox.signature_alias, inbox.stats_error_log restart identity;
delete from inbox.conversation;
delete from inbox.inbox;
delete from core.contact_identity;
delete from core.contact;
delete from core.project;
delete from core.profile;
delete from core."user";

insert into core."user"(id,email) values
  ('11111111-1111-1111-1111-111111111111','mint@asher.local'),
  ('22222222-2222-2222-2222-222222222222','koi@asher.local'),
  ('33333333-3333-3333-3333-333333333333','boss@asher.local'),
  ('99999999-9999-9999-9999-999999999999','ake@asher.local');
insert into core.profile(user_id, role, signature) values
  ('11111111-1111-1111-1111-111111111111','sales','มิ้นท์'),
  ('22222222-2222-2222-2222-222222222222','sales','ก้อย'),
  ('33333333-3333-3333-3333-333333333333','manager','หัวหน้า'),
  ('99999999-9999-9999-9999-999999999999','admin','Ake');

insert into core.project(id,code,name) values
  ('00000000-0000-0000-0000-0000000000a1','naii','ASHER Naii'),
  ('00000000-0000-0000-0000-0000000000a2','vibe','ASHER Vibe');
insert into inbox.inbox(id,channel,project_id,name) values
  ('00000000-0000-0000-0000-0000000000b1','line','00000000-0000-0000-0000-0000000000a1','LINE Naii'),
  ('00000000-0000-0000-0000-0000000000b2','messenger','00000000-0000-0000-0000-0000000000a2','MSG Vibe');
insert into core.contact(id) values
  ('00000000-0000-0000-0000-0000000000c1'),('00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000c3'),('00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-0000000000c5');
insert into core.contact_identity(contact_id,channel,external_id) values
  ('00000000-0000-0000-0000-0000000000c1','line','U001'),
  ('00000000-0000-0000-0000-0000000000c2','line','U002'),
  ('00000000-0000-0000-0000-0000000000c3','line','U003'),
  ('00000000-0000-0000-0000-0000000000c4','messenger','U004'),
  ('00000000-0000-0000-0000-0000000000c5','line','U005');
insert into inbox.conversation(id,inbox_id,contact_id) values
  ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-000000000203','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-000000000205','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c5');

-- ---------------------------------------------------------------------
-- A. กติกาเวลา — 24 ชม. หัก 00:00–06:00
-- ---------------------------------------------------------------------
select pg_temp.ok('A1 policy ตั้งเป็น 06:00-24:00 แล้ว',
  (select biz_open = time '06:00' and biz_close = time '24:00'
     from inbox.sla_policy where project is null and channel_key is null and active),
  (select biz_open::text || ' - ' || biz_close::text
     from inbox.sla_policy where project is null and channel_key is null and active));

select pg_temp.ok('A2 กลางวันนับเต็ม',
  inbox.business_seconds('2026-09-01 10:00+07','2026-09-01 10:10+07',
                         '06:00','24:00','{1,2,3,4,5,6,7}','Asia/Bangkok') = 600);

-- ทัก 23:50 ตอบ 06:10 → นับได้ 10 นาทีก่อนเที่ยงคืน + 10 นาทีหลัง 06:00 = 20 นาที
select pg_temp.ok('A3 ข้ามคืน หักช่วง 00:00-06:00 ออก',
  inbox.business_seconds('2026-09-01 23:50+07','2026-09-02 06:10+07',
                         '06:00','24:00','{1,2,3,4,5,6,7}','Asia/Bangkok') = 1200,
  inbox.business_seconds('2026-09-01 23:50+07','2026-09-02 06:10+07',
                         '06:00','24:00','{1,2,3,4,5,6,7}','Asia/Bangkok')::text || ' วินาที');

-- ★ ข้อสำคัญที่สุดของไฟล์นี้: สองนิยามที่เขียนคนละที่ต้องให้เลขเดียวกัน
--   inbox.business_seconds() (ชั้น stats, 017) กับ inbox.sla_elapsed_minutes() (การ์ดในหน้าแชท, 023)
--   ถ้าข้อนี้ FAIL แปลว่าตัวเลขบนหน้าสถิติกับแท็ก SLA บนการ์ดจะไม่ตรงกัน
--   ทั้งที่เป็นเคสเดียวกัน ซึ่งเป็นอาการที่หาสาเหตุยากที่สุดเวลาเกิดจริง
select pg_temp.ok('A4 ★ ตรงกับ sla_elapsed_minutes ของการ์ดหน้าแชท',
  inbox.business_seconds('2026-09-01 23:50+07','2026-09-02 06:10+07',
                         '06:00','24:00','{1,2,3,4,5,6,7}','Asia/Bangkok') / 60
  = inbox.sla_elapsed_minutes('2026-09-01 23:50+07','2026-09-02 06:10+07'),
  'stats=' || (inbox.business_seconds('2026-09-01 23:50+07','2026-09-02 06:10+07',
                 '06:00','24:00','{1,2,3,4,5,6,7}','Asia/Bangkok')/60)::text
  || ' นาที / การ์ด=' || inbox.sla_elapsed_minutes('2026-09-01 23:50+07','2026-09-02 06:10+07')::text || ' นาที');

select pg_temp.ok('A5 ★ ตรงกันอีกช่วง (เที่ยงคืนถึงเช้า)',
  inbox.business_seconds('2026-09-01 22:00+07','2026-09-02 08:00+07',
                         '06:00','24:00','{1,2,3,4,5,6,7}','Asia/Bangkok') / 60
  = inbox.sla_elapsed_minutes('2026-09-01 22:00+07','2026-09-02 08:00+07'));

-- ---------------------------------------------------------------------
-- B. เกณฑ์ SLA 5 / 10 นาที
-- ---------------------------------------------------------------------
-- ตอบใน 4 นาที = met
select pg_temp.say('00000000-0000-0000-0000-000000000201','contact','สนใจห้อง','2026-09-10 10:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000201','agent','สวัสดีค่ะ','2026-09-10 10:04+07',
                   '11111111-1111-1111-1111-111111111111');
-- ตอบ 7 นาที = warn
select pg_temp.say('00000000-0000-0000-0000-000000000202','contact','ราคาเท่าไหร่','2026-09-10 11:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000202','agent','เดี๋ยวส่งให้ค่ะ','2026-09-10 11:07+07',
                   '11111111-1111-1111-1111-111111111111');
-- ตอบ 12 นาที = breach
select pg_temp.say('00000000-0000-0000-0000-000000000203','contact','ขอดูห้องตัวอย่าง','2026-09-10 12:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000203','agent','ได้ค่ะ','2026-09-10 12:12+07',
                   '22222222-2222-2222-2222-222222222222');

select pg_temp.ok('B1 ตอบ 4 นาที = met',
  (select sla_status from inbox.response_window where conversation_id='00000000-0000-0000-0000-000000000201') = 'met',
  (select sla_status||' / '||business_sec::text||' วิ' from inbox.response_window
    where conversation_id='00000000-0000-0000-0000-000000000201'));

select pg_temp.ok('B2 ตอบ 7 นาที = warn',
  (select sla_status from inbox.response_window where conversation_id='00000000-0000-0000-0000-000000000202') = 'warn',
  (select sla_status||' / '||business_sec::text||' วิ' from inbox.response_window
    where conversation_id='00000000-0000-0000-0000-000000000202'));

select pg_temp.ok('B3 ตอบ 12 นาที = breach',
  (select sla_status from inbox.response_window where conversation_id='00000000-0000-0000-0000-000000000203') = 'breach',
  (select sla_status||' / '||business_sec::text||' วิ' from inbox.response_window
    where conversation_id='00000000-0000-0000-0000-000000000203'));

-- ---------------------------------------------------------------------
-- C. แยก workspace / page / unassigned
-- ---------------------------------------------------------------------
-- ตอบจาก Facebook Page โดยตรง = agent ที่ไม่มี sender_id
select pg_temp.say('00000000-0000-0000-0000-000000000204','contact','ทักจากเพจ','2026-09-10 13:00+07');
select pg_temp.say('00000000-0000-0000-0000-000000000204','agent','ตอบจาก Business Suite','2026-09-10 13:03+07');

select pg_temp.ok('C1 ตอบผ่าน Connect = workspace',
  (select responder_src from inbox.response_window where conversation_id='00000000-0000-0000-0000-000000000201') = 'workspace');

-- ★ signature_alias ว่างโดยเจตนา (ทีมย้ายมาใช้ระบบใหม่ที่มีชื่ออยู่แล้ว
--   ของเก่าที่ไม่มีชื่อรวมเป็นถังเดียว) สาขา signature จึงต้องไม่ทำงาน
select pg_temp.ok('C2 ตอบจาก Page = page ไม่ใช่ signature',
  (select responder_src from inbox.response_window where conversation_id='00000000-0000-0000-0000-000000000204') = 'page',
  (select responder_src from inbox.response_window where conversation_id='00000000-0000-0000-0000-000000000204'));

select pg_temp.ok('C3 ตอบจาก Page ไม่มี responder_id',
  (select responder_id is null from inbox.response_window where conversation_id='00000000-0000-0000-0000-000000000204'));

-- ---------------------------------------------------------------------
-- D. ตารางอันดับ + คะแนน   (ต้องเป็น manager ขึ้นไป)
-- ---------------------------------------------------------------------
set local "test.uid" = '33333333-3333-3333-3333-333333333333';   -- manager

select pg_temp.ok('D1 manager เปิด leaderboard ได้',
  jsonb_array_length(inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) >= 3);

-- มิ้นท์: met(3) + warn(2) = 5 · ก้อย: breach(1) = 1
select pg_temp.ok('D2 คะแนน = met×3 + warn×2 + breach×1',
  (select (a->>'score')::int from jsonb_array_elements(
      inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) a
    where a->>'name' = 'มิ้นท์') = 5,
  (select a->>'score' from jsonb_array_elements(
      inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) a
    where a->>'name' = 'มิ้นท์'));

select pg_temp.ok('D3 ก้อยตอบช้าแต่ยังได้คะแนน',
  (select (a->>'score')::int from jsonb_array_elements(
      inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) a
    where a->>'name' = 'ก้อย') = 1);

select pg_temp.ok('D4 ★ page เป็นแถวของตัวเอง ไม่ยุบรวมกับคน',
  (select count(*) from jsonb_array_elements(
      inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) a
    where a->>'responder_src' = 'page') = 1);

select pg_temp.ok('D5 แถว page ไม่มีชื่อ (หน้าจอเป็นคนตั้งป้าย)',
  (select a->>'name' is null from jsonb_array_elements(
      inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) a
    where a->>'responder_src' = 'page'));

-- ★ คะแนนต้องมาจากตาราง ไม่ใช่เลขฝังในโค้ด — แก้ตารางแล้วเลขต้องเปลี่ยนตาม
update inbox.score_rule set met_points = 10, warn_points = 5, breach_points = 2 where id = 1;
select pg_temp.ok('D6 ★ แก้ score_rule แล้วคะแนนเปลี่ยนตาม (ปรับได้จริง)',
  (select (a->>'score')::int from jsonb_array_elements(
      inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) a
    where a->>'name' = 'มิ้นท์') = 15,
  (select a->>'score' from jsonb_array_elements(
      inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01"}')) a
    where a->>'name' = 'มิ้นท์'));
update inbox.score_rule set met_points = 3, warn_points = 2, breach_points = 1 where id = 1;

-- ---------------------------------------------------------------------
-- E. ภาพรวม
-- ---------------------------------------------------------------------
select pg_temp.ok('E1 % ตอบใน 5 นาที คิดจากรอบที่ตัดสินแล้ว',
  (inbox.stats_overview('{"from":"2026-09-01","to":"2026-10-01"}')->>'within_target_pct')::numeric = 50.0,
  inbox.stats_overview('{"from":"2026-09-01","to":"2026-10-01"}')->>'within_target_pct');

select pg_temp.ok('E2 % เกิน 10 นาที',
  (inbox.stats_overview('{"from":"2026-09-01","to":"2026-10-01"}')->>'over_breach_pct')::numeric = 25.0,
  inbox.stats_overview('{"from":"2026-09-01","to":"2026-10-01"}')->>'over_breach_pct');

select pg_temp.ok('E3 ส่งเกณฑ์นาทีไปให้หน้าจอด้วย',
  (inbox.stats_overview('{}')->'thresholds'->>'warn_minutes')::int = 5
  and (inbox.stats_overview('{}')->'thresholds'->>'breach_minutes')::int = 10);

select pg_temp.ok('E4 ส่งน้ำหนักคะแนนไปให้หน้าจอด้วย',
  (inbox.stats_overview('{}')->'score_weights'->>'met')::int = 3);

select pg_temp.ok('E5 attribution_gap นับคำตอบที่ระบุตัวไม่ได้',
  (inbox.stats_overview('{"from":"2026-09-01","to":"2026-10-01"}')->>'attribution_gap_pct')::numeric = 25.0,
  inbox.stats_overview('{"from":"2026-09-01","to":"2026-10-01"}')->>'attribution_gap_pct');

-- ---------------------------------------------------------------------
-- E′. รายงาน Telegram — ต้องใช้เลขชุดเดียวกับหน้าจอ
-- ---------------------------------------------------------------------
select inbox.rollup_agent_daily('2026-09-10');

select pg_temp.ok('E6 รายงาน Telegram สร้างได้',
  inbox.stats_telegram_daily('2026-09-10') like '%สรุปการตอบ%');

-- ★ คะแนนต้องมีในรายงานด้วย ไม่งั้นอันดับในกลุ่มกับอันดับบนหน้าจอจะคนละชุด
select pg_temp.ok('E7 ★ รายงาน Telegram มีคะแนน',
  inbox.stats_telegram_daily('2026-09-10') like '%คะแนน%',
  replace(inbox.stats_telegram_daily('2026-09-10'), chr(10), ' / '));

-- แถวที่ระบุตัวไม่ได้ต้องอยู่ท้ายสุดเสมอ ไม่ปนกับคน
select pg_temp.ok('E8 แถว "ยังระบุตัวไม่ได้" อยู่ท้ายสุด',
  position('ยังระบุตัวไม่ได้' in inbox.stats_telegram_daily('2026-09-10'))
  > position('มิ้นท์' in inbox.stats_telegram_daily('2026-09-10')));

-- ---------------------------------------------------------------------
-- F. ตัวกรองช่องทาง / โปรเจกต์
-- ---------------------------------------------------------------------
-- ★ ของเดิม (018) timeline กับ agents ไม่รับตัวกรองเลย กดเปลี่ยนช่องทางแล้ว
--   การ์ดตัวเลขขยับแต่กราฟไม่ขยับ สองส่วนบนจอเดียวกันพูดคนละเรื่อง
select pg_temp.ok('F1 ★ timeline กรองช่องทางได้',
  (select coalesce(sum((x->>'windows')::int),0) from jsonb_array_elements(
     inbox.stats_timeline('{"from":"2026-09-01","to":"2026-10-01","bucket":"dow_hour","channel":"messenger"}')) x) = 1,
  (select coalesce(sum((x->>'windows')::int),0)::text from jsonb_array_elements(
     inbox.stats_timeline('{"from":"2026-09-01","to":"2026-10-01","bucket":"dow_hour","channel":"messenger"}')) x));

select pg_temp.ok('F2 timeline ไม่กรอง = ได้ทุกช่องทาง',
  (select coalesce(sum((x->>'windows')::int),0) from jsonb_array_elements(
     inbox.stats_timeline('{"from":"2026-09-01","to":"2026-10-01","bucket":"dow_hour"}')) x) = 4);

select pg_temp.ok('F3 ★ agents กรองโปรเจกต์ได้',
  jsonb_array_length(inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01","project":"vibe"}')) = 1,
  inbox.stats_agents('{"from":"2026-09-01","to":"2026-10-01","project":"vibe"}')::text);

-- ---------------------------------------------------------------------
-- G. ★ ด่านสิทธิ์ — ข้อกำหนดหลักของงานนี้
--    "ไม่ใช่แค่ซ่อนเมนู — sales เรียก API/RPC ตรง ๆ ต้องโดนปฏิเสธ"
-- ---------------------------------------------------------------------
set local "test.uid" = '11111111-1111-1111-1111-111111111111';   -- sales = มิ้นท์

do $$ begin
  perform inbox.stats_overview('{}');
  raise notice 'FAIL ❌ G1 sales ต้องเปิดภาพรวมไม่ได้';
exception when insufficient_privilege then raise notice 'PASS G1 sales เปิดภาพรวมไม่ได้';
end $$;

do $$ begin
  perform inbox.stats_agents('{}');
  raise notice 'FAIL ❌ G2 sales ต้องเปิด leaderboard ไม่ได้';
exception when insufficient_privilege then raise notice 'PASS G2 sales เปิด leaderboard ไม่ได้';
end $$;

do $$ begin
  perform inbox.stats_timeline('{}');
  raise notice 'FAIL ❌ G3 sales ต้องเปิดกราฟไม่ได้';
exception when insufficient_privilege then raise notice 'PASS G3 sales เปิดกราฟไม่ได้';
end $$;

do $$ begin
  perform inbox.stats_open_windows('{}');
  raise notice 'FAIL ❌ G4 sales ต้องเปิดคิวค้างตอบไม่ได้';
exception when insufficient_privilege then raise notice 'PASS G4 sales เปิดคิวค้างตอบไม่ได้';
end $$;

-- ★ ข้อนี้คือเหตุผลที่ 027 บังคับ "พื้น" ไว้ใน stats_scope แทนที่จะไล่แก้ทีละ RPC
--   stats_agent_detail อยู่ใน 018 และ 027 ไม่ได้เขียนทับ ถ้ายกด่านทีละตัว
--   ตัวนี้จะเป็นรูที่เปิดค้างไว้เงียบ ๆ โดยไม่มีใครรู้
do $$ begin
  perform inbox.stats_agent_detail('{"responder_id":"11111111-1111-1111-1111-111111111111"}');
  raise notice 'FAIL ❌ G5 RPC ที่ 027 ไม่ได้แตะ ก็ต้องโดนด่านเดียวกัน';
exception
  when insufficient_privilege then raise notice 'PASS G5 RPC ที่ 027 ไม่ได้แตะ ก็โดนด่านเดียวกัน';
  when undefined_function then raise notice 'PASS G5 (ข้าม — ไม่มี stats_agent_detail บนฐานนี้)';
end $$;

-- ★ ข้อความต้องเป็นคำว่า not_allowed เป๊ะ ๆ เพราะ server.mjs:101 มีคำนี้ใน safeCodes
--   ถ้าเปลี่ยนเป็นข้อความอื่น เบราว์เซอร์จะได้ request_rejected แล้วผู้ใช้
--   จะเห็นข้อความผิดว่า "บันทึกไม่สำเร็จ" แทนที่จะเป็น "ไม่มีสิทธิ์"
do $$
declare v_msg text;
begin
  begin
    perform inbox.stats_overview('{}');
    v_msg := '(ไม่ได้ throw)';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
  end;
  raise notice '% G6 ข้อความ error ต้องเป็น not_allowed  %',
    case when v_msg = 'not_allowed' then 'PASS' else 'FAIL ❌' end, v_msg;
end $$;

set local "test.uid" = '33333333-3333-3333-3333-333333333333';   -- manager
select pg_temp.ok('G7 manager เปิดได้', (inbox.stats_overview('{}')->>'windows_total') is not null);

set local "test.uid" = '99999999-9999-9999-9999-999999999999';   -- admin
select pg_temp.ok('G8 admin เปิดได้', (inbox.stats_overview('{}')->>'windows_total') is not null);

set local "test.uid" = '';
do $$ begin
  perform inbox.stats_overview('{}');
  raise notice 'FAIL ❌ G9 ไม่ได้ล็อกอินต้องเปิดไม่ได้';
exception when others then raise notice 'PASS G9 ไม่ได้ล็อกอินเปิดไม่ได้';
end $$;

-- ---------------------------------------------------------------------
-- H. ★ ตารางต้องปิด — sales ยิงตรงไม่ผ่าน RPC ก็ต้องไม่เห็นอะไร
-- ---------------------------------------------------------------------
-- นี่คือช่องโหว่ที่ 016 เปิดค้างไว้: ไม่มี RLS และไม่มี revoke สักบรรทัด
select pg_temp.ok('H1 ★ response_window เปิด RLS แล้ว',
  (select relrowsecurity from pg_class where oid = 'inbox.response_window'::regclass));

select pg_temp.ok('H2 ★ agent_daily_stat เปิด RLS แล้ว',
  (select relrowsecurity from pg_class where oid = 'inbox.agent_daily_stat'::regclass));

select pg_temp.ok('H3 ★ authenticated อ่าน response_window ตรง ๆ ไม่ได้',
  not has_table_privilege('authenticated','inbox.response_window','select'));

select pg_temp.ok('H4 ★ anon อ่าน response_window ตรง ๆ ไม่ได้',
  not has_table_privilege('anon','inbox.response_window','select'));

select pg_temp.ok('H5 ตารางไม่มี policy สักข้อ (ตั้งใจ — ทางเข้าคือ RPC เท่านั้น)',
  (select count(*) from pg_policies where schemaname='inbox' and tablename='response_window') = 0);

select pg_temp.ok('H6 service_role ยังเขียนได้ (worker ต้องใช้)',
  has_table_privilege('service_role','inbox.response_window','insert'));

select pg_temp.ok('H7 authenticated ยังเรียก RPC ได้ (ด่านอยู่ในฟังก์ชัน ไม่ใช่ที่ grant)',
  has_function_privilege('authenticated','inbox.stats_overview(jsonb)','execute'));

-- ★ security definer ที่ไม่ตั้ง search_path คือช่องโหว่ยกระดับสิทธิ์
select pg_temp.ok('H8 ★ RPC ทุกตัวเป็น security definer + ตั้ง search_path',
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='inbox'
      and p.proname in ('stats_overview','stats_agents','stats_timeline','stats_open_windows','stats_scope')
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig,'{}'),',') like '%search_path%') = 5,
  (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='inbox'
      and p.proname in ('stats_overview','stats_agents','stats_timeline','stats_open_windows','stats_scope')
      and p.prosecdef));

rollback;
