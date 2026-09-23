-- ทำให้ "ผู้ใช้กลาง" เป็นกลางจริง: สิทธิ์ CRM ตามสิทธิ์ที่ตั้งใน Connect เอง (2026-09-23)
--
-- ปัญหา: สิทธิ์ผู้ใช้ถูกเก็บสองที่
--   - core.user_module_access   ← หน้า /admin/users ของ Connect เขียนที่นี่ (ต้นทาง)
--   - asher_crm.crm_memberships ← CRM อ่านที่นี่ตอนออก session (issueSession)
--
--   เพิ่มผู้ใช้ที่หน้า Connect แล้วแถวฝั่ง CRM ไม่เกิดตาม พอผู้ใช้ไป login CRM
--   จะโดนปฏิเสธด้วย 'crm module membership is not mapped' ทั้งที่หน้าจัดการบอกว่ามีสิทธิ์แล้ว
--   ที่ผ่านมาแก้ด้วยการ INSERT เองทีละคน ซึ่งพลาดเมื่อไหร่ก็ไม่มีใครรู้จนผู้ใช้เข้าไม่ได้
--
-- ทำไมเพิ่งทำได้ตอนนี้: เมื่อก่อน asher_crm อยู่คนละ database (answer_hub_clone_20260918)
--   จึงเขียนข้ามไม่ได้ ต้อง sync ด้วยมือหรือผ่านแอป ตอนนี้ย้ายมาอยู่ฐานเดียวกันแล้ว
--   ทริกเกอร์จึงเป็นทางที่ตรงที่สุด — สิทธิ์เดินทางพร้อมกันในธุรกรรมเดียว ไม่มีช่วงที่ไม่ตรงกัน
--
-- ★ ทิศทางเดียว: core → asher_crm เท่านั้น
--   core.user_module_access คือต้นทางความจริง การแก้ที่ crm_memberships ตรง ๆ จะถูกเขียนทับ
--   เมื่อมีการแก้สิทธิ์ครั้งถัดไป — ตั้งใจให้เป็นแบบนั้น จะได้มีที่เดียวที่ต้องดู
--
-- additive: ไม่แก้ตารางเดิม ไม่ลบข้อมูล  · idempotent: รันซ้ำได้  · reversible: ดูท้ายไฟล์

-- แปลง role ของ Connect เป็น role ของ CRM
-- ★ ต้องตรงกับ canonicalRole() ใน CRM (src/modules/auth/service.ts)
--   ถ้าสองฝั่งแปลไม่ตรงกัน issueSession จะเจอ role ไม่ตรงแล้วปฏิเสธด้วย 'forbidden'
CREATE OR REPLACE FUNCTION core.crm_membership_role(p_role_code text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_role_code
    WHEN 'admin' THEN 'admin'
    WHEN 'manager' THEN 'manager'
    WHEN 'sales_manager' THEN 'manager'
    WHEN 'senior_sales' THEN 'manager'
    WHEN 'sales' THEN 'sales'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION core.sync_crm_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core AS $$
DECLARE v_workspace uuid; v_role text;
BEGIN
  IF NEW.module_code <> 'crm' THEN RETURN NEW; END IF;

  -- มี workspace เดียวในระบบนี้ ถ้าวันหนึ่งมีหลายอัน ต้องกลับมาตัดสินใจตรงนี้ก่อน
  -- ไม่เดาเอาอันแรก เพราะให้สิทธิ์ผิด workspace อันตรายกว่าไม่ให้เลย
  SELECT w.id INTO v_workspace FROM asher_crm.crm_workspaces w WHERE w.active ORDER BY w.created_at LIMIT 1;
  IF v_workspace IS NULL THEN RETURN NEW; END IF;

  v_role := core.crm_membership_role(NEW.role_code);

  -- role ที่แปลไม่ได้ = ไม่รู้จะให้สิทธิ์อะไร จึงปิดไว้ ดีกว่าเดา
  IF v_role IS NULL OR NOT NEW.is_enabled THEN
    UPDATE asher_crm.crm_memberships
       SET active = false, updated_at = now()
     WHERE workspace_id = v_workspace AND auth_subject_id = NEW.user_id::text;
    RETURN NEW;
  END IF;

  INSERT INTO asher_crm.crm_memberships (workspace_id, auth_subject_id, role, active)
  VALUES (v_workspace, NEW.user_id::text, v_role, true)
  ON CONFLICT (workspace_id, auth_subject_id)
  DO UPDATE SET role = excluded.role, active = true, updated_at = now();

  RETURN NEW;
END $$;

ALTER FUNCTION core.crm_membership_role(text) OWNER TO postgres;
ALTER FUNCTION core.sync_crm_membership() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_crm_membership ON core.user_module_access;
CREATE TRIGGER sync_crm_membership
AFTER INSERT OR UPDATE OF role_code, is_enabled ON core.user_module_access
FOR EACH ROW EXECUTE FUNCTION core.sync_crm_membership();

-- เก็บตกแถวที่มีอยู่แล้วให้ตรงกัน เพื่อให้ไฟล์นี้ทำงานได้ด้วยตัวเองโดยไม่ต้องพึ่งการ sync มือก่อนหน้า
INSERT INTO asher_crm.crm_memberships (workspace_id, auth_subject_id, role, active)
SELECT w.id, ma.user_id::text, core.crm_membership_role(ma.role_code), true
  FROM core.user_module_access ma
  CROSS JOIN LATERAL (SELECT id FROM asher_crm.crm_workspaces WHERE active ORDER BY created_at LIMIT 1) w
 WHERE ma.module_code = 'crm' AND ma.is_enabled
   AND core.crm_membership_role(ma.role_code) IS NOT NULL
ON CONFLICT (workspace_id, auth_subject_id)
DO UPDATE SET role = excluded.role, active = true, updated_at = now();

NOTIFY pgrst, 'reload schema';

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS sync_crm_membership ON core.user_module_access;
--   DROP FUNCTION IF EXISTS core.sync_crm_membership();
--   DROP FUNCTION IF EXISTS core.crm_membership_role(text);
--   NOTIFY pgrst, 'reload schema';
--
-- การ rollback ไม่ลบแถวใน crm_memberships ที่ทริกเกอร์สร้างไว้ — ตั้งใจ
-- เพราะลบแล้วผู้ใช้ที่ใช้งานอยู่จะเข้า CRM ไม่ได้ทันที กลับไปเป็น sync มือเหมือนเดิมแทน
