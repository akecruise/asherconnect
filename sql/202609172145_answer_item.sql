-- =====================================================================
-- answer-hub answer core (Phase 2) — ตารางคำตอบ + ประตู RPC ชุดแรก
-- =====================================================================
-- ตาราง answer_item คือหัวใจของคลัง — ทั้งคนขาย (Quick Answer) และบอทดึงจากที่เดียวกัน
-- ต่างกันที่ "ตัวกรอง" ไม่ใช่ต่างกันที่แหล่งข้อมูล (ADR-001)
--
-- ประตู RPC (inbox.ah_*) ยึดธรรมเนียมเดิมของระบบ:
--   * security definer set search_path = '' ทุกฟังก์ชัน
--   * ด่านสิทธิ์อยู่บรรทัดแรกของฟังก์ชันด้วย core.current_user_role()
--     (ตัวเดียวกับที่ sql/029 ใช้ — ไม่มีอำนาจจากหน้าจอ)
--   * error ที่ส่งออกเป็น "code" ล้วน (ah_*) ฝั่ง Node แปลเป็นข้อความไทยผ่าน safeCodes
--   * อ่านตรงตารางของ answer_hub ไม่ได้ (Phase 1 revoke หมดแล้ว) — ผ่านประตูนี้เท่านั้น
--
-- สิทธิ์ตาม role จริงของระบบ (AUDIT.md §3):
--   sales / senior_sales : อ่านคำตอบที่ approved เท่านั้น (อนุมัติไม่ได้ แก้ไม่ได้)
--   manager / admin      : เห็นทุกสถานะ + สร้าง/แก้ได้
--   admin                : อนุมัติ (approve) / ปลดใช้ (retire) เท่านั้น
--
-- รันซ้ำได้ (create or replace + if not exists) · ตัวตรวจ: sql/_selftest/ah_answer_item_selftest.sql
-- =====================================================================

-- ── ตาราง answer_item ───────────────────────────────────────────────
create table if not exists answer_hub.answer_item (
  id                  uuid primary key default gen_random_uuid(),
  category_id         uuid references answer_hub.answer_category(id) on delete restrict,
  intent_id           uuid references answer_hub.intent(id) on delete set null,
  title               text not null,
  body_template       text not null,
  answer_type         text not null default 'static' check (answer_type in ('static','dynamic','hybrid')),
  audience            text not null default 'both' check (audience in ('human','bot','both')),
  source_type         text not null default 'manual' check (source_type in ('manual','learned','imported','generated')),
  project_id          uuid references core.project(id) on delete restrict,
  language            text not null default 'th',
  status              text not null default 'draft' check (status in ('draft','review','approved','retired')),
  show_in_quick_answer boolean not null default true,
  bot_auto_answer     boolean not null default false,
  priority            integer not null default 100,
  confidence          numeric(4,3),
  valid_from          timestamptz,
  valid_to            timestamptz,
  approved_by         uuid,
  approved_at         timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists answer_item_status_idx on answer_hub.answer_item (status);
create index if not exists answer_item_project_idx on answer_hub.answer_item (project_id);
create index if not exists answer_item_category_idx on answer_hub.answer_item (category_id);
create index if not exists answer_item_intent_idx on answer_hub.answer_item (intent_id);

create or replace trigger answer_item_touch
  before update on answer_hub.answer_item
  for each row execute function answer_hub.touch_updated_at();

alter table answer_hub.answer_item enable row level security;
revoke all on answer_hub.answer_item from public, anon, authenticated;

-- ── ตัวช่วยกันพลาดภายใน ─────────────────────────────────────────────
-- โยน error เป็น code — ฝั่ง server.mjs มี safeCodes รับพอดี (เพิ่ม ah_* ที่นั่นด้วย)
create or replace function answer_hub._fail(p_code text) returns void
language plpgsql as $$
begin
  raise exception '%', p_code using errcode = 'P0001';
end $$;

-- ── ah_list ─────────────────────────────────────────────────────────
-- รายการคำตอบ พร้อมตัวกรอง · ผู้ใช้ทั่วไปเห็นแค่ approved · manager/admin เห็นทุกสถานะ
-- ★ ต่างจาก qr_list เดิม: สถานะเป็นพารามิเตอร์ ไม่ใช่ filter ตายตัว — หน้า admin ต้องเห็นของปิดได้
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
           replace(replace(v_query, '\', '\\'), '%', '\%') || '%')
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
         replace(replace(v_query, '\', '\\'), '%', '\%') || '%');

  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'total', coalesce(v_total, 0));
end $$;

-- ── ah_get ──────────────────────────────────────────────────────────
create or replace function inbox.ah_get(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  a      answer_hub.answer_item;
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

  return to_jsonb(a);
end $$;

-- ── ah_save ─────────────────────────────────────────────────────────
-- สร้าง/แก้ · manager ขึ้นไป · แก้ของที่ approved แล้ว = ดึงกลับมาเข้ารอบตรวจใหม่
-- (รุ่นเก่าถูกเก็บเป็น version ตั้งแต่ Phase 3 — จุดนี้ตั้งใจให้ไฟล์ถัดไปมาแทนที่)
create or replace function inbox.ah_save(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  v_id   uuid := (p_data->>'id')::uuid;
  a      answer_hub.answer_item;
begin
  if v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  -- ตรวจของที่ต้องมี — สร้างต้องมีทั้ง title/body_template · แก้ตรวจเฉพาะช่องที่ส่งมา
  -- (แก้บางครั้งส่งแค่ body_template ก็ควรผ่าน ไม่ใช่โดน ah_invalid ไปด้วย)
  if v_id is null then
    if coalesce(trim(p_data->>'title'), '') = '' or coalesce(trim(p_data->>'body_template'), '') = '' then
      perform answer_hub._fail('ah_invalid');
    end if;
  elsif (p_data -> 'title' is not null and coalesce(trim(p_data->>'title'), '') = '')
     or (p_data -> 'body_template' is not null and coalesce(trim(p_data->>'body_template'), '') = '') then
    perform answer_hub._fail('ah_invalid');
  end if;
  if p_data -> 'category_id' is not null and p_data->>'category_id' is not null
     and not exists (select 1 from answer_hub.answer_category where id = (p_data->>'category_id')::uuid) then
    perform answer_hub._fail('ah_not_found');
  end if;
  if p_data -> 'project_id' is not null and p_data->>'project_id' is not null
     and not exists (select 1 from core.project where id = (p_data->>'project_id')::uuid) then
    perform answer_hub._fail('ah_not_found');
  end if;

  if v_id is null then
    insert into answer_hub.answer_item (
      category_id, intent_id, title, body_template, answer_type, audience,
      source_type, project_id, language, status, show_in_quick_answer,
      bot_auto_answer, priority, confidence, valid_from, valid_to, created_by
    ) values (
      (p_data->>'category_id')::uuid, (p_data->>'intent_id')::uuid,
      trim(p_data->>'title'), p_data->>'body_template',
      coalesce(p_data->>'answer_type', 'static'), coalesce(p_data->>'audience', 'both'),
      coalesce(p_data->>'source_type', 'manual'), (p_data->>'project_id')::uuid,
      coalesce(nullif(trim(p_data->>'language'), ''), 'th'),
      -- ส่ง submit มา = เข้าคิวรออนุมัติ ไม่งั้นเป็นฉบับร่าง
      case when coalesce((p_data->>'submit')::boolean, false) then 'review' else 'draft' end,
      coalesce((p_data->>'show_in_quick_answer')::boolean, true),
      coalesce((p_data->>'bot_auto_answer')::boolean, false),
      coalesce((p_data->>'priority')::int, 100),
      (p_data->>'confidence')::numeric,
      (p_data->>'valid_from')::timestamptz, (p_data->>'valid_to')::timestamptz,
      auth.uid()
    )
    returning * into a;
  else
    select * into a from answer_hub.answer_item where id = v_id for update;
    if not found then
      perform answer_hub._fail('ah_not_found');
    end if;
    -- ของที่ปลดใช้แล้วห้ามแก้ — ต้องสร้างใหม่
    if a.status = 'retired' then
      perform answer_hub._fail('ah_state_not_allowed');
    end if;

    update answer_hub.answer_item set
      category_id            = coalesce((p_data->>'category_id')::uuid, a.category_id),
      intent_id              = case when p_data -> 'intent_id' is not null then (p_data->>'intent_id')::uuid else a.intent_id end,
      title                  = coalesce(nullif(trim(p_data->>'title'), ''), a.title),
      body_template          = coalesce(p_data->>'body_template', a.body_template),
      answer_type            = coalesce(p_data->>'answer_type', a.answer_type),
      audience               = coalesce(p_data->>'audience', a.audience),
      project_id             = case when p_data -> 'project_id' is not null then (p_data->>'project_id')::uuid else a.project_id end,
      language               = coalesce(nullif(trim(p_data->>'language'), ''), a.language),
      show_in_quick_answer   = coalesce((p_data->>'show_in_quick_answer')::boolean, a.show_in_quick_answer),
      bot_auto_answer        = coalesce((p_data->>'bot_auto_answer')::boolean, a.bot_auto_answer),
      priority               = coalesce((p_data->>'priority')::int, a.priority),
      confidence             = coalesce((p_data->>'confidence')::numeric, a.confidence),
      valid_from             = coalesce((p_data->>'valid_from')::timestamptz, a.valid_from),
      valid_to               = coalesce((p_data->>'valid_to')::timestamptz, a.valid_to),
      -- แก้ของ approved = กลับเข้ารอบตรวจ · ล้างผู้อนุมัติเดิมทิ้ง
      status                 = case when a.status = 'approved' then 'review' else a.status end,
      approved_by            = case when a.status = 'approved' then null else a.approved_by end,
      approved_at            = case when a.status = 'approved' then null else a.approved_at end
    where id = v_id
    returning * into a;
  end if;

  return to_jsonb(a);
end $$;

-- ── ah_approve ──────────────────────────────────────────────────────
-- อนุมัติเฉพาะ admin — สอง role ล่างและแม้แต่ manager ก็อนุมัติไม่ได้ (Master Command ข้อ 18)
create or replace function inbox.ah_approve(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a answer_hub.answer_item;
begin
  if coalesce(core.current_user_role(), '') <> 'admin' then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  update answer_hub.answer_item set
    status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = (p_data->>'id')::uuid
    and status in ('draft', 'review')
  returning * into a;

  if not found then
    perform answer_hub._fail('ah_state_not_allowed');
  end if;
  return to_jsonb(a);
end $$;

-- ── ah_retire ───────────────────────────────────────────────────────
-- ปลดใช้ — ยังอยู่ในประวัติ ไม่มีการลบแถวเด็ดขาด (audit trail)
create or replace function inbox.ah_retire(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a answer_hub.answer_item;
begin
  if coalesce(core.current_user_role(), '') <> 'admin' then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  update answer_hub.answer_item set
    status = 'retired', approved_by = null, approved_at = null
  where id = (p_data->>'id')::uuid
    and status <> 'retired'
  returning * into a;

  if not found then
    perform answer_hub._fail('ah_state_not_allowed');
  end if;
  return to_jsonb(a);
end $$;

-- ── สิทธิ์เรียก: คน login ทุกคนเรียกได้ — ตัวกรองจริงอยู่ในฟังก์ชัน ──
grant execute on function inbox.ah_list(jsonb)   to authenticated;
grant execute on function inbox.ah_get(jsonb)    to authenticated;
grant execute on function inbox.ah_save(jsonb)   to authenticated;
grant execute on function inbox.ah_approve(jsonb) to authenticated;
grant execute on function inbox.ah_retire(jsonb)  to authenticated;
revoke all on function inbox.ah_list(jsonb)    from public, anon;
revoke all on function inbox.ah_get(jsonb)     from public, anon;
revoke all on function inbox.ah_save(jsonb)    from public, anon;
revoke all on function inbox.ah_approve(jsonb) from public, anon;
revoke all on function inbox.ah_retire(jsonb)  from public, anon;

notify pgrst, 'reload schema';
