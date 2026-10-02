/**
 * CRM สั่ง Connect ส่งข้อความ (sql/202610031100_service_outbound.sql)
 *
 *   ALLOW_DB_TESTS=1 node --test tests/service-outbound.db.test.mjs
 *
 * ★ รัน migration + assertion ใน transaction เดียวแล้ว ROLLBACK
 * ★ ไม่ยิง LINE เลย — ตรวจว่าของที่ "จะถูกส่ง" ถูกวางในคิวเดิมถูกต้อง
 *   โดยเฉพาะว่า token ไม่เคยต้องออกจาก Connect และยิงซ้ำไม่ส่งสองครั้ง
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'ต้องมีฐาน supabase จริง — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const strip = name => readFileSync(new URL(`../sql/${name}`, import.meta.url), 'utf8')
  .replace(/^begin;\s*$/gm, '').replace(/^commit;\s*$/gm, '')
const migration = strip('202610031100_service_outbound.sql')

function runSql(sql) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-X', '-q']
  return process.env.DB_TEST_URL
    ? execFileSync('psql', [process.env.DB_TEST_URL, ...args], { input: sql, encoding: 'utf8' })
    : execFileSync('docker', ['exec', '-i', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres', ...args],
      { input: sql, encoding: 'utf8' })
}

const assertions = String.raw`
create function pg_temp.check(p boolean, msg text) returns void language plpgsql as $$
begin if p is distinct from true then raise exception 'FAIL: %', msg; end if; end $$;

DO $test$
DECLARE
  v_inbox uuid; v_chan text; v_contact uuid; v_conv uuid; r jsonb; r2 jsonb;
  v_msg uuid; v_n int; v_blocked boolean;
BEGIN
  SELECT id, channel INTO v_inbox, v_chan FROM inbox.inbox WHERE is_active ORDER BY created_at LIMIT 1;
  IF v_inbox IS NULL THEN RAISE EXCEPTION 'service_outbound_fixture_missing'; END IF;

  -- ── แจ้งทีม ─────────────────────────────────────────────────────────
  r := inbox.service_notify(jsonb_build_object(
         'idempotency_key', 'esc-1', 'text', 'เลย SLA 30 นาที: ลูกค้ายังไม่ได้รับการตอบ'));
  PERFORM pg_temp.check((r->>'reused')::boolean = false, 'first notify creates a job');
  PERFORM pg_temp.check(
    (SELECT kind = 'notify' AND channel = 'line_group' AND payload->>'type' = 'text'
       FROM connect_private.job WHERE id = (r->>'job_id')::bigint),
    'queued as a plain text notify job');
  -- ★ ข้อความของ CRM ต้องไปถึงแบบคำต่อคำ ไม่ผ่าน formatNotify
  PERFORM pg_temp.check(
    (SELECT payload->>'text' FROM connect_private.job WHERE id = (r->>'job_id')::bigint)
      = 'เลย SLA 30 นาที: ลูกค้ายังไม่ได้รับการตอบ', 'text is passed through verbatim');

  -- ยิงซ้ำคีย์เดิม = งานเดิม ไม่เกิดงานที่สอง
  r2 := inbox.service_notify(jsonb_build_object(
          'idempotency_key', 'esc-1', 'text', 'ข้อความใหม่ที่ต้องถูกเมิน'));
  PERFORM pg_temp.check((r2->>'reused')::boolean, 'same key is reused');
  PERFORM pg_temp.check(r2->>'job_id' = r->>'job_id', 'same job id');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM connect_private.job
      WHERE payload->>'service_idempotency_key' = 'esc-1') = 1, 'exactly one job for the key');

  r := inbox.service_notify(jsonb_build_object(
         'idempotency_key', 'esc-2', 'text', 'ส่งเข้า telegram', 'channel', 'telegram'));
  PERFORM pg_temp.check(
    (SELECT channel FROM connect_private.job WHERE id = (r->>'job_id')::bigint) = 'telegram',
    'telegram is an allowed target');

  -- คำขอที่ไม่ครบ / ช่องทางที่ไม่อนุญาต ต้องไม่เงียบ
  FOR v_n IN 1..4 LOOP
    v_blocked := false;
    BEGIN
      PERFORM inbox.service_notify(CASE v_n
        WHEN 1 THEN '{}'::jsonb
        WHEN 2 THEN jsonb_build_object('idempotency_key','x','text','')
        WHEN 3 THEN jsonb_build_object('idempotency_key','','text','hi')
        ELSE jsonb_build_object('idempotency_key','y','text','hi','channel','sms') END);
    EXCEPTION WHEN others THEN v_blocked := true; END;
    PERFORM pg_temp.check(v_blocked, 'bad notify request ' || v_n || ' is rejected');
  END LOOP;

  -- ── ส่งหาลูกค้า ─────────────────────────────────────────────────────
  v_contact := core.resolve_identity(v_chan, 'USERVICEOUT', v_inbox::text, 'ทดสอบ service send', NULL);
  INSERT INTO inbox.conversation(inbox_id, contact_id) VALUES (v_inbox, v_contact) RETURNING id INTO v_conv;

  r := inbox.service_send_to_contact(jsonb_build_object(
         'contact_ref', v_contact, 'idempotency_key', 'auto-1',
         'messages', '[{"type":"text","text":"ขณะนี้นอกเวลาทำการ ทีมงานจะติดต่อกลับพรุ่งนี้ครับ"}]'::jsonb));
  PERFORM pg_temp.check((r->>'reused')::boolean = false, 'first send creates a message');
  PERFORM pg_temp.check((r->>'conversation_id')::uuid = v_conv, 'posted into the contact conversation');
  v_msg := (r->'message_ids'->>0)::uuid;

  -- ★ หัวใจ: ต้องเข้าคิวขาออกเดิมเอง ไม่มีท่อที่สอง
  PERFORM pg_temp.check(
    (SELECT count(*) FROM connect_private.delivery WHERE message_id = v_msg AND status = 'pending') = 1,
    'the existing outbound queue picked it up');
  -- และต้องโผล่ในหน้าแชทให้เซลส์เห็น (sender_type bot, ไม่ใช่ซ่อน)
  PERFORM pg_temp.check(
    (SELECT sender_type = 'bot' AND event_type = 'message' FROM inbox.message WHERE id = v_msg),
    'visible in the chat as a bot message');

  -- ยิงซ้ำ = ไม่ส่งสองครั้ง (ลูกค้าต้องไม่ได้ข้อความซ้ำเพราะ CRM retry)
  r2 := inbox.service_send_to_contact(jsonb_build_object(
          'contact_ref', v_contact, 'idempotency_key', 'auto-1',
          'messages', '[{"type":"text","text":"ของใหม่ที่ต้องถูกเมิน"}]'::jsonb));
  PERFORM pg_temp.check((r2->>'reused')::boolean, 'same key is reused');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.message
      WHERE conversation_id = v_conv AND sender_type = 'bot') = 1, 'exactly one message was sent');

  -- หลายข้อความ = หลายแถว (คิวเดิมคิดเป็นหนึ่งแถวหนึ่งข้อความ)
  r := inbox.service_send_to_contact(jsonb_build_object(
         'contact_ref', v_contact, 'idempotency_key', 'auto-2',
         'messages', '[{"type":"text","text":"ข้อความหนึ่ง"},{"type":"text","text":"ข้อความสอง"}]'::jsonb));
  PERFORM pg_temp.check(jsonb_array_length(r->'message_ids') = 2, 'two messages, two rows');

  -- รูปต้องกลายเป็น payload image ไม่ใช่ข้อความ "[รูปภาพ]"
  r := inbox.service_send_to_contact(jsonb_build_object(
         'contact_ref', v_contact, 'idempotency_key', 'auto-3',
         'messages', '[{"type":"image","originalContentUrl":"https://cdn.example.com/a.jpg","previewImageUrl":"https://cdn.example.com/a-s.jpg"}]'::jsonb));
  v_msg := (r->'message_ids'->>0)::uuid;
  PERFORM pg_temp.check(
    (SELECT payload->>'type' = 'image' AND payload->>'url' = 'https://cdn.example.com/a.jpg'
       FROM connect_private.delivery WHERE message_id = v_msg),
    'an image leaves as an image payload');

  -- ลูกค้าที่ไม่มีบทสนทนา = ปฏิเสธ (การส่งหาคนที่ไม่เคยทักเป็นเรื่องของ broadcast)
  v_blocked := false;
  BEGIN
    PERFORM inbox.service_send_to_contact(jsonb_build_object(
      'contact_ref', gen_random_uuid(), 'idempotency_key', 'auto-9',
      'messages', '[{"type":"text","text":"hi"}]'::jsonb));
  EXCEPTION WHEN others THEN v_blocked := true; END;
  PERFORM pg_temp.check(v_blocked, 'no conversation -> rejected');

  -- 0 และ 6 ข้อความ ต้องถูกปฏิเสธ
  FOR v_n IN 1..2 LOOP
    v_blocked := false;
    BEGIN
      PERFORM inbox.service_send_to_contact(jsonb_build_object(
        'contact_ref', v_contact, 'idempotency_key', 'auto-bad-' || v_n,
        'messages', CASE v_n WHEN 1 THEN '[]'::jsonb ELSE
          (SELECT jsonb_agg(jsonb_build_object('type','text','text','x')) FROM generate_series(1,6)) END));
    EXCEPTION WHEN others THEN v_blocked := true; END;
    PERFORM pg_temp.check(v_blocked, 'message count ' || v_n || ' is rejected');
  END LOOP;

  -- ── แปลงตัวตนในช่องทาง → contact_ref ───────────────────────────────
  -- ★ นี่คือเส้นที่ทำให้ CRM ใช้ /internal/contacts/... ได้จริง เพราะ CRM เก็บ
  --   external_id ไม่ใช่ uuid (crm_conversations.connect_contact_ref)
  r := inbox.service_resolve_contact(jsonb_build_object(
         'provider', v_chan, 'account_scope', v_inbox::text, 'external_id', 'USERVICEOUT'));
  PERFORM pg_temp.check((r->>'contact_ref')::uuid = v_contact, 'tuple resolves to the contact uuid');

  v_blocked := false;
  BEGIN PERFORM inbox.service_resolve_contact(jsonb_build_object(
    'provider', v_chan, 'account_scope', v_inbox::text, 'external_id', 'UNOBODY'));
  EXCEPTION WHEN others THEN v_blocked := true; END;
  PERFORM pg_temp.check(v_blocked, 'unknown identity is not silently resolved');

  v_blocked := false;
  BEGIN PERFORM inbox.service_resolve_contact('{}'::jsonb);
  EXCEPTION WHEN others THEN v_blocked := true; END;
  PERFORM pg_temp.check(v_blocked, 'incomplete tuple is rejected');

  -- ── สิทธิ์: หน้าเว็บของพนักงานเรียกไม่ได้ ───────────────────────────
  PERFORM pg_temp.check(
    NOT has_function_privilege('authenticated', 'inbox.service_notify(jsonb)', 'execute'),
    'authenticated cannot notify the team as the system');
  PERFORM pg_temp.check(
    NOT has_function_privilege('authenticated', 'inbox.service_send_to_contact(jsonb)', 'execute'),
    'authenticated cannot send to a customer through the service door');
  PERFORM pg_temp.check(
    NOT has_function_privilege('anon', 'inbox.service_send_to_contact(jsonb)', 'execute'),
    'anon cannot either');
  PERFORM pg_temp.check(
    NOT has_function_privilege('authenticated', 'inbox.service_resolve_contact(jsonb)', 'execute'),
    'authenticated cannot resolve another customer identity');
  PERFORM pg_temp.check(
    has_function_privilege('service_role', 'inbox.service_send_to_contact(jsonb)', 'execute'),
    'service_role can');
END
$test$;
`

test('service notify + send-to-contact contract', { skip: SKIP && SKIP_WHY }, () => {
  const output = runSql(`BEGIN;\n${migration}\n${assertions}\nROLLBACK;\n`)
  assert.equal(output.trim(), '')
})
