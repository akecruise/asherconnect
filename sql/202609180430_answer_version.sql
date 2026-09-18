-- =====================================================================
-- answer-hub version control (Phase 3) — ประวัติของคำตอบที่เคยอนุมัติแล้ว
-- =====================================================================
-- กฎ: "แก้ของที่ approved ทีหลัง = ต้องมีของเก่าให้ดูย้อนหลังได้เสมอ"
--   * แก้ (ah_save) ของที่ status='approved' → เก็บ snapshot ของเดิมเป็น version ก่อนแก้
--   * ปลดใช้ (ah_retire) ของที่ approved → เก็บ snapshot เดียวกัน
--   * ของที่เป็น draft/review แก้กี่ครั้งก็ไม่เป็น version — ยังไม่เคยผ่านการอนุมัติ
--     ไม่มีอะไร "หาย" ที่ต้องเก็บ
--
-- ไฟล์นี้ create or replace ทับ ah_save/ah_retire ของ Phase 2 — เป็นของ answer-hub เอง
-- (ของที่ห้ามทับคือ connect_private.api/worker — ฟังก์ชัน ah_* เกิดมาเพื่อถูกไฟล์ถัดไป
--  ยกรุ่นได้ อ่านแนวทางใน sql/ORDER.txt หัวไฟล์ 032)
--
-- ตัวตรวจ: sql/_selftest/ah_answer_version_selftest.sql (T05 version history)
-- =====================================================================

-- ── ตาราง answer_version ────────────────────────────────────────────
create table if not exists answer_hub.answer_version (
  id              uuid primary key default gen_random_uuid(),
  answer_item_id  uuid not null references answer_hub.answer_item(id) on delete cascade,
  version_no      integer not null,
  title           text,
  body_template   text,
  snapshot        jsonb not null,        -- ทั้งแถวเดิม ณ ตอนนั้น (รวมสถานะ/ผู้อนุมัติ)
  changed_by      uuid,                  -- คนที่ทำให้เปลี่ยน (คนแก้/คนปลดใช้) ไม่ใช่ผู้อนุมัติเดิม
  change_reason   text,
  created_at      timestamptz not null default now(),
  unique (answer_item_id, version_no)
);

create index if not exists answer_version_item_idx on answer_hub.answer_version (answer_item_id, version_no desc);

alter table answer_hub.answer_version enable row level security;
revoke all on answer_hub.answer_version from public, anon, authenticated;

-- ── ตัวช่วย snapshot กลาง ───────────────────────────────────────────
-- ใส่ version ถัดไปของ item ให้เอง (max+1) — เรียกจาก ah_save/ah_retire ก่อนแก้แถวเดิม
create or replace function answer_hub._snapshot_version(
  p_item      answer_hub.answer_item,
  p_changed_by uuid,
  p_reason    text default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_no integer;
begin
  select coalesce(max(version_no), 0) + 1 into v_no
  from answer_hub.answer_version
  where answer_item_id = p_item.id;

  insert into answer_hub.answer_version
    (answer_item_id, version_no, title, body_template, snapshot, changed_by, change_reason)
  values
    (p_item.id, v_no, p_item.title, p_item.body_template,
     to_jsonb(p_item), p_changed_by, left(p_reason, 500));

  return v_no;
end $$;

-- ── ah_save รุ่นมี version ──────────────────────────────────────────
create or replace function inbox.ah_save(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role   text := coalesce(core.current_user_role(), '');
  v_id     uuid := (p_data->>'id')::uuid;
  v_reason text := nullif(trim(p_data->>'change_reason'), '');
  a        answer_hub.answer_item;
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

    -- ★ แก้ของที่ approved = เก็บรุ่นเก่าไว้ก่อน (จุดเกิดของ version ทุกตัว)
    if a.status = 'approved' then
      perform answer_hub._snapshot_version(a, auth.uid(), v_reason);
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

-- ── ah_retire รุ่นมี version ────────────────────────────────────────
create or replace function inbox.ah_retire(p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a answer_hub.answer_item;
begin
  if coalesce(core.current_user_role(), '') <> 'admin' then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  select * into a from answer_hub.answer_item
  where id = (p_data->>'id')::uuid for update;
  if not found or a.status = 'retired' then
    perform answer_hub._fail('ah_state_not_allowed');
  end if;

  -- ปลดใช้ของที่ approved = รุ่นที่เคยอนุมัติต้องยังอยู่ให้ดูย้อนหลัง
  if a.status = 'approved' then
    perform answer_hub._snapshot_version(a, auth.uid(), nullif(trim(p_data->>'reason'), ''));
  end if;

  update answer_hub.answer_item set
    status = 'retired', approved_by = null, approved_at = null
  where id = a.id
  returning * into a;

  return to_jsonb(a);
end $$;

-- ── ah_versions ─────────────────────────────────────────────────────
-- ประวัติของ item เดียว — manager ขึ้นไป (ประวัติมีข้อความที่เคยอนุมัติทั้งหมด)
create or replace function inbox.ah_versions(p_data jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := coalesce(core.current_user_role(), '');
  v_rows jsonb;
begin
  if v_role not in ('manager', 'admin') then
    perform answer_hub._fail('ah_not_allowed');
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'version_no', v.version_no, 'title', v.title, 'body_template', v.body_template,
      'changed_by', v.changed_by, 'change_reason', v.change_reason,
      'created_at', v.created_at, 'snapshot', v.snapshot
    ) order by v.version_no desc), '[]'::jsonb)
  into v_rows
  from answer_hub.answer_version v
  where v.answer_item_id = (p_data->>'id')::uuid;

  return jsonb_build_object('rows', v_rows);
end $$;

-- ── สิทธิ์เรียก ─────────────────────────────────────────────────────
grant execute on function inbox.ah_versions(jsonb) to authenticated;
revoke all on function inbox.ah_versions(jsonb) from public, anon;

notify pgrst, 'reload schema';
