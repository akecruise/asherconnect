# TikTok DM handoff — 2026-09-23

## Status

| Gate | Result | Evidence |
| --- | --- | --- |
| TikTok API researched | Yes | [Primary-source research](./API-RESEARCH.md) |
| Isolated text/webhook adapter | Implemented with mocked tests | `lib/tiktok.mjs`, `tests/tiktok.test.mjs` |
| Full Connect code ready | No | Receiver/queue/CRM contract below remains |
| @ashercondo authorized | Unknown | No app or owner grant inspected |
| Live receive | No | Channel excluded from `activeChannels` |
| Live send | No | Channel excluded from `activeChannels` |
| Production enabled | No | No deploy, migration, subscription, or real message performed |

The repository had existing uncommitted UI and sender-identity work plus a separate Instagram feature branch. These were preserved. No production credentials or customer messages were used.

## Implemented locally

- TikTok's documented signature format, app/business destination checks, customer/business event separation, provider conversation/message IDs, and text send request/response handling are implemented in the isolated adapter.
- The adapter rejects stale/invalid signatures, other business accounts, missing conversation IDs, unsupported media sends, and unverified reply windows. It marks unconfirmed sends `uncertain` and never treats an HTTP response without a provider message ID as delivered. The current 48-hour guard is deliberately conservative; TikTok documents three further messages after that window for non-mutual-follow users, but the existing queue lacks the state needed to enforce that safely.
- The generic provider and profile paths use explicit channel dispatch. A TikTok message cannot be sent to Meta's Graph API. `activeChannels` still permits only implemented LINE/Messenger transports, so this staged adapter cannot receive or send live traffic.
- A blank, disabled TikTok example, a separate flag defaulting to false, channel labels, and a disabled admin health card are present. Existing Quick Replies insert text into the composer; no TikTok auto-send is enabled.

## Remaining implementation contracts

1. **Database identity and receiver:** Add a registered migration against the *installed* `connect_private.receive_event` definition. It must allow TikTok only after signed, account-scoped events, key deduplication by inbox/account plus provider message ID, and preserve later receiver fixes. Add an account-scoped mapping from TikTok `conversation_id` to the customer `unique_identifier` and Connect conversation. Never merge by username or display name. The current receiver handles LINE/Messenger only.
2. **Outbound queue:** Existing `delivery` jobs target the customer external ID; TikTok's send endpoint requires a `conversation_id`. Resolve it from the scoped mapping, preserve the server-authenticated actor ID/name, and reconcile API echoes by provider message ID, including echo-before-finish races. Do not infer a native TikTok staff name.
3. **Token lifecycle:** Complete secure storage and atomic refresh of the one-day account-holder token and one-year refresh token. Detect TikTok code `40105`, update health, and avoid logging credentials. Keep the app secret distinct from the account access token.
4. **Business rules and media:** Enforce reply count/window from authoritative conversation history or TikTok rejection; the isolated 48-hour check alone is insufficient. Add image support only after per-conversation capability and documented upload are wired. History listing is limited to 90-day conversations and 20 latest messages, so it is not a full backfill.
5. **CRM:** The current Connect publisher SQL allowlists only LINE/Messenger; extending the producer requires corresponding CRM provider validation/ingestion tests and account-scoped identity. Do not enable TikTok outbox publishing before both sides agree.
6. **UI:** The badge/name and disabled health card are present; a server-backed TikTok filter and a full message flow still depend on receiver/queue integration.

## Verification and release

`npm run test:tiktok` and `npm run check` passed locally. `npm test` stopped once at the pre-existing DB-backed `tests/outcomes.test.mjs` manual-label assertion (`unanswered` instead of `bot_only`); the same file passed on an immediate rerun without code changes. The remaining unit tests passed 119/119 and the HTTP integration suite passed 82/82 when run separately. These are local/mock checks only. Live E2E is **NOT RUN** because @ashercondo's API authorization and webhook subscription are unverified, and TikTok remains disabled.

For eventual release, follow [SETUP](./SETUP.md), the [deploy/rollback guide](../deploy.md), and a pre-deploy backup of both databases. Disable the TikTok channel and flag if rollout must stop; keep messages and audit rows. No production change was performed in this work.
