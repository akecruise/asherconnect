/**
 * ติดดาว · การติดตาม · Tag (sql/202610011000_contact_star_tags.sql)
 *
 *   ALLOW_DB_TESTS=1 node --test tests/star-follow-tags.db.test.mjs
 *   ALLOW_DB_TESTS=1 DB_TEST_URL=postgres://... node --test tests/star-follow-tags.db.test.mjs
 *
 * ★ รันทั้ง migration + assertion ใน transaction เดียวแล้ว ROLLBACK — ไม่มีอะไรค้างในฐาน
 *   (แบบเดียวกับ first-responder-case-owner.db.test.mjs) แต่ยังต้องการฐานที่มี schema จริง
 *   และบัญชีพนักงานใน core.profile อย่างน้อย 2 คน จึงล็อกไว้ด้วย ALLOW_DB_TESTS=1
 * ★ ค่าเริ่มต้นยิงเข้า docker container supabase-db · ตั้ง DB_TEST_URL เพื่อยิงฐานอื่นผ่าน psql
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'ต้องมีฐาน supabase จริง — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const migration = readFileSync(new URL('../sql/202610011000_contact_star_tags.sql', import.meta.url), 'utf8')
  // ไฟล์ migration มี begin/commit ของตัวเอง — ตัดออกให้อยู่ใน transaction ของเทสต์ที่ ROLLBACK
  .replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '')

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

DO $test$
DECLARE
  v_inbox uuid; v_inbox2 uuid; v_sales uuid; v_other uuid; v_contact uuid; v_contact2 uuid;
  v_line uuid; v_fb uuid; v_real uuid; v_tag uuid; v_tag2 uuid; r jsonb; v_ver int; v_blocked boolean;
  v_lead uuid;
BEGIN
  SELECT id INTO v_inbox FROM inbox.inbox WHERE is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_inbox2 FROM inbox.inbox WHERE is_active AND id <> v_inbox ORDER BY created_at LIMIT 1;
  v_inbox2 := coalesce(v_inbox2, v_inbox);
  SELECT user_id INTO v_sales FROM core.profile
   WHERE is_active AND role IN ('sales','senior_sales','manager','admin') ORDER BY user_id LIMIT 1;
  SELECT user_id INTO v_other FROM core.profile
   WHERE is_active AND role IN ('sales','senior_sales','manager','admin') AND user_id <> v_sales ORDER BY user_id LIMIT 1;
  IF v_inbox IS NULL OR v_sales IS NULL OR v_other IS NULL THEN RAISE EXCEPTION 'star_tags_fixture_missing'; END IF;
  -- ทั้งหมดถูก ROLLBACK ท้ายไฟล์ — แก้ role/test_only ชั่วคราวได้
  UPDATE core.profile SET role = 'sales', test_only = false WHERE user_id = v_sales;
  UPDATE core.profile SET role = 'manager', test_only = false WHERE user_id = v_other;

  -- ลูกค้าคนเดียวทักมาสองช่องทาง (unified identity = contact เดียว สอง conversation)
  INSERT INTO core.contact(display_name) VALUES ('__star_tags_test__') RETURNING id INTO v_contact;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode) VALUES (v_inbox, v_contact, 'open', 'human') RETURNING id INTO v_line;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode) VALUES (v_inbox2, v_contact, 'open', 'human') RETURNING id INTO v_fb;
  INSERT INTO core.contact(display_name) VALUES ('__star_tags_real__') RETURNING id INTO v_contact2;
  INSERT INTO inbox.conversation(inbox_id, contact_id, status, mode, is_test) VALUES (v_inbox, v_contact2, 'open', 'human', false) RETURNING id INTO v_real;
  UPDATE inbox.conversation SET is_test = true WHERE id IN (v_line, v_fb);
  INSERT INTO connect_private.case_state(conversation_id) VALUES (v_line), (v_fb), (v_real) ON CONFLICT DO NOTHING;

  -- ── ดาว: ผูกกับ contact → อีกช่องทางเห็นด้วย ──
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  r := inbox.case_star(jsonb_build_object('conversation_id', v_line, 'starred', true));
  r := inbox.case_flags(jsonb_build_object('conversation_ids', jsonb_build_array(v_line, v_fb)));
  RESET ROLE;
  PERFORM pg_temp.check((r->v_fb::text->>'starred')::boolean, 'star is shared across channels of one contact');
  PERFORM pg_temp.check((r->v_line::text->>'starred')::boolean, 'star on the starred case');

  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  r := inbox.flag_list('{"filter":"starred"}');
  RESET ROLE;
  PERFORM pg_temp.check((SELECT count(*) FROM jsonb_array_elements(r) x WHERE x->>'id' IN (v_line::text, v_fb::text)) = 2,
                        'starred filter lists both conversations of the contact');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE x->>'id' = v_real::text),
                        'starred filter skips unstarred');
  PERFORM pg_temp.check(r->0 ? 'case_status' AND r->0 ? 'waiting_minutes' AND r->0 ? 'picture_url',
                        'flag_list rows have the list row shape');

  -- ── tag: สร้างชื่อซ้ำคืนตัวเดิม, ติดแล้วเห็นทุกช่องทาง ──
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  r := inbox.tag_upsert('{"name":"__ทดสอบ tag__","color":"teal"}');
  v_tag := (r->>'id')::uuid;
  r := inbox.tag_upsert('{"name":"  __ทดสอบ TAG__ "}');
  PERFORM pg_temp.check((r->>'id')::uuid = v_tag AND NOT (r->>'created')::boolean, 'creating an existing name returns it');
  r := inbox.case_tags_set(jsonb_build_object('conversation_id', v_line, 'add', jsonb_build_array(v_tag)));
  r := inbox.case_flags(jsonb_build_object('conversation_ids', jsonb_build_array(v_fb)));
  RESET ROLE;
  PERFORM pg_temp.check(r->v_fb::text->'tags'->0->>'id' = v_tag::text, 'tag is shared across channels');

  -- sales แก้ชื่อ/เลิกใช้ tag ไม่ได้ · manager ได้
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  v_blocked := false;
  BEGIN PERFORM inbox.tag_upsert(jsonb_build_object('id', v_tag, 'name', 'x')); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'sales cannot rename a tag');
  PERFORM pg_temp.act_as(v_other);
  SET LOCAL ROLE authenticated;
  r := inbox.tag_upsert('{"name":"__ทดสอบ อีกอัน__"}');
  v_tag2 := (r->>'id')::uuid;
  v_blocked := false;
  BEGIN PERFORM inbox.tag_upsert(jsonb_build_object('id', v_tag2, 'name', '__ทดสอบ tag__')); EXCEPTION WHEN raise_exception THEN v_blocked := SQLERRM = 'tag_exists'; END;
  r := inbox.tag_archive(jsonb_build_object('id', v_tag));
  r := inbox.case_flags(jsonb_build_object('conversation_ids', jsonb_build_array(v_line)));
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'rename onto an active name is refused');
  PERFORM pg_temp.check(jsonb_array_length(r->v_line::text->'tags') = 0, 'archived tag disappears from cards');

  -- ── ติดตาม: version กันชน + crm.activity ไม่ซ้อน ──
  SELECT version INTO v_ver FROM connect_private.case_state WHERE conversation_id = v_line;
  SELECT lead_id INTO v_lead FROM connect_private.case_state WHERE conversation_id = v_line;
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  r := inbox.case_follow(jsonb_build_object('conversation_id', v_line, 'follow_up_at', '2030-01-02T03:00:00Z',
                                            'note', 'โทรหลังเลิกงาน', 'version', v_ver));
  PERFORM pg_temp.check((r->>'version')::int = v_ver + 1, 'case_follow bumps version');
  r := inbox.case_follow(jsonb_build_object('conversation_id', v_line, 'follow_up_at', '2030-01-02T03:00:00Z',
                                            'note', 'แก้แค่โน้ต', 'version', v_ver + 1));
  v_blocked := false;
  BEGIN PERFORM inbox.case_follow(jsonb_build_object('conversation_id', v_line, 'follow_up_at', '', 'version', v_ver));
  EXCEPTION WHEN raise_exception THEN v_blocked := SQLERRM = 'version_conflict'; END;
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'stale version is refused');
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  v_blocked := false;
  BEGIN PERFORM inbox.case_star(jsonb_build_object('conversation_id', v_line));
  EXCEPTION WHEN raise_exception THEN v_blocked := SQLERRM = 'invalid_request'; END;
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'star without a boolean is refused cleanly');
  PERFORM pg_temp.check((SELECT follow_up_at = '2030-01-02T03:00:00Z' FROM connect_private.case_state WHERE conversation_id = v_line),
                        'follow_up_at written to case_state');
  PERFORM pg_temp.check((SELECT follow_note = 'แก้แค่โน้ต' FROM connect_private.contact_flag WHERE contact_id = v_contact),
                        'note stored on the contact');
  IF v_lead IS NOT NULL THEN
    PERFORM pg_temp.check((SELECT count(*) FROM crm.activity WHERE conversation_id = v_line AND type = 'task'
                            AND done_at IS NULL AND extra->>'source' = 'connect_followup') = 1,
                          'note-only edit does not stack crm tasks');
  END IF;

  -- ── ผู้ตรวจสอบ (test_only) เห็น/แก้ได้เฉพาะแชททดสอบ และสร้าง tag ไม่ได้ ──
  UPDATE core.profile SET test_only = true WHERE user_id = v_sales;
  PERFORM pg_temp.act_as(v_sales);
  SET LOCAL ROLE authenticated;
  v_blocked := false;
  BEGIN PERFORM inbox.case_star(jsonb_build_object('conversation_id', v_real, 'starred', true));
  EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'reviewer cannot star a real case');
  SET LOCAL ROLE authenticated;
  v_blocked := false;
  BEGIN PERFORM inbox.tag_upsert('{"name":"__reviewer__"}'); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  r := inbox.case_flags(jsonb_build_object('conversation_ids', jsonb_build_array(v_real, v_line)));
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'reviewer cannot create tags');
  PERFORM pg_temp.check(NOT r ? v_real::text AND r ? v_line::text, 'case_flags drops unreadable cases');

  -- ── คนนอก (ไม่มี profile) เรียกไม่ได้ ──
  PERFORM pg_temp.act_as(gen_random_uuid());
  SET LOCAL ROLE authenticated;
  v_blocked := false;
  BEGIN PERFORM inbox.tags_list('{}'); EXCEPTION WHEN insufficient_privilege THEN v_blocked := true; END;
  RESET ROLE;
  PERFORM pg_temp.check(v_blocked, 'non-staff cannot list tags');

  -- ตัวช่วยภายในเรียกตรงจากหน้าเว็บไม่ได้
  PERFORM pg_temp.check(NOT has_function_privilege('authenticated', 'inbox.flag_contact_of(uuid)', 'execute'),
                        'helper is not exposed to authenticated');
END
$test$;
`

test('star / follow-up / tags contract', { skip: SKIP && SKIP_WHY }, () => {
  const output = runSql(`BEGIN;\n${migration}\n${assertions}\nROLLBACK;\n`)
  assert.equal(output.trim(), '')
})
