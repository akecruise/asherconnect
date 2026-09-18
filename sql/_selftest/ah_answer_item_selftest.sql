-- =====================================================================
-- selftest ของ answer_item (Phase 2) — ประตู ah_* บังคับสิทธิ์จริง ไม่ใช่แค่มีหน้าตา
-- =====================================================================
-- ★ เขียนลงฐานแต่ห่อ begin … rollback · ทุก title ขึ้นต้น [__selftest__]
-- วิธีรัน:
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql "<conn>" -v ON_ERROR_STOP=1 -f sql/_selftest/ah_answer_item_selftest.sql
--
-- จำลองตัวตนด้วย set role authenticated + request.jwt.claims (auth.uid อ่านจาก claims)
-- ใช้ user_id จริงจาก core.profile ของแต่ละ role ที่มีอยู่แล้วในฐาน
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
  v_fail     int := 0;
  v_admin    uuid;
  v_manager  uuid;
  v_sales    uuid;
  v_draft    uuid;
  v_review   uuid;
  v_approved uuid;
  r          jsonb;
  v_n        int;
begin
  select user_id into v_admin   from core.profile where role = 'admin'   and is_active order by user_id limit 1;
  select user_id into v_manager from core.profile where role = 'manager' and is_active order by user_id limit 1;
  select user_id into v_sales   from core.profile where role = 'sales'   and is_active order by user_id limit 1;
  if v_admin is null or v_manager is null or v_sales is null then
    raise exception 'ต้องมี profile ทั้งสาม role (admin/manager/sales) ในฐานก่อน';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);

  -- 1. sales สร้างไม่ได้
  begin
    perform inbox.ah_save('{"title":"x","body_template":"y"}');
    raise notice 'sales สร้างคำตอบได้ — ต้องไม่อนุญาต'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'T1 ได้ % แทนที่จะเป็น ah_not_allowed', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  -- 2. manager สร้างฉบับร่าง → draft
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_save(jsonb_build_object(
    'title', '[__selftest__] ราคาเริ่มต้น', 'body_template', 'ราคาเริ่มต้น {{starting_price}}',
    'answer_type', 'hybrid', 'submit', false));
  if r->>'status' <> 'draft' then raise notice 'ร่างควรเป็น draft ได้ %', r->>'status'; v_fail := v_fail + 1; end if;
  v_draft := (r->>'id')::uuid;

  -- 3. submit เข้ารอบตรวจ → review
  r := inbox.ah_save(jsonb_build_object(
    'title', '[__selftest__] โปรโมชั่นเดือนนี้', 'body_template', 'โปรโมชั่น', 'submit', true));
  if r->>'status' <> 'review' then raise notice 'submit ควรเป็น review ได้ %', r->>'status'; v_fail := v_fail + 1; end if;
  v_review := (r->>'id')::uuid;

  -- 4. manager อนุมัติไม่ได้
  begin
    perform inbox.ah_approve(jsonb_build_object('id', v_review));
    raise notice 'manager อนุมัติได้ — ต้องเฉพาะ admin'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'T4 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  -- 5. admin อนุมัติ → approved + approved_by = admin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  r := inbox.ah_approve(jsonb_build_object('id', v_review));
  if r->>'status' <> 'approved' or (r->>'approved_by')::uuid is distinct from v_admin then
    raise notice 'อนุมัติแล้วไม่ครบ: status=% approved_by=%', r->>'status', r->>'approved_by'; v_fail := v_fail + 1;
  end if;
  v_approved := v_review;
  v_review := null;

  -- 6. manager แก้ของ approved → กลับเข้ารอบตรวจ + ล้างผู้อนุมัติ
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_save(jsonb_build_object('id', v_approved, 'body_template', 'ราคาใหม่'));
  if r->>'status' <> 'review' or (r->>'approved_by')::uuid is not distinct from v_admin then
    raise notice 'แก้ของ approved ควรกลับเป็น review: status=% approved_by=%', r->>'status', r->>'approved_by'; v_fail := v_fail + 1;
  end if;

  -- 7. admin retire → retired · แก้ไม่ได้อีก
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  r := inbox.ah_retire(jsonb_build_object('id', v_approved));
  if r->>'status' <> 'retired' then raise notice 'retire ควรได้ retired ได้ %', r->>'status'; v_fail := v_fail + 1; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  begin
    perform inbox.ah_save(jsonb_build_object('id', v_approved, 'title', 'แก้ของปลดใช้'));
    raise notice 'แก้ของที่ retired ได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_state_not_allowed' then raise notice 'T7 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  -- 8. sales ah_get ของที่ยังไม่ approved → ไม่อนุญาต · ah_list เห็นแต่ approved
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);
  begin
    perform inbox.ah_get(jsonb_build_object('id', v_draft));
    raise notice 'sales เห็นฉบับร่างได้ — ต้องไม่อนุญาต'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'T8 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  r := inbox.ah_list('{}');
  select count(*) into v_n from jsonb_array_elements(r->'rows') e
  where e->>'status' <> 'approved';
  if v_n <> 0 then raise notice 'sales เห็นคำตอบไม่ approved ในรายการ % แถว', v_n; v_fail := v_fail + 1; end if;

  -- 9. manager ah_list ขอสถานะตายตัวได้ (ของ admin ที่ปลดใช้ต้องหาได้)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_list('{"status":"retired"}');
  if not exists (select 1 from jsonb_array_elements(r->'rows') e where (e->>'id')::uuid = v_approved) then
    raise notice 'manager ต้องเห็นของ retired ในรายการ'; v_fail := v_fail + 1;
  end if;

  if v_fail > 0 then
    raise exception 'selftest พบปัญหา % จุด', v_fail;
  end if;
  raise notice 'ah_answer_item_selftest ผ่านทั้งหมด';
end $test$;

rollback;
