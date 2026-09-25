-- Reconcile replies sent from LINE Official Account Manager.
--
-- LINE Messaging API webhooks contain customer events, but do not echo manual
-- operator replies from chat.line.biz.  The backfill client supplies the
-- durable LINE message id, operator business id and provider timestamp.

begin;

alter table inbox.human_reply_events
  add column if not exists external_event_id text;

alter table inbox.human_reply_events
  drop constraint if exists human_reply_events_source_check;
alter table inbox.human_reply_events
  add constraint human_reply_events_source_check
  check (source in ('workspace','echo','group_cmd','api','page_inbox','other_app','line_oa_backfill'));

create unique index if not exists human_reply_events_external_event_idx
  on inbox.human_reply_events(conversation_id, source, external_event_id)
  where external_event_id is not null;

-- Provider events can arrive out of order.  Never move the human-reply clock
-- backwards; all existing callers continue to converge on this one function.
create or replace function connect_private.mark_human_reply(
  p_conversation uuid, p_staff uuid, p_source text,
  p_now timestamptz default now(), p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_cancelled int := 0;
begin
  update inbox.conversation
     set last_human_reply_at = greatest(last_human_reply_at, p_now)
   where id = p_conversation;

  with x as (
    update connect_private.job
       set status = 'skipped', skip_reason = 'human_replied', finished_at = p_now
     where conversation_id = p_conversation
       and kind in ('generate','send') and status = 'pending'
     returning 1)
  select count(*) into v_cancelled from x;

  update connect_private.case_state set waiting_since = null
   where conversation_id = p_conversation;

  insert into inbox.human_reply_events(conversation_id, staff_id, source, note, created_at)
  values (p_conversation, p_staff, p_source, p_note, p_now);

  return jsonb_build_object('ok', true, 'cancelled_jobs', v_cancelled);
end
$$;

-- Cancel only the alert episode that existed before this reply.  This keeps a
-- late historical event from closing a newer customer episode.
create or replace function inbox.reply_alert_on_human_reply()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  with cancelled as (
    update inbox.reply_alert a
       set status = 'cancelled', cancelled_at = new.created_at
      from inbox.message episode
     where a.conversation_id = new.conversation_id
       and a.reply_episode_message_id = episode.id
       and episode.created_at < new.created_at
       and a.status in ('pending','processing')
     returning a.job_id
  )
  update connect_private.job j
     set status = 'skipped', skip_reason = 'human_replied', finished_at = new.created_at,
         lease_id = null
   where j.id in (select job_id from cancelled where job_id is not null)
     and j.kind = 'notify' and j.status = 'pending';
  return new;
end
$$;

create or replace function connect_private.backfill_line_oa_reply(
  p_inbox uuid,
  p_external_id text,
  p_display_name text,
  p_event_id text,
  p_replied_at timestamptz,
  p_staff_external_id text,
  p_staff_name text,
  p_text text default null,
  p_content_type text default 'text')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inbox inbox.inbox;
  v_contact uuid;
  v_conversation uuid;
  v_message uuid;
  v_staff uuid;
  v_latest_customer timestamptz;
  v_cancelled int := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_only' using errcode='42501';
  end if;
  if coalesce(btrim(p_external_id),'') = ''
     or coalesce(btrim(p_event_id),'') = ''
     or p_replied_at is null then
    raise exception 'invalid_event';
  end if;

  select * into v_inbox from inbox.inbox
   where id = p_inbox and channel = 'line' and is_active;
  if not found then raise exception 'channel_not_configured'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_inbox::text || ':' || p_external_id, 0));
  select ci.contact_id into v_contact
    from core.contact_identity ci
   where ci.channel = 'line'
     and ci.account_key = p_inbox::text
     and ci.external_id = p_external_id;
  if v_contact is null then
    return jsonb_build_object('matched',false,'reason','identity_not_found');
  end if;
  select id into v_conversation from inbox.conversation
   where inbox_id = p_inbox and contact_id = v_contact
   order by created_at desc limit 1 for update;
  if v_conversation is null then
    return jsonb_build_object('matched',false,'reason','conversation_not_found');
  end if;

  if exists (
    select 1 from inbox.message
     where conversation_id = v_conversation and external_message_id = p_event_id
  ) then
    return jsonb_build_object('duplicate', true, 'conversation_id', v_conversation);
  end if;

  select si.staff_id into v_staff
    from inbox.sales_staff_identity si
   where si.channel = 'line_oa' and si.external_id = p_staff_external_id;
  if v_staff is null and nullif(btrim(p_staff_name),'') is not null then
    select s.id into v_staff from inbox.sales_staff s
     where s.is_active and lower(btrim(s.name)) = lower(btrim(p_staff_name))
     order by s.created_at limit 1;
  end if;

  perform set_config('connect.replay','on',true);
  insert into inbox.message(
    conversation_id, sender_type, sender_id, content, content_type,
    event_type, external_message_id, delivered_at, created_at)
  values (
    v_conversation, 'agent',
    (select user_id from inbox.sales_staff where id = v_staff),
    coalesce(nullif(p_text,''), '[ตอบผ่าน LINE OA]'),
    coalesce(nullif(p_content_type,''),'text'), 'message', p_event_id,
    p_replied_at, p_replied_at)
  returning id into v_message;

  update inbox.conversation
     set last_human_reply_at = greatest(last_human_reply_at, p_replied_at)
   where id = v_conversation;

  insert into inbox.human_reply_events(
    conversation_id, staff_id, source, note, external_event_id, created_at)
  values (
    v_conversation, v_staff, 'line_oa_backfill',
    concat_ws(' · ', nullif(btrim(p_staff_name),''),
              case when nullif(btrim(p_staff_external_id),'') is not null
                   then 'LINE OA owner ' || p_staff_external_id end),
    p_event_id, p_replied_at)
  on conflict (conversation_id, source, external_event_id)
    where external_event_id is not null do nothing;

  select max(m.created_at) into v_latest_customer from inbox.message m
   where m.conversation_id = v_conversation and m.sender_type = 'contact';
  if v_latest_customer is null or v_latest_customer < p_replied_at then
    with x as (
      update connect_private.job
         set status='skipped', skip_reason='human_replied', finished_at=p_replied_at
       where conversation_id=v_conversation
         and kind in ('generate','send') and status='pending'
       returning 1)
    select count(*) into v_cancelled from x;
    update connect_private.case_state set waiting_since=null
     where conversation_id=v_conversation;
  end if;

  insert into connect_private.audit(conversation_id, action, detail, created_at)
  values (v_conversation, 'line_oa_reply_backfill',
          jsonb_build_object('event_id',p_event_id,'staff_external_id',p_staff_external_id,
                             'message_id',v_message,'cancelled_jobs',v_cancelled),
          now());

  return jsonb_build_object('replayed',true,'conversation_id',v_conversation,
                            'message_id',v_message,'cancelled_jobs',v_cancelled);
end
$$;

-- A backfilled LINE OA message is provider-confirmed in the same sense as an
-- external Meta echo, despite having no connect_private.delivery row.
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
           select 1 from inbox.human_reply_events h
            where h.conversation_id = m.conversation_id
              and h.created_at = m.created_at
              and h.source in ('echo','page_inbox','other_app','line_oa_backfill')
         )
       )
  )
$$;

revoke all on function connect_private.backfill_line_oa_reply(
  uuid,text,text,text,timestamptz,text,text,text,text) from public, anon, authenticated;
grant execute on function connect_private.backfill_line_oa_reply(
  uuid,text,text,text,timestamptz,text,text,text,text) to service_role;

commit;
