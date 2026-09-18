-- =====================================================================
-- selftest ของ Answer Service ฝั่ง SQL (Phase 6) — filter/pagination/search ของ ah_list
-- =====================================================================
-- ★ เขียนลงฐานแต่ห่อ begin … rollback · ของชั่วคราวติด __ST6__ / [__selftest__]
-- วิธีรัน:
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql "<conn>" -v ON_ERROR_STOP=1 -f sql/_selftest/ah_answer_service_selftest.sql
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
  v_sales   uuid;
  v_cat_a   uuid;
  v_cat_b   uuid;
  v_proj1   uuid;
  v_proj2   uuid;
  v_i1      uuid;
  r         jsonb;
  v_n       int;
begin
  select user_id into v_admin from core.profile where role = 'admin' and is_active order by user_id limit 1;
  select user_id into v_sales from core.profile where role = 'sales' and is_active order by user_id limit 1;

  -- ─── ของชั่วคราว: 2 หมวด + 2 โครงการ + 3 คำตอบ (approved 2 + draft 1) ───
  insert into answer_hub.answer_category (code, name_th)
  values ('__ST6A__', 'หมวดเทสต์ A') returning id into v_cat_a;
  insert into answer_hub.answer_category (code, name_th)
  values ('__ST6B__', 'หมวดเทสต์ B') returning id into v_cat_b;

  insert into core.project (code, name) values ('__ST6A__', 'โครงการเทสต์ service 1') returning id into v_proj1;
  insert into core.project (code, name) values ('__ST6B__', 'โครงการเทสต์ service 2') returning id into v_proj2;

  insert into answer_hub.answer_item
    (category_id, project_id, title, body_template, status, audience, answer_type,
     source_type, show_in_quick_answer, bot_auto_answer, language)
  values (v_cat_a, v_proj1, 'ราคาโปรโมชั่น [__selftest__]', 'ราคาเริ่ม {{price_start}}',
          'approved', 'human', 'static', 'manual', true, false, 'th')
  returning id into v_i1;

  insert into answer_hub.answer_item
    (category_id, project_id, title, body_template, status, audience, answer_type,
     source_type, show_in_quick_answer, bot_auto_answer, language)
  values
    (v_cat_b, v_proj2, 'ห้องว่างวันนี้ [__selftest__]',
     'ยูนิตคงเหลือ {{units_avail}} คำค้นเฉพาะในเนื้อหา__ST6__',
     'approved', 'bot', 'dynamic', 'imported', false, true, 'th');

  insert into answer_hub.answer_item
    (category_id, project_id, title, body_template, status, audience)
  values (v_cat_a, v_proj1, 'ทักทายลูกค้า [__selftest__]', 'สวัสดีค่ะ', 'draft', 'human');

  set local role authenticated;

  -- 1. S07 — กรอง category ได้ตรง (admin เห็นทุกสถานะ: A = approved + draft = 2)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin)::text, true);
  r := inbox.ah_list(jsonb_build_object('category_id', v_cat_a));
  if (r->>'total')::int <> 2 then raise notice 'S07 กรองหมวด A ควรได้ 2 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;

  -- 2. S08 — กรอง project ได้ตรง
  r := inbox.ah_list(jsonb_build_object('project_id', v_proj1));
  if (r->>'total')::int <> 2 then raise notice 'S08 กรองโครงการ 1 ควรได้ 2 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  r := inbox.ah_list(jsonb_build_object('project_id', v_proj2));
  if (r->>'total')::int <> 1 then raise notice 'S08 กรองโครงการ 2 ควรได้ 1 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;

  -- 3. S09 — search ทั้ง title และ body
  r := inbox.ah_list(jsonb_build_object('query', 'ราคาโปรโมชั่น', 'category_id', v_cat_a));
  if (r->>'total')::int <> 1 then raise notice 'S09 ค้น title ควรเจอ 1 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  r := inbox.ah_list(jsonb_build_object('query', 'คำค้นเฉพาะในเนื้อหา', 'category_id', v_cat_b));
  if (r->>'total')::int <> 1 or (r->'rows'->0->>'title') <> 'ห้องว่างวันนี้ [__selftest__]' then
    raise notice 'S09 ค้น body ต้องเจอห้องว่าง: %', r->>'total'; v_fail := v_fail + 1;
  end if;

  -- 4. S18 — pagination: total เป็นของทั้งชุด หน้าข้อมูลถูกตัดตาม page_size
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'page_size', 2, 'page', 1));
  if (r->>'total')::int <> 3 or jsonb_array_length(r->'rows') <> 2 then
    raise notice 'S18 หน้า 1 ต้อง 2 แถว total 3: total=% rows=%', r->>'total', jsonb_array_length(r->'rows');
    v_fail := v_fail + 1;
  end if;
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'page_size', 2, 'page', 2));
  if (r->>'total')::int <> 3 or jsonb_array_length(r->'rows') <> 1 then
    raise notice 'S18 หน้า 2 ต้อง 1 แถว total 3: total=% rows=%', r->>'total', jsonb_array_length(r->'rows');
    v_fail := v_fail + 1;
  end if;

  -- 5. filter ใหม่ทั้งชุด (audience / bot_auto_answer / answer_type / source_type /
  --    show_in_quick_answer / language)
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'audience', 'bot'));
  if (r->>'total')::int <> 1 then raise notice 'กรอง audience=bot ควรได้ 1 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'bot_auto_answer', true));
  if (r->>'total')::int <> 1 or (r->'rows'->0->>'bot_auto_answer') <> 'true' then
    raise notice 'กรอง bot_auto_answer ไม่ตรง: %', r->>'total'; v_fail := v_fail + 1;
  end if;
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'answer_type', 'dynamic'));
  if (r->>'total')::int <> 1 then raise notice 'กรอง answer_type ควรได้ 1 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'source_type', 'imported'));
  if (r->>'total')::int <> 1 then raise notice 'กรอง source_type ควรได้ 1 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'show_in_quick_answer', false));
  if (r->>'total')::int <> 1 then raise notice 'กรอง show_in_quick_answer=false ควรได้ 1 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'language', 'th'));
  if (r->>'total')::int <> 3 then raise notice 'กรอง language=th ควรได้ 3 ได้ %', r->>'total'; v_fail := v_fail + 1; end if;

  -- 6. สิทธิ์เดิมคงเดิม — sales เห็นแค่ approved · ขอ draft ถูกบังคับกลับเป็น approved
  --    (พฤติกรรมดั้งเดิม Phase 2 ที่ selftest ตอนนั้นรับรอง — ไม่ใช่ของ Phase 6 เปลี่ยน)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sales)::text, true);
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]'));
  if (r->>'total')::int <> 2 then raise notice 'sales ต้องเห็น approved 2 เท่านั้น ได้ %', r->>'total'; v_fail := v_fail + 1; end if;
  r := inbox.ah_list(jsonb_build_object('query', '[__selftest__]', 'status', 'draft'));
  if (r->>'total')::int <> 2
     or exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'status' <> 'approved') then
    raise notice 'sales ขอ draft ต้องถูกบังคับเป็น approved 2: %', r->>'total'; v_fail := v_fail + 1;
  end if;

  -- 7. S15 — invalid id: SQL โยน cast error (เหตุผลที่ Answer Service ตรวจ uuid ก่อนยิง
  --    และ safeCodes ปิดทางรั่วบน HTTP — บันทึกพฤติกรรมไว้เป็นหลักฐาน)
  begin
    perform inbox.ah_get(jsonb_build_object('id', 'ไม่ใช่uuid'));
    raise notice 'S15 invalid uuid ผ่าน — ต้อง error'; v_fail := v_fail + 1;
  exception when others then
    null; -- คาดหมาย: invalid_input_syntax — ตัว service กันไม่ให้ถึงจุดนี้
  end;

  if v_fail > 0 then
    raise exception 'selftest พบปัญหา % จุด', v_fail;
  end if;
  raise notice 'ah_answer_service_selftest ผ่านทั้งหมด';
end $test$;

rollback;
