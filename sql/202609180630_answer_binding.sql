-- =====================================================================
-- answer-hub data binding (Phase 5) — ผูก {{variable}} เข้ากับแหล่งข้อมูลจริง
-- =====================================================================
-- หลักการ (DATABASE.md §7 + ARCHITECTURE "Source Registry flow"):
--   * คำตอบเขียน {{variable}} ไว้ใน body_template · ตารางนี้บอกว่า variable ไหน
--     ดึงค่าจากแหล่งไหน (source_registry) ด้วยกุญแจอะไร (source_field)
--   * resolve เดินผ่าน src_check_allowed ก่อนเสมอ — active + bot/human_allowed
--   * dispatcher ของ src_resolve เป็น CASE ตายตัว: object_name จากทะเบียน "เลือก
--     ทางเดิน" จากทางที่เขียนไว้ในไฟล์นี้เท่านั้น — ไม่มี EXECUTE/format SQL จากค่าใด
--   * ค่าที่ไม่มีจริง = missing + เหตุผล · required ขาด = อยู่ใน missing list
--     (ห้ามส่งข้อความออกอัตโนมัติ) · optional ขาด = ใช้ fallback_text ถ้ามี
--   * uuid ใน context ตรวจรูปแบบก่อน cast ทุกครั้ง — ค่ามั่วได้ invalid_context
--     ไม่ใช่ exception (T11.10 ต่อยอด)
--
-- source_field ใช้สองหน้าที่: (1) fact_key ของ src_project_fact (ส่งผ่าน context)
--   (2) กุญแจเข้า value ของแหล่งที่คืน object (เช่น PROJECT_PROFILE + 'name' → ชื่อโครงการ)
--
-- ah_get อัปเกรดคืน {item, versions, bindings} — ผู้เรียกเดิม (selftest Phase 2/3)
-- ใช้แค่กรณีตรวจสิทธิ์ ไม่ยึดรูปทรง (ยืนยันจากไฟล์ selftest ก่อนแก้)
--
-- รันซ้ำได้ (create or replace + if not exists) · ตัวตรวจ: sql/_selftest/ah_answer_binding_selftest.sql
-- =====================================================================

-- ── ตาราง answer_data_binding ───────────────────────────────────────
create table if not exists answer_hub.answer_data_binding (
  id                uuid primary key default gen_random_uuid(),
  answer_item_id    uuid not null references answer_hub.answer_item(id) on delete cascade,
  variable_name     text not null,
  source_id         uuid not null references answer_hub.source_registry(id) on delete restrict,
  source_field      text,
  required          boolean not null default true,
  fallback_text     text,
  cache_ttl_seconds integer not null default 300,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (answer_item_id, variable_name)
);

create or replace trigger answer_data_binding_touch
  before update on answer_hub.answer_data_binding
  for each row execute function answer_hub.touch_updated_at();

alter table answer_hub.answer_data_binding enable row level security;
revoke all on answer_hub.answer_data_binding from public, anon, authenticated;

-- ── dispatcher กลาง — ทางเดียวที่ทุก resolver เรียกแหล่งข้อมูล ──────
create or replace function answer_hub.src_resolve(p_source_code text, p_context jsonb default '{}', p_for_bot boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r      answer_hub.source_registry;
  v_gate jsonb;
  v_pid  text := nullif(trim(coalesce(p_context->>'project_id', '')), '');
  v_lid  text := nullif(trim(coalesce(p_context->>'lead_id', '')), '');
  v_out  jsonb;
begin
  v_gate := answer_hub.src_check_allowed(p_source_code, p_for_bot);
  if not coalesce((v_gate->>'allowed')::boolean, false) then
    return jsonb_build_object('status', 'denied', 'reason', v_gate->>'reason');
  end if;

  select * into r from answer_hub.source_registry
    where source_code = upper(trim(p_source_code));

  -- uuid ตรวจรูปแบบก่อน cast — ค่ามั่วต้องเป็น invalid_context ไม่ใช่ exception ดิบ
  if (v_pid is not null and v_pid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (v_lid is not null and v_lid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return jsonb_build_object('status', 'invalid', 'reason', 'invalid_context');
  end if;

  -- CASE ตายตัว — ทะเบียนเลือกทางเดิน สร้างทางใหม่ไม่ได้
  v_out := case r.object_name
    when 'answer_hub.src_project_profile' then
      answer_hub.src_project_profile(v_pid::uuid)
    when 'answer_hub.src_project_price' then
      answer_hub.src_project_price(v_pid::uuid)
    when 'answer_hub.src_available_units' then
      answer_hub.src_available_units(v_pid::uuid, nullif(trim(coalesce(p_context->>'status', '')), ''))
    when 'answer_hub.src_current_promotion' then
      answer_hub.src_current_promotion(v_pid::uuid)
    when 'answer_hub.src_project_fact' then
      answer_hub.src_project_fact(v_pid::uuid, nullif(trim(coalesce(p_context->>'source_field', '')), ''))
    when 'answer_hub.src_appointment_slots' then
      answer_hub.src_appointment_slots(v_lid::uuid)
    when 'answer_hub.src_lead_profile' then
      answer_hub.src_lead_profile(v_lid::uuid)
    when 'answer_hub.src_lead_followup' then
      answer_hub.src_lead_followup(v_lid::uuid)
    else null
  end;

  if v_out is null then
    return jsonb_build_object('status', 'missing', 'reason', 'source_unavailable');
  end if;
  return v_out;
end $$;

-- ── ah_binding_save — ผูก/แก้ variable (manager/admin) ─────────────
create or replace function inbox.ah_binding_save(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  v_item uuid := (p_data->>'answer_item_id')::uuid;
  v_var  text;
  v_src  answer_hub.source_registry;
  b      answer_hub.answer_data_binding;
begin
  if v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  -- เก็บไม่มีปีกกา ตัวพิมพ์เล็ก: {{Project_Name}} → project_name
  v_var := lower(regexp_replace(coalesce(p_data->>'variable_name', ''), '\s|\{|\}', '', 'g'));
  if v_var is null or v_var = '' or v_var !~ '^[a-z_][a-z0-9_]*$' then
    perform answer_hub._fail('ah_invalid');
  end if;
  if v_item is null
     or not exists (select 1 from answer_hub.answer_item where id = v_item) then
    perform answer_hub._fail('ah_not_found');
  end if;
  -- ของที่ปลดใช้แล้วห้ามผูกข้อมูลเพิ่ม
  if exists (select 1 from answer_hub.answer_item where id = v_item and status = 'retired') then
    perform answer_hub._fail('ah_state_not_allowed');
  end if;

  if p_data->>'source_id' is not null then
    select * into v_src from answer_hub.source_registry where id = (p_data->>'source_id')::uuid;
  elsif p_data->>'source_code' is not null then
    select * into v_src from answer_hub.source_registry
      where source_code = upper(trim(p_data->>'source_code'));
  else
    perform answer_hub._fail('ah_invalid');
  end if;
  if not found then
    perform answer_hub._fail('ah_not_found');
  end if;
  if p_data -> 'cache_ttl_seconds' is not null
     and coalesce((p_data->>'cache_ttl_seconds')::int, -1) < 0 then
    perform answer_hub._fail('ah_invalid');
  end if;

  -- ผูกซ้ำ (item, variable) เดิม = แก้ของเดิม ไม่ใช่สร้างซ้อน
  insert into answer_hub.answer_data_binding
    (answer_item_id, variable_name, source_id, source_field, required, fallback_text, cache_ttl_seconds)
  values (
    v_item, v_var, v_src.id,
    nullif(trim(coalesce(p_data->>'source_field', '')), ''),
    coalesce((p_data->>'required')::boolean, true),
    nullif(p_data->>'fallback_text', ''),
    coalesce((p_data->>'cache_ttl_seconds')::int, 300))
  on conflict (answer_item_id, variable_name) do update set
    source_id         = excluded.source_id,
    source_field      = excluded.source_field,
    required          = excluded.required,
    fallback_text     = excluded.fallback_text,
    cache_ttl_seconds = excluded.cache_ttl_seconds
  returning * into b;

  return to_jsonb(b);
end $$;

-- ── ah_binding_list — ผูกทั้งหมดของคำตอบ (manager/admin) ───────────
create or replace function inbox.ah_binding_list(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  v_rows jsonb;
begin
  if v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  select coalesce(jsonb_agg(to_jsonb(d) order by d.variable_name), '[]'::jsonb)
  into v_rows
  from answer_hub.answer_data_binding d
  where d.answer_item_id = (p_data->>'answer_item_id')::uuid;

  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end $$;

-- ── ah_binding_delete — ถอดผูก (manager/admin) ─────────────────────
create or replace function inbox.ah_binding_delete(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  b      answer_hub.answer_data_binding;
begin
  if v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  delete from answer_hub.answer_data_binding
  where id = (p_data->>'id')::uuid
  returning * into b;

  if not found then
    perform answer_hub._fail('ah_not_found');
  end if;
  return to_jsonb(b);
end $$;

-- ── ah_resolve — resolveAnswer(answerId, context) สำหรับฝั่งคน ─────
-- ตัวเดียวจบ: อ่าน binding ของคำตอบ → เรียก src_resolve ทีละตัว → คืน values
-- พร้อมกุญแจ {{variable}} + missing list (required ขาด) — ผู้เรียก (render.mjs,
-- หน้าเว็บ, บอทในอนาคต) ใช้ values/missing ต่อ ห้ามเดาค่าเอง
create or replace function inbox.ah_resolve(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role    text := coalesce(core.current_user_role(), '');
  v_item    answer_hub.answer_item;
  b         record;
  v_vals    jsonb := '{}'::jsonb;
  v_detail  jsonb := '[]'::jsonb;
  v_missing text[] := '{}';
  v_res     jsonb;
  v_raw     jsonb;
  v_val     text;
  v_ctx     jsonb;
begin
  if v_role = '' then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  select * into v_item from answer_hub.answer_item
    where id = (p_data->>'answer_id')::uuid;
  if not found then
    perform answer_hub._fail('ah_not_found');
  end if;
  -- คนทั่วไป resolve ได้เฉพาะของ approved — ของร่าง/รอตรวจเห็นได้เฉพาะ manager+
  if v_item.status <> 'approved' and v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  for b in
    select bd.*, s.source_code
    from answer_hub.answer_data_binding bd
    join answer_hub.source_registry s on s.id = bd.source_id
    where bd.answer_item_id = v_item.id
    order by bd.variable_name
  loop
    -- source_field ของ binding ต้องเดินทางไปถึง dispatcher ด้วย (src_project_fact
    -- ใช้เป็น fact_key) — คุมบริบทอื่นของผู้เรียกไว้ครบด้วย merge
    v_ctx := coalesce(p_data->'context', '{}'::jsonb)
             || jsonb_build_object('source_field', b.source_field);
    v_res := answer_hub.src_resolve(b.source_code, v_ctx, false);
    v_val := null;

    if coalesce(v_res->>'status', '') = 'ok' then
      if jsonb_typeof(v_res->'value') = 'array' then
        -- แหล่งที่คืนหลายแถว (เช่น CURRENT_PROMOTION) — ใช้กุญแจจากแถวแรกที่มีกุญแจนั้น
        select x -> b.source_field into v_raw
        from jsonb_array_elements(v_res->'value') x
        where b.source_field is not null and (x -> b.source_field) is not null
        limit 1;
      else
        -- object: กุญแจที่ผูกไว้ (source_field) ก่อน แล้วค่าแสดงมาตรฐานของ fact
        -- (text → num — fact_key กับกุญแจใน value เป็นคนละหน้าที่ จึงหาตามลำดับ)
        -- ไม่เจอทั้งคู่และไม่ได้ผูกกุญแจ = ยัดของเดิมให้ตัวกรอง scalar ตัดสิน
        v_raw := null;
        if b.source_field is not null then
          v_raw := v_res->'value'->b.source_field;
        end if;
        if v_raw is null then
          v_raw := coalesce(v_res->'value'->'text', v_res->'value'->'num');
        end if;
        if v_raw is null and b.source_field is null then
          v_raw := v_res->'value';
        end if;
      end if;
      -- ยอมรับเฉพาะ scalar — object/array คือ "ค่าไม่พร้อมแสดง" ไม่ใช่ค่าสำหรับลูกค้า
      if jsonb_typeof(v_raw) in ('string', 'number', 'boolean') then
        v_val := v_raw #>> '{}';
      end if;
    end if;

    if coalesce(v_val, '') <> '' then
      v_vals := v_vals || jsonb_build_object(b.variable_name, v_val);
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'status', 'ok', 'value', v_val));
    elsif b.fallback_text is not null then
      v_vals := v_vals || jsonb_build_object(b.variable_name, b.fallback_text);
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'status', 'fallback', 'reason', v_res->>'reason'));
    elsif b.required then
      v_missing := v_missing || b.variable_name;
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'status', 'missing', 'reason', coalesce(v_res->>'reason', 'no_value')));
    else
      -- optional ขาดและไม่มี fallback → แทนด้วยค่าว่างตอน render
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'status', 'missing', 'reason', coalesce(v_res->>'reason', 'no_value')));
    end if;
  end loop;

  return jsonb_build_object(
    'answer_id', v_item.id,
    'status', v_item.status,
    'values', v_vals,
    'missing', to_jsonb(v_missing),
    'ok', (array_length(v_missing, 1) is null),
    'detail', v_detail);
end $$;

-- ── ah_get อัปเกรด — คืน {item, versions, bindings} ────────────────
-- (ผู้เรียกเดิมใช้แค่ตรวจสิทธิ์ — รูปทรงใหม่ตาม API.md ที่ออกแบบไว้ตั้งแต่ Phase 0)
create or replace function inbox.ah_get(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role     text := coalesce(core.current_user_role(), '');
  a          answer_hub.answer_item;
  v_versions jsonb;
  v_bindings jsonb;
begin
  if v_role = '' then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  select * into a from answer_hub.answer_item
  where id = (p_data->>'id')::uuid;
  if not found then
    perform answer_hub._fail('ah_not_found');
  end if;

  -- ลำดับเช็คสิทธิ์เดียวกับ ah_list: ของที่ยังไม่ approved เห็นได้เฉพาะ manager/admin
  if a.status <> 'approved' and v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.version_no desc), '[]'::jsonb)
  into v_versions
  from answer_hub.answer_version x
  where x.answer_item_id = a.id;

  select coalesce(jsonb_agg(to_jsonb(d) order by d.variable_name), '[]'::jsonb)
  into v_bindings
  from answer_hub.answer_data_binding d
  where d.answer_item_id = a.id;

  return jsonb_build_object('item', to_jsonb(a), 'versions', v_versions, 'bindings', v_bindings);
end $$;

-- ── สิทธิ์เรียก: คน login เรียกประตูได้ — ตัวกรองจริงอยู่ในฟังก์ชัน ──
grant execute on function inbox.ah_resolve(p_data jsonb)         to authenticated;
grant execute on function inbox.ah_binding_list(p_data jsonb)    to authenticated;
grant execute on function inbox.ah_binding_save(p_data jsonb)    to authenticated;
grant execute on function inbox.ah_binding_delete(p_data jsonb)  to authenticated;
revoke all on function inbox.ah_resolve(p_data jsonb)         from public, anon;
revoke all on function inbox.ah_binding_list(p_data jsonb)    from public, anon;
revoke all on function inbox.ah_binding_save(p_data jsonb)    from public, anon;
revoke all on function inbox.ah_binding_delete(p_data jsonb)  from public, anon;

-- src_resolve เป็นของภายใน (resolver ผ่านประตูเท่านั้น)
revoke all on function answer_hub.src_resolve(text, jsonb, boolean) from public;

notify pgrst, 'reload schema';
