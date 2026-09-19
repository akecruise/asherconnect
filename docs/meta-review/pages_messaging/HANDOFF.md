# Meta Pages Messaging E2E Handoff

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
