# ASHER Unified Identity — implementation handoff

## Implemented in this workspace

`core.profile.user_id` remains the canonical Supabase Auth UUID used by Connect for
conversation assignment, CRM lead ownership in the Connect schema, and audit actor
fields. The additive migration `202609221000_unified_identity.sql` adds:

- shared role registry: `sales`, `senior_sales`, `sales_manager`, `admin`;
- shared modules: `crm`, `connect`;
- per-user module access with RLS and fail-closed `core.current_user_has_module()`;
- `core.user_identity_map` for exact legacy-to-canonical mappings;
- exact UUID backfill from existing Connect profiles and CRM memberships when the
  CRM schema is present;
- CRM legacy subjects are treated as text and mapped only when they match a complete
  UUID, avoiding casts of opaque legacy identifiers such as `sales-1`;
- no deletes, drops, customer writes, or message sends.

Legacy IDs remain valid. Mapping never uses names; non-UUID CRM subjects remain
unresolved until verified against Supabase Auth.

## Verification completed locally

- `npm run sql:check` — passed; migration is in `sql/ORDER.txt`.
- `node --test tests/unified-identity.test.mjs tests/crm-publisher.test.mjs` — 2/2 files passed.
- `npm run check` — passed.
- CRM `npm run typecheck` — passed.

## Production gate still required

This environment cannot reach the production VPS (`ssh` fails before authentication)
and Docker is unavailable in WSL. Therefore no production baseline, backup, migration
apply, deployment, or live acceptance test was performed. The CRM sibling repository
is outside the writable workspace root, so CRM application/migration changes could
not be committed from this session.

Before enabling canonical CRM login/ownership, the operator must use the existing
VPS procedure to back up the database, inspect all CRM/Connect/auth counts, resolve
only deterministic mappings, apply this migration, and verify Messenger/LINE
idempotency and outbox health without sending messages.
