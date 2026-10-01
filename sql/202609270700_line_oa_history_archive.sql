-- Preserve LINE OA Manager history even when its chat ID cannot yet be mapped
-- to a Messaging API user ID. These private tables are not exposed to clients.
begin;

create table if not exists connect_private.line_oa_chat_archive (
  bot_id text not null,
  chat_id text not null,
  profile_name text,
  profile_user_id text,
  source_updated_at timestamptz,
  last_scanned_at timestamptz,
  scan_complete boolean not null default false,
  event_count integer not null default 0,
  primary key (bot_id, chat_id)
);

create table if not exists connect_private.line_oa_event_archive (
  bot_id text not null,
  chat_id text not null,
  event_key text not null,
  event_type text not null,
  event_at timestamptz not null,
  message_type text,
  text_content text,
  owner_biz_id text,
  owner_name text,
  raw jsonb not null,
  archived_at timestamptz not null default now(),
  primary key (bot_id, chat_id, event_key),
  foreign key (bot_id, chat_id)
    references connect_private.line_oa_chat_archive (bot_id, chat_id)
    on delete cascade
);

create index if not exists line_oa_event_archive_at_idx
  on connect_private.line_oa_event_archive (bot_id, event_at desc);
create index if not exists line_oa_event_archive_owner_idx
  on connect_private.line_oa_event_archive (bot_id, owner_biz_id, event_at desc)
  where owner_biz_id is not null;

alter table connect_private.line_oa_chat_archive enable row level security;
alter table connect_private.line_oa_event_archive enable row level security;
revoke all on connect_private.line_oa_chat_archive from public, anon, authenticated;
revoke all on connect_private.line_oa_event_archive from public, anon, authenticated;

commit;
