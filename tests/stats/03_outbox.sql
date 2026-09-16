-- =====================================================================
-- ชุดทดสอบ outbox / id / นโยบายเก็บข้อมูล (0006)
-- =====================================================================
\set ON_ERROR_STOP on
begin;
set timezone = 'Asia/Bangkok';

create or replace function pg_temp.ok4(p_name text, p_cond boolean, p_got text default '')
returns void language plpgsql as $$
begin
  raise notice '% %  %', case when p_cond then 'PASS' else 'FAIL' end, rpad(p_name, 50), p_got;
end $$;

delete from inbox.outbox_cursor;
delete from inbox.event_outbox;
truncate inbox.response_window restart identity cascade;
delete from inbox.message;
delete from inbox.conversation;
delete from inbox.inbox;
delete from core.contact_identity;
delete from core.contact;
delete from core.project;
delete from core.profile;
delete from core."user";

-- ★ channel / project / customer_ref ไม่ได้อยู่บนแถวข้อความ ต้องมีสายให้ไล่จริง
--   ห้อง 401 = messenger/naii (PSID_N) · ห้อง 402 = line/naii (ULINE_N)
insert into core."user"(id,email) values ('11111111-1111-1111-1111-111111111111','mint@asher.local');
insert into core.profile(user_id, role, signature) values ('11111111-1111-1111-1111-111111111111','sales','มิ้นท์');

insert into core.project(id,code,name) values
  ('00000000-0000-0000-0000-0000000000a1','naii','ASHER Naii');
insert into inbox.inbox(id,channel,project_id,name) values
  ('00000000-0000-0000-0000-0000000000b1','messenger','00000000-0000-0000-0000-0000000000a1','Messenger Naii'),
  ('00000000-0000-0000-0000-0000000000b2','line','00000000-0000-0000-0000-0000000000a1','LINE Naii');
insert into core.contact(id) values
  ('00000000-0000-0000-0000-0000000000c1'),('00000000-0000-0000-0000-0000000000c2');
insert into core.contact_identity(contact_id,channel,external_id) values
  ('00000000-0000-0000-0000-0000000000c1','messenger','PSID_N'),
  ('00000000-0000-0000-0000-0000000000c2','line','ULINE_N');
insert into inbox.conversation(id,inbox_id,contact_id) values
  ('00000000-0000-0000-0000-000000000401','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000000000402','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000c2');

create or replace function pg_temp.say4(p_conv uuid, p_sender text, p_text text, p_at timestamptz,
                                        p_by uuid default null, p_ext text default null)
returns void language sql as $fn$
  insert into inbox.message(conversation_id, sender_type, sender_id, content, created_at, external_message_id)
  values (p_conv, p_sender, p_by, p_text, p_at, p_ext);
$fn$;

-- ---------------------------------------------------------------------
-- A. ประกาศเหตุการณ์จากข้อความ
-- ---------------------------------------------------------------------
select pg_temp.say4('00000000-0000-0000-0000-000000000401','contact','สนใจครับ',now(),null,'mid.n1');

select pg_temp.ok4('A1 ทักครั้งแรก = ประกาศ 2 เหตุการณ์',
  (select count(*)=2 from inbox.event_outbox where customer_ref='PSID_N'),
  (select string_agg(type,', ' order by id) from inbox.event_outbox where customer_ref='PSID_N'));

select pg_temp.ok4('A2 มี customer.first_message',
  (select count(*)=1 from inbox.event_outbox
    where type='customer.first_message' and customer_ref='PSID_N'));

select pg_temp.say4('00000000-0000-0000-0000-000000000401','contact','ราคาเท่าไหร่',now(),null,'mid.n2');

select pg_temp.ok4('A3 ทักซ้ำไม่ประกาศ first_message อีก',
  (select count(*)=1 from inbox.event_outbox
    where type='customer.first_message' and customer_ref='PSID_N'));

select pg_temp.say4('00000000-0000-0000-0000-000000000401','agent','สวัสดีครับ',now(),'11111111-1111-1111-1111-111111111111','mid.n3');

select pg_temp.ok4('A4 ตอบออกไป = reply.sent พร้อมคนตอบ',
  (select payload->>'actor'='human' and payload->>'profile_id'='11111111-1111-1111-1111-111111111111'
     from inbox.event_outbox where type='reply.sent' order by id desc limit 1));

select pg_temp.ok4('A5 เหตุการณ์ชี้กลับไปข้อความต้นทางได้',
  (select m.external_message_id='mid.n1' from inbox.event_outbox e
     join inbox.message m on m.id = e.message_id
    where e.type='customer.first_message'));

-- ---------------------------------------------------------------------
-- B. หลาย consumer อ่าน stream เดียวกัน คนละความเร็ว
-- ---------------------------------------------------------------------
select pg_temp.ok4('B1 consumer ใหม่ได้เหตุการณ์ทั้งหมด',
  (select count(*)>=4 from inbox.outbox_poll('crm')));

select inbox.outbox_ack('crm', (select max(id) from inbox.event_outbox));

select pg_temp.ok4('B2 ack แล้วไม่ได้ของเดิมซ้ำ',
  (select count(*)=0 from inbox.outbox_poll('crm')));

select pg_temp.ok4('B3 consumer อีกตัวยังได้ของครบ (ไม่โดนกิน)',
  (select count(*)>=4 from inbox.outbox_poll('content')));

select pg_temp.ok4('B4 กรองตามประเภทได้',
  (select count(*)=1 from inbox.outbox_poll('report', 200,
     array['customer.first_message'])));

select inbox.outbox_ack('crm', 1);
select pg_temp.ok4('B5 ack ถอยหลังไม่ได้',
  (select last_id > 1 from inbox.outbox_cursor where consumer='crm'));

-- ---------------------------------------------------------------------
-- C. ห้องที่เงียบไป
-- ---------------------------------------------------------------------
update inbox.response_window set inbound_at = now() - interval '30 hours'
 where conversation_id = '00000000-0000-0000-0000-000000000401';
select pg_temp.say4('00000000-0000-0000-0000-000000000402','contact','สอบถามครับ',now() - interval '30 hours');
update inbox.response_window set inbound_at = now() - interval '30 hours', closed_at = null
 where conversation_id = '00000000-0000-0000-0000-000000000402';

select pg_temp.ok4('C1 ยิงเหตุการณ์ห้องเงียบได้',
  inbox.emit_idle_events(24) >= 1);

select pg_temp.ok4('C2 รอบเดิมไม่ยิงซ้ำ',
  inbox.emit_idle_events(24) = 0);

-- ---------------------------------------------------------------------
-- D. นโยบายเก็บข้อมูล
-- ---------------------------------------------------------------------
select pg_temp.ok4('D1 ข้อความเก็บนานกว่า payload ดิบ',
  (select m.keep_days > c.keep_days
     from inbox.retention_policy m, inbox.retention_policy c
    where m.scope='message' and c.scope='channel_event'),
  (select concat('message ', keep_days, ' วัน') from inbox.retention_policy where scope='message'));

update inbox.retention_policy set keep_days = 90 where scope = 'message';
do $$
begin
  perform inbox.purge_messages();
  raise notice 'FAIL D2 ตั้งอายุข้อความต่ำกว่าขั้นต่ำแล้วลบได้';
exception when others then
  raise notice 'PASS D2 ตั้งอายุข้อความต่ำกว่าขั้นต่ำแล้วลบไม่ได้';
end $$;
update inbox.retention_policy set keep_days = 1095 where scope = 'message';

-- outbox: ลบได้เฉพาะส่วนที่ทุก consumer ผ่านไปแล้ว
update inbox.event_outbox set at = now() - interval '400 days';
select pg_temp.ok4('D3 ยังมี consumer ตามไม่ทัน = ไม่ลบ',
  inbox.purge_outbox() = 0,
  (select concat('min cursor = ', min(last_id)) from inbox.outbox_cursor));

select inbox.outbox_ack('content', (select max(id) from inbox.event_outbox));
select inbox.outbox_ack('report',  (select max(id) from inbox.event_outbox));
select inbox.outbox_ack('crm',     (select max(id) from inbox.event_outbox));

select pg_temp.ok4('D4 ทุก consumer ผ่านแล้ว = ลบได้',
  inbox.purge_outbox() > 0);

-- ---------------------------------------------------------------------
-- E. ไม่มีสถานะทางธุรกิจปนอยู่ใน inbox
-- ---------------------------------------------------------------------
select pg_temp.ok4('E1 conversation ไม่มีคอลัมน์สถานะของโมดูลอื่น',
  (select count(*)=0 from information_schema.columns
    where table_schema='inbox' and table_name='conversation'
      and column_name in ('lead_status','is_qualified','assigned_to','stage','lead_id')));

select pg_temp.ok4('E2 ยังไม่มี schema crm (ยังไม่ได้เริ่มโมดูล)',
  (select count(*)=0 from information_schema.schemata where schema_name='crm'));

commit;
