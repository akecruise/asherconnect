-- =====================================================================
-- selftest ของ answer_hub foundation (Phase 1) — ของตั้งต้นครบ ปิดตายจริง
-- =====================================================================
-- ★ เขียนลงฐานแต่ห่อ begin … rollback ทั้งก้อน จบแล้วไม่เหลือแถวใด
-- วิธีรัน:
--   ALLOW_DB_TESTS=1 PGOPTIONS='-c asher.allow_db_tests=1' \
--     psql "<conn>" -v ON_ERROR_STOP=1 -f sql/_selftest/ah_foundation_selftest.sql
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
  v_fail int := 0;
  v_n int;
  v_ca timestamptz;
  v_ua timestamptz;
begin
  -- 1. หมวดครบ 10 หมวด
  select count(*) into v_n from answer_hub.answer_category;
  if v_n <> 10 then raise notice 'หมวดควรมี 10 แต่ได้ %', v_n; v_fail := v_fail + 1; end if;

  -- 2. intent ครบ 10 ตัว และทุกตัวชี้หมวดที่มีจริง
  select count(*) into v_n from answer_hub.intent;
  if v_n <> 10 then raise notice 'intent ควรมี 10 แต่ได้ %', v_n; v_fail := v_fail + 1; end if;

  select count(*) into v_n
  from answer_hub.intent i
  left join answer_hub.answer_category c on c.id = i.category_id
  where c.id is null;
  if v_n <> 0 then raise notice 'intent ที่ไม่มีหมวดแม่: %', v_n; v_fail := v_fail + 1; end if;

  -- 3. ตรวจว่าโค้ดซ้ำกันไม่ได้จริง (unique ทำงาน)
  begin
    insert into answer_hub.answer_category (code, name_th) values ('other', 'ซ้ำ');
    raise notice 'unique code ไม่ทำงาน — ใส่ other ซ้ำได้'; v_fail := v_fail + 1;
  exception when unique_violation then null;
  end;

  -- 4. ตารางต้องปิดตายกับ authenticated (revoke + RLS ไม่มี policy)
  execute 'set local role authenticated';
  begin
    perform 1 from answer_hub.answer_category limit 1;
    raise notice 'authenticated อ่าน answer_category ตรง ๆ ได้ — ต้องปิด'; v_fail := v_fail + 1;
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';

  -- 5. touch_updated_at ทำงานจริง (แก้แถวแล้ว updated_at ต้องเดิน)
  select created_at, updated_at into v_ca, v_ua
  from answer_hub.answer_category where code = 'other';
  update answer_hub.answer_category set icon = '__selftest__' where code = 'other';
  select updated_at into v_ua from answer_hub.answer_category where code = 'other';
  if v_ua <= v_ca then
    raise notice 'touch_updated_at ไม่เดิน (created % updated %)', v_ca, v_ua; v_fail := v_fail + 1;
  end if;
  update answer_hub.answer_category set icon = null where code = 'other';

  -- 6. ดัชนีค้นหาคำถามมีจริง
  select count(*) into v_n from pg_indexes
  where schemaname = 'answer_hub' and indexname = 'question_pattern_text_idx';
  if v_n <> 1 then raise notice 'ไม่พบดัชนี question_pattern_text_idx'; v_fail := v_fail + 1; end if;

  if v_fail > 0 then
    raise exception 'selftest พบปัญหา % จุด', v_fail;
  end if;
  raise notice 'ah_foundation_selftest ผ่านทั้งหมด';
end $test$;

rollback;
