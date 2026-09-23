-- Responder attribution for human outbound messages.
-- Additive: old messages remain readable; NULL snapshot means historical
-- responder cannot be proven and the UI must show the explicit fallback.

ALTER TABLE inbox.message
  ADD COLUMN IF NOT EXISTS responder_user_id uuid,
  ADD COLUMN IF NOT EXISTS responder_display_name text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_responder_user_fk'
  ) THEN
    ALTER TABLE inbox.message
      ADD CONSTRAINT message_responder_user_fk
      FOREIGN KEY (responder_user_id) REFERENCES core."user"(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS message_responder_at_idx
  ON inbox.message (conversation_id, sent_at DESC, id)
  WHERE sender_type = 'agent';

COMMENT ON COLUMN inbox.message.responder_user_id IS
  'Immutable auth user who sent the outbound human message; populated from sender_id at insert time.';
COMMENT ON COLUMN inbox.message.responder_display_name IS
  'Name snapshot from core.profile.display_name or auth profile email at send time; never recomputed.';
COMMENT ON COLUMN inbox.message.sent_at IS
  'Outbound responder timestamp snapshot; old rows may be NULL and fall back to created_at for display.';

CREATE OR REPLACE FUNCTION inbox.capture_responder_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, inbox, core, connect_private, public
AS $$
DECLARE
  v_name text;
BEGIN
  IF NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL THEN
    -- sender_id is set by connect_private.api from auth.uid(). The trigger
    -- snapshots it so later profile edits cannot rewrite message history.
    NEW.responder_user_id := NEW.sender_id;
    NEW.sent_at := COALESCE(NEW.sent_at, NEW.created_at, now());
    SELECT COALESCE(NULLIF(btrim(p.display_name), ''), NULLIF(btrim(u.email), ''))
      INTO v_name
      FROM core.profile p
      LEFT JOIN core."user" u ON u.id = p.user_id
     WHERE p.user_id = NEW.sender_id AND p.is_active;
    NEW.responder_display_name := v_name;
    IF v_name IS NULL THEN
      INSERT INTO connect_private.audit(actor_id, conversation_id, action, detail)
      VALUES (NEW.sender_id, NEW.conversation_id, 'responder_attribution_unresolved',
              jsonb_build_object('message_id', NEW.id, 'responder_user_id', NEW.sender_id,
                                 'reason', 'active_profile_name_missing'));
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS capture_responder_attribution ON inbox.message;
CREATE TRIGGER capture_responder_attribution
BEFORE INSERT ON inbox.message
FOR EACH ROW EXECUTE FUNCTION inbox.capture_responder_attribution();

-- Small read boundary used by the server to enrich the existing detail API.
-- It deliberately returns NULL for old messages with no historical snapshot;
-- the browser then shows “ตอบโดย: ไม่ระบุผู้ตอบ”.
CREATE OR REPLACE FUNCTION inbox.message_responder_snapshot(
  p_conversation_id uuid,
  p_message_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, inbox, connect_private, public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT connect_private.can_read(p_conversation_id) THEN
    RAISE EXCEPTION 'conversation_not_found' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'responder_user_id', m.responder_user_id,
    'responder_display_name', m.responder_display_name,
    'sent_at', COALESCE(m.sent_at, m.created_at)
  ) ORDER BY m.created_at, m.id), '[]'::jsonb)
    INTO v_result
    FROM inbox.message m
   WHERE m.conversation_id = p_conversation_id
     AND m.sender_type = 'agent'
     AND (p_message_ids IS NULL OR m.id = ANY(p_message_ids));
  RETURN v_result;
END
$$;

ALTER FUNCTION inbox.capture_responder_attribution() OWNER TO postgres;
ALTER FUNCTION inbox.message_responder_snapshot(uuid, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION inbox.capture_responder_attribution() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inbox.message_responder_snapshot(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inbox.message_responder_snapshot(uuid, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Rollback (forward deployment only; do not run against production without a
-- reviewed backup):
-- DROP FUNCTION IF EXISTS inbox.message_responder_snapshot(uuid, uuid[]);
-- DROP TRIGGER IF EXISTS capture_responder_attribution ON inbox.message;
-- DROP FUNCTION IF EXISTS inbox.capture_responder_attribution();
-- DROP INDEX IF EXISTS inbox.message_responder_at_idx;
-- ALTER TABLE inbox.message DROP CONSTRAINT IF EXISTS message_responder_user_fk;
-- ALTER TABLE inbox.message DROP COLUMN IF EXISTS responder_user_id, DROP COLUMN IF EXISTS responder_display_name, DROP COLUMN IF EXISTS sent_at;
