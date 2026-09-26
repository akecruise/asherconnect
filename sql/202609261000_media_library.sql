-- =====================================================================
-- 202609261000_media_library.sql — คลังรูป (Image Library) ของ Sales Workspace
-- =====================================================================
-- ต่อยอดตาราง inbox.media_asset เดิม (สร้างโดย asher-web 20260916154809_quick_reply)
-- แบบ "เพิ่มเท่านั้น" — ไม่แตะ connect_private.api, ไม่แตะ qr_* เดิม
--
-- ★ วิธีรันด้วยมือ (migration ไม่ถูกรันตอน deploy):
--   local : node sql/run.mjs            (หรือ psql -f ไฟล์นี้)
--   VPS   : docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--             < sql/202609261000_media_library.sql
--   ก่อนรันบน VPS ให้ backup ตามที่เขียนใน docs/quick-reply/DEPLOY.md
-- ★ รันซ้ำได้ (if not exists / create or replace ทั้งไฟล์)
--
-- ที่มาของทางเลือก (docs/quick-reply/PLAN.md D1/D4):
--   - หมวดรูปเป็นชุดปิดของคลังเอง ไม่ใช้ category ของ quick_reply (คนละความหมาย)
--   - sales อัปโหลดได้ แต่รูปเข้าสถานะ pending จน marketing/manager/admin อนุมัติ
--   - use_count/last_used_at เก็บที่แถวรูป (อ่านเร็ว) ส่วนรายการส่งจริงอยู่ที่ media_asset_send
--     ซึ่งใช้ทำป้าย "ส่งแล้ว" ต่อบทสนทนา
--   - reviewer (core.profile.test_only) เห็นคลังได้แต่แก้/อัปโหลดไม่ได้

begin;

-- ── คอลัมน์ใหม่ของรูป ───────────────────────────────────────────────
alter table inbox.media_asset
  add column if not exists category text,
  add column if not exists bot_enabled boolean not null default false,
  add column if not exists expires_at timestamptz,
  add column if not exists status text not null default 'approved',
  add column if not exists use_count integer not null default 0,
  add column if not exists last_used_at timestamptz,
  add column if not exists preview_path text,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid,
  add column if not exists updated_by uuid;

-- รูปเดิม (ชุด Naii 25 ก.ย.) ได้หมวดจาก quick_reply ที่ผูกอยู่
update inbox.media_asset a
   set category = case q.category
                    when 'floorplan' then 'plan'
                    when 'rooms_price' then 'room'
                    when 'facilities' then 'facility'
                    when 'location' then 'location'
                    when 'promo' then 'promo'
                    else 'other' end
  from inbox.quick_reply_attachment x
  join inbox.quick_reply q on q.id = x.quick_reply_id
 where x.media_asset_id = a.id and a.category is null;
update inbox.media_asset set category = 'other' where category is null;

alter table inbox.media_asset alter column category set default 'other';
alter table inbox.media_asset alter column category set not null;

alter table inbox.media_asset drop constraint if exists media_asset_category_check;
alter table inbox.media_asset add constraint media_asset_category_check
  check (category in ('room','plan','facility','location','promo','other'));
alter table inbox.media_asset drop constraint if exists media_asset_status_check;
alter table inbox.media_asset add constraint media_asset_status_check
  check (status in ('pending','approved'));
alter table inbox.media_asset drop constraint if exists media_asset_use_count_check;
alter table inbox.media_asset add constraint media_asset_use_count_check check (use_count >= 0);

create index if not exists media_asset_library_idx
  on inbox.media_asset(project, category) where active and archived_at is null;

-- ── รายการส่งรูปให้ลูกค้า ───────────────────────────────────────────
create table if not exists inbox.media_asset_send (
  id bigint generated always as identity primary key,
  media_asset_id uuid not null references inbox.media_asset(id),
  conversation_id uuid not null references inbox.conversation(id),
  message_id uuid references inbox.message(id),
  sent_by uuid,
  sent_at timestamptz not null default now()
);
create index if not exists media_asset_send_conversation_idx
  on inbox.media_asset_send(conversation_id, media_asset_id);

alter table inbox.media_asset_send enable row level security;
revoke all on inbox.media_asset_send from anon, authenticated;

-- ── ตัวช่วยสิทธิ์ ────────────────────────────────────────────────────
create or replace function inbox.media_library_role()
returns text language sql stable security definer set search_path = inbox, core, public as $$
  select case
    when current_setting('role', true) in ('service_role','postgres') then 'service'
    when coalesce((select p.test_only from core.profile p where p.user_id = auth.uid()), false) then 'reviewer'
    when core.current_user_role() in ('marketing','manager','admin') then 'editor'
    when core.current_user_role() in ('sales','senior_sales') then 'sales'
    else 'none' end
$$;

create or replace function inbox.media_asset_json(a inbox.media_asset, p_sent boolean default false)
returns jsonb language sql stable set search_path = inbox, public as $$
  select jsonb_build_object(
    'id', a.id, 'project', a.project, 'category', a.category, 'title', a.title,
    'storage_path', a.storage_path, 'preview_path', a.preview_path,
    'mime', a.mime, 'width', a.width, 'height', a.height, 'bytes', a.bytes,
    'bot_enabled', a.bot_enabled, 'expires_at', a.expires_at, 'status', a.status,
    'use_count', a.use_count, 'last_used_at', a.last_used_at, 'created_at', a.created_at,
    'sent_to_conversation', p_sent)
$$;

-- ── media_list: คลังสำหรับ popover และหน้าจัดการ ────────────────────
-- p_scope: 'library' (ค่าเริ่มต้น — เฉพาะ approved, ไม่หมดอายุ) | 'manage' (editor เห็นทั้ง pending/หมดอายุ)
create or replace function inbox.media_list(
  p_project text default null, p_category text default null, p_query text default null,
  p_sort text default 'freq', p_conversation_id uuid default null, p_scope text default 'library')
returns jsonb language plpgsql stable security definer set search_path = inbox, core, public as $$
declare v_role text := inbox.media_library_role(); v_manage boolean; v_result jsonb;
begin
  if v_role = 'none' then raise exception 'not_allowed'; end if;
  v_manage := p_scope = 'manage' and v_role in ('editor','service');
  select coalesce(jsonb_agg(inbox.media_asset_json(a,
           p_conversation_id is not null and exists (
             select 1 from inbox.media_asset_send s
              where s.media_asset_id = a.id and s.conversation_id = p_conversation_id))
         order by
           case when p_sort = 'recent' then coalesce(a.last_used_at, a.created_at) end desc nulls last,
           case when p_sort = 'freq' then a.use_count end desc nulls last,
           a.created_at desc), '[]'::jsonb)
    into v_result
    from inbox.media_asset a
   where a.active and a.archived_at is null
     and (v_manage or (a.status = 'approved' and (a.expires_at is null or a.expires_at > now())))
     and (p_project is null or p_project = '' or a.project in (lower(p_project), 'all'))
     and (p_category is null or p_category = '' or a.category = p_category)
     and (p_query is null or p_query = '' or lower(a.title) like '%' || lower(p_query) || '%');
  return v_result;
end $$;

-- ── media_get: ให้ server ตรวจรูปก่อนส่ง/ก่อนเสิร์ฟไฟล์ ─────────────
-- คืนเฉพาะรูปที่ผู้เรียกมีสิทธิ์ใช้ ตามลำดับที่ขอ
create or replace function inbox.media_get(p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = inbox, core, public as $$
declare v_role text := inbox.media_library_role(); v_result jsonb;
begin
  if v_role = 'none' then raise exception 'not_allowed'; end if;
  select coalesce(jsonb_agg(inbox.media_asset_json(a) order by array_position(p_ids, a.id)), '[]'::jsonb)
    into v_result
    from inbox.media_asset a
   where a.id = any(p_ids) and a.active and a.archived_at is null
     and (v_role in ('editor','service') or (a.status = 'approved' and (a.expires_at is null or a.expires_at > now())));
  return v_result;
end $$;

-- เสิร์ฟไฟล์ /library-media/<path> — ตรวจจาก path ทั้งตัวจริงและ preview
create or replace function inbox.media_path_allowed(p_path text)
returns boolean language plpgsql stable security definer set search_path = inbox, core, public as $$
declare v_role text := inbox.media_library_role();
begin
  if v_role = 'none' then return false; end if;
  return exists (
    select 1 from inbox.media_asset a
     where (a.storage_path = p_path or a.preview_path = p_path)
       and a.active and a.archived_at is null
       and (v_role in ('editor','service') or a.status = 'approved'
            or a.created_by = auth.uid()));
end $$;

-- ── media_create: หลังอัปโหลดไฟล์เข้า storage แล้ว ──────────────────
create or replace function inbox.media_create(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = inbox, core, public as $$
declare v_role text := inbox.media_library_role(); v_row inbox.media_asset;
begin
  if v_role not in ('sales','editor','service') then raise exception 'not_allowed'; end if;
  insert into inbox.media_asset(id, project, category, title, storage_path, preview_path, mime, width, height, bytes,
                                public_url, preview_url, bot_enabled, expires_at, status, created_by, updated_by)
  values (coalesce(nullif(p_data->>'id','')::uuid, gen_random_uuid()),
          coalesce(nullif(lower(p_data->>'project'),''), 'all'),
          coalesce(nullif(p_data->>'category',''), 'other'),
          trim(p_data->>'title'),
          p_data->>'storage_path', nullif(p_data->>'preview_path',''),
          p_data->>'mime', nullif(p_data->>'width','')::int, nullif(p_data->>'height','')::int,
          nullif(p_data->>'bytes','')::bigint,
          p_data->>'public_url', nullif(p_data->>'preview_url',''),
          v_role in ('editor','service') and coalesce((p_data->>'bot_enabled')::boolean, false),
          nullif(p_data->>'expires_at','')::timestamptz,
          case when v_role in ('editor','service') then 'approved' else 'pending' end,
          auth.uid(), auth.uid())
  returning * into v_row;
  return inbox.media_asset_json(v_row);
end $$;

-- ── media_update: แก้ชื่อ/หมวด/โครงการ/หมดอายุ/บอท/อนุมัติ ──────────
create or replace function inbox.media_update(p_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = inbox, core, public as $$
declare v_role text := inbox.media_library_role(); v_row inbox.media_asset;
begin
  if v_role not in ('editor','service') then raise exception 'not_allowed'; end if;
  update inbox.media_asset set
    title = coalesce(nullif(trim(p_data->>'title'),''), title),
    project = coalesce(nullif(lower(p_data->>'project'),''), project),
    category = coalesce(nullif(p_data->>'category',''), category),
    expires_at = case when p_data ? 'expires_at' then nullif(p_data->>'expires_at','')::timestamptz else expires_at end,
    bot_enabled = coalesce((p_data->>'bot_enabled')::boolean, bot_enabled),
    status = coalesce(nullif(p_data->>'status',''), status),
    updated_by = auth.uid(), updated_at = now()
  where id = p_id and archived_at is null
  returning * into v_row;
  if not found then raise exception 'media_not_found'; end if;
  return inbox.media_asset_json(v_row);
end $$;

-- ── media_archive: เก็บเข้ากรุ (ไม่ลบไฟล์ ไม่ลบแถว) ──────────────────
-- รูปที่ผูกกับ quick reply ยังส่งผ่าน quick reply ได้ตามเดิมไม่ได้ — qr_list กรอง a.active
-- จึงตั้งใจไม่แตะ active: รูปหายจากคลัง แต่ชุด quick reply เดิมไม่พัง
create or replace function inbox.media_archive(p_id uuid)
returns jsonb language plpgsql security definer set search_path = inbox, core, public as $$
declare v_role text := inbox.media_library_role(); v_row inbox.media_asset;
begin
  if v_role not in ('editor','service') then raise exception 'not_allowed'; end if;
  update inbox.media_asset set archived_at = now(), archived_by = auth.uid(), updated_at = now()
   where id = p_id and archived_at is null
  returning * into v_row;
  if not found then raise exception 'media_not_found'; end if;
  return inbox.media_asset_json(v_row);
end $$;

-- ── media_record_send: เรียกหลังส่งสำเร็จ ─────────────────────────
-- ผู้เรียกต้องเห็นบทสนทนานั้นอยู่แล้ว (connect_private.can_read) — กัน reviewer จดส่งเคสจริง
create or replace function inbox.media_record_send(p_conversation_id uuid, p_media_ids uuid[], p_message_id uuid default null)
returns integer language plpgsql security definer set search_path = inbox, core, public as $$
declare v_role text := inbox.media_library_role(); v_count integer;
begin
  if v_role = 'none' then raise exception 'not_allowed'; end if;
  if v_role <> 'service' and not connect_private.can_read(p_conversation_id) then raise exception 'not_allowed'; end if;
  insert into inbox.media_asset_send(media_asset_id, conversation_id, message_id, sent_by)
  select a.id, p_conversation_id, p_message_id, auth.uid()
    from inbox.media_asset a where a.id = any(p_media_ids);
  get diagnostics v_count = row_count;
  update inbox.media_asset set use_count = use_count + 1, last_used_at = now() where id = any(p_media_ids);
  return v_count;
end $$;

revoke all on function inbox.media_library_role(), inbox.media_asset_json(inbox.media_asset, boolean),
  inbox.media_list(text,text,text,text,uuid,text), inbox.media_get(uuid[]), inbox.media_path_allowed(text),
  inbox.media_create(jsonb), inbox.media_update(uuid,jsonb), inbox.media_archive(uuid),
  inbox.media_record_send(uuid,uuid[],uuid) from public, anon;
grant execute on function inbox.media_list(text,text,text,text,uuid,text), inbox.media_get(uuid[]),
  inbox.media_path_allowed(text), inbox.media_create(jsonb), inbox.media_update(uuid,jsonb),
  inbox.media_archive(uuid), inbox.media_record_send(uuid,uuid[],uuid) to authenticated, service_role;
grant execute on function inbox.media_library_role(), inbox.media_asset_json(inbox.media_asset, boolean)
  to authenticated, service_role;

commit;
