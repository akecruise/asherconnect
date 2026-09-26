-- Case ownership follows the first identified human reply.
--
-- sender_id is auth.users.id for replies sent through ASHER Connect.  It is
-- also the stable subject mirrored into ASHER CRM memberships, so both systems
-- can point at the same person without matching display names or email.
--
-- The conversation row is locked before looking for an earlier human reply.
-- This makes two near-simultaneous first replies deterministic: the first
-- transaction to insert wins, while later replies never rewrite ownership.

CREATE OR REPLACE FUNCTION inbox.assign_first_responder_case_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, inbox
AS $$
BEGIN
  IF NEW.sender_type <> 'agent' OR NEW.sender_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM inbox.conversation
   WHERE id = NEW.conversation_id
   FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1
      FROM inbox.message m
     WHERE m.conversation_id = NEW.conversation_id
       AND m.sender_type = 'agent'
       AND m.sender_id IS NOT NULL
       AND m.id <> NEW.id
       AND (m.created_at, m.id) <= (NEW.created_at, NEW.id)
  ) THEN
    UPDATE inbox.conversation
       SET assignee_id = NEW.sender_id
     WHERE id = NEW.conversation_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assign_first_responder_case_owner ON inbox.message;
CREATE TRIGGER assign_first_responder_case_owner
AFTER INSERT ON inbox.message
FOR EACH ROW
EXECUTE FUNCTION inbox.assign_first_responder_case_owner();

ALTER FUNCTION inbox.assign_first_responder_case_owner() OWNER TO postgres;
REVOKE ALL ON FUNCTION inbox.assign_first_responder_case_owner() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION inbox.assign_first_responder_case_owner() IS
  'Assigns a conversation to its first identified human responder; later replies do not change ownership.';

