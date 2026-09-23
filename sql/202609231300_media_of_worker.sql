-- ประตูอ่านสื่อสำหรับ worker (2026-09-23)
--
-- อาการ: งานส่งข้อความล้มทุกรอบ (~36 วินาที) ด้วย request_rejected
--        log: /rest/v1/rpc/media_of → 403 "permission denied for function media_of"
--        แล้วตามด้วย connect_worker → 400 stale_lease เพราะ job ค้างจนหมดอายุสัญญาเช่า
--
-- เหตุ: addOutboundMedia() ใน server.mjs เรียก inbox.media_of ด้วย service key
--       แต่ inbox.media_of เป็น "ประตูของผู้ใช้" — บรรทัดแรกตรวจ auth.uid()
--       ว่ามีโปรไฟล์ที่ยังใช้งานได้และ role อยู่ใน sales/senior_sales/manager/admin
--       service key ไม่มี auth.uid() เลย ด่านนี้จึงผ่านไม่ได้ตั้งแต่ต้น
--       และ EXECUTE ก็ให้ไว้เฉพาะ authenticated ตามเจตนาเดิม
--
--       ★ นี่คือการเรียกผิดประตู ไม่ใช่สิทธิ์ที่ตกหล่น
--         ถ้า "แก้" ด้วยการ GRANT inbox.media_of ให้ service_role จะกลายเป็นการ
--         เปิดให้ผู้เรียกที่ไม่มีตัวตนเดินผ่านฟังก์ชันที่มีไว้ตรวจตัวตนโดยเฉพาะ
--         — ลบเหตุผลของด่านนั้นทิ้งทั้งอัน จึงไม่ทำ
--
-- วิธีแก้: ทำประตูของ worker แยกออกมาให้ชัด ตามแบบที่ระบบนี้ใช้อยู่แล้ว
--         (inbox.connect_api = ประตูผู้ใช้ / inbox.connect_worker = ประตู worker)
--
--         ★ ไม่ไปเพิ่ม action ใน connect_private.worker เพราะ ORDER.txt เตือนไว้ว่า
--           มีไฟล์ที่เขียนทับ connect_private.worker + connect_private.api ทั้งตัว
--           การแก้ฟังก์ชันนั้นจึงผูกกับลำดับ migration แบบที่พลาดแล้วเงียบ
--           ฟังก์ชันเล็กแยกตัวไม่มีปัญหานี้
--
--         ★ connect_private อยู่นอก PGRST_DB_SCHEMAS (public,graphql_public,core,inbox)
--           worker จึงยิงตรงไม่ได้ ต้องมีตัวแทนใน inbox
--
-- additive: ไม่แตะ inbox.media_of ไม่แตะตาราง ไม่แตะข้อมูล
-- idempotent: CREATE OR REPLACE + GRANT รันซ้ำได้
-- reversible: ดูบล็อก ROLLBACK ท้ายไฟล์

CREATE OR REPLACE FUNCTION inbox.media_of_worker(p_conversation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, inbox AS $$
  SELECT connect_private.media_of(p_conversation_id)
$$;

ALTER FUNCTION inbox.media_of_worker(uuid) OWNER TO postgres;

-- ด่านสิทธิ์ของประตูนี้คือ "ใครถือ service key" ซึ่งอยู่ฝั่งเซิร์ฟเวอร์เท่านั้น
-- เบราว์เซอร์ไม่เคยได้คีย์นี้ ฝั่งผู้ใช้ต้องเดินผ่าน inbox.media_of ที่ตรวจ auth.uid() ตามเดิม
REVOKE ALL ON FUNCTION inbox.media_of_worker(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION inbox.media_of_worker(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS inbox.media_of_worker(uuid);
--   NOTIFY pgrst, 'reload schema';
--
-- ต้อง rollback โค้ดใน server.mjs กลับพร้อมกัน ไม่งั้น worker จะเรียกฟังก์ชันที่ไม่มีอยู่
