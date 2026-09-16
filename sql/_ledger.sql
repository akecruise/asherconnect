-- =====================================================================
-- ทะเบียนไฟล์ SQL ที่ลงฐานไปแล้ว  (ต้องเป็นไฟล์แรกเสมอ)
-- =====================================================================
-- ★ ทำไมต้องมี: ฐานบน VPS มาจาก restore asher_schema.sql จึงไม่มี
--   supabase_migrations.schema_migrations ให้เช็ค ที่ผ่านมาต้องเทียบ catalog
--   ตรง ๆ ทุกครั้งว่าฟังก์ชันไหนลงแล้วบ้าง ซึ่งเทียบพลาดมาแล้ว
--   (เคยเจอ drift ตาราง 43 vs 55 · ฟังก์ชัน 43 vs 90 โดยไม่มีอะไรฟ้อง)
--
-- ★ เก็บ sha256 ไม่ใช่แค่ชื่อไฟล์ เพราะกับดักจริงของที่นี่คือ "ไฟล์ถูกแก้
--   หลังจากลงไปแล้ว" — ชื่อเดิม เนื้อใหม่ แล้วไม่มีใครรู้ว่าฐานเป็นรุ่นไหน
-- =====================================================================

create schema if not exists inbox;

create table if not exists inbox.sql_applied (
  filename   text primary key,
  sha256     text        not null,
  applied_at timestamptz not null default now(),
  applied_by text        not null default current_user
);

comment on table inbox.sql_applied is
  'ไฟล์ใน asher-connect/sql ที่ลงฐานนี้แล้ว — sha256 ของเนื้อไฟล์ตอนที่ลง';

-- ปิดตามแบบเดียวกับตาราง inbox อื่นทุกใบ (เทียบ sql/009_report.sql:41-42)
alter table inbox.sql_applied enable row level security;
revoke all on inbox.sql_applied from public, anon, authenticated;
grant select, insert on inbox.sql_applied to service_role;
