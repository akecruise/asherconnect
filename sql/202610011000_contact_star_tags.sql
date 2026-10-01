-- =====================================================================
-- 202610011000_contact_star_tags.sql — ติดดาว · การติดตาม · Tag แบบ LINE OA
-- =====================================================================
-- spec: docs/handoff/2026-10-01-star-follow-tags.md
--
-- ★ ไม่แตะ connect_private.api เด็ดขาด — ตัวบน VPS ใหม่กว่า repo (handoff Meta review 20 ก.ย.)
--   ใช้ฟังก์ชันแยกใน schema inbox เรียกผ่าน rpcDirect(accessToken, ...) แบบ queue_counts
--   ด่านสิทธิ์อยู่ที่ connect_private.can_read() ตัวเดียวกับกิ่ง list
--
-- ★ ดาว / tag / โน้ตติดตาม ผูกกับ core.contact ไม่ใช่ conversation
--   ทีมตอบแบบคิวรวม จึงเป็นของทีม และลูกค้าคนเดียวที่ทักหลายช่องทาง (unified identity)
--   เห็นดาว/tag ชุดเดียวกัน · วันติดตามยังอยู่ที่ connect_private.case_state.follow_up_at เดิม
--   (ตัวกรอง followup ของกิ่ง list และ inbox.queue_counts อ่านคอลัมน์นั้นอยู่แล้ว)
--
-- ★ LINE Messaging API / Meta ไม่มี API ของ chat tag — tag อยู่ในระบบนี้ที่เดียว ไม่ sync ออก
--
-- ★ วิธีรันด้วยมือ (deploy script ไม่รัน migration):
--   local : node sql/run.mjs apply --db "$DB"
--   VPS   : backup ก่อน (docs/handoff/2026-10-01-star-follow-tags.md หัวข้อ Deploy) แล้ว
--           docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--             < sql/202610011000_contact_star_tags.sql
--   ★★ ก่อนรันบน VPS เทียบคอลัมน์ select ของ inbox.flag_list กับ
--      pg_get_functiondef('connect_private.api(text,jsonb)'::regprocedure) ตัวบน VPS
--      (กิ่ง list) — ไฟล์นี้คัดมาจาก 202609221400_manual_name_guard.sql ใน repo
-- ★ รันซ้ำได้ (if not exists / create or replace / seed แบบ not exists)

begin;

-- ── ตาราง ────────────────────────────────────────────────────────────
-- ดาว + โน้ตติดตาม (1 แถวต่อ contact)
create table if not exists connect_private.contact_flag (
  contact_id  uuid primary key references core.contact(id) on delete cascade,
  starred     boolean not null default false,
  starred_by  uuid,
  starred_at  timestamptz,
  follow_note text check (char_length(follow_note) <= 500),
  updated_at  timestamptz not null default now()
);

-- นิยาม tag ที่ทีมสร้างเอง (แบบ LINE OA)
-- ★ palette ตายตัว ไม่มีแดง — แดงแบรนด์ #8E1116 สงวนไว้ให้ SLA/error เท่านั้น
create table if not exists connect_private.tag (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 30),
  color      text not null default 'grey'
             check (color in ('grey','blue','green','amber','purple','pink','teal')),
  sort_order int not null default 0,
  is_active  boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists tag_name_uq on connect_private.tag (lower(btrim(name))) where is_active;

-- contact ↔ tag
create table if not exists connect_private.contact_tag (
  contact_id uuid not null references core.contact(id) on delete cascade,
  tag_id     uuid not null references connect_private.tag(id) on delete cascade,
  tagged_by  uuid,
  tagged_at  timestamptz not null default now(),
  primary key (contact_id, tag_id)
);
create index if not exists contact_tag_tag_idx on connect_private.contact_tag(tag_id);
create index if not exists contact_flag_starred_idx on connect_private.contact_flag(contact_id) where starred;

-- เข้าถึงผ่าน security definer functions ข้างล่างเท่านั้น (แบบเดียวกับ database.sql)
alter table connect_private.contact_flag enable row level security;
alter table connect_private.tag enable row level security;
alter table connect_private.contact_tag enable row level security;
revoke all on connect_private.contact_flag, connect_private.tag, connect_private.contact_tag
  from public, anon, authenticated;

-- tag เริ่มต้น — ผู้ใช้ปรับ/เลิกใช้ได้ภายหลังจากหน้าจัดการ Tag
insert into connect_private.tag(name, color, sort_order)
select v.name, v.color, v.sort_order
  from (values ('Hot','amber',10), ('สนใจ 1BR','blue',20), ('สนใจ 2BR','teal',30),
               ('นักลงทุน','green',40), ('ต่างชาติ','purple',50), ('นัดชมแล้ว','pink',60),
               ('รอกู้/รอเอกสาร','grey',70)) v(name, color, sort_order)
 where not exists (select 1 from connect_private.tag t
                    where t.is_active and lower(btrim(t.name)) = lower(btrim(v.name)));

-- ── ตัวช่วย ──────────────────────────────────────────────────────────
-- คนที่เรียก: role ที่ใช้ Connect ได้ + ธง test_only (ผู้ตรวจสอบ Meta)
-- คืน null ถ้าไม่ใช่พนักงานที่ active — ฟังก์ชันที่เรียกต้องตัดทิ้งเอง
create or replace function inbox.flag_actor()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.user_id, 'role', p.role, 'test_only', coalesce(p.test_only, false))
    from core.profile p
   where p.user_id = auth.uid() and p.is_active
     and p.role in ('sales','senior_sales','manager','admin')
$$;

-- เคส → contact หลังผ่าน can_read แล้วเท่านั้น
-- ★ can_read มี "(not test_only or is_test)" อยู่แล้ว ผู้ตรวจสอบจึงแตะได้เฉพาะแชททดสอบ
create or replace function inbox.flag_contact_of(p_conversation_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_contact uuid;
begin
  if p_conversation_id is null or not coalesce(connect_private.can_read(p_conversation_id), false) then
    raise exception 'conversation_not_found' using errcode = '42501';
  end if;
  select c.contact_id into v_contact from inbox.conversation c where c.id = p_conversation_id;
  if v_contact is null then raise exception 'conversation_not_found' using errcode = '42501'; end if;
  return v_contact;
end $$;

create or replace function inbox.flag_tags_of(p_contact_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)
                            order by t.sort_order, t.name), '[]'::jsonb)
    from connect_private.contact_tag x
    join connect_private.tag t on t.id = x.tag_id and t.is_active
   where x.contact_id = p_contact_id
$$;

-- ── case_star: ติด/ถอดดาวที่ contact ของเคส ─────────────────────────
-- p = {conversation_id, starred}
create or replace function inbox.case_star(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_conv uuid; v_contact uuid; v_on boolean;
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  v_conv := nullif(p->>'conversation_id', '')::uuid;
  v_contact := inbox.flag_contact_of(v_conv);
  if jsonb_typeof(p->'starred') is distinct from 'boolean' then raise exception 'invalid_request'; end if;
  v_on := (p->>'starred')::boolean;

  insert into connect_private.contact_flag(contact_id, starred, starred_by, starred_at)
  values (v_contact, v_on, case when v_on then auth.uid() end, case when v_on then now() end)
  on conflict (contact_id) do update
     set starred = excluded.starred, starred_by = excluded.starred_by,
         starred_at = excluded.starred_at, updated_at = now();

  insert into connect_private.audit(actor_id, conversation_id, action, detail)
  values (auth.uid(), v_conv, case when v_on then 'star' else 'unstar' end,
          jsonb_build_object('contact_id', v_contact));
  return jsonb_build_object('ok', true, 'contact_id', v_contact, 'starred', v_on);
end $$;

-- ── case_follow: ตั้ง/ล้างวันติดตาม + โน้ต ────────────────────────────
-- p = {conversation_id, follow_up_at (ISO | null | ''), note, version}
-- ★ เขียน case_state.follow_up_at ที่เดียวกับ action save เดิม และปิด/สร้าง crm.activity
--   task source connect_followup แบบเดียวกัน — CRM จะไม่แตกเป็นสองทาง
-- ★ ใช้ case_state.version กันเขียนชนกับฟอร์ม lead card (save ก็เช็ค version ตัวเดียวกัน)
--   และคืน version ใหม่ให้หน้าจอเก็บไว้ ไม่งั้นกด "บันทึกข้อมูล" ต่อจะชน version_conflict
-- ★ ไม่ต้องรับเคสก่อน (ต่างจาก save) — ตาม spec: ทุก role ที่ can_read
create or replace function inbox.case_follow(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_conv uuid; v_contact uuid; c inbox.conversation;
        s connect_private.case_state; v_at timestamptz; v_note text;
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  v_conv := nullif(p->>'conversation_id', '')::uuid;
  v_contact := inbox.flag_contact_of(v_conv);
  select * into strict c from inbox.conversation where id = v_conv for update;
  if c.status = 'resolved' then raise exception 'case_closed'; end if;

  v_at := nullif(p->>'follow_up_at', '')::timestamptz;
  v_note := nullif(btrim(coalesce(p->>'note', '')), '');
  if char_length(v_note) > 500 then raise exception 'invalid_note'; end if;

  insert into connect_private.case_state(conversation_id) values (v_conv) on conflict (conversation_id) do nothing;
  select * into strict s from connect_private.case_state where conversation_id = v_conv for update;
  if p ? 'version' and coalesce(nullif(p->>'version', '')::int, -1) <> s.version then
    raise exception 'version_conflict';
  end if;

  update connect_private.case_state
     set follow_up_at = v_at, version = version + 1
   where conversation_id = v_conv
  returning * into s;

  -- งาน CRM เปลี่ยนเฉพาะตอนวันเปลี่ยน — แก้แค่โน้ตไม่ต้องปิด/เปิด task ใหม่
  update crm.activity set done_at = now()
   where conversation_id = v_conv and type = 'task' and done_at is null
     and extra->>'source' = 'connect_followup'
     and due_at is distinct from v_at;
  if v_at is not null and s.lead_id is not null and not exists (
       select 1 from crm.activity a
        where a.conversation_id = v_conv and a.type = 'task' and a.done_at is null
          and a.extra->>'source' = 'connect_followup' and a.due_at = v_at) then
    insert into crm.activity(lead_id, type, due_at, owner_id, conversation_id, body, extra)
    values (s.lead_id, 'task', v_at, c.assignee_id, v_conv, 'ติดตามลูกค้า', '{"source":"connect_followup"}');
  end if;

  insert into connect_private.contact_flag(contact_id, follow_note) values (v_contact, v_note)
  on conflict (contact_id) do update set follow_note = excluded.follow_note, updated_at = now();

  insert into connect_private.audit(actor_id, conversation_id, action, detail)
  values (auth.uid(), v_conv, 'follow',
          jsonb_build_object('contact_id', v_contact, 'follow_up_at', v_at, 'note', v_note));
  return jsonb_build_object('ok', true, 'follow_up_at', s.follow_up_at, 'follow_note', v_note,
                            'version', s.version);
end $$;

-- ── case_tags_set: ติด/ถอด tag ────────────────────────────────────────
-- p = {conversation_id, add:[tag_id], remove:[tag_id]}
create or replace function inbox.case_tags_set(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_conv uuid; v_contact uuid;
        v_add uuid[]; v_remove uuid[]; v_added uuid[]; v_removed uuid[];
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  v_conv := nullif(p->>'conversation_id', '')::uuid;
  v_contact := inbox.flag_contact_of(v_conv);
  select coalesce(array_agg(x::uuid), '{}') into v_add
    from jsonb_array_elements_text(case when jsonb_typeof(p->'add') = 'array' then p->'add' else '[]' end) x;
  select coalesce(array_agg(x::uuid), '{}') into v_remove
    from jsonb_array_elements_text(case when jsonb_typeof(p->'remove') = 'array' then p->'remove' else '[]' end) x;
  if cardinality(v_add) + cardinality(v_remove) > 50 then raise exception 'too_many_tags'; end if;

  with gone as (
    delete from connect_private.contact_tag
     where contact_id = v_contact and tag_id = any(v_remove)
    returning tag_id)
  select coalesce(array_agg(tag_id), '{}') into v_removed from gone;

  -- ติดได้เฉพาะ tag ที่ยังใช้อยู่ — tag ที่เลิกใช้แล้วถูกเงียบ ๆ ข้าม
  with added as (
    insert into connect_private.contact_tag(contact_id, tag_id, tagged_by)
    select v_contact, t.id, auth.uid()
      from connect_private.tag t
     where t.id = any(v_add) and t.is_active and not (t.id = any(v_remove))
    on conflict do nothing
    returning tag_id)
  select coalesce(array_agg(tag_id), '{}') into v_added from added;

  if cardinality(v_added) > 0 then
    insert into connect_private.audit(actor_id, conversation_id, action, detail)
    values (auth.uid(), v_conv, 'tag_add', jsonb_build_object('contact_id', v_contact, 'tags', to_jsonb(v_added)));
  end if;
  if cardinality(v_removed) > 0 then
    insert into connect_private.audit(actor_id, conversation_id, action, detail)
    values (auth.uid(), v_conv, 'tag_remove', jsonb_build_object('contact_id', v_contact, 'tags', to_jsonb(v_removed)));
  end if;
  return jsonb_build_object('ok', true, 'contact_id', v_contact, 'tags', inbox.flag_tags_of(v_contact));
end $$;

-- ── tags_list: tag ที่ใช้อยู่ + จำนวนเคสที่มองเห็นได้ ───────────────────
-- คืน {tags:[{id,name,color,sort_order,count}], starred:n, can_manage}
-- ★ นับเฉพาะเคสที่ยังไม่ปิดและ can_read — ผู้ตรวจสอบเห็นเฉพาะตัวเลขของแชททดสอบ
create or replace function inbox.tags_list(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_result jsonb;
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  with seen as (
    select c.contact_id from inbox.conversation c
     where c.status <> 'resolved' and connect_private.can_read(c.id)
  )
  select jsonb_build_object(
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color,
                                          'sort_order', t.sort_order,
                                          'count', (select count(*) from seen
                                                     join connect_private.contact_tag x
                                                       on x.contact_id = seen.contact_id and x.tag_id = t.id))
                       order by t.sort_order, t.name)
        from connect_private.tag t where t.is_active), '[]'::jsonb),
    'starred', (select count(*) from seen
                  join connect_private.contact_flag f on f.contact_id = seen.contact_id and f.starred),
    'can_manage', not (v_actor->>'test_only')::boolean and v_actor->>'role' in ('manager','admin'),
    'can_create', not (v_actor->>'test_only')::boolean)
  into v_result;
  return v_result;
end $$;

-- ── tag_upsert: สร้าง (sales ขึ้นไป แบบ LINE) / แก้ชื่อ-สี-ลำดับ (manager/admin) ──
-- p = {id?, name, color?, sort_order?}
-- ★ สร้างชื่อที่มีอยู่แล้ว = คืน tag เดิม (กด "สร้าง tag ใหม่" ซ้ำไม่ทำให้มีสองอัน)
create or replace function inbox.tag_upsert(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_id uuid; v_name text; v_color text; v_sort int;
        v_row connect_private.tag;
begin
  if v_actor is null or (v_actor->>'test_only')::boolean then raise exception 'not_allowed' using errcode = '42501'; end if;
  v_id := nullif(p->>'id', '')::uuid;
  v_name := btrim(coalesce(p->>'name', ''));
  v_color := nullif(p->>'color', '');
  v_sort := nullif(p->>'sort_order', '')::int;
  if v_name = '' and v_id is null then raise exception 'invalid_tag_name'; end if;
  if char_length(v_name) > 30 then raise exception 'invalid_tag_name'; end if;
  if v_color is not null and v_color not in ('grey','blue','green','amber','purple','pink','teal') then
    raise exception 'invalid_tag_color';
  end if;

  if v_id is null then
    select * into v_row from connect_private.tag t where t.is_active and lower(btrim(t.name)) = lower(v_name);
    if found then return to_jsonb(v_row) || jsonb_build_object('created', false); end if;
    insert into connect_private.tag(name, color, sort_order, created_by)
    values (v_name, coalesce(v_color, 'grey'),
            coalesce(v_sort, (select coalesce(max(sort_order), 0) + 10 from connect_private.tag where is_active)),
            auth.uid())
    returning * into v_row;
  else
    if v_actor->>'role' not in ('manager','admin') then raise exception 'not_allowed' using errcode = '42501'; end if;
    if v_name <> '' and exists (select 1 from connect_private.tag t
                                 where t.is_active and t.id <> v_id and lower(btrim(t.name)) = lower(v_name)) then
      raise exception 'tag_exists';
    end if;
    update connect_private.tag set name = coalesce(nullif(v_name, ''), name),
                                   color = coalesce(v_color, color),
                                   sort_order = coalesce(v_sort, sort_order)
     where id = v_id and is_active
    returning * into v_row;
    if not found then raise exception 'tag_not_found'; end if;
  end if;

  insert into connect_private.audit(actor_id, action, detail)
  values (auth.uid(), 'tag_admin', jsonb_build_object('op', case when v_id is null then 'create' else 'update' end,
                                                       'tag', to_jsonb(v_row)));
  return to_jsonb(v_row) || jsonb_build_object('created', v_id is null);
end $$;

-- ── tag_archive: เลิกใช้ (soft) — manager/admin ───────────────────────
-- ★ ไม่ลบแถว contact_tag — ถ้าวันหลังอยากกู้ก็ยังมีประวัติ ทุกที่อ่านผ่าน t.is_active อยู่แล้ว
create or replace function inbox.tag_archive(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_row connect_private.tag;
begin
  if v_actor is null or (v_actor->>'test_only')::boolean or v_actor->>'role' not in ('manager','admin') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update connect_private.tag set is_active = false
   where id = nullif(p->>'id', '')::uuid and is_active
  returning * into v_row;
  if not found then raise exception 'tag_not_found'; end if;
  insert into connect_private.audit(actor_id, action, detail)
  values (auth.uid(), 'tag_admin', jsonb_build_object('op', 'archive', 'tag', to_jsonb(v_row)));
  return jsonb_build_object('ok', true, 'id', v_row.id);
end $$;

-- ── case_flags: ตกแต่งการ์ดในหน้าที่โหลดอยู่ ──────────────────────────
-- p = {conversation_ids:[...]} (≤ 100) → {conversation_id: {starred, tags, follow_up_at, follow_note}}
-- เคสที่ can_read ไม่ผ่านถูกตัดทิ้งเงียบ ๆ (ไม่ throw ทั้งหน้าเพราะเคสเดียว)
create or replace function inbox.case_flags(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_ids uuid[]; v_result jsonb;
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  select coalesce(array_agg(x::uuid), '{}') into v_ids
    from jsonb_array_elements_text(case when jsonb_typeof(p->'conversation_ids') = 'array'
                                        then p->'conversation_ids' else '[]' end) x;
  if cardinality(v_ids) > 100 then raise exception 'too_many_ids'; end if;
  select coalesce(jsonb_object_agg(c.id, jsonb_build_object(
           'starred', coalesce(f.starred, false),
           'tags', inbox.flag_tags_of(c.contact_id),
           'follow_up_at', s.follow_up_at,
           'follow_note', f.follow_note)), '{}'::jsonb)
    into v_result
    from inbox.conversation c
    left join connect_private.contact_flag f on f.contact_id = c.contact_id
    left join connect_private.case_state s on s.conversation_id = c.id
   where c.id = any(v_ids) and connect_private.can_read(c.id);
  return v_result;
end $$;

-- ── flag_list: รายการเคสของตัวกรองใหม่ ────────────────────────────────
-- p = {filter:'starred'|'tag', tag_id, search, offset}
-- ★ แถวรูปเดียวกับกิ่ง list ของ connect_private.api (คอลัมน์คัดมาตรงตัว) หน้าจอจึงวาดการ์ดได้เหมือนกัน
--   วันที่แก้คอลัมน์ในกิ่ง list ต้องมาแก้ที่นี่ด้วย — เหมือนกติกาของ inbox.queue_counts
-- ★ ไม่ใช่ stable เพราะลง audit 'list' แบบเดียวกับกิ่ง list
-- ★ ดาว/tag เป็นของลูกค้า ไม่ใช่ของคิว จึงรวมเคสที่ปิดแล้วด้วย (ลูกค้า potential ที่เคสเก่าปิดไปแล้ว
--   ยังต้องหาเจอ) — เรียงตามข้อความล่าสุดเหมือน list
create or replace function inbox.flag_list(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := inbox.flag_actor(); v_filter text := coalesce(p->>'filter', '');
        v_tag uuid := nullif(p->>'tag_id', '')::uuid; v_search text := coalesce(p->>'search', '');
        v_offset int := greatest(0, least(coalesce(nullif(p->>'offset', '')::int, 0), 100000));
        v_test_only boolean; v_result jsonb;
begin
  if v_actor is null then raise exception 'not_allowed' using errcode = '42501'; end if;
  if v_filter not in ('starred', 'tag') or (v_filter = 'tag' and v_tag is null) then
    raise exception 'invalid_filter';
  end if;
  v_test_only := (v_actor->>'test_only')::boolean;
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_result from (
    select c.id, ct.display_name, ct.phone, c.status, c.assignee_id, u.email as assignee, c.last_message_at,
           c.last_message_preview, c.unread_count, i.channel, coalesce(l.project_id, i.project_id) as project_id,
           s.waiting_since, s.follow_up_at, s.appointment_at, st.label as stage_label, cs.case_status,
           cs.waiting_minutes, cs.sla_minutes, cid.external_id, ct.picture_url
      from inbox.conversation c
      join inbox.inbox i on i.id = c.inbox_id
      join core.contact ct on ct.id = c.contact_id
      left join core.contact_identity cid on cid.contact_id = c.contact_id and cid.channel = i.channel
                                         and cid.account_key = c.inbox_id::text
      left join connect_private.case_state s on s.conversation_id = c.id
      join inbox.case_status cs on cs.conversation_id = c.id
      left join crm.lead l on l.id = s.lead_id
      left join crm.stage st on st.id = l.stage_id
      left join core."user" u on u.id = c.assignee_id
     where connect_private.can_read(c.id)
       and (not v_test_only or c.is_test)
       and (v_search = '' or position(lower(v_search) in
              lower(coalesce(ct.display_name, '') || ' ' || coalesce(ct.phone, ''))) > 0)
       and case v_filter
             when 'starred' then exists (select 1 from connect_private.contact_flag f
                                          where f.contact_id = c.contact_id and f.starred)
             when 'tag' then exists (select 1 from connect_private.contact_tag x
                                       join connect_private.tag t on t.id = x.tag_id and t.is_active
                                      where x.contact_id = c.contact_id and x.tag_id = v_tag)
             else false end
     order by c.last_message_at desc nulls last, c.id
     limit 51 offset v_offset) q;
  insert into connect_private.audit(actor_id, action, detail)
  values (auth.uid(), 'list', jsonb_build_object('filter', v_filter, 'tag_id', v_tag, 'offset', v_offset));
  return v_result;
end $$;

-- ── สิทธิ์ ───────────────────────────────────────────────────────────
-- หน้าเว็บเรียกด้วย token ของคนที่ล็อกอิน (rpcDirect) — auth.uid() จึงเป็นคนจริงและ can_read ยังบังคับ
revoke all on function inbox.flag_actor(), inbox.flag_contact_of(uuid), inbox.flag_tags_of(uuid),
  inbox.case_star(jsonb), inbox.case_follow(jsonb), inbox.case_tags_set(jsonb), inbox.tags_list(jsonb),
  inbox.tag_upsert(jsonb), inbox.tag_archive(jsonb), inbox.case_flags(jsonb), inbox.flag_list(jsonb)
  from public, anon;
-- ตัวช่วยไม่เปิดให้เรียกจากหน้าเว็บ — ใช้ภายในฟังก์ชันข้างบนเท่านั้น
revoke all on function inbox.flag_actor(), inbox.flag_contact_of(uuid), inbox.flag_tags_of(uuid)
  from authenticated;
grant execute on function inbox.case_star(jsonb), inbox.case_follow(jsonb), inbox.case_tags_set(jsonb),
  inbox.tags_list(jsonb), inbox.tag_upsert(jsonb), inbox.tag_archive(jsonb), inbox.case_flags(jsonb),
  inbox.flag_list(jsonb) to authenticated, service_role;

commit;
