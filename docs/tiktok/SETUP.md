# TikTok @ashercondo → ASHER Connect setup

Checked 2026-09-23 against [TikTok Business Messaging API research](./API-RESEARCH.md). This is a staged integration. The current Connect receiver and database are **not activated for TikTok**; do not set `enabled: true` or `CONNECT_TIKTOK_ENABLED=true` yet.

## Account and app prerequisites

1. Verify that `@ashercondo` is a TikTok **Business Account**, and determine its **sign-up region**. Accounts signed up in the EEA, Switzerland, or UK cannot use this API. Do not infer the sign-up region from where the team is located. [TikTok access guide](https://business-api.tiktok.com/portal/docs?id=1832184145137922)
2. Create or identify the TikTok for Business developer app. Select **Business Messaging**, submit TikTok's Business Messaging access request, and complete Data Security & Privacy Review. US-sign-up accounts have additional US review/Addendum requirements. [Access guide](https://business-api.tiktok.com/portal/docs?id=1832184145137922)
3. Set the account to accept DMs from **Everyone** before authorization. Have the account owner approve the four Business Messaging permissions using the account-holder authorization URL from **My Apps → App Detail → Basic Information**. Check the resulting token scopes; the documented example includes `message.list.send`, `message.list.read`, `message.list.manage`, and `user.account.type`, but the actual grant is authoritative. [Authorization](https://business-api.tiktok.com/portal/docs?id=1832184159540418); [webhooks](https://business-api.tiktok.com/portal/docs?id=1832190670631937)
4. Exchange the one-time code within ten minutes at TikTok's account-holder OAuth endpoint. Use the returned `open_id` as `account_id`/`business_id`; **`@ashercondo` is not an account ID**. Access tokens last one day; refresh tokens last one year. The token rotation/persistence workflow still needs to be completed before production activation. [Authentication](https://business-api.tiktok.com/portal/docs?id=1832184175482945)

## Planned Connect configuration

The inert example is in `channels.example.json` as `asher-tiktok`. Keep real tokens in server-side `channels.json` only; never paste them into chat or commit them. The `app_id` is the developer app's `client_key` in webhooks, and `account_id` is the authorized business `open_id`. The app secret is used to verify the `TikTok-Signature` header. The configuration format and token refresh fields will be finalized with the live authorization flow.

The OAuth **Advertiser redirect URL** is now implemented as an inert callback route:

`https://inbox.apluscondo.com/api/integrations/tiktok/oauth/callback`

It accepts TikTok's redirect and never logs, exchanges, or stores the authorization code yet. This makes the URL real without opening TikTok messaging before receiver, outbound queue, token lifecycle, and CRM work are complete. The route returns a clear status page until that flow is activated.

This is separate from the webhook URL. The planned webhook, derived from the existing `/webhooks/<channel-key>` route and the production public domain in `docs/deploy.md`, is:

`https://inbox.apluscondo.com/webhooks/asher-tiktok`

TikTok creates the `DIRECT_MESSAGE` webhook subscription once per developer app with `/business/webhook/update/` using `app_id`, app `secret`, `event_type`, and `callback_url`. **Do not subscribe this callback yet:** the channel remains inactive and a webhook would not be ingested. [Webhook setup](https://business-api.tiktok.com/portal/docs?id=1832190670631937)

## Acceptance gate before activation

- Confirm approved app, DSPR, eligible Business Account, owner authorization, real `open_id`, and actual token scopes.
- Merge and verify the outstanding Instagram/UI work, then finish the TikTok database receiver, account-scoped thread mapping, queue target lookup, CRM ingestion contract, token rotation, and HTTP integration tests.
- Back up both Connect/Supabase and CRM databases. Review `node sql/run.mjs plan` against the installed ledger before any migration. Follow [the repository's deploy and rollback procedure](../deploy.md), which deploys from a commit and preserves `.env`, `channels.json`, and sessions.
- Use an **authorized internal test account** to send the first DM. Verify exactly one conversation, correct assignee/SLA, one human reply with the logged-in responder's identity, native TikTok reply attribution, duplicate delivery, invalid signature, wrong business ID, expiration/rate-limit handling, and no false sent/read status. Do not send test messages to customers.

Until these checks pass, TikTok is **not connected**. The admin health card should report disabled/pending, not healthy.
