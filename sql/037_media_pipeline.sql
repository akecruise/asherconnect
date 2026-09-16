-- =====================================================================
-- 037_media_pipeline.sql — สื่อแนบแบบ private + REST RPC ที่ตรวจสิทธิ์
-- =====================================================================

alter table inbox.message add column if not exists media jsonb;

-- ฟังก์ชันชั้นในไม่ถูก expose ผ่าน PostgREST และไม่เปิดให้ token ผู้ใช้เรียกตรง ๆ
create or replace function connect_private.media_attach(p_message_id uuid, p_media jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_media is null or jsonb_typeof(p_media) <> 'array' or jsonb_array_length(p_media) = 0 then
    raise exception 'media_must_be_nonempty_array';
  end if;
  update inbox.message set media = p_media where id = p_message_id;
  return found;
end;
$$;

create or replace function connect_private.media_of(p_conversation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(m.id::text, m.media), '{}'::jsonb)
    from inbox.message m
   where m.conversation_id = p_conversation_id
     and m.media is not null;
$$;

create or replace function connect_private.media_access(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from inbox.message m
      join inbox.conversation c on c.id = m.conversation_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(m.media) = 'array' then m.media else '[]'::jsonb end
      ) item
     where p_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[1-9][0-9]*)?\.(jpg|png|gif|webp|mp4|m4a|mp3|ogg|pdf|bin)$'
       and c.inbox_id::text = split_part(p_path, '/', 1)
       and m.id::text = left(split_part(p_path, '/', 2), 36)
       and item->>'path' = p_path
  );
$$;

revoke all on function connect_private.media_attach(uuid, jsonb) from public, anon, authenticated;
revoke all on function connect_private.media_of(uuid) from public, anon, authenticated;
revoke all on function connect_private.media_access(text) from public, anon, authenticated;
grant execute on function connect_private.media_attach(uuid, jsonb) to service_role;
grant execute on function connect_private.media_of(uuid) to service_role;
grant execute on function connect_private.media_access(text) to service_role;

-- PostgREST ถูกตั้ง Content-Profile: inbox จึงต้องมี RPC ใน schema inbox.
-- media_attach เปิดเฉพาะ service_role สำหรับท่อ ingest เท่านั้น
create or replace function inbox.media_attach(p_message_id uuid, p_media jsonb)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select connect_private.media_attach(p_message_id, p_media);
$$;

revoke all on function inbox.media_attach(uuid, jsonb) from public, anon, authenticated;
grant execute on function inbox.media_attach(uuid, jsonb) to service_role;

-- ผู้ใช้ทั้งสอง RPC นี้ต้องยังมี profile ที่ active และเป็นบทบาทของ Connect
create or replace function inbox.media_of(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from core.profile p
     where p.user_id = auth.uid()
       and p.is_active
       and p.role in ('sales', 'senior_sales', 'manager', 'admin')
  ) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return connect_private.media_of(p_conversation_id);
end;
$$;

create or replace function inbox.media_access(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from core.profile p
     where p.user_id = auth.uid()
       and p.is_active
       and p.role in ('sales', 'senior_sales', 'manager', 'admin')
  ) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return connect_private.media_access(p_path);
end;
$$;

revoke all on function inbox.media_of(uuid) from public, anon;
revoke all on function inbox.media_access(text) from public, anon;
grant execute on function inbox.media_of(uuid) to authenticated;
grant execute on function inbox.media_access(text) to authenticated;

comment on function inbox.media_access(text) is
  'อนุญาตอ่าน private media เฉพาะ active Connect staff และ path ที่ผูกกับ inbox.message.media';
