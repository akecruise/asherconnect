# DATABASE — Answer Knowledge Hub

กฎการทำ migration (ยึด `sql/run.mjs` + `sql/ORDER.txt` + incident 032):

- ไฟล์ใหม่ชื่อ `YYYYMMDDHHMM_<task>.sql` ต่อท้าย `sql/ORDER.txt` เสมอ — ห้ามแก้ไฟล์เก่า
- idempotent ทุก statement (`create or replace`, `add column if not exists`, `on conflict do nothing`)
- ทุกฟังก์ชัน `security definer set search_path = ''` + อ้างชื่อ schema เต็ม
- ตารางทุกตัว: `enable row level security` + `revoke all on <table> from public, anon, authenticated`
  **ไม่มี policy** (deny ตรง ๆ) — เข้าผ่านฟังก์ชัน `inbox.ah_*` เท่านั้น (pattern เดียวกับ `202609172025_health.sql`)
- จบไฟล์ด้วย `notify pgrst, 'reload schema'`
- apply ด้วย `npm run sql:plan -- --db "<conn>"` แล้ว `sql:apply` — ห้ามรันไฟล์เก่าซ้ำ

## ตารางทั้งหมดใน schema `answer_hub`

### 1. answer_category (Phase 1)
`id uuid PK default gen_random_uuid()` · `code text unique not null` · `name_th text not null` ·
`name_en text` · `parent_id uuid → answer_category(id)` · `icon text` · `sort_order int default 0` ·
`active boolean default true` · `created_at/updated_at timestamptz default now()`
Seed 10 หมวด: ราคาและโปรโมชั่น / ห้องและโครงการ / ทำเลและการเดินทาง / สิ่งอำนวยความสะดวก /
นัดหมาย / สินเชื่อ / การจอง / เอกสาร / After Sales / อื่น ๆ

### 2. intent (Phase 1)
`id uuid PK` · `code text unique not null` · `name text not null` · `description text` ·
`category_id uuid → answer_category` · `active bool default true` · `created_at/updated_at`
Seed: ask_price, ask_promotion, ask_available_unit, ask_room_type, ask_location,
ask_facility, ask_parking, ask_payment, ask_loan, ask_appointment

### 3. question_pattern (Phase 1)
`id uuid PK` · `intent_id uuid → intent` · `question_text text not null` ·
`language text default 'th'` · `source text check(manual|learned|imported)` ·
`occurrence_count int default 1` · `active bool default true` · `created_at/updated_at`
Index: `gin (to_tsvector('simple', question_text))` + trigram ถ้ามี extension

### 4. answer_item (Phase 2)
`id uuid PK` · `category_id → answer_category` · `intent_id → intent (null ได้)` ·
`title text not null` · `body_template text not null` ·
`answer_type text check(static|dynamic|hybrid) default 'static'` ·
`audience text check(human|bot|both) default 'both'` ·
`source_type text check(manual|learned|imported|generated) default 'manual'` ·
`project_id uuid → core.project (null = ทุกโครงการ)` · `language text default 'th'` ·
`status text check(draft|review|approved|retired) default 'draft'` ·
`show_in_quick_answer bool default true` · `bot_auto_answer bool default false` ·
`priority int default 100` · `confidence numeric(4,3)` ·
`valid_from/valid_to timestamptz` · `approved_by/approved_at` ·
`created_by uuid` · `created_at/updated_at`
Index: status+audience+bot_auto_answer (ตัวกรองบอท), trgm(title), project_id

### 5. answer_version (Phase 3)
`id uuid PK` · `answer_item_id → answer_item` · `version_no int` ·
`title text` · `body_template text` · `snapshot jsonb` (ทั้งแถวก่อนแก้) ·
`changed_by uuid` · `change_reason text` · `created_at`
Unique: `(answer_item_id, version_no)` — เขียนโดย RPC approve/update เท่านั้น

### 6. source_registry (Phase 4 — ✅ implement แล้ว: `sql/202609180530_source_registry.sql`)
`id uuid PK` · `source_code text unique not null` (10 แหล่ง seed — ดูตารางข้างล่าง) ·
`source_type text check(view|rpc|api) default 'rpc'` · `object_name text not null`
(ชื่อฟังก์ชัน src_* จริงที่ resolver เรียก — ห้าม interpolate SQL จากแถว) · `description text` ·
`bot_allowed bool default false` (deny by default — เปิดทีละแหล่งเมื่อถึง Phase 15) ·
`human_allowed bool default true` · `freshness_seconds int default 300` ·
`active bool default true` · `created_at/updated_at`
Index: unique(source_code), active, bot_allowed, human_allowed
RPC: `inbox.ah_source_list` (manager+) · `inbox.ah_source_save` (admin — แก้ของที่มีอยู่เท่านั้น)

**รูปแบบคืนค่าของ src_* ทุกตัว (normalized):**
`{"status":"ok","value":…,"as_of":…}` หรือ `{"status":"missing","reason":"…"}` (ห้ามเดา —
render ใช้ fallback_text) · `{"status":"invalid","reason":"invalid_status"}` เมื่อ p_status ไม่อยู่ใน enum

**ด่านสิทธิ์ `answer_hub.src_check_allowed(p_source_code, p_for_bot)`** — ไม่ throw คืน
`{"allowed":bool,"reason":"ok|source_not_found|source_inactive|bot_not_allowed|human_not_allowed", …}`
(แมปกับ error model: source_inactive = source_disabled · bot/human_not_allowed = source_not_allowed ·
missing = data_not_found · project_not_found = invalid_context)

### 7. answer_data_binding (Phase 5 — ✅ implement แล้ว: `sql/202609180630_answer_binding.sql`)
`id uuid PK` · `answer_item_id → answer_item on delete cascade` ·
`variable_name text not null` (เก็บไม่มีปีกกา ตัวพิมพ์เล็ก — `{{Project_Name}}` → `project_name`,
รูปแบบ `^[a-z_][a-z0-9_]*$` ตรวจตอน save) · `source_id → source_registry on delete restrict` ·
`source_field text` · `required bool default true` · `fallback_text text` ·
`cache_ttl_seconds int default 300` · `created_at/updated_at`
Unique: `(answer_item_id, variable_name)` — ผูกซ้ำ = upsert แก้ของเดิม

**`source_field` ทำสองหน้าที่ (จดไว้เพราะไม่เหมือนกันทุกแหล่ง):**
1. ส่งเข้า dispatcher เป็น fact_key ของ `src_project_fact` (ผ่าน context)
2. เป็นกุญแจดึงค่าจาก `value` (เช่น PROJECT_PROFILE + `name` → ชื่อโครงการ)
   — สำหรับ fact สองอย่างนี้คนละค่า (fact_key=payment_terms แต่กุญแจใน value คือ `text`)
   → ลำดับค้นของ ah_resolve: `source_field` → `text` → `num` → ทั้ง value (ตัวกรอง scalar ตัดสิน)

**`inbox.ah_resolve(p_data)`** — resolveAnswer ฝั่งคน: อ่าน binding ทั้งหมดของคำตอบ →
`src_resolve` ทีละตัว (gate + dispatcher CASE ตายตัว — ไม่มี dynamic SQL) → คืน
`{values{var:ค่า}, missing[], ok, detail[]}` · sales เรียกได้เฉพาะของ approved (draft/review
เฉพาะ manager+) · แหล่ง array (CURRENT_PROMOTION) ใช้กุญแจจากแถวแรกที่มีกุญแจนั้น ·
ยอมรับเฉพาะ scalar — object หลุดเข้า values ไม่ได้ · required ขาด = อยู่ใน missing ไม่เดา ·
optional ขาด = fallback_text · uuid ใน context ตรวจ regex ก่อน cast (ค่ามั่ว = invalid_context)

**`answer_hub.src_resolve(code, context, for_bot)`** — dispatcher ภายใน คืน
`denied/source_not_found|source_inactive|bot_not_allowed` / `invalid/invalid_context` /
ok|missing ตามแหล่ง — ทดสอบตรงได้เฉพาะฝั่ง postgres (authenticated ไม่มี USAGE บน schema)

**ตารางพฤติกรรมครบทุกกรณี (ผลจริงจาก selftest Phase 5 — ✅ ผ่าน 2026-09-18):**

| กรณี | ผลที่เกิดจริง |
|---|---|
| required variable missing | ไม่อยู่ใน `values` · อยู่ใน `missing` + `detail` status=missing พร้อมเหตุผล · `ok=false` · render คง `{{var}}` เดิมไว้ — ข้อความที่ยังมี `{{}}` ห้ามส่งออก |
| optional variable missing | ใช้ `fallback_text` ถ้าผูกไว้ (detail status=fallback) · ไม่มี fallback → ไม่อยู่ใน values (render แทนค่าว่าง) |
| source disabled | `src_resolve` คืน `denied/source_inactive` — resolver ไม่แตะแหล่งนั้นเลย |
| source permission denied | `denied/bot_not_allowed` หรือ `human_not_allowed` (deny by default ฝั่งบอท) |
| source unavailable | object_name ไม่มี adapter ใน dispatcher → `missing/source_unavailable` |
| data not found | `missing` + เหตุผลเฉพาะ (project_not_found / fact_not_found / no_active_promotion ฯลฯ) |
| render failure | renderTemplate ออกแบบให้ไม่ throw (body null/ค่าแปลกจัดการครบ); ถ้ายัง throw ฝั่ง service จะ map เป็น RENDER_FAILED — ไม่ปล่อย raw error |

**ยืนยันต่อ anti-hallucination:** ระบบไม่มีการสร้างค่าขึ้นเองทุกชั้น — ค่าใน `values` มาจาก
ฐานเท่านั้น (ผ่าน src_*) หรือจาก `fallback_text` ที่ admin ผูกไว้เอง · ข้อมูล critical
(ราคา/ห้องว่าง/โปรโมชั่น) ไม่มี fallback อัตโนมัติเว้นแต่ admin ตั้งเอง · ค่าที่ resolve
ไม่ได้ = missing และบล็อกการส่งออกอัตโนมัติ ไม่ใช่เดาค่าใส่

### 8. learning_candidate (Phase 11)
`id uuid PK` · `conversation_id uuid` · `customer_question text` · `human_answer text` ·
`suggested_intent_id → intent` · `suggested_category_id → answer_category` ·
`project_id uuid` · `similarity_score numeric(5,4)` · `quality_score numeric(5,4)` ·
`occurrence_count int default 1` ·
`status text check(pending|approved|rejected|merged) default 'pending'` ·
`reviewed_by/reviewed_at` · `created_answer_id → answer_item` (ตอน approve/merge) ·
`created_at`
Dedupe: unique บน normalized(customer_question) ที่ยัง pending — ซ้ำแล้ว bump occurrence_count

### 9. answer_usage (Phase 16)
`id uuid PK` · `answer_item_id → answer_item` · `conversation_id uuid` · `user_id uuid` ·
`actor_type text check(human|bot)` · `action text check(view|preview|select|edit|send|auto_send)` ·
`original_text text` · `final_text text` · `was_edited bool` · `channel text` · `created_at`
Index: (answer_item_id, created_at)

### 10. answer_feedback (Phase 17)
`id uuid PK` · `answer_item_id → answer_item` · `user_id uuid` · `conversation_id uuid` ·
`feedback_type text check(helpful|incorrect|outdated|edited|duplicate|other)` ·
`note text` · `created_at`

## Quick Reply Integration (Phase 7 — ไม่แตะของ asher-web)

### answer_hub.quick_reply_link
`quick_reply_id uuid PK (FK → inbox.quick_reply)` · `answer_item_id uuid → answer_item` ·
`sync_mode text check(manual|mirror) default 'manual'` · `category_code text` (map หมวด QR เดิม) ·
`created_at/updated_at`
**เหตุผลที่เป็นตาราง link ไม่ ALTER inbox.quick_reply**: ตาราง QR เป็นของ repo asher-web
(ledger คนละชุด) — ดู `adr/ADR-005-qr-link-table.md`
Legacy QR (ไม่มี link) ทำงานเหมือนเดิม 100%

## RPC สาธารณะ (inbox.ah_*) — สิทธิ์เรียก

**Phase 6 อัปเกรด (2026-09-18 — `sql/202609180730_answer_service.sql` +
`sql/202609180740_resolve_sources.sql`):** `ah_list` กรองเพิ่มได้ audience / answer_type /
source_type / language / show_in_quick_answer / bot_auto_answer + query ค้นคลุม
body_template ด้วย (สิทธิ์เดิมคงเดิม — sales ขอสถานะอื่นถูกบังคับกลับ approved เหมือนเดิม) ·
`ah_resolve` รายงาน `detail[].source_code` + `sources` (รายการแหล่งที่ถูกใช้ ไม่ซ้ำ)
ให้ Answer Service ประกอบ `sources_used`

| ฟังก์ชัน | ใครเรียก | ทำอะไร |
|---|---|---|
| `ah_recommend(p_data jsonb)` | authenticated: sales ขึ้นไป | recommend + resolve สำหรับ composer |
| `ah_list(p_data)` | authenticated | รายการคำตอบ (filter status/category/intent/project/query) |
| `ah_get(p_data)` | authenticated | รายละเอียด + versions + bindings |
| `ah_save(p_data)` | manager/admin | สร้าง/แก้ (auto version ถ้าเดิม approved) |
| `ah_approve(p_data)` | admin | draft/review → approved |
| `ah_retire(p_data)` | admin | → retired |
| `ah_category_save / ah_intent_save` | admin | จัดการหมวด/intent |
| `ah_source_list / ah_source_save` | list: manager / save: admin | source registry |
| `ah_learning_list / ah_learning_review` | manager/admin | Learning Queue + ตัดสิน |
| `ah_usage_summary / ah_feedback_list` | manager/admin | analytics |
| `ah_health()` | gate เดียวกับ health_can_view | snapshot ส่วนของ hub |
| `ah_bot_recommend(p_data)` | **service_role เท่านั้น** (worker path) | ตัวกรองบอทเข้ม + resolve |
| `ah_learning_create(p_data)` | service_role (จาก hook) | สร้าง candidate |

grant execute: ฟังก์ชัน user → `authenticated` · ฟังก์ชัน service → `service_role`
ตรวจ role ภายในฟังก์ชันด้วย `core.current_user_role()` (มีอยู่จริง ใช้ใน sql/029)

## แหล่งข้อมูล ERP จริงที่ resolver อ่าน (Phase 4 — ✅ implement แล้ว)

| source_code | object_name จริง | หมายเหตุ |
|---|---|---|
| PROJECT_PROFILE | `answer_hub.src_project_profile(p_project_id uuid)` → core.project | active |
| PROJECT_PRICE | `answer_hub.src_project_price(p_project_id uuid)` → min(inventory.unit.price) | active (ไม่มียูนิต → missing) |
| AVAILABLE_UNITS | `answer_hub.src_available_units(p_project_id uuid, p_status text default null)` | active — available_units นับเฉพาะ status='available' · p_status ต้องเป็น label ของ enum จริง |
| CURRENT_PROMOTION | `answer_hub.src_current_promotion(p_project_id uuid)` → public.promotions | active — วันที่ยังไม่พ้น + upper(status)='ACTIVE' |
| PAYMENT_TERMS / PROJECT_LOCATION / FACILITIES | `answer_hub.src_project_fact(p_project_id uuid, p_fact_key text)` → public.project_facts | active — fact_key = payment_terms/location/facilities · ข้อมูลยังว่าง → missing · ออกเฉพาะ is_public≠0 |
| APPOINTMENT_SLOT | `answer_hub.src_appointment_slots(p_lead_id uuid)` → crm.activity type=site_visit | **inactive** (ยังไม่มี data จริง) |
| LEAD_PROFILE | `answer_hub.src_lead_profile(p_lead_id uuid)` → crm.lead | **inactive** |
| LEAD_FOLLOWUP | `answer_hub.src_lead_followup(p_lead_id uuid)` → connect_private.case_state | **inactive** |

resolver เรียกผ่านฟังก์ชัน `object_name` เท่านั้น (ไม่ interpolate SQL จากแถวใด ๆ)

### สิ่งที่ schema จริงต่างจากที่ออกแบบไว้ (ตรวจ catalog 2026-09-18 — schema จริงเป็น source of truth)
- `public.promotions.project_id` และ `public.project_facts.project_id` เป็น **varchar** —
  เทียบแบบ text (`p_project_id::text`) ห้าม cast varchar→uuid (แถวไอดีมั่วจะทำ cast พังทั้ง query)
- `inventory.unit.price` เป็น **NOT NULL** — "missing" ของ PROJECT_PRICE = โครงการไม่มียูนิตเลย
- `promotions.status` เก็บ **'ACTIVE' ตัวใหญ่** — ตัวกรองต้อง `upper(status)='ACTIVE'`
- `inventory.unit.status` เป็น enum `unit_status`: available, hold, booked, contracted, transferred —
  นิยาม "พร้อมขาย" = **available เท่านั้น** (hold/booked/…ไม่นับใน available_units แต่แจกแจงไว้ครบ)
- `project_facts.id` เป็น bigint ไม่มี default · `verified_at` เป็น timestamp ไม่มี timezone

## updated_at handling

trigger `touch_updated_at()` ร่วมกันทุกตารางที่มี updated_at (สร้างครั้งเดียวในไฟล์ Phase 1)
