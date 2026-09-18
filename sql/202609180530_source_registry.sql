-- =====================================================================
-- answer-hub source registry (Phase 4) — ทะเบียนแหล่งข้อมูล + ตัวอ่าน ERP จริง
-- =====================================================================
-- หลักการ (AUDIT.md §4.3 + DATABASE.md §6):
--   * ทะเบียนเก็บ "ชื่อฟังก์ชัน" (object_name) ที่ resolver เรียกเท่านั้น — ห้าม
--     interpolate SQL จากแถวใด ๆ เด็ดขาด
--   * ข้อมูล dynamic อ่านจากตาราง ERP ของจริงเสมอ ไม่มี fake data — ค่าที่ไม่มี
--     คืน status 'missing' พร้อมเหตุผล (ห้ามเดา) — ฝั่ง render ใช้ fallback_text (Phase 5)
--   * บอทกับคนใช้แหล่งเดียวกัน ต่างกันที่ "ตัวกรอง" (ADR-001) — ตัวกรองคือ
--     bot_allowed / human_allowed / active ในทะเบียน ตรวจผ่าน src_check_allowed
--     (บอทปิดหมดตอน seed — เปิดเมื่อถึง Phase 15 ทีละแหล่ง)
--   * placeholder 3 แหล่ง (APPOINTMENT_SLOT / LEAD_PROFILE / LEAD_FOLLOWUP) ยังไม่มี
--     data จริงพอ → seed เป็น inactive ไว้ก่อน เปิดได้โดยไม่ต้อง deploy ใหม่
--
-- สิทธิ์ (DATABASE.md §RPC): ah_source_list = manager/admin · ah_source_save = admin
--   แหล่งเพิ่ม/ลดทำผ่าน migration เท่านั้น — หน้าเว็บแก้ได้แค่คุณธง/คำอธิบาย
--
-- รันซ้ำได้ (create or replace + if not exists + on conflict do nothing)
-- ตัวตรวจ: sql/_selftest/ah_source_registry_selftest.sql
-- =====================================================================

-- ── ตาราง source_registry ───────────────────────────────────────────
create table if not exists answer_hub.source_registry (
  id                uuid primary key default gen_random_uuid(),
  source_code       text not null unique,
  source_type       text not null default 'rpc' check (source_type in ('view','rpc','api')),
  object_name       text not null,
  description       text,
  bot_allowed       boolean not null default false,
  human_allowed     boolean not null default true,
  freshness_seconds integer not null default 300,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists source_registry_active_idx on answer_hub.source_registry (active);
-- source_code มี unique constraint เป็น index ของตัวเองแล้ว — ไม่สร้างซ้ำ
create index if not exists source_registry_bot_allowed_idx on answer_hub.source_registry (bot_allowed);
create index if not exists source_registry_human_allowed_idx on answer_hub.source_registry (human_allowed);

create or replace trigger source_registry_touch
  before update on answer_hub.source_registry
  for each row execute function answer_hub.touch_updated_at();

alter table answer_hub.source_registry enable row level security;
revoke all on answer_hub.source_registry from public, anon, authenticated;

-- ── seed 10 แหล่ง (ตาม map จริงใน AUDIT.md §4.3) ────────────────────
insert into answer_hub.source_registry
  (source_code, source_type, object_name, description, active)
values
  ('PROJECT_PROFILE',     'rpc', 'answer_hub.src_project_profile',
   'ชื่อ/รหัส/สถานะ/วันเปิดขายโครงการ — core.project', true),
  ('PROJECT_PRICE',       'rpc', 'answer_hub.src_project_price',
   'ราคาเริ่มต้น (min price ของยูนิตที่มีราคา) — inventory.unit (ยูนิตว่าง → missing)', true),
  ('AVAILABLE_UNITS',     'rpc', 'answer_hub.src_available_units',
   'จำนวนยูนิตคงเหลือแยกตามสถานะ — inventory.unit', true),
  ('CURRENT_PROMOTION',   'rpc', 'answer_hub.src_current_promotion',
   'โปรโมชั่นที่ยังไม่หมดวัน — public.promotions (start_date..end_date + status ACTIVE)', true),
  ('PAYMENT_TERMS',       'rpc', 'answer_hub.src_project_fact',
   'เงื่อนไขการชำระเงิน — public.project_facts fact_key=payment_terms (ตารางยังว่าง → missing)', true),
  ('PROJECT_LOCATION',    'rpc', 'answer_hub.src_project_fact',
   'ที่ตั้งโครงการ — public.project_facts fact_key=location (ตารางยังว่าง → missing)', true),
  ('FACILITIES',          'rpc', 'answer_hub.src_project_fact',
   'สิ่งอำนวยความสะดวก — public.project_facts fact_key=facilities (ตารางยังว่าง → missing)', true),
  ('APPOINTMENT_SLOT',    'rpc', 'answer_hub.src_appointment_slots',
   'คิวนัดเข้าชมโครงการ — crm.activity type=site_visit (ยังไม่มี data จริง → ปิดไว้)', false),
  ('LEAD_PROFILE',        'rpc', 'answer_hub.src_lead_profile',
   'ข้อมูลลูกค้าเป้าหมาย — crm.lead (ยังไม่เปิดใช้)', false),
  ('LEAD_FOLLOWUP',       'rpc', 'answer_hub.src_lead_followup',
   'วันนัดติดตาม/นัดชม — connect_private.case_state (ยังไม่เปิดใช้)', false)
on conflict (source_code) do nothing;

-- ── ตัวอ่าน ERP จริง (src_*) ────────────────────────────────────────
-- รูปแบบคืนค่าเดียวกันทุกตัว:
--   {"status":"ok","value":…,"as_of":…}      มีค่าจริง
--   {"status":"missing","reason":"…"}        ไม่มีค่า — ห้ามเดา ให้ใช้ fallback_text
-- internal เท่านั้น (resolver เรียกผ่าน inbox.ah_* / security definer ต่อ) —
-- schema answer_hub ปิด usage ไว้แล้ว ข้างล่าง revoke execute ซ้ำอีกชั้นกันเหนียว

create or replace function answer_hub.src_project_profile(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('status', 'ok',
              'value', jsonb_build_object('project_id', p.id, 'code', p.code,
                        'name', p.name, 'status', p.status, 'launch_at', p.launch_at),
              'as_of', now())
     from core.project p
     where p.id = p_project_id),
    jsonb_build_object('status', 'missing', 'reason', 'project_not_found'))
$$;

create or replace function answer_hub.src_project_price(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- ERP ไม่มีคอลัมน์ currency — ไม่เด็ดค่าใส่ (missing currency ≠ ไทยบาทเสมอ)
  select coalesce(
    (select jsonb_build_object('status', 'ok',
              'value', jsonb_build_object('project_id', p.id,
                        'project_name', p.name,
                        'starting_price', min(u.price),
                        'unit_count', count(*)),
              'as_of', now())
     from inventory.unit u
     join core.project p on p.id = u.project_id
     where u.project_id = p_project_id and u.price is not null
     group by p.id, p.name),
    jsonb_build_object('status', 'missing', 'reason', 'no_priced_unit'))
$$;

create or replace function answer_hub.src_available_units(p_project_id uuid, p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  -- "พร้อมขาย" นับเฉพาะ status = available เท่านั้น — hold/booked/contracted/transferred
  -- ไม่ถูกนับใน available_units (ตัวเลขย่อยแยกสถานะให้ครบไว้เพื่อโชว์เหตุผล)
  -- p_status ถ้าส่งมา ต้องเป็น label จริงของ enum inventory.unit_status — ตรวจกับ
  -- catalog ไม่ใช่ free-form (ไม่มีทางกลายเป็น SQL fragment ได้)
  if p_status is not null then
    select exists (
      select 1
      from pg_catalog.pg_enum e
      join pg_catalog.pg_type t on t.oid = e.enumtypid
      where t.typname = 'unit_status' and e.enumlabel = p_status
    ) into v_ok;
    if not v_ok then
      return jsonb_build_object('status', 'invalid', 'reason', 'invalid_status');
    end if;
  end if;

  return jsonb_build_object('status', 'ok',
    'value', jsonb_build_object(
      'project_id',      p_project_id,
      'available_units', count(*) filter (where u.status = 'available'),
      'available',       count(*) filter (where u.status = 'available'),
      'hold',            count(*) filter (where u.status = 'hold'),
      'booked',          count(*) filter (where u.status = 'booked'),
      'contracted',      count(*) filter (where u.status = 'contracted'),
      'transferred',     count(*) filter (where u.status = 'transferred'),
      'status_filter',   p_status,
      'filtered_units',  case when p_status is null then null
                          else count(*) filter (where u.status = p_status::inventory.unit_status) end),
    'as_of', now())
  from inventory.unit u
  where u.project_id = p_project_id;
end $$;

create or replace function answer_hub.src_current_promotion(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if to_regclass('public.promotions') is null then
    return jsonb_build_object('status', 'missing', 'reason', 'source_unavailable');
  end if;
  -- promotions.project_id เป็น varchar ของจริง — เทียบเป็น text กัน cast สะดุดค่าประหลาด
  return (select coalesce(
    (select jsonb_build_object('status', 'ok',
              'value', jsonb_agg(
                jsonb_build_object('promotion_id', r.promotion_id,
                  'name', r.name, 'offer', r.offer,
                  'landing_page', r.landing_page,
                  'start_date', r.start_date, 'end_date', r.end_date)
                order by r.start_date desc),
              'as_of', now())
     from public.promotions r
     where r.project_id = p_project_id::text
       and upper(coalesce(r.status, '')) = 'ACTIVE'
       and r.start_date <= current_date
       and (r.end_date is null or r.end_date >= current_date)
     -- jsonb_agg บนแถวว่างยังคืน 1 แถว (value null) — ต้อง having กันไม่งั้น missing ไม่ขึ้น
     having count(*) > 0),
     jsonb_build_object('status', 'missing', 'reason', 'no_active_promotion')));
end;
$$;

create or replace function answer_hub.src_project_fact(p_project_id uuid, p_fact_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if to_regclass('public.project_facts') is null then
    return jsonb_build_object('status', 'missing', 'reason', 'source_unavailable');
  end if;
  -- อ่าน fact เดียวตาม fact_key (PAYMENT_TERMS/PROJECT_LOCATION/FACILITIES ชี้มาที่ตัวนี้)
  -- เอาแถว verify ล่าสุดที่ is_public เท่านั้น — ของภายในห้ามหลุดออกทางคำตอบ
  return (select coalesce(
    (select jsonb_build_object('status', 'ok',
              'value', jsonb_build_object('text', f.value_text, 'num', f.value_num,
                        'unit', f.unit, 'disclaimer', f.disclaimer,
                        'verified_at', f.verified_at),
              'as_of', now())
     from public.project_facts f
     where f.project_id = p_project_id::text
       and f.fact_key = trim(p_fact_key)
       and coalesce(f.is_public, 0) <> 0
     order by f.verified_at desc nulls last
     limit 1),
    jsonb_build_object('status', 'missing', 'reason', 'fact_not_found')));
end;
$$;

create or replace function answer_hub.src_appointment_slots(p_lead_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('status', 'ok',
              'value', jsonb_agg(
                jsonb_build_object('due_at', a.due_at) order by a.due_at),
              'as_of', now())
     from crm.activity a
     where a.lead_id = p_lead_id and a.type = 'site_visit' and a.done_at is null
     having count(*) > 0),
    jsonb_build_object('status', 'missing', 'reason', 'no_appointment'))
$$;

create or replace function answer_hub.src_lead_profile(p_lead_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('status', 'ok',
              'value', jsonb_build_object('budget', l.budget,
                        'interest_unit_type', l.interest_unit_type,
                        'source_channel', l.source_channel, 'score', l.score),
              'as_of', now())
     from crm.lead l
     where l.id = p_lead_id),
    jsonb_build_object('status', 'missing', 'reason', 'lead_not_found'))
$$;

create or replace function answer_hub.src_lead_followup(p_lead_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('status', 'ok',
              'value', jsonb_build_object('follow_up_at', c.follow_up_at,
                        'appointment_at', c.appointment_at),
              'as_of', now())
     from connect_private.case_state c
     where c.lead_id = p_lead_id
     limit 1),
    jsonb_build_object('status', 'missing', 'reason', 'no_case_state'))
$$;

-- ── ด่านสิทธิ์แหล่งข้อมูล (T11) — ที่เดียวสำหรับ resolver ───────────
-- ไม่ throw — คืน allowed/reason ให้ผู้เรียกเลือกทางเดินเอง (missing → fallback_text)
create or replace function answer_hub.src_check_allowed(p_source_code text, p_for_bot boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r answer_hub.source_registry;
begin
  select * into r from answer_hub.source_registry
    where source_code = upper(trim(p_source_code));
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'source_not_found');
  end if;
  if not r.active then
    return jsonb_build_object('allowed', false, 'reason', 'source_inactive');
  end if;
  if p_for_bot and not r.bot_allowed then
    return jsonb_build_object('allowed', false, 'reason', 'bot_not_allowed');
  end if;
  if not p_for_bot and not r.human_allowed then
    return jsonb_build_object('allowed', false, 'reason', 'human_not_allowed');
  end if;
  return jsonb_build_object('allowed', true, 'reason', 'ok',
    'object_name', r.object_name, 'freshness_seconds', r.freshness_seconds);
end $$;

-- ── ah_source_list — ทะเบียนทั้งหมด (manager/admin) ─────────────────
create or replace function inbox.ah_source_list(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  v_rows jsonb;
begin
  if v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.source_code), '[]'::jsonb)
  into v_rows
  from answer_hub.source_registry s
  where (p_data->>'active' is null or s.active = (p_data->>'active')::boolean);

  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows));
end $$;

-- ── ah_source_save — แก้ธง/คำอธิบายของแหล่งที่มีอยู่ (admin) ────────
create or replace function inbox.ah_source_save(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  v_code text := nullif(upper(trim(coalesce(p_data->>'source_code', ''))), '');
  r      answer_hub.source_registry;
begin
  if v_role <> 'admin' then
    perform answer_hub._fail('ah_not_allowed');
  end if;
  if p_data -> 'freshness_seconds' is not null
     and coalesce((p_data->>'freshness_seconds')::int, -1) < 0 then
    perform answer_hub._fail('ah_invalid');
  end if;

  -- แก้ได้เฉพาะแหล่งที่ทะเบียนมีอยู่ — เพิ่ม/ลดแหล่งทำผ่าน migration เท่านั้น
  if p_data->>'id' is not null then
    select * into r from answer_hub.source_registry where id = (p_data->>'id')::uuid for update;
  elsif v_code is not null then
    select * into r from answer_hub.source_registry where source_code = v_code for update;
  else
    perform answer_hub._fail('ah_invalid');
  end if;
  if not found then
    perform answer_hub._fail('ah_not_found');
  end if;

  update answer_hub.source_registry set
    bot_allowed       = coalesce((p_data->>'bot_allowed')::boolean, r.bot_allowed),
    human_allowed     = coalesce((p_data->>'human_allowed')::boolean, r.human_allowed),
    freshness_seconds = coalesce((p_data->>'freshness_seconds')::int, r.freshness_seconds),
    active            = coalesce((p_data->>'active')::boolean, r.active),
    description       = coalesce(nullif(trim(p_data->>'description'), ''), r.description)
  where id = r.id
  returning * into r;

  return to_jsonb(r);
end $$;

-- ── สิทธิ์เรียก: คน login เรียกประตูได้ — ตัวกรองจริงอยู่ในฟังก์ชัน ──
grant execute on function inbox.ah_source_list(jsonb) to authenticated;
grant execute on function inbox.ah_source_save(jsonb) to authenticated;
revoke all on function inbox.ah_source_list(jsonb) from public, anon;
revoke all on function inbox.ah_source_save(jsonb) from public, anon;

-- src_* เป็นของภายใน — กันเหนียว revoke execute จาก public (ตัว schema ปิดอยู่แล้ว)
revoke all on function answer_hub.src_project_profile(uuid)              from public;
revoke all on function answer_hub.src_project_price(uuid)               from public;
revoke all on function answer_hub.src_available_units(uuid, text)        from public;
revoke all on function answer_hub.src_current_promotion(uuid)           from public;
revoke all on function answer_hub.src_project_fact(uuid, text)          from public;
revoke all on function answer_hub.src_appointment_slots(uuid)           from public;
revoke all on function answer_hub.src_lead_profile(uuid)                from public;
revoke all on function answer_hub.src_lead_followup(uuid)               from public;
revoke all on function answer_hub.src_check_allowed(text, boolean)      from public;

notify pgrst, 'reload schema';
