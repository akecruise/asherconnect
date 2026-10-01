# Meta history import — 2026-09-29

User requested real Asher Condo/Naii chats in Connect, then limited today's
work to data already retrievable. No CRM import was substituted for this task.

## Committed to production Connect

| Customer | New conversation | Added messages | Existing messages skipped |
|---|---:|---:|---:|
| Aom Jyy | Yes | 15 | 0 |
| Anfield BW | No | 3 | 2 |
| Athiramon Kongchana | No | 25 | 13 |

43 text messages inserted from authenticated Meta Conversations API responses.
One new conversation in human mode, bot disabled, unread 0; two existing
conversations were preserved without changes to ownership, status, SLA, mode,
or timestamps. Two attachment-only messages for Athiramon were deliberately
not imported; their media remains pending. No customer messages sent.

Source page: `244737289567723`; target inbox:
`818b4364-20f5-411f-b224-64557aa9604c`.
Identities matched using page-scoped API participant IDs, NOT Business Suite
selected_item_id. API message IDs provide deduplication.

Added Aom conversation: `6e15d40f-a5e3-d236-134a-3132c975ace8`.
Anfield: `6da552a0-4b75-4e6e-ade1-db7c3e90526e`.
Athiramon: `6d9b7078-6748-45ab-8b20-5226ea58f5b5`.

Page-authored outbound messages retain page attribution only; individual staff
and bot-vs-human authorship cannot be established from these API fields.
No human-first-response SLA updates were made.

## Verification and safety

- Transactional preview passed; then COMMIT; then repeat preview returned zero additions.
- Existing conversation snapshots were unchanged.
- Asserted zero new delivery jobs, bot jobs, and CRM publishing jobs for inserted messages.
- No deployment/schema/permission changes.
- Message triggers suppressed only for this transaction via SET LOCAL
  session_replication_role; explicit inbox/contact/participant parent checks.
- Full source preserved privately in `/tmp/asher-meta-import-YM8975/history.json`
  (mode 0600, parent mode 0700), not in Git. Import/collection scripts are alongside it.
- Audit action: `meta_history_import_20260929`, recording source thread/message IDs.

## Pending when user ended today's work

Instagram API list was readable, but message fetching returned HTTP 403 / code 4
(rate limit). No IG messages from this attempt were imported:
Riw Pries (`xikean_27224`), moo_moo3636, Nuchy (`p.nuchy.naka`),
BBAYBBAY (candidate username `bbayiiz`), Eart Parinwat (candidate `earttone`).
Candidate username matches require message-content verification before import.
Browser verification confirmed Riw's real thread and visible transcript.

User also supplied FP (Apr–May) and explicitly authorized extending before June
for older history; FP has not been retrieved/imported. User supplied พรรักษา /
LINE handle `minenameprs`; its OA history/identity linkage remains pending.
Do not turn LINE handles or Meta UI thread IDs into sendable recipient IDs.

Separate earlier CRM spreadsheet import is complete (32 source rows), but does
not imply that those customers' chats are all imported in Connect.
