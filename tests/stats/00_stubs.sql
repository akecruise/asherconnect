-- stub สำหรับเทสต์เท่านั้น (อย่ารันบน production)
--
-- ★ ของเดิมเป็น schema ที่คิดขึ้นเอง ไม่มีคอลัมน์ไหนตรงกับของจริงเลยสักตัว
--   (stub มี direction/is_bot/is_echo/profile_id/text — ของจริงมี sender_type/sender_id/content/event_type)
--   ผลคือเทสต์ผ่าน 25/25 โดยไม่ได้พิสูจน์เลยว่าอ่าน inbox.message ของจริงได้
--   ไฟล์นี้จึงคัดโครงมาจาก information_schema ของฐานจริงบน VPS เมื่อ 2026-09-15
--
-- ที่ยังต่างจากของจริงโดยตั้งใจ: ไม่ใส่ RLS, ไม่ใส่ trigger ของระบบเดิม
-- (enqueue_outbound / sync_conversation_after_message / capture_reply)
-- เพราะเทสต์ชุดนี้วัดชั้น stats ไม่ได้วัดการส่งข้อความ

-- ★ role ของ Supabase — ฐานทดสอบเป็น postgres:16 เปล่า ไม่มี role พวกนี้
--   ไฟล์ที่มี grant/revoke (023, 027) จะตายด้วย role "anon" does not exist
--   service_role ต้อง bypassrls เหมือนของจริง ไม่งั้นเทสต์ RLS จะอ่านผลผิด
do $stub$ begin create role anon          nologin; exception when duplicate_object then null; end $stub$;
do $stub$ begin create role authenticated nologin; exception when duplicate_object then null; end $stub$;
do $stub$ begin create role service_role  nologin bypassrls; exception when duplicate_object then null; end $stub$;

create schema if not exists core;
create schema if not exists auth;
create schema if not exists inbox;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

-- ── ตัวตนของคน ────────────────────────────────────────────────────────
-- ★ core.profile ใช้ user_id เป็น PK ไม่มีคอลัมน์ id และไม่มี full_name
--   ชื่อที่เอาไปโชว์ต้องมาจาก core."user".email
create table if not exists core."user" (
  id    uuid primary key,
  email text not null
);

create table if not exists core.profile (
  user_id    uuid primary key references core."user"(id) on delete cascade,
  role       text not null default 'sales'
             check (role in ('sales','senior_sales','marketing','manager','admin')),
  team       text,
  signature  text,
  is_active  boolean not null default true,
  extra      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── โครงการ / ช่องทาง / ห้องสนทนา ─────────────────────────────────────
create table if not exists core.project (
  id     uuid primary key,
  code   text not null unique,
  name   text not null,
  status text not null default 'active'
);

create table if not exists core.contact (id uuid primary key);

create table if not exists core.contact_identity (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references core.contact(id) on delete cascade,
  channel     text not null,
  external_id text not null,
  unique (channel, external_id)
);

create table if not exists inbox.inbox (
  id         uuid primary key,
  channel    text not null,
  project_id uuid references core.project(id),
  name       text not null,
  is_active  boolean not null default true
);

create table if not exists inbox.conversation (
  id              uuid primary key,
  inbox_id        uuid not null references inbox.inbox(id),
  contact_id      uuid not null references core.contact(id),
  status          text not null default 'open',
  assignee_id     uuid,
  last_message_at timestamptz,
  created_at      timestamptz not null default now()
);

-- ── ข้อความ ───────────────────────────────────────────────────────────
-- ★ สี่ค่าใน sender_type คือของจริงทั้งหมด มี CHECK บังคับอยู่บนฐานจริงด้วย
--   'system' มีอยู่จริงและต้องไม่ถูกนับเป็นคนตอบ
-- ★ event_type: follow/unfollow/postback ถูกเก็บปนอยู่ในตารางเดียวกัน
--   ถ้านับเป็น "ลูกค้าถาม" การกดเพิ่มเพื่อนจะเปิดรอบที่ไม่มีใครตอบ
create table if not exists inbox.message (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references inbox.conversation(id) on delete cascade,
  sender_type         text not null check (sender_type in ('contact','agent','bot','system')),
  sender_id           uuid,
  content             text not null,
  content_type        text not null default 'text',
  external_message_id text,
  delivered_at        timestamptz,
  read_at             timestamptz,
  created_at          timestamptz not null default now(),
  event_type          text not null default 'message'
                      check (event_type in ('message','postback','follow','unfollow','other'))
);

create index if not exists message_conversation_idx on inbox.message (conversation_id, created_at);
