-- แก้สิทธิ์ของฟังก์ชัน User & Access ให้ทำงานได้จริง (2026-09-23)
--
-- อาการ: ล็อกอิน ASHER Connect สำเร็จ แล้วถูกเด้งออกทันทีในคำขอถัดไป (login loop)
--        และหน้า /admin/users ใช้งานไม่ได้
--
-- เหตุ: ฟังก์ชันใน 202609231000_user_access_admin.sql ประกาศเป็น SECURITY INVOKER
--       จึงรันด้วยสิทธิ์ของผู้เรียก ซึ่งคือ service_role
--       แต่ service_role ไม่เคยได้ GRANT บน core.profile และ core."user"
--       (สองตารางนี้เป็นของ postgres มาจาก 202609221000_unified_identity.sql
--        migration รอบที่แล้ว GRANT ให้เฉพาะตารางที่ตัวเองสร้างใหม่)
--       ผลคือทุกการเรียกได้ ERROR 42501 permission denied for table profile
--
--       จุดที่เจ็บที่สุดคือ authorize() ใน server.mjs ซึ่งเรียก core.user_access_state
--       ทุกคำขอที่ผ่าน session — คำขอแรกหลังล็อกอินจึงล้มเสมอ
--       BYPASSRLS ของ service_role ช่วยไม่ได้ เพราะมันข้ามเฉพาะ row policy
--       ไม่ได้ข้ามสิทธิ์ระดับตาราง
--
-- วิธีแก้: ให้ฟังก์ชันเป็น SECURITY DEFINER ที่มี postgres เป็นเจ้าของ
--         (postgres เป็นเจ้าของ core.profile และ core."user" อยู่แล้ว)
--
--         ★ เลือกทางนี้แทนการ GRANT ตารางให้ service_role เพราะแคบกว่า:
--           service_role ยังคงแตะ core.profile / core."user" ตรง ๆ ไม่ได้เลย
--           เข้าถึงได้เฉพาะผ่านฟังก์ชันที่มีพารามิเตอร์ชัดเจนเท่านั้น
--
--         ★ RBAC ไม่ถูกลดทอน — core.user_admin_assert_actor ยังตรวจ
--           role='admin' + is_active + module connect ในตัวฟังก์ชันเหมือนเดิม
--           ด่านสิทธิ์อยู่ในตรรกะของฟังก์ชัน ไม่ได้อยู่ที่สิทธิ์ตาราง
--
--         ★ ทุกฟังก์ชันตรึง search_path = pg_catalog, core ไว้แล้วตั้งแต่ไฟล์ก่อน
--           จึงปลอดภัยกับ SECURITY DEFINER (ไม่มีช่อง search_path hijack)
--
--         ★ EXECUTE ยังเป็นของ service_role เท่านั้น — ไฟล์นี้ไม่ GRANT เพิ่มให้ใคร
--           anon/authenticated/PUBLIC ยังถูก REVOKE ไว้จากไฟล์ก่อน
--
-- additive: ไม่มี DDL กับตาราง ไม่แตะข้อมูล ไม่แตะรหัสผ่าน ไม่แตะข้อมูลลูกค้า
-- idempotent: ALTER FUNCTION รันซ้ำได้ ผลลัพธ์เท่าเดิม
-- reversible: ดูบล็อก ROLLBACK ท้ายไฟล์

ALTER FUNCTION core.user_admin_assert_actor(uuid)                                    SECURITY DEFINER;
ALTER FUNCTION core.user_access_state(uuid)                                          SECURITY DEFINER;
ALTER FUNCTION core.user_admin_list(uuid)                                            SECURITY DEFINER;
ALTER FUNCTION core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid) SECURITY DEFINER;
ALTER FUNCTION core.user_admin_event(uuid,uuid,text,uuid)                            SECURITY DEFINER;
ALTER FUNCTION core.user_admin_revoke(uuid,uuid,uuid)                                SECURITY DEFINER;

-- เจ้าของต้องเป็น postgres เพราะ core.profile และ core."user" เป็นของ postgres
-- ถ้าปล่อยเป็น supabase_admin จะได้สิทธิ์เกินจำเป็น (superuser) โดยไม่มีเหตุผล
ALTER FUNCTION core.user_admin_assert_actor(uuid)                                    OWNER TO postgres;
ALTER FUNCTION core.user_access_state(uuid)                                          OWNER TO postgres;
ALTER FUNCTION core.user_admin_list(uuid)                                            OWNER TO postgres;
ALTER FUNCTION core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid) OWNER TO postgres;
ALTER FUNCTION core.user_admin_event(uuid,uuid,text,uuid)                            OWNER TO postgres;
ALTER FUNCTION core.user_admin_revoke(uuid,uuid,uuid)                                OWNER TO postgres;

-- เปลี่ยนเจ้าของแล้วสิทธิ์ EXECUTE เดิมยังติดมาด้วย แต่ย้ำอีกครั้งให้ชัดว่าใครเรียกได้
REVOKE ALL ON FUNCTION core.user_admin_assert_actor(uuid), core.user_access_state(uuid),
  core.user_admin_list(uuid),
  core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid),
  core.user_admin_event(uuid,uuid,text,uuid), core.user_admin_revoke(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION core.user_admin_assert_actor(uuid), core.user_access_state(uuid),
  core.user_admin_list(uuid),
  core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid),
  core.user_admin_event(uuid,uuid,text,uuid), core.user_admin_revoke(uuid,uuid,uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- ย้อนกลับเป็นสถานะก่อนไฟล์นี้ (ซึ่งคือสถานะที่ล็อกอินไม่ได้ — ใช้เมื่อจำเป็นจริงเท่านั้น):
--
--   ALTER FUNCTION core.user_admin_assert_actor(uuid)                                    SECURITY INVOKER;
--   ALTER FUNCTION core.user_access_state(uuid)                                          SECURITY INVOKER;
--   ALTER FUNCTION core.user_admin_list(uuid)                                            SECURITY INVOKER;
--   ALTER FUNCTION core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid) SECURITY INVOKER;
--   ALTER FUNCTION core.user_admin_event(uuid,uuid,text,uuid)                            SECURITY INVOKER;
--   ALTER FUNCTION core.user_admin_revoke(uuid,uuid,uuid)                                SECURITY INVOKER;
--   ALTER FUNCTION core.user_admin_assert_actor(uuid)                                    OWNER TO supabase_admin;
--   ALTER FUNCTION core.user_access_state(uuid)                                          OWNER TO supabase_admin;
--   ALTER FUNCTION core.user_admin_list(uuid)                                            OWNER TO supabase_admin;
--   ALTER FUNCTION core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid) OWNER TO supabase_admin;
--   ALTER FUNCTION core.user_admin_event(uuid,uuid,text,uuid)                            OWNER TO supabase_admin;
--   ALTER FUNCTION core.user_admin_revoke(uuid,uuid,uuid)                                OWNER TO supabase_admin;
--   NOTIFY pgrst, 'reload schema';
--
-- สถานะก่อนแก้ ตรวจจาก production เมื่อ 2026-09-23 (ทั้ง 7 ตัว INVOKER / เจ้าของ supabase_admin)
