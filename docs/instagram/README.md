# Instagram inbox — ASHER Connect

Prepared 2026-09-23 from Connect `ce05390` in branch `feature/instagram-inbox-20260923`.

## Current status

Implementation and local verification are complete. Instagram is **not connected to the live inbox yet**.
No production deployment, Meta subscription, production migration or real customer message was performed.
The current channel file contains LINE and Messenger; it contains no Instagram credentials.

Worktree: `D:\aplus_postgres_docker\asher-connect-instagram-20260923`.
The canonical Connect folder had unfinished changes to `public/app.js`, `public/app.css` and a sender-identity handoff.
Those changes were preserved. Integrate this branch with that work before deployment.

## Implemented

- Separate `instagram` channel, badge, conversation label, health entry and report label.
- Instagram Login API transport using `graph.instagram.com`; existing Facebook/LINE transports remain separate.
- Signed webhook verification at `/webhooks/<channel-key>` and account-scoped routing.
- Incoming DMs, attachment references, postbacks, native IG echoes and message unsends.
- Direction-aware customer identity: IG scoped IDs are never treated as Facebook PSIDs or merged by display name.
- Existing assignment, SLA, queue and authenticated responder-name path are reused.
- Text and one image per send; a 24-hour window guard; ambiguous sends are marked uncertain instead of automatically retried.
- Instagram media is opened from the provider URL; incoming media bytes are not copied to storage.

## Exact boundaries

- This integration uses **Instagram API with Instagram Login**. A Messenger Page token is not a substitute.
- One text message (up to 1,000 characters) OR one image per send. Send a caption separately.
- Native IG replies do not identify the individual staff member reliably. They use the existing unknown-responder fallback.
- No old conversation import, reaction display, read-receipt ingestion, group chat or automated outreach is implemented.
- Native unsends clear visible message text and attachment references; raw webhook audit follows existing retention.
- External ASHER CRM publishing currently allowlists LINE/Messenger. This change does not claim Instagram Customer 360 integration.
  Connect's own contact, lead, assignment and SLA state are available. Expand and test the CRM ingestion contract separately before enabling IG outbox publishing.

## Verification

Windows Node 24.15.0: **91/91 PASS** across Instagram, real HTTP webhook with mocked upstream, existing provider/profile/media and conversation-presentation tests.
Local Supabase: **17 assertions PASS**, including identity isolation, duplicate MID, orphan echo, native echo, authenticated responder attribution,
queued outbound/echo correlation, scoped unsends and denied browser/anonymous ingestion access. The complete SQL test ends with `ROLLBACK`.
Syntax checks and the SQL manifest check passed. No full production acceptance claim is made.

```powershell
Set-Location D:\aplus_postgres_docker\asher-connect-instagram-20260923
npm run test:instagram
node scripts/test-instagram-db.mjs --allow-local-db-tests
npm run check
```

The DB runner uses the local Docker engine only, includes the required media/responder migrations within the rollback transaction,
and fails on any SQL error. The local DB was missing those prerequisite columns; they were not permanently added.

A broader test attempt in the temporary Linux source copy returned 204/221: 14 report tests could not access Docker,
two lacked source-copy fixtures (Dockerfile/XLSX), and one existing assertion expects `ไม่ทราบผู้ตอบ` while the baseline renderer says `ไม่ระบุผู้ตอบ`.
These results do not represent a full-suite pass. The targeted Windows tests above used the actual worktree.

## Activation checklist

1. Identify the exact ASHER Instagram username and professional account. In Meta's app setup choose Instagram Login,
   authorize `instagram_business_basic` and `instagram_business_manage_messages`, and complete the access/review requirements for the intended users.
2. Merge the branch while preserving the other UI work. Back up the target database and review `node sql/run.mjs plan` against its ledger.
   Apply the registered `20260923090119_instagram_inbox.sql` after the existing media and responder-attribution migrations.
   The migration refuses missing prerequisites or an unrecognized installed receiver contract.
3. Create a separate `inbox.inbox` row with `channel='instagram'`, the verified ASHER project and its own UUID.
   Keep it inactive until ready. Set `reply.enabled=false` and `bot.generate_enabled=false` for the new inbox.
   Do not change the existing global send-mode setting: the current app aggregates active inbox send switches with `bool_and`.
4. Add the Instagram entry from `channels.example.json` to the server-side channel file. Fill `inbox_id`, the numeric IG account ID,
   the Instagram token, app secret, a new verify token and a supported Graph API version. Keep `enabled=false` until deployment is ready.
   Store secrets on the server, never in git or a chat message.
5. Deploy the tested code; configure the Meta callback to `https://inbox.apluscondo.com/webhooks/asher-instagram`.
   The verify token must match the server configuration. Subscribe to `messages` and `messaging_postbacks` for the authorized IG account.
   Activate the inbox and channel together, preserving the intended send-mode state of Facebook/LINE.
6. From an authorized test account, send a DM. Check one IG conversation, correct customer name, no Facebook collision, correct assignee/SLA,
   then send an approved test reply from a logged-in staff account and confirm the staff name plus provider delivery ID.
   Also check a native IG reply, duplicate webhook, attachment link and unsend. A public live callback and Meta authorization are required for this gate.

If rollout must be stopped, disable only the IG channel and inbox; preserve their messages. Review the aggregate send switch before restarting.
Do not revert the shared receiver by restoring an old full function definition over later fixes.

## Official API references checked

- https://www.postman.com/meta/instagram/folder/uxudqu0/send-api
- https://www.postman.com/meta/instagram/request/1rgmhuk/text-message
- https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
- https://developers.facebook.com/documentation/instagram-platform/webhooks

Live Meta permissions, webhook subscription and real end-to-end acceptance remain pending account authorization.
