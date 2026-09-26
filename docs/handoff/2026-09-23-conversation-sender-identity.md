# ASHER Connect Conversation Sender Identity — implementation handoff

## Scope completed

Conversation history now presents the real message actor instead of using the
conversation owner as a proxy:

- inbound `contact` messages render on the left;
- outbound `agent` messages render on the right and use the message's
  `responder_display_name` snapshot;
- outbound `bot` messages render as `Asher Bot` with a visible `BOT` badge;
- `system` messages are neutral and never impersonate a human;
- customer avatar, customer/channel label, date separators, delivery status,
  images, files, Thai wrapping, and mobile layout are supported.

The existing database vocabulary is preserved for compatibility:

- `sender_type='agent'` is the existing human outbound value;
- `sender_type='bot'` is the bot value;
- `sender_id` identifies the actor who sent the message;
- `conversation.assignee_id` remains ownership and is never used as message
  sender identity.

Historical agent messages without a provable snapshot show `ไม่ทราบผู้ตอบ`.
The UI does not infer a responder from the current assignee or current profile.

## Files changed for this work

- `public/app.js` — shared message-side, sender-label, status, date-separator
  rendering and customer avatar.
- `public/app.css` — Messenger-style rows, left/right alignment, sender labels,
  Bot badge, date separators, and responsive constraints.
- `public/conversation-presentation.mjs` — pure presentation rules shared by
  browser code and tests.
- `server.mjs` — serves the new browser module.
- `tests/conversation-presentation.test.mjs` — sender, direction, bot,
  fallback, status, date, attachment/mobile, and assignee regression checks.
- `tests/responder-attribution.test.mjs` — updated for the new shared renderer.
- `package.json` — registers the new test file.

## Existing schema/migration dependency

The additive migration already present in the repository is:

`sql/202609231500_responder_attribution.sql`

It adds `responder_user_id`, `responder_display_name`, and `sent_at`, with an
insert trigger that snapshots the human responder name. It is listed in
`sql/ORDER.txt`. No destructive migration or new message table was added in
this UI work.

Production migration state was verified before application deployment. The
responder migration is already present in `inbox.sql_applied` and its production
SHA matches the repository SHA:

`86ca01282845806061a8df841ec35ea48f18e59d61267585a8f78fa92ecd0352`

## Verification

Passed:

- `npm run check`
- SQL order/check validation
- Conversation-focused tests: 8/8
- Relevant regression selection: 85/85, including provider, Messenger/LINE,
  media, attachments, Quick Replies, Answer Hub, and responder attribution

The complete `npm test` command is currently not green because the existing
`report.test.mjs` integration setup fails in the local database before its
report assertions: `core.resolve_identity` attempts to insert a
`contact_identity` row with `channel = null`. This is outside the Conversation
sender-identity diff and must be repaired or explicitly waived before a green
release gate.

## Production deployment evidence

Application deployment completed on 2026-09-23 (Asia/Bangkok):

- deployed commit: `1b72ee71eeb7e500143aebaee484be3e52095527`;
- VPS marker: `/opt/asher-inbox/app/.deployed-commit` contains the same commit;
- rollback image: `app-asher-connect:rollback-20260923-074924`;
- application backup: `/opt/asher-inbox/app.bak-20260923-074924`;
- deployment used `git archive`, then `docker compose build` and
  `docker compose up -d --force-recreate`;
- post-deploy `healthz` and `/health` passed;
- database health passed and no recent application error logs were observed;
- container uptime reset after forced recreation and reported healthy.

Status: **DEPLOYED — MONITORING / TEST CAVEAT**.

Follow-up release work:

1. repair or isolate the pre-existing local report-test/database fixture issue;
2. run an authenticated UI smoke test for one Messenger and one LINE
   conversation with two human agents,
   one Bot message, attachment, delivery status, and unchanged assignee.

The full local `npm test` suite remains non-green because `report.test.mjs`
fails on the existing local fixture where `core.resolve_identity` receives a
null channel. The relevant Conversation/provider/media/Answer Hub/Quick Reply
selection passed 85/85 before deployment.

## Rollback

If the deployed UI artifact has a problem, restore the saved app directory and
rollback image above, excluding `.env`, `channels.json`, and `.sessions/`, then
run `docker compose up -d --force-recreate`. Keep the additive responder
columns in place; do not remove them during an application rollback.

## Handoff guardrails

Do not rewrite `conversation.assignee_id` when sending a message. Do not
backfill an unknown historical responder from the current profile or assignee.
The production artifact was created from commit `1b72ee7`; do not claim later
local working-tree changes are deployed. At handoff time, local `public/app.js`
and `public/app.css` have uncommitted modifications plus the untracked handoff
file. Review and commit those changes separately before any next deployment.
