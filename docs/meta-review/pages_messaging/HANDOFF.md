# Meta Pages Messaging E2E Handoff

## Verification update (2026-09-19) — both migrations applied and tested locally

Started the local Docker stack (`D:\aplus_postgres_docker\supabase\docker`,
container `supabase-db`) and applied both new migrations by hand via
`docker exec supabase-db psql` (in order: `033`, `035`, `036`, `031`, then the
two new files — `sql/run.mjs apply` itself doesn't work on this Windows host,
it shells out to a local `psql` binary that isn't installed here; use
`docker exec` directly or run `sql/run.mjs` from a host that has `psql`).
Results:

- `npm test` (full suite, 12 sub-suites + the 82-check `http.integration.mjs`
  end-to-end run): **all pass, zero failures**, with both migrations applied —
  including checks that exercise `connect_private.api`, bot decisioning, and
  reply stats, so neither the `receive_event` rewrite nor the `can_read`
  rewrite nor the `stats_normalize` fix broke anything already covered.
- `ALLOW_DB_TESTS=1 npm run test:reviewcode:db` — 4/4 pass. Found and fixed two
  bugs in the *test file itself* (not the migration) along the way: (1) a jsonb
  boolean extracted with `->>` prints `'true'/'false'`, not Postgres's native
  `'t'/'f'`; (2) the cleanup routine deleted `core.contact` before
  `core.event_log`/`crm.lead`, which `receive_event`'s `ensure_lead()`/`emit()`
  calls populate and which FK-reference the contact — this test is the first
  one in the suite to exercise the real `receive_event` path, so this gap
  never showed up in the older `testreset.db.test.mjs`.
- `ALLOW_DB_TESTS=1 npm run test:shared-sales-queue` — 3/3 pass, using the real
  `sales.a.test@`/`sales.b.test@` fixtures. Confirmed `test_only` was correctly
  reverted to `false` on both afterward.

This local DB is a dev instance, not the VPS — `inbox.sql_applied` was empty
before this (nothing in `sql/` had ever been applied here, only the base
`database.sql`-equivalent restore), and applying via raw `docker exec` instead
of `sql/run.mjs` means the ledger table still doesn't reflect these files being
applied. That's fine for local verification but means: **do not** treat this
local DB's state as any indication of what's on the VPS, and don't run
`sql/run.mjs plan/apply` against it expecting sane output without first either
installing `psql` here or fixing the ledger rows by hand.

**Nothing was applied to the VPS.** Both migrations are verified correct
against a real Postgres/Supabase instance now, but deploying them to
production is a separate, much higher-risk step not taken here.

## STEP 2 update (2026-09-19) — can_read migration implemented, NOT yet deployed

Code-complete on the local repo, not applied to the VPS database and not deployed.
Brings the manual VPS hotfix (from the STEP 1/2 task context: 2026-09-19,
"Hotfix in can_read" + the reviewer's `test_only` flag) back into the repo as a
real migration, instead of it only existing as an out-of-band edit on production.

Files:
- `sql/041_shared_sales_queue.sql` — adds `core.profile.test_only` (never existed
  in this repo before; added ad hoc on the VPS for the reviewer account) and
  rewrites `connect_private.can_read` (previously only defined in `database.sql`,
  never touched by anything in `sql/`) to: (1) drop the assignee/team-based read
  restriction for `sales`/`senior_sales` — shared queue, matches the exact VPS
  hotfix wording quoted in the task; (2) keep
  `(not p.test_only or c.is_test)` exactly as verified on the VPS. Registered in
  `sql/ORDER.txt`, `node sql/run.mjs check` passes.
- `tests/shared-sales-queue.db.test.mjs` — DB-level regression test: a sales user
  in one team can read a conversation assigned to a sales user in a *different*
  team (proves the old per-team/assignee gate is gone); a `test_only` account
  can't see a normal conversation but can once it's flagged `is_test`; a normal
  teammate still sees `is_test` conversations too (not hidden from the team).
  **Now run and passing (3/3)** — see "Verification update" above. Depends on
  the shared test fixtures in `../.asher-test-users`
  (`asher-web/scripts/seed-test-users.mjs --apply`) for `sales.a.test@`/
  `sales.b.test@` (different teams) — same fixtures `tests/http.integration.mjs`
  already relies on. It temporarily flips `test_only` on `sales.b.test@` and
  reverts it in both a `finally` and `test.after`, but if it's ever interrupted
  mid-run, check `core.profile.test_only` on that fixture account before relying
  on it elsewhere.

Scope note: the task's second STEP 2 bullet ("align assignee-based visibility
filters in `connect_private.api` with it — assignee stays as information and an
optional 'mine' filter, not an access-control gate") needed **no code change**.
Checked `sql/026_contact_external_id.sql` (current `connect_private.api`) and
`sql/024_queue_counts.sql`: both already gate solely through
`connect_private.can_read()` and use `assignee_id` only for the `mine`/
`unassigned` UI filter and for the separate "must claim before mutating the
deal" business rule (`claim_required`, unrelated to read access, already
commented as such in `026`). Fixing `can_read` alone is sufficient.

## STEP 1 update (2026-09-19) — review-code path implemented, NOT yet deployed

Code-complete on the local repo (branch `meta-review-hardening`), not applied to the
VPS database and not deployed. Implements the review-code requirement from the
STEP 1 task: a Messenger message starting with `META_REVIEW_CODE` (env, default
`META-REVIEW`) on channel key `asher-messenger` flags that conversation
`is_test=true` and `mode='human'` so the bot never answers the reviewer.

Files:
- `bots/reviewcode.mjs` — pure logic (`reviewCode()`, `tagReviewCode()`), unit
  tested in `tests/reviewcode.test.mjs` (10/10 pass, no DB needed).
- `server.mjs` — `processInbound()` tags each Messenger event before calling the
  `receive` RPC; nothing else changed.
- `sql/202609191500_review_code.sql` — re-defines `connect_private.receive_event`
  (built on `sql/036_echo_source_from_queue.sql`, one added block) plus a fix to
  `inbox.stats_normalize` (see below). Registered in `sql/ORDER.txt`.
- `tests/reviewcode.db.test.mjs` — DB-level regression test (a/b/c from the task:
  code hit sets is_test+human+no generate job; normal Messenger text untouched;
  a channel other than asher-messenger is ignored even if the flag leaked in).
  **Now run and passing (4/4)** — see "Verification update" above (two bugs
  found and fixed were in this test file, not the migration — see that note).

Design notes worth knowing before touching this again:
- `is_test` alone does **not** stop the bot — `sql/031_test_reset.sql`
  (`connect_private.reset_test_conversation`, the "test" keyword command) sets
  `is_test=true` together with `mode='bot'` on purpose, because the team uses it
  to test the bot itself, on both LINE and Messenger. Gating bot replies on
  `is_test` globally would have broken that. Bot suppression here uses
  `inbox.conversation.mode='human'` instead — the pre-existing
  `reply.respect_convo_mode` gate in `inbox.decide_reply` (`sql/002_decide.sql`)
  already reads it. No change to `decide_reply` was needed.
- Found and fixed a real pre-existing gap while implementing "excluded from
  reply stats / points": `inbox.stats_normalize` (`sql/017_stats_functions.sql`)
  never filtered `is_test` out of `countable`, so every `is_test` conversation
  (from the "test" command too, not just this new path) has always leaked into
  the reply-stats/points system (`sql/016-018`, `027_stats_v2.sql`). Fixed in
  the same migration. `reply_stats` (009), `conversation_outcomes` (013) and
  `case_status` (023) already excluded `is_test` correctly — untouched.
- "No `assignment_rule` auto-assignment" from the task is a no-op: this
  codebase has no automatic-assignment feature at all (`assignee_id` is only
  ever set manually through the `assign` action). Confirmed by grep across
  `sql/*.sql`; nothing to change.
- Team-notify-on-message (Telegram/LINE group ping when a new message arrives)
  is intentionally **not** suppressed for `is_test` — it already gets a
  `[TEST]` prefix (`sql/031`/`036`, tested in `tests/notify-test-prefix.test.mjs`)
  so the team can see review activity happening. That's a different thing from
  the periodic reply-stats/points reports, which are excluded as above.
- (Resolved by STEP 2) `connect_private.can_read` originally had **no**
  `test_only`/`is_test` awareness in this repo — that gate only existed as a
  manual VPS hotfix. `sql/041_shared_sales_queue.sql` brings it into the repo
  and both migrations are now verified together locally (see "Verification
  update" above), so regression check (a) from the task ("the test_only
  reviewer login can list, open and reply") is covered end-to-end, just not
  yet on the VPS itself.

Not done (left for later / out of scope): applying either migration to the
VPS, wiring `META_REVIEW_CODE` into `.env`/`.env.example`. Also fixed in
passing: `docs/meta-review/pages_messaging/REVIEWER-INSTRUCTIONS.md` said
"BLOCKED — reviewer account not created", contradicting the rest of this
file (reviewer account exists, login PASS) — updated it to point at the real,
still-open blocker (reviewer-account send not yet verified) instead.

---

STATUS: PAUSED — technical round-trip proven, reviewer-account send not yet verified

REVIEWER ACCOUNT: PASS
REVIEWER LOGIN: PASS
PASSWORD_ROTATED: YES
ROLE: sales
TEST_ONLY: PASS
ADMIN_ACCESS_BLOCKED: PASS
MESSENGER_BINDING: PASS
INBOUND_RECEIVED: YES
CONNECT_CONVERSATION_VISIBLE: YES
HUMAN_REPLY_SENT: YES
META_API_ACCEPTED: YES
MESSENGER_RECEIVED: YES
E2E_STATUS: PASS_TECHNICAL
READY_FOR_META_REVIEW: NO

FILES UPDATED:
- docs/meta-review/pages_messaging/HANDOFF.md
- docs/meta-review/pages_messaging/TEST-CHECKLIST.md

CHANGED PRODUCTION DATA: NONE

BLOCKER: The verified round-trip reply was sent from `ake@asher.local` (tester's own Sales Workspace login), not from the reviewer account `meta-review@asher.local`. Meta App Review requires the flow to be demonstrable using the reviewer credentials that will actually be handed to Meta, so READY_FOR_META_REVIEW stays NO until that specific send is verified.

WHAT HAS BEEN VERIFIED (evidence-based, from `connect_private.delivery` / `inbox.message` / `core.contact_identity` on the production DB, read-only):
- Reviewer account meta-review@asher.local exists; password rotation completed; real /api/login succeeded.
- Role sales; active=true; test_only=true; purpose=meta_app_review; admin=false.
- Admin route returned 403.
- Tester (Ake) sent a new inbound message from their own Facebook account (confirmed by the tester, who has a role on the Meta app) to the Page.
- All markers below share one PSID: `3333241816728941` (single conversation, confirmed as the tester's own identity, not a customer):
  - `META-E2E-20260919-01` — inbound, received 2026-09-19 14:17:32 Thai time.
  - `META-E2E-20260919-02` — inbound (×3, 14:29–14:34 Thai time).
  - `META-E2E-20260919-03` — outbound reply, sent via Sales Workspace by `ake@asher.local` (sender_type=agent), `connect_private.delivery.status=sent`, `provider_id (Meta message_id) = m_iNjjWCnB8NwStBm_wUKl9EPqSCrUszMoz2euRkadxgImuLbmi0g_r2X_5h3jaJnLwviKw6bnuCd_R2u0_971FA`, delivered_at 2026-09-19 14:39:26 Thai time, no error. Received in Messenger confirmed by tester (~14:16 by tester's own estimate; DB timestamp is 14:39:26 — minor discrepancy, not investigated further).
- This proves the full technical loop works: inbound webhook → visible in ASHER Connect → human agent reply via Sales Workspace → Meta Send API accepted → delivered to Messenger.
- Not yet proven: the same reply sent specifically from the `meta-review@asher.local` login.

WHAT MUST NOT BE DONE:
- Do not use the old 24-message customer conversation as test.
- Do not guess PSID; PSID `3333241816728941` is the only approved test recipient (tester's own account).
- Do not send outbound to any other PSID.
- Do not change production data beyond a reviewer-account send that follows this same tested path.

## ทำต่อจากตรงนี้ (resume here)

1. Log into the Sales Workspace as `meta-review@asher.local` (not `ake@asher.local`).
2. Open the same test conversation (PSID `3333241816728941`).
3. Send a reply (suggested marker: `META-E2E-20260919-05`, since -03 and -04 are already used/reserved).
4. Re-run the read-only verification query below against production (`ssh root@187.53.139.175` → `docker exec supabase-db psql -U postgres -d postgres`) and confirm:
   - `sender_type='agent'` and `agent_email='meta-review@asher.local'`
   - `delivery_status='sent'` with a non-null `meta_message_id`
   - `psid='3333241816728941'` (same conversation, no new PSID)
5. Only if all of the above hold, set `READY_FOR_META_REVIEW: YES` in this file and in TEST-CHECKLIST.md.
6. Remaining prep before submitting to Meta App Review (independent of the above):
   - Record a screencast of the reviewer flow (login → inbound visible → reply sent → received in Messenger).
   - Fill in real reviewer login instructions in `docs/meta-review/pages_messaging/REVIEWER-INSTRUCTIONS.md` (currently has placeholder `[ACTUAL REVIEWER USERNAME]` / password fields — do not put the actual password in this repo; reference where it's provided securely).
   - Write the `pages_messaging` permission usage explanation for the Meta App Review form (what the app does with the permission, screencast reference).

### Verification query (read-only, safe to re-run)

```sql
select m.id as message_id,
       m.sender_type,
       u.email as agent_email,
       left(m.content, 60) as content,
       m.created_at at time zone 'Asia/Bangkok' as created_thai,
       m.delivered_at at time zone 'Asia/Bangkok' as delivered_thai,
       d.status as delivery_status,
       d.provider_id as meta_message_id,
       d.last_error,
       ci.external_id as psid,
       i.channel
  from inbox.message m
  join inbox.conversation c on c.id = m.conversation_id
  join inbox.inbox i on i.id = c.inbox_id
  left join core.contact_identity ci on ci.contact_id = c.contact_id and ci.channel = i.channel and ci.account_key = i.id::text
  left join connect_private.delivery d on d.message_id = m.id
  left join core."user" u on u.id = m.sender_id
 where m.content ilike '%META-E2E-2026091%'
 order by m.created_at desc
 limit 15;
```

Run via:
```bash
ssh root@187.53.139.175 "docker exec supabase-db psql -U postgres -d postgres -c \"<query above, single line, escape inner double quotes>\""
```

RETEST MARKER: META-E2E-20260919-05 (next unused marker; -03 sent from wrong account, -04 previously reserved/unused)
