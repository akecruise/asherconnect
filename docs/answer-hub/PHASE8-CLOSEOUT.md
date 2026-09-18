# Phase 8 — Controlled Deploy Closeout Review

Date: 2026-09-18 (Asia/Bangkok). Latest automated production evidence: 09:40:07.

**Deployment verification: PASS within the original controlled-deploy scope.**
**Overall Phase 8: COMPLETE within the original controlled-deploy scope. The live-client Answer Hub RPC check is explicitly deferred to the next authorized task; it is not part of this closeout and does not activate the Hub.**

This is the controlled-deploy Phase 8 described in `docs/handoff/2026-09-18-deploy-health-ah3.md`, not roadmap Phase 8 (Admin UI). No roadmap phase advanced.

## Verified evidence

| Check | Result | Evidence and limits |
|---|---|---|
| Current local code | PASS | No code/config/test diff against deployed commit `97d1b6362cc4ab2db6225c7d3b5531b829fec992`; documentation changes only. |
| Local check | PASS | `npm run check` exit 0; existing duplicate numeric SQL-prefix warnings only. |
| Local regression | PASS | `npm test` exit 0: 209 unit tests + 72 HTTP integration tests = 281 passed, 0 failed. Local tests do not establish live-user production RPC behavior. |
| Upload / artifact | Previously verified | Handoff records archive SHA256 `513c00e93d8bf78ef3ef083ce176a40a762bfa81acb33f4adb536fb9afa7ba51` and 51/51 file matches. Not reuploaded in this session. |
| Deployed commit | PASS | Production `.deployed-commit` matches `97d1b6362cc4ab2db6225c7d3b5531b829fec992`. |
| Environment protection | PASS | `.env` SHA256 `da2e57fe4756cf7d838732dbead59de3cd2f342d10148eaf2ca77171a3530b4d`, unchanged from predeploy evidence. |
| Channels protection | PASS | `channels.json` SHA256 `a47299bc2b0783cfb746478ed1f86d72e921114115ec95898b017d9ce28e6ce8`, unchanged. |
| Migration 1–5 and registry | PASS | All five authorized files present in `inbox.sql_applied`; ledger hashes match deployed files 5/5. No migration rerun. |
| Docker build / start | Previously verified + live PASS | Original build/swap recorded in deployment log; current container running and healthy, started 08:49:05 +07:00; restart count 0 checked at 09:26. |
| Runtime packaging | PASS | Answer Hub service imported successfully inside the running container; all five feature flags false. |
| `/healthz` | PASS | Internal and public HTTPS endpoints HTTP 200, `ok:true`, at 09:40. |
| `/health` | PASS | Live SSH check at 09:24: healthy, database 4 ms, workers/channels healthy. |
| Admin System Health UI | USER-REPORTED PASS | User supplied page output at 09:32:20 and 09:34:47: HEALTHY, version `2026.09.18-health-ah3`, DB 5 ms, workers/channels normal, pending/processing/failed 0, shadow OFF. Not browser-automation evidence. |
| Admin Self Test | PASS EXCEPT PLANNED SKIP | Persisted production `selftest` events at 09:36:06 and 09:38:16 identify Telegram as the only failure. Actual stored `ok` is false, not rewritten to true. Runtime confirms both HEALTH_TELEGRAM_TOKEN and HEALTH_TELEGRAM_CHAT_ID absent. Original deployment rule 10 explicitly excludes Telegram setup. Exact per-step timings and response HTTP status were not captured. |
| Unauthenticated endpoint protection | PASS | Internal and public admin status, self-test and `ah_list` command requests return 401 `session_expired`. No unauthenticated self-test executed. |
| DB function grants | PASS | The six deployed `ah_*` functions and `health_can_view`: anon EXECUTE false, authenticated EXECUTE true. This does not substitute for role-specific real-client tests. |
| Answer Hub DB smoke | PASS | Five expected Phase 1–3 tables; category seed 10, intent seed 10; deployed functions `ah_list`, `ah_get`, `ah_save`, `ah_approve`, `ah_retire`, `ah_versions`. |
| Disabled service gate | PASS, ISOLATED | Runtime service probe returns `HUB_DISABLED` with zero RPC calls. Not a live-client dispatch or PostgREST success test. |
| Production logs | PASS IN OBSERVED WINDOW | Latest 15-minute window: two webhooks accepted and processed, one bot reply, no request_failed events, no Unhandled/TypeError/FATAL/ERR_MODULE_NOT_FOUND lines. Does not claim all-time error absence. |
| Backup | PASS: archive readability | `/opt/asher-inbox/backup-pre-phase8-20260918-014105.tar.gz`, 2,813,387 bytes, full `tar -tzf` succeeded. Not a database-restore rehearsal. |

## Applied migrations

1. `202609172025_health.sql`
2. `202609172100_answer_hub_foundation.sql`
3. `202609172130_system_status.sql`
4. `202609172145_answer_item.sql`
5. `202609180430_answer_version.sql`

Full ledger and deployed-file hashes are in `PHASE8-EVIDENCE.json`.

## Deferred scope decision

The latest handoff added a live-client Answer Hub RPC check. It has NOT been completed: the browser tool has no connected browser, no real-user token was acquired, and no session store was read. The user explicitly accepted deferring this check to the next authorized task.

The original deploy plan explicitly excludes Phase 4+ migrations and says the source RPCs should not be exercised in this deployment. Its incident follow-up also excludes Phase 5/6 database deployment. Therefore the following missing RPCs are planned limitations, not justification to apply extra migrations:

`ah_source_list`, `ah_source_save`, `ah_resolve`, `ah_binding_list`, `ah_binding_save`, `ah_binding_delete`.

The controlled deploy is therefore closed with flags disabled. Authenticated Answer Hub RPC acceptance and Phase 4–6 database activation remain deferred to a separately authorized task. Even a successful authenticated `HUB_DISABLED` response would prove only the session/dispatch gate, not successful database RPC execution.

## Actions taken and next action

This session performed read-only production inspection, local verification, and documentation updates. No redeploy, migration, customer-data changes, messaging action, configuration changes, secret extraction, or Phase 7/9 implementation.

Next action: perform the deferred real-client RPC verification in a separate authorized task. Do not enable flags or apply the excluded migrations as part of this closeout.

**STOP. DO NOT START PHASE 9.**
