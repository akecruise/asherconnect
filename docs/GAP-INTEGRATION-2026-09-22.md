# Connect gap integration — 22 September 2026

This branch captures the complete reviewed working source at 39e4232 and adds durable standalone profile publishing. No production deployment or migration was performed.

## Implementation

- Preserve the custom SQL registry order and reviewed profile/messaging migrations.
- 202609221500_crm_profile_updated_outbox.sql adds contact.profile_updated, a durable pending table, a profile trigger and a bounded retry RPC.
- A failed outbox insert preserves the source update and pending retry. Profile events use deterministic IDs; retries are idempotent. Manually named contacts are skipped.
- Pending table has RLS; privileged functions use a fixed search_path and revoke PUBLIC/anon/authenticated execution.
- ASHER_CRM_PROFILE_RETRY_ENABLED=true enables the retry pass in the existing publisher. It defaults off. Apply the migration and make its RPC available before enabling.
- npm test now runs tests that do not target the shared database. Database tests require explicit disposable container/database/user and an opt-in.

## Release sequence

1. Recheck the live release and custom migration ledger with node sql/run.mjs plan; inspect the complete pending plan, not only the latest filename.
2. Back up and verify the actual Connect database. The observed live Connect database was postgres; CRM used another database.
3. Deploy the CRM consumer with its 010/011/012 schema first.
4. Apply reviewed Connect migrations using the existing runner; ensure the profile RPC is visible through the configured PostgREST inbox schema.
5. Deploy this Connect branch, retain publisher configuration, and enable ASHER_CRM_PROFILE_RETRY_ENABLED=true.
6. Observe pending retry count/age/attempts, claim/delivery status, and CRM processing. Check a profile-only change without sending a chat message.
7. On a failure, turn off the new retry flag and roll back application releases as appropriate; preserve queued events and additive schema for investigation. Disabling retry alone does not disable the profile trigger.

## Verification

- Default safe suite: 181 passed.
- npm run check: syntax and custom SQL order passed.
- tests/profile-outbox-retry.sql: standalone event, injected failure, durable recovery, deduplication, manual-name guard and ACL checks passed in an isolated disposable database.
- The SQL test bootstraps synthetic core/inbox schemas and rolls them back; do not run it on a populated database.

## Database tests

Set all of the following explicitly:

    ASHER_CONNECT_ALLOW_DB_TESTS=true
    ASHER_CONNECT_TEST_CONTAINER=<asher-gap-* or asher-test-* disposable container>
    ASHER_CONNECT_TEST_DATABASE=<asher_*_sandbox disposable database>
    ASHER_CONNECT_TEST_USER=<test user>

HTTP integration also requires HTTP_TEST_SUPABASE_URL pointing to an isolated loopback service, not port 8055. Use npm run test:database only after recreating the necessary full Connect schema and test API environment. That legacy suite has not been reverified on a full isolated clone in this review.

During the initial legacy npm test, report/outcome/decision tests ran against their hardcoded local shared supabase-db target before the risk was identified. They were not run against the production SSH host. Tagged test inboxes were checked and none remained. Those tests also recalculate dated reports, so absence of tagged inboxes is not a proof that every local derived value was untouched. Default/test-target guards above prevent repeating that implicit targeting.
