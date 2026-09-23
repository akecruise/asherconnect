-- Run after the Instagram migration INSIDE a transaction that is rolled back.
-- No network calls; fixture inboxes are never committed or visible to workers.
CREATE FUNCTION pg_temp.ig_check(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;
DO $test$
DECLARE
  project uuid; ig uuid; fb uuid; actor uuid;
  r jsonb; duplicate_result jsonb; echo_result jsonb; outbound jsonb;
  conv uuid; contact uuid; fb_contact uuid; mid uuid; agent_mid uuid; count_before integer;
BEGIN
  SELECT id INTO STRICT project FROM core.project ORDER BY created_at LIMIT 1;
  INSERT INTO inbox.inbox(channel,project_id,name,is_active) VALUES('instagram',project,'__ig_rollback_test__',true) RETURNING id INTO ig;
  INSERT INTO inbox.inbox(channel,project_id,name,is_active) VALUES('messenger',project,'__fb_ig_rollback_test__',true) RETURNING id INTO fb;
  INSERT INTO inbox.bot_config(inbox_id,key,value) VALUES(ig,'reply.enabled','false'),(ig,'bot.generate_enabled','false')
    ON CONFLICT(inbox_id,key) DO UPDATE SET value=excluded.value;
  r := connect_private.receive_event(jsonb_build_object('inbox_id',ig,'page_id','1789','customer_psid','same-scoped-id',
    'external_id','same-scoped-id','event_id','ig-inbound-test','event_type','message','text','IG hello','is_standby',true),now());
  conv := (r->>'id')::uuid; mid := (r->>'message_id')::uuid;
  PERFORM pg_temp.ig_check(conv IS NOT NULL AND mid IS NOT NULL, 'IG receive creates conversation and message');
  SELECT contact_id INTO contact FROM inbox.conversation WHERE id=conv;
  fb_contact := core.resolve_identity('messenger','same-scoped-id',fb::text,'Same name',project);
  PERFORM pg_temp.ig_check(contact<>fb_contact, 'same textual ID on IG and Messenger remains isolated');
  duplicate_result := connect_private.receive_event(jsonb_build_object('inbox_id',ig,'event_id','ig-inbound-test'),now());
  PERFORM pg_temp.ig_check(duplicate_result->>'duplicate'='true', 'duplicate MID creates no second message');
  SELECT count(*) INTO count_before FROM core.contact_identity WHERE account_key=ig::text;
  echo_result := connect_private.receive_event(jsonb_build_object('inbox_id',ig,'page_id','1789','customer_psid','unknown',
    'external_id','unknown','event_id','ig-orphan-echo','event_type','echo','text','orphan'),now());
  PERFORM pg_temp.ig_check(echo_result->>'error'='IDENTITY_UNRESOLVED', 'orphan IG echo is unresolved');
  PERFORM pg_temp.ig_check((SELECT count(*)=count_before FROM core.contact_identity WHERE account_key=ig::text), 'orphan echo creates no phantom customer');
  echo_result := connect_private.receive_event(jsonb_build_object('inbox_id',ig,'page_id','1789','customer_psid','same-scoped-id',
    'external_id','same-scoped-id','event_id','ig-team-echo','event_type','echo','text','ตอบผ่าน IG'),now());
  PERFORM pg_temp.ig_check(echo_result->>'id'=conv::text, 'native IG reply attaches to customer conversation');
  PERFORM pg_temp.ig_check((SELECT sender_type='agent' FROM inbox.message WHERE id=(echo_result->>'message_id')::uuid), 'native reply is outbound');
  PERFORM pg_temp.ig_check((SELECT last_human_reply_at IS NOT NULL FROM inbox.conversation WHERE id=conv), 'native reply updates human response state');
  -- Each RPC normally has its own transaction; reset its transaction-local
  -- replay flag before simulating the next authenticated request here.
  PERFORM set_config('connect.replay','off',true);
  SELECT user_id INTO actor FROM core.profile WHERE is_active AND role IN ('admin','manager','sales','senior_sales') ORDER BY role LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'active test-capable staff profile required'; END IF;
  UPDATE inbox.conversation SET assignee_id=actor WHERE id=conv;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  outbound := inbox.connect_api('send',jsonb_build_object('id',conv,'request_id',gen_random_uuid(),'text','Reply through ASHER Connect'));
  agent_mid := (outbound->>'message_id')::uuid;
  PERFORM pg_temp.ig_check(agent_mid IS NOT NULL, 'staff reply enters delivery queue');
  PERFORM pg_temp.ig_check(EXISTS(SELECT 1 FROM connect_private.delivery WHERE message_id=agent_mid), 'outbound queue row exists');
  PERFORM pg_temp.ig_check((SELECT responder_user_id=actor FROM inbox.message WHERE id=agent_mid), 'staff responder attribution survives IG channel');
  UPDATE connect_private.delivery SET provider_id='ig-workspace-echo',status='sent' WHERE message_id=agent_mid;
  echo_result := connect_private.receive_event(jsonb_build_object('inbox_id',ig,'page_id','1789','customer_psid','same-scoped-id',
    'external_id','same-scoped-id','event_id','ig-workspace-echo','event_type','echo','text','Reply through ASHER Connect'),now());
  PERFORM pg_temp.ig_check(echo_result->>'duplicate_of'=agent_mid::text, 'workspace echo links existing outbound without duplication');
  UPDATE inbox.message SET media='[{"provider":"instagram","url":"https://example.test/a.jpg"}]' WHERE id=mid;
  r := inbox.instagram_message_deleted(ig,'wrong-customer','ig-inbound-test');
  PERFORM pg_temp.ig_check(r->>'deleted'='0', 'unsend cannot edit a different customer');
  SET LOCAL ROLE service_role;
  r := inbox.instagram_message_deleted(ig,'same-scoped-id','ig-inbound-test');
  RESET ROLE;
  PERFORM pg_temp.ig_check(r->>'deleted'='1', 'unsend clears the scoped message');
  PERFORM pg_temp.ig_check((SELECT media='[]'::jsonb AND content='[ข้อความถูกยกเลิกใน Instagram]' FROM inbox.message WHERE id=mid), 'unsend clears text and media references');
  PERFORM pg_temp.ig_check(NOT has_function_privilege('authenticated','inbox.instagram_message_deleted(uuid,text,text)','EXECUTE'), 'browser cannot invoke ingestion deletion RPC');
  PERFORM pg_temp.ig_check(NOT has_function_privilege('anon','inbox.instagram_message_deleted(uuid,text,text)','EXECUTE'), 'anonymous cannot invoke ingestion deletion RPC');
END
$test$;
