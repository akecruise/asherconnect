-- Connect -> CRM: conversation.created (ต่อจาก 202609211300_crm_publisher.sql)
--
-- ทำไมต้องมี: ฝั่ง CRM สร้าง Lead ได้จาก conversation.created เท่านั้น
-- (src/modules/events/service.ts §182-212) ส่วน message.received/message.sent
-- ไม่เคยสร้าง Lead เลย — ของเดิมจึงได้แค่ contact/conversation/message
--
-- หลักการ: หนึ่งบทสนทนา = หนึ่ง conversation.created ตลอดกาล
-- event_id คำนวณจาก conversation_id แบบตายตัว (md5 -> uuid) ไม่ใช่ random
-- ดังนั้นต่อให้ทริกเกอร์ถูกเรียกซ้ำกี่รอบ on conflict (event_id) do nothing
-- ก็กันซ้ำให้เอง ไม่ต้องมีตารางจำสถานะเพิ่ม
--
-- project_ref ไม่ได้ใส่ที่นี่ — publisher เป็นคนเติมตอนส่งจาก ASHER_CRM_PROJECT_MAP
-- (config อยู่ที่เดียวกับ ASHER_CRM_* ตัวอื่น ไม่ฝัง id ของ production ลงใน SQL)

-- 1) เปิดทางให้ event_type ใหม่ผ่าน check เดิม
alter table inbox.crm_publish_outbox
  drop constraint if exists crm_publish_outbox_event_type_check;
alter table inbox.crm_publish_outbox
  add constraint crm_publish_outbox_event_type_check
  check (event_type in ('message.received', 'message.sent', 'conversation.created'));

-- 2) ทริกเกอร์เดิม + แขนง conversation.created
create or replace function inbox.crm_publish_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, inbox, core as $$
declare
  v_inbox inbox.inbox;
  v_conversation inbox.conversation;
  v_identity core.contact_identity;
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
    )
  )
  on conflict (event_id) do nothing;

  -- ── message.received / message.sent: ของเดิม ไม่แตะ ──
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
    'agent_id', case when NEW.sender_type = 'agent' and NEW.sender_id is not null then NEW.sender_id::text else null end
  );

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
