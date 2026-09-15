-- เทสต์ inbox.sla_elapsed_minutes ตามเคสในสเปกเฟส A
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < tests/sql/sla_elapsed.sql
--
-- ไม่เขียนอะไรลงฐานเลย เรียกฟังก์ชันล้วน ๆ รันซ้ำได้ไม่จำกัด
-- เวลาที่ใส่เป็นเวลาไทย แปลงเป็น timestamptz ด้วย at time zone ตรงจุดเรียก

\set ON_ERROR_STOP on

do $$
declare
  v int;
  -- ประกาศไว้ตรงนี้เพื่อให้เห็นชัดว่าเทสต์ผูกกับค่าตั้งไหน
  v_sla int := inbox.setting_int('sla_minutes', 10);

  function_under_test text := 'inbox.sla_elapsed_minutes';
begin
  raise notice 'sla_minutes ที่ใช้อยู่ = % · หยุดนับ %–%', v_sla,
    inbox.setting_time('sla_pause_start', time '00:00'),
    inbox.setting_time('sla_pause_end',   time '06:00');

  -- 1. ทัก 14:00 → ตอบ 14:10 · กลางวันล้วน ไม่มีอะไรถูกตัด
  v := inbox.sla_elapsed_minutes(
         timestamp '2026-09-15 14:00' at time zone 'Asia/Bangkok',
         timestamp '2026-09-15 14:10' at time zone 'Asia/Bangkok');
  assert v = 10, format('เคส 1 ควรได้ 10 แต่ได้ %s', v);
  assert v >= v_sla, 'เคส 1 ต้องนับเป็นตอบช้า';

  -- 2. ทัก 01:30 → ตอบ 06:10 · รอจริง 280 นาที แต่ 270 นาทีอยู่ในช่วงหยุดนับ
  v := inbox.sla_elapsed_minutes(
         timestamp '2026-09-15 01:30' at time zone 'Asia/Bangkok',
         timestamp '2026-09-15 06:10' at time zone 'Asia/Bangkok');
  assert v = 10, format('เคส 2 ควรได้ 10 แต่ได้ %s', v);
  assert v >= v_sla, 'เคส 2 ต้องนับเป็นตอบช้า';

  -- 3. ทัก 23:55 → ตอบ 06:05 ของวันถัดไป · ข้ามวัน รอจริง 370 นาที ตัดออก 360
  v := inbox.sla_elapsed_minutes(
         timestamp '2026-09-15 23:55' at time zone 'Asia/Bangkok',
         timestamp '2026-09-16 06:05' at time zone 'Asia/Bangkok');
  assert v = 10, format('เคส 3 ควรได้ 10 แต่ได้ %s', v);
  assert v >= v_sla, 'เคส 3 ต้องนับเป็นตอบช้า';

  -- 4. ตอบระหว่าง 00:00–06:00 · อยู่ในช่วงหยุดนับทั้งหมด ต้องนับว่าตอบทัน
  v := inbox.sla_elapsed_minutes(
         timestamp '2026-09-15 01:00' at time zone 'Asia/Bangkok',
         timestamp '2026-09-15 03:00' at time zone 'Asia/Bangkok');
  assert v = 0, format('เคส 4 ควรได้ 0 แต่ได้ %s', v);
  assert v < v_sla, 'เคส 4 ต้องนับเป็นตอบทัน';

  -- ── เคสขอบที่สเปกไม่ได้สั่ง แต่พังเงียบได้ถ้าไม่ดัก ──

  -- ทักก่อนเที่ยงคืนแล้วตอบข้ามคืนยาว ๆ · 22:00 → 08:00 = 600 นาที ตัด 360 เหลือ 240
  v := inbox.sla_elapsed_minutes(
         timestamp '2026-09-15 22:00' at time zone 'Asia/Bangkok',
         timestamp '2026-09-16 08:00' at time zone 'Asia/Bangkok');
  assert v = 240, format('เคสข้ามคืนยาว ควรได้ 240 แต่ได้ %s', v);

  -- ข้ามหลายวัน · 15 ที่ 12:00 → 18 ที่ 12:00 = 4320 นาที ตัดคืนละ 360 สามคืน = 3240
  v := inbox.sla_elapsed_minutes(
         timestamp '2026-09-15 12:00' at time zone 'Asia/Bangkok',
         timestamp '2026-09-18 12:00' at time zone 'Asia/Bangkok');
  assert v = 3240, format('เคสข้ามสามวัน ควรได้ 3240 แต่ได้ %s', v);

  -- เวลาย้อนหลัง / เท่ากัน / null ต้องได้ 0 ไม่ใช่ค่าติดลบหรือ error
  assert inbox.sla_elapsed_minutes(now(), now()) = 0, 'เวลาเท่ากันต้องได้ 0';
  assert inbox.sla_elapsed_minutes(now(), now() - interval '1 hour') = 0, 'เวลาย้อนหลังต้องได้ 0';
  assert inbox.sla_elapsed_minutes(null, now()) = 0, 'null ต้องได้ 0 ไม่ใช่ null';

  raise notice 'ผ่านครบทุกข้อ · %', function_under_test;
end $$;
