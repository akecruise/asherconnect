# DEPLOYMENT — Answer Knowledge Hub (โครง — เต็มตาม Phase 26)

ยึด `docs/deploy.md` เดิมเป็นหลัก (VPS `root@187.53.139.175`, `/opt/asher-inbox/app`,
deploy จาก git commit เท่านั้น, ห้ามแตะ .env/channels.json/.sessions ฝั่ง VPS)

## Prerequisite
- [ ] ทุก Phase 1–25 เสร็จ + `npm run check` + `npm test` ผ่านบนเครื่อง dev
- [ ] local selftest ของ migration ผ่าน (docker supabase-db)

## ขั้นตอน (เรียงตาย)
1. **Backup DB** ก่อน migration ทุกครั้ง (pg_dump ผ่าน pooler)
2. **Migration** ก่อน code เสมอ: `node sql/run.mjs plan --db "<conn>"` → ตรวจรายชื่อไฟล์
   → `apply --db "<conn>"` (ห้ามข้าม plan)
3. Deploy code: จาก commit (git archive → scp → tar) บน dir ใหม่ → สลับ
4. `docker compose up -d` (เปลี่ยน env ต้อง up -d ไม่ใช่ restart)
5. Smoke test: `curl localhost:3200/health` = 200, login ได้, composer ปกติ, QR เดิมขึ้น
6. Health: /admin/health เขียว + ส่วน Answer Hub ขึ้น

## Environment variables (เพิ่ม — ค่าเริ่มปลอดภัย)
```
ANSWER_HUB_ENABLED=false            # เปิดหลัง smoke test ผ่าน
ANSWER_HUB_LEARNING_ENABLED=false
ANSWER_HUB_BOT_ENABLED=false        # เปิดเป็นส่วนสุดท้าย
ANSWER_HUB_IMPORT_ENABLED=false
ANSWER_HUB_DYNAMIC_DATA_ENABLED=false
```

## Rollback
ดู ROLLBACK.md — สลับ dir กลับ + ปิด flag ได้โดยไม่ต้องย้อน DB (migration ของ hub
สร้างของใหม่ล้วน ไม่แก้ของเดิม จึงปล่อยไว้ได้ปลอดภัย)

---

## Deployment Log

### MVP rollout gate — schema conflict (2026-09-18)

- Fresh backup: `/opt/asher-inbox/backup-pre-answer-hub-20260918T174500Z.dump`, 1,825,337 bytes, SHA-256 `b650b978d8ff65acaf95ec782b4ec3c8fb37dec32b85a339e09b60749cac837e`, CUSTOM archive verified with PostgreSQL 17 `pg_restore`.
- Release commit: `d793c7344c2cfbd0c42187d586ae5617235442ee`.
- Migration attempt: `202609180530_source_registry.sql` only, canonical first release migration, transaction rolled back.
- Blocker: production lacks `public.promotions` and `public.project_facts`, required by the migration. No guessed schema was created.
- Result: NOT DEPLOYED; production remains on `97d1b6362cc4ab2db6225c7d3b5531b829fec992`.

### Phase 8 — Corrected Controlled Deploy (2026-09-18 09:00+07:00)
- **Status**: COMPLETE within original controlled-deploy scope
- **Deployed Commit**: `97d1b6362cc4ab2db6225c7d3b5531b829fec992`
- **Archive SHA256**: `513c00e93d8bf78ef3ef083ce176a40a762bfa81acb33f4adb536fb9afa7ba51` (`deploy-97d1b6362cc4ab2db6225c7d3b5531b829fec992.tar.gz`)
- **Transfer Integrity**: 51/51 files verified 100% against `deploy-sha-local.txt` on VPS (`187.53.139.175`).
- **Config & Secret Integrity**:
  - `/opt/asher-inbox/app/.env` SHA256 `da2e57fe4756cf7d838732dbead59de3cd2f342d10148eaf2ca77171a3530b4d` (untouched)
  - `/opt/asher-inbox/app/channels.json` SHA256 `a47299bc2b0783cfb746478ed1f86d72e921114115ec95898b017d9ce28e6ce8` (untouched)
- **Pre-deploy Backup**: `/opt/asher-inbox/backup-pre-phase8-20260918-014105.tar.gz` (2.8MB, readable and verified).
- **Build**: `docker compose build asher-connect` (node:22-alpine, image `app-asher-connect:latest` built with `COPY --chown=node:node services ./services`).
- **Container**: `docker compose up -d asher-connect` -> `Up (healthy)`.
- **Verified Checks**:
  - `GET http://127.0.0.1:3200/healthz` -> HTTP 200 `{"ok":true,"uptime_s":...}`
  - `GET http://127.0.0.1:3200/health` -> HTTP 200 (database healthy 4-5ms, workers healthy, queue healthy, channels healthy).
  - Runtime: `/app/services/answer-hub/service.mjs` and `render.mjs` present in container and loaded without error.
  - Logs: `ASHER Connect listening on 3200; 2 active channel(s) · ล็อกอินรายบุคคล` with active live webhook acceptance and processing. Zero fatal/unhandled errors.
- **Deferred by explicit scope decision**:
  - Live client token invocation of Answer Hub actions via PostgREST RPC; perform in the next authorized task.
  - Phase 4+ Answer Hub migrations and their six RPCs remain excluded from this deployment.
- **Action**: STOP. DO NOT START PHASE 9.


## Historical Phase 8 verification — 2026-09-18 09:26 +07:00

Historical status before the explicit deferral decision. Controlled-deploy Phase 8 is now COMPLETE within its original scope; this is not roadmap Phase 8 (Admin UI).

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

## Manual UI evidence — 2026-09-18 09:32:20 +07:00

User supplied text from /admin/health: HEALTHY; uptime 43 minutes; version 2026.09.18-health-ah3; shadow OFF (live sending); database healthy at 5 ms; LINE and Messenger healthy; inbound/outbound workers healthy; Pending 0, Processing 0, Failed 0; webhook signature failures 0 in 10 minutes. The user-reported UI smoke check passes for these displayed fields. Browser automation remains unavailable; account role, full check details, Answer Hub panel and live-client RPC execution were not independently verified. Telegram rule labels do not establish successful alert delivery.

This evidence supersedes earlier statements that no UI evidence was available. Controlled-deploy Phase 8 is complete; real-client RPC checks and the deferred Phase 4+ production RPC scope are carried forward to the next authorized task. Retain disabled flags and existing deployment scope. STOP. DO NOT START PHASE 9.

## Phase 8 closeout review — 2026-09-18 09:40 +07:00

Deployment verification is PASS within the original controlled-deploy scope. Phase 8 is COMPLETE for that scope; the live-client Answer Hub RPC check is explicitly deferred to the next authorized task. See [PHASE8-CLOSEOUT.md](PHASE8-CLOSEOUT.md) and [PHASE8-EVIDENCE.json](PHASE8-EVIDENCE.json).

Latest verification: `npm run check` exit 0; `npm test` 281/281 (209 unit + 72 HTTP integration), 0 failures; unchanged deployed code; migration ledger/file hashes match 5/5; category/intent seeds 10/10; internal and public protected endpoints return 401 without a session; all flags false. Production selftests at 09:36:06 and 09:38:16 record only Telegram failing; both Telegram config values are absent, an explicit planned skip in the original deploy rule 10. Stored selftest `ok` remains false. No fatal-pattern logs in the observed 15-minute window.

Scope decision: six missing Phase 4+ RPCs and the real-client RPC check are explicitly deferred to the next authorized task. They do not justify extra migrations in this closeout. UI evidence is user-reported; automation remains unavailable. No credential/session-store access occurred.

Next action: perform the deferred real-client RPC check in a separate authorized task. No additional deployment or phase work is authorized by this note. STOP. DO NOT START PHASE 9.
