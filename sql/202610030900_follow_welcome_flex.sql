-- =====================================================================
-- 202610030900_follow_welcome_flex.sql — Phase 2 ฝั่ง Connect
--   ข้อความต้อนรับแบบ Flex ตอนลูกค้าเพิ่มเพื่อน + ส่ง postback ต่อให้ CRM
-- =====================================================================
-- spec: line-roadmap-phases.md Phase 2 · docs/BOUNDARIES.md
--
-- ★ หน้าที่ของ Connect ในงานนี้มีสองอย่างเท่านั้น: "ส่งข้อความต้อนรับ" กับ "บอก CRM ว่าเกิดอะไรขึ้น"
--   ★★ ไม่มี logic สร้าง lead · ไม่เก็บ tag · ไม่ตัดสินว่าลูกค้าสนใจโครงการไหน
--      ปุ่มที่กดถูกส่งต่อเป็น event ดิบ ๆ CRM เป็นคนตัดสินใจทั้งหมด (BOUNDARIES)
--
-- ★ ไม่แตะ connect_private.receive_event และไม่แตะ inbox.enqueue_outbound เด็ดขาด
--   ทั้งคู่บน VPS ใหม่กว่า repo — ใช้ทริกเกอร์ after insert บน inbox.message แทน
--   แบบเดียวกับ trg_crm_publish_message (202609211300) และ trg_broadcast_follow_track
--
-- ★★ ทำไมออกทาง reply token ได้เอง ไม่ต้องเขียนท่อใหม่:
--   inbox.enqueue_outbound (ทริกเกอร์เดิม) เข้าคิวให้ทุกข้อความของ bot/agent อยู่แล้ว
--   ด้วย payload {"type":"text"} และมี ON CONFLICT (message_id) DO NOTHING
--   ชื่อทริกเกอร์เรียงตามตัวอักษร: enqueue_outbound < trg_follow_welcome_flex
--   → ของเดิมเข้าคิวก่อน แล้วไฟล์นี้ค่อย "อัปเกรด payload" เป็น Flex ทีหลัง
--   ตัวส่งเลือก reply token เองเมื่อ token ยังสด (providers.mjs canReplyToken)
--   ★ ผลด้านเงิน: reply message ไม่ถูกนับเข้าโควตา 300/เดือน — คนเพิ่มเพื่อนวันละร้อยคนก็ฟรี
--     (push/multicast เท่านั้นที่ถูกนับ ดู docs/runbook/2026-10-line-broadcast-deploy.md)
--
-- ★ ค่าตั้งต้นปิดไว้: reply.flex_welcome_on_follow = false
--   เปิดต่อ inbox ได้จาก inbox.bot_config โดยไม่ต้อง deploy
--
-- ★ รันซ้ำได้ (create or replace / on conflict do nothing / drop trigger ก่อนสร้าง)

begin;

-- ── 0. เปิดทางให้ outbox เดิมพา postback ไป CRM ───────────────────────
-- ★ ต้องอยู่หลัง 202610021200_line_broadcast.sql — ไฟล์นั้นตั้ง constraint ชุดก่อนหน้า
alter table inbox.crm_publish_outbox drop constraint if exists crm_publish_outbox_event_type_check;
alter table inbox.crm_publish_outbox add constraint crm_publish_outbox_event_type_check
  check (event_type in ('message.received', 'message.sent',
                        -- ★★ สองชนิดนี้มีแถวอยู่บน production แล้ว ห้ามตกจากรายการ
                        --   ADD CONSTRAINT CHECK ตรวจแถวเดิมทั้งตาราง ตกไปหนึ่งค่า = deploy ล้ม
                        'conversation.created', 'contact.profile_updated',
                        'channel_identity.follow_changed',
                        'channel_identity.postback',
                        'appointment.requested',
                        'broadcast.batch_result', 'broadcast.completed'));

-- ── 1. แบบของข้อความต้อนรับ ───────────────────────────────────────────
--
-- เก็บเป็น "ข้อมูล" ใน inbox.bot_config.value ไม่ใช่ "โค้ด" — แก้ข้อความ/ปุ่ม/สี
-- ได้จากฐานโดยไม่ต้อง deploy และไม่ต้องแก้ไฟล์นี้
--
-- ★ รูปแบบ data ของปุ่ม: 'asher:v1:interest=<code>'
--   ใส่เลขรุ่น v1 ไว้เพื่อให้ CRM แยกของเก่า/ใหม่ได้เมื่อวันหนึ่งเปลี่ยนรูปแบบ
--   ★★ Connect ไม่แปลความหมายของ <code> เลย — ส่งต่อดิบ ๆ CRM เป็นคนแมปเป็นโครงการ/tag
-- ★ ประกอบเป็นชั้น ๆ ด้วย CTE ไม่ซ้อน jsonb_build_object ลึก ๆ ในนิพจน์เดียว
--   เหตุผลตรง ๆ: ของซ้อนหกชั้นนับวงเล็บด้วยตาไม่ได้ และพลาดไปแล้วหนึ่งครั้งตอนเขียน
create or replace function inbox.follow_welcome_default()
returns jsonb language sql immutable set search_path = '' as $$
  with btn(code, label, display, style) as (values
    ('vibe',   'ASHER Vibe',  'สนใจ ASHER Vibe', 'primary'),
    ('naii',   'ASHER Naii',  'สนใจ ASHER Naii', 'primary'),
    ('unsure', 'ยังไม่แน่ใจ', 'ยังไม่แน่ใจ',     'secondary')
  ),
  buttons as (
    select jsonb_agg(jsonb_build_object(
             'type', 'button', 'style', b.style, 'height', 'sm',
             'action', jsonb_build_object(
               'type', 'postback', 'label', b.label,
               'data', 'asher:v1:interest=' || b.code, 'displayText', b.display))
           order by b.code = 'unsure', b.label) as items
      from btn b
  ),
  body as (
    select jsonb_build_object(
             'type', 'box', 'layout', 'vertical', 'spacing', 'md',
             'contents', jsonb_build_array(
               jsonb_build_object('type', 'text', 'text', 'ขอบคุณที่เพิ่มเพื่อน ASHER 🙏',
                                  'weight', 'bold', 'size', 'md', 'wrap', true),
               jsonb_build_object('type', 'text', 'wrap', true, 'size', 'sm', 'color', '#666666',
                                  'text', 'เลือกโครงการที่สนใจ เพื่อให้ทีมส่งข้อมูลที่ตรงกับคุณที่สุด'))
           ) as box
  ),
  footer as (
    select jsonb_build_object('type', 'box', 'layout', 'vertical', 'spacing', 'sm',
                              'contents', buttons.items) as box
      from buttons
  )
  select jsonb_build_object(
           'type', 'flex',
           -- altText คือสิ่งที่โผล่ในรายการแชทและใน notification ต้องอ่านรู้เรื่องด้วยตัวเอง
           'altText', 'ขอบคุณที่เพิ่มเพื่อน ASHER — สนใจโครงการไหนครับ',
           'contents', jsonb_build_object('type', 'bubble', 'body', body.box, 'footer', footer.box))
    from body, footer
$$;

comment on function inbox.follow_welcome_default() is
  'แบบตั้งต้นของข้อความต้อนรับ Flex — ทับได้ด้วย inbox.bot_config key line.follow_welcome_flex';

-- seed ลง bot_config ของทุก inbox ที่ยังไม่มีค่า (แก้ทีหลังได้ ไม่ถูกทับตอนรันซ้ำ)
insert into inbox.bot_config(inbox_id, key, value, note)
select i.id, 'line.follow_welcome_flex', inbox.follow_welcome_default(),
       'ข้อความต้อนรับ Flex ตอนลูกค้าเพิ่มเพื่อน (Phase 2) — ปุ่มส่ง postback asher:v1:interest=<code>'
  from inbox.inbox i
 where i.channel = 'line'
on conflict (inbox_id, key) do nothing;

-- สวิตช์เปิด/ปิด — ★ ปิดไว้เป็นค่าตั้งต้น เปิดเมื่อพร้อมทดสอบ
insert into inbox.bot_config(inbox_id, key, value, note)
select i.id, 'reply.flex_welcome_on_follow', to_jsonb(false),
       'เปิด = ตอบ Flex เลือกโครงการตอนลูกค้าเพิ่มเพื่อน (ใช้ reply token ไม่กินโควตา)'
  from inbox.inbox i
 where i.channel = 'line'
on conflict (inbox_id, key) do nothing;

-- ── 2. ตอบ Flex ตอนเพิ่มเพื่อน ────────────────────────────────────────
create or replace function inbox.follow_welcome_send()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, inbox, core, connect_private as $$
declare v_inbox inbox.inbox; v_flex jsonb; v_msg uuid; v_alt text;
begin
  if NEW.event_type <> 'follow' then return NEW; end if;

  select i.* into v_inbox
    from inbox.conversation c join inbox.inbox i on i.id = c.inbox_id
   where c.id = NEW.conversation_id;
  if v_inbox.id is null or v_inbox.channel <> 'line' then return NEW; end if;
  if not inbox.cfg_bool(v_inbox.id, 'reply.flex_welcome_on_follow', false) then return NEW; end if;

  select value into v_flex from inbox.bot_config
   where inbox_id = v_inbox.id and key = 'line.follow_welcome_flex';
  v_flex := coalesce(v_flex, inbox.follow_welcome_default());
  if jsonb_typeof(v_flex) <> 'object' or v_flex->>'contents' is null then return NEW; end if;
  v_alt := coalesce(v_flex->>'altText', 'ขอบคุณที่เพิ่มเพื่อน ASHER');

  -- ข้อความของบอทตามปกติ — ทริกเกอร์ enqueue_outbound เดิมพาเข้าคิวขาออกให้เอง
  -- ทางออกสู่ลูกค้าจึงยังมีทางเดียวทั้งระบบ (เหมือน welcome text ของ receive_event)
  -- ★ content เป็น altText เพราะมันคือสิ่งที่จะแสดงในหน้าแชทของทีมและเป็น fallback
  --   ของช่องทาง/ตัวส่งที่ทำ Flex ไม่ได้ (renderPayload type 'raw' ตกลงมาเป็น text เอง)
  insert into inbox.message(conversation_id, sender_type, content, content_type, event_type)
  values (NEW.conversation_id, 'bot', v_alt, 'text', 'message')
  returning id into v_msg;

  -- อัปเกรด payload ที่ enqueue_outbound เพิ่งใส่ไว้ให้เป็น Flex
  -- ★ type 'raw' คือทางที่ providers.renderPayload เปิดไว้ให้ส่งของดิบของแต่ละช่องทาง
  --   (line = ข้อความ LINE ทั้งก้อน) ไม่ต้องแก้ providers.mjs เลย
  update connect_private.delivery
     set payload = jsonb_build_object('type', 'raw', 'line', v_flex)
   where message_id = v_msg and status = 'pending';

  update inbox.conversation set last_bot_reply_at = NEW.created_at where id = NEW.conversation_id;
  return NEW;
exception when others then
  -- ข้อความขาเข้าของลูกค้าห้าม rollback เพราะงานผนวกชิ้นนี้พัง (หลักเดียวกับ trg_crm_publish_message)
  return NEW;
end $$;

drop trigger if exists trg_follow_welcome_flex on inbox.message;
create trigger trg_follow_welcome_flex
  after insert on inbox.message
  for each row execute function inbox.follow_welcome_send();

-- ── 3. ส่ง postback ต่อให้ CRM ────────────────────────────────────────
--
-- ★ ใช้ inbox.broadcast_emit จาก 202610021200 — ชื่อเหมือนเป็นของ broadcast
--   แต่จริง ๆ เป็น "ตัวเขียนคิวไป CRM ตัวเดียวของระบบ" ไม่สร้างตัวที่สองขนานกัน
--   (BOUNDARIES: Connect → CRM ใช้ outbox เดิมเท่านั้น ห้ามเปิดช่องทางใหม่)
--
-- ★ ที่มาของข้อมูล: receive_event เก็บ postback เป็น message ของ contact
--   content = '[กดปุ่ม] <data>' (prefix มาจาก providers.mjs normalizeEvents)
--   ไฟล์นี้จึงตัด prefix ออกแล้วส่ง data จริงไป พร้อมแนบ content เต็มไปด้วย
--   เผื่อรูปแบบ prefix เปลี่ยนวันหนึ่ง CRM จะยังมีของดิบให้ดู
create or replace function inbox.postback_publish()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, inbox, core, connect_private as $$
declare v_inbox inbox.inbox; v_external text; v_contact uuid; v_data text;
begin
  if NEW.event_type <> 'postback' or NEW.sender_type <> 'contact' then return NEW; end if;

  -- ★ แยกสองคำสั่ง — plpgsql ไม่ยอมให้ตัวแปร record อยู่ใน INTO ร่วมกับตัวอื่น
  select i.* into v_inbox
    from inbox.conversation c join inbox.inbox i on i.id = c.inbox_id
   where c.id = NEW.conversation_id;
  if v_inbox.id is null then return NEW; end if;
  select c.contact_id into v_contact from inbox.conversation c where c.id = NEW.conversation_id;

  select ci.external_id into v_external
    from core.contact_identity ci
   where ci.contact_id = v_contact and ci.channel = v_inbox.channel
     and ci.account_key = v_inbox.id::text
   limit 1;

  -- '[กดปุ่ม] asher:v1:interest=vibe' -> 'asher:v1:interest=vibe'
  v_data := btrim(regexp_replace(coalesce(NEW.content, ''), '^\[กดปุ่ม\]\s*', ''));

  -- ★ ผสมชนิด event เข้าไปในคีย์ — trg_crm_publish_message จอง id ของ message
  --   ไปเป็น message.received แล้ว ใช้ค่าเดิมซ้ำจะถูก on conflict กลืนหายเงียบ ๆ
  --   (เจอตอนเขียนเทสต์ ไม่ใช่ตอนขึ้น prod — ดูหัวข้อ inbox.crm_event_id ใน 202610021200)
  perform inbox.broadcast_emit(
    inbox.crm_event_id(NEW.id, 'channel_identity.postback'),
    'channel_identity.postback', 'channel_identity',
    v_inbox.id::text || ':' || coalesce(v_external, '?'), NEW.created_at,
    jsonb_build_object(
      'provider', v_inbox.channel, 'account_scope', v_inbox.id::text,
      'external_id', v_external, 'contact_ref', v_contact,
      'conversation_id', NEW.conversation_id::text, 'message_id', NEW.id::text,
      'postback_data', nullif(v_data, ''), 'raw_content', NEW.content));
  return NEW;
exception when others then
  return NEW;
end $$;

drop trigger if exists trg_postback_publish on inbox.message;
create trigger trg_postback_publish
  after insert on inbox.message
  for each row execute function inbox.postback_publish();

-- ── 4. สิทธิ์ ─────────────────────────────────────────────────────────
-- ทริกเกอร์ทั้งสองทำงานด้วยสิทธิ์ของตัวเอง (security definer) ไม่มีใครต้องเรียกตรง
revoke all on function inbox.follow_welcome_send(), inbox.postback_publish()
  from public, anon, authenticated;
-- แบบตั้งต้นอ่านได้ — หน้าตั้งค่าในอนาคตจะใช้โชว์ "ค่าโรงงาน" ให้กดคืนค่าได้
grant execute on function inbox.follow_welcome_default() to authenticated, service_role;

commit;
