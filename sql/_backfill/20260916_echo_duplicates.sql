-- =====================================================================
-- 20260916_echo_duplicates.sql — เก็บกวาดแถวซ้ำที่เกิดจาก echo ของเราเอง
-- =====================================================================
-- ★★ ยังไม่ได้ลง — ซ้อม begin…rollback ไว้แล้ว รอผู้ใช้อนุมัติ
--    ไฟล์นี้ "ลบแถวข้อความ" ซึ่งเป็นข้อมูลลูกค้า จึงอยู่นอกขอบเขตที่ให้ทำเองได้
--
-- เหตุ
--   ก่อน sql/035 กิ่ง echo ไม่รู้ว่าข้อความที่เพจส่งออกไปเป็นของแอปเราเอง
--   ทุกข้อความที่แอปส่ง จึงถูกบันทึกสองแถว: แถวต้นทาง (external_message_id ว่าง)
--   กับแถวที่เกิดจาก echo เด้งกลับ (มี mid) ห่างกันราว 1 วินาที
--   unique index (conversation_id, external_message_id) กันไม่ได้เพราะข้างหนึ่งเป็น NULL
--
-- ขอบเขต (วัดจากของจริง ไม่ได้ประมาณ)
--   แถวซ้ำทั้งฐาน = 8 แถว · ช่วง 2026-09-14 15:56 ถึง 2026-09-15 14:29
--   ทุกแถวจับคู่กับ connect_private.delivery.provider_id ได้แบบตรงตัว (ไม่ใช่เดาจากข้อความ)
--   human_reply_events ที่เกิดจากแถวเหล่านี้ = 8 แถว (source='echo')
--   ★ ทั้งแปดคู่มีเหตุการณ์ source='workspace' ของตัวส่งอยู่แล้วในวินาทีเดียวกัน
--     "คนตอบจริง" จึงไม่ได้หายไปไหน ที่ลบคือรายการซ้ำเท่านั้น
--
-- ★ สิ่งที่ไฟล์นี้ตั้งใจไม่ทำ
--   · ไม่แตะ 21 แถวที่เป็น echo ของคนตอบจาก Page Inbox จริง ๆ
--   · ไม่ส่งข้อความหาลูกค้า ไม่สร้างงานแจ้งเตือน
--   · ไม่แก้ last_human_reply_at — ตรวจแล้วว่าทุกบทสนทนาที่เกี่ยวข้องมีเวลา
--     ที่ใหม่กว่าเหตุการณ์ซ้ำเหล่านี้อยู่แล้ว การลบจึงไม่ทำให้ค่าปัจจุบันผิด
--     (ไฟล์นี้พิมพ์ค่าก่อน/หลังให้ดูด้วย ถ้าเปลี่ยนแปลว่าสมมุติฐานไม่จริง ให้ rollback)
--
-- ★ รันซ้ำได้ — ทุกคำสั่งผูกกับเงื่อนไข "ยังมีคู่ซ้ำอยู่จริง" รอบสองจะจับ 0 แถว
-- =====================================================================

begin;

-- ── 0) ของที่จะเปลี่ยน ────────────────────────────────────────────────
create temporary table _dup on commit drop as
select d.message_id as original_id, m2.id as dup_id, d.provider_id as mid,
       m2.conversation_id, m2.created_at as dup_at
  from connect_private.delivery d
  join inbox.message m2 on m2.external_message_id = d.provider_id and m2.id <> d.message_id
  join inbox.message m1 on m1.id = d.message_id
 where m1.conversation_id = m2.conversation_id;

select count(*) as rows_to_change_messages from _dup;

select c.id as conversation_id, c.last_human_reply_at as before_value
  from inbox.conversation c
 where c.id in (select conversation_id from _dup)
 order by 1;

-- ── 1) ย้ายการอ้างอิงของ inbound_event ไปที่แถวต้นทาง ─────────────────
--     (FK เป็น on delete set null อยู่แล้ว แต่ set null คือทิ้งข้อมูล
--      ส่วนการชี้ไปแถวต้นทางคือสิ่งที่ถูกต้องจริง ๆ)
update connect_private.inbound_event e
   set message_id = d.original_id
  from _dup d
 where e.message_id = d.dup_id;

-- ── 2) ลบเหตุการณ์ "คนตอบ" ที่เกิดจากแถวซ้ำ ───────────────────────────
--     จับด้วยเวลาที่ตรงกันเป๊ะกับแถวซ้ำ + ต้องมีคู่ workspace ในหน้าต่าง 2 นาที
--     ★ เงื่อนไขคู่ workspace คือด่านกันลบพลาด ถ้าไม่มีคู่ = อาจเป็นคนตอบจริง
delete from inbox.human_reply_events h
 using _dup d
 where h.conversation_id = d.conversation_id
   and h.source = 'echo'
   and h.created_at = d.dup_at
   and exists (select 1 from inbox.human_reply_events w
                where w.conversation_id = h.conversation_id and w.source = 'workspace'
                  and abs(extract(epoch from (w.created_at - h.created_at))) < 120);

-- ── 2.5) ตัวอย่างฝึกบอทที่ผูกกับแถวซ้ำ ────────────────────────────────
-- ★ ต้องลบตรงนี้เอง ห้ามปล่อยให้ FK cascade ทำเงียบ ๆ
--   bot.reply_sample.message_id เป็น FK แบบ ON DELETE CASCADE และเป็น PK ด้วย
--   ถ้าไม่เขียนไว้ตรงนี้ การลบแถวข้อความจะพาตัวอย่างฝึก 8 แถวหายไปโดยไม่มีใครเห็น
--
-- ★ ทำไมลบทิ้งได้ (ตรวจของจริงก่อนแล้ว ทั้ง 8 คู่):
--   · ทุก dup_id มี 'ฝาแฝด' ที่ชี้ไป original_id อยู่แล้ว (conflict_on_original = 1 ทุกแถว)
--     จึงย้ายให้ชี้ต้นฉบับแทนไม่ได้ เพราะ message_id เป็น primary key
--   · แถวฝาแฝดที่ชี้ต้นฉบับมี agent_id ครบ ส่วนแถวของ echo ไม่มี (agent_id ว่าง)
--   · bot_draft ว่างทั้งคู่ (ยาว 0) ข้อมูลฝึกจึงไม่ได้หายไปไหน
--   · think_seconds ของแถว echo สูงกว่าเล็กน้อยเพราะจับเวลาจากจังหวะที่ echo เด้งกลับ
--     ไม่ใช่จังหวะที่คนกดส่ง → เป็นค่าที่ผิดอยู่แล้ว
--   สำรองไว้ครบที่ sql/_backup/echo_duplicates_rows_20260916.sql
delete from bot.reply_sample rs using _dup d where rs.message_id = d.dup_id;

-- ── 3) ลบแถวข้อความที่ซ้ำ แล้วย้าย mid ไปไว้ที่แถวต้นทาง ──────────────
--     ต้องลบก่อนค่อยย้าย mid ไม่งั้นชน unique (conversation_id, external_message_id)
delete from inbox.message m using _dup d where m.id = d.dup_id;

update inbox.message m
   set external_message_id = d.mid
  from _dup d
 where m.id = d.original_id and m.external_message_id is null;

-- ── 4) บันทึกไว้ว่าทำอะไรย้อนหลัง ────────────────────────────────────
insert into connect_private.audit(actor_id, conversation_id, action, detail)
select null, d.conversation_id, 'backfill_echo_duplicate',
       jsonb_build_object(
         'incident_date', '2026-09-16',
         'cause',         'ก่อน sql/035 กิ่ง echo แยกไม่ออกว่าข้อความที่เพจส่งเป็นของแอปเราเอง จึงบันทึกซ้ำสองแถว',
         'fixed_by',      'sql/035_echo_attribution.sql + sql/036_echo_source_from_queue.sql',
         'original_id',   d.original_id,
         'removed_id',    d.dup_id,
         'mid_moved_to_original', true,
         'no_notify_sent', true)
  from _dup d;

-- ── 5) ผลหลังแก้ ─────────────────────────────────────────────────────
select c.id as conversation_id, c.last_human_reply_at as after_value
  from inbox.conversation c
 where c.id in (select conversation_id from _dup)
 order by 1;

select (select count(*) from bot.reply_sample rs join _dup d on d.dup_id = rs.message_id) as reply_samples_left,
       (select count(*) from bot.reply_sample rs join _dup d on d.original_id = rs.message_id) as reply_samples_kept_on_original,
       (select count(*) from inbox.message m join _dup d on d.dup_id = m.id) as duplicates_left,
       (select count(*) from inbox.message m join _dup d on d.original_id = m.id
         where m.external_message_id is not null) as originals_with_mid,
       (select count(*) from connect_private.audit where action = 'backfill_echo_duplicate') as audit_rows;

commit;
