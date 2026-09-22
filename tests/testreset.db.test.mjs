import { disposableTarget } from './db-target.mjs';
const testTarget = disposableTarget();
/**
 * คำสั่ง "test" — ส่วนที่ต้องมีฐานจริง
 *
 *   ALLOW_DB_TESTS=1 node --test tests/testreset.db.test.mjs
 *
 * ★★ เทสต์ชุดนี้ INSERT/UPDATE/DELETE ลงฐานจริง ★★
 *   บนเครื่องที่ต่อกับ production มันจะเขียนลง production
 *   จึงถูกล็อกไว้ด้วย ALLOW_DB_TESTS=1 ไม่ให้รันหลุดตอน `npm test`
 *
 * ★ สร้าง contact ของตัวเองด้วย external_id ที่ขึ้นต้น __selftest__
 *   แล้วเก็บกวาดทั้งตอนเริ่ม (ขยะจากรอบที่ล้ม) และตอนจบ
 *   ไม่แตะแชทของลูกค้าจริงสักแถว
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const EXT = '__selftest__' + Date.now()
const PREFIX = '__selftest__'

// ★ ประตูกัน — ไม่ตั้ง ALLOW_DB_TESTS=1 แล้วข้ามทั้งไฟล์ ไม่ใช่ข้ามทีละข้อ
//   ข้ามทีละข้อจะหลอกตาว่า "เทสต์ผ่าน" ทั้งที่ไม่ได้ทดสอบอะไรเลย
const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const SKIP_WHY = 'เทสต์ชุดนี้เขียนลงฐานจริง (insert/update/delete) — ตั้ง ALLOW_DB_TESTS=1 ถ้าตั้งใจรัน'
const dbTest = (name, fn) => test(name, { skip: SKIP && SKIP_WHY }, fn)

async function sql(text, role = 'service_role') {
  const wrapped = `begin; set local request.jwt.claims = '{"role":"${role}"}'; ${text} commit;`
  const { stdout } = await run('docker', ['exec', testTarget.container, 'psql', '-U', testTarget.user, '-d', testTarget.database,
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', wrapped], { maxBuffer: 8 << 20 })
  return stdout.split('\n').map(s => s.trim())
    .filter(s => s && !['BEGIN', 'COMMIT', 'SET', 'ROLLBACK'].includes(s))
}

const lineInbox = async () =>
  (await sql(`select id from inbox.inbox where channel='line' and is_active order by created_at limit 1;`))[0]

const reset = async (inbox) => sql(
  `select connect_private.reset_test_conversation(jsonb_build_object(
     'inbox_id','${inbox}','channel','line','external_id','${EXT}'));`)

dbTest('ยังไม่มีแถว conversation → สร้างให้ (upsert) และติดธง is_test', async () => {
  const inbox = await lineInbox()
  const [out] = await reset(inbox)
  assert.equal(JSON.parse(out).created, true, out)

  const [row] = await sql(
    `select c.mode, c.bot_active, c.is_test from inbox.conversation c
      join core.contact_identity ci on ci.contact_id = c.contact_id
     where ci.external_id = '${EXT}';`)
  assert.equal(row, 'bot|t|t', 'ต้องได้ mode=bot · bot_active=true · is_test=true')
})

dbTest('แชทที่เป็น human → กลับเป็น bot และ trigger ตั้ง bot_active ให้เอง', async () => {
  const inbox = await lineInbox()
  // ตั้งให้เป็น human พร้อมสถานะค้างต่าง ๆ เหมือนแชทที่ทีมรับช่วงไปแล้ว
  await sql(`update inbox.conversation c
                set mode='human', offtopic_count=3, offtopic_date=current_date,
                    last_human_reply_at=now(), last_notified_at=now(), sla_due_at=now()
               from core.contact_identity ci
              where ci.contact_id = c.contact_id and ci.external_id='${EXT}';`)

  const [before] = await sql(`select c.mode, c.bot_active from inbox.conversation c
      join core.contact_identity ci on ci.contact_id=c.contact_id where ci.external_id='${EXT}';`)
  assert.equal(before, 'human|f', 'ตั้งต้นต้องเป็น human')

  await reset(inbox)

  const [after] = await sql(`select c.mode, c.bot_active, c.offtopic_count,
                                    c.last_human_reply_at is null, c.last_notified_at is null,
                                    c.sla_due_at is null
      from inbox.conversation c join core.contact_identity ci on ci.contact_id=c.contact_id
     where ci.external_id='${EXT}';`)
  // ★ bot_active=true มาจาก trigger conversation_sync_mode ไม่ได้ตั้งเอง
  assert.equal(after, 'bot|t|0|t|t|t', 'ต้องล้างสถานะครบและ trigger ซิงก์ bot_active')
})

dbTest('เรียกซ้ำได้ (idempotent) และบันทึก audit ทุกครั้ง', async () => {
  const inbox = await lineInbox()
  const [n0] = await sql(`select count(*) from connect_private.audit a
     join inbox.conversation c on c.id=a.conversation_id
     join core.contact_identity ci on ci.contact_id=c.contact_id
    where ci.external_id='${EXT}' and a.action='test_reset';`)
  await reset(inbox)
  await reset(inbox)
  const [n1] = await sql(`select count(*) from connect_private.audit a
     join inbox.conversation c on c.id=a.conversation_id
     join core.contact_identity ci on ci.contact_id=c.contact_id
    where ci.external_id='${EXT}' and a.action='test_reset';`)
  assert.equal(Number(n1) - Number(n0), 2, 'audit ต้องเพิ่มตามจำนวนครั้งที่เรียก')

  const [detail] = await sql(`select a.detail->>'channel', a.detail ? 'user_id',
                                     a.detail ? 'previous_mode', a.detail ? 'cancelled_jobs'
     from connect_private.audit a
     join inbox.conversation c on c.id=a.conversation_id
     join core.contact_identity ci on ci.contact_id=c.contact_id
    where ci.external_id='${EXT}' and a.action='test_reset' order by a.id desc limit 1;`)
  assert.equal(detail, 'line|t|t|t', 'detail ต้องมี channel/user_id/previous_mode/cancelled_jobs')
})

dbTest('case_state: ล้างสิ่งที่ต้องทำต่อ แต่เก็บ lead_id กับ first_human_response_at และ bump version', async () => {
  const inbox = await lineInbox()
  const [cid] = await sql(`select c.id from inbox.conversation c
     join core.contact_identity ci on ci.contact_id=c.contact_id where ci.external_id='${EXT}';`)
  await sql(`insert into connect_private.case_state
               (conversation_id, follow_up_at, appointment_at, waiting_since, first_human_response_at, version)
             values ('${cid}', now(), now(), now(), now(), 1)
             on conflict (conversation_id) do update
               set follow_up_at=now(), appointment_at=now(), waiting_since=now(),
                   first_human_response_at=now();`)
  const [v0] = await sql(`select version from connect_private.case_state where conversation_id='${cid}';`)

  await reset(inbox)

  const [row] = await sql(`select follow_up_at is null, appointment_at is null, waiting_since is null,
                                  first_human_response_at is not null, version
     from connect_private.case_state where conversation_id='${cid}';`)
  assert.equal(row, `t|t|t|t|${Number(v0) + 1}`, 'ล้าง 3 ช่อง เก็บประวัติ และ version +1')
})

dbTest('แชททดสอบต้องไม่โผล่ในสถิติและไม่นับ SLA', async () => {
  const [cid] = await sql(`select c.id from inbox.conversation c
     join core.contact_identity ci on ci.contact_id=c.contact_id where ci.external_id='${EXT}';`)

  const [inEpisodes] = await sql(`select count(*) from inbox.reply_episodes(
     now() - interval '1 day', now() + interval '1 day') e where e.conversation_id='${cid}';`)
  assert.equal(inEpisodes, '0', 'reply_episodes ต้องกรองแชททดสอบออก')

  const [sla] = await sql(`select waiting_minutes is null, is_test
     from inbox.case_status where conversation_id='${cid}';`)
  assert.equal(sla, 't|t', 'case_status ต้องยังเห็นแถว (ไว้ติดแท็ก) แต่ไม่นับ SLA')
})

/**
 * เก็บกวาดแถวทดสอบทั้งหมด — ลบตามลำดับ FK จากลูกไปหาแม่
 *
 * ★ กวาดด้วย prefix ไม่ใช่แค่ EXT ของรอบนี้ — รอบที่ล้มกลางทางจะทิ้งขยะไว้
 *   แล้วมันจะค้างในฐาน production ตลอดไปถ้าไม่มีใครกวาด
 */
async function sweep() {
  if (SKIP) return
  await sql(`delete from connect_private.job j using inbox.conversation c, core.contact_identity ci
              where j.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from connect_private.audit a using inbox.conversation c, core.contact_identity ci
              where a.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from connect_private.case_state cs using inbox.conversation c, core.contact_identity ci
              where cs.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from inbox.message m using inbox.conversation c, core.contact_identity ci
              where m.conversation_id=c.id and ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  await sql(`delete from inbox.conversation c using core.contact_identity ci
              where ci.contact_id=c.contact_id and ci.external_id like '${PREFIX}%';`)
  // ★ identity ก่อน contact — FK ชี้จาก identity ไป contact ไม่ใช่ทางกลับ
  const ids = await sql(`select distinct contact_id from core.contact_identity where external_id like '${PREFIX}%';`)
  await sql(`delete from core.contact_identity where external_id like '${PREFIX}%';`)
  for (const id of ids.filter(Boolean)) await sql(`delete from core.contact where id='${id}';`)
}

test.before(sweep)   // ขยะจากรอบก่อนที่ล้มกลางทาง
test.after(sweep)
