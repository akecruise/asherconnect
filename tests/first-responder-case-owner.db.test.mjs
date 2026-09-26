import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../sql/202609251400_first_responder_case_owner.sql', import.meta.url), 'utf8')

test('first identified human reply links Connect ownership and later replies cannot replace it', () => {
  const assertions = String.raw`
DO $test$
DECLARE
  v_inbox uuid;
  v_contact uuid;
  v_conversation uuid;
  v_first uuid;
  v_second uuid;
  v_owner uuid;
BEGIN
  SELECT id INTO v_inbox FROM inbox.inbox WHERE is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_first FROM core."user" ORDER BY id LIMIT 1;
  SELECT id INTO v_second FROM core."user" WHERE id <> v_first ORDER BY id LIMIT 1;
  IF v_inbox IS NULL OR v_first IS NULL OR v_second IS NULL THEN
    RAISE EXCEPTION 'first_responder_fixture_missing';
  END IF;

  INSERT INTO core.contact(display_name) VALUES ('__first_responder_test__') RETURNING id INTO v_contact;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode, assignee_id)
  VALUES (v_inbox, v_contact, 'open', 'human', v_second)
  RETURNING id INTO v_conversation;

  INSERT INTO inbox.message(conversation_id, sender_type, sender_id, content)
  VALUES (v_conversation, 'agent', v_first, 'first');
  SELECT assignee_id INTO v_owner FROM inbox.conversation WHERE id=v_conversation;
  IF v_owner IS DISTINCT FROM v_first THEN RAISE EXCEPTION 'first_responder_not_assigned'; END IF;

  INSERT INTO inbox.message(conversation_id, sender_type, sender_id, content)
  VALUES (v_conversation, 'agent', v_second, 'second');
  SELECT assignee_id INTO v_owner FROM inbox.conversation WHERE id=v_conversation;
  IF v_owner IS DISTINCT FROM v_first THEN RAISE EXCEPTION 'later_responder_replaced_owner'; END IF;

  INSERT INTO inbox.message(conversation_id, sender_type, sender_id, content)
  VALUES (v_conversation, 'bot', NULL, 'bot');
  INSERT INTO inbox.message(conversation_id, sender_type, sender_id, content)
  VALUES (v_conversation, 'agent', NULL, 'native echo');
  SELECT assignee_id INTO v_owner FROM inbox.conversation WHERE id=v_conversation;
  IF v_owner IS DISTINCT FROM v_first THEN RAISE EXCEPTION 'unattributed_message_replaced_owner'; END IF;
END
$test$;
ROLLBACK;
`
  const output = execFileSync('docker', [
    'exec', '-i', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-X', '-q',
  ], { input: `BEGIN;\n${migration}\n${assertions}`, encoding: 'utf8' })
  assert.equal(output, '')
})
