-- Standalone profile updates, with a durable retry queue if outbox insertion fails.
ALTER TABLE inbox.crm_publish_outbox DROP CONSTRAINT IF EXISTS crm_publish_outbox_event_type_check;
ALTER TABLE inbox.crm_publish_outbox ADD CONSTRAINT crm_publish_outbox_event_type_check
  CHECK (event_type IN ('message.received','message.sent','conversation.created','contact.profile_updated'));

CREATE TABLE IF NOT EXISTS inbox.crm_profile_publish_pending (
  contact_id uuid PRIMARY KEY REFERENCES core.contact(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inbox.crm_profile_publish_pending ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS crm_profile_pending_due_idx ON inbox.crm_profile_publish_pending(next_attempt_at,contact_id);
REVOKE ALL ON inbox.crm_profile_publish_pending FROM PUBLIC, anon, authenticated;
GRANT SELECT ON inbox.crm_profile_publish_pending TO service_role;

CREATE OR REPLACE FUNCTION inbox.crm_enqueue_profile(p_contact_id uuid, p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE v_contact core.contact; v_identity core.contact_identity; v_event_id uuid;
BEGIN
  SELECT * INTO v_contact FROM core.contact WHERE id=p_contact_id;
  IF NOT FOUND OR coalesce(v_contact.extra->>'name_source','')='manual' THEN RETURN; END IF;
  FOR v_identity IN SELECT * FROM core.contact_identity WHERE contact_id=p_contact_id AND channel='line'
  LOOP
    v_event_id := md5('contact.profile_updated:' || p_contact_id::text || ':' || v_identity.id::text || ':' ||
      p_occurred_at::text || ':' || coalesce(v_contact.display_name,'') || ':' ||
      coalesce(v_contact.picture_url,'') || ':' || coalesce(v_contact.profile_status,''))::uuid;
    INSERT INTO inbox.crm_publish_outbox(event_id,event_type,aggregate_type,aggregate_id,occurred_at,payload)
    VALUES(v_event_id,'contact.profile_updated','contact',p_contact_id::text,p_occurred_at,
      jsonb_build_object('provider','line','account_scope',v_identity.account_key,'external_id',v_identity.external_id,
        'display_name',v_contact.display_name,'picture_url',v_contact.picture_url,'status',v_contact.profile_status))
    ON CONFLICT(event_id) DO NOTHING;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION inbox.crm_enqueue_profile(uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION inbox.crm_enqueue_profile(uuid,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION inbox.crm_publish_profile_updated()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF coalesce(NEW.extra->>'name_source','')='manual' THEN
    DELETE FROM inbox.crm_profile_publish_pending WHERE contact_id=NEW.id;
    RETURN NEW;
  END IF;
  IF OLD.display_name IS NOT DISTINCT FROM NEW.display_name
    AND OLD.picture_url IS NOT DISTINCT FROM NEW.picture_url
    AND OLD.profile_status IS NOT DISTINCT FROM NEW.profile_status THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM core.contact_identity WHERE contact_id=NEW.id AND channel='line') THEN RETURN NEW; END IF;
  -- This write is outside the exception subtransaction. A failed outbox insert
  -- rolls back only the inner block; the pending row and source update survive.
  INSERT INTO inbox.crm_profile_publish_pending(contact_id,occurred_at)
  VALUES(NEW.id,coalesce(NEW.updated_at,now()))
  ON CONFLICT(contact_id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,
    attempts=0,next_attempt_at=now(),last_error_code=NULL;
  BEGIN
    PERFORM inbox.crm_enqueue_profile(NEW.id,coalesce(NEW.updated_at,now()));
    DELETE FROM inbox.crm_profile_publish_pending WHERE contact_id=NEW.id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE inbox.crm_profile_publish_pending SET attempts=attempts+1,last_error_code=SQLSTATE,
      next_attempt_at=now()+interval '30 seconds' WHERE contact_id=NEW.id;
    RAISE WARNING 'CRM profile event queued for retry (SQLSTATE %)', SQLSTATE;
  END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION inbox.crm_publish_profile_updated() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_crm_publish_profile_updated ON core.contact;
CREATE TRIGGER trg_crm_publish_profile_updated
  AFTER UPDATE OF display_name,picture_url,profile_status ON core.contact
  FOR EACH ROW EXECUTE FUNCTION inbox.crm_publish_profile_updated();

CREATE OR REPLACE FUNCTION inbox.crm_retry_profile_updates(p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE r inbox.crm_profile_publish_pending; v_done integer:=0; v_failed integer:=0;
BEGIN
  FOR r IN SELECT * FROM inbox.crm_profile_publish_pending WHERE next_attempt_at<=now()
    ORDER BY next_attempt_at,contact_id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,100))
  LOOP
    BEGIN
      PERFORM inbox.crm_enqueue_profile(r.contact_id,r.occurred_at);
      DELETE FROM inbox.crm_profile_publish_pending WHERE contact_id=r.contact_id;
      v_done:=v_done+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE inbox.crm_profile_publish_pending SET attempts=attempts+1,last_error_code=SQLSTATE,
        next_attempt_at=now()+interval '30 seconds' WHERE contact_id=r.contact_id;
      v_failed:=v_failed+1;
    END;
  END LOOP;
  RETURN jsonb_build_object('recovered',v_done,'failed',v_failed,
    'pending',(SELECT count(*) FROM inbox.crm_profile_publish_pending));
END $$;
REVOKE ALL ON FUNCTION inbox.crm_retry_profile_updates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION inbox.crm_retry_profile_updates(integer) TO service_role;
