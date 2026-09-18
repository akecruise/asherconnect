-- =====================================================================
-- selftest ของ answer_version (Phase 3) — T05 version history ทำงานจริง
-- =====================================================================
-- ★ เขียนลงฐานแต่ห่อ begin … rollback · ทุก title ขึ้นต้น [__selftest__]
-- วิธีรัน:
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql "<conn>" -v ON_ERROR_STOP=1 -f sql/_selftest/ah_answer_version_selftest.sql
-- =====================================================================

do $guard$
begin
  if current_setting('asher.allow_db_tests', true) is distinct from '1' then
    raise exception 'ข้าม selftest — ต้องตั้ง ALLOW_DB_TESTS=1 และ PGOPTIONS=''-c asher.allow_db_tests=1'' ก่อน';
  end if;
end $guard$;

begin;

do $test$
declare
  v_fail    int := 0;
  v_admin   uuid;
  v_manager uuid;
  v_sales   uuid;
  v_item    uuid;
  r         jsonb;
  v         jsonb;
  v_n       int;
begin
  select user_id into v_admin   from core.profile where role = 'admin'   and is_active order by user_id limit 1;
  select user_id into v_manager from core.profile where role = 'manager' and is_active order by user_id limit 1;
  select user_id into v_sales   from core.profile where role = 'sales'   and is_active order by user_id limit 1;

  set local role authenticated;

  -- สร้าง → อนุมัติ → แก้ (v1) → อนุมัติ → แก้อีก (v2) → อนุมัติ → ปลดใช้ (v3)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_save(jsonb_build_object(
    'title', '[__selftest__] ราคา v?', 'body_template', 'ราคารุ่นแรก', 'submit', true));
  v_item := (r->>'id')::uuid;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  perform inbox.ah_approve(jsonb_build_object('id', v_item));

  -- 1. แก้ของ approved → ต้องเกิด version 1 ที่มีข้อความเดิม (ราคารุ่นแรก)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  perform inbox.ah_save(jsonb_build_object(
    'id', v_item, 'body_template', 'ราคารุ่นสอง', 'change_reason', 'ปรับข้อความ'));
  -- ตรวจตารางตรง ๆ ต้องเป็น postgres — reset role แล้วคืน authenticated ก่อนเรียก ah_* ต่อ
  execute 'reset role';
  select to_jsonb(t) into v from (
    select version_no, title, body_template, change_reason
    from answer_hub.answer_version
    where answer_item_id = v_item order by version_no limit 1) t;
  execute 'set local role authenticated';
  if v is null or v->>'version_no' <> '1' or v->>'body_template' <> 'ราคารุ่นแรก'
     or v->>'change_reason' <> 'ปรับข้อความ' then
    raise notice 'version 1 ไม่ตรง: %', v; v_fail := v_fail + 1;
  end if;

  -- 2. แก้ตอนยัง review (หลังถูกดึงกลับ) → ห้ามเกิด version เพิ่ม
  perform inbox.ah_save(jsonb_build_object('id', v_item, 'body_template', 'ราคารุ่นสองแก้ครั้งที่สองของ review'));
  execute 'reset role';
  select count(*) into v_n from answer_hub.answer_version where answer_item_id = v_item;
  execute 'set local role authenticated';
  if v_n <> 1 then raise notice 'แก้ตอน review แต่เกิด version เพิ่ม (% แถว)', v_n; v_fail := v_fail + 1; end if;

  -- 3. อนุมัติรอบสอง → แก้อีก → version 2
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  perform inbox.ah_approve(jsonb_build_object('id', v_item));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  perform inbox.ah_save(jsonb_build_object('id', v_item, 'body_template', 'ราคารุ่นสาม'));
  execute 'reset role';
  select count(*) into v_n from answer_hub.answer_version where answer_item_id = v_item;
  execute 'set local role authenticated';
  if v_n <> 2 then raise notice 'ควรมี 2 version ได้ %', v_n; v_fail := v_fail + 1; end if;

  -- 4. อนุมัติรอบสาม → admin ปลดใช้ → version 3 พร้อมข้อความรุ่นสาม
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  perform inbox.ah_approve(jsonb_build_object('id', v_item));
  perform inbox.ah_retire(jsonb_build_object('id', v_item, 'reason', 'หมดโปรโมชั่น'));
  execute 'reset role';
  select to_jsonb(t) into v from (
    select version_no, body_template, change_reason
    from answer_hub.answer_version
    where answer_item_id = v_item order by version_no desc limit 1) t;
  execute 'set local role authenticated';
  if v->>'version_no' <> '3' or v->>'body_template' <> 'ราคารุ่นสาม' or v->>'change_reason' <> 'หมดโปรโมชั่น' then
    raise notice 'version จากการปลดใช้ไม่ตรง: %', v; v_fail := v_fail + 1;
  end if;

  -- 5. ลำดับ version_no ถูกต้อง 1,2,3 (unique กันซ้ำ)
  execute 'reset role';
  select count(*) into v_n from answer_hub.answer_version where answer_item_id = v_item;
  execute 'set local role authenticated';
  if v_n <> 3 then raise notice 'รวมควรมี 3 version ได้ %', v_n; v_fail := v_fail + 1; end if;

  -- 6. sales อ่านประวัติไม่ได้ · manager อ่านได้ (เรียงใหม่ล่าสุดก่อน)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);
  begin
    perform inbox.ah_versions(jsonb_build_object('id', v_item));
    raise notice 'sales อ่านประวัติได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'T6 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_versions(jsonb_build_object('id', v_item));
  if (r->'rows'->0->>'version_no') <> '3' then
    raise notice 'ประวัติตัวแรกควรเป็น version 3 ได้ %', r->'rows'->0; v_fail := v_fail + 1;
  end if;

  if v_fail > 0 then
    raise exception 'selftest พบปัญหา % จุด', v_fail;
  end if;
  raise notice 'ah_answer_version_selftest ผ่านทั้งหมด';
end $test$;

rollback;
