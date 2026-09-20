-- =====================================================================
-- 041_shared_sales_queue.sql — เซลส์ใช้คิวรวม + ผู้ตรวจสอบ Meta เห็นเฉพาะแชททดสอบ
-- =====================================================================
-- ★ ทำไมต้องมีไฟล์นี้
--   connect_private.can_read (นิยามอยู่ใน database.sql ฐานเดิม ไม่เคยมีไฟล์ใน
--   sql/ แตะมาก่อน) ถูกแก้สดบน VPS ตรง ๆ เมื่อ 2026-09-19 เพื่อเปิดบัญชีผู้ตรวจสอบ
--   Meta App Review (meta-review@asher.local) — การแก้นั้นไม่เคยเข้า repo นี้
--   ไฟล์นี้เอาการแก้นั้นกลับเข้า repo ให้ตรงกับที่รันจริงบน VPS
--
-- สองเรื่องที่ยืนยันจากฐานจริงบน VPS (2026-09-19):
--
--   1) เซลส์ทำงานเป็น "คิวรวม" ไม่ใช่คนละเคส — sql/025_reply_without_claim.sql
--      (connect_private.api กิ่ง reply โดยไม่ต้อง claim) เขียนไว้ตรง ๆ แล้วว่า
--      can_read() เป็นตัวคุมว่าเห็นเคสไหนได้บ้าง แต่ can_read() เดิม (ก่อนแก้)
--      ยังกันไว้ที่ assignee_id (เห็นเฉพาะของตัวเอง/ไม่มีเจ้าของ/ทีมเดียวกัน)
--      ขัดกับโมเดลคิวรวมที่โค้ดส่วนอื่นออกแบบไว้แล้ว — หัวไฟล์แก้ตรงนี้:
--        เดิม  "p.role in ('manager','admin') or c.assignee_id is null ..."
--        ใหม่  "p.role in ('sales','senior_sales','manager','admin') or ..."
--      ผลคือ role ที่ผ่านด่านแรกสุด (sales/senior_sales/manager/admin ที่ active)
--      อ่านได้ทุกเคส — เงื่อนไข assignee_id/senior_sales-team เดิมเลยกลายเป็น
--      จริงเสมอซ้ำกับด่านแรก (dead code) จึงตัดออกแทนที่จะปล่อยไว้ให้อ่านสับสน
--
--      assignee_id ไม่ได้หายไปไหน — ยังเป็น "ข้อมูล" ใช้กรอง UI ตามเดิมทุกที่
--      (connect_private.api กิ่ง 'list' ตัวกรอง 'mine'/'unassigned' และ
--      inbox.queue_counts) และยังเป็นด่าน "ต้อง claim ก่อนแก้ดีล" สำหรับ
--      action ที่ไม่ใช่ send/retry (sql/026 บรรทัด claim_required) — สองจุดนั้น
--      ไม่ใช่ด่านอ่าน ไม่ต้องแก้ ตรวจแล้วแยกกับ can_read() อยู่แล้ว
--
--   2) ผู้ตรวจสอบ Meta ต้องเห็น "เฉพาะ" แชททดสอบ — core.profile ไม่เคยมีคอลัมน์
--      test_only ในโค้ดชุดนี้เลย (เพิ่มสดบน VPS ตอนตั้งบัญชี meta-review@asher.local)
--      เพิ่มคอลัมน์ + เงื่อนไข "(not test_only or is_test)" เข้า can_read()
--      ★ ต้องคง "(not p.test_only or c.is_test)" ไว้ตามที่ตรวจยืนยันบน VPS แล้ว
--        ห้ามเปลี่ยนเป็นอย่างอื่น — สลับค่า default หรือกลับเงื่อนไขจะทำให้
--        ผู้ตรวจสอบเห็นแชทลูกค้าจริง หรือเซลส์จริงมองไม่เห็นแชทตัวเอง
--
-- รันซ้ำได้ (add column if not exists + create or replace) ไม่ผูกลำดับกับใคร
-- ต้องอยู่หลัง sql/202609191500_review_code.sql เสมอ (ต้องมี inbox.conversation.is_test
-- อยู่ก่อน — จริง ๆ มีมาตั้งแต่ sql/031_test_reset.sql แล้ว ระบุไว้เพื่อความชัดเจน)
-- =====================================================================

begin;

-- ── ด่านตรวจ: ต้องมี inbox.conversation.is_test อยู่ก่อน (sql/031) ──────────
do $dep$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'inbox' and table_name = 'conversation' and column_name = 'is_test')
  then raise exception 'inbox.conversation.is_test ไม่มี — ต้องลง sql/031_test_reset.sql ก่อน'; end if;
end $dep$;

-- ── ธงบัญชีผู้ตรวจสอบ/ทดสอบ — เห็นได้เฉพาะแชทที่ติด is_test ─────────────────
alter table core.profile
  add column if not exists test_only boolean not null default false;

comment on column core.profile.test_only is
  'บัญชีสำหรับผู้ตรวจสอบ/ทดสอบภายนอก (เช่น Meta App Review) — เห็นได้เฉพาะ '
  'บทสนทนาที่ is_test=true เท่านั้น ไม่เห็นงานขายจริง · ตั้งครั้งเดียวตอนสร้างบัญชี';

-- ── can_read: คิวรวมสำหรับเซลส์ + กันผู้ตรวจสอบไม่ให้เห็นงานจริง ────────────
create or replace function connect_private.can_read(p_id uuid)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','public'
as $function$
  select auth.uid() is not null and exists(
    select 1 from core.profile p join inbox.conversation c on c.id = p_id
    where p.user_id = auth.uid()
      and p.is_active
      and p.role in ('sales','senior_sales','manager','admin')
      and (not coalesce(p.test_only,false) or coalesce(c.is_test,false))
  )
$function$;

grant execute on function connect_private.can_read(uuid) to authenticated;
revoke all on function connect_private.can_read(uuid) from public, anon;

commit;
