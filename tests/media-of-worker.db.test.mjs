/**
 * ประตูอ่านสื่อของ worker — เทสต์กติกาของ sql/202609231300_media_of_worker.sql
 *
 *   ALLOW_DB_TESTS=1 node --test tests/media-of-worker.db.test.mjs
 *   ALLOW_DB_TESTS=1 ASHER_DB_SSH=root@<host> node --test tests/media-of-worker.db.test.mjs
 *
 * บั๊กที่กันไว้: worker เคยเรียก inbox.media_of ซึ่งเป็นประตูของ "ผู้ใช้"
 * (บรรทัดแรกตรวจ auth.uid()) ทั้งที่ยิงด้วย service key ที่ไม่มีตัวตนผู้ใช้
 * ผลคือ 403 ทุกครั้ง งานส่งค้างจนสัญญาเช่าหมดอายุ แล้ววนซ้ำทุก ~36 วินาที
 *
 * ★ เทสต์นี้ต้องล้มถ้ามีใครมา "แก้" ด้วยการ GRANT inbox.media_of ให้ service_role
 *   เพราะนั่นคือการลบเหตุผลของด่าน auth.uid() ทิ้ง ไม่ใช่การแก้บั๊ก
 *
 * ★ อ่านอย่างเดียว ไม่เขียนอะไรลงฐาน จึงรันบนฐานจริงได้
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SKIP = process.env.ALLOW_DB_TESTS !== '1'
const dbTest = (name, fn) => test(name, { skip: SKIP }, fn)

// ★ ฐานที่มีนิยามฟังก์ชันจริงคือฐานเดียว — ถ้ารันจากเครื่องที่ไม่ได้อยู่กับฐานนั้น
//   docker exec เปล่า ๆ จะไปโดนฐานอื่นที่ค้างอยู่ในเครื่อง แล้วได้ผลลวง
//   ตั้ง ASHER_DB_SSH=root@host เพื่อยิงข้ามไปเครื่องที่ฐานจริงอยู่
const DB_SSH = process.env.ASHER_DB_SSH || ''
const PSQL = 'docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -t -A -F "|"'

async function sql(raw) {
  // ยุบขึ้นบรรทัดใหม่ให้เหลือช่องว่างก่อนเสมอ — ผ่าน ssh แล้ว "\n" จะกลายเป็นตัวอักษรสองตัว
  // ไม่ใช่การขึ้นบรรทัด psql จึงมองเป็น syntax error โดยที่เทสต์ดูเหมือนแค่ "ล้ม"
  const body = raw.replace(/\s+/g, ' ').trim()
  const { stdout } = DB_SSH
    ? await run('ssh', ['-o', 'BatchMode=yes', DB_SSH, `${PSQL} -c ${JSON.stringify(body)}`], { maxBuffer: 16 << 20 })
    : await run('docker', ['exec', '-i', 'supabase-db', 'psql',
        '-U', 'supabase_admin', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', body], { maxBuffer: 16 << 20 })
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .filter(s => !['BEGIN', 'ROLLBACK', 'COMMIT', 'SET'].includes(s))
}

dbTest('worker door exists as SECURITY DEFINER owned by the table owner', async () => {
  const [row] = await sql(`select p.prosecdef||'|'||pg_get_userbyid(p.proowner)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='inbox' and p.proname='media_of_worker'`)
  assert.equal(row, 'true|postgres')
})

dbTest('service_role may use the worker door', async () => {
  const [row] = await sql(
    `select has_function_privilege('service_role','inbox.media_of_worker(uuid)','EXECUTE')`)
  assert.equal(row, 't')
})

dbTest('service_role may NOT use the user door — its auth.uid() guard stays meaningful', async () => {
  const [row] = await sql(
    `select has_function_privilege('service_role','inbox.media_of(uuid)','EXECUTE')`)
  assert.equal(row, 'f', 'ห้าม GRANT inbox.media_of ให้ service_role — ใช้ media_of_worker แทน')
})

dbTest('browser-facing roles may NOT use the worker door', async () => {
  for (const role of ['anon', 'authenticated']) {
    const [row] = await sql(
      `select has_function_privilege('${role}','inbox.media_of_worker(uuid)','EXECUTE')`)
    assert.equal(row, 'f', `${role} ต้องเดินผ่าน inbox.media_of ที่ตรวจตัวตนเท่านั้น`)
  }
})

dbTest('the user door still keeps its auth.uid() check', async () => {
  const [row] = await sql(`select position('auth.uid()' in p.prosrc)>0
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='inbox' and p.proname='media_of'`)
  assert.equal(row, 't')
})

dbTest('worker door returns the same shape as the private reader', async () => {
  const [row] = await sql(
    `select inbox.media_of_worker('00000000-0000-0000-0000-000000000000'::uuid)::text`)
  assert.equal(row, '{}')
})
