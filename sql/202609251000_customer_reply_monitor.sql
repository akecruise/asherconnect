-- Customer reply monitor
--
-- Uses the existing message, delivery, conversation, job and human-reply
-- signal tables.  It adds only the durable alert ledger and the read/worker
-- functions needed to make the existing watchdog episode-aware.

begin;

create table if not exists inbox.reply_alert (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references inbox.conversation(id) on delete cascade,
  reply_episode_message_id uuid not null references inbox.message(id) on delete cascade,
  alert_level           text not null,
  status                text not null default 'pending'
                        check (status in ('pending','processing','sent','cancelled','failed')),
  job_id                bigint references connect_private.job(id) on delete set null,
  created_at             timestamptz not null default now(),
  sent_at                timestamptz,
  cancelled_at           timestamptz,
  last_error             text,
  unique (conversation_id, reply_episode_message_id, alert_level)
);

create index if not exists reply_alert_open_idx
  on inbox.reply_alert(conversation_id, status)
  where status in ('pending','processing');

alter table inbox.reply_alert enable row level security;
revoke all on inbox.reply_alert from public, anon, authenticated;
grant select, insert, update, delete on inbox.reply_alert to service_role;

-- A human reply is successful only when the existing outbound delivery says
-- sent, or when the provider delivered an external page echo that was already
-- classified by receive_event as a human reply.  A queued/failed agent row is
-- deliberately not enough.
create or replace function inbox.reply_message_delivered(p_message_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from inbox.message m
      left join connect_private.delivery d on d.message_id = m.id
     where m.id = p_message_id
       and m.sender_type = 'agent'
       and (
         d.status = 'sent'
         or exists (
           select 1
             from inbox.human_reply_events h
            where h.conversation_id = m.conversation_id
              and h.created_at = m.created_at
              and h.source in ('echo','page_inbox','other_app')
         )
       )
  )
$$;

-- Local installs can be one migration behind the full SLA stack.  Prefer the
-- existing business-time function when it is present; otherwise keep the
-- monitor usable with UTC elapsed minutes until sql/023 is applied.
create or replace function inbox.monitor_elapsed_minutes(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_result integer;
begin
  if to_regprocedure('inbox.sla_elapsed_minutes(timestamp with time zone,timestamp with time zone)') is not null then
    execute 'select inbox.sla_elapsed_minutes($1,$2)' into v_result using p_from, p_to;
    return coalesce(v_result, 0);
  end if;
  return greatest(0, floor(extract(epoch from (p_to - p_from)) / 60))::integer;
end
$$;

create or replace function inbox.monitor_sla_minutes()
returns integer
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_result integer;
begin
  if to_regprocedure('inbox.setting_int(text,integer)') is not null then
    execute 'select inbox.setting_int($1,$2)' into v_result using 'sla_minutes', 10;
    return coalesce(v_result, 10);
  end if;
  return 10;
end
$$;

-- Keep the existing reporting API aligned with delivery truth.  Bot answers
-- remain report answers, but an agent row that never reached the provider is
-- excluded from the episode just like it is in the monitor.
create or replace function inbox.reply_episodes(p_from timestamptz, p_to timestamptz)
returns table (
  conversation_id uuid, channel text, customer_name text,
  asked_at timestamptz, asked_text text,
  answered_at timestamptz, responder text, minutes numeric, fallback boolean
)
language sql stable
set search_path = pg_catalog, public
as $$
with m as (
  select msg.id, msg.conversation_id, msg.created_at, msg.sender_type, msg.sender_id, msg.content,
         lag(msg.sender_type) over (partition by msg.conversation_id order by msg.created_at, msg.id) as prev
    from inbox.message msg
   where msg.created_at >= p_from - interval '2 days'
     and msg.created_at < p_to
     and msg.sender_type in ('contact','agent','bot')
     and (msg.sender_type <> 'agent' or inbox.reply_message_delivered(msg.id))
), episodes as (
  select m.conversation_id, m.created_at as asked_at, m.content as asked_text
    from m
   where m.sender_type = 'contact' and (m.prev is null or m.prev <> 'contact')
), answered as (
  select e.*, r.created_at as answered_at,
         case when r.sender_type = 'bot' then 'bot'
              else coalesce(st.name, u.email, 'unknown') end as responder,
         false as fallback
    from episodes e
    left join lateral (
      select msg.created_at, msg.sender_type, msg.sender_id
        from inbox.message msg
       where msg.conversation_id = e.conversation_id
         and msg.sender_type in ('agent','bot')
         and (msg.sender_type <> 'agent' or inbox.reply_message_delivered(msg.id))
         and msg.created_at > e.asked_at
       order by msg.created_at, msg.id
       limit 1
    ) r on true
    left join inbox.sales_staff st on st.user_id = r.sender_id
    left join core."user" u on u.id = r.sender_id
), patched as (
  select a.conversation_id, a.asked_at, a.asked_text,
         coalesce(a.answered_at, case when c.last_human_reply_at > a.asked_at then c.last_human_reply_at end) as answered_at,
         case when a.answered_at is not null then a.responder
              when c.last_human_reply_at > a.asked_at then 'unknown' end as responder,
         (a.answered_at is null and c.last_human_reply_at > a.asked_at) as fallback,
         i.channel, ct.display_name
    from answered a
    join inbox.conversation c on c.id = a.conversation_id and not c.is_test
    join inbox.inbox i on i.id = c.inbox_id
    join core.contact ct on ct.id = c.contact_id
)
select p.conversation_id, p.channel, p.display_name, p.asked_at, p.asked_text,
       p.answered_at, p.responder,
       case when p.answered_at is null then null else round((extract(epoch from (p.answered_at - p.asked_at)) / 60)::numeric, 1) end,
       p.fallback
  from patched p
 where (p.answered_at >= p_from and p.answered_at < p_to)
    or (p.answered_at is null and p.asked_at >= p_from and p.asked_at < p_to)
 order by p.asked_at
$$;

-- Read model for the monitor and for the local preview.  The first customer
-- message after the last successful human reply is the episode clock.  More
-- customer messages in that same episode do not reset it.
create or replace function inbox.pending_reply_snapshot(
  p_now timestamptz default now(),
  p_limit integer default 200
)
returns table (
  conversation_id uuid,
  inbox_id uuid,
  reply_episode_message_id uuid,
  customer_name text,
  assignee text,
  assignee_id uuid,
  channel text,
  external_id text,
  asked_at timestamptz,
  asked_text text,
  waiting_minutes integer,
  raw_waiting_minutes integer,
  sla_minutes integer,
  chat_url text,
  is_test boolean
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
with last_human as (
  select c.id as conversation_id,
         greatest(
           c.last_human_reply_at,
           (select max(m.created_at)
              from inbox.message m
             where m.conversation_id = c.id
               and m.sender_type = 'agent'
               and inbox.reply_message_delivered(m.id))
         ) as answered_at
    from inbox.conversation c
), pending as (
  select c.id as conversation_id, c.inbox_id, c.contact_id, c.assignee_id,
         c.is_test, lh.answered_at, i.channel,
         ep.id as episode_message_id, ep.created_at as asked_at, ep.content as asked_text
    from inbox.conversation c
    join inbox.inbox i on i.id = c.inbox_id and i.is_active
    join last_human lh on lh.conversation_id = c.id
    join lateral (
      select m.id, m.created_at, m.content
        from inbox.message m
       where m.conversation_id = c.id
         and m.sender_type = 'contact'
         and m.event_type in ('message','postback')
         and (lh.answered_at is null or (m.created_at, m.id) > (lh.answered_at, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
       order by m.created_at, m.id
       limit 1
    ) ep on true
   where c.status <> 'resolved'
     and not c.is_test
), identity as (
  select p.*, ci.external_id,
         ct.display_name,
         coalesce(nullif(btrim(pr.display_name), ''), nullif(btrim(u.email), '')) as assignee_name,
         inbox.monitor_elapsed_minutes(p.asked_at, p_now) as business_waiting_minutes,
         extract(epoch from (p_now - p.asked_at)) / 60 as wall_waiting_minutes,
         inbox.monitor_sla_minutes() as configured_sla
    from pending p
    join core.contact ct on ct.id = p.contact_id
    left join core.contact_identity ci
      on ci.contact_id = p.contact_id
     and ci.channel = p.channel
     and ci.account_key = p.inbox_id::text
    left join core.profile pr on pr.user_id = p.assignee_id and pr.is_active
    left join core."user" u on u.id = p.assignee_id
)
select i.conversation_id, i.inbox_id, i.episode_message_id,
       coalesce(nullif(btrim(i.display_name), ''), 'ลูกค้า') as customer_name,
       i.assignee_name, i.assignee_id, i.channel, i.external_id,
       i.asked_at, i.asked_text,
       greatest(0, i.business_waiting_minutes)::integer,
       greatest(0, floor(i.wall_waiting_minutes))::integer,
       i.configured_sla,
       case when i.channel = 'messenger' then 'https://business.facebook.com/latest/inbox/all'
            when i.channel = 'line' then 'https://chat.line.biz/'
            when i.channel = 'instagram' then 'https://www.instagram.com/direct/inbox/'
            else null end,
       i.is_test
  from identity i
 order by i.asked_at, i.conversation_id
 limit greatest(1, least(coalesce(p_limit, 200), 1000))
$$;

-- Authenticated preview used by the local UI/CLI.  The service worker calls
-- the underlying function directly, while can_read remains the user boundary.
create or replace function inbox.pending_reply_preview(
  p_now timestamptz default now(),
  p_limit integer default 200
)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_role text := (auth.jwt()->>'role'); v_rows jsonb;
begin
  if v_role not in ('authenticated','service_role') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_rows
    from (
      select s.*
        from inbox.pending_reply_snapshot(p_now, p_limit) s
       where v_role = 'service_role'
          or connect_private.can_read(s.conversation_id)
       order by s.asked_at, s.conversation_id
    ) x;
  return jsonb_build_object('generated_at', p_now, 'timezone', 'Asia/Bangkok', 'rows', v_rows);
end
$$;

-- The old view treated every inserted agent row as an answer, including rows
-- whose delivery later failed.  Keep the same public shape but use the durable
-- success signal and the existing human-reply fallback.
create or replace view inbox.case_status as
select c.id as conversation_id, c.inbox_id, c.status as conversation_status,
       w.waiting_since,
       case when c.status = 'resolved' then 'closed'
            when w.waiting_since is null then 'wait'
            when inbox.monitor_elapsed_minutes(w.waiting_since, now()) >= inbox.monitor_sla_minutes() then 'late'
            else 'new' end as case_status,
       case when c.is_test then null
            when c.status = 'resolved' or w.waiting_since is null then null
            else inbox.monitor_elapsed_minutes(w.waiting_since, now()) end as waiting_minutes,
       inbox.monitor_sla_minutes() as sla_minutes,
       c.is_test
  from inbox.conversation c
  left join lateral (
    select min(m.created_at) as waiting_since
      from inbox.message m
     where m.conversation_id = c.id
       and m.sender_type = 'contact'
       and m.event_type in ('message','postback')
       and m.created_at > greatest(
         coalesce(c.last_human_reply_at, '-infinity'::timestamptz),
         coalesce((select max(m2.created_at) from inbox.message m2
                    where m2.conversation_id = c.id
                      and m2.sender_type = 'agent'
                      and inbox.reply_message_delivered(m2.id)), '-infinity'::timestamptz)
       )
  ) w on true;

-- Human reply signals cancel pending monitor jobs as well as the old bot/send
-- jobs.  The guard below handles the small processing race before provider I/O.
create or replace function inbox.reply_alert_on_human_reply()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  update inbox.reply_alert
     set status = 'cancelled', cancelled_at = new.created_at
   where conversation_id = new.conversation_id
     and status in ('pending','processing');
  update connect_private.job
     set status = 'skipped', skip_reason = 'human_replied', finished_at = new.created_at,
         lease_id = null
   where conversation_id = new.conversation_id
     and kind = 'notify'
     and status = 'pending';
  return new;
end
$$;

drop trigger if exists reply_alert_on_human_reply on inbox.human_reply_events;
create trigger reply_alert_on_human_reply
after insert on inbox.human_reply_events
for each row execute function inbox.reply_alert_on_human_reply();

-- Last check immediately before notify delivery.  It prevents an alert that
-- was claimed milliseconds before a human reply from being sent afterwards.
create or replace function inbox.reply_alert_current(p_alert_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from inbox.reply_alert a
      join inbox.pending_reply_snapshot(now(), 1000) p
        on p.conversation_id = a.conversation_id
       and p.reply_episode_message_id = a.reply_episode_message_id
     where a.id = p_alert_id
       and a.status in ('pending','processing')
  )
$$;

-- Keep the alert ledger in step with the existing generic job worker.
create or replace function inbox.reply_alert_job_sync()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_alert uuid := nullif(new.payload->>'alert_id','')::uuid;
begin
  if new.kind = 'notify' and v_alert is not null then
    update inbox.reply_alert
       set status = case new.status when 'done' then 'sent'
                                    when 'failed' then 'failed'
                                    when 'skipped' then 'cancelled'
                                    else status end,
           sent_at = case when new.status = 'done' then coalesce(sent_at, new.finished_at, now()) else sent_at end,
           last_error = new.last_error,
           cancelled_at = case when new.status = 'skipped' then coalesce(cancelled_at, new.finished_at, now()) else cancelled_at end
     where id = v_alert;
  end if;
  return new;
end
$$;

drop trigger if exists reply_alert_job_sync on connect_private.job;
create trigger reply_alert_job_sync
after update on connect_private.job
for each row execute function inbox.reply_alert_job_sync();

-- Episode-aware replacement for the existing watchdog.  It keeps the existing
-- notify job/worker and settings, but deduplicates by conversation + episode +
-- alert level and rechecks the episode under a transaction lock.
create or replace function inbox.watchdog(p_now timestamptz)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare r record; v_checked int := 0; v_notified int := 0; v_alert uuid; v_job bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('asher-connect.customer-reply-watchdog', 0)) then
    return jsonb_build_object('checked', 0, 'notified', 0, 'locked', true);
  end if;
  for r in
    select p.*, inbox.cfg_bool(p.inbox_id, 'notify.watchdog.enabled', false) as enabled,
           inbox.cfg_int(p.inbox_id, 'notify.watchdog.after_min', 120) as after_min
      from inbox.pending_reply_snapshot(p_now, 1000) p
     order by p.asked_at, p.conversation_id
  loop
    v_checked := v_checked + 1;
    if not r.enabled or r.raw_waiting_minutes < r.after_min then continue; end if;

    insert into inbox.reply_alert(conversation_id, reply_episode_message_id, alert_level, status)
    values (r.conversation_id, r.reply_episode_message_id, 'watchdog', 'pending')
    on conflict (conversation_id, reply_episode_message_id, alert_level) do nothing
    returning id into v_alert;
    if v_alert is null then continue; end if;

    insert into connect_private.job(kind, channel, inbox_id, conversation_id, payload, send_after)
    values ('notify', 'team', r.inbox_id, r.conversation_id,
            jsonb_build_object(
              'kind','watchdog', 'alert_id',v_alert,
              'reply_episode_message_id',r.reply_episode_message_id,
              'alert_level','watchdog', 'min_since_msg',r.raw_waiting_minutes,
              'waiting_since',r.asked_at, 'text',left(r.asked_text,200),
              'display_name',r.customer_name, 'assignee',r.assignee,
              'channel',r.channel, 'chat_url',r.chat_url,
              'is_test',r.is_test), p_now)
    returning id into v_job;
    update inbox.reply_alert set job_id = v_job, status = 'processing'
     where id = v_alert and status = 'pending';
    update inbox.conversation set last_notified_at = p_now where id = r.conversation_id;
    v_notified := v_notified + 1;
  end loop;
  return jsonb_build_object('checked', v_checked, 'notified', v_notified, 'timezone', 'Asia/Bangkok');
end
$$;

revoke all on function inbox.reply_message_delivered(uuid), inbox.monitor_elapsed_minutes(timestamptz,timestamptz), inbox.monitor_sla_minutes(), inbox.pending_reply_snapshot(timestamptz,integer),
  inbox.pending_reply_preview(timestamptz,integer), inbox.reply_alert_current(uuid), inbox.watchdog(timestamptz)
  from public, anon;
grant execute on function inbox.pending_reply_preview(timestamptz,integer), inbox.reply_alert_current(uuid) to authenticated;
grant execute on function inbox.reply_message_delivered(uuid), inbox.monitor_elapsed_minutes(timestamptz,timestamptz), inbox.monitor_sla_minutes(), inbox.pending_reply_snapshot(timestamptz,integer), inbox.watchdog(timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
