-- Run only in a fresh disposable database. Existing schemas cause an early failure.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA core;
CREATE SCHEMA inbox;
CREATE TABLE core.contact(id uuid PRIMARY KEY,display_name text,picture_url text,profile_status text,extra jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now());
CREATE TABLE core.contact_identity(id uuid PRIMARY KEY,contact_id uuid REFERENCES core.contact,channel text,account_key text,external_id text);
CREATE TABLE inbox.crm_publish_outbox(event_id uuid UNIQUE,event_type text CHECK(event_type IN ('message.received','message.sent','conversation.created')),
 aggregate_type text,aggregate_id text,occurred_at timestamptz,payload jsonb);
\ir ../sql/202609221500_crm_profile_updated_outbox.sql
INSERT INTO core.contact(id,display_name) VALUES('00000000-0000-0000-0000-000000000001','Before');
INSERT INTO core.contact_identity VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','line','synthetic-account','synthetic-customer');
UPDATE core.contact SET display_name='After',updated_at=clock_timestamp();
DO $$ BEGIN
 IF (SELECT count(*) FROM inbox.crm_publish_outbox)<>1 THEN RAISE EXCEPTION 'Standalone event missing'; END IF;
 IF EXISTS(SELECT 1 FROM inbox.crm_profile_publish_pending) THEN RAISE EXCEPTION 'Successful event left pending'; END IF;
 IF has_function_privilege('anon','inbox.crm_retry_profile_updates(integer)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous retry permitted'; END IF;
 IF has_table_privilege('authenticated','inbox.crm_profile_publish_pending','SELECT') THEN RAISE EXCEPTION 'Pending queue exposed'; END IF;
END $$;
CREATE FUNCTION inbox.reject_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE check_violation USING MESSAGE='Synthetic failure'; END $$;
CREATE TRIGGER fail_outbox BEFORE INSERT ON inbox.crm_publish_outbox FOR EACH ROW EXECUTE FUNCTION inbox.reject_test_insert();
UPDATE core.contact SET display_name='Recovered name',updated_at=clock_timestamp();
DO $$ BEGIN
 IF (SELECT display_name FROM core.contact)<>'Recovered name' THEN RAISE EXCEPTION 'Source update rolled back'; END IF;
 IF (SELECT count(*) FROM inbox.crm_profile_publish_pending WHERE last_error_code='23514')<>1 THEN RAISE EXCEPTION 'Failure not durably queued'; END IF;
END $$;
DROP TRIGGER fail_outbox ON inbox.crm_publish_outbox;
UPDATE inbox.crm_profile_publish_pending SET next_attempt_at=now();
SELECT inbox.crm_retry_profile_updates(20);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM inbox.crm_profile_publish_pending) THEN RAISE EXCEPTION 'Recovery left pending'; END IF;
 IF (SELECT count(*) FROM inbox.crm_publish_outbox WHERE payload->>'display_name'='Recovered name')<>1 THEN RAISE EXCEPTION 'Recovery event missing'; END IF;
END $$;
SELECT inbox.crm_enqueue_profile(id,updated_at) FROM core.contact;
DO $$ BEGIN
 IF (SELECT count(*) FROM inbox.crm_publish_outbox)<>2 THEN RAISE EXCEPTION 'Duplicate recovery event'; END IF;
END $$;
INSERT INTO inbox.crm_profile_publish_pending(contact_id,occurred_at) SELECT id,updated_at FROM core.contact;
UPDATE core.contact SET display_name='Sales manual',extra='{"name_source":"manual"}',updated_at=clock_timestamp();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM inbox.crm_profile_publish_pending) THEN RAISE EXCEPTION 'Manual name queued'; END IF;
 IF (SELECT count(*) FROM inbox.crm_publish_outbox)<>2 THEN RAISE EXCEPTION 'Manual name published'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: standalone update, durable failure, recovery, dedupe, manual guard and permissions' AS result;
