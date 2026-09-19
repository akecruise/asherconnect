-- =====================================================================
-- 202609191500_review_code.sql — Meta App Review: รหัสรีวิวใน Messenger
-- =====================================================================
-- ★ ทำไมต้องมีไฟล์นี้
--   Meta App Review (pages_messaging) ต้องมีบัญชีผู้ตรวจสอบ (test_only=true)
--   ที่ทดสอบด้วยบัญชี Messenger จริง แต่ห้ามปนกับงานขายจริง — บทสนทนาต้อง
--   ติดธง is_test เพื่อให้ผู้ตรวจสอบมองเห็น (ประตูอยู่ที่ connect_private.can_read)
--   และห้ามบอทแย่งตอบผู้ตรวจสอบก่อนที่เซลส์/ผู้ตรวจสอบจะได้ตอบเอง
--
-- ★ ทำไมใช้ is_test ตัวเดียวกับคำสั่ง "test" (sql/031) ไม่ได้เฉย ๆ
--   sql/031_test_reset.sql ตั้งใจให้ is_test=true คู่กับ mode='bot' เพราะทีมใช้
--   คำสั่งนั้น "ทดสอบบอท" — ต้องการให้บอทตอบตามปกติ ถ้าที่นี่ไปเพิ่มเงื่อนไข
--   "is_test แปลว่าบอทห้ามตอบ" เข้าไปใน inbox.decide_reply จะทำให้ทีมทดสอบบอท
--   ไม่ได้อีกต่อไป (ของจริง: TEST_USER_IDS ใช้ได้ทั้ง LINE และ Messenger)
--
--   ทางที่ปลอดภัยกว่าคือใช้ inbox.conversation.mode ซึ่งเป็นกลไกกันบอทตอบที่มีอยู่
--   แล้ว (inbox.decide_reply บรรทัด reply.respect_convo_mode, sql/002_decide.sql)
--   ตั้ง mode='human' ให้กับบทสนทนาที่ทริกเกอร์ด้วยรหัสรีวิวเท่านั้น ส่วน is_test
--   ยังทำหน้าที่เดิม (มองเห็นได้/ไม่นับสถิติ) โดยไม่ต้องแตะ decide_reply เลย
--
-- ★ ตรวจข้อความในฝั่ง Node (server.mjs: tagReviewCode) ไม่ใช่ในฟังก์ชันนี้
--   เพราะรหัสรีวิวมาจาก env META_REVIEW_CODE ซึ่ง SQL อ่านตรง ๆ ไม่ได้ (ไม่ใช่
--   inbox.settings ของแต่ละ inbox) — Node เช็ค channel key 'asher-messenger'
--   + prefix แล้วส่งธง p_data->>'review_code_hit' มาที่นี่ ฟังก์ชันนี้เชื่อธงนั้น
--   ตรง ๆ ไม่ตรวจซ้ำ (ผู้เรียกเดียวคือ service_role ผ่าน action 'receive')
--
-- ประกอบจาก sql/036_echo_source_from_queue.sql ทั้งฟังก์ชัน — เพิ่มบล็อกเดียว
-- หลัง v_text ถูกคำนวณ กิ่งอื่นไม่ถูกแตะ (นับ marker ก่อน-หลังเท่ากัน)
-- =====================================================================

begin;

-- ── ด่านตรวจ: ต้องเป็นรุ่น 036 อยู่ก่อน ───────────────────────────────
do $dep$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'connect_private' and p.proname = 'receive_event'
                    and strpos(pg_get_functiondef(p.oid), 'v_is_ours') > 0)
  then raise exception 'receive_event บนฐานยังไม่ใช่รุ่น 035/036 — ต้องลง sql/036_echo_source_from_queue.sql ก่อน'; end if;
end $dep$;

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
  -- ★ เพิ่มใน 035: แยกที่มาของ echo และกันข้อความของเราเองซ้ำ
  v_bot_app text; v_is_ours boolean; v_own uuid; v_source text;
  v_who text; v_staff uuid; v_staff_user uuid;
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

  -- ── Meta App Review: รหัสรีวิวจาก asher-messenger (server.mjs: tagReviewCode)
  --   ติดธง is_test ถาวร (เหมือน sql/031) + mode='human' กันบอทตอบผู้ตรวจสอบ
  --   ★ ต้องตั้ง mode ไม่ใช่แค่ is_test — is_test อย่างเดียวไม่กันบอท (ดูหัวไฟล์)
  --   ★ ต้องอัปเดต v_convo ในตัวแปรด้วย ไม่ใช่แค่ในตาราง — v_ctx ข้างล่างอ่านจาก
  --     v_convo.mode ที่ select ไว้ก่อนหน้านี้แล้ว ไม่ query ซ้ำ
  --   trigger conversation_sync_mode จะตั้ง bot_active=false ให้เองจาก mode นี้
  --   ★ เช็ค v_inbox.channel ซ้ำอีกชั้นแม้ server.mjs กรอง asher-messenger มาแล้ว
  --     กันบั๊กฝั่ง Node ในอนาคตไม่ให้ไปปิดบอท/ตัดสถิติของ LINE โดยไม่ตั้งใจ
  if v_inbox.channel = 'messenger' and coalesce((p_data->>'review_code_hit')::boolean, false) then
    update inbox.conversation set is_test = true, mode = 'human' where id = v_id;
    v_convo.is_test := true;
    v_convo.mode := 'human';
  end if;

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

  -- ── echo: เพจเป็นคนส่ง ไม่ใช่ลูกค้า — ต้องรู้ให้ได้ว่า "ใครในฝั่งเรา"
  --
  -- ของเดิมตัดสินแค่สองทาง (bot / agent) จาก app_id เทียบกับ team.bot_app_id
  -- ซึ่งไม่เคยถูกตั้งค่าเลย → echo ของบอทเองถูกป้ายเป็น agent แล้วไปเรียก
  -- mark_human_reply() ทำให้ decide_reply เห็น human_owns_convo
  -- ผลคือบอทตอบครั้งเดียวแล้วเงียบถาวรในแชทนั้น (ดูหัวไฟล์ 035)
  if v_event_type = 'echo' then
    v_app_id  := p_data->>'app_id';
    v_bot_app := inbox.cfg_text(v_inbox.id, 'team.bot_app_id', '');
    v_is_ours := v_app_id is not null and v_bot_app <> '' and v_app_id = v_bot_app;

    -- ★ กันซ้ำชั้นที่สอง — ด่าน connect_private.inbound_event กันได้แค่
    --   "echo ก้อนเดิมถูกยิงมาสองครั้ง" แต่กันไม่ได้ว่า "ข้อความที่เราส่งเอง
    --   เด้งกลับมาเป็นแถวที่สองในบทสนทนา" ซึ่งเกิดกับทุกข้อความที่แอปส่ง
    --   (ของจริง 2026-09-15: ทุกข้อความของเรามีแถวคู่ ห่างกันราว 1 วินาที)
    --   ด่านนี้คือ mid ของ echo = provider_id ที่ตัวส่งบันทึกไว้ในคิวขาออก
    select d.message_id into v_own
      from connect_private.delivery d
     where d.provider_id = p_data->>'event_id'
     limit 1;

    -- ★ กรณี echo มาถึงก่อนที่ตัวส่งจะบันทึก provider_id ลงคิว (แข่งกันได้จริง —
    --   Meta เด้ง echo กลับใน ~1 วินาที ส่วน worker กว่าจะ finish อาจช้ากว่านั้น)
    --   เคสนี้ mid ยังไม่มีในคิว จึงจับคู่ด้วยเนื้อความ + หน้าต่างเวลาสั้น ๆ แทน
    --   ★ ปลอดภัยเพราะทำงานเฉพาะเมื่อ app_id เป็นของแอปเราเท่านั้น — เซลส์ที่
    --     พิมพ์ข้อความเดียวกันจาก Page Inbox มี app_id ของ Meta ไม่เข้าเงื่อนไขนี้
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

    -- ★ ป้ายที่มา สี่ทาง
    --   bot        แอปเราส่ง และแถวต้นทางเป็นข้อความของบอท
    --   workspace  แอปเราส่ง แต่แถวต้นทางเป็นเซลส์กดส่งจากหน้าจอเรา
    --   page_inbox คนตอบจาก Page Inbox / Business Suite ของ Meta
    --   other_app  แอปอื่นที่ผูกกับเพจนี้
    -- ★ ข้อเท็จจริงจากของจริง: Page Inbox ส่ง app_id ของ Business Suite มาด้วย
    --   เสมอ (263902037430900) ไม่ได้ปล่อยว่างอย่างที่คอมเมนต์ใน providers.mjs เขียนไว้
    --   จึงเทียบกับทะเบียน team.page_inbox_app_ids ไม่ใช่เช็ค null
    -- ★ ลำดับสำคัญ: ถ้าผูกกับแถวขาออกของเราได้แล้ว ให้เชื่อ "แถว" ก่อน "app_id"
    --   ของจริง 2026-09-14..15: echo ของข้อความที่เราส่งเอง 8 ก้อน มาด้วย app_id
    --   สองค่า — 946246731840651 (แอปเรา) 5 ก้อน และ 1905070200457329 3 ก้อน
    --   ถ้าตัดสินจาก app_id อย่างเดียว สามก้อนหลังจะถูกป้ายเป็น other_app
    --   ทั้งที่เป็นข้อความของเราเอง — mid ที่ตรงกับคิวขาออกเป็นหลักฐานที่หนักกว่า
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

    -- ── ของเราเอง: ผูก mid กลับเข้าแถวเดิม ไม่สร้างแถวใหม่ ไม่นับว่า "คนตอบ"
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

    -- ── ใครตอบ: อ่านจากลายเซ็นท้ายข้อความ (team.signatures)
    --   ★ ยังไม่มีใครใช้คอนฟิกนี้มาก่อน — seed_bot_defaults หว่านไว้เฉย ๆ
    --     ที่นี่เป็นที่แรกที่เอามาใช้จริง
    --   ★ inbox.sales_staff ยังว่าง 0 แถว ตอนนี้จึงได้แต่ชื่อ (ลงใน note)
    --     พอมีใครลงทะเบียนพร้อม user_id แล้ว sender_id จะถูกเซ็ตให้เองทันที
    --     และรายงานที่ join sales_staff อยู่แล้วจะเห็นชื่อคนตอบโดยไม่ต้องแก้อะไร
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

    -- ธงเดียวกับที่ connect_private.replay() ใช้ — กัน trigger สร้างงานขาออก
    -- ถ้าไม่ตั้ง ข้อความที่ทีมเพิ่งตอบไปจะถูกส่งกลับไปหาลูกค้าอีกรอบ
    perform set_config('connect.replay', 'on', true);
    v_sender := case when v_is_ours then 'bot' else 'agent' end;
    insert into inbox.message(conversation_id, sender_type, sender_id, content, content_type, event_type,
                              external_message_id, created_at)
    values (v_id, v_sender, v_staff_user, v_text, coalesce(p_data->>'content_type','text'), 'message',
            p_data->>'event_id', v_time)
    returning id into v_message;

    if v_sender = 'agent' then
      -- ★ source ละเอียดกว่าคำว่า 'echo' เดิม — แยกได้ว่าเซลส์ตอบจากที่ไหน
      --   (page_inbox / other_app) เทียบกับ 'workspace' ที่ตัวส่งของเราบันทึกไว้
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
end $function$;

grant execute on function connect_private.receive_event(jsonb, timestamptz, int) to service_role;

-- =====================================================================
-- excluded from reply stats / points (เกี่ยวกับ requirement ข้อ 3 ของ STEP 1)
--
-- ★ ช่องโหว่ที่เจอระหว่างตรวจ: inbox.stats_normalize (sql/017_stats_functions.sql)
--   คำนวณ 'countable' โดยไม่เช็ค conversation.is_test เลย — สวนทางกับคอมเมนต์บน
--   คอลัมน์เอง ("แชททดสอบ ... ไม่นับใน ... คะแนนผู้ตอบ ... " sql/031) แชท is_test
--   ทุกแชท (ทั้งจากคำสั่ง "test" และจากรหัสรีวิวนี้) จึงหลุดเข้า response_window/
--   หน้าสถิติการตอบ (sql/016-018, 027) มาตลอด — ไม่ใช่บั๊กใหม่ที่ไฟล์นี้สร้าง
--   แต่ต้องปิดเพื่อให้ "excluded from reply stats / points" เป็นจริง
-- ★ ไม่แตะ reply_stats (sql/009) / conversation_outcomes (sql/013) /
--   case_status (sql/023) — สามตัวนั้นกรอง is_test ไว้แล้ว
-- =====================================================================
create or replace function inbox.stats_normalize(m inbox.message)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'message_id',      m.id,
    'conversation_id', m.conversation_id,
    'channel_key',     coalesce(i.channel, 'unknown'),
    'project',         p.code,
    'customer_ref',    ci.external_id,
    'direction',       case when m.sender_type = 'contact' then 'in' else 'out' end,
    'actor',           case m.sender_type
                         when 'contact' then 'customer'
                         when 'bot'     then 'bot'
                         when 'agent'   then 'human'
                         else 'ignore' end,
    'profile_id',      m.sender_id,
    'text',            m.content,
    'is_echo',         (m.sender_type = 'agent' and m.sender_id is null),
    -- ★ เพิ่ม not coalesce(c.is_test,false) — แชททดสอบต้องไม่เปิด/ปิด response_window
    'countable',       (m.event_type = 'message' and m.sender_type <> 'system'
                         and not coalesce(c.is_test, false)),
    'created_at',      m.created_at
  )
  from (select 1) _
  left join inbox.conversation c  on c.id = m.conversation_id
  left join inbox.inbox        i  on i.id = c.inbox_id
  left join core.project       p  on p.id = i.project_id
  left join lateral (
    select x.external_id from core.contact_identity x
     where x.contact_id = c.contact_id and x.channel = i.channel limit 1
  ) ci on true
$$;

commit;
