-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3 — ตรรกะตัดสินใจของบอท ย้ายจาก TypeScript มาอยู่ใน Postgres
--
-- ที่มา: decideReply / decideNotify / decideDelay / decideWatchdog
--        ใน reference/bot-webhook.ts (bot-webhook_fixed.ts 09-09 21:37)
--
-- กติกาของไฟล์นี้
--   1. ★ ห้ามมี now() ในตรรกะเด็ดขาด — เวลาเข้ามาทาง p_now เสมอ
--      ของเดิมใช้ global CLOCK ที่ถูกตั้ง/ล้างรอบการเรียก ซึ่งทดสอบเวลาขอบ ๆ ได้ยาก
--      และพังทันทีถ้ามีสองคำขอพร้อมกัน — p_now แก้ทั้งสองเรื่องด้วยตัวเดียว
--   2. ★ ห้ามสุ่มข้างใน — jitter ส่งเข้ามาทาง p_jitter
--      ของเดิมเรียก Math.random() กลางตรรกะ ทำให้ผลไม่ซ้ำเดิมสองครั้ง
--   3. ค่าเงื่อนไขทุกตัวมาจาก inbox.bot_config / inbox.bot_schedule ต่อ inbox
--      ไม่มีเลขวิเศษในโค้ด — เปลี่ยนพฤติกรรมด้วยการเปลี่ยนข้อมูล ไม่ใช่แก้ฟังก์ชัน
--
-- รันซ้ำได้ (create or replace ทั้งหมด)
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1) ตัวช่วยเรื่องเวลาและค่าตั้งค่า
-- ───────────────────────────────────────────────────────────────────────────

create or replace function inbox.bangkok_hour(p_now timestamptz)
returns integer language sql immutable
set search_path = pg_catalog, public
as $$ select extract(hour from p_now at time zone 'Asia/Bangkok')::int $$;

/**
 * ชั่วโมงนี้อยู่ในช่วงไหม — ความหมายเดียวกับ withinHours() ของเดิมเป๊ะ
 *   start < end  → [start, end)
 *   start > end  → ข้ามเที่ยงคืน
 *   0 ถึง 24     → ตลอดเวลา
 */
create or replace function inbox.within_hours(p_hour int, p_start int, p_end int)
returns boolean language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_start = 0 and p_end = 24 then true
    when p_start <= p_end then p_hour >= p_start and p_hour < p_end
    else p_hour >= p_start or p_hour < p_end
  end
$$;

-- อ่านค่าตั้งค่าแบบมีชนิด — ไม่มีค่าในฐาน = ใช้ค่าสำรองที่ผู้เรียกระบุ
create or replace function inbox.cfg_bool(p_inbox uuid, p_key text, p_default boolean)
returns boolean language sql stable set search_path = pg_catalog, public
as $$ select coalesce((inbox.bot_cfg(p_inbox, p_key))::boolean, p_default) $$;

create or replace function inbox.cfg_int(p_inbox uuid, p_key text, p_default int)
returns int language sql stable set search_path = pg_catalog, public
as $$ select coalesce((inbox.bot_cfg(p_inbox, p_key))::int, p_default) $$;

create or replace function inbox.cfg_text(p_inbox uuid, p_key text, p_default text)
returns text language sql stable set search_path = pg_catalog, public
as $$ select coalesce(inbox.bot_cfg(p_inbox, p_key) #>> '{}', p_default) $$;

/**
 * นาทีจาก ctx โดยที่ "ไม่มีค่า" แปลว่า นานมาก
 *
 * ของเดิมใช้ Infinity ของ JavaScript ซึ่งเทียบแล้วได้ผลต่างกันสองทาง
 *   Infinity < 720   → false   (ไม่เคยมีคนตอบ = ไม่ได้เพิ่งตอบ)
 *   Infinity >= 15   → true    (ไม่เคยแจ้ง = ถึงเวลาแจ้งได้แล้ว)
 * ถ้าแปลงเป็น null เฉย ๆ ทั้งสองเงื่อนไขจะกลายเป็น null แล้วผลเพี้ยนคนละทาง
 * float8 ของ Postgres มี 'Infinity' จริง จึงใช้ตัวนั้นให้ตรงกับของเดิมทุกกรณี
 */
create or replace function inbox.ctx_min(p_ctx jsonb, p_key text)
returns double precision language sql immutable
set search_path = pg_catalog, public
as $$ select coalesce((p_ctx ->> p_key)::double precision, 'Infinity'::double precision) $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2) บอทตอบไหม — port ตรงจาก decideReply()
--
-- ลำดับการตัดสินสำคัญพอ ๆ กับตัวเงื่อนไข ห้ามสลับ
-- เช่น standby ต้องมาก่อน adminBypass ไม่งั้นแอดมินที่ทักมาตอน standby จะได้คำตอบซ้อน
-- กับแอปที่ถือ thread อยู่
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.decide_reply(p_inbox uuid, p_ctx jsonb, p_now timestamptz)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_hour int; w record; v_hold int;
begin
  if not inbox.cfg_bool(p_inbox, 'reply.enabled', true) then
    return jsonb_build_object('go', false, 'reason', 'reply_disabled');
  end if;

  if coalesce((p_ctx->>'is_standby')::boolean, false) then
    return jsonb_build_object('go', false, 'reason', 'not_thread_owner');
  end if;

  if coalesce((p_ctx->>'is_admin')::boolean, false)
     and inbox.cfg_bool(p_inbox, 'reply.admin_bypass', true) then
    return jsonb_build_object('go', true, 'reason', 'admin_bypass');
  end if;

  if not coalesce((p_ctx->>'has_text')::boolean, false)
     and not inbox.cfg_bool(p_inbox, 'reply.reply_to_attachment_only', false) then
    return jsonb_build_object('go', false, 'reason', 'attachment_only');
  end if;

  if inbox.cfg_bool(p_inbox, 'reply.respect_convo_mode', true)
     and coalesce(p_ctx->>'convo_mode', 'bot') <> 'bot' then
    return jsonb_build_object('go', false, 'reason', 'convo_mode_' || coalesce(p_ctx->>'convo_mode', 'bot'));
  end if;

  -- คนตอบแชทนี้ไปแล้ว บอทไม่ยุ่งต่ออีกช่วงหนึ่ง
  v_hold := inbox.cfg_int(p_inbox, 'reply.human_hold_min', 0);
  if v_hold > 0 and inbox.ctx_min(p_ctx, 'human_replied_min') < v_hold then
    return jsonb_build_object('go', false, 'reason', 'human_owns_convo');
  end if;

  -- ช่วงเวลาแรกที่ครอบชั่วโมงนี้ (ของเดิมใช้ .find() = ตัวแรกที่เจอ)
  v_hour := inbox.bangkok_hour(p_now);
  select * into w from inbox.bot_schedule s
   where s.inbox_id = p_inbox and s.is_active
     and inbox.within_hours(v_hour, s.start_hour, s.end_hour)
   order by s.start_hour
   limit 1;

  if not found then
    -- นอกตาราง: เงียบ หรือตอบรับสั้น ๆ
    return jsonb_build_object(
      'go', inbox.cfg_text(p_inbox, 'reply.outside_schedule', 'silent') = 'ack',
      'reason', 'outside_schedule_' || inbox.cfg_text(p_inbox, 'reply.outside_schedule', 'silent'));
  end if;

  if w.mode = 'wait_human' then
    return jsonb_build_object('go', true, 'reason', 'wait_human_' || coalesce(w.wait_min, 30) || 'm',
                              'wait_min', coalesce(w.wait_min, 30));
  end if;
  return jsonb_build_object('go', true, 'reason', 'immediate');
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 3) แจ้งทีมไหม — port ตรงจาก decideNotify()
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.decide_notify(p_inbox uuid, p_ctx jsonb, p_reply jsonb, p_now timestamptz)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_rule text; v_remind int; v_is_lead boolean; v_reply_go boolean;
begin
  if not inbox.cfg_bool(p_inbox, 'notify.enabled', true) then
    return jsonb_build_object('go', false, 'reason', 'notify_disabled');
  end if;
  if inbox.cfg_bool(p_inbox, 'notify.test_mode', false) then
    return jsonb_build_object('go', true, 'reason', 'test_mode');
  end if;
  if coalesce((p_ctx->>'is_admin')::boolean, false)
     and not inbox.cfg_bool(p_inbox, 'notify.include_admins', false) then
    return jsonb_build_object('go', false, 'reason', 'admin');
  end if;

  v_is_lead := (p_ctx->>'phone_in_text') is not null or (p_ctx->>'line_in_text') is not null;
  if inbox.cfg_bool(p_inbox, 'notify.always_on_lead', true) and v_is_lead then
    return jsonb_build_object('go', true, 'reason', 'lead');
  end if;
  if inbox.cfg_bool(p_inbox, 'notify.always_on_repeat', true)
     and coalesce((p_ctx->>'verbatim_repeat')::boolean, false) then
    return jsonb_build_object('go', true, 'reason', 'verbatim_repeat');
  end if;

  v_reply_go := coalesce((p_reply->>'go')::boolean, false);
  if inbox.cfg_bool(p_inbox, 'notify.always_when_bot_silent', true)
     and not v_reply_go and coalesce((p_ctx->>'is_new_chat')::boolean, false) then
    return jsonb_build_object('go', true, 'reason', 'bot_silent_new');
  end if;

  v_rule := inbox.cfg_text(p_inbox, 'notify.rule', 'unanswered');
  if v_rule = 'every' then
    return jsonb_build_object('go', true, 'reason', 'every');
  elsif v_rule = 'new_chat' then
    if coalesce((p_ctx->>'is_new_chat')::boolean, false)
       or inbox.ctx_min(p_ctx, 'gap_hours') >= inbox.cfg_int(p_inbox, 'notify.new_chat_gap_hours', 6) then
      return jsonb_build_object('go', true, 'reason', 'new_chat_or_gap');
    end if;
    return jsonb_build_object('go', false, 'reason', 'within_gap');
  else
    -- unanswered
    if coalesce((p_ctx->>'is_new_chat')::boolean, false) then
      return jsonb_build_object('go', true, 'reason', 'new_chat');
    end if;
    v_remind := inbox.cfg_int(p_inbox, 'notify.remind_after_min', 0);
    if v_remind <= 0 then
      -- แจ้งครั้งเดียวตอนแชทใหม่ ไม่เตือนซ้ำ
      return jsonb_build_object('go', false, 'reason', 'no_repeat');
    end if;
    if inbox.ctx_min(p_ctx, 'unanswered_since_notify_min') >= v_remind then
      return jsonb_build_object('go', true,
        'reason', case when v_reply_go then 'still_unanswered' else 'bot_silent_unanswered' end);
    end if;
    return jsonb_build_object('go', false, 'reason', 'recently_notified');
  end if;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 4) หน่วงกี่วินาที — port ตรงจาก decideDelay()
--
-- ★ jitter มาจากข้างนอก ของเดิมเรียก Math.random() ตรงนี้
--   ผลคือเทสต์เดิมเทียบได้แค่ "ตอบเลย/รอคน" เทียบตัวเลขวินาทีไม่ได้เลย
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.decide_delay(p_inbox uuid, p_ctx jsonb, p_reply jsonb, p_jitter int default 0)
returns int
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_wait int; v_base int;
begin
  v_wait := coalesce((p_reply->>'wait_min')::int, 0);
  if v_wait > 0 then return v_wait * 60; end if;   -- รอคน → ไม่มี jitter

  v_base := case when coalesce((p_ctx->>'is_new_chat')::boolean, false)
                 then inbox.cfg_int(p_inbox, 'delay.first_reply_sec', 15)
                 else inbox.cfg_int(p_inbox, 'delay.next_reply_sec', 6) end;
  return v_base + least(greatest(coalesce(p_jitter, 0), 0), inbox.cfg_int(p_inbox, 'delay.jitter_sec', 4));
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 5) รวมการตัดสินใจ — port ตรงจาก decideAll()
--
-- ของจริงกับเทสต์ต้องเดินผ่านฟังก์ชันตัวเดียวกันเสมอ ไม่งั้นเทสต์รับประกันอะไรไม่ได้
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.decide_all(p_inbox uuid, p_ctx jsonb, p_now timestamptz, p_jitter int default 0)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_reply jsonb; v_notify jsonb; v_delay int; v_action text;
        v_is_lead boolean; v_in_hours boolean; v_outside text; v_hour int;
begin
  v_reply  := inbox.decide_reply(p_inbox, p_ctx, p_now);
  v_notify := inbox.decide_notify(p_inbox, p_ctx, v_reply, p_now);
  v_delay  := case when coalesce((v_reply->>'go')::boolean, false)
                   then inbox.decide_delay(p_inbox, p_ctx, v_reply, p_jitter) else 0 end;
  v_hour   := inbox.bangkok_hour(p_now);

  v_action := 'none';
  if coalesce((v_notify->>'go')::boolean, false) then
    v_is_lead := (p_ctx->>'phone_in_text') is not null or (p_ctx->>'line_in_text') is not null;
    v_in_hours := inbox.within_hours(v_hour,
                    inbox.cfg_int(p_inbox, 'notify.hours.start', 0),
                    inbox.cfg_int(p_inbox, 'notify.hours.end', 24))
                  or (inbox.cfg_bool(p_inbox, 'notify.leads_ignore_hours', false) and v_is_lead);
    v_outside := inbox.cfg_text(p_inbox, 'notify.outside_hours', 'send');
    v_action := case when v_in_hours or v_outside = 'send' then 'send'
                     when v_outside = 'queue' then 'queue'
                     else 'skip' end;
  end if;

  return jsonb_build_object('reply', v_reply, 'notify', v_notify,
                            'delay_sec', v_delay, 'notify_action', v_action, 'hour', v_hour);
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 6) ค้างตอบกลางวัน — port ตรงจาก decideWatchdog()
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.decide_watchdog(p_inbox uuid, p_ctx jsonb, p_now timestamptz)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare v_after int; v_repeat int;
begin
  if not inbox.cfg_bool(p_inbox, 'notify.watchdog.enabled', false) then
    return jsonb_build_object('go', false, 'reason', 'watchdog_disabled');
  end if;
  if coalesce((p_ctx->>'is_admin')::boolean, false) then
    return jsonb_build_object('go', false, 'reason', 'admin');
  end if;
  if not inbox.within_hours(inbox.bangkok_hour(p_now),
        inbox.cfg_int(p_inbox, 'notify.watchdog.hours.start', 9),
        inbox.cfg_int(p_inbox, 'notify.watchdog.hours.end', 19)) then
    return jsonb_build_object('go', false, 'reason', 'outside_watchdog_hours');
  end if;
  if coalesce((p_ctx->>'page_replied_after_msg')::boolean, false) then
    return jsonb_build_object('go', false, 'reason', 'answered');
  end if;

  v_after := inbox.cfg_int(p_inbox, 'notify.watchdog.after_min', 120);
  if inbox.ctx_min(p_ctx, 'min_since_msg') < v_after then
    return jsonb_build_object('go', false, 'reason', 'too_soon');
  end if;

  if coalesce((p_ctx->>'notified_after_msg')::boolean, false) then
    v_repeat := inbox.cfg_int(p_inbox, 'notify.watchdog.repeat_every_min', 0);
    if v_repeat > 0 and inbox.ctx_min(p_ctx, 'min_since_notified') >= v_repeat then
      return jsonb_build_object('go', true, 'reason', 'still_unanswered_repeat');
    end if;
    return jsonb_build_object('go', false, 'reason', 'already_notified');
  end if;

  return jsonb_build_object('go', true, 'reason', 'unanswered_' || v_after || 'm');
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 7) ดึงเบอร์ / LINE id ออกจากข้อความ — port จาก extractThaiPhone / extractLineId
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.extract_phone(p_text text)
returns text
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare v_raw text; v_digits text;
begin
  if p_text is null then return null; end if;
  v_raw := substring(p_text from '(\+?66|0)[[:space:]]?[689][[:space:]]?[0-9]([- ]?[0-9]){7}');
  if v_raw is null then return null; end if;
  v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
  if left(v_digits, 2) = '66' then v_digits := '0' || substr(v_digits, 3); end if;
  return case when v_digits ~ '^0[689][0-9]{8}$' then v_digits else null end;
end $$;

create or replace function inbox.extract_line_id(p_text text)
returns text
language sql immutable
set search_path = pg_catalog, public
as $$
  select nullif(substring(p_text from '(?:line|ไลน์|id)[[:space:]]*[:;]?[[:space:]]*@?([a-zA-Z0-9_.\-]{3,})'), '')
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 8) รับ event เข้าระบบ — ตัดสินใจแล้วเข้าคิว
--
-- แยกออกมาจาก connect_private.worker() เป็นฟังก์ชันของตัวเอง เพราะมันโตขึ้นมาก
-- และเพราะต้องรับ p_now ได้เพื่อทดสอบเวลาขอบ ๆ โดยไม่ต้องรอให้ถึงเวลาจริง
--
-- งานที่ทำตามลำดับ
--   1. กันซ้ำที่ฐาน (inbound_event)
--   2. echo = ฝั่งเราเป็นคนตอบ → บันทึกเวลา + ยกเลิกงานที่บอทจ่อจะส่ง → จบ
--   3. ข้อความลูกค้า → contact/conversation → บันทึกข้อความ
--   4. ประกอบ ctx → decide_all → บันทึก bot_decisions
--   5. เข้าคิว: notify / generate (พร้อม send_after) / classify
-- ───────────────────────────────────────────────────────────────────────────
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
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 9) ค้างตอบ — ไล่ทั้งกระดานแล้วเข้าคิวแจ้ง
--
-- ไม่มี HTTP call กลับไปหา Node เลย ตัวนี้เป็น SQL ล้วน เรียกจากตัวตั้งเวลาอะไรก็ได้
-- ───────────────────────────────────────────────────────────────────────────
create or replace function inbox.watchdog(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare c record; v_ctx jsonb; v_verdict jsonb; v_checked int := 0; v_notified int := 0;
        v_last_page timestamptz; v_lookback int;
begin
  for c in
    select cv.*, i.id as ib, i.channel
      from inbox.conversation cv join inbox.inbox i on i.id = cv.inbox_id
     where i.is_active
       and inbox.cfg_bool(i.id, 'notify.watchdog.enabled', false)
       and cv.last_message_at is not null
       and cv.last_message_at >= p_now - make_interval(hours => inbox.cfg_int(i.id, 'notify.watchdog.lookback_hours', 24))
       and cv.last_message_at <= p_now - make_interval(mins => inbox.cfg_int(i.id, 'notify.watchdog.after_min', 120))
     order by cv.last_message_at desc
     limit 200
  loop
    v_checked := v_checked + 1;
    v_last_page := greatest(c.last_human_reply_at, c.last_bot_reply_at);
    v_ctx := jsonb_build_object(
      'min_since_msg', extract(epoch from (p_now - c.last_message_at)) / 60,
      'page_replied_after_msg', v_last_page is not null and v_last_page > c.last_message_at,
      'notified_after_msg', c.last_notified_at is not null and c.last_notified_at > c.last_message_at,
      'min_since_notified', case when c.last_notified_at is null then null
                                 else extract(epoch from (p_now - c.last_notified_at)) / 60 end,
      'convo_mode', coalesce(c.mode, 'bot'),
      'is_admin', false);

    v_verdict := inbox.decide_watchdog(c.ib, v_ctx, p_now);
    if coalesce((v_verdict->>'go')::boolean, false) then
      insert into connect_private.job(kind, channel, inbox_id, conversation_id, payload, send_after)
      values ('notify', 'team', c.ib, c.id,
              jsonb_build_object('reason', v_verdict->>'reason', 'kind', 'watchdog',
                                 'min_since_msg', round((v_ctx->>'min_since_msg')::numeric),
                                 'text', left(coalesce((select content from inbox.message
                                                         where conversation_id = c.id and sender_type = 'contact'
                                                         order by created_at desc limit 1), ''), 200)),
              p_now);
      update inbox.conversation set last_notified_at = p_now where id = c.id;
      v_notified := v_notified + 1;
    end if;
  end loop;
  return jsonb_build_object('checked', v_checked, 'notified', v_notified);
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 10) ต่อสายเข้ากับ worker เดิม
--
-- worker('receive') ยังเป็นทางเข้าเดียวเหมือนเดิม เปลี่ยนแค่ว่าข้างในเรียกตัวใหม่
-- ★ now() อยู่ตรงนี้ที่เดียว — ตรรกะข้างในไม่รู้จักนาฬิกา
-- ★ jitter สุ่มตรงนี้ที่เดียวเช่นกัน
-- ───────────────────────────────────────────────────────────────────────────
create or replace function connect_private.receive(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_inbox uuid;
begin
  v_inbox := (p_data->>'inbox_id')::uuid;
  return connect_private.receive_event(
    p_data, now(),
    (random() * inbox.cfg_int(v_inbox, 'delay.jitter_sec', 4))::int);
end $$;

-- สิทธิ์: เครื่องคุยกับเครื่องเท่านั้น
revoke all on function inbox.decide_reply(uuid,jsonb,timestamptz), inbox.decide_notify(uuid,jsonb,jsonb,timestamptz),
                      inbox.decide_delay(uuid,jsonb,jsonb,int), inbox.decide_all(uuid,jsonb,timestamptz,int),
                      inbox.decide_watchdog(uuid,jsonb,timestamptz), inbox.watchdog(timestamptz),
                      connect_private.receive_event(jsonb,timestamptz,int), connect_private.receive(jsonb)
  from public, anon, authenticated;
grant execute on function inbox.decide_reply(uuid,jsonb,timestamptz), inbox.decide_notify(uuid,jsonb,jsonb,timestamptz),
                          inbox.decide_delay(uuid,jsonb,jsonb,int), inbox.decide_all(uuid,jsonb,timestamptz,int),
                          inbox.decide_watchdog(uuid,jsonb,timestamptz), inbox.watchdog(timestamptz),
                          connect_private.receive_event(jsonb,timestamptz,int), connect_private.receive(jsonb)
  to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- ยังไม่ทำ — รอคนตัดสิน
--
-- pg_cron: ยังไม่ create extension เพราะเป็นการเปลี่ยนฐานที่มีข้อมูลจริง (กติกาข้อ 9)
-- ตัวที่ต้องตั้งเวลามีสองงาน และทั้งคู่เป็น SQL ล้วนแล้ว เรียกจากอะไรก็ได้
--
--   select inbox.watchdog(now());                 -- ทุกนาที
--   -- digest 09:00 รอ Phase 7 (ต้องมี inbox.reply_report ก่อน)
--
-- ถ้าอนุมัติ pg_cron:
--   create extension pg_cron;
--   select cron.schedule('asher-watchdog', '* * * * *', $q$select inbox.watchdog(now())$q$);
-- ถ้าไม่เอา pg_cron ก็ให้ Windows Task Scheduler เรียก psql ตัวเดียวกันนี้ได้เลย
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- 11) worker('receive') → ส่งต่อให้ connect_private.receive()
--
-- ยกมาทั้งฟังก์ชันเพราะ plpgsql แทนที่ได้ทีละทั้งตัว — action อื่นเหมือนเดิมทุกบรรทัด
-- (คัดลอกจาก migration 20260914130000 ด้วยสคริปต์ ไม่ได้พิมพ์ใหม่ จึงไม่มีโอกาสพิมพ์ตก)
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function connect_private.worker(p_action text, p_data jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare v_inbox inbox.inbox; v_contact uuid; v_id uuid; v_message uuid; v_lead uuid;
 v_delivery connect_private.delivery; v_msg inbox.message;
 v_result jsonb; v_first boolean; v_time timestamptz;
 v_event_type text; v_log bigint; v_row connect_private.webhook_log;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_only' using errcode='42501'; end if;

 if p_action='receive' then
 -- ★ ตรรกะย้ายไป connect_private.receive() แล้ว (Phase 3)
 --   ที่นี่เหลือแค่ทางเข้า เพื่อให้ผู้เรียกเดิมไม่ต้องรู้ว่าข้างในเปลี่ยน
 return connect_private.receive(p_data);

 elsif p_action='log' then
 -- ทางเข้าของ webhook: เก็บของดิบให้จบแล้วปล่อยให้ผู้ส่งไปทำอย่างอื่นต่อ
 -- ตรงนี้ต้องเบาที่สุดในระบบ เพราะ LINE/Meta รออยู่ปลายสาย
 if coalesce(p_data->>'channel_key','')='' or coalesce(p_data->>'channel','')='' then raise exception 'invalid_event'; end if;
 insert into connect_private.webhook_log(channel_key,channel,inbox_id,payload)
 values(p_data->>'channel_key',p_data->>'channel',nullif(p_data->>'inbox_id','')::uuid,coalesce(p_data->'payload','{}'::jsonb))
 returning id into v_log;
 return jsonb_build_object('log_id',v_log);

 elsif p_action='claim_inbound' then
 -- โพรเซสที่ถือของไว้แล้วตายกลางทาง ปล่อยของกลับเข้าคิว
 -- ขาเข้าทำซ้ำได้ปลอดภัยเสมอ เพราะ inbound_event กันซ้ำอยู่แล้ว จึงไม่ต้องมีสถานะ uncertain แบบขาออก
 update connect_private.webhook_log set status='pending',lease_id=null
  where status='processing' and locked_at<now()-interval '2 minutes';
 with picked as (
   select w.id from connect_private.webhook_log w
    where w.status='pending' and w.available_at<=now()
      and w.channel_key in (select value from jsonb_array_elements_text(coalesce(p_data->'channel_keys','[]')))
    order by w.id limit 1 for update skip locked
 ), updated as (
   update connect_private.webhook_log w set status='processing',attempts=attempts+1,locked_at=now(),lease_id=gen_random_uuid()
    from picked p where w.id=p.id returning w.*
 ) select to_jsonb(u) into v_result from updated u;
 return v_result;

 elsif p_action='finish_inbound' then
 select * into v_row from connect_private.webhook_log where id=(p_data->>'log_id')::bigint for update;
 if not found or v_row.status<>'processing' or v_row.lease_id is distinct from (p_data->>'lease_id')::uuid then
   raise exception 'stale_lease';
 end if;
 if coalesce(p_data->>'status','')='done' then
   update connect_private.webhook_log set status='done',processed_at=now(),lease_id=null,last_error=null,
          events_count=coalesce((p_data->>'events_count')::int,0)
    where id=v_row.id;
 else
   -- ของดิบยังอยู่เสมอ ต่อให้ทำไม่สำเร็จ — ล้มเลิกแค่การประมวลผล ไม่ใช่ทิ้งหลักฐาน
   update connect_private.webhook_log
      set status=case when v_row.attempts<5 then 'pending' else 'failed' end,
          available_at=now()+make_interval(secs=>least(900,30*v_row.attempts)),
          last_error=left(p_data->>'error',200), lease_id=null
    where id=v_row.id;
 end if;
 return jsonb_build_object('ok',true);

 elsif p_action='sweep' then
 -- ในของดิบมีข้อความลูกค้าจริง เก็บเท่าที่ใช้ประโยชน์ได้แล้วลบ
 with gone as (delete from connect_private.webhook_log where received_at<now()-interval '30 days' returning 1)
 select jsonb_build_object('deleted',count(*)) into v_result from gone;
 return v_result;

 elsif p_action='claim' then
 -- A crashed non-idempotent Messenger send is uncertain and must not be resent automatically.
 update connect_private.delivery d set status='uncertain',last_error='delivery_confirmation_lost',lease_id=null
 from inbox.message m join inbox.conversation c on c.id=m.conversation_id join inbox.inbox i on i.id=c.inbox_id
 where d.message_id=m.id and d.status='processing' and d.locked_at<now()-interval '2 minutes' and i.channel<>'line';
 with picked as (
 select d.message_id from connect_private.delivery d join inbox.message m on m.id=d.message_id join inbox.conversation c on c.id=m.conversation_id join inbox.inbox i on i.id=c.inbox_id
 where i.is_active and i.id in (select value::uuid from jsonb_array_elements_text(coalesce(p_data->'inbox_ids','[]')))
 and d.available_at<=now() and (d.status='pending' or (d.status='processing' and d.locked_at<now()-interval '2 minutes' and i.channel='line'))
 and not exists(select 1 from connect_private.delivery older join inbox.message om on om.id=older.message_id where om.conversation_id=m.conversation_id and older.status in ('pending','processing','uncertain') and (om.created_at,om.id)<(m.created_at,m.id))
 order by d.created_at limit 1 for update of d skip locked
 ), updated as (update connect_private.delivery d set status='processing',attempts=attempts+1,locked_at=now(),lease_id=gen_random_uuid() from picked p where d.message_id=p.message_id returning d.*)
 select to_jsonb(u)||jsonb_build_object('text',m.content,'channel',i.channel,'inbox_id',i.id,'recipient',ci.external_id,'last_inbound_at',(select max(created_at) from inbox.message where conversation_id=c.id and sender_type='contact')) into v_result
 from updated u join inbox.message m on m.id=u.message_id join inbox.conversation c on c.id=m.conversation_id join inbox.inbox i on i.id=c.inbox_id
 left join core.contact_identity ci on ci.contact_id=c.contact_id and ci.channel=i.channel and ci.account_key=i.id::text;
 return v_result;

 elsif p_action='finish' then
 select * into v_delivery from connect_private.delivery where message_id=(p_data->>'message_id')::uuid for update;
 if not found or v_delivery.status<>'processing' or v_delivery.lease_id is distinct from (p_data->>'lease_id')::uuid then raise exception 'stale_lease'; end if;
 select * into strict v_msg from inbox.message where id=v_delivery.message_id;
 perform 1 from inbox.conversation where id=v_msg.conversation_id for update;
 if p_data->>'status'='sent' then
 update connect_private.delivery set status='sent',provider_id=p_data->>'provider_id',last_error=null,lease_id=null where message_id=v_delivery.message_id;
 update inbox.message set delivered_at=now() where id=v_delivery.message_id;
 select first_human_response_at is null into v_first from connect_private.case_state where conversation_id=v_msg.conversation_id;
 update connect_private.case_state set first_human_response_at=coalesce(first_human_response_at,now()),waiting_since=(select min(created_at) from inbox.message where conversation_id=v_msg.conversation_id and sender_type='contact' and created_at>v_msg.created_at) where conversation_id=v_msg.conversation_id;
 update inbox.conversation set sla_due_at=(select waiting_since+interval '30 minutes' from connect_private.case_state where conversation_id=v_msg.conversation_id) where id=v_msg.conversation_id;
 perform connect_private.emit(v_msg.conversation_id,'message_sent',jsonb_build_object('message_id',v_msg.id,'provider_id',p_data->>'provider_id'),v_msg.sender_id);
 if v_first then perform connect_private.emit(v_msg.conversation_id,'human_first_response',jsonb_build_object('message_id',v_msg.id),v_msg.sender_id); end if;
 else
 update connect_private.delivery set status=case when p_data->>'status'='uncertain' then 'uncertain' when p_data->>'status'='retry' and attempts<5 then 'pending' else 'failed' end,
 available_at=now()+make_interval(secs=>least(900,30*attempts)),last_error=left(p_data->>'error',200),lease_id=null where message_id=v_delivery.message_id;
 end if;
 return jsonb_build_object('ok',true);

 elsif p_action='health' then
 return jsonb_build_object(
   'pending',(select count(*) from connect_private.delivery where status in ('pending','processing')),
   'failed',(select count(*) from connect_private.delivery where status in ('failed','uncertain')),
   'inbound_pending',(select count(*) from connect_private.webhook_log where status in ('pending','processing')),
   'inbound_failed',(select count(*) from connect_private.webhook_log where status='failed'));
 end if;
 raise exception 'unknown_action';
end $$;


revoke all on function connect_private.worker(text,jsonb) from public,anon,authenticated;
grant execute on function connect_private.worker(text,jsonb) to service_role;

commit;
