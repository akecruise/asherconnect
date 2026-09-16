-- =====================================================================
-- 033_receive_event_resync.sql — กู้อีกสองชิ้นที่ sql/002 รันทับ
-- =====================================================================
-- เหตุและหลักฐานทั้งหมดอยู่ใน sql/032_worker_resync.sql
-- ไฟล์นั้นกู้ connect_private.worker ไปแล้ว (ลงโปรดักชัน 2026-09-16 04:59 UTC)
-- ไฟล์นี้กู้อีกสองชิ้นที่ 002 พาย้อนรุ่นไปพร้อมกัน
--
--   connect_private.receive_event  ← ฐานจาก sql/006_receive_line.sql
--     ที่หายไปตอนถูก 002 ทับ:
--       · กิ่ง group_command — คำสั่งในกลุ่ม/ห้อง LINE (ทีมสั่งงานบอทจากตรงนี้)
--       · เก็บ reply_token ลง inbox.conversation (last_reply_token/_at)
--       · ข้อความต้อนรับตอนลูกค้าเพิ่มเพื่อน (line.welcome_on_follow)
--       · ad attribution ฝั่ง LINE — inbox.strip_ad_prefix() + v_ad_id
--
--   inbox.extract_phone           ← sql/014_fix_extract_phone.sql
--     ต่างกันบรรทัดเดียว: วงเล็บนอกสุดครอบทั้งก้อน กลุ่มแรกจึงเป็น "ทั้งเบอร์"
--     ไม่ใช่แค่ตัวนำหน้า (0/66)
--
-- ★★ ไม่ใช่การยก sql/006 มาทับเฉย ๆ — 006 เขียนไว้ก่อน sql/031 จะมีอยู่
--    จึงไม่มี 'is_test' ใน payload ของงานแจ้งทีม ขณะที่ของบนโปรดักชันมี
--    (มีคนเติม 031 ลงในตัว 002 โดยตรง) ถ้ายก 006 มาทั้งก้อนธงแชททดสอบจะหาย
--    ไฟล์นี้จึง merge: เนื้อของ 006 + บรรทัด is_test ของ 031
--    → ตรวจแล้วว่าไม่มีอะไรอื่นของโปรดักชันที่ 006 ไม่มี (เทียบทีละบรรทัด)
--    v_convo ประกาศเป็น inbox.conversation rowtype + select * จึงมี is_test อยู่แล้ว
--
-- ★ ของที่ฟังก์ชันนี้เรียกหา ตรวจแล้วว่ามีบนฐานจริงครบ โดยเฉพาะ
--   connect_private.group_command, connect_private.mark_human_reply,
--   inbox.strip_ad_prefix, inbox.conversation.last_reply_token/_at/is_test
-- =====================================================================

begin;

create or replace function connect_private.receive_event(p_data jsonb, p_now timestamptz, p_jitter int default 0)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inbox inbox.inbox; v_contact uuid; v_id uuid; v_message uuid; v_lead uuid;
  v_event_type text; v_time timestamptz; v_text text; v_has_text boolean;
  v_is_new boolean; v_convo inbox.conversation; v_prev_count int;
  v_ctx jsonb; v_decision jsonb; v_reply jsonb; v_notify jsonb;
  v_phone text; v_line text; v_repeat boolean; v_last_page timestamptz;
  v_unanswered double precision; v_sender text; v_app_id text; v_cancelled int := 0;
  v_delay int; v_action text; v_decision_id bigint; v_topic text;
  v_cmd jsonb; v_ad jsonb; v_ad_id text; v_welcome text;
begin
  select * into v_inbox from inbox.inbox where id = (p_data->>'inbox_id')::uuid and is_active;
  if not found then raise exception 'channel_not_configured'; end if;
  if coalesce(p_data->>'event_id','') = '' then raise exception 'invalid_event'; end if;

  v_event_type := coalesce(p_data->>'event_type', 'message');
  if v_event_type not in ('message','postback','follow','unfollow','echo','group_command') then
    v_event_type := 'other';
  end if;

  -- ── ด่านกันซ้ำ ครอบทุกชนิดรวมทั้งคำสั่งในกลุ่ม
  -- LINE ยิงซ้ำได้ ถ้าไม่กัน คำสั่ง "ตอบแล้ว" จะถูกทำสองรอบ (ไม่เสียหาย แต่ log จะโกหก)
  insert into connect_private.inbound_event(inbox_id, event_id, event_type)
  values (v_inbox.id, p_data->>'event_id',
          case when v_event_type in ('echo','group_command') then 'other' else v_event_type end)
  on conflict do nothing;
  if not found then return jsonb_build_object('duplicate', true); end if;

  -- ── คำสั่งในกลุ่ม: ไม่มีลูกค้า ไม่มีบทสนทนา ไม่แตะ contact เลย
  if v_event_type = 'group_command' then
    v_cmd := connect_private.group_command(v_inbox.id, p_data->>'group_id', p_data->>'external_id',
                                           p_data->>'text', p_now);
    if not coalesce((v_cmd->>'handled')::boolean, false) then
      -- ไม่ใช่คำสั่งที่รู้จัก = คุยกันเองในกลุ่ม ไม่ต้องตอบ
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

  if coalesce(p_data->>'external_id','') = '' then raise exception 'invalid_event'; end if;

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

  -- ── reply token เก็บไว้ให้ชั้นส่งของใช้ ถ้ามันมาด้วย
  if coalesce(p_data->>'reply_token','') <> '' then
    update inbox.conversation
       set last_reply_token = p_data->>'reply_token', last_reply_token_at = v_time
     where id = v_id;
  end if;

  -- ── บล็อกบัญชี: ไม่มีข้อความ ไม่มีอะไรให้ตัดสินใจ
  if v_event_type = 'unfollow' then
    update core.contact set blocked = true, blocked_at = v_time where id = v_contact;
    insert into inbox.message(conversation_id, sender_type, content, content_type, event_type,
                              external_message_id, created_at)
    values (v_id, 'system', '[ลูกค้าบล็อกบัญชี]', 'unfollow', 'unfollow', p_data->>'event_id', v_time)
    returning id into v_message;
    update connect_private.inbound_event set message_id = v_message
     where inbox_id = v_inbox.id and event_id = p_data->>'event_id';
    return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', 'unfollow', 'blocked', true);
  end if;

  -- ── echo: ฝั่งเราเป็นคนส่ง ไม่ใช่ลูกค้า
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
      v_cmd := connect_private.mark_human_reply(v_id, null, 'echo', v_time);
      v_cancelled := coalesce((v_cmd->>'cancelled_jobs')::int, 0);
    else
      update inbox.conversation set last_bot_reply_at = v_time where id = v_id;
    end if;

    update connect_private.inbound_event set message_id = v_message
     where inbox_id = v_inbox.id and event_id = p_data->>'event_id';
    return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', 'echo',
                              'sender_type', v_sender, 'cancelled_jobs', v_cancelled);
  end if;

  -- ── เพิ่มเพื่อน: ทักทาย + บอกทีม · คนที่เคยบล็อกแล้วกลับมา ต้องปลดธงด้วย
  if v_event_type = 'follow' then
    update core.contact set blocked = false, blocked_at = null where id = v_contact;
    insert into inbox.message(conversation_id, sender_type, content, content_type, event_type,
                              external_message_id, created_at)
    values (v_id, 'system', '[ลูกค้าเพิ่มเพื่อน]', 'follow', 'follow', p_data->>'event_id', v_time)
    returning id into v_message;
    update connect_private.inbound_event set message_id = v_message
     where inbox_id = v_inbox.id and event_id = p_data->>'event_id';

    v_welcome := inbox.cfg_text(v_inbox.id, 'line.welcome_on_follow', '');
    if inbox.cfg_bool(v_inbox.id, 'reply.reply_to_follow', false) and v_welcome <> '' then
      -- ข้อความต้อนรับเป็นข้อความของบอทตามปกติ trigger จะพาเข้าคิวขาออกเอง
      -- ทางออกสู่ลูกค้าจึงยังมีทางเดียวทั้งระบบ
      insert into inbox.message(conversation_id, sender_type, content, content_type, event_type)
      values (v_id, 'bot', v_welcome, 'text', 'message');
      update inbox.conversation set last_bot_reply_at = v_time where id = v_id;
    end if;

    if inbox.cfg_bool(v_inbox.id, 'notify.enabled', true)
       and inbox.cfg_bool(v_inbox.id, 'notify.always_on_follow', false) then
      insert into connect_private.job(kind, channel, inbox_id, conversation_id, message_id, payload, send_after)
      values ('notify', 'team', v_inbox.id, v_id, v_message,
              jsonb_build_object('kind','follow','reason','follow','text','เพิ่มเพื่อนใหม่',
                                 'is_new_chat', v_is_new,
                                 'code', right(p_data->>'external_id', 6)), p_now);
      update inbox.conversation set last_notified_at = v_time where id = v_id;
    end if;

    return jsonb_build_object('id', v_id, 'message_id', v_message, 'event_type', 'follow');
  end if;

  -- ── ข้อความของลูกค้า
  --
  -- [AD:xxx] มาจากลิงก์โฆษณาที่ prefill ข้อความให้ลูกค้า — ตัด prefix ออกก่อนเก็บ
  -- ไม่งั้นทั้งหน้าจอและบอทจะเห็นโค้ดโฆษณาปนอยู่ในสิ่งที่ลูกค้า "พิมพ์"
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
              -- ★ แชททดสอบ: ให้ข้อความแจ้งติด [TEST] นำหน้า (sql/031)
              --   ยังแจ้งตามปกติ เพราะทีมต้องเห็นว่าการทดสอบเดินถึงไหน
              --   ★ บรรทัดนี้ไม่มีใน sql/006 — 006 เขียนก่อน 031 จะมีอยู่
              --     ถ้ายก 006 มาทับเฉย ๆ ธงแชททดสอบจะหายไปเงียบ ๆ
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
end $$;

create or replace function inbox.extract_phone(p_text text)
returns text
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare v_raw text; v_digits text;
begin
  if p_text is null then return null; end if;
  -- ★ วงเล็บนอกสุดครอบทั้งก้อน เพื่อให้กลุ่มแรก = ทั้งเบอร์ ไม่ใช่แค่ตัวนำหน้า
  v_raw := substring(p_text from '((\+?66|0)[[:space:]]?[689][[:space:]]?[0-9]([- ]?[0-9]){7})');
  if v_raw is null then return null; end if;
  v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
  if left(v_digits, 2) = '66' then v_digits := '0' || substr(v_digits, 3); end if;
  return case when v_digits ~ '^0[689][0-9]{8}$' then v_digits else null end;
end $$;

commit;
