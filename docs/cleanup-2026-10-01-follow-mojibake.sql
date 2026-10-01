-- Cleanup 2026-10-01: rows written with mojibake Thai by connect_private.receive_event
-- between ~2026-09-21 and the receive_event hotfix (docs/hotfix-2026-10-01-follow-mojibake.sql).
-- Run that hotfix FIRST, otherwise new rows keep arriving garbled.
--
-- ASCII-only on purpose (Thai as U&'\0E..'), same as the hotfix: pasting through a
-- Windows terminal cannot corrupt it. Matches the exact garbled strings only, never a pattern,
-- so real customer text is never touched.
--
-- Dry run (default) - shows counts, changes nothing:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < /tmp/cleanup.sql
-- Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v apply=1 < /tmp/cleanup.sql
--
-- Touches: inbox.message.content, inbox.conversation.last_message_preview, inbox.bot_decisions.text.
-- Not touched (counted only): connect_private.job payloads (already-sent notifications) and
-- inbox.crm_publish_outbox payloads (events already handed to CRM; re-publishing is a separate decision).
-- UPDATE on inbox.message fires no publish/stats triggers (those are AFTER INSERT only);
-- updating last_message_preview bumps conversation.updated_at via conversation_updated_at.

begin;

create temp table fix_label(k text primary key, bad text not null, good text not null) on commit drop;
insert into fix_label values
  ('nontext',
   U&'[\0E40\0E18\0082\0E40\0E19\0089\0E40\0E18\0E0D\0E40\0E18\0084\0E40\0E18\0E07\0E40\0E18\0E12\0E40\0E18\0E01\0E40\0E18\2014\0E40\0E18\0E15\0E40\0E19\0088\0E40\0E19\0084\0E40\0E18\0E01\0E40\0E19\0088\0E40\0E19\0083\0E40\0E18\008A\0E40\0E19\0088\0E40\0E18\0082\0E40\0E19\0089\0E40\0E18\0E0D\0E40\0E18\0084\0E40\0E18\0E07\0E40\0E18\0E12\0E40\0E18\0E01\0E40\0E18\2022\0E40\0E18\0E11\0E40\0E18\0E07\0E40\0E18\0E0D\0E40\0E18\0E11\0E40\0E18\0081\0E40\0E18\0E09\0E40\0E18\0E03]',
   U&'[\0E02\0E49\0E2D\0E04\0E27\0E32\0E21\0E17\0E35\0E48\0E44\0E21\0E48\0E43\0E0A\0E48\0E02\0E49\0E2D\0E04\0E27\0E32\0E21\0E15\0E31\0E27\0E2D\0E31\0E01\0E29\0E23]'),
  ('unfollow',
   U&'[\0E40\0E18\0E05\0E40\0E18\0E19\0E40\0E18\0081\0E40\0E18\0084\0E40\0E19\0089\0E40\0E18\0E12\0E40\0E18\009A\0E40\0E18\0E05\0E40\0E19\0087\0E40\0E18\0E0D\0E40\0E18\0081\0E40\0E18\009A\0E40\0E18\0E11\0E40\0E18\008D\0E40\0E18\008A\0E40\0E18\0E15]',
   U&'[\0E25\0E39\0E01\0E04\0E49\0E32\0E1A\0E25\0E47\0E2D\0E01\0E1A\0E31\0E0D\0E0A\0E35]'),
  ('follow',
   U&'[\0E40\0E18\0E05\0E40\0E18\0E19\0E40\0E18\0081\0E40\0E18\0084\0E40\0E19\0089\0E40\0E18\0E12\0E40\0E19\20AC\0E40\0E18\009E\0E40\0E18\0E14\0E40\0E19\0088\0E40\0E18\0E01\0E40\0E19\20AC\0E40\0E18\009E\0E40\0E18\0E17\0E40\0E19\0088\0E40\0E18\0E0D\0E40\0E18\0099]',
   U&'[\0E25\0E39\0E01\0E04\0E49\0E32\0E40\0E1E\0E34\0E48\0E21\0E40\0E1E\0E37\0E48\0E2D\0E19]'),
  ('follow_notify',
   U&'\0E40\0E19\20AC\0E40\0E18\009E\0E40\0E18\0E14\0E40\0E19\0088\0E40\0E18\0E01\0E40\0E19\20AC\0E40\0E18\009E\0E40\0E18\0E17\0E40\0E19\0088\0E40\0E18\0E0D\0E40\0E18\0099\0E40\0E19\0083\0E40\0E18\0E0B\0E40\0E18\0E01\0E40\0E19\0088',
   U&'\0E40\0E1E\0E34\0E48\0E21\0E40\0E1E\0E37\0E48\0E2D\0E19\0E43\0E2B\0E21\0E48');

-- sanity: each bad string must decode to a different, non-empty good string
do $$ begin
  if exists (select 1 from fix_label where bad = good or length(bad) < 2 * length(good)) then
    raise exception 'fix_label table looks wrong';
  end if;
end $$;

\echo '== before =='
select 'inbox.message' as tbl, f.k, count(m.*) as rows, min(m.created_at) as first_seen, max(m.created_at) as last_seen
  from fix_label f left join inbox.message m on m.content = f.bad group by f.k
union all
select 'inbox.conversation.preview', f.k, count(c.*), null, null
  from fix_label f left join inbox.conversation c on c.last_message_preview = f.bad group by f.k
union all
select 'inbox.bot_decisions', f.k, count(d.*), min(d.decided_at), max(d.decided_at)
  from fix_label f left join inbox.bot_decisions d on d.text = f.bad group by f.k
union all
select 'connect_private.job (not fixed)', f.k, count(j.*), min(j.send_after), max(j.send_after)
  from fix_label f left join connect_private.job j on j.payload->>'text' = f.bad group by f.k
union all
select 'inbox.crm_publish_outbox (not fixed)', f.k, count(o.*), null, null
  from fix_label f left join inbox.crm_publish_outbox o on o.payload::text like '%' || f.bad || '%' group by f.k
order by 1, 2;

update inbox.message m set content = f.good from fix_label f where m.content = f.bad;
update inbox.conversation c set last_message_preview = f.good from fix_label f where c.last_message_preview = f.bad;
update inbox.bot_decisions d set text = f.good from fix_label f where d.text = f.bad;

\echo '== garbled rows left (should all be 0) =='
select (select count(*) from inbox.message m join fix_label f on m.content = f.bad) as message,
       (select count(*) from inbox.conversation c join fix_label f on c.last_message_preview = f.bad) as preview,
       (select count(*) from inbox.bot_decisions d join fix_label f on d.text = f.bad) as bot_decisions;

\if :{?apply}
  commit;
  \echo '== APPLIED =='
\else
  rollback;
  \echo '== DRY RUN: rolled back. Re-run with -v apply=1 to keep the changes =='
\endif
