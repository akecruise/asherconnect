-- Connect -> CRM durable publisher outbox.
-- This is intentionally separate from inbox.event_outbox: the CRM delivery
-- lifecycle needs leases/retries/dead letters and must not move the shared
-- event cursor used by other consumers.

create table if not exists inbox.crm_publish_outbox (
  id bigint generated always as identity primary key,
  event_id uuid not null unique,
  event_type text not null check (event_type in ('message.received', 'message.sent')),
  workspace_id uuid,
  producer text,
  aggregate_type text not null default 'conversation',
  aggregate_id text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'delivered', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  last_error_detail text,
  created_at timestamptz not null default now()
);
create index if not exists crm_publish_claim_idx
  on inbox.crm_publish_outbox (status, next_attempt_at, lease_until, id);
create index if not exists crm_publish_health_idx
  on inbox.crm_publish_outbox (status, created_at);

comment on table inbox.crm_publish_outbox is
  'Durable Connect -> CRM publisher queue. Rows survive process restart and are never deleted on failure.';

create or replace function inbox.crm_publish_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, inbox, core as $$
declare
  v_inbox inbox.inbox;
  v_conversation inbox.conversation;
  v_identity core.contact_identity;
  v_sender_kind text;
  v_event_type text;
  v_event_id uuid;
  v_payload jsonb;
begin
  if NEW.sender_type not in ('contact', 'agent', 'bot') then
    return NEW;
  end if;

  select * into v_conversation from inbox.conversation where id = NEW.conversation_id;
  if not found then return NEW; end if;
  select * into v_inbox from inbox.inbox where id = v_conversation.inbox_id;
  if not found or v_inbox.channel not in ('line', 'messenger') then return NEW; end if;

  select * into v_identity
    from core.contact_identity
   where contact_id = v_conversation.contact_id
     and channel = v_inbox.channel
     and account_key = v_inbox.id::text
   order by id
   limit 1;

  v_sender_kind := case NEW.sender_type when 'contact' then 'customer' when 'agent' then 'human' else 'bot' end;
  v_event_type := case NEW.sender_type when 'contact' then 'message.received' else 'message.sent' end;
  v_event_id := NEW.id;
  v_payload := jsonb_build_object(
    'conversation_id', NEW.conversation_id::text,
    'provider', v_inbox.channel,
    'account_scope', v_inbox.id::text,
    'external_id', v_identity.external_id,
    'message_id', NEW.id::text,
    'sender_kind', v_sender_kind,
    'sender_id', case when NEW.sender_id is null then null else NEW.sender_id::text end,
    'agent_id', case when NEW.sender_type = 'agent' and NEW.sender_id is not null then NEW.sender_id::text else null end
  );

  insert into inbox.crm_publish_outbox
    (event_id, event_type, aggregate_id, occurred_at, payload)
  values (v_event_id, v_event_type, NEW.conversation_id::text, NEW.created_at, v_payload)
  on conflict (event_id) do nothing;
  return NEW;
exception when others then
  -- CRM publishing is an integration concern. A bad/missing identity must
  -- not roll back Connect's customer message transaction.
  return NEW;
end $$;

drop trigger if exists trg_crm_publish_message on inbox.message;
create trigger trg_crm_publish_message
  after insert on inbox.message
  for each row execute function inbox.crm_publish_message();

create or replace function inbox.crm_publish_claim(p_limit integer default 20, p_lease_seconds integer default 60)
returns setof inbox.crm_publish_outbox language plpgsql security definer
set search_path = pg_catalog, public, inbox as $$
begin
  return query
    update inbox.crm_publish_outbox q
       set status = 'processing',
           attempts = q.attempts + 1,
           lease_until = now() + make_interval(secs => greatest(1, p_lease_seconds))
     where q.id in (
       select id from inbox.crm_publish_outbox
        where (status = 'pending' and next_attempt_at <= now())
           or (status = 'processing' and lease_until < now())
        order by id
        for update skip locked
        limit greatest(1, least(p_limit, 100))
     )
    returning *;
end $$;

create or replace function inbox.crm_publish_finish(
  p_id bigint, p_status text, p_error_code text default null,
  p_error_detail text default null, p_next_attempt_at timestamptz default null)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, inbox as $$
begin
  update inbox.crm_publish_outbox
     set status = case when p_status = 'delivered' then 'delivered'
                       when p_status = 'dead_letter' then 'dead_letter'
                       when p_status = 'retry' and attempts >= 6 then 'dead_letter'
                       else 'pending' end,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
         lease_until = null,
         next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at),
         last_error_code = p_error_code,
         last_error_detail = left(p_error_detail, 1000)
   where id = p_id and status = 'processing';
  return found;
end $$;

create or replace function inbox.crm_publish_stats()
returns jsonb language sql security definer
set search_path = pg_catalog, public, inbox as $$
  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'processing', count(*) filter (where status = 'processing'),
    'delivered', count(*) filter (where status = 'delivered'),
    'dead_letter', count(*) filter (where status = 'dead_letter'),
    'last_success_at', max(delivered_at),
    'last_error_at', max(created_at) filter (where last_error_code is not null),
    'oldest_pending_at', min(created_at) filter (where status in ('pending','processing'))
  ) from inbox.crm_publish_outbox;
$$;

revoke all on function inbox.crm_publish_claim(integer, integer) from public, anon, authenticated;
revoke all on function inbox.crm_publish_finish(bigint, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function inbox.crm_publish_stats() from public, anon, authenticated;
grant execute on function inbox.crm_publish_claim(integer, integer) to service_role;
grant execute on function inbox.crm_publish_finish(bigint, text, text, text, timestamptz) to service_role;
grant execute on function inbox.crm_publish_stats() to service_role;
