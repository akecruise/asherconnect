-- =====================================================================
-- answer-hub resolve detail (Phase 6 ต่อเนื่อง) — detail ระบุ source_code
-- =====================================================================
-- เหตุผล: Answer Service (services/answer-hub/service.mjs) ต้องประกอบ
-- "sources_used" ให้หน้าเว็บ/บอทตรวจย้อนได้ว่าคำตอบใช้แหล่งใด — ผล detail เดิม
-- มีแต่ variable/status/reason ไม่รู้ว่าตัวแปรนั้นมาจากแหล่งไหน
-- แก้ที่เดียว: create or replace ทับ inbox.ah_resolve ของ hub เอง (Phase 5)
-- ตรรกะ values/missing คงเดิมทุกอย่าง (selftest Phase 5 ต้องยังผ่าน)
--
-- รันซ้ำได้ · ตัวตรวจ: sql/_selftest/ah_answer_binding_selftest.sql (+ เพิ่มเคส source_code)
-- =====================================================================

create or replace function inbox.ah_resolve(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role    text := coalesce(core.current_user_role(), '');
  v_item    answer_hub.answer_item;
  b         record;
  v_vals    jsonb := '{}'::jsonb;
  v_detail  jsonb := '[]'::jsonb;
  v_missing text[] := '{}';
  v_sources text[] := '{}';
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

    -- ทะเบียนแหล่งที่ถูกใช้จริง (ไม่ซ้ำ) — ตัว denied/missing ก็นับเพราะ "พยายามใช้"
    if not (v_sources @> array[b.source_code]) then
      v_sources := v_sources || b.source_code;
    end if;

    if coalesce(v_val, '') <> '' then
      v_vals := v_vals || jsonb_build_object(b.variable_name, v_val);
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'ok', 'value', v_val));
    elsif b.fallback_text is not null then
      v_vals := v_vals || jsonb_build_object(b.variable_name, b.fallback_text);
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'fallback', 'reason', v_res->>'reason'));
    elsif b.required then
      v_missing := v_missing || b.variable_name;
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'missing', 'reason', coalesce(v_res->>'reason', 'no_value')));
    else
      -- optional ขาดและไม่มี fallback → แทนด้วยค่าว่างตอน render
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'variable', b.variable_name, 'source_code', b.source_code,
        'status', 'missing', 'reason', coalesce(v_res->>'reason', 'no_value')));
    end if;
  end loop;

  return jsonb_build_object(
    'answer_id', v_item.id,
    'status', v_item.status,
    'values', v_vals,
    'missing', to_jsonb(v_missing),
    'sources', to_jsonb(v_sources),
    'ok', (array_length(v_missing, 1) is null),
    'detail', v_detail);
end $$;

notify pgrst, 'reload schema';
