-- =====================================================================
-- 20260916_register_sales_staff.sql — ลงทะเบียนผู้ตอบใน inbox.sales_staff
-- =====================================================================
-- ★★ ยังไม่ได้ลง — รอผู้ใช้ยืนยัน "ชื่อ ↔ อีเมล" ก่อน (ดู EMAIL ด้านล่าง)
--
-- ทำไมต้องมี
--   sql/035 อ่านลายเซ็นท้ายข้อความจาก team.signatures ได้แล้ว (Mint / Kuang / Choosak)
--   และจะเซ็ต inbox.message.sender_id ให้เองถ้าหาแถวใน inbox.sales_staff เจอ
--   แต่ตอนนี้ตารางนั้น "ว่าง 0 แถว" → รายงาน inbox.reply_episodes / reply_stats
--   ที่ join ด้วย sales_staff.user_id จึงขึ้นชื่อผู้ตอบเป็น 'unknown' ตลอด
--   ลงไฟล์นี้แล้วชื่อคนตอบจะขึ้นเองโดยไม่ต้องแก้โค้ดหรือรายงานสักบรรทัด
--
-- ★ ชื่อใน name ต้องสะกดตรงกับคีย์ใน team.signatures (035 เทียบแบบไม่สนตัวพิมพ์)
--   คีย์ปัจจุบันของ inbox messenger: Choosak · Kuang · Mint
--
-- ★ user_id เป็น null ได้ (คอลัมน์ยอมให้ว่าง) แต่ถ้าปล่อยว่าง รายงานจะยังไม่เห็นชื่อ
--   เพราะ reply_episodes join ด้วย sales_staff.user_id = inbox.message.sender_id
--   → ถ้าคนไหนยังไม่มีบัญชี ต้องสร้างบัญชีก่อน (ดูท้ายไฟล์)
--
-- ★ รันซ้ำได้ — ข้ามชื่อที่มีอยู่แล้ว (เทียบแบบไม่สนตัวพิมพ์)
-- =====================================================================

begin;

-- ── กรอกอีเมลจริงของแต่ละคนตรงนี้ก่อนรัน ─────────────────────────────
-- ผู้ช่วยจับคู่ให้จากชื่อบัญชีที่มีอยู่ (ยังไม่ยืนยัน — ต้องให้คนตัดสิน):
--   Choosak → บัญชี manager ที่ local part ยาว 7 ตัวขึ้นต้น "ch"
--   Mint    → บัญชี manager ที่ local part ยาว 4 ตัวขึ้นต้น "mi"
--   Kuang   → ★ ไม่พบบัญชีที่ขึ้นต้นด้วย "ku" หรือ "ko" เลยในระบบ (13 บัญชี)
create temporary table _staff(name text, email text) on commit drop;
insert into _staff(name, email) values
  ('Choosak', 'ใส่อีเมลจริงที่นี่'),
  ('Kuang',   'ใส่อีเมลจริงที่นี่'),
  ('Mint',    'ใส่อีเมลจริงที่นี่');

-- ── ด่านกันกรอกไม่ครบ / อีเมลไม่มีจริง ───────────────────────────────
do $chk$
declare v_bad text;
begin
  select string_agg(s.name, ', ') into v_bad from _staff s
   where s.email like '%ใส่อีเมล%';
  if v_bad is not null then
    raise exception 'ยังไม่ได้กรอกอีเมลของ: % — เปิดไฟล์แล้วแก้ก่อนรัน', v_bad;
  end if;

  select string_agg(s.name || ' (' || s.email || ')', ', ') into v_bad
    from _staff s where not exists (select 1 from core."user" u where lower(u.email) = lower(s.email));
  if v_bad is not null then
    raise exception 'ไม่พบบัญชีในระบบสำหรับ: % — ต้องสร้างบัญชีก่อน', v_bad;
  end if;
end $chk$;

-- ── ลงทะเบียน ────────────────────────────────────────────────────────
insert into inbox.sales_staff(id, name, user_id, is_active)
select gen_random_uuid(), s.name, u.id, true
  from _staff s
  join core."user" u on lower(u.email) = lower(s.email)
 where not exists (select 1 from inbox.sales_staff st where lower(st.name) = lower(s.name));

select st.name,
       left(u.email,2) || repeat('x', greatest(length(split_part(u.email,'@',1)) - 2, 0))
         || '@' || split_part(u.email,'@',2) as email_masked,
       st.is_active, st.created_at
  from inbox.sales_staff st left join core."user" u on u.id = st.user_id
 order by st.name;

commit;

-- =====================================================================
-- ถ้าใครยังไม่มีบัญชี (เช่น Kuang)
-- =====================================================================
-- บัญชีของระบบนี้อยู่ใน auth.users ของ Supabase แล้วมีแถวเงาใน core."user"
-- + core.profile (role/is_active) — สร้างผ่าน Supabase admin API หรือสคริปต์
-- asher-web/scripts/create-user.mjs (npm run user:create) ไม่ใช่ insert ตรง ๆ
-- เพราะ auth.users ต้องการ hash รหัสผ่านที่ถูกต้อง
--
-- ★ ทางลัดที่ใช้ได้ถ้ายังไม่อยากสร้างบัญชี: ลงทะเบียนชื่อโดย user_id เป็น null
--     insert into inbox.sales_staff(id, name, user_id, is_active)
--     values (gen_random_uuid(), 'Kuang', null, true);
--   035 จะยังบันทึกชื่อลง inbox.human_reply_events.note ได้ตามปกติ
--   แต่รายงานที่ join ด้วย user_id จะยังไม่เห็นชื่อ จนกว่าจะผูกบัญชีจริง
-- =====================================================================
