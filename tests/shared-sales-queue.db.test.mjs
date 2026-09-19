/**
 * เซลส์ใช้คิวรวม + ผู้ตรวจสอบ Meta เห็นเฉพาะแชททดสอบ (sql/041_shared_sales_queue.sql)
 *
 *   ALLOW_DB_TESTS=1 node --test tests/shared-sales-queue.db.test.mjs
 *
 * ★★ เทสต์ชุดนี้ INSERT/UPDATE ลงฐานจริง (รวมทั้งสลับ core.profile.test_only
 *   ของบัญชีทดสอบที่ใช้ร่วมกับ asher-web ชั่วคราว) ★★ ล็อกไว้ด้วย ALLOW_DB_TESTS=1
 *
 * ★ ต้องมีบัญชีทดสอบร่วมของ ../.asher-test-users อยู่ก่อน (สร้างด้วย
 *   asher-web/scripts/seed-test-users.mjs --apply) — ใช้ sales.a.test@ (ทีมเหนือ)
 *   กับ sales.b.test@ (ทีมใต้) เพราะคนละทีมกัน คือกรณีที่ can_read เดิม (ก่อนแก้)
 *   จะปฏิเสธ แต่หลังแก้ต้องอ่านได้ (คิวรวม)
 * ★ ก่อนรัน ต้องลง sql/041_shared_sales_queue.sql แล้ว (node sql/run.mjs apply)
 * ★ สลับ test_only ของ sales.b ชั่วคราวเท่านั้น — คืนค่าเดิมใน finally และใน
 *   test.after ซ้ำอีกชั้น กันไม่ให้ fixture ที่ใช้ร่วมกับ asher-web ค้างผิดสถานะ
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const STAMP = Date.now()
const PREFIX = '__selftest__'

const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'เทสต์ชุดนี้เขียนลงฐานจริง (insert/update + สลับ test_only ชั่วคราว) — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const dbTest = (name, fn) => test(name, { skip: SKIP && SKIP_WHY }, fn)

async function sql(text, claims = '{"role":"service_role"}') {
  const wrapped = `begin; set local request.jwt.claims = '${claims}'; ${text} commit;`
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', wrapped], { maxBuffer: 8 << 20 })
  return stdout.split('\n').map(s => s.trim())
    .filter(s => s && !['BEGIN', 'COMMIT', 'SET', 'ROLLBACK'].includes(s))
}
const asUser = (userId) => `{"sub":"${userId}","role":"authenticated"}`

async function testUserId(prefix) {
  const raw = await readFile(join(root, '..', '.asher-test-users'), 'utf8').catch(() => null)
  if (!raw) throw new Error('ไม่พบ ../.asher-test-users — รัน asher-web/scripts/seed-test-users.mjs --apply ก่อน')
  const line = raw.split(/\r?\n/).find(l => l.startsWith(prefix))
  if (!line) throw new Error(`ไม่พบบัญชีทดสอบ ${prefix} ใน .asher-test-users`)
  const email = line.split('|')[0]
  const [id] = await sql(`select id from auth.users where email='${email}';`)
  if (!id) throw new Error(`มีชื่อใน .asher-test-users แต่ไม่มีแถวจริงใน auth.users: ${email}`)
  return id
}

const messengerInbox = async () =>
  (await sql(`select id from inbox.inbox where channel='messenger' and is_active order by created_at limit 1;`))[0]

const canRead = async (conv, userId) =>
  (await sql(`select connect_private.can_read('${conv}');`, asUser(userId)))[0]

let salesA, salesB, conv, ext

test.before(async () => {
  if (SKIP) return
  salesA = await testUserId('sales.a.test@')   // ทีมเหนือ
  salesB = await testUserId('sales.b.test@')   // ทีมใต้ — คนละทีมกับ A โดยตั้งใจ

  const inbox = await messengerInbox()
  ext = `${PREFIX}sharedqueue-${STAMP}`
  const [contact] = await sql(
    `select core.resolve_identity('messenger','${ext}','${inbox}','ผู้ทดสอบ ${STAMP}',
       (select project_id from inbox.inbox where id='${inbox}'));`)
  const [id] = await sql(
    `insert into inbox.conversation(inbox_id,contact_id,assignee_id,status)
     values('${inbox}','${contact}','${salesA}','open') returning id;`)
  conv = id
})

// ── คิวรวม: คนละทีมกันก็อ่านได้ (ก่อนแก้จะอ่านไม่ได้) ───────────────────────

dbTest('เซลส์ต่างทีมกัน (ไม่ใช่เจ้าของเคส ไม่ใช่ senior_sales/manager) ก็อ่านเคสนี้ได้', async () => {
  const readable = await canRead(conv, salesB)
  assert.equal(readable, 't', 'คิวรวม: assignee_id ต้องไม่ใช่ด่านอ่านอีกต่อไป')
})

dbTest('เจ้าของเคสเองอ่านได้ตามปกติ', async () => {
  assert.equal(await canRead(conv, salesA), 't')
})

// ── ผู้ตรวจสอบ (test_only): เห็นเฉพาะแชท is_test ────────────────────────────

dbTest('บัญชี test_only=true มองไม่เห็นแชทจริง (is_test=false) แม้เป็น sales ปกติ', async () => {
  await sql(`update core.profile set test_only=true where user_id='${salesB}';`)
  try {
    assert.equal(await canRead(conv, salesB), 'f', 'ต้องเห็นไม่ได้ — นี่คือแชทงานจริง')

    await sql(`update inbox.conversation set is_test=true where id='${conv}';`)
    assert.equal(await canRead(conv, salesB), 't', 'ติดธง is_test แล้วต้องเห็นได้')

    // เซลส์คนอื่นที่ไม่ใช่ test_only ยังเห็นแชทนี้ได้เหมือนเดิม — is_test ไม่ได้ซ่อนจากทีม
    assert.equal(await canRead(conv, salesA), 't', 'is_test ไม่ควรซ่อนจากเพื่อนร่วมทีม')
  } finally {
    await sql(`update core.profile set test_only=false where user_id='${salesB}';`)
    await sql(`update inbox.conversation set is_test=false where id='${conv}';`)
  }
})

test.after(async () => {
  if (SKIP) return
  // กันเคสทดสอบก่อนหน้าล้มกลางทางแล้วเหลือ test_only=true ค้างบนบัญชีที่ใช้ร่วมกับ asher-web
  await sql(`update core.profile set test_only=false where user_id in ('${salesA}','${salesB}');`)
  await sql(`delete from connect_private.job j using inbox.conversation c, core.contact_identity ci
              where j.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from connect_private.case_state cs using inbox.conversation c, core.contact_identity ci
              where cs.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from inbox.message m using inbox.conversation c, core.contact_identity ci
              where m.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from inbox.conversation c using core.contact_identity ci
              where ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  const ids = await sql(`select distinct contact_id from core.contact_identity where external_id like '${PREFIX}%';`)
  await sql(`delete from core.contact_identity where external_id like '${PREFIX}%';`)
  for (const id of ids.filter(Boolean)) await sql(`delete from core.contact where id='${id}';`)
})
