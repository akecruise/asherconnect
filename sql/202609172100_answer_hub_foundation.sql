-- =====================================================================
-- answer-hub foundation (Phase 1) — schema ใหม่ทั้งหมด ไม่แตะตารางเดิมใด ๆ
-- =====================================================================
-- ขอบเขตไฟล์นี้: answer_category + intent + question_pattern + ของตั้งต้น
--   (answer_item และของถัด ๆ อยู่ในไฟล์ Phase ถัดไป — ห้ามยัดรวมไว้ไฟล์เดียว
--    เพื่อให้ plan/apply และย้อนจุดพังชัดเจนทีละขั้น ตามบทเรียน incident 032)
--
-- กติกาที่ไฟล์นี้ยึด (เหมือน 202609172025_health.sql):
--   * ตารางทุกตัว RLS enabled + revoke จากทุก role แล้ว "ไม่มี policy" เลย
--     = ปิดการอ่านตรงทั้งหมด เข้าผ่านฟังก์ชัน security definer (Phase 2 เป็นต้นไป)
--   * รันซ้ำได้ (if not exists / on conflict do nothing) ตามธรรมเนียมของ sql/
--   * ตัวตรวจของไฟล์นี้: sql/_selftest/ah_foundation_selftest.sql
--
-- ทะเบียนวางแผนทั้งหมด: docs/answer-hub/DATABASE.md · ของเดิมที่ตรวจแล้ว: AUDIT.md §4
-- =====================================================================

create schema if not exists answer_hub;

-- schema นี้ "ไม่ใช่ทางเดินของคนอื่น" — PostgREST ไม่ได้ expose (db-schemas มีแค่
-- public, graphql_public, core, inbox) ประตูเดียวของผู้ใช้คือฟังก์ชัน inbox.ah_*
-- ที่จะเขียนในไฟล์ Phase 2 ขึ้นไป
revoke all on schema answer_hub from public, anon, authenticated;

-- ── updated_at กลาง ─────────────────────────────────────────────────
-- ทริกเกอร์ตัวเดียวใช้ร่วมทุกตารางของ answer_hub (ตารางไหนมี updated_at ก็ผูกตัวนี้)
create or replace function answer_hub.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── 1. answer_category ──────────────────────────────────────────────
-- หมวดคำตอบ 10 หมวดเริ่มต้นตาม spec — แก้ชื่อ/เพิ่มย่อยได้ทาง admin (Phase 8)
-- ลบไม่ได้เมื่อมีคำตอบผูกอยู่ (FK restrict) — retire คำตอบแทนการลบหมวด
create table if not exists answer_hub.answer_category (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_th     text not null,
  name_en     text,
  parent_id   uuid references answer_hub.answer_category(id) on delete restrict,
  icon        text,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace trigger answer_category_touch
  before update on answer_hub.answer_category
  for each row execute function answer_hub.touch_updated_at();

-- ── 2. intent ───────────────────────────────────────────────────────
-- ความตั้งใจของคำถาม — ใช้จับคู่คำถามกับคำตอบและเก็บผล classify ของบอทให้เชื่อมกันได้
create table if not exists answer_hub.intent (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  description  text,
  category_id  uuid references answer_hub.answer_category(id) on delete set null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace trigger intent_touch
  before update on answer_hub.intent
  for each row execute function answer_hub.touch_updated_at();

-- ── 3. question_pattern ─────────────────────────────────────────────
-- รูปคำถามหลายแบบต่อหนึ่ง intent — วัตถุดิบของ recommendation (Phase 14)
-- occurrence_count เพิ่มเมื่อเรียนรู้คำถามเดิมซ้ำ (learning, Phase 11)
create table if not exists answer_hub.question_pattern (
  id               uuid primary key default gen_random_uuid(),
  intent_id        uuid not null references answer_hub.intent(id) on delete cascade,
  question_text    text not null,
  language         text not null default 'th',
  source           text not null default 'manual' check (source in ('manual','learned','imported')),
  occurrence_count integer not null default 1,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists question_pattern_intent_idx on answer_hub.question_pattern (intent_id);
-- ค้นหาคำถามแบบ "มีคำนี้" ก่อนพิธีกรรมอื่น — simple config ใช้ได้กับไทยแบบ prefix matching
create index if not exists question_pattern_text_idx
  on answer_hub.question_pattern using gin (to_tsvector('simple', question_text));

create or replace trigger question_pattern_touch
  before update on answer_hub.question_pattern
  for each row execute function answer_hub.touch_updated_at();

-- ── สิทธิ์: ปิดการอ่าน/เขียนตรงทุกตาราง (นโยบายเดียวกับ health) ──────
alter table answer_hub.answer_category  enable row level security;
alter table answer_hub.intent           enable row level security;
alter table answer_hub.question_pattern enable row level security;

revoke all on answer_hub.answer_category  from public, anon, authenticated;
revoke all on answer_hub.intent           from public, anon, authenticated;
revoke all on answer_hub.question_pattern from public, anon, authenticated;

-- ── ของตั้งต้น: หมวด 10 หมวด ────────────────────────────────────────
insert into answer_hub.answer_category (code, name_th, name_en, sort_order) values
  ('price_promo',  'ราคาและโปรโมชั่น',      'Price & Promotions',    1),
  ('room_project', 'ห้องและโครงการ',        'Rooms & Projects',      2),
  ('location',     'ทำเลและการเดินทาง',     'Location & Transport',  3),
  ('facility',     'สิ่งอำนวยความสะดวก',    'Facilities',            4),
  ('appointment',  'นัดหมาย',                'Appointment',           5),
  ('loan',         'สินเชื่อ',                'Loan & Payment',        6),
  ('booking',      'การจอง',                  'Booking',               7),
  ('document',     'เอกสาร',                  'Documents',             8),
  ('after_sales',  'หลังการขาย',              'After Sales',           9),
  ('other',        'อื่น ๆ',                    'Other',                10)
on conflict (code) do nothing;

-- ── ของตั้งต้น: intent 10 ตัว ───────────────────────────────────────
insert into answer_hub.intent (code, name, description, category_id)
select v.code, v.name, v.description, c.id
from (values
  ('ask_price',         'สอบถามราคา',              'ราคาเริ่มต้น ราคาห้อง ราคาต่อตารางเมตร',   'price_promo'),
  ('ask_promotion',     'สอบถามโปรโมชั่น',         'โปรโมชั่น ข้อเสนอ ส่วนลด ของแถม',          'price_promo'),
  ('ask_available_unit','สอบถามห้องว่าง',          'ห้องว่าง ห้องเหลือ เหลือชั้นไหน',          'room_project'),
  ('ask_room_type',     'สอบถามประเภทห้อง',        'ขนาดห้อง จำนวนห้องนอน แปลนห้อง',           'room_project'),
  ('ask_location',      'สอบถามทำเล',              'ที่อยู่ เดินทาง ใกล้รถไฟฟ้า แผนที่',        'location'),
  ('ask_facility',      'สอบถามสิ่งอำนวยความสะดวก','สระว่ายน้ำ ฟิตเนส พื้นที่ใช้สอยร่วม',       'facility'),
  ('ask_parking',       'สอบถามที่จอดรถ',          'ที่จอดรถ ค่าจอดรถ จอดกี่คัน',               'facility'),
  ('ask_payment',       'สอบถามเงื่อนไขการชำระ',   'เงินดาวน์ งวดผ่อน วิธีชำระ',                'loan'),
  ('ask_loan',          'สอบถามสินเชื่อ',          'สินเชื่อ ธนาคาร ดอกเบี้ย การอนุมัติ',        'loan'),
  ('ask_appointment',   'นัดหมายเข้าชมโครงการ',    'นัดดูห้อง นัดชมจริง นัดคุยกับที่ปรึกษา',     'appointment')
) as v(code, name, description, category_code)
join answer_hub.answer_category c on c.code = v.category_code
on conflict (code) do nothing;

-- PostgREST ต้อง reload แคชก่อนเห็นตารางใหม่ (ธรรมเนียมเดิมท้ายไฟล์)
notify pgrst, 'reload schema';
