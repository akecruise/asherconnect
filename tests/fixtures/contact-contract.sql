-- Isolated PostgreSQL fixture: real receive/profile/outbox functions are loaded
-- by the runner. Unrelated bot scheduling and CRM lead creation are stubbed.
create schema core; create schema inbox; create schema connect_private;
create schema auth;
create function auth.jwt() returns jsonb language sql as $$ select '{"role":"service_role"}'::jsonb $$;
create role anon; create role authenticated; create role service_role;
create table core.contact (
 id uuid primary key default gen_random_uuid(), display_name text, phone text, email text,
 extra jsonb not null default '{}', anonymized_at timestamptz, updated_at timestamptz default now(),
 picture_url text, profile_status text, profile_fetched_at timestamptz, blocked boolean, blocked_at timestamptz
);
create table core.contact_identity (
 id uuid primary key default gen_random_uuid(), contact_id uuid references core.contact,
 channel text, external_id text, account_key text, unique(channel,account_key,external_id)
);
create table inbox.inbox (id uuid primary key, channel text, project_id uuid, is_active boolean default true);
create table inbox.conversation (
 id uuid primary key default gen_random_uuid(), inbox_id uuid, contact_id uuid,
 is_test boolean default false, mode text default 'human', last_reply_token text, last_reply_token_at timestamptz,
 last_bot_reply_at timestamptz, last_human_reply_at timestamptz, last_notified_at timestamptz,
 last_message_at timestamptz, ad_id text, ad_title text, status text, assignee_id uuid, sla_due_at timestamptz,
 created_at timestamptz default now()
);
create table inbox.message (
 id uuid primary key default gen_random_uuid(), conversation_id uuid, sender_type text, sender_id uuid,
 content text, content_type text, event_type text, external_message_id text, created_at timestamptz default now(),
 media jsonb, responder_user_id uuid, responder_display_name text
);
create table connect_private.inbound_event (inbox_id uuid,event_id text,event_type text,message_id uuid,unique(inbox_id,event_id));
create table connect_private.case_state(conversation_id uuid,waiting_since timestamptz);
create table connect_private.delivery(message_id uuid,provider_id text);
create table connect_private.webhook_log(id bigint);
create table inbox.bot_decisions(id bigserial,conversation_id uuid,message_id uuid,event_id text,topic text,
 reply_go boolean,reply_reason text,reply_wait_min int,notify_go boolean,notify_reason text,notify_action text,
 delay_sec int,text text,decided_at timestamptz);
create table inbox.crm_publish_outbox (
 event_id uuid primary key,event_type text,aggregate_type text,aggregate_id text,occurred_at timestamptz,payload jsonb
);
create function core.resolve_identity(text,text,text,text,uuid) returns uuid language sql as $$
 select contact_id from core.contact_identity where channel=$1 and external_id=$2 and account_key=$3
$$;
create function connect_private.ensure_lead(uuid) returns uuid language sql as $$ select null::uuid $$;
create function inbox.extract_phone(text) returns text language sql as $$ select null::text $$;
create function inbox.extract_line_id(text) returns text language sql as $$ select null::text $$;
create function inbox.cfg_bool(uuid,text,boolean) returns boolean language sql as $$ select false $$;
create function inbox.decide_all(uuid,jsonb,timestamptz,int) returns jsonb language sql as $$
 select '{"reply":{"go":false},"notify":{"go":false},"notify_action":"none","delay_sec":0}'::jsonb
$$;
create function connect_private.emit(uuid,text,jsonb,uuid) returns void language sql as $$ select $$;
