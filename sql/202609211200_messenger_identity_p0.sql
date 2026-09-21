-- 202609211200_messenger_identity_p0.sql - direction-first Messenger identity boundary
-- Depends on the latest receive_event definition from 202609191500_review_code.sql.
begin;

CREATE OR REPLACE FUNCTION connect_private.receive_event(p_data jsonb, p_now timestamp with time zone, p_jitter integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_inbox inbox.inbox; v_contact uuid; v_id uuid; v_message uuid; v_lead uuid;
  v_event_type text; v_time timestamptz; v_text text; v_has_text boolean;
  v_is_new boolean; v_convo inbox.conversation; v_prev_count int;
  v_ctx jsonb; v_decision jsonb; v_reply jsonb; v_notify jsonb;
  v_phone text; v_line text; v_repeat boolean; v_last_page timestamptz;
  v_unanswered double precision; v_sender text; v_app_id text; v_cancelled int := 0;
  v_delay int; v_action text; v_decision_id bigint; v_topic text;
  v_cmd jsonb; v_ad jsonb; v_ad_id text; v_welcome text;
  -- โ… เน€เธเธดเนเธกเนเธ 035: เนเธขเธเธ—เธตเนเธกเธฒเธเธญเธ echo เนเธฅเธฐเธเธฑเธเธเนเธญเธเธงเธฒเธกเธเธญเธเน€เธฃเธฒเน€เธญเธเธเนเธณ
  v_bot_app text; v_is_ours boolean; v_own uuid; v_source text;
  v_who text; v_staff uuid; v_staff_user uuid;
  v_page_id text; v_customer_psid text; v_identity_count integer;
begin
  select * into v_inbox from inbox.inbox where id = (p_data->>'inbox_id')::uuid and is_active;
  if not found then raise exception 'channel_not_configured'; end if;
  if coalesce(p_data->>'event_id','') = '' then raise exception 'invalid_event'; end if;

  v_event_type := coalesce(p_data->>'event_type', 'message');
  if v_event_type not in ('message','postback','follow','unfollow','echo','group_command') then
    v_event_type := 'other';
  end if;

  -- โ”€โ”€ เธ”เนเธฒเธเธเธฑเธเธเนเธณ เธเธฃเธญเธเธ—เธธเธเธเธเธดเธ”เธฃเธงเธกเธ—เธฑเนเธเธเธณเธชเธฑเนเธเนเธเธเธฅเธธเนเธก
  -- LINE เธขเธดเธเธเนเธณเนเธ”เน เธ–เนเธฒเนเธกเนเธเธฑเธ เธเธณเธชเธฑเนเธ "เธ•เธญเธเนเธฅเนเธง" เธเธฐเธ–เธนเธเธ—เธณเธชเธญเธเธฃเธญเธ (เนเธกเนเน€เธชเธตเธขเธซเธฒเธข เนเธ•เน log เธเธฐเนเธเธซเธ)
  insert into connect_private.inbound_event(inbox_id, event_id, event_type)
  values (v_inbox.id, p_data->>'event_id',
          case when v_event_type in ('echo','group_command') then 'other' else v_event_type end)
  on conflict do nothing;
  if not found then return jsonb_build_object('duplicate', true); end if;

  -- โ”€โ”€ เธเธณเธชเธฑเนเธเนเธเธเธฅเธธเนเธก: เนเธกเนเธกเธตเธฅเธนเธเธเนเธฒ เนเธกเนเธกเธตเธเธ—เธชเธเธ—เธเธฒ เนเธกเนเนเธ•เธฐ contact เน€เธฅเธข
  if v_event_type = 'group_command' then
    v_cmd := connect_private.group_command(v_inbox.id, p_data->>'group_id', p_data->>'external_id',
                                           p_data->>'text', p_now);
    if not coalesce((v_cmd->>'handled')::boolean, false) then
      -- เนเธกเนเนเธเนเธเธณเธชเธฑเนเธเธ—เธตเนเธฃเธนเนเธเธฑเธ = เธเธธเธขเธเธฑเธเน€เธญเธเนเธเธเธฅเธธเนเธก เนเธกเนเธ•เนเธญเธเธ•เธญเธ
      return jsonb_build_object('event_type', 'group_command', 'handled', false);
    end if;
    if coalesce(v_cmd->>'reply','') <> '' then
      insert into connect_private.job(kind, channel, inbox_id, conversation_id, target, payload, send_after)
      values ('send', 'line_group', v_inbox.id, nullif(v_cmd->>'conversation_id','')::uuid,
              p_data->>'group_id',
              jsonb_build_object('type','text','text', v_cmd->>'reply'), p_now);
    end if;
    return jsonb_build_object('event_type', 'group_command', 'handled', true,
                              'reply', v_cmd->>'reply', 'conversation_id', v_cmd->>'conversation_id');
  end if;

  -- Messenger identity is direction-sensitive. external_id remains for LINE;
  -- Messenger uses the explicit customer PSID only.
  v_page_id := nullif(p_data->>'page_id', '');
  v_customer_psid := nullif(p_data->>'customer_psid', '');

  if v_inbox.channel = 'messenger' then
    if v_page_id is null then
      return jsonb_build_object('error', 'IDENTITY_UNRESOLVED', 'event_type', v_event_type,
                                'reason', 'missing_page_id');
    end if;
    if v_event_type = 'echo' then
      select m.conversation_id, ci.contact_id, ci.external_id
        into v_id, v_contact, v_customer_psid
        from connect_private.delivery d
        join inbox.message m on m.id = d.message_id
        join inbox.conversation c on c.id = m.conversation_id
        join core.contact_identity ci
          on ci.contact_id = c.contact_id
         and ci.channel = 'messenger'
         and ci.account_key = v_inbox.id::text
       where d.provider_id = p_data->>'event_id'
       limit 1;
      -- SELECT INTO without STRICT clears targets when the queue row is absent.
      -- Preserve the provider's customer PSID for Page Inbox echoes.
      v_customer_psid := coalesce(v_customer_psid, nullif(p_data->>'customer_psid', ''));
      if v_id is null then
        if v_customer_psid is null or v_customer_psid = v_page_id then
          return jsonb_build_object('error', 'IDENTITY_UNRESOLVED', 'event_type', v_event_type,
                                    'reason', 'customer_psid_missing_or_is_page');
        end if;
        select count(distinct ci.contact_id), (array_agg(distinct ci.contact_id))[1]
          into v_identity_count, v_contact
          from core.contact_identity ci
         where ci.channel = 'messenger' and ci.account_key = v_inbox.id::text
           and ci.external_id = v_customer_psid;
        if v_identity_count <> 1 then
          return jsonb_build_object('error', 'IDENTITY_UNRESOLVED', 'event_type', v_event_type,
                                    'reason', 'customer_psid_not_existing_or_ambiguous');
        end if;
        select count(*) into v_identity_count from inbox.conversation c
         where c.inbox_id = v_inbox.id and c.contact_id = v_contact;
        if v_identity_count <> 1 then
          return jsonb_build_object('error', 'IDENTITY_UNRESOLVED', 'event_type', v_event_type,
                                    'reason', case when v_identity_count = 0 then 'customer_conversation_missing' else 'customer_conversation_ambiguous' end);
        end if;
        select c.id into v_id from inbox.conversation c
         where c.inbox_id = v_inbox.id and c.contact_id = v_contact for update;
      end if;
    else
      if v_customer_psid is null or v_customer_psid = v_page_id then
        return jsonb_build_object('error', 'IDENTITY_UNRESOLVED', 'event_type', v_event_type,
                                  'reason', 'customer_psid_missing_or_is_page');
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_inbox.id::text || ':' || v_customer_psid, 0));
      v_contact := core.resolve_identity(v_inbox.channel, v_customer_psid, v_inbox.id::text,
                                         p_data->>'display_name', v_inbox.project_id);
    end if;
  else
    if coalesce(p_data->>'external_id','') = '' then raise exception 'invalid_event'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_inbox.id::text || ':' || (p_data->>'external_id'), 0));
    v_contact := core.resolve_identity(v_inbox.channel, p_data->>'external_id', v_inbox.id::text,
                                       p_data->>'display_name', v_inbox.project_id);
  end if;

  if v_id is null then
    select count(*) into v_identity_count from inbox.conversation
     where inbox_id = v_inbox.id and contact_id = v_contact;
    if v_identity_count > 1 then
      return jsonb_build_object('error', 'IDENTITY_UNRESOLVED', 'event_type', v_event_type,
                                'reason', 'customer_conversation_ambiguous');
    end if;
    select id into v_id from inbox.conversation
     where inbox_id = v_inbox.id and contact_id = v_contact for update;
    v_is_new := v_id is null;
    if v_is_new and v_event_type = 'echo' then
      return jsonb_build_object('error', 'IDENTITY_UNRESOLVED', 'event_type', v_event_type,
                                'reason', 'customer_conversation_missing');
    end if;
    if v_is_new then
      insert into inbox.conversation(inbox_id, contact_id) values (v_inbox.id, v_contact) returning id into v_id;
    end if;
  else
    v_is_new := false;
  end if;
  select * into v_convo from inbox.conversation where id = v_id;
  v_lead := connect_private.ensure_lead(v_id);
  v_time := least(p_now, coalesce((p_data->>'occurred_at')::timestamptz, p_now));
  v_text := coalesce(p_data->>'text', '[เธเนเธญเธเธงเธฒเธกเธ—เธตเนเนเธกเนเนเธเนเธเนเธญเธเธงเธฒเธกเธ•เธฑเธงเธญเธฑเธเธฉเธฃ]');

  -- โ”€โ”€ Meta App Review: เธฃเธซเธฑเธชเธฃเธตเธงเธดเธงเธเธฒเธ asher-messenger (server.mjs: tagReviewCode)
  --   เธ•เธดเธ”เธเธ is_test เธ–เธฒเธงเธฃ (เน€เธซเธกเธทเธญเธ sql/031) + mode='human' เธเธฑเธเธเธญเธ—เธ•เธญเธเธเธนเนเธ•เธฃเธงเธเธชเธญเธ
  --   โ… เธ•เนเธญเธเธ•เธฑเนเธ mode เนเธกเนเนเธเนเนเธเน is_test โ€” is_test เธญเธขเนเธฒเธเน€เธ”เธตเธขเธงเนเธกเนเธเธฑเธเธเธญเธ— (เธ”เธนเธซเธฑเธงเนเธเธฅเน)
  --   โ… เธ•เนเธญเธเธญเธฑเธเน€เธ”เธ• v_convo เนเธเธ•เธฑเธงเนเธเธฃเธ”เนเธงเธข เนเธกเนเนเธเนเนเธเนเนเธเธ•เธฒเธฃเธฒเธ โ€” v_ctx เธเนเธฒเธเธฅเนเธฒเธเธญเนเธฒเธเธเธฒเธ
  --     v_convo.mode เธ—เธตเน select เนเธงเนเธเนเธญเธเธซเธเนเธฒเธเธตเนเนเธฅเนเธง เนเธกเน query เธเนเธณ
  --   trigger conversation_sync_mode เธเธฐเธ•เธฑเนเธ bot_active=false เนเธซเนเน€เธญเธเธเธฒเธ mode เธเธตเน
  --   โ… เน€เธเนเธ v_inbox.channel เธเนเธณเธญเธตเธเธเธฑเนเธเนเธกเน server.mjs เธเธฃเธญเธ asher-messenger เธกเธฒเนเธฅเนเธง
  --     เธเธฑเธเธเธฑเนเธเธเธฑเนเธ Node เนเธเธญเธเธฒเธเธ•เนเธกเนเนเธซเนเนเธเธเธดเธ”เธเธญเธ—/เธ•เธฑเธ”เธชเธ–เธดเธ•เธดเธเธญเธ LINE เนเธ”เธขเนเธกเนเธ•เธฑเนเธเนเธ
  if v_inbox.channel = 'messenger' and coalesce((p_data->>'review_code_hit')::boolean, false) then
    update inbox.conversation set is_test = true, mode = 'human' where id = v_id;
    v_convo.is_test := true;
    v_convo.mode := 'human';
  end if;

  -- โ”€โ”€ reply token เน€เธเนเธเนเธงเนเนเธซเนเธเธฑเนเธเธชเนเธเธเธญเธเนเธเน เธ–เนเธฒเธกเธฑเธเธกเธฒเธ”เนเธงเธข
  if coalesce(p_data->>'reply_token','') <> '' then
    update inbox.conversation
       set last_reply_token = p_data->>'reply_token', last_reply_token_at = v_time
     where id = v_id;
  end if;

  -- โ”€โ”€ เธเธฅเนเธญเธเธเธฑเธเธเธต: เนเธกเนเธกเธตเธเนเธญเธเธงเธฒเธก เนเธกเนเธกเธตเธญเธฐเนเธฃเนเธซเนเธ•เธฑเธ”เธชเธดเธเนเธ
  if v_event_type = 'unfollow' then
    update core.contact set blocked = true, blocked_at = v_time where id = v_contact;
    insert into inbox.message(conversation_id, sender_type, content, content_type, event_type,
                              external_message_id, created_at)
    values (v_id, 'system', '[เธฅเธนเธเธเนเธฒเธเธฅเนเธญเธเธเธฑเธเธเธต]', 'unfollow', 'unfollow', p_data->>'event_id', v_time)
    returning id into v_message;
    update connect_private.inbound_event set message_id = v_message
     where inbox_id = v_inbox.id and event_id = p_data->>'event_id';
    return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', 'unfollow', 'blocked', true);
  end if;

  -- โ”€โ”€ echo: เน€เธเธเน€เธเนเธเธเธเธชเนเธ เนเธกเนเนเธเนเธฅเธนเธเธเนเธฒ โ€” เธ•เนเธญเธเธฃเธนเนเนเธซเนเนเธ”เนเธงเนเธฒ "เนเธเธฃเนเธเธเธฑเนเธเน€เธฃเธฒ"
  --
  -- เธเธญเธเน€เธ”เธดเธกเธ•เธฑเธ”เธชเธดเธเนเธเนเธชเธญเธเธ—เธฒเธ (bot / agent) เธเธฒเธ app_id เน€เธ—เธตเธขเธเธเธฑเธ team.bot_app_id
  -- เธเธถเนเธเนเธกเนเน€เธเธขเธ–เธนเธเธ•เธฑเนเธเธเนเธฒเน€เธฅเธข โ’ echo เธเธญเธเธเธญเธ—เน€เธญเธเธ–เธนเธเธเนเธฒเธขเน€เธเนเธ agent เนเธฅเนเธงเนเธเน€เธฃเธตเธขเธ
  -- mark_human_reply() เธ—เธณเนเธซเน decide_reply เน€เธซเนเธ human_owns_convo
  -- เธเธฅเธเธทเธญเธเธญเธ—เธ•เธญเธเธเธฃเธฑเนเธเน€เธ”เธตเธขเธงเนเธฅเนเธงเน€เธเธตเธขเธเธ–เธฒเธงเธฃเนเธเนเธเธ—เธเธฑเนเธ (เธ”เธนเธซเธฑเธงเนเธเธฅเน 035)
  if v_event_type = 'echo' then
    v_app_id  := p_data->>'app_id';
    v_bot_app := inbox.cfg_text(v_inbox.id, 'team.bot_app_id', '');
    v_is_ours := v_app_id is not null and v_bot_app <> '' and v_app_id = v_bot_app;

    -- โ… เธเธฑเธเธเนเธณเธเธฑเนเธเธ—เธตเนเธชเธญเธ โ€” เธ”เนเธฒเธ connect_private.inbound_event เธเธฑเธเนเธ”เนเนเธเน
    --   "echo เธเนเธญเธเน€เธ”เธดเธกเธ–เธนเธเธขเธดเธเธกเธฒเธชเธญเธเธเธฃเธฑเนเธ" เนเธ•เนเธเธฑเธเนเธกเนเนเธ”เนเธงเนเธฒ "เธเนเธญเธเธงเธฒเธกเธ—เธตเนเน€เธฃเธฒเธชเนเธเน€เธญเธ
    --   เน€เธ”เนเธเธเธฅเธฑเธเธกเธฒเน€เธเนเธเนเธ–เธงเธ—เธตเนเธชเธญเธเนเธเธเธ—เธชเธเธ—เธเธฒ" เธเธถเนเธเน€เธเธดเธ”เธเธฑเธเธ—เธธเธเธเนเธญเธเธงเธฒเธกเธ—เธตเนเนเธญเธเธชเนเธ
    --   (เธเธญเธเธเธฃเธดเธ 2026-09-15: เธ—เธธเธเธเนเธญเธเธงเธฒเธกเธเธญเธเน€เธฃเธฒเธกเธตเนเธ–เธงเธเธนเน เธซเนเธฒเธเธเธฑเธเธฃเธฒเธง 1 เธงเธดเธเธฒเธ—เธต)
    --   เธ”เนเธฒเธเธเธตเนเธเธทเธญ mid เธเธญเธ echo = provider_id เธ—เธตเนเธ•เธฑเธงเธชเนเธเธเธฑเธเธ—เธถเธเนเธงเนเนเธเธเธดเธงเธเธฒเธญเธญเธ
    select d.message_id into v_own
      from connect_private.delivery d
     where d.provider_id = p_data->>'event_id'
     limit 1;

    -- โ… เธเธฃเธ“เธต echo เธกเธฒเธ–เธถเธเธเนเธญเธเธ—เธตเนเธ•เธฑเธงเธชเนเธเธเธฐเธเธฑเธเธ—เธถเธ provider_id เธฅเธเธเธดเธง (เนเธเนเธเธเธฑเธเนเธ”เนเธเธฃเธดเธ โ€”
    --   Meta เน€เธ”เนเธ echo เธเธฅเธฑเธเนเธ ~1 เธงเธดเธเธฒเธ—เธต เธชเนเธงเธ worker เธเธงเนเธฒเธเธฐ finish เธญเธฒเธเธเนเธฒเธเธงเนเธฒเธเธฑเนเธ)
    --   เน€เธเธชเธเธตเน mid เธขเธฑเธเนเธกเนเธกเธตเนเธเธเธดเธง เธเธถเธเธเธฑเธเธเธนเนเธ”เนเธงเธขเน€เธเธทเนเธญเธเธงเธฒเธก + เธซเธเนเธฒเธ•เนเธฒเธเน€เธงเธฅเธฒเธชเธฑเนเธ เน เนเธ—เธ
    --   โ… เธเธฅเธญเธ”เธ เธฑเธขเน€เธเธฃเธฒเธฐเธ—เธณเธเธฒเธเน€เธเธเธฒเธฐเน€เธกเธทเนเธญ app_id เน€เธเนเธเธเธญเธเนเธญเธเน€เธฃเธฒเน€เธ—เนเธฒเธเธฑเนเธ โ€” เน€เธเธฅเธชเนเธ—เธตเน
    --     เธเธดเธกเธเนเธเนเธญเธเธงเธฒเธกเน€เธ”เธตเธขเธงเธเธฑเธเธเธฒเธ Page Inbox เธกเธต app_id เธเธญเธ Meta เนเธกเนเน€เธเนเธฒเน€เธเธทเนเธญเธเนเธเธเธตเน
    if v_own is null and v_is_ours then
      select m.id into v_own
        from inbox.message m
       where m.conversation_id = v_id
         and m.sender_type in ('bot','agent')
         and m.external_message_id is null
         and m.content = v_text
         and m.created_at >= v_time - make_interval(mins => inbox.cfg_int(v_inbox.id, 'echo.self_match_window_min', 10))
       order by m.created_at desc
       limit 1;
    end if;

    -- โ… เธเนเธฒเธขเธ—เธตเนเธกเธฒ เธชเธตเนเธ—เธฒเธ
    --   bot        เนเธญเธเน€เธฃเธฒเธชเนเธ เนเธฅเธฐเนเธ–เธงเธ•เนเธเธ—เธฒเธเน€เธเนเธเธเนเธญเธเธงเธฒเธกเธเธญเธเธเธญเธ—
    --   workspace  เนเธญเธเน€เธฃเธฒเธชเนเธ เนเธ•เนเนเธ–เธงเธ•เนเธเธ—เธฒเธเน€เธเนเธเน€เธเธฅเธชเนเธเธ”เธชเนเธเธเธฒเธเธซเธเนเธฒเธเธญเน€เธฃเธฒ
    --   page_inbox เธเธเธ•เธญเธเธเธฒเธ Page Inbox / Business Suite เธเธญเธ Meta
    --   other_app  เนเธญเธเธญเธทเนเธเธ—เธตเนเธเธนเธเธเธฑเธเน€เธเธเธเธตเน
    -- โ… เธเนเธญเน€เธ—เนเธเธเธฃเธดเธเธเธฒเธเธเธญเธเธเธฃเธดเธ: Page Inbox เธชเนเธ app_id เธเธญเธ Business Suite เธกเธฒเธ”เนเธงเธข
    --   เน€เธชเธกเธญ (263902037430900) เนเธกเนเนเธ”เนเธเธฅเนเธญเธขเธงเนเธฒเธเธญเธขเนเธฒเธเธ—เธตเนเธเธญเธกเน€เธกเธเธ•เนเนเธ providers.mjs เน€เธเธตเธขเธเนเธงเน
    --   เธเธถเธเน€เธ—เธตเธขเธเธเธฑเธเธ—เธฐเน€เธเธตเธขเธ team.page_inbox_app_ids เนเธกเนเนเธเนเน€เธเนเธ null
    -- โ… เธฅเธณเธ”เธฑเธเธชเธณเธเธฑเธ: เธ–เนเธฒเธเธนเธเธเธฑเธเนเธ–เธงเธเธฒเธญเธญเธเธเธญเธเน€เธฃเธฒเนเธ”เนเนเธฅเนเธง เนเธซเนเน€เธเธทเนเธญ "เนเธ–เธง" เธเนเธญเธ "app_id"
    --   เธเธญเธเธเธฃเธดเธ 2026-09-14..15: echo เธเธญเธเธเนเธญเธเธงเธฒเธกเธ—เธตเนเน€เธฃเธฒเธชเนเธเน€เธญเธ 8 เธเนเธญเธ เธกเธฒเธ”เนเธงเธข app_id
    --   เธชเธญเธเธเนเธฒ โ€” 946246731840651 (เนเธญเธเน€เธฃเธฒ) 5 เธเนเธญเธ เนเธฅเธฐ 1905070200457329 3 เธเนเธญเธ
    --   เธ–เนเธฒเธ•เธฑเธ”เธชเธดเธเธเธฒเธ app_id เธญเธขเนเธฒเธเน€เธ”เธตเธขเธง เธชเธฒเธกเธเนเธญเธเธซเธฅเธฑเธเธเธฐเธ–เธนเธเธเนเธฒเธขเน€เธเนเธ other_app
    --   เธ—เธฑเนเธเธ—เธตเนเน€เธเนเธเธเนเธญเธเธงเธฒเธกเธเธญเธเน€เธฃเธฒเน€เธญเธ โ€” mid เธ—เธตเนเธ•เธฃเธเธเธฑเธเธเธดเธงเธเธฒเธญเธญเธเน€เธเนเธเธซเธฅเธฑเธเธเธฒเธเธ—เธตเนเธซเธเธฑเธเธเธงเนเธฒ
    if v_own is not null then
      v_source := case when (select m.sender_type from inbox.message m where m.id = v_own) = 'agent'
                       then 'workspace' else 'bot' end;
    elsif v_is_ours then
      v_source := 'bot';
    elsif v_app_id is null
       or position(v_app_id in inbox.cfg_text(v_inbox.id, 'team.page_inbox_app_ids', '')) > 0 then
      v_source := 'page_inbox';
    else
      v_source := 'other_app';
    end if;

    -- โ”€โ”€ เธเธญเธเน€เธฃเธฒเน€เธญเธ: เธเธนเธ mid เธเธฅเธฑเธเน€เธเนเธฒเนเธ–เธงเน€เธ”เธดเธก เนเธกเนเธชเธฃเนเธฒเธเนเธ–เธงเนเธซเธกเน เนเธกเนเธเธฑเธเธงเนเธฒ "เธเธเธ•เธญเธ"
    if v_own is not null then
      update inbox.message
         set external_message_id = p_data->>'event_id'
       where id = v_own and external_message_id is null;
      if v_source = 'bot' then
        update inbox.conversation set last_bot_reply_at = v_time where id = v_id;
      end if;
      update connect_private.inbound_event set message_id = v_own
       where inbox_id = v_inbox.id and event_id = p_data->>'event_id';
      return jsonb_build_object('id', v_id, 'message_id', v_own, 'event_type', 'echo',
                                'source', v_source, 'duplicate_of', v_own, 'linked_mid', true);
    end if;

    -- โ”€โ”€ เนเธเธฃเธ•เธญเธ: เธญเนเธฒเธเธเธฒเธเธฅเธฒเธขเน€เธเนเธเธ—เนเธฒเธขเธเนเธญเธเธงเธฒเธก (team.signatures)
    --   โ… เธขเธฑเธเนเธกเนเธกเธตเนเธเธฃเนเธเนเธเธญเธเธเธดเธเธเธตเนเธกเธฒเธเนเธญเธ โ€” seed_bot_defaults เธซเธงเนเธฒเธเนเธงเนเน€เธเธข เน
    --     เธ—เธตเนเธเธตเนเน€เธเนเธเธ—เธตเนเนเธฃเธเธ—เธตเนเน€เธญเธฒเธกเธฒเนเธเนเธเธฃเธดเธ
    --   โ… inbox.sales_staff เธขเธฑเธเธงเนเธฒเธ 0 เนเธ–เธง เธ•เธญเธเธเธตเนเธเธถเธเนเธ”เนเนเธ•เนเธเธทเนเธญ (เธฅเธเนเธ note)
    --     เธเธญเธกเธตเนเธเธฃเธฅเธเธ—เธฐเน€เธเธตเธขเธเธเธฃเนเธญเธก user_id เนเธฅเนเธง sender_id เธเธฐเธ–เธนเธเน€เธเนเธ•เนเธซเนเน€เธญเธเธ—เธฑเธเธ—เธต
    --     เนเธฅเธฐเธฃเธฒเธขเธเธฒเธเธ—เธตเน join sales_staff เธญเธขเธนเนเนเธฅเนเธงเธเธฐเน€เธซเนเธเธเธทเนเธญเธเธเธ•เธญเธเนเธ”เธขเนเธกเนเธ•เนเธญเธเนเธเนเธญเธฐเนเธฃ
    if not v_is_ours then
      select s.key into v_who
        from jsonb_each_text(inbox.bot_cfg(v_inbox.id, 'team.signatures', '{}'::jsonb)) as s(key, pat)
       where coalesce(s.pat,'') <> '' and v_text ~* s.pat
       order by length(s.pat) desc
       limit 1;
      if v_who is not null then
        select st.id, st.user_id into v_staff, v_staff_user
          from inbox.sales_staff st
         where lower(st.name) = lower(v_who) and coalesce(st.is_active, true)
         limit 1;
      end if;
    end if;

    -- เธเธเน€เธ”เธตเธขเธงเธเธฑเธเธ—เธตเน connect_private.replay() เนเธเน โ€” เธเธฑเธ trigger เธชเธฃเนเธฒเธเธเธฒเธเธเธฒเธญเธญเธ
    -- เธ–เนเธฒเนเธกเนเธ•เธฑเนเธ เธเนเธญเธเธงเธฒเธกเธ—เธตเนเธ—เธตเธกเน€เธเธดเนเธเธ•เธญเธเนเธเธเธฐเธ–เธนเธเธชเนเธเธเธฅเธฑเธเนเธเธซเธฒเธฅเธนเธเธเนเธฒเธญเธตเธเธฃเธญเธ
    perform set_config('connect.replay', 'on', true);
    v_sender := case when v_is_ours then 'bot' else 'agent' end;
    insert into inbox.message(conversation_id, sender_type, sender_id, content, content_type, event_type,
                              external_message_id, created_at)
    values (v_id, v_sender, v_staff_user, v_text, coalesce(p_data->>'content_type','text'), 'message',
            p_data->>'event_id', v_time)
    returning id into v_message;

    if v_sender = 'agent' then
      -- โ… source เธฅเธฐเน€เธญเธตเธขเธ”เธเธงเนเธฒเธเธณเธงเนเธฒ 'echo' เน€เธ”เธดเธก โ€” เนเธขเธเนเธ”เนเธงเนเธฒเน€เธเธฅเธชเนเธ•เธญเธเธเธฒเธเธ—เธตเนเนเธซเธ
      --   (page_inbox / other_app) เน€เธ—เธตเธขเธเธเธฑเธ 'workspace' เธ—เธตเนเธ•เธฑเธงเธชเนเธเธเธญเธเน€เธฃเธฒเธเธฑเธเธ—เธถเธเนเธงเน
      v_cmd := connect_private.mark_human_reply(v_id, v_staff, v_source, v_time,
                 coalesce(v_who, inbox.cfg_text(v_inbox.id, 'team.unknown_label', 'unknown')));
      v_cancelled := coalesce((v_cmd->>'cancelled_jobs')::int, 0);
    else
      update inbox.conversation set last_bot_reply_at = v_time where id = v_id;
    end if;

    update connect_private.inbound_event set message_id = v_message
     where inbox_id = v_inbox.id and event_id = p_data->>'event_id';
    return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', 'echo',
                              'sender_type', v_sender, 'source', v_source, 'linked_mid', false,
                              'responder', v_who, 'staff_id', v_staff, 'cancelled_jobs', v_cancelled);
  end if;

  -- โ”€โ”€ เน€เธเธดเนเธกเน€เธเธทเนเธญเธ: เธ—เธฑเธเธ—เธฒเธข + เธเธญเธเธ—เธตเธก ยท เธเธเธ—เธตเนเน€เธเธขเธเธฅเนเธญเธเนเธฅเนเธงเธเธฅเธฑเธเธกเธฒ เธ•เนเธญเธเธเธฅเธ”เธเธเธ”เนเธงเธข
  if v_event_type = 'follow' then
    update core.contact set blocked = false, blocked_at = null where id = v_contact;
    insert into inbox.message(conversation_id, sender_type, content, content_type, event_type,
                              external_message_id, created_at)
    values (v_id, 'system', '[เธฅเธนเธเธเนเธฒเน€เธเธดเนเธกเน€เธเธทเนเธญเธ]', 'follow', 'follow', p_data->>'event_id', v_time)
    returning id into v_message;
    update connect_private.inbound_event set message_id = v_message
     where inbox_id = v_inbox.id and event_id = p_data->>'event_id';

    v_welcome := inbox.cfg_text(v_inbox.id, 'line.welcome_on_follow', '');
    if inbox.cfg_bool(v_inbox.id, 'reply.reply_to_follow', false) and v_welcome <> '' then
      -- เธเนเธญเธเธงเธฒเธกเธ•เนเธญเธเธฃเธฑเธเน€เธเนเธเธเนเธญเธเธงเธฒเธกเธเธญเธเธเธญเธ—เธ•เธฒเธกเธเธเธ•เธด trigger เธเธฐเธเธฒเน€เธเนเธฒเธเธดเธงเธเธฒเธญเธญเธเน€เธญเธ
      -- เธ—เธฒเธเธญเธญเธเธชเธนเนเธฅเธนเธเธเนเธฒเธเธถเธเธขเธฑเธเธกเธตเธ—เธฒเธเน€เธ”เธตเธขเธงเธ—เธฑเนเธเธฃเธฐเธเธ
      insert into inbox.message(conversation_id, sender_type, content, content_type, event_type)
      values (v_id, 'bot', v_welcome, 'text', 'message');
      update inbox.conversation set last_bot_reply_at = v_time where id = v_id;
    end if;

    if inbox.cfg_bool(v_inbox.id, 'notify.enabled', true)
       and inbox.cfg_bool(v_inbox.id, 'notify.always_on_follow', false) then
      insert into connect_private.job(kind, channel, inbox_id, conversation_id, message_id, payload, send_after)
      values ('notify', 'team', v_inbox.id, v_id, v_message,
              jsonb_build_object('kind','follow','reason','follow','text','เน€เธเธดเนเธกเน€เธเธทเนเธญเธเนเธซเธกเน',
                                 'is_new_chat', v_is_new,
                                 'code', right(p_data->>'external_id', 6)), p_now);
      update inbox.conversation set last_notified_at = v_time where id = v_id;
    end if;

    return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', 'follow');
  end if;

  -- โ”€โ”€ เธเนเธญเธเธงเธฒเธกเธเธญเธเธฅเธนเธเธเนเธฒ
  --
  -- [AD:xxx] เธกเธฒเธเธฒเธเธฅเธดเธเธเนเนเธเธฉเธ“เธฒเธ—เธตเน prefill เธเนเธญเธเธงเธฒเธกเนเธซเนเธฅเธนเธเธเนเธฒ โ€” เธ•เธฑเธ” prefix เธญเธญเธเธเนเธญเธเน€เธเนเธ
  -- เนเธกเนเธเธฑเนเธเธ—เธฑเนเธเธซเธเนเธฒเธเธญเนเธฅเธฐเธเธญเธ—เธเธฐเน€เธซเนเธเนเธเนเธ”เนเธเธฉเธ“เธฒเธเธเธญเธขเธนเนเนเธเธชเธดเนเธเธ—เธตเนเธฅเธนเธเธเนเธฒ "เธเธดเธกเธเน"
  v_ad_id := p_data->>'ad_id';
  if v_inbox.channel = 'line' then
    v_ad := inbox.strip_ad_prefix(v_text, inbox.cfg_text(v_inbox.id, 'line.ad_prefix_pattern',
                                                         '^\[AD:([a-zA-Z0-9_-]+)\]\s*'));
    v_text := v_ad->>'text';
    v_ad_id := coalesce(v_ad->>'ad_id', v_ad_id);
  end if;

  v_has_text := coalesce((p_data->>'has_text')::boolean, v_text !~ '^\[');

  select count(*) into v_prev_count from (
    select content from inbox.message
     where conversation_id = v_id and sender_type = 'contact'
     order by created_at desc limit 3 offset 1) m
   where lower(btrim(m.content)) = lower(btrim(v_text));
  v_repeat := length(btrim(v_text)) > 8 and v_prev_count > 0;

  insert into inbox.message(conversation_id, sender_type, content, content_type, event_type,
                            external_message_id, created_at)
  values (v_id, 'contact', v_text, coalesce(p_data->>'content_type','text'), v_event_type,
          p_data->>'event_id', v_time)
  returning id into v_message;
  update connect_private.inbound_event set message_id = v_message
   where inbox_id = v_inbox.id and event_id = p_data->>'event_id';

  if v_ad_id is not null or (p_data->>'ad_title') is not null then
    update inbox.conversation set ad_id = coalesce(v_ad_id, ad_id),
                                  ad_title = coalesce(p_data->>'ad_title', ad_title)
     where id = v_id;
  end if;

  if v_event_type in ('message','postback') then
    update inbox.conversation
       set status = case when assignee_id is null then 'pending' else 'open' end,
           sla_due_at = coalesce((select waiting_since from connect_private.case_state where conversation_id = v_id), v_time)
                        + interval '30 minutes'
     where id = v_id;
    update connect_private.case_state set waiting_since = coalesce(waiting_since, v_time) where conversation_id = v_id;
  end if;

  v_phone := inbox.extract_phone(v_text);
  v_line  := inbox.extract_line_id(v_text);
  v_last_page := greatest(v_convo.last_human_reply_at, v_convo.last_bot_reply_at);
  v_unanswered := case
    when v_convo.last_notified_at is null then 'Infinity'::double precision
    when v_last_page is null or v_last_page < v_convo.last_notified_at
      then extract(epoch from (p_now - v_convo.last_notified_at)) / 60
    else 0 end;

  v_ctx := jsonb_build_object(
    'text', v_text,
    'has_text', v_has_text,
    'is_admin', coalesce((p_data->>'is_admin')::boolean, false),
    'is_new_chat', v_is_new,
    'gap_hours', case when v_convo.last_message_at is null then null
                      else extract(epoch from (p_now - v_convo.last_message_at)) / 3600 end,
    'unanswered_since_notify_min', case when v_unanswered = 'Infinity'::double precision then null else v_unanswered end,
    'human_replied_min', case when v_convo.last_human_reply_at is null then null
                              else extract(epoch from (p_now - v_convo.last_human_reply_at)) / 60 end,
    'phone_in_text', v_phone,
    'line_in_text', v_line,
    'verbatim_repeat', v_repeat,
    'convo_mode', coalesce(v_convo.mode, 'bot'),
    'is_standby', coalesce((p_data->>'is_standby')::boolean, false),
    'event_type', v_event_type);

  v_decision := inbox.decide_all(v_inbox.id, v_ctx, p_now, p_jitter);
  v_reply  := v_decision->'reply';
  v_notify := v_decision->'notify';
  v_delay  := (v_decision->>'delay_sec')::int;
  v_action := v_decision->>'notify_action';
  v_topic  := p_data->>'topic';

  insert into inbox.bot_decisions(conversation_id, message_id, event_id, topic,
                                  reply_go, reply_reason, reply_wait_min,
                                  notify_go, notify_reason, notify_action, delay_sec, text, decided_at)
  values (v_id, v_message, p_data->>'event_id', v_topic,
          (v_reply->>'go')::boolean, v_reply->>'reason', (v_reply->>'wait_min')::int,
          (v_notify->>'go')::boolean, v_notify->>'reason', v_action, v_delay, left(v_text, 200), p_now)
  returning id into v_decision_id;

  if v_action in ('send','queue') then
    insert into connect_private.job(kind, channel, inbox_id, conversation_id, message_id, payload, send_after)
    values ('notify', 'team', v_inbox.id, v_id, v_message,
            jsonb_build_object(
              'reason', v_notify->>'reason', 'queued', v_action = 'queue',
              'text', left(v_text, 200), 'event_type', v_event_type,
              'is_new_chat', v_is_new, 'verbatim_repeat', v_repeat,
              -- โ… เนเธเธ—เธ—เธ”เธชเธญเธ: เนเธซเนเธเนเธญเธเธงเธฒเธกเนเธเนเธเธ•เธดเธ” [TEST] เธเธณเธซเธเนเธฒ (sql/031)
              --   เธขเธฑเธเนเธเนเธเธ•เธฒเธกเธเธเธ•เธด เน€เธเธฃเธฒเธฐเธ—เธตเธกเธ•เนเธญเธเน€เธซเนเธเธงเนเธฒเธเธฒเธฃเธ—เธ”เธชเธญเธเน€เธ”เธดเธเธ–เธถเธเนเธซเธ
              --   โ… เธเธฃเธฃเธ—เธฑเธ”เธเธตเนเนเธกเนเธกเธตเนเธ sql/006 โ€” 006 เน€เธเธตเธขเธเธเนเธญเธ 031 เธเธฐเธกเธตเธญเธขเธนเน
              --     เธ–เนเธฒเธขเธ 006 เธกเธฒเธ—เธฑเธเน€เธเธข เน เธเธเนเธเธ—เธ—เธ”เธชเธญเธเธเธฐเธซเธฒเธขเนเธเน€เธเธตเธขเธ เน
              'is_test', coalesce(v_convo.is_test, false),
              'phone', v_phone, 'line_id', v_line, 'topic', v_topic,
              'ad_title', v_convo.ad_title, 'code', right(p_data->>'external_id', 6),
              'reply_go', (v_reply->>'go')::boolean, 'reply_reason', v_reply->>'reason',
              'wait_min', (v_reply->>'wait_min')::int, 'delay_sec', v_delay),
            case when v_action = 'queue'
                 then date_trunc('day', p_now at time zone 'Asia/Bangkok' + interval '1 day')
                      at time zone 'Asia/Bangkok'
                      + make_interval(hours => split_part(inbox.cfg_text(v_inbox.id,'notify.digest_at','09:00'), ':', 1)::int,
                                      mins  => split_part(inbox.cfg_text(v_inbox.id,'notify.digest_at','09:00'), ':', 2)::int)
                 else p_now end);
    update inbox.conversation set last_notified_at = v_time where id = v_id;
  end if;

  if coalesce((v_reply->>'go')::boolean, false) then
    if not exists (select 1 from connect_private.job
                    where conversation_id = v_id and kind = 'generate' and status in ('pending','processing')) then
      insert into connect_private.job(kind, channel, inbox_id, conversation_id, message_id, target, payload, send_after)
      values ('generate', v_inbox.channel, v_inbox.id, v_id, v_message, p_data->>'external_id',
              jsonb_build_object('reason', v_reply->>'reason', 'is_new_chat', v_is_new,
                                 'wait_min', (v_reply->>'wait_min')::int),
              p_now + make_interval(secs => v_delay));
    end if;
  elsif inbox.cfg_bool(v_inbox.id, 'insight.enabled', true)
        and inbox.cfg_bool(v_inbox.id, 'insight.classify_when_silent', true)
        and v_has_text and not coalesce((p_data->>'is_admin')::boolean, false) then
    insert into connect_private.job(kind, channel, inbox_id, conversation_id, message_id, payload, send_after)
    values ('classify', v_inbox.channel, v_inbox.id, v_id, v_message,
            jsonb_build_object('text', v_text, 'ad_title', v_convo.ad_title), p_now);
  end if;

  perform connect_private.emit(v_id, 'conversation_received',
    jsonb_build_object('message_id', v_message, 'event_type', v_event_type,
                       'decision_id', v_decision_id, 'attribution', p_data->'attribution'), null);

  return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', v_event_type,
                            'ad_id', v_ad_id, 'decision', v_decision, 'decision_id', v_decision_id);
end $function$;


grant execute on function connect_private.receive_event(jsonb, timestamptz, int) to service_role;

-- Historical contamination may make a hard unique constraint unsafe today.
-- The receive boundary is the application-level protection until reviewed cleanup.
create index if not exists messenger_conversation_identity_lookup_idx
  on inbox.conversation(inbox_id, contact_id)
  where inbox_id is not null and contact_id is not null;

commit;
