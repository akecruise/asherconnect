-- =====================================================================
-- answer-hub service support (Phase 6) — ขยาย ah_list ให้หน้า service ใช้ได้ครบ
-- =====================================================================
-- หลักการ:
--   * ไม่มีตารางใหม่ — Phase 6 เป็นชั้น service (Node) ฝั่ง SQL มีแค่อัปเกรด
--     ah_list ให้กรองได้ครบตามที่ Answer Service ต้องใช้ (ARCHITECTURE.md Components)
--   * create or replace ทับ inbox.ah_list ของ hub เอง (Phase 2) — ตรรกะสิทธิ์เดิม
--     คงไว้ทุกอย่าง: สอง role ล่างเห็นแค่ approved เสมอ ไม่ว่าจะขอสถานะอะไร
--   * search รุ่นแรก = ilike บน title + body_template (เสถียร ไม่เพิ่ม dependency) —
--     คะแนน/trgm/question_pattern ทำใน Phase 14 ตาม ROADMAP
--   * filter ใหม่: audience / answer_type / source_type / language /
--     show_in_quick_answer / bot_auto_answer — ทุกตัว optional ส่ง null = ไม่กรอง
--
-- รันซ้ำได้ (create or replace) · ตัวตรวจ: sql/_selftest/ah_answer_service_selftest.sql
-- =====================================================================

-- ── ah_list รุ่นขยาย (Phase 6) ──────────────────────────────────────
create or replace function inbox.ah_list(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role   text := coalesce(core.current_user_role(), '');
  v_status text := nullif(trim(p_data->>'status'), '');
  v_query  text := nullif(trim(p_data->>'query'), '');
  v_page   int  := greatest(coalesce((p_data->>'page')::int, 1), 1);
  v_size   int  := least(greatest(coalesce((p_data->>'page_size')::int, 50), 1), 200);
  v_rows   jsonb;
  v_total  int;
begin
  if v_role = '' then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  -- สอง role ล่างเห็นได้แค่ approved เสมอ ไม่ว่าจะขอสถานะอะไรมา
  if v_role in ('manager', 'admin') then
    null; -- เห็นทุกสถานะ
  elsif v_status is null or v_status <> 'approved' then
    v_status := 'approved';
  end if;

  -- หน้าข้อมูลกับจำนวนทั้งหมดแยกกัน (aggregate + window ใน statement เดียวแล้ว
  --  PostgreSQL ตีความไม่ตรงเป้า) — ตัวกรองเขียนซ้ำสองรอบเพื่อให้ total เป็นของทั้งชุด
  with page as (
    select * from answer_hub.answer_item a
    where (v_status is null or a.status = v_status)
      and (p_data->>'category_id' is null or a.category_id = (p_data->>'category_id')::uuid)
      and (p_data->>'intent_id'   is null or a.intent_id   = (p_data->>'intent_id')::uuid)
      and (p_data->>'project_id'  is null or a.project_id  = (p_data->>'project_id')::uuid)
      and (v_query is null or a.title ilike '%' ||
           replace(replace(v_query, '\', '\\'), '%', '\%') || '%'
           or a.body_template ilike '%' ||
           replace(replace(v_query, '\', '\\'), '%', '\%') || '%')
      and (p_data->>'audience'  is null or a.audience  = p_data->>'audience')
      and (p_data->>'answer_type' is null or a.answer_type = p_data->>'answer_type')
      and (p_data->>'source_type' is null or a.source_type = p_data->>'source_type')
      and (p_data->>'language'  is null or a.language  = p_data->>'language')
      and (p_data->>'show_in_quick_answer' is null
           or a.show_in_quick_answer = (p_data->>'show_in_quick_answer')::boolean)
      and (p_data->>'bot_auto_answer' is null
           or a.bot_auto_answer = (p_data->>'bot_auto_answer')::boolean)
    order by a.priority, a.updated_at desc
    limit v_size offset (v_page - 1) * v_size
  )
  select coalesce(jsonb_agg(to_jsonb(p) order by p.priority, p.updated_at desc), '[]'::jsonb)
  into v_rows
  from page p;

  select count(*) into v_total
  from answer_hub.answer_item a
  where (v_status is null or a.status = v_status)
    and (p_data->>'category_id' is null or a.category_id = (p_data->>'category_id')::uuid)
    and (p_data->>'intent_id'   is null or a.intent_id   = (p_data->>'intent_id')::uuid)
    and (p_data->>'project_id'  is null or a.project_id  = (p_data->>'project_id')::uuid)
    and (v_query is null or a.title ilike '%' ||
         replace(replace(v_query, '\', '\\'), '%', '\%') || '%'
         or a.body_template ilike '%' ||
         replace(replace(v_query, '\', '\\'), '%', '\%') || '%')
    and (p_data->>'audience'  is null or a.audience  = p_data->>'audience')
    and (p_data->>'answer_type' is null or a.answer_type = p_data->>'answer_type')
    and (p_data->>'source_type' is null or a.source_type = p_data->>'source_type')
    and (p_data->>'language'  is null or a.language  = p_data->>'language')
    and (p_data->>'show_in_quick_answer' is null
         or a.show_in_quick_answer = (p_data->>'show_in_quick_answer')::boolean)
    and (p_data->>'bot_auto_answer' is null
         or a.bot_auto_answer = (p_data->>'bot_auto_answer')::boolean);

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'total', coalesce(v_total, 0));
end $$;

notify pgrst, 'reload schema';
