# Contact receive contract fix

## Scope and result

Fixes Node extraction -> PostgreSQL contact -> durable CRM outbox, and
Messenger profile write isolation. This is not Unified Send Service or SLA work.
No live DB changes, Graph calls, CRM HTTP delivery, or deployment performed.

Migration: `sql/20260929103510_contact_receive_contract.sql`, generated with
`supabase migration new contact_receive_contract`, moved into this repository's
`sql/ORDER.txt` ledger. Do not also apply it through a second migration ledger.

### Changes

- Receive consumes normalized `extracted_name` / `extracted_phone` only for
  `event_type=message`, `source_type=user`, after identity/conversation validation.
  Contact updates and message/outbox writes share the receive transaction.
- Empty fields are filled; existing names and phones are retained. Names over
  80 characters and non-normalized Thai mobile numbers are ignored. Extraction
  of free text remains Node's responsibility, not a second SQL parser.
- Customer-supplied names get `name_source=customer`; subsequent platform
  refreshes preserve both customer and manual names. Anonymized contacts are not
  restored by these writes.
- `sync_contact_profile` requires `account_key` (the inbox UUID, NOT the literal
  Facebook Page ID), validates its channel, and matches the complete identity
  `(channel, account_key, external_id)`. Runtime and backfill callers now supply it.
  Missing/invalid scope fails closed. The verified channel config maps Page to inbox.
- Profile events now include `phone` and fire for phone-only changes, including
  when a contact already has a manually verified name. Message/conversation
  snapshots include phone too. CRM event names remain unchanged.
- Profile outbox insertion errors no longer disappear in a catch-all handler:
  receive rolls back, allowing the existing durable inbound retry to recover.
  There is no synchronous call to CRM in the DB transaction.
- Guarded patches retain installed receiver/worker definitions, including
  Instagram identity and inbox-scoped echo matching. Unexpected definitions stop
  migration rather than silently replacing unrelated fixes.
- Service-only profile/helper privileges are retained. No existing table columns
  are changed and no historical contact data is backfilled automatically.

## Verification

The regression runner executes the real receive, profile, worker profile-update,
and CRM trigger SQL in an isolated PGlite PostgreSQL engine. Fixture schemas are
minimal; bot decisions/scheduling and lead creation are stubs. This verifies the
DB contract, not every production trigger or the separate CRM consumer.

Install a pinned test-only engine outside the application (no runtime dependency):

```bash
CONTACT_TEST_DIR=$(mktemp -d)
npm install --prefix "$CONTACT_TEST_DIR" --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.3.14
export PGLITE_MODULE="$CONTACT_TEST_DIR/node_modules/@electric-sql/pglite/dist/index.js"
npm run test:contact-contract
npm run test:messenger-contact
npm run check
```

`CONTRACT_BASELINE=1 npm run test:contact-contract` omits the new migration to
reproduce the failures against the historical definitions. It is expected to fail.
Initial reproduction: missing extracted name, missing phone, and Page B profile
written to Page A. Test output uses synthetic names/phones only.

Tests cover contact + message/profile outbox payloads, duplicate events, scoped
receive and profile writes, missing scope rejection, manual/existing values,
invalid input, non-user messages, platform refresh precedence, anonymization,
outbox failure/replay, migration rerun, preserved Instagram logic, and privileges.

Local results: 9 PostgreSQL contract tests and 82 related Node tests passed;
`npm run check`, backfill script syntax, and `git diff --check` passed. Docker
Desktop's Linux engine was unavailable, so the full Supabase staging suite and
database advisors were not run. Permission assertions were run in the isolated
engine instead; they do not substitute for a deployment security review.

## Rollout / PR checklist

- Pause inbound/profile workers during coordinated rollout: old unscoped callers
  intentionally fail against the new contract.
- Back up installed definitions of `connect_private.receive_event`,
  `connect_private.worker`, `inbox.sync_contact_profile`,
  `inbox.crm_publish_profile_updated`, `inbox.crm_publish_message`, and the profile
  trigger before migration. Compare any production drift first.
- Run `node sql/run.mjs plan --db "$STAGING_DATABASE_URL"`; inspect the plan.
  Only then run `node sql/run.mjs apply --db "$STAGING_DATABASE_URL"`.
  This runner applies all outstanding migrations, not just this file.
- Deploy the matching server and backfill script; resume workers in staging.
- Verify a test Page message creates the expected contact and outbox payload;
  verify the CRM publisher delivers it and the CRM consumer actually maps `phone`.
  Confirm project mapping, permissions, and dead-letter status. Repeat with two
  inbox scopes and a subsequent phone-only update.
- Do not claim production resolution until this staging/live contract check passes.
  Existing processed messages are not automatically repaired: dedupe still works.
  Any historical backfill requires separately scoped work.
- Rollback: pause workers and restore the captured function/trigger definitions
  and matching application version. Do not delete contacts/outbox data or blindly
  rerun old receiver migrations, which could remove later Instagram fixes.

Supabase security reference used for function privileges and search paths:
https://supabase.com/docs/guides/database/functions
