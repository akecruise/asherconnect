/**
 * ตัวรันไฟล์ SQL ตามลำดับใน sql/ORDER.txt
 *
 *   node sql/run.mjs check                 ตรวจอย่างเดียว ไม่ต้องต่อฐาน
 *   node sql/run.mjs plan  --db "$DB"      บอกว่าจะรันอะไรบ้าง ไม่แตะฐาน
 *   node sql/run.mjs apply --db "$DB"      รันจริง แล้วบันทึกลงทะเบียน
 *
 * ทำไมต้องมีไฟล์นี้ แทนที่จะ psql -f ไล่ทีละไฟล์เหมือนเดิม:
 *
 *   1. เลขนำหน้าชื่อไฟล์ใช้เรียงลำดับไม่ได้แล้ว — มี 022/023/024 อย่างละสองไฟล์
 *      ที่ถูกตั้งเลขทับของเดิม ลำดับจริงจึงต้องเขียนไว้ที่เดียวคือ ORDER.txt
 *
 *   2. ★ กับดักตัวจริงไม่ใช่เลขซ้ำ แต่เป็น "หลายไฟล์ create or replace ของชิ้น
 *      เดียวกัน" — ตัวที่รันทีหลังชนะ ของก่อนหน้าหายเงียบ ๆ ไม่มีอะไรฟ้อง
 *      ตอนนี้ connect_private.api ถูกเขียนทับทั้งก้อนอยู่ 4 ไฟล์ และ
 *      purge_channel_events อีก 2 ไฟล์ ตัวนี้พิมพ์ให้ดูทุกครั้งว่าใครชนะ
 *
 *   3. ฐานบน VPS มาจาก restore จึงไม่มี supabase_migrations.schema_migrations
 *      ทะเบียน inbox.sql_applied เก็บ sha256 ไว้ด้วย จะได้รู้ว่าไฟล์ถูกแก้
 *      หลังลงไปแล้วหรือเปล่า ไม่ใช่รู้แค่ว่า "เคยลงชื่อนี้"
 *
 * ★ ไม่ห่อทุกไฟล์ไว้ใน transaction เดียว เพราะบางไฟล์มี commit; ของตัวเอง
 *   (011_cloud_functions.sql) และ create extension ที่ทำใน transaction ไม่ได้
 *   จึงรันทีละไฟล์ แล้วบันทึกทะเบียนเมื่อไฟล์นั้นผ่าน
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mojibakeLines } from './mojibake.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, 'ORDER.txt')

const argv = process.argv.slice(2)
const mode = argv.find((a) => !a.startsWith('--')) || 'check'
const dbAt = argv.indexOf('--db')
const DB = dbAt > -1 ? argv[dbAt + 1] : process.env.DATABASE_URL || ''

const sha = (s) => createHash('sha256').update(s).digest('hex')
const red = (s) => '\x1b[31m' + s + '\x1b[0m'
const yellow = (s) => '\x1b[33m' + s + '\x1b[0m'
const green = (s) => '\x1b[32m' + s + '\x1b[0m'
const dim = (s) => '\x1b[2m' + s + '\x1b[0m'

// ── อ่านลำดับ ────────────────────────────────────────────────────────
const order = readFileSync(MANIFEST, 'utf8')
  .split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))

const onDisk = readdirSync(HERE).filter((f) => f.endsWith('.sql')).sort()

const problems = []
const warnings = []

// ── ด่าน 1: ลำดับกับโฟลเดอร์ต้องตรงกัน ───────────────────────────────
// ไฟล์ที่ไม่มีใครสั่งให้รัน อันตรายพอ ๆ กับไฟล์ที่หายไป — แปลว่ามีของที่เขียน
// ขึ้นมาแล้วไม่มีใครรู้ว่าต้องรันตอนไหน ซึ่งคือสภาพของโฟลเดอร์นี้ก่อนมี ORDER.txt
const missingOnDisk = order.filter((f) => !onDisk.includes(f))
const notInOrder = onDisk.filter((f) => !order.includes(f))
if (missingOnDisk.length) problems.push('ORDER.txt อ้างไฟล์ที่ไม่มีในโฟลเดอร์: ' + missingOnDisk.join(', '))
if (notInOrder.length) problems.push('มีไฟล์ในโฟลเดอร์ที่ไม่ได้อยู่ใน ORDER.txt: ' + notInOrder.join(', '))

const dupInOrder = order.filter((f, i) => order.indexOf(f) !== i)
if (dupInOrder.length) problems.push('ORDER.txt มีชื่อซ้ำ: ' + [...new Set(dupInOrder)].join(', '))

// ── อ่านเนื้อไฟล์ แล้วหาว่าแต่ละไฟล์สร้างอะไรบ้าง ────────────────────
// ★ ตัดคอมเมนต์ออกก่อนเสมอ ไม่งั้นบรรทัดที่ comment ไว้ (เช่น cron ทั้งสามตัว
//   ใน 019_stats_seed_cron.sql) จะถูกนับเป็นของจริง
const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
// ★ ใช้ \p{L} ไม่ใช่ [a-z] — ไม่งั้นชื่อที่มีอักษรไทยจะถูกตัดกลางคัน แล้วรายงาน
//   จะบอกว่าของชนกันที่ "inbox" เฉย ๆ ซึ่งอ่านแล้วไม่รู้เรื่องและชี้ผิดตัว
// \p{M} ต้องมีด้วย ไม่งั้นสระ/วรรณยุกต์ไทยหลุด แล้ว "ชนกัน" จะกลายเป็น "ชนก"
const IDENT = '(?:[\\p{L}_][\\p{L}\\p{M}\\p{N}_$]*\\.)?"?[\\p{L}_][\\p{L}\\p{M}\\p{N}_$]*"?'
const KIND = '(function|view|procedure|materialized\\s+view)'
const DEFINES = new RegExp('\\bcreate\\s+(?:or\\s+replace\\s+)?' + KIND + '\\s+(' + IDENT + ')', 'giu')
const DROPS = new RegExp('\\bdrop\\s+' + KIND + '\\s+(?:if\\s+exists\\s+)?(' + IDENT + ')', 'giu')

const bodies = new Map()
const defines = new Map() // "kind schema.name" -> [ไฟล์ เรียงตาม ORDER.txt]
const drops = new Map()   // ไฟล์ -> Set ของ "kind schema.name" ที่ไฟล์นั้น drop ทิ้งก่อน
for (const f of order) {
  if (!onDisk.includes(f)) continue
  const raw = readFileSync(join(HERE, f), 'utf8')
  bodies.set(f, raw)
  const clean = stripComments(raw)
  const key = (m) => m[1].toLowerCase().replace(/\s+/g, ' ') + ' ' + m[2].toLowerCase().replace(/"/g, '')
  for (const m of clean.matchAll(DEFINES)) {
    const k = key(m)
    if (!defines.has(k)) defines.set(k, [])
    if (!defines.get(k).includes(f)) defines.get(k).push(f)
  }
  drops.set(f, new Set([...clean.matchAll(DROPS)].map(key)))
}

// ── ด่าน 1.5: ภาษาไทยเพี้ยน (UTF-8 → cp874) ─────────────────────────
// ★ ไฟล์ที่เพี้ยนรันผ่านได้ปกติ ไม่มี error — สตริงเพี้ยนไปโผล่ในแชท/แจ้งเตือนแทน
//   จึงต้องหยุดตั้งแต่ตรงนี้ ก่อน plan/apply ลงฐาน (ดู sql/mojibake.mjs)
for (const [f, raw] of bodies) {
  const lines = mojibakeLines(raw)
  if (lines.length) problems.push(f + ' มีภาษาไทยเพี้ยน (เซฟผ่าน PowerShell 5/cp874?) บรรทัด '
    + lines.slice(0, 5).join(', ') + (lines.length > 5 ? ' …รวม ' + lines.length + ' บรรทัด' : ''))
}

const objectsOf = (f) => new Set([...defines].filter(([, fs]) => fs.includes(f)).map(([k]) => k))

// ── ด่าน 2: เลขนำหน้าซ้ำ ─────────────────────────────────────────────
const byPrefix = new Map()
for (const f of order) {
  const p = /^(\d+)_/.exec(f)
  if (!p) continue
  if (!byPrefix.has(p[1])) byPrefix.set(p[1], [])
  byPrefix.get(p[1]).push(f)
}
for (const [p, files] of byPrefix) {
  if (files.length < 2) continue
  // เลขซ้ำไม่อันตรายด้วยตัวมันเอง อันตรายตอนที่คู่นั้นแตะของชิ้นเดียวกัน จึงบอกให้ครบ
  const a = objectsOf(files[0])
  const shared = [...objectsOf(files[1])].filter((o) => a.has(o))
  warnings.push(shared.length
    ? red('เลข ' + p + ' ซ้ำ และทั้งสองไฟล์แตะของชิ้นเดียวกัน: ' + shared.join(', ') + ' — ลำดับใน ORDER.txt สำคัญ')
    : 'เลข ' + p + ' ซ้ำ (' + files.join(' , ') + ') แต่คนละของ สลับลำดับกันได้')
}

// ── ด่าน 3: ของชิ้นเดียวกันถูกเขียนทับหลายไฟล์ ───────────────────────
const clashes = [...defines].filter(([, fs]) => fs.length > 1)

// ── รายงานส่วนที่ไม่ต้องต่อฐาน ───────────────────────────────────────
console.log('\nลำดับใน ORDER.txt: ' + order.length + ' ไฟล์   ในโฟลเดอร์: ' + onDisk.length + ' ไฟล์\n')

if (clashes.length) {
  // ★ แยกสองกรณีให้ออก ไม่ใช่เหมารวมว่า "ทับ" เหมือนกันหมด:
  //     drop ก่อน create = ตั้งใจเปลี่ยนลายเซ็น มีคนคิดมาแล้ว (เช่น 012 ที่
  //       drop reply_report(date) ทิ้งก่อนสร้างตัวสองอาร์กิวเมนต์ ไม่งั้นจะได้
  //       overload สองตัวแล้วการเรียกแบบอาร์กิวเมนต์เดียวจะกำกวมทันที)
  //     ทับเฉย ๆ       = ของเก่าหายเงียบ ถ้าคนเขียนไฟล์หลังไม่ได้คัดของเดิมมาครบ
  //   กรณีหลังคือกับดักที่ sql/015 เตือนไว้ และเป็นตัวที่ต้องจ้องเวลารีวิว
  const silent = clashes.filter(([k, fs]) => fs.slice(1).some((f) => !drops.get(f)?.has(k)))
  console.log('ของที่ถูกเขียนทับมากกว่าหนึ่งไฟล์ — ตัวท้ายสุดคือตัวที่ได้ใช้จริง'
    + dim('  (' + silent.length + ' ชิ้นถูกทับแบบไม่ drop ก่อน)'))
  for (const [key, fs] of clashes) {
    console.log('  ' + yellow(key))
    fs.forEach((f, i) => {
      const tag = i === fs.length - 1 ? green('   <- ตัวนี้ชนะ') : dim('   (ถูกทับ)')
      const how = i > 0 ? (drops.get(f)?.has(key) ? dim('  [drop ก่อน]') : red('  [ทับเฉย ๆ]')) : ''
      console.log('      ' + (i + 1) + '. ' + f + tag + how)
    })
  }
  console.log(dim('\n  หมายเหตุ: เทียบด้วยชื่อ ไม่ได้เทียบลายเซ็น — ฟังก์ชันที่ตั้งใจทำ overload\n'
    + '  (คนละชุดอาร์กิวเมนต์) จะขึ้นในรายการนี้ด้วย ดูคอลัมน์ [drop ก่อน] ประกอบ') + '\n')
}

for (const w of warnings) console.log('เตือน: ' + w)
if (warnings.length) console.log('')

if (problems.length) {
  for (const p of problems) console.log(red('ผิดพลาด: ' + p))
  console.log('')
  process.exit(1)
}

if (mode === 'check') {
  console.log(green('ตรวจผ่าน') + '  ' + dim('(โหมด check ไม่ต่อฐาน — ใช้ plan/apply เพื่อเทียบกับทะเบียน)') + '\n')
  process.exit(0)
}

if (mode !== 'plan' && mode !== 'apply') {
  console.log(red('โหมดที่รู้จัก: check | plan | apply'))
  process.exit(1)
}

if (!DB) {
  console.log(red('โหมด ' + mode + ' ต้องมี --db "<connection string>" หรือตั้ง DATABASE_URL'))
  process.exit(1)
}

// ── ด่าน 4: เทียบกับทะเบียนในฐาน ─────────────────────────────────────
const psql = (args) => execFileSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' })

let applied
try {
  const out = psql(['-A', '-t', '-c', 'select filename, sha256 from inbox.sql_applied'])
  applied = new Map(out.trim().split('\n').filter(Boolean).map((l) => l.split('|')))
} catch {
  applied = null // ตารางยังไม่มี = ยังไม่เคยลงอะไรผ่านตัวรันนี้
}
if (applied === null) {
  console.log(dim('ยังไม่มีตาราง inbox.sql_applied — _ledger.sql จะสร้างให้เป็นไฟล์แรก\n'))
  applied = new Map()
}

const todo = []
for (const f of order) {
  const digest = sha(bodies.get(f))
  const seen = applied.get(f)
  if (!seen) { todo.push({ f, digest, why: 'ยังไม่เคยลง' }); continue }
  if (seen !== digest) {
    // อันตรายกว่าไฟล์ใหม่ — ของที่ลงไปแล้วไม่ตรงกับไฟล์ในมือ แปลว่าฐานเป็นคนละรุ่น
    // กับที่เห็นในโฟลเดอร์ รันทับไปเฉย ๆ จะกลบความต่างนั้นโดยไม่มีใครรู้
    problems.push(f + ' ถูกแก้หลังจากลงฐานไปแล้ว (ทะเบียน ' + seen.slice(0, 12) +
      ' ≠ ไฟล์ปัจจุบัน ' + digest.slice(0, 12) + ')')
    continue
  }
  console.log(dim('ข้าม  ' + f + '  (ลงแล้ว ' + seen.slice(0, 12) + ')'))
}

if (problems.length) {
  console.log('')
  for (const p of problems) console.log(red('ผิดพลาด: ' + p))
  console.log(red('\nหยุด — ตรวจว่าฐานเป็นรุ่นไหนก่อน อย่ารันทับ\n'))
  process.exit(1)
}

if (!todo.length) {
  console.log(green('\nไม่มีอะไรต้องรัน ฐานตรงกับ ORDER.txt แล้ว\n'))
  process.exit(0)
}

console.log('\nจะรัน ' + todo.length + ' ไฟล์:')
for (const t of todo) console.log('  ' + t.f + '  ' + dim(t.why))

if (mode === 'plan') {
  console.log(dim('\n(โหมด plan — ไม่ได้แตะฐาน)') + '\n')
  process.exit(0)
}

console.log('')
for (const t of todo) {
  process.stdout.write('รัน ' + t.f + ' ... ')
  try {
    psql(['-q', '-f', join(HERE, t.f)])
  } catch (err) {
    console.log(red('ล้มเหลว'))
    if (err.stdout) console.log(err.stdout)
    if (err.stderr) console.log(err.stderr)
    console.log(red('\nหยุดที่ ' + t.f + ' — ไฟล์ก่อนหน้าลงและบันทึกทะเบียนแล้ว แก้เสร็จรันซ้ำได้เลย\n'))
    process.exit(1)
  }
  // บันทึกหลังไฟล์ผ่านเท่านั้น ไฟล์ที่พังกลางทางจะไม่ถูกนับว่าลงแล้ว
  psql(['-q', '-c', "insert into inbox.sql_applied(filename, sha256) values ('" + t.f + "', '" + t.digest +
    "') on conflict (filename) do update set sha256 = excluded.sha256, applied_at = now(), applied_by = current_user"])
  console.log(green('ผ่าน'))
}
console.log(green('\nลงครบ ' + todo.length + ' ไฟล์\n'))
