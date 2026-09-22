import { disposableTarget } from './db-target.mjs';
const testTarget = disposableTarget();
/**
 * ชื่อที่คนตั้งเอง ห้ามตัวดึงโปรไฟล์ทับ — เทสต์กติกาของ 202609221400_manual_name_guard.sql
 *
 *   ALLOW_DB_TESTS=1 node --test tests/manual-name-guard.db.test.mjs
 *
 * ★ ทุกเคสรันใน transaction แล้ว rollback เสมอ — ไม่มีแถวไหนค้างในฐานจริง
 *   ตั้งใจไม่ใช้ commit เพราะเทสต์ชุดนี้ต้องรันบนฐานโปรดักชันได้ด้วย
 *   (ฐานเดียวคือที่เดียวที่มีนิยามฟังก์ชันจริง — ดูหัว sql/026 เรื่อง drift)
 *
 * ★ ไม่แตะ Messenger backfill (sql/022_contact_profile_sync.sql) — คนละเส้นทางกัน
 *   เคส messenger ที่นี่ทดสอบกิ่ง profile_update ซึ่งใช้ร่วมกันทั้งสองช่องทาง
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const run = promisify(execFile)
const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const dbTest = (name, fn) => test(name, { skip: SKIP }, fn)

const TAG = '__manual_name_guard__' + Date.now()

/** รันใน transaction แล้ว rollback — คืนบรรทัดผลลัพธ์ที่ไม่ใช่ noise ของ psql */
async function sqlRollback(body) {
  const { stdout } = await run('docker', ['exec', '-i', testTarget.container, 'psql',
    '-U', testTarget.adminUser, '-d', testTarget.database,
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|',
    '-c', `begin; ${body} rollback;`], { maxBuffer: 16 << 20 })
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .filter(s => !['BEGIN', 'ROLLBACK', 'COMMIT', 'SET'].includes(s))
}

/**
 * สร้างลูกค้าหนึ่งคน + identity หนึ่งเส้น แล้วยิง profile_update ใส่
 * คืนชื่อที่เหลืออยู่หลังยิง
 *
 * @param channel   'line' | 'messenger'
 * @param before    ชื่อที่มีอยู่ก่อน (null = ยังไม่มีชื่อ)
 * @param manual    true = ชื่อนั้นคนตั้งเอง (extra.name_source='manual')
 * @param incoming  ชื่อที่แพลตฟอร์มคืนมา ('' = คืนค่าว่าง)
 */
async function nameAfterSync({ channel, before, manual, incoming }) {
  // ★ สร้าง uuid ฝั่งนี้ เพื่อให้แต่ละคำสั่งเป็นอิสระต่อกัน
  //   ใช้ \gset ไม่ได้ (เป็น meta-command ของ psql ใช้ใน -c ไม่ได้) และใช้ CTE
  //   ก็ไม่ได้ เพราะ worker() ทำ update ภายใน — CTE มองไม่เห็นแถวที่เพิ่ง insert
  //   ในคำสั่งเดียวกัน (snapshot ถูกตรึงตั้งแต่ต้นคำสั่ง) จะได้ contact_not_found
  const id = randomUUID()
  const ext = `${TAG}_${channel}_${randomUUID().slice(0, 8)}`
  const acct = `${TAG}_acct`
  const beforeSql = before === null ? 'null' : `'${before}'`
  const extraSql = manual ? `'{"name_source":"manual"}'::jsonb` : `'{}'::jsonb`

  const out = await sqlRollback(`
    insert into core.contact(id, display_name, extra)
      values ('${id}', ${beforeSql}, ${extraSql});
    insert into core.contact_identity(contact_id, channel, account_key, external_id)
      values ('${id}', '${channel}', '${acct}', '${ext}');
    select connect_private.worker('profile_update', jsonb_build_object(
      'channel','${channel}','account_key','${acct}','external_id','${ext}',
      'display_name','${incoming}','status','ok'));
    select coalesce(display_name,'<null>') from core.contact where id = '${id}';
  `)
  return out[out.length - 1]
}

// ── ชื่อที่ยังไม่ถูกตั้งเอง: ตัวดึงต้องเติม/อัปเดตได้ตามปกติ ────────────────

dbTest('LINE: ชื่อที่ไม่ได้ตั้งเอง ตัวดึงอัปเดตได้', async () => {
  const after = await nameAfterSync({
    channel: 'line', before: 'ชื่อเก่าจากแพลตฟอร์ม', manual: false, incoming: 'ชื่อใหม่จาก LINE' })
  assert.equal(after, 'ชื่อใหม่จาก LINE')
})

dbTest('Messenger: ชื่อที่ไม่ได้ตั้งเอง ตัวดึงอัปเดตได้', async () => {
  const after = await nameAfterSync({
    channel: 'messenger', before: 'ชื่อเก่าจากแพลตฟอร์ม', manual: false, incoming: 'ชื่อใหม่จาก FB' })
  assert.equal(after, 'ชื่อใหม่จาก FB')
})

// ── ชื่อที่คนตั้งเอง: ห้ามทับ ทั้งสองช่องทาง ────────────────────────────────

dbTest('LINE: ชื่อที่คนตั้งเอง ตัวดึงทับไม่ได้', async () => {
  const after = await nameAfterSync({
    channel: 'line', before: 'คุณเอ (เซลส์ตั้งเอง)', manual: true, incoming: 'ชื่อใหม่จาก LINE' })
  assert.equal(after, 'คุณเอ (เซลส์ตั้งเอง)')
})

dbTest('Messenger: ชื่อที่คนตั้งเอง ตัวดึงทับไม่ได้', async () => {
  const after = await nameAfterSync({
    channel: 'messenger', before: 'คุณบี (เซลส์ตั้งเอง)', manual: true, incoming: 'ชื่อใหม่จาก FB' })
  assert.equal(after, 'คุณบี (เซลส์ตั้งเอง)')
})

// ── ค่าว่างห้ามลบของเดิม (กติกาเดิมก่อนหน้านี้ ต้องไม่พังไปด้วย) ─────────────

dbTest('ค่าว่างที่ส่งเข้ามา ห้ามลบชื่อที่มีอยู่ (ไม่ manual)', async () => {
  const after = await nameAfterSync({
    channel: 'line', before: 'ชื่อที่มีอยู่', manual: false, incoming: '' })
  assert.equal(after, 'ชื่อที่มีอยู่')
})

dbTest('ค่าว่างที่ส่งเข้ามา ห้ามลบชื่อที่คนตั้งเอง', async () => {
  const after = await nameAfterSync({
    channel: 'line', before: 'ชื่อที่คนตั้งเอง', manual: true, incoming: '' })
  assert.equal(after, 'ชื่อที่คนตั้งเอง')
})

// ── คนที่ยังไม่มีชื่อเลย ต้องเติมได้ (ไม่งั้น backfill ตาย) ──────────────────

dbTest('คนที่ยังไม่มีชื่อ ตัวดึงเติมให้ได้ (เส้นทางของ backfill)', async () => {
  const after = await nameAfterSync({
    channel: 'line', before: null, manual: false, incoming: 'ชื่อแรกจาก LINE' })
  assert.equal(after, 'ชื่อแรกจาก LINE')
})
