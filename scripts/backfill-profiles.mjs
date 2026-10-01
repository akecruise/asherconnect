/**
 * เติมชื่อ/รูปโปรไฟล์ให้ contact ที่ยังไม่มีชื่อ
 *
 *   node scripts/backfill-profiles.mjs --dry-run     ดูว่าจะทำอะไรบ้าง ไม่เขียนอะไร
 *   node scripts/backfill-profiles.mjs               ทำจริง
 *   node scripts/backfill-profiles.mjs --limit 50    จำกัดจำนวนต่อรอบ
 *   node scripts/backfill-profiles.mjs --stale       รวมคนที่ดึงไว้เกิน 7 วันด้วย
 *   node scripts/backfill-profiles.mjs --channel line  เฉพาะ LINE
 *
 * ★ อ่าน token จาก channels.json เท่านั้น ไม่มี token ในฐานและไม่พิมพ์ออกจอ
 * ★ ไม่พิมพ์ชื่อหรือ id ของลูกค้า — พิมพ์แค่ช่องทาง จำนวน และรหัสผลลัพธ์
 * ★ หน่วง 200ms ระหว่างคน เพื่อไม่ให้ชนโควตาของ LINE/Meta
 */
import { readFile } from 'node:fs/promises'
import { fetchProfile } from '../lib/profile.mjs'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const STALE = args.includes('--stale')
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 500
const channelAt = args.indexOf('--channel')
const CHANNEL = channelAt > -1 ? args[channelAt + 1] : null
const DELAY_MS = 200

const upstream = process.env.SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
const channelsFile = process.env.CONNECT_CHANNELS_FILE || './channels.json'
if (!upstream || !service) { console.error('ต้องมี SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function rpc(fn, body) {
  const r = await fetch(`${upstream}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json',
               // ★ ตัวห่ออยู่ที่ inbox.connect_worker — ไม่บอกโปรไฟล์ PostgREST จะไปหาใน public แล้วได้ 404 (PGRST202)
               'Content-Profile': 'inbox', 'Accept-Profile': 'inbox' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`${fn} -> HTTP ${r.status}`)
  return r.json()
}

// PostgREST อ่านตารางตรง ๆ ไม่ได้ (RLS + สคีมา core ไม่ได้ expose)
// จึงถามผ่าน RPC ที่มีอยู่แล้วทีละคน โดยใช้รายชื่อจาก connect_worker('profile_state')
// รายชื่อ "ใครบ้าง" ต้องมาจากฐาน — ที่นี่ขอผ่าน worker action เดิมไม่ได้
// จึงใช้ list ของ identity ที่ส่งมาทาง argument แทน (ดู --help ใน README)
async function candidates() {
  // ใช้ profile_state เป็นตัวตัดสินรายคน แต่ต้องรู้ก่อนว่ามีใครบ้าง
  // -> อ่านจาก view ที่ migration สร้างไว้ ผ่าน RPC เดียวกัน
  return rpc('connect_worker', { p_action: 'profile_backlog', p_data: {
    limit: LIMIT, include_stale: STALE, channel: CHANNEL,
  } })
}

const channels = JSON.parse(await readFile(channelsFile, 'utf8'))
const byInbox = new Map(channels.map(c => [c.inbox_id, c]))

console.log(`โหมด: ${DRY ? 'ดูอย่างเดียว (--dry-run)' : 'ทำจริง'}` +
            `  ·  สูงสุด ${LIMIT} ราย  ·  ${STALE ? 'รวมคนที่เกิน 7 วัน' : 'เฉพาะคนที่ยังไม่มีชื่อ'}` +
            `  ·  ช่องทาง ${CHANNEL || 'ทั้งหมด'}`)

let rows
try {
  rows = await candidates()
} catch (e) {
  console.error('ดึงรายชื่อไม่สำเร็จ: ' + e.message)
  process.exit(1)
}

if (!Array.isArray(rows) || rows.length === 0) { console.log('ไม่มีใครต้องเติมชื่อ'); process.exit(0) }
console.log(`พบ ${rows.length} ราย\n`)

const tally = { ok: 0, not_found: 0, error: 0, skipped_no_channel: 0 }
const errorCodes = new Map()

for (const [i, row] of rows.entries()) {
  const config = byInbox.get(row.account_key)
  if (!config || !config.access_token) {
    tally.skipped_no_channel++
    console.log(`  [${i + 1}/${rows.length}] ${row.channel} — ข้าม: ไม่มีช่องทางที่ตรงกับ inbox นี้ใน channels.json`)
    continue
  }

  const source = row.group_id ? { type: 'group', id: row.group_id } : { type: 'user' }
  const p = await fetchProfile({ channel: row.channel, externalId: row.external_id, config, source })
  tally[p.status] = (tally[p.status] ?? 0) + 1
  if (p.status === 'error') errorCodes.set('error', (errorCodes.get('error') ?? 0) + 1)

  const got = p.status === 'ok' ? (p.display_name ? 'ได้ชื่อ' : 'ได้ 200 แต่ไม่มีชื่อ') : p.status
  console.log(`  [${i + 1}/${rows.length}] ${row.channel.padEnd(10)} ${got}${DRY ? '  (ไม่ได้เขียน)' : ''}`)

  if (!DRY) {
    try {
      await rpc('connect_worker', { p_action: 'profile_update', p_data: {
        channel: row.channel, account_key: row.account_key, external_id: row.external_id,
        display_name: p.display_name, picture_url: p.picture_url, status: p.status,
      } })
    } catch (e) {
      console.log(`      เขียนกลับไม่สำเร็จ: ${e.message}`)
    }
  }

  if (i < rows.length - 1) await sleep(DELAY_MS)
}

console.log('\n── สรุป ──')
console.log(`  ok        : ${tally.ok}`)
console.log(`  not_found : ${tally.not_found}   (ลูกค้าบล็อกหรือไม่ได้แอดเพื่อน)`)
console.log(`  error     : ${tally.error}`)
if (tally.skipped_no_channel) console.log(`  ข้าม      : ${tally.skipped_no_channel}   (ไม่มีช่องทางใน channels.json)`)
if (DRY) console.log('\n  นี่คือโหมดดูอย่างเดียว — ไม่ได้เขียนอะไรลงฐาน')
