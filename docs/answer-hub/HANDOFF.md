# HANDOFF — Answer Knowledge Hub

> อัปเดตก่อนหยุดงานทุกครั้ง — เปิดไฟล์นี้แล้วทำต่อได้ทันทีโดยไม่ต้องเดา

## Project
ASHER Connect — Answer Knowledge Hub (คลังคำตอบกลางสำหรับ Quick Answer / Bot / Admin / Learning / Import)

## Root Path
`D:\aplus_postgres_docker\asher-connect`

## Current Phase
Phase 7 — QR Integration (**NEXT — ยังไม่เริ่ม** · Phase 6 ปิดแล้ว 2026-09-18)

## Current Status
- **Phase 6 COMPLETE** (2026-09-18) · Phase 0–6 = COMPLETE ทั้งหมด · regression ยืนยัน:
  npm test exit 0 · unit 209/209 · integration 68/68 · **รวม 277 PASS / 0 FAIL** ·
  selftest hub ครบ 6 Phase ผ่านทั้งหมด · mapping S01–S21 อยู่ใน TESTING.md
- **DO NOT RERUN OR EDIT APPLIED MIGRATIONS** — ไฟล์ที่ apply บน local DB แล้ว (ห้ามรันซ้ำ
  บน local ด้วยคำสั่ง psql ตรง เพราะ local ไม่มี ledger กันซ้ำ — ไฟล์ออกแบบ idempotent
  ไว้ให้ apply บน VPS ผ่าน sql:apply ครั้งเดียวตอน Phase 26):
  `202609172025_health.sql` (ของ session คู่ขนาน) · `202609172100_answer_hub_foundation.sql`
  · `202609172145_answer_item.sql` · `202609180430_answer_version.sql` ·
  `202609180530_source_registry.sql` · `202609180630_answer_binding.sql` ·
  `202609180730_answer_service.sql` · `202609180740_resolve_sources.sql`
  — แก้ behavior ใหม่ = สร้างไฟล์ใหม่ create-or-replace เสมอ (แบบเดียวกับ Phase 3/5/6 ที่ทับ
  ฟังก์ชันของ hub เอง)

## Completed
- Phase 0: AUDIT.md + เอกสารชุด `docs/answer-hub/` ครบ (ดู README)
- Phase 1: migration `202609172100_answer_hub_foundation.sql` + selftest — apply บน local แล้ว
- Phase 2: migration `202609172145_answer_item.sql` + selftest 9 เคส + server.mjs (safeCodes,
  AH_ACTIONS whitelist, dispatch) — apply บน local แล้ว (VPS ยังไม่)
- Phase 3: `sql/202609180430_answer_version.sql` (ตาราง answer_version +
  `_snapshot_version` + ah_save/ah_retire รุ่นเก็บประวัติ + ah_versions) — apply บน local ผ่าน
  (REVOKE/NOTIFY ครบ) · ORDER.txt append แล้ว · server.mjs เพิ่ม 'ah_versions' ใน AH_ACTIONS แล้ว ·
  `node --check` + `sql:check` ผ่านแล้ว · selftest 6/6 ผ่าน (แก้ role-switch 5 จุดแล้ว) —
  **ปิด Phase แล้ว 2026-09-18**
- Phase 4: `sql/202609180530_source_registry.sql` (ตาราง source_registry + seed 10 แหล่ง
  = 7 active / 3 placeholder inactive + src_* 9 ฟังก์ชันอ่าน ERP จริง + src_check_allowed +
  ah_source_list/save) — apply local ผ่าน (idempotent พิสูจน์แล้ว) · ORDER.txt append แล้ว ·
  server.mjs AH_ACTIONS ครบ 8 · selftest T11.1–T11.11 ผ่าน · ตรวจ catalog จริงครบ ·
  docs 5 ไฟล์อัปเดต (DATABASE/ARCHITECTURE/API/SECURITY/TROUBLESHOOTING) —
  **ปิด Phase แล้ว 2026-09-18** · รายละเอียด schema จริงที่ต่างจากออกแบบไว้ดู DATABASE.md
  (promotions/project_facts.project_id เป็น varchar · unit.price NOT NULL · status 'ACTIVE' ใหญ่ ·
  unit_status enum)
- Phase 5: `sql/202609180630_answer_binding.sql` (ตาราง answer_data_binding + dispatcher
  `src_resolve` CASE ตายตัว + ah_resolve/ah_binding_save/list/delete + ah_get คืน
  `{item, versions, bindings}`) — apply local ผ่าน · `services/answer-hub/render.mjs`
  (zero-dep) + unit test 10 ข้อ (อยู่ใน npm test chain แล้ว) · selftest T09/T10 ผ่าน ·
  AH_ACTIONS ครบ 12 · รายละเอียด source_field สองหน้าที่ + ลำดับค้นกุญแจดู DATABASE.md §7 —
  **ปิด Phase แล้ว 2026-09-18**
- Phase 6: `services/answer-hub/service.mjs` (ชั้นบริการกลาง — handle() รับ action
  AH_ACTIONS ทั้งหมดจาก server.mjs · flags 5 ตัว default ปิด · error model ANSWER_* ·
  resolve ต่อยอด Phase 5 เท่านั้น · boundary NOT_AVAILABLE_YET ไม่ fake) + SQL
  `202609180730_answer_service.sql` (ah_list filter/search ขยาย) +
  `202609180740_resolve_sources.sql` (detail ใส่ source_code + sources) + unit tests
  21 ข้อ + selftest service — **ปิด Phase แล้ว 2026-09-18** · แก้ Dockerfile เพิ่ม
  COPY services/ (test ของ bots.test.mjs จับ — container จะขึ้นไม่ได้ถ้าลืม)

## In Progress
(ไม่มี — งานจบสะอาดรอบนี้)

## Remaining
- Phase 7 — QR Integration: ตาราง `quick_reply_link` (ผูก answer_item ↔ quick_reply ของ
  asher-web — ไม่แตะ asher-web เด็ดขาด) + bootstrap ยังส่ง QR เดิมได้ 100% · legacy QR
  ไม่มี link ใช้ได้เหมือนเดิม · เทสต์ T18 legacy QR ต้องเหมือนเดิมทุก field
- Phase 8–30 (ดู PHASE-STATUS.md)

## Blockers
- การ apply migration ลง VPS production ต้องใช้ DATABASE_URL/connection string จากผู้ดูแล — local dev DB (docker supabase-db) ใช้ตรวจ selftest ได้เอง ไม่ block การพัฒนา
- local dev DB ยังไม่มีไฟล์ 016–037 + health (ยังไม่มี inbox.settings / flow_event / sql_applied) — ถ้า Phase ไหนต้องใช้ ต้อง apply ชุดนั้นก่อนหรือออกแบบให้ไม่พึ่ง

## Important Architecture Decisions
1. ใช้ role จริงของระบบ: `sales, senior_sales, manager, admin` (+ service_role สำหรับบอท/worker) — **ไม่มี role "supervisor"** ตามที่ spec วางไว้ (AUDIT §3)
2. RPC ใหม่ทั้งหมดชื่อ `inbox.ah_*` + whitelist AH_ACTIONS ใน server.mjs — **ไม่แตะ `connect_private.api`/`worker`** (incident 032)
3. Quick Reply เป็นของ repo `asher-web` — hub ผูกผ่าน `answer_hub.quick_reply_link` **ไม่ ALTER inbox.quick_reply** (ADR-005)
4. Migration ไฟล์ใหม่ `YYYYMMDDHHMM_*.sql` ต่อท้าย ORDER.txt idempotent เสมอ — ห้ามแก้/rerun ไฟล์เก่า
5. Bot path: `ah_bot_recommend` (service_role เท่านั้น) → ไม่ผ่านตัวกรอง = fallback Claude เดิม (ADR-002)
6. Learning: fire-and-forget + flag ปิด default — ห้ามพัง inbound, ห้าม auto-approve (ADR-003)
7. ERP จริง: core.project / inventory.unit(price,status) / public.promotions / public.project_facts — อีก 6 source เป็น placeholder inactive

## Database Objects Created
(บน local dev DB — ยังไม่รวม VPS)
- schema `answer_hub` (revoke schema จาก public/anon/authenticated)
- ฟังก์ชัน `answer_hub.touch_updated_at()` + trigger ครบทุกตารางที่มี updated_at (7 ตาราง),
  `answer_hub._fail(p_code)`,
  `answer_hub._snapshot_version(p_item, p_changed_by, p_reason)` (Phase 3)
- ตาราง `answer_hub.answer_category` (seed 10), `answer_hub.intent` (seed 10),
  `answer_hub.question_pattern` (ว่าง), `answer_hub.answer_item` (Phase 2),
  `answer_hub.answer_version` (Phase 3, unique (answer_item_id, version_no)),
  `answer_hub.source_registry` (Phase 4, seed 10 = 7 active/3 inactive),
  `answer_hub.answer_data_binding` (Phase 5, unique (answer_item_id, variable_name))
- ตัวอ่าน ERP (Phase 4): `answer_hub.src_project_profile/price/available_units/current_promotion/
  project_fact/appointment_slots/lead_profile/lead_followup` + `src_check_allowed` —
  คืน {"status":"ok|missing|invalid"} · ประตู `inbox.ah_source_list` (manager+) /
  `ah_source_save` (admin)
- ดัชนี: question_pattern_intent/text_idx, answer_item_status/project/category/intent_idx,
  answer_version_item_idx
- ประตู RPC (inbox): `ah_list, ah_get, ah_save, ah_approve, ah_retire` (Phase 2) ·
  `ah_save`/`ah_retire` รุ่นเก็บประวัติ + `ah_versions` (Phase 3) — grant authenticated,
  role gate ข้างใน

## Files Changed
- `sql/ORDER.txt` (append ×7 — Phase 1, 2, 3, 4, 5, 6×2)
- `server.mjs` (AH_ACTIONS ครบ 12 + import/wire `answerHub.handle()` — safeCodes
  ยังเป็น +6 จาก Phase 2 เพราะ hub คืน code ผ่าน error model ของ service)
- `package.json` (test chain เพิ่ม render + service tests)
- `Dockerfile` (เพิ่ม COPY services/ — Phase 6; ไฟล์นี้ของ session คู่ขนาน แก้แบบ
  additive 1 ก้อนตามที่ bots.test.mjs บังคับ)
- `docs/answer-hub/*` (DATABASE/ARCHITECTURE/API/SECURITY/TROUBLESHOOTING/TESTING —
  อัปเดตตามของจริงทุก Phase)

## Files Created
- `services/answer-hub/service.mjs`, `tests/answer-hub.service.test.mjs`,
  `sql/202609180730_answer_service.sql`, `sql/202609180740_resolve_sources.sql`,
  `sql/_selftest/ah_answer_service_selftest.sql` (Phase 6)
- `sql/202609180630_answer_binding.sql`, `sql/_selftest/ah_answer_binding_selftest.sql`,
  `services/answer-hub/render.mjs`, `tests/answer-hub.render.test.mjs` (Phase 5)
- `sql/202609180530_source_registry.sql`, `sql/_selftest/ah_source_registry_selftest.sql` (Phase 4)
- `sql/202609172100_answer_hub_foundation.sql`, `sql/_selftest/ah_foundation_selftest.sql` (Phase 1)
- `sql/202609172145_answer_item.sql`, `sql/_selftest/ah_answer_item_selftest.sql` (Phase 2)
- `sql/202609180430_answer_version.sql`, `sql/_selftest/ah_answer_version_selftest.sql` (Phase 3)
- `docs/answer-hub/`: README, AUDIT, ROADMAP, PHASE-STATUS, HANDOFF, ARCHITECTURE, DATABASE, API, SECURITY, TESTING, DEPLOYMENT, ROLLBACK, TROUBLESHOOTING, CHANGELOG, ADMIN-GUIDE, SALES-GUIDE, BOT-GUIDE, IMPORT-GUIDE, LEARNING-GUIDE, adr/ADR-001..005 (Phase 0)

## APIs
ดู `API.md` (ออกแบบไว้แล้ว — ยังไม่ implement)

## RPC
ดู `DATABASE.md` §RPC (ออกแบบไว้แล้ว — ยังไม่ implement)

## Environment Variables (ที่ hub จะใช้เพิ่ม — Phase 6/29)
`ANSWER_HUB_ENABLED, ANSWER_HUB_LEARNING_ENABLED, ANSWER_HUB_BOT_ENABLED, ANSWER_HUB_IMPORT_ENABLED, ANSWER_HUB_DYNAMIC_DATA_ENABLED` (default ปิดทั้งหมด)

## Commands
- `npm run check` — syntax ทุกไฟล์หลัก + sql:check (ทำก่อนจบทุก Phase)
- `npm test` — ชุดเดิมของ repo (baseline บน local = ผ่าน 47 / ล้ม 14 — 14 ข้อล้มเป็นของเดิม
  เพราะ local DB ยังไม่มีไฟล์ 016+ พิสูจน์ด้วย A/B แล้ว)
- Migration บน local dev DB (ไม่มี ledger บน local — apply ตรงด้วย psql ได้เฉพาะไฟล์ใหม่ของ hub):
  `MSYS_NO_PATHCONV=1 docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < sql/<ไฟล์>.sql`
- Selftest บน local dev DB:
  `MSYS_NO_PATHCONV=1 docker exec -i -e PGOPTIONS='-c asher.allow_db_tests=1' supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < sql/_selftest/<ไฟล์>.sql`
- บน VPS (ห้ามใช้วิธี docker ข้างบน): `npm run sql:plan -- --db "<conn>"` ก่อน แล้ว `sql:apply --db "<conn>"`
  — conn string ต้องขอจากผู้ดูแล

## Tests Run
- Phase 1: selftest 6/6 ผ่าน · Phase 2: selftest 9/9 ผ่าน (impersonate JWT sales/manager/admin)
- Phase 3: selftest ผ่าน 6/6 (แก้ role-switch 5 จุด — ครอบ SELECT ตารางตรง ๆ ด้วย
  `execute 'reset role'` … `execute 'set local role authenticated'`)
- Phase 4: selftest `ah_source_registry_selftest.sql` ผ่านครบ (T11.1–T11.11) · apply migration
  ผ่าน (รันซ้ำพิสูจน์ idempotent) · ตรวจ catalog จริง: constraint/index ครบ · ทุก src_* +
  ah_source_* มี `search_path=''` จริง (proconfig) · authenticated เรียกประตูได้/anon+service_role
  ถูกกัน · authenticated ไม่มีสิทธิ์ select ตารางตรง · seed = 7 active/3 inactive/บอทปิดหมด ·
  `node --check` + `npm run check` ผ่าน
- Phase 5: selftest `ah_answer_binding_selftest.sql` ผ่าน (T09/T10 + dispatcher + สิทธิ์) ·
  render unit test 10/10 · selftest ย้อนหลัง Phase 1–4 รันซ้ำผ่านหมด (regression ฝั่งฐาน)
- Phase 6: unit `tests/answer-hub.service.test.mjs` 21/21 (S01–S17 + flags + boundary) ·
  selftest `ah_answer_service_selftest.sql` ผ่าน (S07/S08/S09/S18 + filter ใหม่ + สิทธิ์
  sales ถูกบังคับ approved ตามเดิม) · selftest hub ครบ 6 ไฟล์รันซ้ำผ่านหมด
- `npm test` ตอนปิด Phase 6 = **ผ่าน 277 / ล้ม 0** (unit 209 + integration 68/68, exit 0) ·
  baseline เดินหน้าตาม Phase: 256 (จบ Phase 5) → 277 (+21 service)

## Test Results
Phase 0–6 PASS

## Known Issues
1. `GET /health` ไม่มี auth + `/api/health/login` คืน token ให้ browser (ของเดิม) — hub ห้ามเพิ่มข้อมูลลง endpoint เหล่านี้
2. `qr_list` filter active เสมอ — admin เห็นแถวปิดไม่ได้ (ของ asher-web — รายงานไว้ ไม่แก้ข้าม repo)
3. repo มีไฟล์ `*.bak-*`, `.env.bak*`, `channels_*.json` กระจาย — hygiene risk (แจ้งผู้ใช้แล้วใน AUDIT §8)
4. local dev DB ล้าหลัง VPS (ไฟล์ 016+) — ดู Blockers
5. มี session อื่นแก้ repo คู่ขนาน ("Admin System Status"/health: `202609172130_system_status.sql`,
   server.mjs, tests/http.integration.mjs, Dockerfile ฯลฯ) — ก่อนแก้ไฟล์ใดต้อง re-read ก่อนเสมอ
   อย่าเขียนทับของเขา (จุดค้าง Phase 3 เดิม — แก้ปิดแล้ว ไม่ใช่ Known Issue อีกต่อไป)

## Safe Next Step
**SAFE NEXT COMMAND:**

Start Answer Knowledge Hub Phase 7 (QR Integration) — Phase 0–6 ปิดหมดแล้ว.
อ่านก่อน: docs/answer-hub/AUDIT.md §4.1 (Quick Reply objects จริง — อยู่ repo asher-web),
ARCHITECTURE.md (QR Integration section), adr/ADR-005 (link table ไม่ ALTER inbox.quick_reply),
DATABASE.md หัวข้อ Quick Reply Integration แล้วค่อยแตะโค้ด.

ขั้นตอน: สร้าง `answer_hub.quick_reply_link` (quick_reply_id PK/FK → inbox.quick_reply,
answer_item_id, sync_mode, category_code — ไม่แตะ inbox.quick_reply และไม่แตะ repo asher-web
เด็ดขาด) → migration ใหม่ idempotent + append ORDER.txt → selftest เน้น T18: legacy QR
(ไม่มี link) ต้องเหมือนเดิมทุก field → `npm run check` + `npm test` (baseline ปัจจุบัน
277/0) → selftest hub ครบ 7 → อัปเดต ROADMAP/PHASE-STATUS/HANDOFF/CHANGELOG ปิด Phase.
ข้อควรระวัง: มี agent อื่นแก้ repo คู่ขนาน (health — เตรียม deploy VPS ตาม
docs/handoff/2026-09-18-deploy-health-ah3.md และห้าม sql:apply เต็มชุด) — re-read ทุกไฟล์
ก่อนแก้ทุกครั้ง และห้ามแตะไฟล์ของเขา (202609172130_system_status.sql, ส่วน health ของ
server.mjs, tests/http.integration.mjs, deploy scripts).

## Do Not Touch
- `connect_private.api` / `connect_private.worker` (ห้าม emit ซ้ำ)
- ไฟล์ migration เก่าทุกไฟล์ใน sql/001–037 + 202609172025_health.sql
- `inbox.quick_reply` และวงในของ asher-web (แก้ผ่าน link table เท่านั้น)
- `.env`, `channels.json`, โฟลเดอร์ `.sessions`, `.secrets-archive` (secret ทั้งหมด)
- `git reset --hard` / `git checkout -- .` / `git clean -fd` (กฎข้อ 2 ของ Master Command)

## Rollback Point
- Phase 1–6 = additive ต่อของเดิมทั้งหมด (create-or-replace ทับเฉพาะฟังก์ชัน/ตารางของ hub เอง —
  ah_list/ah_get/ah_save/ah_retire/ah_resolve คือของ hub ตั้งแต่ Phase 2/5) — ย้อนได้ด้วย
  `drop schema answer_hub cascade` + 3 จุดใน repo:
  1) server.mjs: import service, ก้อน `const answerHub = ...`, บล็อก AH_ACTIONS dispatch
     (คืนเป็น `rpcDirect(token, input.action, { p_data: input.data })` ตามเดิม)
  2) AH_ACTIONS Set: ล้างชื่อ ah_* ทั้งหมด (หรือทิ้งไว้ก็ไม่พัง เพราะ schema หายไปแล้ว RPC
     คืน error — แต่ควรล้าง)
  3) Dockerfile: ลบบรรทัด `COPY --chown=node:node services ./services` ด้วย — COPY
     โฟลเดอร์ที่ไม่มีอยู่จะทำ build พังตั้งแต่ขั้น build
  flags ปิดอยู่แล้ว default — ตัดทุกจุดข้างบนแล้วระบบเดิม (messaging/QR/health) ไม่กระทบ

## Last Updated
2026-09-18 — Phase 6 ปิดแล้ว (Answer Service · npm test 277/0 · selftest ครบ 6) · ตัวถัดไป Phase 7 QR Integration
