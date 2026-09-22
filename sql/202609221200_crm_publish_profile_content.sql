-- Connect -> CRM: ส่งชื่อ/รูป/สถานะโปรไฟล์ และเนื้อความจริงไปด้วย
-- (ต่อจาก 202609212000_crm_conversation_created.sql)
--
-- ทำไมต้องมี: payload เดิมมีแต่ "ตัวชี้" (conversation_id / external_id / message_id)
-- ฝั่ง CRM จึงเห็นลูกค้าเป็นรหัสเปล่า ๆ ไม่มีชื่อ ไม่มีรูป และไม่เห็นว่าคุยอะไรกัน
-- ต้องเปิด Connect ควบอีกจอเพื่ออ่านข้อความ ซึ่งเป็นเหตุผลเดียวกับที่ทำ integration นี้ตั้งแต่แรก
--
-- แหล่งข้อมูลตามจริง ไม่มีตัวไหนแต่งขึ้น:
--   * display_name  <- core.contact.display_name
--   * picture_url   <- core.contact.picture_url
--   * status        <- core.contact.profile_status
--     ทั้งสามคอลัมน์เขียนโดย rpc 'profile_update' ที่ server.mjs เรียกหลังบันทึกข้อความ
--     (syncProfiles §807-833 และ refreshProfiles §841-874) ค่าจึงมาจาก LINE/Meta โดยตรง
--   * content       <- inbox.message.content ของแถวที่ทริกเกอร์กำลังทำงานอยู่ (NEW)
--     ไม่ตัด ไม่ย่อ ไม่ normalize — CRM ต้องเห็นข้อความเดียวกับที่ Connect เก็บ
--
-- ★ ทำไมติดโปรไฟล์ไปกับ message ด้วย ไม่ใช่แค่ conversation.created:
--   conversation.created ยิงครั้งเดียวต่อบทสนทนาตลอดกาล (event_id ตายตัว + on conflict
--   do nothing) แต่โปรไฟล์ถูกดึง "หลัง" ข้อความแรกลงฐานเสมอ — ข้อความแรกของคนใหม่
--   display_name จึงเป็น null เสมอโดยธรรมชาติ ถ้าใส่ไว้แต่ใน conversation.created
--   CRM จะไม่มีวันได้ชื่อของคนนั้นเลย การติดไปกับทุก message ทำให้ข้อความถัดไป
--   พาชื่อ/รูปที่ดึงมาได้แล้วตามไปเอง โดยไม่ต้องมี backfill แยกหรือ event ชนิดใหม่
--
-- ★ เพิ่มอย่างเดียว ไม่ถอดคีย์เดิมสักตัว: source id, timestamps และวิธีคิด event_id
--   เหมือนเดิมทุกประการ ของที่ส่งไปแล้วจึงยังซ้ำไม่ได้เหมือนเดิม (on conflict do nothing)
--   รันไฟล์นี้ซ้ำกี่รอบก็ได้ — create or replace ล้วน ไม่มี DDL ที่ทำลายข้อมูล

create or replace function inbox.crm_publish_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, inbox, core as $$
declare
  v_inbox inbox.inbox;
  v_conversation inbox.conversation;
  v_identity core.contact_identity;
  v_contact core.contact;
  v_profile jsonb;
  v_sender_kind text;
  v_event_type text;
  v_event_id uuid;
  v_payload jsonb;
  v_conv_event_id uuid;
begin
  if NEW.sender_type not in ('contact', 'agent', 'bot') then
    return NEW;
  end if;

  select * into v_conversation from inbox.conversation where id = NEW.conversation_id;
  if not found then return NEW; end if;
  select * into v_inbox from inbox.inbox where id = v_conversation.inbox_id;
  if not found or v_inbox.channel not in ('line', 'messenger') then return NEW; end if;

  select * into v_identity
    from core.contact_identity
   where contact_id = v_conversation.contact_id
     and channel = v_inbox.channel
     and account_key = v_inbox.id::text
   order by id
   limit 1;

  -- ไม่มีตัวตนลูกค้า = CRM ตีกลับ 400 แล้ว dead_letter ฟรี ๆ ไม่ต้องส่ง
  if v_identity.external_id is null then
    return NEW;
  end if;

  -- โปรไฟล์ของ "เจ้าของบทสนทนา" ไม่ใช่ของผู้ส่งข้อความ — ข้อความจาก agent/bot
  -- ก็ต้องพาชื่อลูกค้าคนเดิมไป CRM จะได้ไม่ต้องเดาว่าแถวนี้เป็นของใคร
  select * into v_contact from core.contact where id = v_conversation.contact_id;
  v_profile := jsonb_build_object(
    'display_name', v_contact.display_name,
    'picture_url', v_contact.picture_url,
    'status', v_contact.profile_status
  );

  -- ── conversation.created: ใบเบิกทางของ Lead ยิงครั้งเดียวต่อบทสนทนา ──
  v_conv_event_id := md5('conversation.created:' || v_conversation.id::text)::uuid;
  insert into inbox.crm_publish_outbox
    (event_id, event_type, aggregate_id, occurred_at, payload)
  values (
    v_conv_event_id,
    'conversation.created',
    v_conversation.id::text,
    coalesce(v_conversation.created_at, NEW.created_at),
    jsonb_build_object(
      'conversation_id', v_conversation.id::text,
      'provider', v_inbox.channel,
      'account_scope', v_inbox.id::text,
      'external_id', v_identity.external_id
    ) || v_profile
  )
  on conflict (event_id) do nothing;

  -- ── message.received / message.sent ──
  v_sender_kind := case NEW.sender_type when 'contact' then 'customer' when 'agent' then 'human' else 'bot' end;
  v_event_type := case NEW.sender_type when 'contact' then 'message.received' else 'message.sent' end;
  v_event_id := NEW.id;
  v_payload := jsonb_build_object(
    'conversation_id', NEW.conversation_id::text,
    'provider', v_inbox.channel,
    'account_scope', v_inbox.id::text,
    'external_id', v_identity.external_id,
    'message_id', NEW.id::text,
    'sender_kind', v_sender_kind,
    'sender_id', case when NEW.sender_id is null then null else NEW.sender_id::text end,
    'agent_id', case when NEW.sender_type = 'agent' and NEW.sender_id is not null then NEW.sender_id::text else null end,
    'content', NEW.content
  ) || v_profile;

  insert into inbox.crm_publish_outbox
    (event_id, event_type, aggregate_id, occurred_at, payload)
  values (v_event_id, v_event_type, NEW.conversation_id::text, NEW.created_at, v_payload)
  on conflict (event_id) do nothing;
  return NEW;
exception when others then
  -- CRM publishing is an integration concern. A bad/missing identity must
  -- not roll back Connect's customer message transaction.
  return NEW;
end $$;
