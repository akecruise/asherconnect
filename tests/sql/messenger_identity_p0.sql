-- Messenger identity P0 regression self-test.
-- Run with: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1
begin;
do $$
declare
  ib uuid;
  project uuid;
  tag text := '__messenger_identity_sql_' || extract(epoch from clock_timestamp())::bigint;
  a text := tag || '_A';
  b text := tag || '_B';
  review text := tag || '_META_REVIEW_PSID';
  ra jsonb;
  rb jsonb;
  ra2 jsonb;
  re jsonb;
  before_contacts integer;
  after_contacts integer;
  ca uuid;
  cb uuid;
begin
  select id, project_id into ib, project from inbox.inbox
   where channel = 'messenger' and is_active order by created_at limit 1;
  if ib is null then raise exception 'no active Messenger inbox'; end if;

  perform core.resolve_identity('messenger', a, ib::text, 'Same Display Name', project);
  ra := connect_private.receive_event(jsonb_build_object(
    'inbox_id', ib, 'page_id', 'PAGE_1', 'customer_psid', a, 'external_id', a,
    'event_id', tag || '_a1', 'event_type', 'message', 'text', 'A one',
    'display_name', 'Same Display Name', 'is_standby', true), now());
  rb := connect_private.receive_event(jsonb_build_object(
    'inbox_id', ib, 'page_id', 'PAGE_1', 'customer_psid', b, 'external_id', b,
    'event_id', tag || '_b1', 'event_type', 'message', 'text', 'B one',
    'display_name', 'Same Display Name', 'is_standby', true), now());
  if ra->>'id' is null or rb->>'id' is null or ra->>'id' = rb->>'id'
    then raise exception 'PSID isolation failed: % / %', ra, rb; end if;
  ca := (ra->>'id')::uuid; cb := (rb->>'id')::uuid;

  ra2 := connect_private.receive_event(jsonb_build_object(
    'inbox_id', ib, 'page_id', 'PAGE_1', 'customer_psid', a, 'external_id', a,
    'event_id', tag || '_a2', 'event_type', 'message', 'text', 'A two',
    'display_name', 'Same Display Name', 'is_standby', true), now());
  if ra2->>'id' <> ca::text then raise exception 'same PSID did not reuse conversation'; end if;

  select count(*) into before_contacts from core.contact_identity
   where channel='messenger' and account_key=ib::text;
  re := connect_private.receive_event(jsonb_build_object(
    'inbox_id', ib, 'page_id', 'PAGE_1', 'customer_psid', 'PAGE_1', 'external_id', 'PAGE_1',
    'event_id', tag || '_page', 'event_type', 'message', 'text', 'bad'), now());
  select count(*) into after_contacts from core.contact_identity
   where channel='messenger' and account_key=ib::text;
  if re->>'error' <> 'IDENTITY_UNRESOLVED' or before_contacts <> after_contacts
    then raise exception 'Page identity contaminated: %', re; end if;

  select count(*) into before_contacts from core.contact_identity
   where channel='messenger' and account_key=ib::text;
  re := connect_private.receive_event(jsonb_build_object(
    'inbox_id', ib, 'page_id', 'PAGE_1', 'customer_psid', a, 'external_id', a,
    'event_id', tag || '_echo', 'event_type', 'echo', 'text', 'agent reply'), now());
  select count(*) into after_contacts from core.contact_identity
   where channel='messenger' and account_key=ib::text;
  if re->>'id' <> ca::text or before_contacts <> after_contacts
    then raise exception 'echo did not attach safely: %', re; end if;

  re := connect_private.receive_event(jsonb_build_object(
    'inbox_id', ib, 'page_id', 'PAGE_1', 'customer_psid', review, 'external_id', review,
    'event_id', tag || '_review', 'event_type', 'message', 'text', 'review'), now());
  if re->>'id' is null or re->>'id' = ca::text or re->>'id' = cb::text
    then raise exception 'review identity crossed customer boundary: %', re; end if;

  re := connect_private.receive_event(jsonb_build_object(
    'inbox_id', ib, 'page_id', 'PAGE_1', 'customer_psid', tag || '_missing',
    'external_id', tag || '_missing', 'event_id', tag || '_missing',
    'event_type', 'echo', 'text', 'ambiguous'), now());
  if re->>'error' <> 'IDENTITY_UNRESOLVED'
    then raise exception 'missing echo was guessed: %', re; end if;

  raise notice 'MESSENGER_IDENTITY_P0_PASS';
exception when others then
  delete from connect_private.inbound_event where event_id like tag || '%';
  delete from inbox.conversation where id in (ca, cb)
     or contact_id in (select contact_id from core.contact_identity where external_id like tag || '%');
  delete from core.contact_identity where external_id like tag || '%';
  raise;
end $$;
rollback;

