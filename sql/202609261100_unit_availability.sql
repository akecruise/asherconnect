-- =====================================================================
-- 202609261100_unit_availability.sql — ห้องว่าง/ราคาจาก Asher CRM ในช่องตอบของเซลส์
-- =====================================================================
-- แหล่งความจริงคือ asher_crm.crm_units (สด ไม่คัดลอก) — ตรงกับ ADR-004 ของ Answer Hub
-- ★ inventory.unit ของ ERP ว่าง (ตรวจ 2026-09-26) จึงไม่ใช้
-- ★ ราคา 0 / null = "ยังไม่มีราคา" ไม่ใช่ราคาจริง — คืน null ให้หน้าจอขึ้น "สอบถามราคา"
-- ★ ตรวจ 2026-09-26: CRM มียูนิตเฉพาะ asher-nine (78) · asher-naii / asher-vibe = 0 ยูนิต
--
-- วิธีรันด้วยมือ (ไม่รันตอน deploy):
--   VPS: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < sql/202609261100_unit_availability.sql
--   ต้องรันหลัง 202609261000_media_library.sql (ใช้ inbox.media_library_role)
-- รันซ้ำได้

begin;

create or replace function inbox.unit_availability(p_project text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role text := inbox.media_library_role(); v_result jsonb;
begin
  if v_role = 'none' then raise exception 'not_allowed'; end if;
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'code', p.code, 'name', p.name,
      'total', (select count(*) from asher_crm.crm_units u where u.project_id = p.id),
      'available', (select count(*) from asher_crm.crm_units u where u.project_id = p.id and upper(u.status) = 'AVAILABLE'),
      'as_of', now(),
      'units', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'unit_number', u.unit_number,
                 'building', b.name,
                 'floor', coalesce(f.display_name, 'ชั้น ' || f.floor_number),
                 'floor_number', f.floor_number,
                 'type', t.name, 'bedrooms', t.bedrooms,
                 'area_sqm', u.area_sqm, 'view', nullif(u.view, ''), 'direction', nullif(u.direction, ''),
                 'price', case when coalesce(u.selling_price, 0) > 0 then u.selling_price
                               when coalesce(u.list_price, 0) > 0 then u.list_price end)
               order by f.floor_number nulls last, u.unit_number)
          from asher_crm.crm_units u
          left join asher_crm.crm_floors f on f.id = u.floor_id
          left join asher_crm.crm_buildings b on b.id = u.building_id
          left join asher_crm.crm_unit_types t on t.id = u.unit_type_id
         where u.project_id = p.id and upper(u.status) = 'AVAILABLE'), '[]'::jsonb)) as x
    from asher_crm.crm_projects p
    where p.status = 'active'
      and (p_project is null or p_project = '' or p.code = 'asher-' || lower(p_project) or p.code = lower(p_project))
  ) s;
  return v_result;
end $$;

revoke all on function inbox.unit_availability(text) from public, anon;
grant execute on function inbox.unit_availability(text) to authenticated, service_role;

commit;
