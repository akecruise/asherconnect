/**
 * รหัสรีวิวของ Meta App Review — ส่วนที่ต้องมีฐานจริง (sql/202609191500_review_code.sql)
 *
 *   ALLOW_DB_TESTS=1 node --test tests/reviewcode.db.test.mjs
 *
 * ★★ เทสต์ชุดนี้ INSERT/UPDATE ลงฐานจริงผ่าน connect_private.receive_event ★★
 *   บนเครื่องที่ต่อกับ production มันจะเขียนลง production
 *   จึงถูกล็อกไว้ด้วย ALLOW_DB_TESTS=1 เหมือน tests/testreset.db.test.mjs
 *
 * ★ สร้าง contact ของตัวเองด้วย external_id ที่ขึ้นต้น __selftest__
 *   แล้วเก็บกวาดทั้งตอนเริ่ม (ขยะจากรอบที่ล้ม) และตอนจบ ไม่แตะแชทของลูกค้าจริงสักแถว
 * ★ ก่อนรัน ต้องลง sql/202609191500_review_code.sql แล้ว (node sql/run.mjs apply)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const run = promisify(execFile)
const STAMP = Date.now()
const PREFIX = '__selftest__'
const CODE = 'META-REVIEW'

const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'เทสต์ชุดนี้เขียนลงฐานจริง (insert/update ผ่าน receive_event) — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const dbTest = (name, fn) => test(name, { skip: SKIP && SKIP_WHY }, fn)

async function sql(text, role = 'service_role') {
  const wrapped = `begin; set local request.jwt.claims = '{"role":"${role}"}'; ${text} commit;`
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', wrapped], { maxBuffer: 8 << 20 })
  return stdout.split('\n').map(s => s.trim())
    .filter(s => s && !['BEGIN', 'COMMIT', 'SET', 'ROLLBACK'].includes(s))
}

const messengerInbox = async () =>
  (await sql(`select id from inbox.inbox where channel='messenger' and is_active order by created_at limit 1;`))[0]
const lineInbox = async () =>
  (await sql(`select id from inbox.inbox where channel='line' and is_active order by created_at limit 1;`))[0]

const receive = async (inbox, externalId, text, hit) => sql(
  `select connect_private.receive_event(jsonb_build_object(
     'inbox_id','${inbox}','event_id','${randomUUID()}','event_type','message',
     'external_id','${externalId}','text','${text.replace(/'/g, "''")}'
     ${hit ? `,'review_code_hit',true` : ''}
   ), now());`)

const convoRow = (externalId) => sql(
  `select c.mode, c.bot_active, c.is_test from inbox.conversation c
     join core.contact_identity ci on ci.contact_id = c.contact_id
    where ci.external_id = '${externalId}';`)

// ── (a) รหัสรีวิวจาก Messenger → is_test + mode='human' ────────────────────

dbTest('(a) ข้อความขึ้นต้นด้วยรหัสรีวิว → is_test=true, mode=human, ไม่มีงาน generate', async () => {
  const inbox = await messengerInbox()
  const ext = `${PREFIX}review-a-${STAMP}`
  const [out] = await receive(inbox, ext, `${CODE} ทดสอบ pages_messaging`, true)
  const parsed = JSON.parse(out)
  assert.ok(parsed.id, out)

  const [row] = await convoRow(ext)
  assert.equal(row, 'human|f|t', 'ต้องได้ mode=human · bot_active=false (trigger ตาม) · is_test=true')

  const [pendingGenerate] = await sql(
    `select count(*) from connect_private.job where conversation_id='${parsed.id}' and kind='generate' and status='pending';`)
  assert.equal(pendingGenerate, '0', 'ห้ามมีงาน generate ค้าง — บอทต้องไม่ตอบผู้ตรวจสอบ')
})

// ── (b) ข้อความปกติของลูกค้าจริงบน asher-messenger → ไม่ถูกแตะ ─────────────

dbTest('(b) ข้อความปกติ (ไม่มีรหัส) บน Messenger → is_test ยังเป็น false, mode ยังเป็น bot', async () => {
  const inbox = await messengerInbox()
  const ext = `${PREFIX}review-b-${STAMP}`
  await receive(inbox, ext, 'สนใจคอนโดครับ ราคาเท่าไหร่', false)

  const [row] = await convoRow(ext)
  assert.equal(row, 'bot|t|f', 'ข้อความลูกค้าจริงต้องไม่ถูกแตะเลย')
})

// ── (c) แม้ธงหลุดมาจากช่องทางอื่น (จำลองบั๊กฝั่ง Node) → ฐานกันซ้ำอีกชั้น ──

dbTest('(c) LINE + review_code_hit หลุดมา → ฐานเมิน (เช็ค v_inbox.channel ซ้ำ)', async () => {
  const inbox = await lineInbox()
  const ext = `${PREFIX}review-c-${STAMP}`
  await receive(inbox, ext, `${CODE} หลุดมาจาก LINE`, true)

  const [row] = await convoRow(ext)
  assert.equal(row, 'bot|t|f', 'ช่องทางอื่นต้องไม่ถูกติดธง is_test/human แม้ธงจะหลุดมาจริง')
})

// ── สถิติ/คะแนน: แชทรหัสรีวิวต้องไม่นับ (ปิดช่องโหว่ countable ของ 017) ────

dbTest('แชทรหัสรีวิวต้องไม่ถูกนับใน stats_normalize (ไม่เปิด response_window)', async () => {
  const ext = `${PREFIX}review-a-${STAMP}`
  const [row] = await sql(
    `select (inbox.stats_normalize(m)->>'countable')
       from inbox.message m
       join inbox.conversation c on c.id = m.conversation_id
       join core.contact_identity ci on ci.contact_id = c.contact_id
      where ci.external_id = '${ext}' and m.sender_type = 'contact'
      order by m.created_at desc limit 1;`)
  // ★ ->>'countable' ดึงจาก jsonb boolean ได้ข้อความ 'true'/'false' ไม่ใช่ 't'/'f'
  //   ของ Postgres boolean ธรรมดา — คนละรูปแบบกับที่ convoRow() ใช้ (select ตรง ๆ)
  assert.equal(row, 'false', 'countable ต้องเป็น false สำหรับแชท is_test')
})

/** เก็บกวาดแถวทดสอบทั้งหมด — ลบตามลำดับ FK จากลูกไปหาแม่ (เหมือน testreset.db.test.mjs) */
async function sweep() {
  if (SKIP) return
  await sql(`delete from connect_private.job j using inbox.conversation c, core.contact_identity ci
              where j.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from inbox.bot_decisions bd using inbox.conversation c, core.contact_identity ci
              where bd.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from connect_private.case_state cs using inbox.conversation c, core.contact_identity ci
              where cs.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from inbox.message m using inbox.conversation c, core.contact_identity ci
              where m.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  // ★ connect_private.inbound_event ไม่กวาด — event_id เป็น random uuid ต่อครั้ง
  //   ไม่มี prefix ให้กรอง เป็นตารางกันซ้ำล้วน ๆ ไม่มี PII เหลือค้างได้โดยไม่เสียหาย
  await sql(`delete from inbox.conversation c using core.contact_identity ci
              where ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  const ids = await sql(`select distinct contact_id from core.contact_identity where external_id like '${PREFIX}%';`)
  // ★ receive_event เรียก ensure_lead() + emit() เสมอ (ไม่เหมือน reset_test_conversation
  //   ของ testreset.db.test.mjs) จึงมี core.event_log/crm.lead ค้างอ้างถึง contact
  //   ต้องกวาดสองตัวนี้ก่อน ไม่งั้น delete core.contact จะชน event_log_contact_id_fkey
  for (const id of ids.filter(Boolean)) {
    await sql(`delete from crm.activity where lead_id in (select id from crm.lead where contact_id='${id}');`)
    await sql(`delete from crm.lead where contact_id='${id}';`)
    await sql(`delete from core.event_log where contact_id='${id}';`)
  }
  await sql(`delete from core.contact_identity where external_id like '${PREFIX}%';`)
  for (const id of ids.filter(Boolean)) await sql(`delete from core.contact where id='${id}';`)
}

test.before(sweep)   // ขยะจากรอบก่อนที่ล้มกลางทาง
test.after(sweep)
