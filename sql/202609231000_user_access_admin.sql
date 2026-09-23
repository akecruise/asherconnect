-- User & Access additions. Apply only after 202609221000_unified_identity.sql.
-- The existing auth UUID remains the only identity; no credentials are stored here.
ALTER TABLE core.profile ADD COLUMN IF NOT EXISTS display_name text;

CREATE TABLE IF NOT EXISTS core.user_security_state (
  user_id uuid PRIMARY KEY REFERENCES core."user"(id) ON DELETE CASCADE,
  revoked_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core.user_admin_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES core."user"(id),
  target_id uuid NOT NULL REFERENCES core."user"(id),
  action text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_admin_audit_target_at_idx
  ON core.user_admin_audit (target_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS user_admin_audit_actor_at_idx
  ON core.user_admin_audit (actor_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS core_user_email_normalized_idx
  ON core."user" (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE core.user_security_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.user_security_state, core.user_admin_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.user_security_state, core.user_admin_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE core.user_admin_audit_id_seq TO service_role;

-- A service-role caller still has to supply an active canonical admin actor.
CREATE OR REPLACE FUNCTION core.user_admin_assert_actor(p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, core AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.profile p
    JOIN core.user_module_access a ON a.user_id=p.user_id
    WHERE p.user_id=p_actor AND p.role='admin' AND p.is_active
      AND a.module_code='connect' AND a.is_enabled
  ) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE='42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION core.user_admin_list(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, core AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM core.user_admin_assert_actor(p_actor);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'email', u.email, 'display_name', coalesce(p.display_name, u.email),
    'role', p.role, 'team', p.team, 'is_active', p.is_active,
    'modules', coalesce((SELECT jsonb_agg(a.module_code ORDER BY a.module_code)
      FROM core.user_module_access a WHERE a.user_id=u.id AND a.is_enabled), '[]'::jsonb),
    'updated_at', p.updated_at
  ) ORDER BY u.email), '[]'::jsonb) INTO v_result
  FROM core."user" u JOIN core.profile p ON p.user_id=u.id;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION core.user_access_state(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, core AS $$
  SELECT jsonb_build_object('active',p.is_active,'role',p.role,
    'modules',coalesce((SELECT jsonb_agg(a.module_code ORDER BY a.module_code)
      FROM core.user_module_access a WHERE a.user_id=p.user_id AND a.is_enabled),'[]'::jsonb),
    'revoked_after',(SELECT s.revoked_after FROM core.user_security_state s WHERE s.user_id=p.user_id))
  FROM core.profile p WHERE p.user_id=p_user
$$;

CREATE OR REPLACE FUNCTION core.user_admin_save(
  p_actor uuid, p_target uuid, p_email text, p_display_name text,
  p_role text, p_team text, p_modules text[], p_active boolean, p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, core AS $$
DECLARE v_before jsonb; v_after jsonb; v_role text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('asher_user_admin'));
  PERFORM core.user_admin_assert_actor(p_actor);
  IF p_target IS NULL OR p_request_id IS NULL OR p_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR nullif(btrim(p_display_name),'') IS NULL OR length(p_display_name)>200
     OR p_role NOT IN ('sales','senior_sales','manager','admin')
     OR p_modules IS NULL OR p_modules <@ ARRAY['connect','crm']::text[] IS NOT TRUE
     OR p_active IS NULL THEN
    RAISE EXCEPTION 'invalid_user' USING ERRCODE='22023';
  END IF;
  IF p_target=p_actor AND (NOT p_active OR p_role<>'admin' OR NOT ('connect'=ANY(p_modules))) THEN
    RAISE EXCEPTION 'self_admin_change' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('email',u.email,'display_name',p.display_name,'role',p.role,
    'team',p.team,'is_active',p.is_active,'modules',coalesce((SELECT jsonb_agg(a.module_code ORDER BY a.module_code)
    FROM core.user_module_access a WHERE a.user_id=p_target AND a.is_enabled),'[]'::jsonb))
    INTO v_before FROM core."user" u JOIN core.profile p ON p.user_id=u.id WHERE u.id=p_target;
  IF v_before IS NOT NULL AND v_before->>'role'='admin' AND (p_role<>'admin' OR NOT p_active)
    AND (SELECT count(*) FROM core.profile WHERE role='admin' AND is_active)<=1 THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE='42501';
  END IF;
  INSERT INTO core."user"(id,email) VALUES (p_target,lower(p_email))
    ON CONFLICT(id) DO UPDATE SET email=excluded.email;
  INSERT INTO core.profile(user_id,display_name,role,team,is_active)
    VALUES(p_target,btrim(p_display_name),p_role,nullif(btrim(p_team),''),p_active)
    ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,
      team=excluded.team,is_active=excluded.is_active,updated_at=now();
  v_role := CASE WHEN p_role='manager' THEN 'sales_manager' ELSE p_role END;
  DELETE FROM core.user_role WHERE user_id=p_target AND role_code<>v_role;
  INSERT INTO core.user_role(user_id,role_code) VALUES(p_target,v_role) ON CONFLICT DO NOTHING;
  INSERT INTO core.user_module_access(user_id,module_code,role_code,is_enabled)
    SELECT p_target,m.code,v_role,m.code=ANY(p_modules) FROM core.module m
    WHERE m.code IN ('connect','crm')
    ON CONFLICT(user_id,module_code) DO UPDATE SET role_code=excluded.role_code,
      is_enabled=excluded.is_enabled,updated_at=now();
  v_after := jsonb_build_object('email',lower(p_email),'display_name',btrim(p_display_name),
    'role',p_role,'team',nullif(btrim(p_team),''),'is_active',p_active,'modules',to_jsonb(p_modules));
  INSERT INTO core.user_admin_audit(actor_id,target_id,action,before_value,after_value,request_id)
    VALUES(p_actor,p_target,CASE WHEN v_before IS NULL THEN 'user.created' ELSE 'user.updated' END,
      v_before,v_after,p_request_id);
  RETURN v_after;
END $$;

CREATE OR REPLACE FUNCTION core.user_admin_event(
  p_actor uuid, p_target uuid, p_action text, p_request_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, core AS $$
BEGIN
  PERFORM core.user_admin_assert_actor(p_actor);
  IF p_action NOT IN ('password.reset','sessions.revoked','user.enabled','user.disabled')
    OR NOT EXISTS (SELECT 1 FROM core.profile WHERE user_id=p_target) THEN
    RAISE EXCEPTION 'invalid_user' USING ERRCODE='22023';
  END IF;
  INSERT INTO core.user_admin_audit(actor_id,target_id,action,request_id)
    VALUES(p_actor,p_target,p_action,p_request_id);
END $$;

CREATE OR REPLACE FUNCTION core.user_admin_revoke(p_actor uuid, p_target uuid, p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, core AS $$
BEGIN
  PERFORM core.user_admin_assert_actor(p_actor);
  IF NOT EXISTS (SELECT 1 FROM core.profile WHERE user_id=p_target) THEN
    RAISE EXCEPTION 'invalid_user' USING ERRCODE='22023';
  END IF;
  INSERT INTO core.user_security_state(user_id,revoked_after) VALUES(p_target,now())
    ON CONFLICT(user_id) DO UPDATE SET revoked_after=excluded.revoked_after,updated_at=now();
  PERFORM core.user_admin_event(p_actor,p_target,'sessions.revoked',p_request_id);
END $$;

CREATE OR REPLACE FUNCTION core.user_admin_audit_list(p_actor uuid, p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, core AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM core.user_admin_assert_actor(p_actor);
  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC, a.id DESC),'[]'::jsonb)
    INTO v_result FROM (SELECT * FROM core.user_admin_audit WHERE target_id=p_target
      ORDER BY created_at DESC,id DESC LIMIT 100) a;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION core.user_admin_assert_actor(uuid), core.user_admin_list(uuid),
  core.user_access_state(uuid),
  core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid),
  core.user_admin_event(uuid,uuid,text,uuid), core.user_admin_revoke(uuid,uuid,uuid),
  core.user_admin_audit_list(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION core.user_admin_assert_actor(uuid), core.user_admin_list(uuid),
  core.user_access_state(uuid),
  core.user_admin_save(uuid,uuid,text,text,text,text,text[],boolean,uuid),
  core.user_admin_event(uuid,uuid,text,uuid), core.user_admin_revoke(uuid,uuid,uuid),
  core.user_admin_audit_list(uuid,uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
