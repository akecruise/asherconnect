-- =====================================================================
-- selftest ของ source_registry (Phase 4) — T11 source permission + ERP อ่านจริง
-- =====================================================================
-- ★ เขียนลงฐานแต่ห่อ begin … rollback · ทุกของชั่วคราวติด __ST4__ / [__selftest__]
--   ไม่มีการสร้าง fake data ค้างฐาน — ของเทสต์หมดไปกับ rollback เสมอ
-- บทเรียน Phase 3: หลัง set local role authenticated ห้าม SELECT ตาราง answer_hub.*
--   ตรง ๆ — ต้อง execute 'reset role' ก่อนแล้วคืน role ก่อนเรียก ah_*
-- วิธีรัน:
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql "<conn>" -v ON_ERROR_STOP=1 -f sql/_selftest/ah_source_registry_selftest.sql
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
  v_proj    uuid;
  v_utype   uuid;
  r         jsonb;
  v         jsonb;
  v_n       int;
begin
  select user_id into v_admin   from core.profile where role = 'admin'   and is_active order by user_id limit 1;
  select user_id into v_manager from core.profile where role = 'manager' and is_active order by user_id limit 1;
  select user_id into v_sales   from core.profile where role = 'sales'   and is_active order by user_id limit 1;

  -- ─── ของชั่วคราว (rollback ลบทิ้ง) — โครงการ + ประเภทยูนิต + ยูนิต 5 ห้อง ───
  insert into core.project (code, name)
  values ('__ST4__', 'โครงการเทสต์ source registry')
  returning id into v_proj;

  insert into inventory.unit_type (project_id, code, size_sqm)
  values (v_proj, '__ST4__', 35.5)
  returning id into v_utype;

  insert into inventory.unit (project_id, unit_type_id, number, status, price) values
    (v_proj, v_utype, '__ST4__-01', 'available',   2900000),
    (v_proj, v_utype, '__ST4__-02', 'available',   3200000),
    (v_proj, v_utype, '__ST4__-03', 'hold',        1500000),
    (v_proj, v_utype, '__ST4__-04', 'booked',      5200000),
    (v_proj, v_utype, '__ST4__-05', 'transferred', 4500000);

  -- โปรโมชั่น (project_id เป็น varchar ของจริง — เทียบแบบ text) + แถว project_id มั่ว
  insert into public.promotions (promotion_id, project_id, name, offer, landing_page,
                                 start_date, end_date, status, created_at) values
    ('__ST4__1', v_proj::text, 'เปิดตัวเทสต์', 'ลด 5%', null,
     current_date - 10, current_date + 10, 'ACTIVE', now()),
    ('__ST4__2', v_proj::text, 'เปิดตัวเทสต์ ตัวพิมพ์เล็ก', 'ของแถม', null,
     current_date - 10, current_date + 10, 'active', now()),
    ('__ST4__3', v_proj::text, 'หมดอายุแล้ว', 'หมด', null,
     current_date - 40, current_date - 1, 'ACTIVE', now()),
    ('__ST4__J', 'not-a-uuid-at-all', 'โปรเจกต์ไอดีมั่ว', 'ห้ามโผล่', null,
     current_date - 10, current_date + 10, 'ACTIVE', now());

  -- fact กึ่งสาธารณะ/ภายใน (ตารางว่างจริง — id ไม่มี default ต้องใส่เอง)
  insert into public.project_facts (id, project_id, fact_key, value_text, is_public, verified_at) values
    (1, v_proj::text, 'payment_terms', 'ดาวน์ 10% ถึงกองกลาง 10%', 1, localtimestamp),
    (2, v_proj::text, 'location', 'ข้อมูลภายใน — ห้ามออก', 0, localtimestamp);

  -- ─── T11 ส่วนทะเบียน (ยังเป็น postgres — อ่านตารางตรงได้) ───

  -- 1. seed ครบ 10 แหล่ง (code ไม่ซ้ำการันตีด้วย unique constraint)
  select count(*) into v_n from answer_hub.source_registry;
  if v_n <> 10 then raise notice 'T11 ทะเบียนควรมี 10 แหล่ง ได้ %', v_n; v_fail := v_fail + 1; end if;

  -- 2. inactive = 3 placeholder พอดี (APPOINTMENT_SLOT / LEAD_PROFILE / LEAD_FOLLOWUP)
  select count(*) into v_n from answer_hub.source_registry where not active;
  if v_n <> 3 then raise notice 'T11 inactive ควรมี 3 ได้ %', v_n; v_fail := v_fail + 1; end if;
  select count(*) into v_n from answer_hub.source_registry
    where not active and source_code in ('APPOINTMENT_SLOT','LEAD_PROFILE','LEAD_FOLLOWUP');
  if v_n <> 3 then raise notice 'T11 ชุด inactive ไม่ตรงสเปก (%)', v_n; v_fail := v_fail + 1; end if;

  -- 3. T11.11 โครงสร้าง: object_name ต้องเป็น answer_hub.src_* เท่านั้น (ไม่มีทางเป็น SQL fragment)
  --    และทุกชื่อต้องมีฟังก์ชันอยู่จริง — resolver ไม่มีทางถูกชี้เข้าที่ไม่มีจริง
  select count(*) into v_n from answer_hub.source_registry
    where object_name !~ '^answer_hub\.src_[a-z_]+$';
  if v_n <> 0 then raise notice 'T11.11 object_name หลุดรูปแบบ src_* % แถว', v_n; v_fail := v_fail + 1; end if;
  select count(*) into v_n from answer_hub.source_registry s
    where not exists (
      select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = split_part(s.object_name, '.', 1)
        and p.proname = split_part(s.object_name, '.', 2));
  if v_n <> 0 then raise notice 'T11.11 object_name ชี้ฟังก์ชันที่ไม่มีจริง % แถว', v_n; v_fail := v_fail + 1; end if;

  -- 4. T11.4/5/6 ด่าน src_check_allowed — บอทถูกปิดหมดตอน seed (deny by default)
  r := answer_hub.src_check_allowed('PROJECT_PROFILE', true);
  if (r->>'allowed')::boolean then raise notice 'T11.6 บอทอ่านได้ทั้งที่ bot_allowed=false'; v_fail := v_fail + 1; end if;
  if r->>'reason' <> 'bot_not_allowed' then raise notice 'T11.6 reason ผิด: %', r->>'reason'; v_fail := v_fail + 1; end if;
  r := answer_hub.src_check_allowed('PROJECT_PROFILE', false);
  if not (r->>'allowed')::boolean then raise notice 'T11.5 คนอ่านไม่ได้ทั้งที่ human_allowed=true: %', r->>'reason'; v_fail := v_fail + 1; end if;
  r := answer_hub.src_check_allowed('APPOINTMENT_SLOT', false);
  if r->>'reason' <> 'source_inactive' then raise notice 'T11.4 แหล่งปิดต้องโดน source_inactive: %', r->>'reason'; v_fail := v_fail + 1; end if;
  r := answer_hub.src_check_allowed('APPOINTMENT_SLOT', true);
  if (r->>'allowed')::boolean then raise notice 'T11.4 แหล่งปิดแต่บอทอ่านได้'; v_fail := v_fail + 1; end if;
  r := answer_hub.src_check_allowed('ไม่มีโค้ดนี้', false);
  if r->>'reason' <> 'source_not_found' then raise notice 'T11 โค้ดแปลกต้อง source_not_found: %', r->>'reason'; v_fail := v_fail + 1; end if;

  -- 5. พลิกธงแล้วด่านเปลี่ยนตามจริง (แก้ข้างใน rollback — ไม่ทิ้งฐาน)
  update answer_hub.source_registry set bot_allowed = true, human_allowed = false
    where source_code = 'PROJECT_PROFILE';
  r := answer_hub.src_check_allowed('PROJECT_PROFILE', true);
  if not (r->>'allowed')::boolean then raise notice 'T11.6 เปิด bot_allowed แล้วบอทยังโดนกัน: %', r->>'reason'; v_fail := v_fail + 1; end if;
  r := answer_hub.src_check_allowed('PROJECT_PROFILE', false);
  if (r->>'allowed')::boolean or r->>'reason' <> 'human_not_allowed' then
    raise notice 'T11.5 ปิด human_allowed แล้วคนยังผ่าน: %', r->>'reason'; v_fail := v_fail + 1;
  end if;
  update answer_hub.source_registry set bot_allowed = false, human_allowed = true
    where source_code = 'PROJECT_PROFILE';

  -- ─── T11 ส่วนตัวอ่าน ERP จริง (src_* — security definer เรียกได้จากที่นี่) ───

  -- 6. T11.10 โครงการไม่มีจริง → missing อย่างมีเหตุผล ไม่ crash
  r := answer_hub.src_project_profile(gen_random_uuid());
  if r->>'status' <> 'missing' or r->>'reason' <> 'project_not_found' then
    raise notice 'T11.10 โครงการมั่วต้อง missing: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_project_profile(v_proj);
  if r->>'status' <> 'ok' or r->'value'->>'name' <> 'โครงการเทสต์ source registry' then
    raise notice 'T11 profile อ่านโครงการจริงไม่ตรง: %', r; v_fail := v_fail + 1;
  end if;

  -- 7. T11.7/11.8 ราคา = min ของทุกยูนิต (price เป็น NOT NULL ของจริง — min ที่ 1.5M)
  r := answer_hub.src_project_price(v_proj);
  if r->>'status' <> 'ok' or (r->'value'->>'starting_price')::numeric <> 1500000
     or (r->'value'->>'unit_count')::int <> 5 then
    raise notice 'T11.7 ราคาเริ่มต้นไม่ตรงฐานจริง: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_project_price(gen_random_uuid());
  if r->>'status' <> 'missing' then raise notice 'T11.10 ราคาโครงการว่างต้อง missing: %', r; v_fail := v_fail + 1; end if;

  -- 8. T11.7 available_units นับเฉพาะ available · T11.8 สถานะอื่นไม่หลุดเข้าตัวเลขพร้อมขาย
  r := answer_hub.src_available_units(v_proj);
  if (r->'value'->>'available_units')::int <> 2
     or (r->'value'->>'hold')::int <> 1 or (r->'value'->>'booked')::int <> 1
     or (r->'value'->>'transferred')::int <> 1 or (r->'value'->>'contracted')::int <> 0 then
    raise notice 'T11.7/11.8 นับยูนิตตามสถานะไม่ตรง: %', r->'value'; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_available_units(v_proj, 'hold');
  if (r->'value'->>'filtered_units')::int <> 1 then
    raise notice 'T11 กรองสถานะ hold ควรได้ 1: %', r->'value'; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_available_units(v_proj, 'DROP TABLE x');
  if r->>'status' <> 'invalid' or r->>'reason' <> 'invalid_status' then
    raise notice 'T11.11 สถานะแปลกต้องโดนกรอง: %', r; v_fail := v_fail + 1;
  end if;

  -- 9. T11.9 varchar project_id: แถว project_id มั่วไม่ทำให้ cast พัง และไม่หลุดมาในผล
  r := answer_hub.src_current_promotion(v_proj);
  if r->>'status' <> 'ok' or jsonb_array_length(r->'value') <> 2 then
    raise notice 'T11.9 โปรโมชั่นควรเหลือ 2 แถว (ตัดหมดอายุ/ไอดีมั่ว): %', r; v_fail := v_fail + 1;
  end if;
  if r->'value' @> '[{"promotion_id":"__ST4__J"}]' or r->'value' @> '[{"promotion_id":"__ST4__3"}]' then
    raise notice 'T11.9 ผลมีแถวที่ห้ามโผล่'; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_current_promotion(gen_random_uuid());
  if r->>'status' <> 'missing' then raise notice 'T11.10 โปรโมชั่นโครงการว่างต้อง missing: %', r; v_fail := v_fail + 1; end if;

  -- 10. fact: ของ is_public ออก · ของภายใน + ไม่มีแถว = missing (ไม่เดา)
  r := answer_hub.src_project_fact(v_proj, 'payment_terms');
  if r->>'status' <> 'ok' or r->'value'->>'text' <> 'ดาวน์ 10% ถึงกองกลาง 10%' then
    raise notice 'T11 fact public อ่านไม่ตรง: %', r; v_fail := v_fail + 1;
  end if;
  r := answer_hub.src_project_fact(v_proj, 'location');
  if r->>'status' <> 'missing' then raise notice 'T11 fact ภายในต้องไม่ออก: %', r; v_fail := v_fail + 1; end if;
  r := answer_hub.src_project_fact(v_proj, 'facilities');
  if r->>'status' <> 'missing' then raise notice 'T11 fact ไม่มีแถวต้อง missing: %', r; v_fail := v_fail + 1; end if;

  -- 11. placeholder 3 แหล่ง — ยังไม่มีข้อมูลจริง = missing เสมอ (ห้ามแต่ง)
  r := answer_hub.src_lead_profile(gen_random_uuid());
  if r->>'status' <> 'missing' then raise notice 'T11 lead profile ต้อง missing: %', r; v_fail := v_fail + 1; end if;
  r := answer_hub.src_appointment_slots(gen_random_uuid());
  if r->>'status' <> 'missing' then raise notice 'T11 คิวนัดต้อง missing: %', r; v_fail := v_fail + 1; end if;
  r := answer_hub.src_lead_followup(gen_random_uuid());
  if r->>'status' <> 'missing' then raise notice 'T11 ติดตามลูกค้าต้อง missing: %', r; v_fail := v_fail + 1; end if;

  -- ─── T11 ส่วนประตู ah_source_* (impersonate JWT ต่อ role) ───
  set local role authenticated;

  -- 12. T11.2 sales แก้ทะเบียนไม่ได้ · อ่านทะเบียนก็ไม่ได้ (manager ขึ้นไปเท่านั้น)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);
  begin
    perform inbox.ah_source_save(jsonb_build_object('source_code', 'PROJECT_PROFILE', 'active', false));
    raise notice 'T11.2 sales แก้ทะเบียนได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'T11.2 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;
  begin
    perform inbox.ah_source_list('{}'::jsonb);
    raise notice 'T11 sales อ่านทะเบียนได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'T11 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  -- 13. T11.1 admin อ่านครบ 10 พร้อมทุกคอลัมน์ที่หน้า admin ต้องใช้ · กรอง active=false ได้ 3
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  r := inbox.ah_source_list('{}'::jsonb);
  if (r->>'total')::int <> 10 or (r->'rows'->0) ? 'bot_allowed' is false
     or (r->'rows'->0) ? 'human_allowed' is false or (r->'rows'->0) ? 'freshness_seconds' is false then
    raise notice 'T11.1 admin อ่านทะเบียนไม่ครบ: %', r->>'total'; v_fail := v_fail + 1;
  end if;
  r := inbox.ah_source_list(jsonb_build_object('active', false));
  if (r->>'total')::int <> 3 then raise notice 'T11 กรอง inactive ควรได้ 3 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;

  -- 14. manager อ่านได้แต่แก้ไม่ได้
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager)::text, true);
  r := inbox.ah_source_list('{}'::jsonb);
  if (r->>'total')::int <> 10 then raise notice 'T11 manager อ่านทะเบียนไม่ได้: %', r->>'total'; v_fail := v_fail + 1; end if;
  begin
    perform inbox.ah_source_save(jsonb_build_object('source_code', 'PROJECT_PROFILE', 'description', 'แก้ลับ ๆ'));
    raise notice 'T11.2 manager แก้ทะเบียนได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_not_allowed' then raise notice 'T11.2 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;

  -- 15. T11.1 admin พลิกธงผ่านประตูแล้วค่าเปลี่ยนจริง + ค่า freshness ติดลบโดนกัน
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  r := inbox.ah_source_save(jsonb_build_object('source_code', 'AVAILABLE_UNITS', 'bot_allowed', true));
  if (r->>'bot_allowed')::boolean is distinct from true then
    raise notice 'T11.1 เปิดธงผ่านประตูไม่สำเร็จ: %', r; v_fail := v_fail + 1;
  end if;
  begin
    perform inbox.ah_source_save(jsonb_build_object('source_code', 'AVAILABLE_UNITS', 'freshness_seconds', -5));
    raise notice 'T11.1 freshness ติดลบผ่าน — ต้องห้าม'; v_fail := v_fail + 1;
  exception when others then
    if sqlerrm <> 'ah_invalid' then raise notice 'T11.1 ได้ %', sqlerrm; v_fail := v_fail + 1; end if;
  end;
  r := inbox.ah_source_save(jsonb_build_object('source_code', 'AVAILABLE_UNITS', 'bot_allowed', false));
  if (r->>'bot_allowed')::boolean is distinct from false then
    raise notice 'T11.1 คืนธงไม่สำเร็จ: %', r; v_fail := v_fail + 1;
  end if;

  -- 16. T11.3 service_role (ทางบอท) แก้ทะเบียนไม่ได้แม้แต่ขั้น grant
  execute 'set local role service_role';
  begin
    perform inbox.ah_source_save('{}'::jsonb);
    raise notice 'T11.3 service_role แก้ทะเบียนได้ — ต้องห้าม'; v_fail := v_fail + 1;
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  execute 'set local role authenticated';

  if v_fail > 0 then
    raise exception 'selftest พบปัญหา % จุด', v_fail;
  end if;
  raise notice 'ah_source_registry_selftest ผ่านทั้งหมด';
end $test$;

rollback;
