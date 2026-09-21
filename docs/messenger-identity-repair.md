# Messenger identity repair

This document is an audit and repair runbook only. The queries below are
read-only. No historical repair is executed by the P0 hotfix.

The canonical Messenger identity is `(inbox_id, customer PSID)`. The Page ID
is routing metadata and must never be stored as the customer's `external_id`.

## Read-only collision audit

Run these queries with a read-only database role. Replace the literals only
when narrowing the report; do not add `UPDATE`, `DELETE`, or `INSERT` to them.

```sql
-- Conversations containing more than one Messenger customer PSID.
select c.id as conversation_id, c.inbox_id,
       count(distinct ci.external_id) as psid_count,
       array_agg(distinct ci.external_id order by ci.external_id) as psids
from inbox.conversation c
join inbox.inbox i on i.id = c.inbox_id and i.channel = 'messenger'
join core.contact_identity ci
  on ci.contact_id = c.contact_id
 and ci.channel = 'messenger'
 and ci.account_key = c.inbox_id::text
group by c.id, c.inbox_id
having count(distinct ci.external_id) > 1;

-- Page IDs stored as Messenger customer external_id.
-- Supply the known Page IDs for the deployment in the VALUES list.
with pages(page_id) as (values ('PAGE_1'::text))
select ci.contact_id, ci.account_key as inbox_id, ci.external_id as page_id,
       c.id as conversation_id
from core.contact_identity ci
join pages p on p.page_id = ci.external_id
left join inbox.conversation c on c.contact_id = ci.contact_id
where ci.channel = 'messenger';

-- Multiple PSIDs mapped to one contact in one Messenger inbox.
select ci.account_key as inbox_id, ci.contact_id,
       count(distinct ci.external_id) as psid_count,
       array_agg(distinct ci.external_id order by ci.external_id) as psids
from core.contact_identity ci
where ci.channel = 'messenger'
group by ci.account_key, ci.contact_id
having count(distinct ci.external_id) > 1;

-- Meta review/test identity mixed with a normal customer identity.
-- Adjust the review PSID/code values to the deployment's documented fixtures.
with review(psid) as (values ('META_REVIEW_PSID'::text))
select r.psid as review_psid, ci.contact_id, ci.account_key as inbox_id,
       array_agg(distinct ci2.external_id order by ci2.external_id) as all_psids
from review r
join core.contact_identity ci on ci.external_id = r.psid
join core.contact_identity ci2
  on ci2.contact_id = ci.contact_id
 and ci2.channel = 'messenger'
 and ci2.account_key = ci.account_key
where ci.channel = 'messenger'
group by r.psid, ci.contact_id, ci.account_key
having count(distinct ci2.external_id) > 1;
```

## Controlled repair procedure

1. **Backup**: take and verify a database backup, including `core.contact_identity`,
   `inbox.conversation`, `inbox.message`, and dependent tables.
2. **Detect**: run every query above and save the results with a timestamp.
3. **Dry-run mapping**: produce a proposed PSID-to-contact and
   PSID-to-conversation mapping in a temporary review artifact; do not mutate
   production tables.
4. **Review**: obtain explicit owner approval for each mapping, including
   uncertain Page-ID and Meta-review cases.
5. **Split**: in a transaction, create the correct contact/conversation rows
   for each validated PSID and re-associate only the approved historical
   records. Never delete, merge, split, or rewrite message content without an
   approved per-row mapping.
6. **Verify**: rerun the collision queries, check message counts and event IDs,
   and replay the Messenger identity regression tests.
7. **Rollback**: if verification fails, restore the backup or execute the
   reviewed inverse mapping from the transaction log. Do not improvise a
   rollback from partial observations.

The P0 migration deliberately defers a hard unique constraint because existing
contaminated rows may already conflict. The receive boundary and exact
`(inbox_id, contact identity)` lookup provide the safe application protection
until cleanup is reviewed and complete.

