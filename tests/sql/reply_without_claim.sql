-- เทสต์ "ตอบได้โดยไม่ต้องรับเคส" ด้วย role ต่างกัน
-- ★ ทั้งไฟล์อยู่ในทรานแซกชันเดียวและ rollback ทิ้ง ไม่มีอะไรค้างในฐาน
--   ข้อความที่ส่งทดสอบจึงไม่ถูก commit → trigger enqueue_outbound ไม่มีผลจริง
\set ON_ERROR_STOP on
begin;

\echo ==== เคสที่ใช้ทดสอบ ====
create temporary table t_case on commit drop as
select c.id as conv_id, c.assignee_id
  from inbox.conversation c
 where c.status <> 'resolved' and c.assignee_id is null
 order by c.last_message_at desc nulls last limit 1;
select conv_id as "เคสที่ไม่มีผู้รับ" from t_case;

create temporary table t_users on commit drop as
select role, (array_agg(user_id order by user_id))[1] as uid
  from core.profile where is_active and role in ('sales','senior_sales','manager','admin')
 group by role;
select role, uid from t_users order by role;

do $do$
declare
  v_conv uuid := (select conv_id from t_case);
  v_sales uuid := (select uid from t_users where role='sales');
  v_senior uuid := (select uid from t_users where role='senior_sales');
  v_mgr uuid := (select uid from t_users where role='manager');
  v_admin uuid := (select uid from t_users where role='admin');
  v_res jsonb;
  v_err text;
begin
  if v_conv is null then raise exception 'ไม่มีเคสที่ไม่มีผู้รับให้ทดสอบ'; end if;

  -- ── 1. sales ที่ไม่ใช่ผู้รับเคส ต้อง "ส่งข้อความได้"
  perform set_config('request.jwt.claim.sub', v_sales::text, true);
  v_res := connect_private.api('send', jsonb_build_object(
    'id', v_conv, 'request_id', gen_random_uuid(), 'text', '[ทดสอบระบบ] ข้อความทดสอบ ไม่ได้ส่งจริง'));
  raise notice '1. sales ส่งข้อความโดยไม่รับเคส : ผ่าน';

  -- ── 2. senior_sales ก็ต้องส่งได้
  perform set_config('request.jwt.claim.sub', v_senior::text, true);
  perform connect_private.api('send', jsonb_build_object(
    'id', v_conv, 'request_id', gen_random_uuid(), 'text', '[ทดสอบระบบ] senior'));
  raise notice '2. senior_sales ส่งข้อความโดยไม่รับเคส : ผ่าน';

  -- ── 3. manager / admin ก็ต้องส่งได้ (เดิมก็ได้อยู่แล้ว ต้องไม่พังเพราะการแก้)
  perform set_config('request.jwt.claim.sub', v_mgr::text, true);
  perform connect_private.api('send', jsonb_build_object(
    'id', v_conv, 'request_id', gen_random_uuid(), 'text', '[ทดสอบระบบ] manager'));
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform connect_private.api('send', jsonb_build_object(
    'id', v_conv, 'request_id', gen_random_uuid(), 'text', '[ทดสอบระบบ] admin'));
  raise notice '3. manager และ admin ส่งข้อความได้ : ผ่าน';

  -- ── 4. ★ งานที่ไม่ใช่การตอบแชท ต้องยังบังคับรับเคสเหมือนเดิม
  perform set_config('request.jwt.claim.sub', v_sales::text, true);
  begin
    perform connect_private.api('save', jsonb_build_object(
      'id', v_conv, 'request_id', gen_random_uuid(), 'version', 0,
      'project_id', (select project_id from inbox.inbox limit 1),
      'interest', 'unknown'));
    raise exception 'ไม่ควรผ่าน: sales แก้ข้อมูลเคสที่ไม่ได้รับได้';
  exception when sqlstate '42501' then
    raise notice '4. sales แก้ข้อมูลเคสที่ไม่ได้รับ ยังถูกบล็อก (claim_required) : ผ่าน';
  end;

  -- ── 5. คนนอกทีม (ไม่มีแถวใน core.profile) ต้องเข้าไม่ได้เลย
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  begin
    perform connect_private.api('send', jsonb_build_object(
      'id', v_conv, 'request_id', gen_random_uuid(), 'text', 'x'));
    raise exception 'ไม่ควรผ่าน: คนนอกส่งข้อความได้';
  exception when sqlstate '42501' then
    raise notice '5. คนนอกทีมส่งข้อความไม่ได้ (not_allowed) : ผ่าน';
  end;

  -- ── 6. ข้อความที่ส่งไปต้องบันทึกว่าใครส่ง และหน้าเคสต้องรู้ว่าใครตอบล่าสุด
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  v_res := connect_private.api('detail', jsonb_build_object('id', v_conv));
  assert v_res->'last_agent_reply' is not null and v_res->'last_agent_reply' <> 'null'::jsonb,
    'detail ต้องมี last_agent_reply';
  -- ★ เทียบกับ "คนใดคนหนึ่งที่เพิ่งส่ง" ไม่ใช่เจาะจง admin
  --   เพราะ now() ในทรานแซกชันเดียวคืนค่าเท่ากันทุกครั้ง ข้อความ 4 ก้อนจึง created_at ชนกัน
  --   แล้ว order by created_at desc, id desc ไปตัดสินด้วย uuid สุ่ม ซึ่งไม่ได้เรียงตามลำดับที่ใส่
  --   ของจริงไม่เจอปัญหานี้ เพราะแต่ละคำขอเป็นคนละทรานแซกชัน เวลาจึงต่างกันเสมอ
  assert (v_res->'last_agent_reply'->>'by') in (v_sales::text, v_senior::text, v_mgr::text, v_admin::text),
    format('last_agent_reply.by ต้องเป็นคนใดคนหนึ่งที่เพิ่งส่ง แต่ได้ %s', v_res->'last_agent_reply'->>'by');
  assert (v_res->'last_agent_reply'->>'at') is not null, 'last_agent_reply ต้องมีเวลา';
  assert (v_res->'last_agent_reply'->>'name') is not null, 'last_agent_reply ต้องมีชื่อคนตอบ';
  raise notice '6. last_agent_reply มีครบ name/by/at และชี้คนที่ส่งจริง : ผ่าน';

  -- ── 7. ทุกข้อความขาออกต้องมีผู้ส่งติดมาด้วย
  assert not exists (
    select 1 from jsonb_array_elements(v_res->'messages') m
     where m->>'sender_type' = 'agent' and (m->>'sender_id') is null),
    'มีข้อความ agent ที่ไม่มี sender_id';
  assert exists (
    select 1 from jsonb_array_elements(v_res->'messages') m
     where m->>'sender_type' = 'agent' and (m->>'sender_name') is not null),
    'ข้อความ agent ต้องมี sender_name อย่างน้อยหนึ่งก้อน';
  raise notice '7. ข้อความขาออกมี sender_id + sender_name ครบ : ผ่าน';

  raise notice '── ผ่านครบทั้ง 7 ข้อ ──';
end
$do$;

rollback;
