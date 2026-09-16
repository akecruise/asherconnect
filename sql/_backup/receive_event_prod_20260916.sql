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
begin
  select * into v_inbox from inbox.inbox where id = (p_data->>'inbox_id')::uuid and is_active;
  if not found then raise exception 'channel_not_configured'; end if;
  if coalesce(p_data->>'external_id','') = '' or coalesce(p_data->>'event_id','') = '' then
    raise exception 'invalid_event';
  end if;

  v_event_type := coalesce(p_data->>'event_type', 'message');
  if v_event_type not in ('message','postback','follow','unfollow','echo') then v_event_type := 'other'; end if;

  -- ── 1. ด่านกันซ้ำ: ฐานเป็นคนจำ ไม่ใช่ Node
  insert into connect_private.inbound_event(inbox_id, event_id, event_type)
  values (v_inbox.id, p_data->>'event_id', case when v_event_type = 'echo' then 'other' else v_event_type end)
  on conflict do nothing;
  if not found then return jsonb_build_object('duplicate', true); end if;

  perform pg_advisory_xact_lock(hashtextextended(v_inbox.id::text || ':' || (p_data->>'external_id'), 0));
  v_contact := core.resolve_identity(v_inbox.channel, p_data->>'external_id', v_inbox.id::text,
                                     p_data->>'display_name', v_inbox.project_id);
  select id into v_id from inbox.conversation
   where inbox_id = v_inbox.id and contact_id = v_contact order by created_at desc limit 1 for update;
  v_is_new := v_id is null;
  if v_is_new then
    insert into inbox.conversation(inbox_id, contact_id) values (v_inbox.id, v_contact) returning id into v_id;
  end if;
  select * into v_convo from inbox.conversation where id = v_id;
  v_lead := connect_private.ensure_lead(v_id);
  v_time := least(p_now, coalesce((p_data->>'occurred_at')::timestamptz, p_now));
  v_text := coalesce(p_data->>'text', '[ข้อความที่ไม่ใช่ข้อความตัวอักษร]');

  -- ── 2. echo: ฝั่งเราเป็นคนส่ง ไม่ใช่ลูกค้า
  if v_event_type = 'echo' then
    v_app_id := p_data->>'app_id';
    v_sender := case when v_app_id is not null and v_app_id = inbox.cfg_text(v_inbox.id, 'team.bot_app_id', '')
                     then 'bot' else 'agent' end;

    -- ธงเดียวกับที่ connect_private.replay() ใช้ — กัน trigger สร้างงานขาออก
    -- ถ้าไม่ตั้ง ข้อความที่ทีมเพิ่งตอบไปจะถูกส่งกลับไปหาลูกค้าอีกรอบ
    perform set_config('connect.replay', 'on', true);
    insert into inbox.message(conversation_id, sender_type, content, content_type, event_type,
                              external_message_id, created_at)
    values (v_id, v_sender, v_text, coalesce(p_data->>'content_type','text'), 'message',
            p_data->>'event_id', v_time)
    returning id into v_message;

    if v_sender = 'agent' then
      update inbox.conversation set last_human_reply_at = v_time where id = v_id;
      -- คนตอบแล้ว งานที่บอทจ่อจะส่งต้องหยุดทันที ไม่ใช่รอให้ถึงเวลาแล้วค่อยมาเช็ค
      with x as (
        update connect_private.job set status = 'skipped', skip_reason = 'human_replied', finished_at = p_now
         where conversation_id = v_id and kind in ('generate','send') and status = 'pending' returning 1)
      select count(*) into v_cancelled from x;
      update connect_private.case_state set waiting_since = null where conversation_id = v_id;
    else
      update inbox.conversation set last_bot_reply_at = v_time where id = v_id;
    end if;

    update connect_private.inbound_event set message_id = v_message
     where inbox_id = v_inbox.id and event_id = p_data->>'event_id';
    return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', 'echo',
                              'sender_type', v_sender, 'cancelled_jobs', v_cancelled);
  end if;

  -- ── 3. ข้อความของลูกค้า
  v_has_text := coalesce((p_data->>'has_text')::boolean,
                         v_text !~ '^\[' );   -- ของที่ขึ้นต้นด้วย [ คือสื่อแนบ/ปุ่ม ไม่ใช่ข้อความพิมพ์

  -- ถามซ้ำคำต่อคำ: เทียบกับสามข้อความก่อนหน้า (ข้ามข้อความล่าสุดของตัวเอง)
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

  if (p_data->>'ad_id') is not null or (p_data->>'ad_title') is not null then
    update inbox.conversation set ad_id = coalesce(p_data->>'ad_id', ad_id),
                                  ad_title = coalesce(p_data->>'ad_title', ad_title)
     where id = v_id;
  end if;

  -- นาฬิกา SLA เดินเฉพาะของที่ลูกค้ารอคำตอบจริง
  if v_event_type in ('message','postback') then
    update inbox.conversation
       set status = case when assignee_id is null then 'pending' else 'open' end,
           sla_due_at = coalesce((select waiting_since from connect_private.case_state where conversation_id = v_id), v_time)
                        + interval '30 minutes'
     where id = v_id;   -- last_message_at ไม่ต้องตั้งเอง trigger sync_conversation_after_message ทำให้แล้ว
    update connect_private.case_state set waiting_since = coalesce(waiting_since, v_time) where conversation_id = v_id;
  end if;

  -- ── 4. ประกอบ ctx แล้วตัดสินใจ
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

  -- ── 5. เข้าคิว
  --
  -- ทุกอย่างที่ต้องเกิดทีหลังเป็นแถวในคิว ไม่มีการหน่วงค้างไว้ในคำขอ (กติกาข้อ 1)
  if v_action in ('send','queue') then
    insert into connect_private.job(kind, channel, inbox_id, conversation_id, message_id, payload, send_after)
    values ('notify', 'team', v_inbox.id, v_id, v_message,
            jsonb_build_object(
              'reason', v_notify->>'reason', 'queued', v_action = 'queue',
              'text', left(v_text, 200), 'event_type', v_event_type,
              'is_new_chat', v_is_new, 'verbatim_repeat', v_repeat,
              -- ★ แชททดสอบ: ให้ข้อความแจ้งติด [TEST] นำหน้า (sql/031)
              --   ยังแจ้งตามปกติ เพราะทีมต้องเห็นว่าการทดสอบเดินถึงไหน
              'is_test', coalesce(v_convo.is_test, false),
              'phone', v_phone, 'line_id', v_line, 'topic', v_topic,
              'ad_title', v_convo.ad_title,
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
    -- งานคิดคำตอบ: หนึ่งบทสนทนามีได้ทีละหนึ่งงานเท่านั้น
    -- ของเดิมเช็คก่อน insert ด้วยการอ่านแล้วค่อยเขียน ซึ่งสองสายพร้อมกันหลุดได้
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
    -- บอทเงียบ แต่ยังอยากรู้ว่าลูกค้าถามเรื่องอะไร ไว้ทำโฆษณา
    insert into connect_private.job(kind, channel, inbox_id, conversation_id, message_id, payload, send_after)
    values ('classify', v_inbox.channel, v_inbox.id, v_id, v_message,
            jsonb_build_object('text', v_text, 'ad_title', v_convo.ad_title), p_now);
  end if;

  perform connect_private.emit(v_id, 'conversation_received',
    jsonb_build_object('message_id', v_message, 'event_type', v_event_type,
                       'decision_id', v_decision_id, 'attribution', p_data->'attribution'), null);

  return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', v_event_type,
                            'decision', v_decision, 'decision_id', v_decision_id);
end $function$

