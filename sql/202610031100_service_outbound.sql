-- =====================================================================
-- 202610031100_service_outbound.sql — ให้ CRM สั่ง Connect ส่งข้อความได้
-- =====================================================================
-- spec: docs/BOUNDARIES.md ("CRM → Connect: command ผ่าน service endpoint")
--       asher-crm Phase 3: escalate ไปหัวหน้า + auto-reply นอกเวลาทำการ
--
-- ★★ หลักที่ไฟล์นี้มีอยู่เพื่อรักษา: **token ของช่องทางอยู่ที่ Connect ที่เดียว**
--   CRM ตัดสินใจว่า "ควรส่งอะไรหาใคร" แต่ไม่เคยถือ token และไม่เคยยิง LINE เอง
--   (BOUNDARIES: CRM ห้ามเก็บ/อ่าน token ของช่องทาง)
--
-- ★ ไม่แตะ connect_private.api · ไม่แตะ receive_event · ไม่แตะ enqueue_outbound
--   ข้อความหาลูกค้าวางเป็น inbox.message ของ bot ตามปกติ แล้วทริกเกอร์เดิม
--   (inbox.enqueue_outbound) พาเข้าคิวขาออกให้เอง — ทางออกสู่ลูกค้าจึงยังมีทางเดียว
--   ทั้งระบบ และข้อความที่ CRM สั่งส่งจะโผล่ในหน้าแชทให้เซลส์เห็นด้วย
--
-- ★ สิทธิ์: service_role เท่านั้น (ทางเข้าคือ /internal/* ด้วย CONNECT_SERVICE_TOKEN)
--
-- ★ รันซ้ำได้ · ต้องอยู่หลัง 202610021200 (ใช้ inbox.crm_event_id ไม่ได้ใช้ก็จริง
--   แต่วางต่อท้ายตามลำดับเวลาที่เขียน)

begin;

-- ── 1. กันคำสั่งซ้ำ ───────────────────────────────────────────────────
--
-- CRM ยิงซ้ำได้เสมอ (timeout แล้วลองใหม่) จึงต้องมีคีย์ที่ทำให้ "ยิงสองครั้ง
-- = ส่งครั้งเดียว" · ข้อความหาลูกค้าใช้ UNIQUE (conversation_id, external_message_id)
-- ของ inbox.message ที่มีอยู่แล้ว · ส่วนงานแจ้งทีมไม่มีคีย์ จึงเติม index ให้
-- ★ additive: เป็น index ใหม่บนตารางเดิม ไม่เปลี่ยนคอลัมน์และไม่แตะข้อมูล
create unique index if not exists job_service_idem_uq
  on connect_private.job ((payload->>'service_idempotency_key'))
  where payload ? 'service_idempotency_key';

-- ── 2. แจ้งทีม (escalation ของ CRM) ───────────────────────────────────
--
-- p = {idempotency_key, text, channel('line_group'|'telegram'), inbox_id?}
--
-- ★ ตั้งใจ *ไม่* ใช้ channel 'team' — ทาง 'team' วิ่งผ่าน formatNotify ซึ่งขึ้นรูป
--   สำหรับ "ลูกค้าทักมา" (มีบรรทัด 'บอท: ...' และคำว่าลูกค้า) ถ้า CRM ส่ง
--   "เลย SLA แล้ว หัวหน้าโปรดดู" ผ่านทางนั้น ข้อความจะอ่านไม่ได้ความ
--   ทาง line_group/telegram ส่ง payload ตรง ๆ จึงได้ข้อความของ CRM เป๊ะ ๆ
create or replace function inbox.service_notify(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(coalesce(p->>'idempotency_key','')), '');
  v_text text := nullif(btrim(coalesce(p->>'text','')), '');
  v_channel text := coalesce(p->>'channel', 'line_group');
  v_inbox uuid := nullif(p->>'inbox_id','')::uuid;
  v_job bigint;
begin
  if v_key is null or v_text is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if v_channel not in ('line_group', 'telegram') then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;
  if length(v_text) > 4000 then
    raise exception 'text_too_long' using errcode = '22023';
  end if;

  -- ไม่ระบุ inbox มาก็หยิบตัวที่ active ตัวแรก — job ต้องมี inbox_id
  if v_inbox is null then
    select id into v_inbox from inbox.inbox where is_active order by created_at limit 1;
  end if;
  if v_inbox is null then raise exception 'no_active_inbox' using errcode = '42704'; end if;

  insert into connect_private.job(kind, channel, inbox_id, payload, send_after)
  values ('notify', v_channel, v_inbox,
          jsonb_build_object('type', 'text', 'text', v_text,
                             'service_idempotency_key', v_key,
                             'source', 'crm'),
          now())
  on conflict ((payload->>'service_idempotency_key')) where payload ? 'service_idempotency_key'
  do nothing
  returning id into v_job;

  if v_job is null then
    select id into v_job from connect_private.job
     where payload->>'service_idempotency_key' = v_key;
    return jsonb_build_object('job_id', v_job, 'reused', true);
  end if;
  return jsonb_build_object('job_id', v_job, 'reused', false);
end $$;

-- ── 3. ส่งข้อความหาลูกค้า (auto-reply ที่ CRM ตัดสินใจ) ────────────────
--
-- p = {contact_ref, idempotency_key, messages[1..5], channel_key?}
--
-- ★ ต้องมีบทสนทนาอยู่ก่อน — ข้อความของ bot ต้องผูกกับ conversation และการส่ง
--   ให้คนที่ไม่เคยทักมาเลยเป็นเรื่องของ broadcast ไม่ใช่ของทางนี้
-- ★ ข้อความแรกเป็น content ของแถว (หน้าแชทเห็น) ที่เหลือเป็นแถวถัดไป
--   เพราะคิวขาออกเดิมคิดเป็น "หนึ่งแถว = หนึ่งข้อความ"
create or replace function inbox.service_send_to_contact(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ref uuid := nullif(p->>'contact_ref','')::uuid;
  v_key text := nullif(btrim(coalesce(p->>'idempotency_key','')), '');
  v_msgs jsonb := coalesce(p->'messages','[]'::jsonb);
  v_channel_key text := nullif(p->>'channel_key','');
  v_conv uuid; v_inbox uuid; v_msg uuid; v_ids jsonb := '[]'::jsonb;
  v_item jsonb; v_text text; v_idx int := 0; v_existing uuid;
begin
  if v_ref is null or v_key is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if jsonb_typeof(v_msgs) <> 'array'
     or jsonb_array_length(v_msgs) < 1 or jsonb_array_length(v_msgs) > 5 then
    raise exception 'messages_required' using errcode = '22023';
  end if;

  -- บทสนทนาล่าสุดของลูกค้าคนนี้ (เลือกช่องทางได้ถ้าระบุ channel_key)
  select c.id, c.inbox_id into v_conv, v_inbox
    from inbox.conversation c
    join inbox.inbox i on i.id = c.inbox_id and i.is_active
   where c.contact_id = v_ref
     and (v_channel_key is null or i.id::text = v_channel_key)
   order by c.last_message_at desc nulls last, c.created_at desc
   limit 1;
  if v_conv is null then raise exception 'conversation_not_found' using errcode = '42704'; end if;

  -- ยิงซ้ำด้วยคีย์เดิม → คืนของเดิม ไม่ส่งใหม่
  select id into v_existing from inbox.message
   where conversation_id = v_conv and external_message_id = 'crm:' || v_key;
  if v_existing is not null then
    return jsonb_build_object('conversation_id', v_conv, 'reused', true,
                              'message_ids', jsonb_build_array(v_existing));
  end if;

  for v_item in select * from jsonb_array_elements(v_msgs) loop
    v_idx := v_idx + 1;
    v_text := case when v_item->>'type' = 'text' then v_item->>'text'
                   when v_item->>'type' = 'image' then '[รูปภาพ]'
                   else null end;
    if v_text is null or btrim(v_text) = '' then
      raise exception 'invalid_message' using errcode = '22023';
    end if;

    insert into inbox.message(conversation_id, sender_type, content, content_type, event_type,
                              external_message_id)
    values (v_conv, 'bot', v_text, 'text', 'message',
            -- คีย์กันซ้ำติดกับแถวแรกเท่านั้น แถวถัดไปต่อ index กันชนกันเอง
            case when v_idx = 1 then 'crm:' || v_key else 'crm:' || v_key || ':' || v_idx end)
    returning id into v_msg;
    v_ids := v_ids || to_jsonb(v_msg);

    -- รูปต้องไปเป็น payload ของ LINE ไม่ใช่ข้อความ "[รูปภาพ]"
    if v_item->>'type' = 'image' then
      update connect_private.delivery
         set payload = jsonb_build_object('type', 'image',
                                          'url', v_item->>'originalContentUrl',
                                          'preview_url', coalesce(v_item->>'previewImageUrl',
                                                                  v_item->>'originalContentUrl'))
       where message_id = v_msg and status = 'pending';
    end if;
  end loop;

  update inbox.conversation set last_bot_reply_at = now() where id = v_conv;
  return jsonb_build_object('conversation_id', v_conv, 'reused', false, 'message_ids', v_ids);
end $$;

-- ── 4. สิทธิ์ — service_role เท่านั้น ─────────────────────────────────
-- ★ ห้าม grant ให้ authenticated: ถ้าหน้าเว็บเรียกได้ เซลส์คนเดียวจะส่งข้อความ
--   ในนามระบบได้โดยไม่ผ่านด่านของ CRM
revoke all on function inbox.service_notify(jsonb), inbox.service_send_to_contact(jsonb)
  from public, anon, authenticated;
grant execute on function inbox.service_notify(jsonb), inbox.service_send_to_contact(jsonb)
  to service_role;

commit;
