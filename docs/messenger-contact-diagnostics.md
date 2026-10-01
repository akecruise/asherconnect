# Messenger contact enrichment

The Messenger adapter now marks inbound customer events with `source_type: user`,
so the existing inbound worker extracts names and Thai mobile numbers from the
first message. Echoes remain separate. Existing database deduplication, webhook
signature verification, and the CRM `/internal/events` outbox remain in place.

Profile lookup uses bearer headers, matches fallback participants by exact PSID,
isolates caches by inbox and Page, and does not cache provider errors. Failed
fallback requests remain errors for the existing retry workflow. Phone extraction
rejects longer IDs and numbers joined across text or newlines.

## Offline verification

```bash
npm run test:messenger-contact
python3 -m unittest discover -s tests -p 'test_fb_crm_diagnostic.py'
npm run check
```

## Read-only diagnostics

From the project root, load real `FB_PAGE_TOKEN`, `FB_APP_ID`, and `FB_APP_TOKEN`
into the environment using your secret manager. Do not paste secrets into chat or
commit them. `FB_GRAPH_VERSION` optionally overrides the existing v23.0 default.

```bash
python3 fb-crm-diagnostic.py check-api
python3 fb-crm-diagnostic.py analyze-log --file webhook.jsonl
```

No pip dependencies are required. `check-api` calls Meta's token debugger and a
minimal identity lookup; it sends no messages and makes no CRM writes. Permission
presence is not proof of Page access, lead access, profile visibility, or App Review
approval. `analyze-log` accepts one raw webhook per line, or a `payload`/`body`
wrapper. It reports only counts, never message contents, tokens or customer IDs.
Exit codes: 0 = checks passed, 1 = a failed check or malformed/unrecognized log
record, 2 = configuration, network or file error.

## Limits and rollout

Names from message text require an explicit `ชื่อ:` or `name:` label. Unlabelled
text next to a phone is not a name, including "โทรกลับด้วย" and "ไม่ต้องโทร".
This extraction does not implement consent or a do-not-contact state.

These changes do not add Lead Ads ingestion, phone-request auto-messages, a new
CRM API, or support for landlines. The diagnostic can identify `leadgen` events,
but retrieving/mapping form fields needs a separate implementation. Existing
SQL sources in this checkout do not consume `extracted_name`/`extracted_phone`;
`receive_event` still extracts phones independently using `inbox.extract_phone`.
The Node enrichment fixes therefore do not prove names/phones reach CRM. Verify
the deployed DB definitions and implement that missing contract before rollout.
Unit tests use fake providers; they do not establish production token
permissions or end-to-end CRM delivery. Deploy through the existing release process
and verify a controlled Messenger message plus its CRM outbox result before
backfilling old records. Never replay production conversations simply to test.
