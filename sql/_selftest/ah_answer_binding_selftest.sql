-- =====================================================================
-- selftest ของ answer_data_binding (Phase 5) — T09 binding success · T10 missing ไม่เดา
-- =====================================================================
-- ★ เขียนลงฐานแต่ห่อ begin … rollback · ของชั่วคราวติด __ST5__ / [__selftest__]
-- บทเรียน Phase 3: authenticated ไม่มี USAGE บน schema answer_hub — เรียก src_resolve
--   ตรงต้องอยู่ฝั่ง postgres (ก่อน set local role) ส่วนทดสอบสิทธิ์ใช้ inbox.ah_* เท่านั้น
-- วิธีรัน:
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql "<conn>" -v ON_ERROR_STOP=1 -f sql/_selftest/ah_answer_binding_selftest.sql
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
  v_has_optional_sources boolean := to_regclass('public.promotions') is not null and to_regclass('public.project_facts') is not null;
  v_proj    uuid;
  v_utype   uuid;
  v_item    uuid;
  v_draft   uuid;
  r         jsonb;
  v_n       int;
begin
  select user_id into v_admin   from core.profile where role = 'admin'   and is_active order by user_id limit 1;
  select user_id into v_manager from core.profile where role = 'manager' and is_active order by user_id limit 1;
  select user_id into v_sales   from core.profile where role = 'sales'   and is_active order by user_id limit 1;
  if not v_has_optional_sources then
    raise notice 'optional promotions/project_facts adapters absent; binding resolver integration test skipped';
    return;
  end if;

  -- ─── ของชั่วคราว: โครงการ + ยูนิต + โปร + fact + คำตอบ 3 สถานะ ───
  insert into core.project (code, name)
  values ('__ST5__', 'โครงการเทสต์ binding')
  returning id into v_proj;

  insert into inventory.unit_type (project_id, code, size_sqm)
  values (v_proj, '__ST5__', 30.0)
  returning id into v_utype;

  insert into inventory.unit (project_id, unit_type_id, number, status, price) values
    (v_proj, v_utype, '__ST5__-01', 'available', 2900000),
    (v_proj, v_utype, '__ST5__-02', 'available', 3200000);

  insert into public.promotions (promotion_id, project_id, name, offer, landing_page,
                                 start_date, end_date, status, created_at) values
    ('__ST5__1', v_proj::text, 'โปรเทสต์ผูกข้อมูล', 'ลด 3%', null,
     current_date - 5, current_date + 5, 'ACTIVE', now());

  insert into public.project_facts (id, project_id, fact_key, value_text, is_public, verified_at) values
    (10, v_proj::text, 'payment_terms', 'ดาวน์ 5% ถึงกองกลาง', 1, localtimestamp);

  insert into answer_hub.answer_item (title, body_template, status)
  values ('[__selftest__] ผูกข้อมูล approved',
    'ชื่อ {{project_name}} เริ่ม {{price_start}} ว่าง {{units_avail}} โปร {{promo_name}} '
    || 'เงื่อนไข {{payment_terms}} ที่ตั้ง {{location_note}} สิ่งอำนวย {{facilities_note}} '
    || 'ดิบ {{profile_raw}}',
    'approved')
  returning id into v_item;

  insert into answer_hub.answer_item (title, body_template, status)
  values ('[__selftest__] ผูกข้อมูล draft', 'ชื่อ {{project_name}}', 'draft')
  returning id into v_draft;

  -- ─── ด่าน src_resolve (ยังเป็น postgres — authenticated ไม่ถึง schema นี้) ───

  -- 1. dispatcher: ทางเดินตามทะเบียนครบ + กันค่ามั่วทุกทาง
  r := answer_hub.src_resolve('PROJECT_PROFILE', jsonb_build_object('project_id', v_proj), false);
  if r->>'status' <> 'ok' or r->'value'->>'name' <> 'โครงการเทสต์ binding' then
    raise notice 'T09 dispatcher profile ไม่ตรง: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_resolve('PROJECT_PROFILE', jsonb_build_object('project_id', v_proj), true);
  if r->>'status' <> 'denied' or r->>'reason' <> 'bot_not_allowed' then
    raise notice 'T11.6 ต่อยอด บอทผ่าน src_resolve ไม่ได้: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_resolve('APPOINTMENT_SLOT', jsonb_build_object('lead_id', gen_random_uuid()), false);
  if r->>'status' <> 'denied' or r->>'reason' <> 'source_inactive' then
    raise notice 'T11.4 ต่อยอด แหล่งปิดผ่าน dispatcher: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_resolve('ไม่มีจริง', '{}'::jsonb, false);
  if r->>'status' <> 'denied' or r->>'reason' <> 'source_not_found' then
    raise notice 'โค้ดแปลกผ่าน dispatcher: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_resolve('PROJECT_PROFILE', jsonb_build_object('project_id', 'abc'), false);
  if r->>'status' <> 'invalid' or r->>'reason' <> 'invalid_context' then
    raise notice 'T11.10 ต่อยอด uuid มั่วต้อง invalid_context: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_resolve('PROJECT_PROFILE', jsonb_build_object('project_id', gen_random_uuid()), false);
  if r->>'status' <> 'missing' or r->>'reason' <> 'project_not_found' then
    raise notice 'โครงการไม่มีจริงต้อง missing: %', r; v_fail := v_fail + 1;
  end if;

  -- ─── ส่วนประตู ah_* (impersonate JWT) ───
  set local role authenticated;

  -- 2. manager ผูกครบ 8 ตัวแปร (รวมกรณี optional+fallback และ required ไม่มี fallback)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', '{{project_name}}',
    'source_code', 'PROJECT_PROFILE', 'source_field', 'name'));
  if r->>'variable_name' <> 'project_name' then raise notice 'T09 ชื่อตัวแปรต้องตัดปีกกา: %', r->>'variable_name'; v_fail := v_fail + 1; end if;
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'price_start',
    'source_code', 'PROJECT_PRICE', 'source_field', 'starting_price'));
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'units_avail',
    'source_code', 'AVAILABLE_UNITS', 'source_field', 'available_units'));
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'promo_name',
    'source_code', 'CURRENT_PROMOTION', 'source_field', 'name'));
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'payment_terms',
    'source_code', 'PAYMENT_TERMS', 'source_field', 'payment_terms'));
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'location_note',
    'source_code', 'PROJECT_LOCATION', 'source_field', 'text', 'required', false, 'fallback_text', 'สอบถามพนักงาน'));
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'facilities_note',
    'source_code', 'FACILITIES', 'source_field', 'text'));
  r := inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'profile_raw',
    'source_code', 'PROJECT_PROFILE', 'required', false));
  if r->>'source_field' is not null then raise notice 'source_field ว่างต้องเก็บ null: %', r; v_fail := v_fail + 1; end if;

  -- 3. ผูกซ้ำ (item, variable) เดิม = แก้ ไม่ใช่สร้างซ้อน
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'price_start',
    'source_code', 'PROJECT_PRICE', 'source_field', 'starting_price', 'required', false));
  r := inbox.ah_binding_list(jsonb_build_object('answer_item_id', v_item));
  v_n := (r->>'total')::int;
  if v_n <> 8 then raise notice 'T09 ผูกควรมี 8 (upsert ไม่เพิ่ม) ได้ %', v_n; v_fail := v_fail + 1; end if;

  -- 4. ชื่อตัวแปรผิดรูปแบบ / แหล่งไม่มีจริง / ของ retired → โดนกัน
  begin
    perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', '{{ ภาษาไทย }}',
      'source_code', 'PROJECT_PROFILE'));
    raise notice 'ตัวแปรไทยผ่าน — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_invalid' then raise notice 'ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;
  begin
    perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'x1',
      'source_code', 'ไม่มีจริง'));
    raise notice 'แหล่งมั่วผ่าน — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_found' then raise notice 'ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  -- Phase 9: binding changes invalidate approval; approve the completed fixture.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  perform inbox.ah_approve(jsonb_build_object('id', v_item));

  -- 5. T09+T10 — sales resolve ของ approved: values ครบจากฐานจริง · ของที่ไม่มีอยู่ใน missing ไม่เดา
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);
  r := inbox.ah_resolve(jsonb_build_object('answer_id', v_item,
    'context', jsonb_build_object('project_id', v_proj)));
  if (r->'values'->>'project_name') <> 'โครงการเทสต์ binding'
     or (r->'values'->>'price_start')::numeric <> 2900000
     or (r->'values'->>'units_avail') <> '2'
     or (r->'values'->>'promo_name') <> 'โปรเทสต์ผูกข้อมูล'
     or (r->'values'->>'payment_terms') <> 'ดาวน์ 5% ถึงกองกลาง' then
    raise notice 'T09 values ไม่ตรงฐานจริง: %', r->'values'; v_fail := v_fail + 1;
  end if;
  if (r->'values'->>'location_note') <> 'สอบถามพนักงาน' then
    raise notice 'T09 fallback_text ไม่ทำงาน: %', r->'values'; v_fail := v_fail + 1;
  end if;
  if r->'values' ? 'facilities_note' or r->'values' ? 'profile_raw' then
    raise notice 'T10 ค่าที่ไม่มีจริงหลุดเข้า values: %', r->'values'; v_fail := v_fail + 1;
  end if;
  if r->'missing' <> '["facilities_note"]'::jsonb then
    raise notice 'T10 missing list ต้องเหลือ facilities_note เดียว: %', r->'missing'; v_fail := v_fail + 1;
  end if;
  if (r->>'ok')::boolean then raise notice 'T10 มี required ขาดแต่บอก ok'; v_fail := v_fail + 1; end if;

  -- 6. sales resolve ของ draft → ไม่อนุญาต · manager → ได้
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_draft, 'variable_name', 'project_name',
    'source_code', 'PROJECT_PROFILE', 'source_field', 'name'));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);
  begin
    perform inbox.ah_resolve(jsonb_build_object('answer_id', v_draft,
      'context', jsonb_build_object('project_id', v_proj)));
    raise notice 'sales resolve ของ draft ได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_resolve(jsonb_build_object('answer_id', v_draft,
    'context', jsonb_build_object('project_id', v_proj)));
  if (r->>'ok')::boolean is distinct from true then
    raise notice 'T09 manager resolve ของ draft ต้องผ่าน: %', r; v_fail := v_fail + 1;
  end if;

  -- 7. sales แก้/อ่านผูกไม่ได้ · manager ลบได้ · ลบของไม่มี → not_found
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);
  begin
    perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'x2',
      'source_code', 'PROJECT_PROFILE'));
    raise notice 'T11.2 ต่อยอด sales ผูกได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;
  begin
    perform inbox.ah_binding_list(jsonb_build_object('answer_item_id', v_item));
    raise notice 'sales อ่านผูกได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_binding_list(jsonb_build_object('answer_item_id', v_item));
  perform inbox.ah_binding_delete(jsonb_build_object('id', r->'rows'->0->>'id'));
  r := inbox.ah_binding_list(jsonb_build_object('answer_item_id', v_item));
  if (r->>'total')::int <> 7 then raise notice 'ลบแล้วควรเหลือ 7 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  begin
    perform inbox.ah_binding_delete(jsonb_build_object('id', gen_random_uuid()));
    raise notice 'ลบของไม่มีผ่าน — ต้อง not_found'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_found' then raise notice 'ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  -- 8. ah_get คืน {item, versions, bindings} ครบ
  r := inbox.ah_get(jsonb_build_object('id', v_item));
  if r->'item'->>'id' is null or jsonb_array_length(r->'versions') <> 2
     or jsonb_array_length(r->'bindings') <> 7 then
    raise notice 'ah_get รูปทรงใหม่ไม่ครบ: item=% versions=% bindings=%',
      r->'item'->>'id', jsonb_array_length(r->'versions'), jsonb_array_length(r->'bindings');
    v_fail := v_fail + 1;
  end if;

  -- 9. service_role แก้ผูกไม่ได้แม้แต่ขั้น grant (ทางเดียวกับ Phase 4)
  execute 'set local role service_role';
  begin
    perform inbox.ah_binding_save(jsonb_build_object('answer_item_id', v_item, 'variable_name', 'x3',
      'source_code', 'PROJECT_PROFILE'));
    raise notice 'service_role ผูกได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  execute 'set local role authenticated';

  if v_fail > 0 then
    raise exception 'selftest พบปัญหา % จุด', v_fail;
  end if;
  raise notice 'ah_answer_binding_selftest ผ่านทั้งหมด';
end $test$;

rollback;
