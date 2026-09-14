-- ═══════════════════════════════════════════════════════════════════════════
-- แก้ inbox.extract_phone() ที่ไม่เคยดึงเบอร์ได้เลยตั้งแต่ Phase 3
--
-- อาการ
--   select inbox.extract_phone('0812345678')  →  null
--
-- สาเหตุ
--   substring(text from pattern) ของ Postgres ถ้า pattern มีวงเล็บ
--   จะคืน "สิ่งที่ตรงกับวงเล็บกลุ่มแรก" ไม่ใช่ทั้งก้อนที่ match
--   pattern เดิมขึ้นต้นด้วย (\+?66|0) จึงคืนแค่ "0" แล้วตกด่านตรวจรูปแบบท้ายฟังก์ชัน
--
-- ผลที่ตามมา (ทั้งหมดเงียบ ไม่มี error ให้เห็น)
--   1. decide_notify กฎ "ลูกค้าให้เบอร์ → แจ้งทีมเสมอ" ไม่เคยทำงาน
--      ซึ่งเป็นกฎที่สำคัญที่สุดข้อหนึ่งของบอทตัวเดิม
--   2. bot_decisions บันทึก phone เป็น null ตลอด
--   3. Phase 9: outcome 'lead' ไม่มีวันเกิด
--
-- ทำไมเทสต์ 29 ข้อไม่จับ: ชุดนั้นป้อน phone_in_text เข้า ctx โดยตรง
-- (parseSim ทำให้) จึงไม่เคยเดินผ่านตัวดึงเบอร์เลยสักครั้ง
-- ตัวที่จับได้คือเทสต์ Phase 9 ที่สร้างข้อความจริงแล้วให้ระบบอ่านเอง
--
-- รันซ้ำได้
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function inbox.extract_phone(p_text text)
returns text
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare v_raw text; v_digits text;
begin
  if p_text is null then return null; end if;
  -- ★ วงเล็บนอกสุดครอบทั้งก้อน เพื่อให้กลุ่มแรก = ทั้งเบอร์ ไม่ใช่แค่ตัวนำหน้า
  v_raw := substring(p_text from '((\+?66|0)[[:space:]]?[689][[:space:]]?[0-9]([- ]?[0-9]){7})');
  if v_raw is null then return null; end if;
  v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');
  if left(v_digits, 2) = '66' then v_digits := '0' || substr(v_digits, 3); end if;
  return case when v_digits ~ '^0[689][0-9]{8}$' then v_digits else null end;
end $$;

commit;
