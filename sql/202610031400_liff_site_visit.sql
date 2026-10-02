-- =====================================================================
-- 202610031400_liff_site_visit.sql — LIFF นัดชมโครงการ (ฝั่ง Connect)
-- =====================================================================
-- spec: line-roadmap-phases.md Phase 4
--
-- ★★ Connect **ไม่เก็บนัด** — "นัดชม" เป็นของ CRM ตาม BOUNDARIES
--   หน้าที่ของ Connect มีสองอย่าง: ยืนยันว่าคนที่กดจองเป็นใครจริง ๆ (ID token)
--   แล้วส่งต่อให้ CRM ตัดสินใจ · ไม่มีตารางนัดในไฟล์นี้โดยเจตนา
--
-- ★ ส่งต่อผ่าน outbox เดิม (inbox.crm_publish_outbox) ไม่เปิดช่องทางใหม่
--
-- ★ ไม่แตะ connect_private.api / receive_event / enqueue_outbound
-- ★ ต้องอยู่หลัง 202610021200 (ใช้ inbox.broadcast_emit + inbox.crm_event_id)
-- ★ รันซ้ำได้

begin;

-- เปิดทางให้ outbox พา event ชนิดใหม่
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

-- ── รับคำขอนัดจากหน้า LIFF ────────────────────────────────────────────
--
-- p = {provider, account_scope, external_id, scheduled_at, visitor_count, note,
--      project_ref, display_name}
--
-- ★ external_id ที่เข้ามาต้องมาจาก `sub` ของ ID token ที่ยืนยันกับ LINE แล้วเท่านั้น
--   ชั้น Node เป็นคนยืนยัน (lib/liff.mjs verifyIdToken) — ฟังก์ชันนี้เชื่อผู้เรียก
--   เพราะเรียกได้แค่ service_role ซึ่งมีแต่ server ของเราเอง
--
-- ★ กันกดซ้ำ: event_id มาจาก (contact, เวลานัด) จึงกดสองครั้งได้ event เดียว
--   ไม่ต้องให้ลูกค้าเห็น error และ CRM ก็ไม่ได้นัดซ้ำ
create or replace function inbox.liff_site_visit_request(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_provider text := nullif(btrim(coalesce(p->>'provider','')), '');
  v_scope text := nullif(btrim(coalesce(p->>'account_scope','')), '');
  v_external text := nullif(btrim(coalesce(p->>'external_id','')), '');
  v_at timestamptz := nullif(p->>'scheduled_at','')::timestamptz;
  v_contact uuid; v_conv uuid; v_seed text; v_event uuid;
begin
  if v_provider is null or v_scope is null or v_external is null or v_at is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  select ci.contact_id into v_contact
    from core.contact_identity ci
   where ci.channel = v_provider and ci.account_key = v_scope and ci.external_id = v_external
   limit 1;
  -- ★ คนที่ยังไม่เคยทักมาเลยจะไม่มี contact — ไม่สร้างให้เองที่นี่
  --   core.resolve_identity เป็นของเส้นทางรับข้อความ การสร้างคนจากหน้าเว็บ
  --   จะทำให้มี contact ที่ไม่มีบทสนทนาเลยลอยอยู่ในระบบ
  if v_contact is null then raise exception 'contact_not_found' using errcode = '42704'; end if;

  select c.id into v_conv from inbox.conversation c
   where c.contact_id = v_contact and c.inbox_id::text = v_scope
   order by c.last_message_at desc nulls last limit 1;

  -- เวลานัดปัดเป็นนาที เพื่อให้กดซ้ำในวินาทีต่างกันยังได้คีย์เดิม
  v_seed := v_contact::text || ':' || to_char(date_trunc('minute', v_at), 'YYYY-MM-DD"T"HH24:MI');
  v_event := inbox.crm_event_id(md5(v_seed)::uuid, 'appointment.requested');

  perform inbox.broadcast_emit(
    v_event, 'appointment.requested', 'contact', v_contact::text, now(),
    jsonb_build_object(
      'provider', v_provider, 'account_scope', v_scope, 'external_id', v_external,
      'contact_ref', v_contact, 'conversation_id', v_conv,
      'scheduled_at', v_at, 'visitor_count', coalesce((p->>'visitor_count')::int, 1),
      'note', nullif(p->>'note',''), 'project_ref', nullif(p->>'project_ref',''),
      'display_name', nullif(p->>'display_name',''), 'source', 'liff'));

  return jsonb_build_object('contact_ref', v_contact, 'event_id', v_event,
                            'scheduled_at', v_at, 'conversation_id', v_conv);
end $$;

revoke all on function inbox.liff_site_visit_request(jsonb) from public, anon, authenticated;
grant execute on function inbox.liff_site_visit_request(jsonb) to service_role;

commit;
