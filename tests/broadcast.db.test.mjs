/**
 * ตัวส่ง LINE หลายคน — ฝั่งฐาน (sql/202610021200_line_broadcast.sql)
 *
 *   ALLOW_DB_TESTS=1 node --test tests/broadcast.db.test.mjs
 *   ALLOW_DB_TESTS=1 DB_TEST_URL=postgres://... node --test tests/broadcast.db.test.mjs
 *
 * ★ รัน migration + assertion ใน transaction เดียวแล้ว ROLLBACK (แบบ star-follow-tags.db.test.mjs)
 *   ต้องมีฐานที่มี schema จริง จึงล็อกไว้ด้วย ALLOW_DB_TESTS=1
 * ★ เทสต์นี้ไม่ยิง LINE เลย — ตรวจเฉพาะสิ่งที่ฐานรับผิดชอบ: idempotency, การแบ่ง batch,
 *   retry key คงที่, ไม่ส่ง batch ที่ sent แล้วซ้ำ, การตัดคน unfollow, และสิทธิ์
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'ต้องมีฐาน supabase จริง — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const strip = name => readFileSync(new URL(`../sql/${name}`, import.meta.url), 'utf8')
  // ไฟล์ migration มี begin/commit ของตัวเอง — ตัดออกให้อยู่ใน transaction ของเทสต์ที่ ROLLBACK
  .replace(/^begin;\s*$/gm, '').replace(/^commit;\s*$/gm, '')

// ★ ลง 202609211300 ให้ด้วย: ไฟล์นี้ ALTER check constraint ของ inbox.crm_publish_outbox
//   ที่ไฟล์นั้นสร้าง ฐาน dev ที่ยังไม่มีตารางจะล้มด้วย "relation does not exist"
//   ซึ่งถูกแล้วตามลำดับใน ORDER.txt — เทสต์จึงลงเองทั้งคู่เพื่อยืนที่ไหนก็ได้
const migration = strip('202609211300_crm_publisher.sql') + '\n' + strip('202610021200_line_broadcast.sql')

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

-- ผู้รับ n คน เป็น jsonb ให้ broadcast_enqueue
create function pg_temp.people(n int) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'external_user_id', 'U' || lpad(g::text, 6, '0'),
           'contact_ref', 'ref-' || g)), '[]'::jsonb)
    from generate_series(1, n) g
$$;

DO $test$
DECLARE
  v_inbox uuid; v_msgs jsonb := '[{"type":"text","text":"hello"}]'::jsonb;
  r jsonb; r2 jsonb; b jsonb; v_job uuid; v_job2 uuid; v_key1 uuid; v_key2 uuid;
  v_n int; v_status text;
BEGIN
  SELECT id INTO v_inbox FROM inbox.inbox WHERE is_active ORDER BY created_at LIMIT 1;
  IF v_inbox IS NULL THEN RAISE EXCEPTION 'broadcast_fixture_missing'; END IF;

  -- ── การแบ่ง batch: 1 / 500 / 501 / 1234 ─────────────────────────────
  FOR v_n IN SELECT * FROM (VALUES (1),(500),(501),(1234)) v(n) LOOP
    r := inbox.broadcast_enqueue(jsonb_build_object(
           'idempotency_key', 'batch-' || v_n, 'inbox_id', v_inbox, 'channel_key', 'k',
           'messages', v_msgs, 'batch_size', 500, 'recipients', pg_temp.people(v_n)));
    v_job := (r->>'job_id')::uuid;
    PERFORM pg_temp.check((r->>'accepted')::int = v_n, 'accepted = ' || v_n);
    PERFORM pg_temp.check(
      (SELECT count(*) FROM connect_private.broadcast_batch WHERE job_id = v_job) = ceil(v_n / 500.0),
      'batch count for ' || v_n);
    -- ทุกคนต้องอยู่ใน batch ใดบ้าง ไม่มีใครตกหล่น ไม่มีใครอยู่สอง batch
    PERFORM pg_temp.check(
      (SELECT count(*) FROM connect_private.broadcast_recipient
        WHERE job_id = v_job AND batch_no IS NOT NULL) = v_n, 'all recipients assigned for ' || v_n);
    PERFORM pg_temp.check(
      (SELECT max(c) FROM (SELECT count(*) c FROM connect_private.broadcast_recipient
        WHERE job_id = v_job GROUP BY batch_no) s) <= 500, 'no batch over 500 for ' || v_n);
  END LOOP;

  -- ── 0 คน: ไม่สร้าง batch และจบงานทันที ──────────────────────────────
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'empty', 'inbox_id', v_inbox, 'channel_key', 'k',
         'messages', v_msgs, 'recipients', '[]'::jsonb));
  v_job := (r->>'job_id')::uuid;
  PERFORM pg_temp.check((r->>'accepted')::int = 0, 'zero recipients accepted 0');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM connect_private.broadcast_batch WHERE job_id = v_job) = 0, 'no batch for 0');
  PERFORM pg_temp.check(
    (SELECT status FROM connect_private.broadcast_job WHERE id = v_job) = 'sent', 'empty job finishes');

  -- ── idempotency: คีย์ซ้ำคืนงานเดิม ไม่สร้างใหม่ ─────────────────────
  r  := inbox.broadcast_enqueue(jsonb_build_object(
          'idempotency_key', 'idem-1', 'inbox_id', v_inbox, 'channel_key', 'k',
          'messages', v_msgs, 'recipients', pg_temp.people(3)));
  r2 := inbox.broadcast_enqueue(jsonb_build_object(
          'idempotency_key', 'idem-1', 'inbox_id', v_inbox, 'channel_key', 'k',
          'messages', v_msgs, 'recipients', pg_temp.people(9)));
  PERFORM pg_temp.check(r->>'job_id' = r2->>'job_id', 'same key returns same job');
  PERFORM pg_temp.check((r2->>'reused')::boolean, 'duplicate key marked reused');
  PERFORM pg_temp.check((r2->>'accepted')::int = 3, 'duplicate key does not add recipients');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM connect_private.broadcast_job WHERE idempotency_key = 'idem-1') = 1,
    'only one job row per key');

  -- ── ผู้รับซ้ำในคำขอเดียว: ตัดเหลือหนึ่ง ────────────────────────────
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'dupes', 'inbox_id', v_inbox, 'channel_key', 'k', 'messages', v_msgs,
         'recipients', '[{"external_user_id":"UX"},{"external_user_id":"UX"},{"external_user_id":"UY"}]'::jsonb));
  PERFORM pg_temp.check((r->>'accepted')::int = 2, 'duplicate recipients collapsed');

  -- ── คนที่ unfollow แล้ว ต้องกลายเป็น skipped ไม่ใช่ queued ──────────
  INSERT INTO connect_private.channel_follow(inbox_id, external_user_id, channel, following)
  VALUES (v_inbox, 'UBLOCKED', 'line', false), (v_inbox, 'UOK', 'line', true);
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'skip-1', 'inbox_id', v_inbox, 'channel_key', 'k', 'messages', v_msgs,
         'recipients', '[{"external_user_id":"UBLOCKED"},{"external_user_id":"UOK"},{"external_user_id":"UNEW"}]'::jsonb));
  v_job := (r->>'job_id')::uuid;
  -- UNEW ไม่มีแถวใน channel_follow = ยังไม่เคยเห็น event → ส่งได้ ไม่ใช่ตัดทิ้ง
  PERFORM pg_temp.check((r->>'accepted')::int = 2, 'unknown follow state is sendable');
  PERFORM pg_temp.check(jsonb_array_length(r->'skipped') = 1, 'one skipped');
  PERFORM pg_temp.check(r->'skipped'->0->>'id' = 'UBLOCKED', 'the unfollowed one is skipped');
  PERFORM pg_temp.check(r->'skipped'->0->>'reason' = 'unfollowed', 'skip reason recorded');
  PERFORM pg_temp.check(
    (SELECT skipped_count FROM connect_private.broadcast_job WHERE id = v_job) = 1, 'skipped_count');

  -- ── crash หลัง batch 2: รันใหม่ไม่ส่งซ้ำ และ batch 3 ใช้ retry key เดิม ──
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'crash-1', 'inbox_id', v_inbox, 'channel_key', 'k',
         'messages', v_msgs, 'batch_size', 500, 'recipients', pg_temp.people(1234)));
  v_job := (r->>'job_id')::uuid;
  PERFORM inbox.broadcast_job_start(jsonb_build_object('job_id', v_job));

  SELECT retry_key INTO v_key1 FROM connect_private.broadcast_batch WHERE job_id = v_job AND batch_no = 1;
  SELECT retry_key INTO v_key2 FROM connect_private.broadcast_batch WHERE job_id = v_job AND batch_no = 3;

  b := inbox.broadcast_claim_batch('{}');
  PERFORM pg_temp.check((b->>'job_id')::uuid = v_job AND (b->>'batch_no')::int = 1, 'claims batch 1 first');
  PERFORM pg_temp.check((b->>'retry_key')::uuid = v_key1, 'claim carries the stored retry key');
  PERFORM pg_temp.check(jsonb_array_length(b->'recipients') = 500, 'batch 1 has 500 ids');
  PERFORM inbox.broadcast_batch_finish(jsonb_build_object(
    'job_id', v_job, 'batch_no', 1, 'outcome', 'sent', 'http_status', 200, 'line_request_id', 'req-1'));

  b := inbox.broadcast_claim_batch('{}');
  PERFORM pg_temp.check((b->>'batch_no')::int = 2, 'claims batch 2 next');
  PERFORM inbox.broadcast_batch_finish(jsonb_build_object(
    'job_id', v_job, 'batch_no', 2, 'outcome', 'sent', 'http_status', 200));

  -- ★ "crash" = ไม่มีใครเรียก finish ของ batch 3 — lease หมดแล้วหยิบใหม่
  b := inbox.broadcast_claim_batch('{}');
  PERFORM pg_temp.check((b->>'batch_no')::int = 3, 'batch 3 is next, never 1 or 2 again');
  UPDATE connect_private.broadcast_batch SET lease_until = now() - interval '1 minute'
   WHERE job_id = v_job AND batch_no = 3;
  b := inbox.broadcast_claim_batch('{}');
  PERFORM pg_temp.check((b->>'batch_no')::int = 3, 'expired lease re-claims the same batch');
  PERFORM pg_temp.check((b->>'retry_key')::uuid = v_key2, 'retry key unchanged across attempts');
  PERFORM pg_temp.check((b->>'attempts')::int = 2, 'attempts counted');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM connect_private.broadcast_batch
      WHERE job_id = v_job AND status = 'sent') = 2, 'batches 1-2 stay sent');

  PERFORM inbox.broadcast_batch_finish(jsonb_build_object(
    'job_id', v_job, 'batch_no', 3, 'outcome', 'sent', 'http_status', 200));
  r := inbox.broadcast_status(jsonb_build_object('job_id', v_job));
  PERFORM pg_temp.check(r->>'status' = 'sent', 'all batches sent -> job sent');
  PERFORM pg_temp.check((r->>'sent_count')::int = 1234, 'sent_count counts everyone');

  -- ── retry ไม่จบ batch และเลื่อนเวลา ────────────────────────────────
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'retry-1', 'inbox_id', v_inbox, 'channel_key', 'k',
         'messages', v_msgs, 'recipients', pg_temp.people(2)));
  v_job := (r->>'job_id')::uuid;
  PERFORM inbox.broadcast_job_start(jsonb_build_object('job_id', v_job));
  b := inbox.broadcast_claim_batch('{}');
  SELECT retry_key INTO v_key1 FROM connect_private.broadcast_batch WHERE job_id = v_job AND batch_no = 1;
  PERFORM inbox.broadcast_batch_finish(jsonb_build_object(
    'job_id', v_job, 'batch_no', 1, 'outcome', 'retry', 'http_status', 429, 'backoff_seconds', 300));
  PERFORM pg_temp.check(
    (SELECT status = 'queued' AND next_attempt_at > now() + interval '4 minutes'
       FROM connect_private.broadcast_batch WHERE job_id = v_job AND batch_no = 1), 'retry reschedules');
  PERFORM pg_temp.check(
    (SELECT retry_key FROM connect_private.broadcast_batch WHERE job_id = v_job AND batch_no = 1) = v_key1,
    'retry keeps the key');
  -- ยังไม่ถึงเวลา = claim ไม่เจอ (งานอื่นในเทสต์นี้จบไปหมดแล้ว)
  PERFORM pg_temp.check(inbox.broadcast_claim_batch('{}') IS NULL, 'backoff respected by claim');
  PERFORM pg_temp.check(
    (SELECT status FROM connect_private.broadcast_job WHERE id = v_job) = 'sending', 'job still sending');

  -- ── 400 = failed · งานที่ล้มบางส่วนเป็น partially_failed ──────────────
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'partial-1', 'inbox_id', v_inbox, 'channel_key', 'k',
         'messages', v_msgs, 'batch_size', 500, 'recipients', pg_temp.people(600)));
  v_job2 := (r->>'job_id')::uuid;
  PERFORM inbox.broadcast_job_start(jsonb_build_object('job_id', v_job2));
  PERFORM inbox.broadcast_batch_finish(jsonb_build_object(
    'job_id', v_job2, 'batch_no', 1, 'outcome', 'sent', 'http_status', 200));
  r := inbox.broadcast_batch_finish(jsonb_build_object(
    'job_id', v_job2, 'batch_no', 2, 'outcome', 'failed', 'http_status', 400, 'error', 'line_http_400'));
  PERFORM pg_temp.check(r->>'status' = 'partially_failed', 'one failed batch -> partially_failed');
  r := inbox.broadcast_status(jsonb_build_object('job_id', v_job2));
  PERFORM pg_temp.check((r->>'sent_count')::int = 500 AND (r->>'failed_count')::int = 100, 'counts split');

  -- ── โควตาไม่พอ: ล้มทั้งงาน ไม่มีใครถูกส่ง ───────────────────────────
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'quota-1', 'inbox_id', v_inbox, 'channel_key', 'k',
         'messages', v_msgs, 'recipients', pg_temp.people(10)));
  v_job := (r->>'job_id')::uuid;
  PERFORM inbox.broadcast_job_fail(jsonb_build_object('job_id', v_job, 'reason', 'quota_exceeded'));
  r := inbox.broadcast_status(jsonb_build_object('job_id', v_job));
  PERFORM pg_temp.check(r->>'status' = 'failed' AND r->>'fail_reason' = 'quota_exceeded', 'quota fails job');
  PERFORM pg_temp.check((r->>'sent_count')::int = 0, 'quota failure sends to nobody');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM connect_private.broadcast_batch
      WHERE job_id = v_job AND status <> 'cancelled') = 0, 'all batches cancelled');
  -- งานที่ล้มแล้วต้องไม่ถูก claim อีก
  PERFORM pg_temp.check(
    NOT EXISTS (SELECT 1 FROM connect_private.broadcast_batch b
                 JOIN connect_private.broadcast_job j ON j.id = b.job_id
                WHERE b.job_id = v_job AND j.status = 'sending'), 'failed job not claimable');

  -- ── cancel: ยกเลิกได้เฉพาะที่ยังไม่ส่ง ──────────────────────────────
  r := inbox.broadcast_enqueue(jsonb_build_object(
         'idempotency_key', 'cancel-1', 'inbox_id', v_inbox, 'channel_key', 'k',
         'messages', v_msgs, 'batch_size', 500, 'recipients', pg_temp.people(1100)));
  v_job := (r->>'job_id')::uuid;
  PERFORM inbox.broadcast_job_start(jsonb_build_object('job_id', v_job));
  PERFORM inbox.broadcast_batch_finish(jsonb_build_object(
    'job_id', v_job, 'batch_no', 1, 'outcome', 'sent', 'http_status', 200));
  r := inbox.broadcast_cancel(jsonb_build_object('job_id', v_job));
  PERFORM pg_temp.check((r->>'cancelled_batches')::int = 2, 'two unsent batches cancelled');
  PERFORM pg_temp.check(
    (SELECT status FROM connect_private.broadcast_batch WHERE job_id = v_job AND batch_no = 1) = 'sent',
    'cancel never un-sends a sent batch');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM connect_private.broadcast_recipient
      WHERE job_id = v_job AND status = 'sent') = 500, 'sent recipients kept');

  -- ── event เข้า outbox เดิม (ไม่ใช่ตารางใหม่) และไม่ซ้ำเมื่อเรียกซ้ำ ──
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox
      WHERE event_type = 'broadcast.completed' AND aggregate_id = v_job2::text) = 1,
    'one completed event per job');
  PERFORM inbox.broadcast_complete(jsonb_build_object('job_id', v_job2));
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox
      WHERE event_type = 'broadcast.completed' AND aggregate_id = v_job2::text) = 1,
    'calling complete twice does not duplicate the event');
  PERFORM pg_temp.check(
    (SELECT count(*) FROM inbox.crm_publish_outbox
      WHERE event_type = 'broadcast.batch_result' AND aggregate_id = v_job2::text) = 2,
    'one batch_result per batch');

  -- ── สถานะ follow: ทริกเกอร์เขียนแถว + ส่ง event ─────────────────────
  DECLARE
    v_contact uuid; v_conv uuid; v_msg uuid; v_chan text;
  BEGIN
    SELECT channel INTO v_chan FROM inbox.inbox WHERE id = v_inbox;
    v_contact := core.resolve_identity(v_chan, 'UFOLLOWTEST', v_inbox::text, 'ทดสอบ follow', NULL);
    INSERT INTO inbox.conversation(inbox_id, contact_id) VALUES (v_inbox, v_contact) RETURNING id INTO v_conv;

    INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
    VALUES (v_conv, 'system', '[ลูกค้าเพิ่มเพื่อน]', 'follow', 'follow') RETURNING id INTO v_msg;
    PERFORM pg_temp.check(
      (SELECT following FROM connect_private.channel_follow
        WHERE inbox_id = v_inbox AND external_user_id = 'UFOLLOWTEST'), 'follow recorded');
    PERFORM pg_temp.check(
      (SELECT count(*) FROM inbox.crm_publish_outbox
        WHERE event_id = inbox.crm_event_id(v_msg, 'channel_identity.follow_changed')) = 1,
      'follow_changed published to the existing outbox');
    -- ★ follow/unfollow เป็น message ของ 'system' ซึ่ง trg_crm_publish_message
    --   ข้ามอยู่แล้ว (guard sender_type not in contact/agent/bot) จึงไม่เคยชนกัน
    --   ตัวที่ชนจริงคือ postback ของลูกค้า — ดู tests/follow-welcome.db.test.mjs
    PERFORM pg_temp.check(
      (SELECT count(*) FROM inbox.crm_publish_outbox WHERE event_id = v_msg) = 0,
      'the existing publisher skips system messages, so nothing claimed that id');

    INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
    VALUES (v_conv, 'system', '[ลูกค้าบล็อกบัญชี]', 'unfollow', 'unfollow');
    PERFORM pg_temp.check(
      NOT (SELECT following FROM connect_private.channel_follow
            WHERE inbox_id = v_inbox AND external_user_id = 'UFOLLOWTEST'), 'unfollow flips the flag');

    -- ข้อความธรรมดาไม่แตะสถานะ follow
    INSERT INTO inbox.message(conversation_id, sender_type, content, content_type, event_type)
    VALUES (v_conv, 'contact', 'สนใจห้องครับ', 'text', 'message');
    PERFORM pg_temp.check(
      NOT (SELECT following FROM connect_private.channel_follow
            WHERE inbox_id = v_inbox AND external_user_id = 'UFOLLOWTEST'), 'plain message leaves it alone');

    -- คนที่ unfollow แล้วถูกตัดออกจาก broadcast โดยอัตโนมัติ
    r := inbox.broadcast_enqueue(jsonb_build_object(
           'idempotency_key', 'follow-skip', 'inbox_id', v_inbox, 'channel_key', 'k', 'messages', v_msgs,
           'recipients', '[{"external_user_id":"UFOLLOWTEST"}]'::jsonb));
    PERFORM pg_temp.check((r->>'accepted')::int = 0, 'unfollowed contact is not sent to');
  END;

  -- ── สิทธิ์: พนักงานที่ล็อกอิน (authenticated) เรียกไม่ได้เลย ─────────
  -- ทางเข้าคือ /internal/* ด้วย CONNECT_SERVICE_TOKEN เท่านั้น (BOUNDARIES)
  PERFORM pg_temp.check(
    NOT has_function_privilege('authenticated', 'inbox.broadcast_enqueue(jsonb)', 'execute'),
    'authenticated cannot enqueue a broadcast');
  PERFORM pg_temp.check(
    NOT has_function_privilege('authenticated', 'inbox.broadcast_claim_batch(jsonb)', 'execute'),
    'authenticated cannot claim batches');
  PERFORM pg_temp.check(
    NOT has_function_privilege('authenticated', 'inbox.broadcast_recent_messages(jsonb)', 'execute'),
    'authenticated cannot read messages through the service door');
  PERFORM pg_temp.check(
    NOT has_function_privilege('anon', 'inbox.broadcast_status(jsonb)', 'execute'),
    'anon cannot read broadcast status');
  PERFORM pg_temp.check(
    has_function_privilege('service_role', 'inbox.broadcast_enqueue(jsonb)', 'execute'),
    'service_role can enqueue');
END
$test$;
`

test('broadcast job / batch / recipient contract', { skip: SKIP && SKIP_WHY }, () => {
  const output = runSql(`BEGIN;\n${migration}\n${assertions}\nROLLBACK;\n`)
  assert.equal(output.trim(), '')
})
