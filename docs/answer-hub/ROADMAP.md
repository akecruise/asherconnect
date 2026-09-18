# ROADMAP — Answer Knowledge Hub

สถานะย่อ: `[ ]` Not Started · `[~]` In Progress · `[x]` Complete · `[!]` Blocked
อัปเดตทุกครั้งหลังจบ Phase คู่กับ `PHASE-STATUS.md`, `HANDOFF.md`, `CHANGELOG.md`

---

## Phase 0 — Discovery & Audit
Status: **COMPLETE**

- Objective: เข้าใจระบบเดิมก่อนแก้โค้ด — ห้ามเดา
- Scope: Quick Reply / composer / send flow / inbound / bot / auth / roles / DB / worker / health / migration
- Tasks: [x] อ่าน server.mjs/auth/providers ทั้งหมด [x] อ่าน sql/ ทุกไฟล์ + asher-web QR migration
  [x] ตรวจ live DB catalog (PostgREST OpenAPI + psql) [x] เขียน AUDIT.md
- Files: `docs/answer-hub/AUDIT.md`, README, ROADMAP, PHASE-STATUS, HANDOFF, ARCHITECTURE, DATABASE, API, ADR 001–005
- Database changes: ไม่มี (audit เท่านั้น)
- Tests: ไม่มี (probe แบบอ่านอย่างเดียว: qr_list → 200 [], health_ping/queue_counts → 404 = ยังไม่ apply local)
- Dependencies: ไม่มี
- Risks: local dev DB ล้าหลังไฟล์ 016+ — ดู AUDIT.md §8
- Acceptance: ทุก object ที่ Master Command ถามถึงถูกยืนยันชื่อจริงแล้ว
- Definition of Done: AUDIT.md ครบ §1–10 — **PASS**
- Actual Result: QR objects มีจริง (repo asher-web) · ERP มีของจริง 4 แหล่ง · knowledge/learning ไม่มี = greenfield

## Phase 1 — Database Foundation
Status: **COMPLETE**

- Objective: schema `answer_hub` + answer_category + intent + question_pattern + seed
- Scope: migration ไฟล์ใหม่ 1 ไฟล์ ต่อท้าย ORDER.txt; ห้ามแตะตารางเดิม
- Tasks: [x] ไฟล์ `202609172100_answer_hub_foundation.sql` [x] trigger touch_updated_at
  [x] RLS+revoke [x] seed 10 หมวด + 10 intent [x] selftest SQL ใน sql/_selftest
- Files: `sql/202609172100_answer_hub_foundation.sql`, `sql/ORDER.txt` (append),
  `sql/_selftest/ah_foundation_selftest.sql`
- Database changes: schema answer_hub + 3 ตาราง + 3 trigger + 1 ดัชนี gin(to_tsvector) + seed 10+10
- Tests: selftest 6 ข้อ (seed ครบ / FK ครบ / unique ทำงาน / authenticated อ่านตรงไม่ได้ /
  updated_at เดิน / ดัชนีมีจริง) — รันบน local dev DB ผ่านทั้งหมด
- Dependencies: Phase 0
- Risks: (เคยกังวล local ไม่มี auth role — มีจริง ผ่าน) · apply บน VPS ยังรอผู้ดูแล
- Acceptance: `sql:check` ผ่าน, selftest ผ่าน, A/B test ยืนยัน integration suite ไม่เปลี่ยน (ล้ม 14 = เดิม)
- DoD: seed ครบ 10+10, RLS deny, updated_at ทำงาน — **PASS**
- Actual Result: PASS ทุกข้อ 2026-09-17

## Phase 2 — Answer Core
Status: **COMPLETE**

- Objective: ตาราง `answer_hub.answer_item` + RPC พื้นฐาน (ah_list/ah_get/ah_save/ah_approve/ah_retire)
- Tasks: [x] ตาราง + 4 ดัชนี [x] role gate ในฟังก์ชัน (core.current_user_role) [x] safeCodes ใหม่ 6 ตัว
  [x] AH_ACTIONS whitelist + dispatch ใน server.mjs
- Files: `sql/202609172145_answer_item.sql`, `sql/_selftest/ah_answer_item_selftest.sql`,
  `sql/ORDER.txt` (append), `server.mjs` (safeCodes + AH_ACTIONS + dispatch — 3 จุดเล็ก)
- Database changes: ตาราง answer_item + ดัชนี + ฟังก์ชัน inbox.ah_list/ah_get/ah_save/ah_approve/ah_retire
  + answer_hub._fail (grant execute ให้ authenticated, revoke จาก public/anon)
- Tests: selftest 9 เคส (impersonate JWT ต่อ role): sales สร้างไม่ได้ / manager สร้าง draft+submit review /
  manager อนุมัติไม่ได้ / admin อนุมัติ+approved_by / แก้ของ approved → กลับ review ล้างผู้อนุมัติ /
  retire แล้วห้ามแก้ / sales มองไม่เห็น draft / sales list เห็นแต่ approved / manager list สถานะตายตัวได้ — ผ่าน 9/9
- Dependencies: Phase 1
- Risks: (เคยพบ) `create trigger` ไม่ idempotent → แก้เป็น `create or replace trigger` ทั้ง Phase 1+2;
  update บางครั้งส่งแค่ body_template → validation แยก create/update แล้ว
- Acceptance: `npm run check` + sql:check ผ่าน · `npm test` = 47/14 เท่า baseline
- DoD: สิทธิ์ครบ 4 role ตาม AUDIT §3 — **PASS**
- Actual Result: PASS 2026-09-18 (บั๊กที่ selftest จับได้: ah_invalid ตอน update เฉพาะ body_template,
  aggregate+window ผสมใน ah_list — แก้แล้วทั้งหมด)

## Phase 3 — Version Control
Status: **COMPLETE** (ปิด 2026-09-18)

- Objective: `answer_version` + auto snapshot เมื่อแก้/ปลดใช้ของที่ approved + RPC ah_versions
- Tasks: [x] migration `202609180430_answer_version.sql` (ตาราง + `_snapshot_version` +
  ah_save/ah_retire รุ่นเก็บประวัติ + ah_versions) [x] apply บน local ผ่าน [x] append ORDER.txt
  [x] server.mjs เพิ่ม 'ah_versions' [x] node --check + sql:check ผ่าน
  [x] selftest แก้จุด role-switch แล้วรันผ่าน 6/6 (ครอบ SELECT ตารางตรง ๆ 5 จุดด้วย
      `execute 'reset role'` … `execute 'set local role authenticated'` แบบเดียวกับ
      ah_foundation_selftest)
  [x] ปิด Phase: npm run check ผ่าน + npm test 246 ผ่าน / 0 ล้ม + อัปเดต 4 ไฟล์ tracking
- Files: `sql/202609180430_answer_version.sql`, `sql/_selftest/ah_answer_version_selftest.sql`,
  `sql/ORDER.txt`, `server.mjs` (AH_ACTIONS)
- Database changes: ตาราง answer_version + ฟังก์ชัน `_snapshot_version` + ah_save/ah_retire
  create-or-replace ทับของ Phase 2 (ของ hub เอง — ออกแบบให้ยกรุ่นได้) + ah_versions
- Tests: T05 version history — เคส 6 ข้อเขียนไว้แล้วใน selftest (สร้าง→อนุมัติ→แก้=v1, แก้ตอน
  review ไม่เกิด version, รอบสอง=v2, ปลดใช้=v3, ลำดับ version_no, sales อ่านไม่ได้/manager อ่านได้)
- Dependencies: Phase 2
- Risks: ไม่มีระดับ schema — เหลือแค่บั๊กของตัว selftest เอง
- Acceptance: selftest ผ่าน + integration suite เท่า baseline
- DoD: แก้ของ approved ทุกครั้งต้องเกิด version พร้อม snapshot และอ่านย้อนได้ตามสิทธิ์

## Phase 4 — Source Registry
Status: **COMPLETE** (implement + เทสต์ + docs ครบ 2026-09-18 — tracking ปิดใน handoff เดียวกัน)

- Objective: `source_registry` + ฟังก์ชัน src_* ที่อ่าน ERP จริง + placeholder inactive
- Tasks: [x] migration `202609180530_source_registry.sql` (ตาราง + index active/bot_allowed/
  human_allowed + seed 10 แหล่ง = 7 active / 3 inactive + src_* 9 ฟังก์ชัน + src_check_allowed +
  ah_source_list/save) — apply local ผ่าน (รันซ้ำพิสูจน์ idempotent) [x] ORDER.txt append
  [x] server.mjs เพิ่ม 2 action ใน AH_ACTIONS [x] node --check + npm run check ผ่าน
  [x] selftest `ah_source_registry_selftest.sql` T11.1–T11.11 ผ่าน (rollback สะอาด)
  [x] ตรวจ catalog จริง (constraint/index/proconfig search_path=''/privilege/seed)
  [x] npm test 246 ผ่าน / 0 ล้ม = เท่าก่อนแตะ (T11.12 regression PASS)
  [x] docs 5 ไฟล์ (DATABASE/ARCHITECTURE/API/SECURITY/TROUBLESHOOTING)
- ERP จริงที่ map ได้: core.project, inventory.unit (price NOT NULL, status enum), public.promotions
  (project_id varchar, status 'ACTIVE' ใหญ่), public.project_facts (varchar, id bigint ไม่มี default)
  — facts ยังว่าง → missing ตามดีไซน์ · placeholder 3 แหล่ง inactive ไม่ fake data
- Dependencies: Phase 1 (ยึด map จาก AUDIT.md §4.3)

## Phase 5 — Data Binding
Status: **COMPLETE** (2026-09-18)
- Objective: `answer_data_binding` + `resolveAnswer(answerId, context)` + render.mjs
- Tasks: [x] migration `202609180630_answer_binding.sql` (ตาราง + src_resolve dispatcher
  CASE ตายตัว + ah_binding_save/list/delete + ah_resolve + ah_get คืน {item, versions,
  bindings}) — apply local ผ่าน [x] ORDER.txt append [x] server.mjs AH_ACTIONS ครบ 12
  [x] selftest T09/T10 ผ่าน (values ตรงฐานจริง · missing list ไม่เดา · fallback · กัน
  object หลุด · สิทธิ์ sales/manager/service_role) [x] render.mjs zero-dep + unit test 10 ข้อ
  [x] npm test 256 ผ่าน / 0 ล้ม + selftest ย้อนหลัง Phase 1–4 ผ่านหมด
  [x] docs DATABASE/API/ARCHITECTURE อัปเดต
- จุดที่ต่างจากออกแบบไว้ (จดใน DATABASE.md §7): source_field ทำสองหน้าที่ (fact_key +
  กุญแจใน value) — คนละค่าสำหรับ fact → ลำดับค้น source_field → text → num · แหล่ง array
  (CURRENT_PROMOTION) ใช้แถวแรกที่มีกุญแจ
- Tests: T09 binding success, T10 missing data → missing list ไม่เดา
- Dependencies: Phase 2, 4

## Phase 6 — Answer Service
Status: **COMPLETE** (2026-09-18)
- Objective: `services/answer-hub/service.mjs` ครบฟังก์ชันตาม Master Command + AH_ACTIONS whitelist + feature flags (default ปิดส่วนเสี่ยง)
- Tasks: [x] `services/answer-hub/service.mjs` (getAnswer/listAnswers/searchAnswers/
  resolveAnswer/botResolve/create-update-approve-retire passthrough + boundary
  NOT_AVAILABLE_YET สำหรับ recommend/usage/feedback — ไม่ fake) [x] flags 5 ตัว default ปิด
  (buildFlags env + hook override inbox.settings เมื่อพร้อม) [x] error model ANSWER_* map
  ที่เดียว ไม่หลุด raw error [x] ah_list ขยาย filter + search body (`202609180730`) [x]
  ah_resolve รายงาน sources (`202609180740`) [x] server.mjs เดินทาง handle() ทั้ง AH_ACTIONS
  [x] unit tests 21 ข้อ (S01–S17 ฝั่ง service) + selftest SQL `ah_answer_service_selftest`
  (S07/S08/S09/S18 + filter ใหม่ + สิทธิ์) [x] npm test 277 ผ่าน / 0 ล้ม + selftest ครบ 6
  [x] Dockerfile COPY services/ (test ของ bots.test.mjs จับได้) [x] docs 6 ไฟล์
- Tests: flag ปิด → action คืน disabled; unit tests ผ่าน node --test
- Dependencies: Phase 5

## Phase 7 — Quick Reply Integration
Status: NOT STARTED
- Objective: `quick_reply_link` + bootstrap ยังส่ง QR เดิมได้ 100% + link อ่านเพิ่มเมื่อมี
- กติกา: ไม่แตะ asher-web; legacy QR ไม่มี link ก็ใช้ได้เหมือนเดิม
- Tests: T18 legacy QR ต้องเหมือนเดิมทุก field
- Dependencies: Phase 2

## Phase 8 — Admin UI (โครง)
Status: NOT STARTED
- Objective: หน้า `answer-hub.html/js` เมนู Dashboard/คำตอบ/Import/Learning/หมวด/Intent/Sources/Versions/Usage/Feedback/Health + staticFiles + nav
- Dependencies: Phase 6

## Phase 9 — Add/Edit Answer Form
Status: **COMPLETE** (2026-09-18)
- Objective: form ครบ field ตาม Master Command + preview resolve + save draft/submit/approve/retire + bindings editor
- Dependencies: Phase 8

## Phase 10 — Import System
Status: **COMPLETE** (2026-09-18)
- Objective: parse xlsx/csv ฝั่ง Node (lib ใน repo, CSP-safe) → validate → preview → confirm → transaction import
- Tests: T12 valid, T13 invalid, T14 duplicate
- Dependencies: Phase 9

## Phase 11 — Learning System
Status: **COMPLETE** (2026-09-18)
- Objective: `learning_candidate` + hook fire-and-forget ที่ human reply + dedupe/score
- Tests: T15 create candidate/dedupe, worker-only capture, queue authorization, and non-blocking post-send hook.
- Dependencies: Phase 2; flag ANSWER_HUB_LEARNING_ENABLED

## Phase 12 — Learning Review UI
Status: **COMPLETE** (2026-09-18)
- Objective: Learning Queue + approve/edit_approve/merge/reject → สร้าง answer_item (bot_auto_answer=false เสมอ)
- Tests: T16 approve, T17 merge
- Dependencies: Phase 11

## Phase 13 — Quick Answer Sales UI
Status: NOT STARTED
- Objective: panel ใน composer: Search/Suggested/Categories/Recent/Frequent/Recommended + Preview/Edit/Send/Favorite/Submit/Report
- กติกา: send path เดิมไม่แตะ; hub พัง → panel ซ่อน composer ยังใช้ได้
- Tests: T19 Quick Answer new, T29 hub failure ไม่พัง composer
- Dependencies: Phase 6, 14 (recommended ใช้เวอร์ชันแรกของ 14 ได้)

## Phase 14 — Recommendation Engine
Status: NOT STARTED
- Objective: `recommendAnswers(question, context)` SQL-first: keyword+normalized+trgm (ถ้ามี ext)+fts+intent+category+project+priority+usage
- Tests: T20 search, T21 recommend
- Dependencies: Phase 2

## Phase 15 — Bot Integration
Status: NOT STARTED
- Objective: bot-bridge ใน job 'generate' — hub ก่อน Claude fallback; ตัวกรองบอทครบ 5 เงื่อนไข; ขาดข้อมูล → requires_human_review
- Tests: T07 bot-only, T08 bot_auto_answer false, T22 expired, T29/T30
- Dependencies: Phase 5, 14; flag ANSWER_HUB_BOT_ENABLED

## Phase 16 — Usage Analytics
Status: NOT STARTED
- Objective: `answer_usage` + recordUsage ที่ send path (post-success, fire-and-forget)
- Tests: T24 usage logging
- Dependencies: Phase 2

## Phase 17 — Feedback
Status: NOT STARTED
- Objective: `answer_feedback` + UI report incorrect + admin views (most used/edited/reported)
- Tests: T25 feedback logging
- Dependencies: Phase 16

## Phase 18 — Permissions (เช็คขวาง)
Status: NOT STARTED
- Objective: ตารางสิทธิ์จริงตาม role ระบบ (sales/senior_sales/manager/admin/service) ทดสอบขวางทุก RPC
- Tests: T06 human-only, T26 sales permission, T27 admin permission
- Dependencies: Phase 12

## Phase 19 — Security Review
Status: NOT STARTED
- Objective: checklist ตาม SECURITY.md — ไม่รั่ว service_role/token/secret; SQL injection (ผ่าน RPC parameter เท่านั้น); XSS (DOM API only); import injection; template injection
- Tests: T28 service-role not exposed
- Dependencies: Phase 10, 15

## Phase 20 — Health Check
Status: NOT STARTED
- Objective: ah_health() + section ใน /admin/health snapshot + flow_event stage ใหม่
- Dependencies: Phase 6

## Phase 21 — Logging
Status: NOT STARTED
- Objective: structured event ครบตาม Master Command (answer_created … human_answer_selected) ผ่าน log.info/health.log
- Dependencies: Phase 6–17

## Phase 22 — Automated Tests (รวมชุด)
Status: NOT STARTED
- Objective: T01–T30 เป็น node --test + selftest SQL; รวมใน npm test
- Dependencies: Phase 1–17

## Phase 23 — Manual Test Checklist
Status: NOT STARTED
- Objective: TESTING.md checklist 19 ข้อตาม Master Command
- Dependencies: Phase 22

## Phase 24 — Admin Dashboard
Status: NOT STARTED
- Objective: หน้า Dashboard ตัวเลขครบ 14 ช่อง (Total/Approved/Draft/Pending/Learning Pending/Bot Enabled/Human Only/Dynamic/Sources/Failed/Usage Today/Most Used/Edited/Reported)
- Dependencies: Phase 16–17

## Phase 25 — Documentation คู่มือครบ
Status: NOT STARTED
- Objective: ADMIN/SALES/BOT/IMPORT/LEARNING-GUIDE เนื้อหาเต็มตามการใช้จริง
- Dependencies: Phase 8–17

## Phase 26 — Deployment
Status: NOT STARTED
- Objective: DEPLOYMENT.md — backup, migration order, env, restart, smoke test บน VPS ตาม docs/deploy.md เดิม
- Dependencies: Phase 1–22

## Phase 27 — Rollback
Status: NOT STARTED
- Objective: ROLLBACK.md — DB rollback (แบบ idempotent-safe), code rollback, feature disable ทีละส่วนด้วย flag
- Dependencies: Phase 26, 29

## Phase 28 — Troubleshooting
Status: NOT STARTED
- Objective: TROUBLESHOOTING.md ครบ 11 อาการตาม Master Command
- Dependencies: Phase 23

## Phase 29 — Feature Flags (ยกมาทำตั้งแต่ Phase 6)
Status: NOT STARTED (ร่างตั้งแต่ Phase 6)
- Objective: flag 5 ตัว env + inbox.settings override — เปิด/ปิดทีละส่วนโดยไม่ deploy
- Dependencies: Phase 6

## Phase 30 — Final Acceptance
Status: NOT STARTED
- Objective: FINAL-REPORT.md + DoD checklist 19 ข้อ PASS ครบ
- Dependencies: ทุก Phase

---

## Blockers ปัจจุบัน
- (ไม่มีที่ block การเขียนโค้ด) ตัวที่ต้องมีคน/บัญชีจริง: apply migration บน VPS ต้องใช้ connection string จากผู้ดูแล (`sql:apply --db …`) — บันทึกไว้ใน HANDOFF ตอนถึง Phase 26

## Canonical MVP checkpoint override — 2026-09-18

Phase 30 local MVP acceptance is complete. See `FINAL-ACCEPTANCE-MATRIX.md` and the latest `HANDOFF.md`. Production deployment is not claimed: Phase 26 remains blocked until the DEPLOYMENT.md backup, release-artifact, migration-ledger, and controlled smoke-test prerequisites are satisfied.
