/**
 * Follow → Lead ฝั่ง Connect (sql/202610030900_follow_welcome_flex.sql)
 *
 *   ALLOW_DB_TESTS=1 node --test tests/follow-welcome.db.test.mjs
 *
 * ★ รัน migration + assertion ใน transaction เดียวแล้ว ROLLBACK — ไม่มีอะไรค้างในฐาน
 * ★ ไม่ยิง LINE เลย — ตรวจว่าของที่ "จะถูกส่ง" ถูกวางในคิวขาออกถูกต้องแล้วหรือยัง
 *   (ตัวส่งจริงคือ providers.mjs ซึ่งมีเทสต์ของตัวเองอยู่แล้ว)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'ต้องมีฐาน supabase จริง — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const strip = name => readFileSync(new URL(`../sql/${name}`, import.meta.url), 'utf8')
  .replace(/^begin;\s*$/gm, '').replace(/^commit;\s*$/gm, '')

// ลงทั้งสายตามลำดับใน ORDER.txt — 202610030900 ใช้ broadcast_emit + constraint ของสองไฟล์ก่อนหน้า
const migration = [
  '202609211300_crm_publisher.sql',
  '202610021200_line_broadcast.sql',
  '202610030900_follow_welcome_flex.sql',
].map(strip).join('\n')

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
  v_inbox uuid; v_chan text; v_contact uuid; v_conv uuid;
  v_follow uuid; v_bot uuid; v_pb uuid; r jsonb; v_payload jsonb; v_n int;
BEGIN
  SELECT id, channel INTO v_inbox, v_chan FROM inbox.inbox
   WHERE is_active AND channel = 'line' ORDER BY created_at LIMIT 1;
  IF v_inbox IS NULL THEN RAISE EXCEPTION 'follow_welcome_fixture_missing: ไม่มี inbox ช่องทาง line'; END IF;

  v_contact := core.resolve_identity(v_chan, 'UWELCOMETEST', v_inbox::text, 'ทดสอบ welcome', NULL);
  INSERT INTO inbox.conversation(inbox_id, contact_id) VALUES (v_inbox, v_contact) RETURNING id INTO v_conv;

  -- ── แบบตั้งต้นต้องเป็น Flex ที่ถูกรูปของ LINE ────────────────────────
  r := inbox.follow_welcome_default();
  PERFORM pg_temp.check(r->>'type' = 'flex', 'default is a flex message');
  PERFORM pg_temp.check(coalesce(r->>'altText','') <> '', 'flex has altText');
  PERFORM pg_temp.check(r->'contents'->>'type' = 'bubble', 'flex contents is a bubble');
  PERFORM pg_temp.check(
    jsonb_array_length(r->'contents'->'footer'->'contents') = 3, 'three buttons');
  -- ปุ่มทั้งสามต้องเป็น postback และ data ต้องขึ้นต้นด้วยรุ่นที่ตกลงไว้
  PERFORM pg_temp.check(
    (select count(*) from jsonb_array_elements(r->'contents'->'footer'->'contents') b
      where b->'action'->>'type' = 'postback'
        and b->'action'->>'data' like 'asher:v1:interest=%') = 3,
    'every button is a versioned postback');
  PERFORM pg_temp.check(
    (select jsonb_agg(b->'action'->>'data' order by b->'action'->>'data')
       from jsonb_array_elements(r->'contents'->'footer'->'contents') b)
      = '["asher:v1:interest=naii","asher:v1:interest=unsure","asher:v1:interest=vibe"]'::jsonb,
    'the three codes are vibe / naii / unsure');

  -- ── ปิดอยู่ = ไม่ตอบอะไรเลย (ค่าตั้งต้นต้องปลอดภัย) ─────────────────
  PERFORM pg_temp.check(
    NOT inbox.cfg_bool(v_inbox, 'reply.flex_welcome_on_follow', false),
    'the switch ships off');

  INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
  VALUES (v_conv, 'system', '[ลูกค้าเพิ่มเพื่อน]', 'follow', 'follow') RETURNING id INTO v_follow;
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.message WHERE conversation_id = v_conv AND sender_type = 'bot') = 0,
    'switch off -> no welcome message at all');

  -- ── เปิดสวิตช์ แล้ว follow อีกครั้ง ─────────────────────────────────
  UPDATE inbox.bot_config SET value = to_jsonb(true)
   WHERE inbox_id = v_inbox AND key = 'reply.flex_welcome_on_follow';
  PERFORM pg_temp.check(inbox.cfg_bool(v_inbox, 'reply.flex_welcome_on_follow', false), 'switch on');

  INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
  VALUES (v_conv, 'system', '[ลูกค้าเพิ่มเพื่อน]', 'follow', 'follow') RETURNING id INTO v_follow;

  SELECT id INTO v_bot FROM inbox.message
   WHERE conversation_id = v_conv AND sender_type = 'bot' ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check(v_bot IS NOT NULL, 'welcome message created');
  PERFORM pg_temp.check(
    (SELECT content FROM inbox.message WHERE id = v_bot) = inbox.follow_welcome_default()->>'altText',
    'chat list shows the altText, not raw json');

  -- ★ หัวใจของไฟล์นี้: payload ในคิวขาออกต้องถูกอัปเกรดเป็น Flex แล้ว
  --   ไม่ใช่ {"type":"text"} ที่ enqueue_outbound ใส่ไว้ตอนแรก
  SELECT payload INTO v_payload FROM connect_private.delivery WHERE message_id = v_bot;
  PERFORM pg_temp.check(v_payload IS NOT NULL, 'the existing outbound queue picked it up');
  PERFORM pg_temp.check(v_payload->>'type' = 'raw', 'payload upgraded to raw');
  PERFORM pg_temp.check(v_payload->'line'->>'type' = 'flex', 'raw.line carries the flex message');
  PERFORM pg_temp.check(
    jsonb_array_length(v_payload->'line'->'contents'->'footer'->'contents') = 3,
    'the buttons survived into the queue');
  PERFORM pg_temp.check(
    (SELECT status FROM connect_private.delivery WHERE message_id = v_bot) = 'pending',
    'still queued, nothing sent from inside the database');

  -- แก้แบบในฐานแล้วต้องมีผลทันที ไม่ต้อง deploy
  UPDATE inbox.bot_config
     SET value = jsonb_set(inbox.follow_welcome_default(), '{altText}', '"แบบที่แก้เองแล้ว"')
   WHERE inbox_id = v_inbox AND key = 'line.follow_welcome_flex';
  INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
  VALUES (v_conv, 'system', '[ลูกค้าเพิ่มเพื่อน]', 'follow', 'follow');
  PERFORM pg_temp.check(
    (SELECT content FROM inbox.message WHERE conversation_id = v_conv AND sender_type = 'bot'
      ORDER BY created_at DESC LIMIT 1) = 'แบบที่แก้เองแล้ว',
    'template is data: editing bot_config changes the reply without a deploy');

  -- ของเสียในฐานต้องไม่ทำให้ข้อความลูกค้าหาย (ทริกเกอร์กลืน error ของตัวเอง)
  UPDATE inbox.bot_config SET value = '"ไม่ใช่ออบเจกต์"'::jsonb
   WHERE inbox_id = v_inbox AND key = 'line.follow_welcome_flex';
  INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
  VALUES (v_conv, 'system', '[ลูกค้าเพิ่มเพื่อน]', 'follow', 'follow') RETURNING id INTO v_follow;
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.message WHERE id = v_follow) = 1,
    'a broken template never costs us the inbound follow event');

  -- ── postback ถูกส่งต่อให้ CRM ผ่าน outbox เดิม ──────────────────────
  INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
  VALUES (v_conv, 'contact', '[กดปุ่ม] asher:v1:interest=vibe', 'postback', 'postback')
  RETURNING id INTO v_pb;

  SELECT payload INTO r FROM inbox.crm_publish_outbox
   WHERE event_id = inbox.crm_event_id(v_pb, 'channel_identity.postback');
  PERFORM pg_temp.check(r IS NOT NULL, 'postback published to the existing outbox');
  PERFORM pg_temp.check(r->>'postback_data' = 'asher:v1:interest=vibe', 'prefix stripped, data intact');
  PERFORM pg_temp.check(r->>'raw_content' = '[กดปุ่ม] asher:v1:interest=vibe', 'raw content kept too');
  PERFORM pg_temp.check(r->>'external_id' = 'UWELCOMETEST', 'carries the channel identity');
  PERFORM pg_temp.check((r->>'contact_ref')::uuid = v_contact, 'carries contact_ref for CRM');
  PERFORM pg_temp.check(r->>'provider' = 'line', 'carries the provider');

  -- ★ ของเดิมต้องไม่ถูกกลืน: message.received ของ postback เดียวกันต้องยังอยู่
  --   (เคสที่ทำให้ event หายไปเงียบ ๆ ก่อนแก้ inbox.crm_event_id)
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox WHERE event_id = v_pb
      AND event_type = 'message.received') = 1,
    'the original message.received row is still there');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox
      WHERE aggregate_id LIKE '%' AND event_id IN (
        v_pb, inbox.crm_event_id(v_pb, 'channel_identity.postback'))) = 2,
    'both events for one message coexist');

  -- ยิงซ้ำ event เดิมไม่เกิดแถวที่สอง
  PERFORM inbox.broadcast_emit(inbox.crm_event_id(v_pb, 'channel_identity.postback'),
    'channel_identity.postback', 'channel_identity', 'x', now(), '{}'::jsonb);
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox
      WHERE event_id = inbox.crm_event_id(v_pb, 'channel_identity.postback')) = 1,
    'the outbox de-duplicates by event id');

  -- ★ BOUNDARIES: Connect ต้องไม่สร้าง lead และไม่ติด tag ให้ใครเอง
  --   (ข้ามถ้าฐานยังไม่มีตาราง tag — ฐาน dev บางเครื่องยังไม่ลง 202610011000)
  IF to_regclass('connect_private.contact_tag') IS NOT NULL THEN
    EXECUTE 'select count(*) from connect_private.contact_tag where contact_id = $1'
      INTO v_n USING v_contact;
    PERFORM pg_temp.check(v_n = 0, 'Connect tagged nobody -- that decision belongs to CRM');
  END IF;


  -- postback ของฝั่งเรา (echo/agent) ต้องไม่ถูกส่งเป็น event ของลูกค้า
  INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
  VALUES (v_conv, 'bot', '[กดปุ่ม] ของเราเอง', 'postback', 'postback') RETURNING id INTO v_pb;
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox
      WHERE event_id = inbox.crm_event_id(v_pb, 'channel_identity.postback')) = 0,
    'only a contact postback is published');

  -- ข้อความธรรมดาไม่ถูกส่งเป็น postback event
  INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
  VALUES (v_conv, 'contact', 'สนใจห้อง 2 นอนครับ', 'text', 'message') RETURNING id INTO v_pb;
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox
      WHERE event_id = inbox.crm_event_id(v_pb, 'channel_identity.postback')) = 0,
    'a plain message is not a postback');
END
$test$;
`

test('follow welcome flex + postback publishing', { skip: SKIP && SKIP_WHY }, () => {
  const output = runSql(`BEGIN;\n${migration}\n${assertions}\nROLLBACK;\n`)
  assert.equal(output.trim(), '')
})
