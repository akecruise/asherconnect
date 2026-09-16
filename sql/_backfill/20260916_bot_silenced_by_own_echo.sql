-- =====================================================================
-- 20260916_bot_silenced_by_own_echo.sql
--   ปลดแชทที่บอทเงียบเพราะ echo ของบอทเองถูกนับเป็น "คนตอบ"
-- =====================================================================
-- ★★ ยังไม่ได้ลง — ซ้อม begin…rollback ไว้แล้ว
-- ★★ ผลการซ้อมวันนี้ = 0 แถว (ไม่มีแชทไหนโดนจริง) เก็บไฟล์ไว้เป็นเครื่องมือ
--    ถ้าวันหลังเจอเคสแบบนี้ ไม่ใช่เพราะต้องรีบแก้อะไรตอนนี้
--
-- เหตุที่ควรมีเคสแบบนี้ (แต่วันนี้ยังไม่มี)
--   ก่อน sql/035 คีย์ team.bot_app_id ไม่เคยถูกตั้ง → echo ของบอทเองถูกป้ายเป็น
--   'agent' → เรียก mark_human_reply() → last_human_reply_at ขึ้น
--   → decide_reply เห็น human_owns_convo → บอทเงียบถาวรในแชทนั้น
--
-- ทำไมวันนี้ยังไม่มีเคส (ตรวจแล้ว ไม่ได้เดา)
--   ข้อความที่ "บอท" ส่งออกจริงทั้งฐานมีชิ้นเดียว (2026-09-15 07:07)
--   และอยู่บน LINE ซึ่งไม่มี echo กลับมา — Messenger เท่านั้นที่ยิง echo
--   ส่วน echo ของเราเองอีก 8 ก้อนเป็นข้อความที่ "คนกดส่งจากหน้าจอเรา"
--   การนับว่าคนตอบจึงถูกต้องอยู่แล้ว (แค่ซ้ำกับเหตุการณ์ workspace)
--   → ดู sql/_backfill/20260916_echo_duplicates.sql สำหรับรายการซ้ำนั้น
--
-- ★ ไฟล์นี้ไม่ลบข้อความ ไม่ส่งอะไรหาลูกค้า ไม่สร้างงานแจ้งเตือน
--   แตะแค่ inbox.conversation.last_human_reply_at กับเหตุการณ์ที่ป้ายผิด
-- ★ รันซ้ำได้ — เงื่อนไขผูกกับ "ยังผิดอยู่จริง" รอบสองจะจับ 0 แถว
-- =====================================================================

begin;

-- ── เคสที่เข้าข่าย: เหตุการณ์ "คนตอบ" ที่แท้จริงแล้วเป็น echo ของบอทเอง ──
create temporary table _bogus on commit drop as
select h.id as event_id, h.conversation_id, h.created_at as event_at, m.id as message_id
  from inbox.human_reply_events h
  join inbox.message m
    on m.conversation_id = h.conversation_id
   and m.created_at = h.created_at
   and m.sender_type = 'agent'
 where h.source = 'echo'
   -- ข้อความนั้นคือ echo ของสิ่งที่ "บอท" ส่งออกไปเอง
   and exists (select 1 from connect_private.delivery d
                 join inbox.message src on src.id = d.message_id
                where d.provider_id = m.external_message_id
                  and src.sender_type = 'bot')
   -- และไม่มีคนตอบจริงหลังจากนั้น (ไม่งั้นค่าปัจจุบันก็ถูกอยู่แล้ว)
   and not exists (select 1 from inbox.human_reply_events h2
                    where h2.conversation_id = h.conversation_id
                      and h2.created_at > h.created_at
                      and h2.source in ('workspace','group_cmd','api','page_inbox','other_app'));

select count(*) as rows_to_change from _bogus;

-- ── 1) ปลดธง "คนตอบ" กลับไปที่เหตุการณ์จริงล่าสุด (หรือว่างถ้าไม่มีเลย) ──
update inbox.conversation c
   set last_human_reply_at = (
         select max(h2.created_at) from inbox.human_reply_events h2
          where h2.conversation_id = c.id
            and h2.id not in (select event_id from _bogus)
            and h2.source in ('workspace','group_cmd','api','page_inbox','other_app'))
  from _bogus b
 where c.id = b.conversation_id;

-- ── 2) แถวข้อความของบอทที่ถูกป้ายเป็น agent → แก้ให้เป็น bot ──────────
update inbox.message m
   set sender_type = 'bot'
  from _bogus b
 where m.id = b.message_id and m.sender_type = 'agent';

-- ── 3) ลบเหตุการณ์ที่ป้ายผิด ─────────────────────────────────────────
delete from inbox.human_reply_events h using _bogus b where h.id = b.event_id;

-- ── 4) บันทึกไว้ ─────────────────────────────────────────────────────
insert into connect_private.audit(actor_id, conversation_id, action, detail)
select null, b.conversation_id, 'backfill_bot_silenced',
       jsonb_build_object(
         'incident_date', '2026-09-16',
         'cause',  'team.bot_app_id ไม่เคยถูกตั้ง → echo ของบอทเองถูกนับเป็นคนตอบ',
         'fixed_by', 'sql/035_echo_attribution.sql (หว่าน team.bot_app_id) + 036',
         'event_id', b.event_id, 'message_id', b.message_id,
         'no_notify_sent', true)
  from _bogus b;

select (select count(*) from _bogus) as fixed_conversations,
       (select count(*) from connect_private.audit where action = 'backfill_bot_silenced') as audit_rows;

commit;
