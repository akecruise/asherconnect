-- ASHER Unified Identity: additive shared authorization and mapping foundation.
-- core.profile.user_id is the existing canonical Supabase auth.users.id.
-- Existing Connect ownership columns already store that UUID; this migration
-- supplies the reusable role/module/mapping registry for CRM and future modules.

CREATE TABLE IF NOT EXISTS core.role (
  code text PRIMARY KEY,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO core.role(code, description) VALUES
  ('sales','Sales user'), ('senior_sales','Senior sales user'),
  ('sales_manager','Sales manager'), ('admin','Administrator')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.user_role (
  user_id uuid NOT NULL,
  role_code text NOT NULL REFERENCES core.role(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE IF NOT EXISTS core.module (
  code text PRIMARY KEY,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO core.module(code, description) VALUES
  ('crm','ASHER CRM'), ('connect','ASHER Connect')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.user_module_access (
  user_id uuid NOT NULL,
  module_code text NOT NULL REFERENCES core.module(code),
  role_code text REFERENCES core.role(code),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_code)
);

CREATE TABLE IF NOT EXISTS core.user_identity_map (
  user_id uuid NOT NULL,
  system_code text NOT NULL,
  legacy_user_id text NOT NULL,
  confidence text NOT NULL DEFAULT 'exact' CHECK (confidence IN ('exact','verified','ambiguous','unresolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, system_code, legacy_user_id),
  UNIQUE (system_code, legacy_user_id)
);

ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.module ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_module_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_identity_map ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.role, core.user_role, core.module, core.user_module_access, core.user_identity_map FROM anon;
GRANT SELECT ON core.role, core.module, core.user_role, core.user_module_access, core.user_identity_map TO authenticated;
GRANT ALL ON core.role, core.user_role, core.module, core.user_module_access, core.user_identity_map TO service_role;

DROP POLICY IF EXISTS unified_roles_read ON core.role;
CREATE POLICY unified_roles_read ON core.role FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS unified_modules_read ON core.module;
CREATE POLICY unified_modules_read ON core.module FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS unified_user_role_read ON core.user_role;
CREATE POLICY unified_user_role_read ON core.user_role FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS unified_access_read ON core.user_module_access;
CREATE POLICY unified_access_read ON core.user_module_access FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS unified_identity_read ON core.user_identity_map;
CREATE POLICY unified_identity_read ON core.user_identity_map FOR SELECT TO authenticated USING (user_id = auth.uid());

INSERT INTO core.user_role(user_id, role_code)
SELECT p.user_id, CASE WHEN p.role = 'manager' THEN 'sales_manager' ELSE p.role END
FROM core.profile p
WHERE p.is_active AND p.role IN ('sales','senior_sales','manager','admin')
ON CONFLICT DO NOTHING;

INSERT INTO core.user_module_access(user_id, module_code, role_code, is_enabled)
SELECT p.user_id, m.code, CASE WHEN p.role = 'manager' THEN 'sales_manager' ELSE p.role END, true
FROM core.profile p CROSS JOIN core.module m
WHERE p.is_active AND p.role IN ('sales','senior_sales','manager','admin')
ON CONFLICT (user_id,module_code) DO UPDATE
SET role_code=EXCLUDED.role_code,is_enabled=true,updated_at=now();

INSERT INTO core.user_identity_map(user_id, system_code, legacy_user_id, confidence)
SELECT p.user_id, 'connect', p.user_id::text, 'exact'
FROM core.profile p
ON CONFLICT (system_code, legacy_user_id) DO NOTHING;

-- CRM legacy memberships are preserved and mapped only on exact UUID auth_subject_id.
DO $$
BEGIN
  IF to_regclass('asher_crm.crm_memberships') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO core.user_identity_map(user_id,system_code,legacy_user_id,confidence)
      SELECT m.auth_subject_id::uuid,'crm',m.id::text,'exact'
      FROM asher_crm.crm_memberships m
      WHERE m.auth_subject_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ON CONFLICT (system_code,legacy_user_id) DO NOTHING
    $q$;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION core.current_user_has_module(p_module_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM core.user_module_access a
    WHERE a.user_id = auth.uid() AND a.module_code = p_module_code AND a.is_enabled
  )
$$;

COMMENT ON FUNCTION core.current_user_has_module(text) IS
  'Canonical ASHER module access check. Uses auth.uid()/core.user_module_access; legacy IDs are compatibility mappings only.';

-- Keep the existing RPC contract, but make Connect module access a database
-- gate as well as a role gate.  The underlying security-definer implementation
-- remains unchanged; this invoker wrapper runs first under the caller identity.
CREATE OR REPLACE FUNCTION inbox.connect_api(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO pg_catalog, public AS $$
BEGIN
  IF NOT core.current_user_has_module('connect') THEN
    RAISE EXCEPTION 'module_not_enabled' USING errcode='42501';
  END IF;
  RETURN connect_private.api(p_action, p_data);
END $$;
