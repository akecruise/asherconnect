# Asher Condo history backfill — 2026-09-29

Destination: Asher Connect on the user-specified VPS. Not Asher CRM.
Scope: Asher Condo only; exclude Apluscondo, Dev, unrelated businesses, and groups.
Window: 2026-06-01 00:00 Asia/Bangkok through collection cutoff
2026-09-29T15:19:59.232Z. This is a partial completion, not an all-channel import.

## Verified operations

- User authenticated LINE in Chrome. Used the `agent-browser` skill with an
  isolated named CDP session and read-only requests to the authenticated OA.
  No cookies/tokens were exported to the VPS.
- Enumerated 3,457 roster records (3,456 USER and one GROUP). Selected 86 USER
  chats using roster activity timestamps in the requested window; fetched 1,338
  events. Activity-based selection is not a guarantee that every historical chat
  remains available from LINE. Older existing archive data was preserved.
- Preview against existing private archive found one new chat and 137 new events.
  Committed these additions using composite source keys and ON CONFLICT DO NOTHING.
  Did not overwrite old archive rows or claim a complete lifetime scan.
- Repeated archive preview: zero new chats, zero new events.
- Cross-matched archive to existing Connect conversations using same normalized
  name plus at least two distinct inbound text messages matching content and time
  within 1.5 seconds. Required one-to-one pairing and excluded test/anonymized
  contacts. This is conservative corroboration, not a conversion of OA identifiers
  into Messaging API user IDs. No match by name alone.
- Twelve chats passed the strict matching rule. Preview found 19 missing inbound
  messages across two conversations. Appended exactly these 19; no new outbound
  rows were required for this matched subset.
- Repeated message preview: zero additional rows.

## Safety controls

No new contact identities, customer messages sent, bot generation, CRM delivery,
consent changes, owner changes, SLA resets, or application deployments.

Historical message insertion used transaction-local `session_replication_role`
and `connect.replay` settings, not globally disabled triggers. The transaction
locked/validated exact parent conversations and asserted absence of imported IDs
in delivery, jobs, and CRM outbox, plus byte-equivalent conversation state before
commit. Consequently stats/training triggers were also intentionally not replayed.
Other sessions were unaffected. Unique constraints remained active.

Audit: `connect_private.audit.action = 'line_oa_june2026_history_import'`;
batch `asher-line-june-v1`. Audit details hold exact inserted message IDs for a
targeted recovery if ever needed. No recovery/deletion was performed.

Collection and one-shot import scripts: `/tmp/asher-browser-x5Q191/` on the local
WSL host. Raw source files are mode 0600 under a mode 0700 directory; do not commit
or share them. Durable source archive and import audit are on the Connect DB.

## Outstanding

- Unmatched historical customers remain in the private archive, not new sendable
  Connect contacts. OA chat/profile IDs do not directly match Messaging API IDs.
  User choice requested: keep for review or add a separate read-only history view.
- Facebook Business authentication reached a two-factor verification screen.
  Messenger and IG history has not been collected or imported in this run.
- More recent events after the cutoff need a subsequent incremental run.
