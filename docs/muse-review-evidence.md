# Follow-up to Muse design review

Scope: local source audit, not a production database/log audit. No customer data
or credentials were used. Changes have not been deployed.

## Confirmed and fixed locally

`lib/customer-contact-extraction.mjs` inferred names from any text remaining after
removing a phone. A synthetic reproduction returned `กลับด้วย` for
`โทรกลับด้วย 0812345678` and `ไม่ต้อง` for `ไม่ต้องโทร 0812345678`.
Removed this fallback. Name extraction now requires an explicit `ชื่อ:` or `name:`
label at a field boundary, and supports Thai combining marks. Unlabelled names
are intentionally left unchanged until a structured name-capture flow exists.
Tests cover both requests and refusals; no consent state is inferred by this fix.

## Existing mechanisms (source-confirmed, deployment unverified)

- `providers.mjs`: `RECEIVE_TYPES` includes referral and postback. The user-only
  gate in `server.mjs` controls contact extraction, not admission to `receive`.
  SQL `receive_event` maps referral to `other`; production first-touch behavior
  still needs integration verification, rather than assuming the event is dropped.
- `server.mjs`: signed webhook payloads are persisted before acknowledgement;
  `inboundWorker` processes them later. Do not acknowledge before durable storage.
- `sql/202609211200_messenger_identity_p0.sql`: atomic inbound-event insertion
  with `ON CONFLICT DO NOTHING`, plus advisory transaction locks scoped by inbox
  and customer identity. This is stronger evidence than assuming check-then-insert.
- `sql/202609211300_crm_publisher.sql`: persistent CRM outbox, unique event ID,
  leases, `FOR UPDATE SKIP LOCKED`, retry and dead-letter states already exist.
- `sql/202609221400_manual_name_guard.sql`: `profile_update` preserves manually
  set names and does not replace existing values with blanks. This alone does not
  prove manual edits originating in the separate CRM are reflected in Connect.

## Confirmed gaps requiring follow-up before rollout

Update: gaps 1–2 below are now fixed in local code by
`sql/20260929103510_contact_receive_contract.sql` and scoped Node callers.
See [contact-contract-fix.md](contact-contract-fix.md) for regression evidence and
rollout requirements. The descriptions below record the pre-fix findings;
production deployment and actual CRM consumer acceptance remain unverified.

1. `server.mjs` emits `extracted_name` and `extracted_phone`, but no SQL in this
   checkout consumes them. `receive_event` independently calls `inbox.extract_phone`.
   Passing Node tests is not evidence of CRM persistence. The earlier handoff's
   assumption that a consuming migration already existed was unsupported.
2. Messenger `writeProfile` calls `sync_contact_profile`. Its checked-in definition
   in `sql/022_contact_profile_sync.sql` selects by channel and external ID with
   `LIMIT 1`, without account scope. Page-scoped cache isolation is not sufficient
   to guarantee write isolation. Verify the deployed function before migrating.
3. Profile refresh is an idle-worker daily sweep with a batch of 100. The checked-in
   SQL records `profile_fetched_at` even for errors; there is no demonstrated
   per-contact bounded backoff by Graph error class. Removing the Node error cache
   does not establish reliable automatic recovery end-to-end.
4. Lead Ads form retrieval/mapping and persistent phone-request consent state are
   not implemented by this patch.

## Next verification

Use an isolated staging database and test Page to exercise the deployed SQL
definitions, first-touch referral, concurrent duplicate delivery, CRM rejection,
manual-name precedence, and profile failures followed by recovery. A refusal such
as "ไม่สะดวก" needs a scoped consent policy; it should not silently become a
permanent global do-not-contact flag without agreed semantics.

Local verification: 82 Messenger/profile/provider/extraction/CRM-publisher tests
passed after the name fix. Three diagnostic tests had passed in the prior step.
No live Graph API calls, database mutations, outbound customer messages, or deploy.
