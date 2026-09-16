-- =====================================================================
-- 20260916_bot_decisions_lead_fix.sql
-- เติมย้อนหลังผลตัดสินใจ 1 แถว ที่คลาดเพราะ inbox.extract_phone ถูกย้อนรุ่น
-- =====================================================================
-- ไม่ได้อยู่ใน sql/ORDER.txt เพราะเป็น "การแก้ข้อมูล" ไม่ใช่การแก้โครงสร้าง
-- ฐานที่ตั้งใหม่ไม่ต้องรันไฟล์นี้ (ไม่มีแถวที่ผิดให้แก้)
--
-- เหตุ (2026-09-16 ราว 04:21 UTC)
--   มีการรัน sql/002_decide.sql ทั้งไฟล์ใส่โปรดักชัน ทำให้ inbox.extract_phone
--   ย้อนไปเป็นรุ่นก่อน sql/014 ซึ่ง regex ไม่มีวงเล็บนอกสุด → substring() คืน
--   เฉพาะกลุ่มแรก ('0') ไม่ใช่ทั้งเบอร์ → ด่านตรวจรูปแบบไม่ผ่าน → คืน null
--   ผลคือ ctx 'phone_in_text' ว่าง → inbox.decide_notify มองไม่เห็นว่าเป็น lead
--   (แก้แล้วด้วย sql/033_receive_event_resync.sql เมื่อ 2026-09-16 05:18:35 UTC)
--
-- ขอบเขตที่ไล่แล้ว (อ่านอย่างเดียว ทั้งฐาน ไม่ใช่แค่ช่วงที่พัง)
--   ข้อความของลูกค้าที่มีเบอร์โทรทั้งฐาน = 1 ข้อความ
--   รุ่นแก้แล้วจับได้ / รุ่นพังจับไม่ได้  = 1 ข้อความ  (แถวเดียวนี้)
--   ทั้งสองรุ่นจับได้เหมือนกัน            = 0
--   → ไฟล์นี้จึงแก้แถวเดียว ไม่มีเคสอื่นค้างอยู่
--
-- ★ สิ่งที่ไฟล์นี้ตั้งใจ *ไม่* ทำ
--   · ไม่สร้างงาน notify ย้อนหลัง — ของจริงต้องเป็น action='skip' ตามคอนฟิก
--     (notify.hours 19→9 · outside_hours='skip' · leads_ignore_hours=false
--      เหตุเกิด 11:39 น. ไทย = นอกช่วงแจ้ง) ทีมจึงไม่ได้พลาดการแจ้งจริง
--     และเซลส์ตอบลูกค้าเองแล้วภายใน 90 วินาที
--   · ไม่ส่งข้อความหาลูกค้าย้อนหลังทุกกรณี
--   · ไม่แตะ inbox.message / core.contact / crm.lead — เบอร์ไม่ได้ถูกเก็บลง
--     โปรไฟล์อยู่แล้วตั้งแต่ต้น (receive_event ไม่เคยเขียน v_phone ลงตาราง
--     และ crm.lead ไม่มีคอลัมน์เบอร์โทร) จึงไม่มีอะไรให้เติม
--
-- ★ รันซ้ำได้ — where ระบุทั้ง id และค่าเดิมทุกช่อง รอบสองจะจับ 0 แถว
--   และไม่เขียน audit ซ้ำ เพราะ audit ผูกกับผลของ update
-- =====================================================================

begin;

-- ── ก่อนแก้: บอกว่าจะเปลี่ยนกี่แถว (0 = เคยแก้แล้ว หรือค่าไม่ตรงตามที่คาด) ──
select count(*) as rows_to_change
  from inbox.bot_decisions
 where id = 45
   and message_id = 'a2215089-1ca4-4efa-82bc-2982402c96be'::uuid
   and notify_go = false and notify_reason = 'no_repeat' and notify_action = 'none';

with upd as (
  update inbox.bot_decisions
     set notify_go     = true,
         notify_reason = 'lead',
         notify_action = 'skip'
   where id = 45
     and message_id   = 'a2215089-1ca4-4efa-82bc-2982402c96be'::uuid
     and notify_go    = false
     and notify_reason = 'no_repeat'
     and notify_action = 'none'
  returning id, conversation_id, message_id
)
insert into connect_private.audit(actor_id, conversation_id, action, detail)
select null,                                   -- ไม่มีคนกด เป็นการแก้ย้อนหลังของระบบ
       u.conversation_id,
       'backfill_bot_decision',
       jsonb_build_object(
         'incident_date',  '2026-09-16',
         'cause',          'sql/002_decide.sql ถูกรันทับ ทำให้ inbox.extract_phone ย้อนรุ่นก่อน sql/014',
         'fixed_by',       'sql/033_receive_event_resync.sql (2026-09-16 05:18:35 UTC)',
         'decision_id',    u.id,
         'message_id',     u.message_id,
         'before',         jsonb_build_object('notify_go', false, 'notify_reason', 'no_repeat', 'notify_action', 'none'),
         'after',          jsonb_build_object('notify_go', true,  'notify_reason', 'lead',      'notify_action', 'skip'),
         'evidence',       'inbox.decide_all() ที่เวลาจริงของเหตุการณ์คืน notify.reason=lead, notify_action=skip เมื่อ phone_in_text ไม่ว่าง',
         'no_notify_sent', true,
         'note',           'ไม่ได้สร้างงานแจ้งเตือนหรือส่งข้อความย้อนหลัง · ไม่บันทึกเบอร์โทรลง audit')
  from upd u;

-- ── หลังแก้: แถวนั้นเป็นอะไร ──
select id, notify_go, notify_reason, notify_action, decided_at
  from inbox.bot_decisions where id = 45;

-- ── audit ที่เพิ่งบันทึก (ต้องมีแถวเดียวต่อการแก้จริงหนึ่งครั้ง) ──
select id, action, detail->>'decision_id' as decision_id, created_at
  from connect_private.audit where action = 'backfill_bot_decision' order by id;

commit;
