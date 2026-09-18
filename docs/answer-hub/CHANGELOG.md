# CHANGELOG — Answer Knowledge Hub

รูปแบบ: วันที่ · Phase · เปลี่ยนอะไร · ไฟล์

## 2026-09-18 · Phase 6 — Answer Service
- สร้าง `services/answer-hub/service.mjs`: ชั้นบริการกลาง — ทุก action `ah_*` จาก server.mjs
  เดินผ่าน `handle()` เท่านั้น (ห้าม consumer query ตารางตรง) · getAnswer (uuid/validity/
  สถานะ) · listAnswers (filter ครบ + clamp pagination + ตรวจ uuid filter) · searchAnswers
  (title+body ilike, score=null รอ Phase 14) · resolveAnswer (ต่อยอด ah_resolve + render.mjs
  — ไม่ duplicate renderer; static ไม่โดน dynamic flag) · botResolve (policy: approved +
  audience bot/both + bot_auto_answer + validity — ทางเดินจริงของบอท Phase 15) ·
  recommend/usage/feedback = boundary NOT_AVAILABLE_YET ห้าม fake
- flags 5 ตัว default ปิดทั้งหมด: ANSWER_HUB_ENABLED / _DYNAMIC_DATA_ / _BOT_ / _LEARNING_ /
  _IMPORT_ — buildFlags อ่าน env + hook override inbox.settings (ต่อเมื่อตารางพร้อม); flag ปิด
  = คืน HUB_DISABLED/FEATURE_DISABLED แบบ controlled (HTTP 200)
- error model กลาง ANSWER_* — code ดิบของฐาน map ที่เดียว, raw SQL error ไม่มีทางออก client
  (S16/S17 พิสูจน์) · structured log ใหม่: answer_service_get/search/resolve,
  answer_service_rpc_failed, answer_service_resolve_failed, answer_permission_denied,
  answer_source_missing (ไม่ใส่ PII)
- SQL: `202609180730_answer_service.sql` (ah_list กรอง audience/answer_type/source_type/
  language/show_in_quick_answer/bot_auto_answer + query ค้น body — สิทธิ์เดิมคงเดิม) ·
  `202609180740_resolve_sources.sql` (ah_resolve detail ใส่ source_code + รายการ sources)
- แก้ Dockerfile เพิ่ม COPY services/ — test "ทุกโฟลเดอร์ที่ import ต้องถูก COPY"
  (bots.test.mjs) จับได้ว่าไม่งั้น container ขึ้นไม่ขึ้น
- tests ใหม่: unit `tests/answer-hub.service.test.mjs` 21 ข้อ (S01–S17 + flags + boundary) ·
  selftest `ah_answer_service_selftest.sql` (S07/S08/S09/S18 + filter ใหม่ + สิทธิ์เดิม)
- regression: npm test = ผ่าน 277 / ล้ม 0 (unit 209 + integration 68) · selftest hub ครบ 6
  ผ่านหมด · mapping S01–S21 อยู่ใน TESTING.md
- ยังไม่ apply บน VPS (ต้องใช้ connection string จากผู้ดูแล)

## 2026-09-18 · Phase 5 — Data Binding
- สร้าง `sql/202609180630_answer_binding.sql`: ตาราง `answer_hub.answer_data_binding`
  (unique (answer_item_id, variable_name), ผูกซ้ำ = upsert) + dispatcher ภายใน
  `answer_hub.src_resolve` (gate ผ่าน src_check_allowed + CASE ตายตัวตาม object_name —
  ไม่มี dynamic SQL) + ประตู `inbox.ah_resolve` / `ah_binding_save` / `ah_binding_list` /
  `ah_binding_delete` + `ah_get` อัปเกรดคืน `{item, versions, bindings}` — apply local ผ่าน
- `server.mjs`: AH_ACTIONS ครบ 12 action (ไม่แตะ safeCodes — ไม่มี code ใหม่)
- สร้าง `services/answer-hub/render.mjs` (zero-dep — renderTemplate/renderFromResolve:
  required ขาดคง {{var}} ไว้ + missing list ห้ามส่งออก · ค่าแทนไม่สแกนซ้ำกัน recursion)
  + unit test `tests/answer-hub.render.test.mjs` 10 ข้อ (เสียบ test chain ใน package.json)
- selftest `sql/_selftest/ah_answer_binding_selftest.sql` — T09/T10 ผ่าน: values ตรงฐานจริง
  (profile/price/units/promo/fact) · fallback_text · required ขาดอยู่ใน missing ไม่เดา ·
  object หลุดเป็นค่าไม่ได้ · sales resolve ได้เฉพาะ approved · sales/service_role แก้ผูกไม่ได้
- บั๊กที่ selftest จับได้ (แก้แล้ว): source_field ของ fact ต้องเดินทางเข้า dispatcher เป็น
  fact_key (context merge) · แหล่ง array ต้องหากุญแจจากแถวแรกที่มี · fact_key ≠ กุญแจใน
  value → ลำดับค้น source_field → text → num
- ความจริง schema เพิ่ม: `inventory.unit.price` มี scale 2 (2.9M เก็บเป็น 2900000.00)
- `npm test` = ผ่าน 256 / ล้ม 0 (unit 188 + integration 68) · selftest ย้อนหลัง Phase 1–4 ผ่านหมด
- ยังไม่ apply บน VPS (ต้องใช้ connection string จากผู้ดูแล)

## 2026-09-18 · Phase 4 — Source Registry
- สร้าง `sql/202609180530_source_registry.sql`: ตาราง `answer_hub.source_registry` (index
  active/bot_allowed/human_allowed — source_code ใช้ unique ที่มีอยู่) + seed 10 แหล่ง
  (7 active / 3 placeholder inactive: APPOINTMENT_SLOT, LEAD_PROFILE, LEAD_FOLLOWUP) +
  ตัวอ่าน ERP จริง `src_*` 9 ฟังก์ชัน (ok/missing/invalid — ห้ามเดา) + ด่าน
  `src_check_allowed` + ประตู `inbox.ah_source_list` (manager+) / `ah_source_save` (admin) —
  apply บน local DB ผ่าน (รันซ้ำพิสูจน์ idempotent)
- `server.mjs`: เพิ่ม 'ah_source_list'/'ah_source_save' ใน AH_ACTIONS (บรรทัดเดียว — ไม่แตะ safeCodes)
- selftest `sql/_selftest/ah_source_registry_selftest.sql` — T11.1–T11.11 ผ่านครบ:
  ทะเบียน seed/inactive ตรงชุด, object_name ต้องเป็น src_* และมีฟังก์ชันจริง (กัน arbitrary SQL),
  ด่านบอท/คน/แหล่งปิด, sales/manager/service_role แก้ทะเบียนไม่ได้, admin list/save ได้,
  AVAILABLE_UNITS นับเฉพาะ available (enum จริง), varchar project_id ไม่พัง cast, invalid project → missing
- ของจริงที่ต่างจากออกแบบไว้ (จดใน DATABASE.md): promotions/project_facts.project_id เป็น varchar,
  inventory.unit.price NOT NULL, promotions.status เก็บ 'ACTIVE' ตัวใหญ่, unit.status เป็น enum
- บั๊กที่ selftest จับได้ (แก้แล้ว): min() ปนคอลัมน์ non-aggregate ต้อง GROUP BY · jsonb_agg บน
  แถวว่างคืน 1 แถว value null ต้อง having count(*)>0 — งั้น missing ไม่ขึ้น
- ตรวจ catalog จริง (constraint/index/proconfig search_path=''/privilege ทุก role/seed) ครบ
- `npm test` = 246 ผ่าน / 0 ล้ม เท่าก่อนแตะ Phase 4 · docs 5 ไฟล์อัปเดต
- ยังไม่ apply บน VPS (ต้องใช้ connection string จากผู้ดูแล)

## 2026-09-18 · Phase 3 — Version Control
- สร้าง `sql/202609180430_answer_version.sql`: ตาราง `answer_hub.answer_version` +
  `answer_hub._snapshot_version` + ah_save/ah_retire รุ่นเก็บประวัติ (ทับของ Phase 2 ได้ —
  ฟังก์ชันของ hub เอง) + `inbox.ah_versions` (อ่านประวัติ, manager+) — apply บน local DB ผ่าน
- `server.mjs`: เพิ่ม 'ah_versions' ใน AH_ACTIONS · ORDER.txt append แล้ว
- selftest `sql/_selftest/ah_answer_version_selftest.sql` (T05, 6 เคส) — แก้บั๊กของตัว selftest
  เอง: จุดที่ SELECT ตาราง `answer_hub.answer_version` ตรง ๆ ขณะ impersonate authenticated
  (5 จุด) ครอบด้วย `execute 'reset role'` … `execute 'set local role authenticated'`
  แบบเดียวกับ ah_foundation_selftest → ผ่าน 6/6
- `npm run check` ผ่าน · `npm test` = ผ่าน 246 / ล้ม 0 (178 unit + 68 integration) — สูงกว่า
  baseline เดิม 47/14 เพราะ session คู่ขนาน (health/system-status) แก้ tests/http.integration.mjs
  และ apply SQL เพิ่มบน local DB ไปแล้ว · ไฟล์ที่ hub แก้เป็น selftest SQL นอก npm test
- ยังไม่ apply บน VPS (ต้องใช้ connection string จากผู้ดูแล — ดู HANDOFF Blockers)

## 2026-09-18 · Phase 2 — Answer Core
- สร้าง migration `sql/202609172145_answer_item.sql`: ตาราง `answer_hub.answer_item` + 4 ดัชนี +
  ประตู RPC `inbox.ah_list/ah_get/ah_save/ah_approve/ah_retire` (security definer, role gate
  ด้วย core.current_user_role ข้างใน, error เป็น code ah_*)
- `server.mjs`: เพิ่ม AH_ACTIONS whitelist + dispatch + safeCodes (ah_not_allowed, ah_not_found,
  ah_invalid, ah_state_not_allowed, ah_duplicate, ah_missing_required_data)
- selftest `sql/_selftest/ah_answer_item_selftest.sql` — 9 เคส จำลอง JWT ต่อ role ผ่าน 9/9
- บั๊กที่ selftest จับได้ (แก้แล้ว): validation ตอน update บังคับ title แม้ส่งแค่ body_template ·
  `create trigger` ไม่ idempotent (เปลี่ยนเป็น create or replace trigger ทั้ง Phase 1+2) ·
  aggregate+window ผสมใน query เดียวทำ ah_list พัง (แยก CTE)
- `npm run check` + sql:check ผ่าน · `npm test` = 47/14 เท่า baseline (ไม่ทำของเดิมพัง)
- หมายเหตุ: มี session คู่ขนานทำ "Admin System Status" (202609172130_system_status.sql) —
  migration ผมเลื่อนเลขเป็น 2145 กันชนเลขนาที

## 2026-09-17 · Phase 1 — Database Foundation
- สร้าง migration `sql/202609172100_answer_hub_foundation.sql` (schema `answer_hub` +
  answer_category + intent + question_pattern + trigger touch_updated_at + ดัชนี
  gin(to_tsvector) + seed หมวด 10 / intent 10) — idempotent, RLS ไม่มี policy (deny ตรง)
- append ลง `sql/ORDER.txt` ท้ายไฟล์
- selftest ใหม่ `sql/_selftest/ah_foundation_selftest.sql` — ผ่าน 6/6 บน local dev DB
- พิสูจน์ด้วย A/B test ว่า integration suite (ล้ม 14 ข้อ) เป็นของเดิมของ local DB ไม่เกี่ยวกับ migration
- ยังไม่ apply บน VPS (ต้องใช้ connection string จากผู้ดูแล — ดู HANDOFF Blockers)

## 2026-09-17 · Phase 0 — Discovery & Audit
- สำรวจระบบจริงครบทั้งโค้ด + sql/ + asher-web + live DB; ยืนยัน Quick Reply objects, ERP objects จริง, roles จริง
- ยืนยันว่าไม่มีระบบ knowledge/answer/learning อยู่ก่อน (greenfield)
- สร้างเอกสารชุด `docs/answer-hub/` (20 ไฟล์ + adr 5 ไฟล์)
- ไม่มี code change, ไม่มี DB change
