/**
 * หน้า "รายชื่อติดต่อ" (sql/202610021000_contacts_page.sql)
 *
 *   ALLOW_DB_TESTS=1 node --test tests/contacts-page.db.test.mjs
 *   ALLOW_DB_TESTS=1 DB_TEST_URL=postgres://... node --test tests/contacts-page.db.test.mjs
 *
 * ★ ลง migration ทั้งสองไฟล์ + assertion ใน transaction เดียวแล้ว ROLLBACK — ไม่มีอะไรค้าง
 *   ต้องมีบัญชีพนักงานใน core.profile อย่างน้อย 2 คน และ inbox ที่ active อย่างน้อย 1 ตัว
 * ★ SLA ในเทสต์นี้ให้ฐานคำนวณเองจากข้อความที่ใส่เข้าไป (inbox.case_status) ไม่ได้ปลอมค่า
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'ต้องมีฐาน supabase จริง — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const strip = (f) => readFileSync(new URL('../sql/' + f, import.meta.url), 'utf8')
  .replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '')
const migrations = strip('202610011000_contact_star_tags.sql') + '\n' + strip('202610021000_contacts_page.sql')

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
create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
end $$;
create function pg_temp.row_of(r jsonb, p_contact uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(r) x where x->>'contact_id' = p_contact::text $$;

DO $test$
DECLARE
  v_inbox uuid; v_inbox2 uuid; v_sales uuid; v_mgr uuid;
  k_multi uuid; k_late uuid; k_near uuid; k_book uuid;
  c_old uuid; c_new uuid; c_late uuid; c_near uuid; c_book uuid;
  r jsonb; x jsonb; v_blocked boolean; v_lead uuid; v_stage uuid; v_before timestamptz;
BEGIN
  SELECT id INTO v_inbox FROM inbox.inbox WHERE is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_inbox2 FROM inbox.inbox WHERE is_active AND id <> v_inbox ORDER BY created_at LIMIT 1;
  v_inbox2 := coalesce(v_inbox2, v_inbox);
  SELECT user_id INTO v_sales FROM core.profile WHERE is_active AND role IN ('sales','senior_sales','manager','admin') ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_mgr FROM core.profile WHERE is_active AND role IN ('sales','senior_sales','manager','admin') AND user_id <> v_sales ORDER BY user_id LIMIT 1;
  IF v_inbox IS NULL OR v_sales IS NULL OR v_mgr IS NULL THEN RAISE EXCEPTION 'contacts_fixture_missing'; END IF;
  UPDATE core.profile SET role = 'sales', test_only = false WHERE user_id = v_sales;
  UPDATE core.profile SET role = 'manager', test_only = false WHERE user_id = v_mgr;

  -- ลูกค้าคนเดียวสองช่องทาง · ยังไม่มีใครตอบ → ใหม่
  INSERT INTO core.contact(display_name, phone) VALUES ('__ct_multi__', '081-234-5678') RETURNING id INTO k_multi;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode, last_message_at) VALUES (v_inbox, k_multi, 'open', 'human', now() - interval '3 hours') RETURNING id INTO c_old;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode, last_message_at) VALUES (v_inbox2, k_multi, 'open', 'human', now() - interval '1 hours') RETURNING id INTO c_new;
  -- รอเกิน SLA: ข้อความลูกค้าเมื่อ 30 นาทีที่แล้ว ไม่มีคำตอบ
  INSERT INTO core.contact(display_name) VALUES ('__ct_late__') RETURNING id INTO k_late;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode, last_message_at) VALUES (v_inbox, k_late, 'open', 'human', now() - interval '30 minutes') RETURNING id INTO c_late;
  INSERT INTO inbox.message(conversation_id, sender_type, content, created_at) VALUES (c_late, 'contact', 'สนใจครับ', now() - interval '30 minutes');
  -- ใกล้เกิน: รอมา 6 นาที (sla 10)
  INSERT INTO core.contact(display_name) VALUES ('__ct_near__') RETURNING id INTO k_near;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode, last_message_at) VALUES (v_inbox, k_near, 'open', 'human', now() - interval '6 minutes') RETURNING id INTO c_near;
  INSERT INTO inbox.message(conversation_id, sender_type, content, created_at) VALUES (c_near, 'contact', 'ราคาเท่าไหร่', now() - interval '6 minutes 30 seconds');
  -- จองแล้ว + มีคนตอบแล้ว + มีเจ้าของ
  INSERT INTO core.contact(display_name) VALUES ('__ct_book__') RETURNING id INTO k_book;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode, assignee_id, last_message_at, last_human_reply_at)
    VALUES (v_inbox, k_book, 'open', 'human', v_sales, now() - interval '2 hours', now() - interval '2 hours') RETURNING id INTO c_book;
  SELECT id INTO v_stage FROM crm.stage WHERE code = 'booking' LIMIT 1;
  IF v_stage IS NOT NULL THEN
    INSERT INTO crm.lead(stage_id) VALUES (v_stage) RETURNING id INTO v_lead;
    INSERT INTO connect_private.case_state(conversation_id, lead_id) VALUES (c_book, v_lead)
      ON CONFLICT (conversation_id) DO UPDATE SET lead_id = excluded.lead_id;
  END IF;
  SELECT max(created_at) INTO v_before FROM inbox.message WHERE conversation_id IN (c_late, c_near);

  -- ── sales ──
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  r := inbox.contacts_list('{"search":"__ct_"}');
  RESET ROLE;
  PERFORM pg_temp.check(jsonb_array_length(r) = 4, 'one row per contact, not per conversation');
  x := pg_temp.row_of(r, k_multi);
  PERFORM pg_temp.check((x->>'conversation_id')::uuid = c_new, 'row points at the latest conversation');
  PERFORM pg_temp.check(x->>'phone' = '***-***-5678', 'sales sees a masked phone');
  PERFORM pg_temp.check(x->>'stage' = 'new', 'no human reply yet = new');
  PERFORM pg_temp.check(pg_temp.row_of(r, k_late)->>'sla' = 'over', 'customer waiting 30 min = over SLA');
  PERFORM pg_temp.check(pg_temp.row_of(r, k_near)->>'sla' = 'near', 'waiting 6 of 10 min = near SLA');
  PERFORM pg_temp.check(pg_temp.row_of(r, k_book)->>'sla' = 'ok', 'nobody waiting = ok');
  IF v_stage IS NOT NULL THEN
    PERFORM pg_temp.check(pg_temp.row_of(r, k_book)->>'stage' = 'booking', 'crm stage booking = booking');
  END IF;
  PERFORM pg_temp.check(r->0->>'contact_id' = k_near::text, 'default sort = latest chat first');

  SET LOCAL ROLE authenticated;
  r := inbox.contacts_list('{"search":"__ct_","sort":"asc"}');
  PERFORM pg_temp.check(r->0->>'contact_id' = k_book::text, 'sort asc = oldest latest-chat first (multi-channel uses its newest chat)');
  r := inbox.contacts_list('{"search":"__ct_","sla":"over"}');
  PERFORM pg_temp.check(jsonb_array_length(r) = 1 AND r->0->>'contact_id' = k_late::text, 'filter by SLA');
  r := inbox.contacts_list('{"search":"__ct_","stage":"new"}');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r) e WHERE e->>'contact_id' = k_book::text), 'filter by stage');
  r := inbox.contacts_list(jsonb_build_object('search', '__ct_', 'assignee', v_sales));
  PERFORM pg_temp.check(jsonb_array_length(r) = 1 AND r->0->>'contact_id' = k_book::text, 'filter by assignee');
  r := inbox.contacts_list('{"search":"__ct_","assignee":"none"}');
  PERFORM pg_temp.check(jsonb_array_length(r) = 3, 'filter unassigned');
  r := inbox.case_star(jsonb_build_object('conversation_id', c_late, 'starred', true));
  r := inbox.contacts_list('{"search":"__ct_","starred":true}');
  PERFORM pg_temp.check(jsonb_array_length(r) = 1 AND r->0->>'contact_id' = k_late::text, 'filter starred');
  r := inbox.contact_detail(jsonb_build_object('conversation_id', c_old));
  RESET ROLE;
  PERFORM pg_temp.check(jsonb_array_length(r->'conversations') = 2, 'drawer lists every channel of the contact');
  PERFORM pg_temp.check(r->>'phone' = '***-***-5678' AND (r->>'phone_masked')::boolean, 'drawer masks phone for sales');

  -- ── manager เห็นเบอร์เต็ม ──
  PERFORM pg_temp.act_as(v_mgr);
  SET LOCAL ROLE authenticated;
  r := inbox.contacts_list('{"search":"__ct_multi"}');
  RESET ROLE;
  PERFORM pg_temp.check(r->0->>'phone' = '081-234-5678', 'manager sees the full phone');

  -- ── reviewer เห็นเฉพาะแชททดสอบ ──
  UPDATE core.profile SET test_only = true WHERE user_id = v_sales;
  UPDATE inbox.conversation SET is_test = true WHERE id = c_near;
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  r := inbox.contacts_list('{"search":"__ct_"}');
  v_blocked := false;
  BEGIN PERFORM inbox.contact_detail(jsonb_build_object('conversation_id', c_late));
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  PERFORM pg_temp.check(jsonb_array_length(r) = 1 AND r->0->>'contact_id' = k_near::text, 'reviewer sees test chats only');
  PERFORM pg_temp.check(v_blocked, 'reviewer cannot open a real customer');
  PERFORM pg_temp.check(r->0->>'phone' IS NULL OR r->0->>'phone' LIKE '***%', 'reviewer never gets a full phone');

  -- ── คนนอก ──
  PERFORM pg_temp.act_as(gen_random_uuid());
  SET LOCAL ROLE authenticated;
  v_blocked := false;
  BEGIN PERFORM inbox.contacts_list('{}'); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'non-staff cannot list contacts');

  -- ── เวลาข้อความไม่ถูกแตะ ──
  PERFORM pg_temp.check((SELECT max(created_at) FROM inbox.message WHERE conversation_id IN (c_late, c_near)) = v_before,
                        'message timestamps unchanged');
  PERFORM pg_temp.check(NOT has_function_privilege('authenticated', 'inbox.contact_phone_out(text,jsonb)', 'execute'),
                        'phone helper not exposed');
END
$test$;
`

test('contacts page contract', { skip: SKIP && SKIP_WHY }, () => {
  const output = runSql(`BEGIN;\n${migrations}\n${assertions}\nROLLBACK;\n`)
  assert.equal(output.trim(), '')
})
