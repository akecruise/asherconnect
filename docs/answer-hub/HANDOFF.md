# HANDOFF — Answer Knowledge Hub

## Canonical execution state — 2026-09-18

The roadmap audit baseline is authoritative: Phase 0–12 are COMPLETE and Phase 13 is in progress. “Controlled-deploy Phase 8” is historical deployment evidence only; it is distinct from Roadmap Phase 8 (Admin UI). Earlier paused/STOP notes below are historical and superseded by this section.

## Phase 9

Status: COMPLETE

Implemented:
- Add/edit form with `answer_key`, sources, attachments, bindings, draft/review/approve/retire, preview and version history.
- Server/RPC authorization for editor options, reads and preview; no browser service-role credential.
- Atomic binding replacement and an approval-invalidating binding trigger.

Verification:
- `npm run check`: PASS
- Answer Hub service: 27/27 PASS
- Answer Hub SQL selftests: PASS
- Browser fixture: PASS
- HTTP integration: 79/79 PASS

Known limitation: Production deployment of the new migration remains deferred until Phase 26; local development schema has the editor RPCs.

Safe next step: Phase 10 Import System.

## Phase 10

Status: COMPLETE

Implemented:
- Dependency-free server-side CSV parser and row validation in `services/answer-hub/import.mjs`.
- Rejects malformed CSV, missing required fields, invalid enums, oversized files/row sets, and spreadsheet formula injection before any RPC.
- Added feature-gated service/server actions `ah_import_preview` and `ah_import_commit`.
- Tests T12/T13 currently cover valid parsing and invalid/injection rejection.

Completed after the initial parser work:
- Added `202609181000_answer_import.sql`, `answer_hub.import_batch`, admin-only preview/apply RPCs and audit metadata.
- Apply is one transaction and delegates every row to existing `inbox.ah_save`.
- Added XLSX parsing, import UI, SQL selftest, HTTP test #80 and browser fixture coverage.

Verification: local DB backup `/tmp/answer-hub-pre-phase10.dump`; migration/RPC catalog verified; SQL selftest PASS; parser tests 3/3 PASS; browser fixture PASS; HTTP integration 80/80 PASS; `npm run check` PASS.

Safe next step: Phase 11 Learning System.

## Phase 11

Status: COMPLETE

Implemented:
- `202609181100_learning.sql`: private candidate staging, dedupe/occurrence count, pending index, RLS/revokes and service-role-only capture RPC.
- Successful outbound deliveries invoke a feature-gated, fire-and-forget capture only after completion. Capture errors are logged and never affect delivery.
- `202609181110_learning_review.sql`: manager/admin queue and review actions. Approval delegates to `ah_save`, so lifecycle, validation, history and bot-auto-answer policy remain centralized.

Files changed:
- `server.mjs`, `services/answer-hub/service.mjs`, `public/answer-hub.js`
- `sql/202609181100_learning.sql`, `sql/202609181110_learning_review.sql`, `sql/_selftest/ah_learning_selftest.sql`, `sql/ORDER.txt`
- Answer Hub service, HTTP and browser tests.

Security:
- Worker RPC checks the JWT `role` claim instead of `current_user` under SECURITY DEFINER.
- Browser uses authenticated command calls only; table access stays denied by RLS/revoke.

Tests:
- targeted: learning SQL selftest PASS; service 28/28 PASS; browser fixture PASS; HTTP integration 81/81 PASS.
- regression: `npm run check` PASS. Full `npm test` remains the Phase 12 checkpoint.

Production: NOT DEPLOYED. Local backup: `/tmp/answer-hub-pre-phase11.dump`.

Rollback: disable `ANSWER_HUB_LEARNING_ENABLED`; rows remain private and review-only. Restore the local backup before removing schema objects if a development rollback is required.

Safe next step: Phase 12 Learning Review UI — finish edit/approve and merge flows, then run its full regression.

## Phase 12

Status: COMPLETE

Implemented:
- Manager/admin queue UI with refresh, approve, edit-and-approve, merge into the currently open answer, and reject actions.
- Server whitelist/service handlers and SQL role gates for list/review.
- Approval and merge both delegate to `ah_save`; approval produces a review-state answer and disables bot auto-answer.

Tests: SQL selftest covers approve and merge; browser fixture covers queue/reject; HTTP integration #81 verifies service-role capture, sales denial, and reviewed safe answer creation. `npm run check` and `npm test` passed locally.

Safe next step: Phase 13 Quick Answer Sales UI. Reuse the current composer and `public/quick-replies.js`; the Answer Hub must remain optional and never block send.

> อัปเดตก่อนหยุดงานทุกครั้ง — เปิดไฟล์นี้แล้วทำต่อได้ทันทีโดยไม่ต้องเดา

## Project
ASHER Connect — Answer Knowledge Hub (คลังคำตอบกลางสำหรับ Quick Answer / Bot / Admin / Learning / Import)

## Root Path
`D:\aplus_postgres_docker\asher-connect`

## Current Phase
PHASE 8 — COMPLETE (controlled deploy scope) (2026-09-18)

## Current Status

## Phase 9 — Current Work Snapshot (paused 2026-09-18)

**Status: PARTIAL / PAUSED BY USER. Do not resume automatically and do not start Phase 10.**

Phase 9 was inspected and implementation was started, then stopped before any migration, deploy, or test run for the new work. Phase 8 files were not reverted or rewritten.

### Work completed in this attempt

- Read the current HANDOFF, ROADMAP, PHASE-STATUS, Answer Hub schema/RPC/service code, existing UI shell, and existing tests.
- Added the additive migration draft `sql/202609180900_answer_edit.sql` and appended it to `sql/ORDER.txt`.
- The draft adds nullable `answer_hub.answer_item.answer_key`, a partial unique index, `answer_version.answer_key`, a replacement snapshot helper, and replacement `inbox.ah_save`/`inbox.ah_versions` functions with key validation, duplicate detection, draft/review behavior, and history capture.
- No Admin Add/Edit UI, bindings editor, preview endpoint, new tests, or service/server changes were completed. An attempted service/server patch was interrupted and is not present in the worktree.

### Exact changed/untracked files for Phase 9

- Modified: `sql/ORDER.txt` — appended the Phase 9 migration filename.
- Untracked: `sql/202609180900_answer_edit.sql` — migration draft described above.
- No Phase 9 test file was created or modified.
- Existing documentation changes and `PHASE8-CLOSEOUT.md`/`PHASE8-EVIDENCE.json` are Phase 8 closeout artifacts from the prior task; preserve them.

### Lifecycle and feature status

| Capability | Phase 9 status |
|---|---|
| Draft create | SQL draft exists in migration code; NOT APPLIED and NOT VERIFIED |
| Edit | SQL draft exists; NOT APPLIED and NOT VERIFIED |
| Preview | NOT IMPLEMENTED |
| Submit Review | SQL draft preserves the existing `submit` → `review` behavior; NOT APPLIED and NOT VERIFIED |
| Approve | Existing Phase 2/3 RPC remains available in code; Phase 9 integration NOT VERIFIED |
| Retire | Existing Phase 2/3 RPC remains available in code; Phase 9 integration NOT VERIFIED |
| Bindings | Existing Phase 5 RPC/schema inspected; no Phase 9 UI or new tests |
| Sources/attachments | Existing source registry inspected; no Phase 9 integration |
| Versions/history | Migration draft extends snapshot/version key support; NOT APPLIED and NOT VERIFIED |

### Verification state

- Last known baseline before the Phase 9 attempt: `npm run check` PASS and `npm test` **281/281 PASS, 0 FAIL** (209 unit + 72 HTTP integration).
- Those results predate `202609180900_answer_edit.sql`; no Phase 9 test result exists.
- `npm run check` after the Phase 9 migration draft: **NOT VERIFIED**.
- `npm test` after the Phase 9 migration draft: **NOT VERIFIED**.
- Answer Hub SQL selftests after the Phase 9 migration draft: **NOT RUN**.
- Browser verification: **NOT RUN**; browser automation was unavailable earlier. No customer data or credentials were used.

### Migration/deploy and production impact

- `202609180900_answer_edit.sql` was **not applied** to local or production databases.
- No migration was rerun. No deploy, container rebuild, restart, flag change, `.env` change, `channels.json` change, or secret change occurred during this Phase 9 attempt.
- Production remains on the Phase 8 deployed commit and state. The migration draft is a pending code change only.

### Risks/blockers

- The migration draft must be reviewed and syntax/selftested before any apply. It changes a security-definer RPC and version snapshot behavior.
- Production still excludes Phase 4+ Answer Hub RPCs under the Phase 8 deployment scope; do not assume the new editor can run against production.
- The existing service master flag is disabled by default; UI/API work must preserve that gate and server-side role checks.

### Safe resume order

1. Review the migration draft against the live/local schema and run `npm run check` (no apply).
2. Add focused SQL selftests for key validation, duplicate key, draft/review, version snapshot, and role denial; run the existing Answer Hub selftests without rerunning applied migrations.
3. Add the Answer Service preview action only if it uses `render.mjs`, then add unit tests.
4. Add the Admin Add/Edit UI under the existing authenticated shell, including bindings/source panels and loading/error/empty states; add HTTP tests for unauthorized access.
5. Run `npm run check`, `npm test`, and all Answer Hub selftests; record actual counts.
6. Only after explicit review decide whether to apply the new migration to a backed-up development database. Do not deploy from this snapshot.

Useful commands when resuming (review/check only; do not apply automatically):

```powershell
git status --short
git diff --stat
git diff -- sql/ORDER.txt sql/202609180900_answer_edit.sql
npm run check
npm test
```

**STOP. Phase 9 is paused. Do not start Phase 10.**

## Phase 8 closeout review — 2026-09-18 09:40 +07:00

Deployment verification is PASS within the original controlled-deploy scope. Phase 8 is COMPLETE for that scope. The live-client Answer Hub RPC check is explicitly deferred to the next authorized task; this does not activate the Hub or extend the deployment scope. See [PHASE8-CLOSEOUT.md](PHASE8-CLOSEOUT.md) and [PHASE8-EVIDENCE.json](PHASE8-EVIDENCE.json).

Latest verification: `npm run check` exit 0; `npm test` 281/281 (209 unit + 72 HTTP integration), 0 failures; unchanged deployed code; migration ledger/file hashes match 5/5; category/intent seeds 10/10; internal and public protected endpoints return 401 without a session; all flags false. Production selftests at 09:36:06 and 09:38:16 record only Telegram failing; both Telegram config values are absent, an explicit planned skip in the original deploy rule 10. Stored selftest `ok` remains false. No fatal-pattern logs in the observed 15-minute window.

Scope decision: six missing Phase 4+ RPCs and the live-client RPC check are explicitly deferred to the next authorized task. They do not justify extra migrations in this task. UI evidence is user-reported; automation remains unavailable. No credential/session-store access occurred.

Next action: preserve the deployed state and schedule the deferred RPC verification as a separate authorized task. No additional deployment, migration, flag activation, or later-phase work is authorized by this note. STOP. DO NOT START PHASE 9.


## Manual UI evidence — 2026-09-18 09:32:20 +07:00

User supplied text from /admin/health: HEALTHY; uptime 43 minutes; version 2026.09.18-health-ah3; shadow OFF (live sending); database healthy at 5 ms; LINE and Messenger healthy; inbound/outbound workers healthy; Pending 0, Processing 0, Failed 0; webhook signature failures 0 in 10 minutes. The user-reported UI smoke check passes for these displayed fields. Browser automation remains unavailable; account role, full check details, Answer Hub panel and live-client RPC execution were not independently verified. Telegram rule labels do not establish successful alert delivery.

This evidence supersedes earlier statements that no UI evidence was available. The controlled-deploy Phase 8 scope is complete; real-client RPC checks and the deferred Phase 4+ production RPC scope are explicitly carried forward to the next authorized task. Retain disabled flags and existing deployment scope. STOP. DO NOT START PHASE 9.

## Historical Phase 8 verification — 2026-09-18 09:26 +07:00

Historical status before the user's explicit deferral decision. The controlled-deploy Phase 8 is now COMPLETE within its original scope; this is not roadmap Phase 8 (Admin UI).

- Live SSH checks: deployed commit `97d1b6362cc4ab2db6225c7d3b5531b829fec992`; container healthy, restart count 0; `/healthz` and `/health` successful, database latency 4 ms, workers/channels healthy.
- `.env` SHA256 remains `da2e57fe4756cf7d838732dbead59de3cd2f342d10148eaf2ca77171a3530b4d`.
- `channels.json` SHA256 remains `a47299bc2b0783cfb746478ed1f86d72e921114115ec95898b017d9ce28e6ce8`.
- Backup `/opt/asher-inbox/backup-pre-phase8-20260918-014105.tar.gz`: 2,813,387 bytes; full `tar -tzf` succeeded. This verifies archive readability, not database restore readiness.
- Runtime flags: master/dynamic/bot/learning/import all false. Isolated runtime service probe `ah_list` returned `HUB_DISABLED`, with zero RPC calls. This is NOT an authenticated HTTP or PostgREST test.
- Production catalog read-only query succeeded (exit 0): `ah_list`, `ah_get`, `ah_save`, `ah_approve`, `ah_retire`, `ah_versions` present; `health_can_view` present.
- Missing production action RPCs: `ah_source_list`, `ah_source_save`, `ah_resolve`, `ah_binding_list`, `ah_binding_save`, `ah_binding_delete`. Historical deployment scope explicitly excluded Phase 4+ migrations. Do not enable Hub or claim all actions verified.
- Browser unavailable: discovery returned no browsers, including retry after user reported ready. Authenticated `/admin/health` UI and real-client PostgREST checks remain unverified. No credentials or session tokens were extracted.
- An initial catalog command hit a Windows heredoc terminator error after the read-only transaction committed; the catalog query was repeated successfully with direct stdin. No database writes occurred.
- No redeploy, migration, configuration changes, or later-phase work performed.

Next safe action: perform the explicitly deferred real-client RPC check in a separate authorized task. Preserve disabled flags and the existing deployment scope. STOP. DO NOT START PHASE 9.

- **PHASE 8 — COMPLETE within controlled-deploy scope** (2026-09-18 09:00+07:00)
  1. **What was completed**:
     - Pre-deploy backup created on VPS at `/opt/asher-inbox/backup-pre-phase8-20260918-014105.tar.gz` (2.8MB).
     - Local clean Git commit `97d1b6362cc4ab2db6225c7d3b5531b829fec992` created containing all tested Phase 0-6 files + Dockerfile fix (`COPY services ./services`).
     - Archive `deploy-97d1b6362cc4ab2db6225c7d3b5531b829fec992.tar.gz` created directly from commit and uploaded to VPS.
     - Extract, docker compose build, and docker compose up -d executed on VPS (`187.53.139.175`).
  2. **What was verified**:
     - Pre-deploy backup verified readable on VPS (`tar -tzf ... | head -5`).
     - Upload integrity: 51/51 files matched `deploy-sha-local.txt` 100% OK on VPS; archive SHA256 matched bit-for-bit (`513c00e93d8bf78ef3ef083ce176a40a762bfa81acb33f4adb536fb9afa7ba51`).
     - Secret protection: `.env` and `channels.json` untouched (SHA256 verified identical before & after).
     - Container health: `asher-connect` running `Up (healthy)`, uptime verified, no restart loop.
     - `GET http://127.0.0.1:3200/healthz` verified returning HTTP 200 `{"ok":true,"uptime_s":...}`.
     - `GET http://127.0.0.1:3200/health` verified returning HTTP 200 (database healthy 4-5ms, workers healthy, queue healthy, channels healthy).
     - Container filesystem: `/app/services/answer-hub/service.mjs` (16636 bytes) and `render.mjs` (2560 bytes) present inside running container.
     - Live traffic: Container logs confirm active webhook acceptance (`webhook_accepted`) and processing (`webhook_processed`) on Messenger/LINE with 0 errors.
  3. **What is not yet verified**:
     - Authenticated `/admin/health` UI browser test with real admin login (cannot run headless without human session).
     - Individual Answer Hub action dispatch via live PostgREST RPC from client token (requires JWT login on production).
  4. **Current production state**:
     - Host: `root@187.53.139.175` (`/opt/asher-inbox/app`)
     - Container `asher-connect`: UP and Healthy.
     - Version in .env: `2026.09.18-health-ah3`.
     - Deployed commit recorded in `/opt/asher-inbox/app/.deployed-commit`: `97d1b6362cc4ab2db6225c7d3b5531b829fec992`.
  5. **Backup path**:
     `/opt/asher-inbox/backup-pre-phase8-20260918-014105.tar.gz` (size: 2,813,387 bytes).
  6. **Current deployment/integrity evidence**:
     - Local commit: `97d1b6362cc4ab2db6225c7d3b5531b829fec992`
     - Remote `.deployed-commit`: `97d1b6362cc4ab2db6225c7d3b5531b829fec992`
     - Local archive SHA256: `513c00e93d8bf78ef3ef083ce176a40a762bfa81acb33f4adb536fb9afa7ba51`
     - VPS archive SHA256: `513c00e93d8bf78ef3ef083ce176a40a762bfa81acb33f4adb536fb9afa7ba51` (match 100%)
  7. **.env and channels.json current hashes**:
     - `/opt/asher-inbox/app/.env`: `da2e57fe4756cf7d838732dbead59de3cd2f342d10148eaf2ca77171a3530b4d` (mtime=1789688724)
     - `/opt/asher-inbox/app/channels.json`: `a47299bc2b0783cfb746478ed1f86d72e921114115ec95898b017d9ce28e6ce8` (mtime=1789608065)
  8. **Container / Answer Hub / webhook evidence**:
     - `docker ps`: container `asher-connect` `Up (healthy)`
     - `docker exec asher-connect ls -la /app/services/answer-hub`: files present
     - `docker logs asher-connect --tail 25`: active webhook acceptance and processing with zero error/exception traces
  9. **Remaining Phase 8 checks**:
     - Manual UI check on `https://inbox.apluscondo.com/admin/health` by user with admin login.
     - Final sign-off recorded: controlled-deploy scope COMPLETE; live-client RPC verification deferred.
  10. **Exact safe resume instructions for the next agent**:
      - Do NOT deploy again unless requested. Current production image is running commit `97d1b63`.
      - Check container status: `ssh root@187.53.139.175 "docker ps --filter name=asher-connect && curl -s http://127.0.0.1:3200/healthz"`.
      - Mark COMPLETE only when required checks have passed or deferrals are explicitly accepted. Do not proceed to another phase.
  11. **Explicit instruction**:
      - **STOP. DO NOT START PHASE 9.**
- **Phase 6 COMPLETE** (2026-09-18) · Phase 0–6 = COMPLETE ทั้งหมด · regression ยืนยัน:
  npm test exit 0 · unit 209/209 · integration 72/72 · **รวม 281 PASS / 0 FAIL** ·
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
- Phase 8: Corrected controlled deploy to VPS (`187.53.139.175`) — **COMPLETE within controlled-deploy scope**:
  - Root cause resolved: Dockerfile updated with `COPY --chown=node:node services ./services`, and `services/` included in deploy packaging.
  - Pre-deploy backup: `/opt/asher-inbox/backup-pre-phase8-20260918-014105.tar.gz` (2.8MB).
  - Deployed commit: `97d1b6362cc4ab2db6225c7d3b5531b829fec992`.
  - Integrity check: 51/51 files SHA256 matched `deploy-sha-local.txt` 100% on VPS.
  - Secret protection: `.env` and `channels.json` SHA256 verified identical before and after deploy.
  - Production build: `docker compose build asher-connect` exited 0.
  - Production swap: `docker compose up -d asher-connect` completed cleanly.
  - Health checks: container `healthy`, `/healthz` 200, `/health` 200 (database, workers, channels healthy).
  - Runtime verified: `/app/services/answer-hub/` verified inside container and importable.
  - Live traffic: active processing of LINE & Messenger webhooks with 0 errors.

## In Progress
(ไม่มี — งานจบสะอาดรอบนี้)

## Remaining
- Phase 7 — QR Integration: ตาราง `quick_reply_link` (ผูก answer_item ↔ quick_reply ของ
  asher-web — ไม่แตะ asher-web เด็ดขาด) + bootstrap ยังส่ง QR เดิมได้ 100% · legacy QR
  ไม่มี link ใช้ได้เหมือนเดิม · เทสต์ T18 legacy QR ต้องเหมือนเดิมทุก field
- Phase 9–30 (ดู PHASE-STATUS.md)

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
Read PHASE8-CLOSEOUT.md. Complete or explicitly defer the outstanding real-client RPC check before marking overall Phase 8 COMPLETE. Missing Phase 4+ RPCs are planned deployment exclusions; do not apply their migrations in this closeout. Do not start Phase 7 or Phase 9.

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
2026-09-18 — Phase 8 COMPLETE within controlled-deploy scope (commit 97d1b63, container healthy, /healthz 200, backup verified); live-client RPC deferred to next authorized task · STOP. DO NOT START PHASE 9.

## MVP checkpoint — Phase 13–15 (2026-09-18)

Status: MVP READY (Phase 13, Phase 14, Phase 15)

Implemented:
- Sales composer picker uses approved human/both answers only, category search, editable drafts, local recent/favorites, and preserves Quick Replies/manual send when Hub fails.
- SQL-first recommendation uses keyword/FTS/trigram/project/priority signals and separates human from bot candidates.
- Bot worker selects only approved, bot-enabled static Hub candidates before Claude; errors/no candidates fall back to the existing Claude flow.

Database:
- Applied `202609181300_quick_answer.sql` and `202609181400_recommendation.sql` locally.

Tests:
- Phase 13 SQL selftest PASS; browser fixture PASS; HTTP targeted test executed with cleanup.
- Phase 14 SQL selftest PASS.
- Targeted bot/service tests: 51 PASS / 0 FAIL.

Production: NOT DEPLOYED.
Safe next step: Phase 16 Usage Analytics MVP.

## MVP checkpoint — Phase 16–17 (2026-09-18)

Status: MVP READY

Phase 16: usage is carried through the existing composer as `answer_id` and recorded only after a successful delivery result. Recording is fire-and-forget and cannot fail the customer-message path. Authenticated/browser direct calls are denied by the service-role-only RPC.

Phase 17: authenticated users can report an approved answer as incorrect/outdated/other. Reports are append-only, validated server-side, and exposed from the picker without changing send behavior.

Migrations applied locally:
- `202609181600_usage.sql`
- `202609181700_feedback.sql`

Verification:
- usage SQL selftest PASS
- feedback SQL selftest PASS
- `npm run check` PASS
- service targeted tests 29/29 PASS

Production: NOT DEPLOYED.
Safe next step: Phase 18 permissions MVP.

## MVP checkpoint — Phase 18–19 (2026-09-18)

Status: MVP READY

Phase 18 permissions: existing SQL role gates, RLS, RPC grants/revokes, and cross-role selftests were rerun. Human picker/feedback are authenticated; usage recording is service-only; bot paths remain server-side.

Phase 19 security: targeted scan found no service-role or Supabase secret references in browser assets. RPC inputs validate UUIDs and lengths; browser rendering uses text nodes; optional telemetry failure is isolated.

Verification:
- answer item/service/binding/quick-answer/usage/feedback SQL selftests PASS
- `git diff --check` PASS

Production: NOT DEPLOYED.
Safe next step: Phase 20 health MVP.

## MVP checkpoint — Phase 20 (2026-09-18)

Status: MVP READY

Added manager/admin-only `inbox.ah_health` summary RPC covering answer totals, lifecycle counts, learning pending, usage today, and feedback today. It is exposed through the existing Answer Hub service/action boundary and does not alter the existing `/health` flow.

Migration applied: `202609181800_health.sql`
Verification: `npm run check` PASS; prior Answer Hub SQL selftests PASS.
Production: NOT DEPLOYED.
Safe next step: Phase 21 logging MVP.

## MVP checkpoint — Phase 21–24 (2026-09-18)

Status: MVP READY

- Phase 21: existing structured `log.info` and `flowHealth.log` paths cover answer Hub bot selection, fallback, usage failure, learning capture, reply queue, and delivery outcomes.
- Phase 22: node Answer Hub tests and SQL selftests are present in the repository and targeted suites pass.
- Phase 23: `docs/answer-hub/TESTING.md` contains the manual 19-step checklist.
- Phase 24: manager/admin Answer Hub dashboard now calls secure `ah_health` and displays lifecycle, learning, usage, and feedback counters.

Verification: `npm run check` PASS; SQL selftests for answer item/service/binding/quick answer/usage/feedback PASS.
Production: NOT DEPLOYED.
Safe next step: Phase 25 documentation MVP, then deployment/rollback phases.

## MVP checkpoint — Phase 25–29 (2026-09-18)

Status: MVP READY (implementation/documentation scope); production deployment remains pending.

- Phase 25: admin, import, learning, bot, rollback, security, database, API, and troubleshooting guides exist and reflect the implemented boundaries.
- Phase 26: deployment prerequisites and migration order are documented in DEPLOYMENT.md; no production deployment was performed in this session.
- Phase 27: rollback controls use additive migrations and feature flags; ROLLBACK.md documents disabling Hub, bot, learning, import, and dynamic data independently.
- Phase 28: TROUBLESHOOTING.md covers Hub-disabled, RPC, source, import, learning, and bot fallback symptoms.
- Phase 29: five env feature flags and service-side gating are implemented; disabled states preserve legacy paths.

Verification: `npm run check` PASS; no production secrets changed. Production: NOT DEPLOYED.
Safe next step: Phase 30 MVP acceptance after final full regression and deployment decision.

## Phase 30 — Final MVP Acceptance (2026-09-18)

Status: COMPLETE — MVP READY (production deployment decision recorded separately)

Full regression:
- `npm run check`: PASS
- `npm test`: 220 Node tests PASS / 0 FAIL; HTTP integration 82/82 PASS / 0 FAIL
- Answer Hub SQL selftests: 13/13 PASS / 0 FAIL
- `git diff --check`: PASS

Acceptance matrix: `docs/answer-hub/FINAL-ACCEPTANCE-MATRIX.md`.

Production decision: NOT DEPLOYED. The current worktree has no reviewed release commit and no newly verified production backup/migration ledger for the Phase 9–24 additive migrations. DEPLOYMENT.md requires backup, migration plan, clean release artifact, controlled deploy, and post-deploy smoke checks. Forcing deployment would violate the production-safety prerequisite. Historical Phase 8 health evidence remains valid only for the old deployed commit and scope.

Production verification: historical Phase 8 `/healthz` and `/health` PASS; current Answer Hub MVP is local-only and not claimed live.

Known limitations: manual browser checklist, production migration/deploy, live RPC smoke, and live rollback proof remain pending. These are recorded in HARDENING-TODO.md and do not hide any local test failure.

Safe next step: obtain an approved release/deployment window, create and verify a production backup, run migration plan/apply in canonical order, deploy the reviewed artifact, and append live evidence.

Production read-only prerequisite check (2026-09-18): VPS `asher-connect` is `Up 8 hours (healthy)`, `/healthz` returned `{"ok":true}`, deployed commit remains `97d1b6362cc4ab2db6225c7d3b5531b829fec992`. This confirms the existing Phase 8 deployment only; it does not verify the new local migrations or Answer Hub actions in production.

## Production release gate (2026-09-18)

Release commit: `d793c7344c2cfbd0c42187d586ae5617235442ee` (`feat(answer-hub): complete MVP phases 1-30`).

Local evidence is complete: `npm run check` PASS, `npm test` 302/302 PASS (220 Node + 82 HTTP), and 13/13 SQL selftests PASS. A secret-pattern scan found no credential values in the staged Answer Hub files.

Deployment is BLOCKED before migration/deploy. Read-only production checks show the container healthy and `/healthz` HTTP 200, but production remains on `97d1b6362cc4ab2db6225c7d3b5531b829fec992`. The production `inbox.sql_applied` ledger currently contains only `_ledger.sql`, legacy/stat files, `202609172025_health.sql`, foundation/system/item/version; it does not contain the source, binding, service, answer-edit, import, learning, quick-answer, recommendation, usage, feedback, or health migrations from this release. The ledger therefore cannot safely distinguish unapplied migrations from historical catalog drift. The existing VPS archives are historical backups (`backup-pre-phase8-20260918-014105.tar.gz` and `backup-health-ah3-20260918.tar.gz`), not a newly verified pre-release database backup.

Per `DEPLOYMENT.md`, do not apply migrations or deploy until an operator creates and verifies a fresh database backup and reconciles the production ledger/catalog with the release migration plan. No production data, flags, secrets, or containers were changed in this release attempt.

Rollback point: production commit `97d1b6362cc4ab2db6225c7d3b5531b829fec992`; release commit remains available as `d793c7344c2cfbd0c42187d586ae5617235442ee`.
