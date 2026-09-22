-- Publish profile changes independently of inbox.message.  A profile refresh
-- must reach CRM even when the customer sends no new message.
ALTER TABLE inbox.crm_publish_outbox
  DROP CONSTRAINT IF EXISTS crm_publish_outbox_event_type_check;
ALTER TABLE inbox.crm_publish_outbox
  ADD CONSTRAINT crm_publish_outbox_event_type_check
  CHECK (event_type IN ('message.received', 'message.sent', 'conversation.created', 'contact.profile_updated'));

CREATE OR REPLACE FUNCTION inbox.crm_publish_profile_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, inbox, core
AS $$
DECLARE
  v_identity core.contact_identity;
  v_event_id uuid;
BEGIN
  -- The CRM's manual-name guard is represented at the source by this marker.
  IF coalesce(NEW.extra->>'name_source', '') = 'manual' THEN
    RETURN NEW;
  END IF;
  IF OLD.display_name IS NOT DISTINCT FROM NEW.display_name
     AND OLD.picture_url IS NOT DISTINCT FROM NEW.picture_url
     AND OLD.profile_status IS NOT DISTINCT FROM NEW.profile_status THEN
    RETURN NEW;
  END IF;

  FOR v_identity IN
    SELECT * FROM core.contact_identity
     WHERE contact_id = NEW.id AND channel = 'line'
  LOOP
    v_event_id := md5('contact.profile_updated:' || NEW.id::text || ':' || v_identity.id::text || ':' || coalesce(NEW.updated_at::text, ''))::uuid;
    INSERT INTO inbox.crm_publish_outbox
      (event_id, event_type, aggregate_type, aggregate_id, occurred_at, payload)
    VALUES
      (v_event_id, 'contact.profile_updated', 'contact', NEW.id::text,
       coalesce(NEW.updated_at, now()),
       jsonb_build_object(
         'provider', 'line',
         'account_scope', v_identity.account_key,
         'external_id', v_identity.external_id,
         'display_name', NEW.display_name,
         'picture_url', NEW.picture_url,
         'status', NEW.profile_status))
    ON CONFLICT (event_id) DO NOTHING;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN others THEN
  -- A CRM outage must not roll back the Connect profile update. The source
  -- change remains durable and can be reconciled from core.contact.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_crm_publish_profile_updated ON core.contact;
CREATE TRIGGER trg_crm_publish_profile_updated
  AFTER UPDATE OF display_name, picture_url, profile_status ON core.contact
  FOR EACH ROW EXECUTE FUNCTION inbox.crm_publish_profile_updated();
