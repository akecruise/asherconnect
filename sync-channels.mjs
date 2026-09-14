/**
 * เติมค่า LINE / Facebook Messenger ลง channels.json จากไฟล์ secrets ของระบบเดิม
 *
 *   node sync-channels.mjs                    # ดูว่าจะเติมอะไรบ้าง ไม่เขียนไฟล์
 *   node sync-channels.mjs --apply            # เขียนจริง
 *   node sync-channels.mjs --apply --secrets D:/secrets/mkt18-secrets.php
 *
 * ทำไมต้องมีไฟล์นี้ แทนที่จะก็อป token มาวางเอง:
 * ระบบเดิมยังใช้ไฟล์ secrets อยู่ ถ้าก็อปค่าออกมาอีกชุดจะกลายเป็นสองแหล่งความจริง
 * วันที่ token หมุน จะมีที่เดียวที่ถูกอัปเดต แล้วอีกที่เงียบ ๆ พัง
 * รันไฟล์นี้ซ้ำหลัง token หมุนได้เลย ไม่ต้องแก้มือ
 *
 * ★ ไฟล์นี้ไม่พิมพ์ค่า token ออกมาสักตัว พิมพ์แค่ว่า "ตั้งไว้กี่ตัวอักษร"
 *   ยกเว้น verify_token ของ Messenger ที่สุ่มขึ้นมาเอง เพราะต้องเอาไปวางใน Meta console
 *
 * ★ ค่าที่ไม่ได้อยู่ในไฟล์ secrets ไฟล์นี้จะไปถามปลายทางเอง
 *   LINE  → /v2/bot/info ได้ Bot user ID ที่ใช้เทียบ field destination ของทุก webhook
 *   Meta  → /me/accounts ได้ Page ID และเช็คว่ามีสิทธิ์ pages_messaging หรือยัง
 *           ถ้าไม่มีสิทธิ์นี้ จะรับข้อความได้แต่ตอบกลับไม่ได้ ซึ่งเป็นอาการที่ไล่หาสาเหตุยากมาก
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APPLY = process.argv.includes('--apply')
const SECRETS = (() => {
  const i = process.argv.indexOf('--secrets')
  if (i > -1) return process.argv[i + 1]
  for (const p of ['D:/secrets/mkt18-secrets.php',
                   'D:/APlusMKT/secrets/Asher_ERP-secrets.php',
                   'D:/APlusMKT/secrets/mkt18-secrets.php']) if (existsSync(p)) return p
  return null
})()

const mask = (v) => (v ? `ตั้งไว้ (${v.length} ตัวอักษร)` : 'ไม่มี')
const notes = []

/** รองรับทั้ง 'k' => 'v' และ "k" => "v" · ทั้งแบบ array(...) และ [...] */
function readPhpValue(src, ...keys) {
  for (const key of keys) {
    const m = src.match(new RegExp(`['"]${key}['"]\\s*=>\\s*(['"])([\\s\\S]*?)\\1`))
    if (m && m[2].trim()) return m[2].trim()
  }
  return ''
}

async function getJson(url, options = {}) {
  try {
    const r = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return { error: data?.error?.message || `HTTP ${r.status}` }
    return data
  } catch (e) {
    return { error: e.message }
  }
}

if (!SECRETS || !existsSync(SECRETS)) {
  console.error('ไม่พบไฟล์ secrets — ระบุด้วย --secrets <path>')
  process.exit(1)
}

const src = readFileSync(SECRETS, 'utf8')
const path = join(HERE, 'channels.json')
const channels = JSON.parse(readFileSync(path, 'utf8'))
let changed = 0

console.log(`\nไฟล์ secrets : ${SECRETS}`)

// ══════════════════════════════════════════════════ LINE
const lineToken = readPhpValue(src, 'channel_access_token')
const lineSecret = readPhpValue(src, 'channel_secret')
const line = channels.find((c) => c.channel === 'line')

console.log('\n── LINE Official Account')
console.log(`  channel_secret       : ${mask(lineSecret)}`)
console.log(`  channel_access_token : ${mask(lineToken)}`)

if (!line) {
  notes.push('channels.json ไม่มีรายการช่องทาง line')
} else if (!lineToken || !lineSecret) {
  notes.push('ไฟล์ secrets ไม่มีค่าของ LINE ครบ — ต้องมีทั้ง channel_secret และ channel_access_token')
} else {
  const info = await getJson('https://api.line.me/v2/bot/info',
    { headers: { Authorization: `Bearer ${lineToken}` } })
  if (info.error) {
    notes.push(`ถาม LINE ไม่สำเร็จ: ${info.error} — ถ้า token ยังใช้ได้ ให้ใส่ account_id เองใน channels.json (ขึ้นต้นด้วย U)`)
  } else {
    console.log(`  บัญชี                : ${info.displayName} (${info.basicId})`)
    console.log(`  Bot user ID          : ${info.userId}`)
    line.account_id = info.userId
    line.secret = lineSecret
    line.access_token = lineToken
    line.enabled = true
    changed++
    console.log('  → พร้อมเปิดใช้')
  }
}

// ══════════════════════════════════════════════════ Facebook Messenger
const metaToken = readPhpValue(src, 'page_access_token', 'access_token')
const metaSecret = readPhpValue(src, 'app_secret', 'meta_app_secret', 'client_secret', 'secret_key')
const fb = channels.find((c) => c.channel === 'messenger')

console.log('\n── Facebook Messenger')
console.log(`  app_secret           : ${mask(metaSecret)}`)
console.log(`  access_token         : ${mask(metaToken)}`)

if (!fb) {
  notes.push('channels.json ไม่มีรายการช่องทาง messenger')
} else if (!metaToken) {
  notes.push('ไฟล์ secrets ไม่มี access_token ของ Meta')
} else {
  // เพจไหน และ token ของเพจตัวไหน
  const accounts = await getJson(
    `https://graph.facebook.com/${fb.api_version || 'v23.0'}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(metaToken)}`)
  let pageToken = ''
  if (accounts.error) {
    notes.push(`ถาม Meta เรื่องเพจไม่สำเร็จ: ${accounts.error}`)
  } else {
    const pages = accounts.data ?? []
    console.log(`  เพจที่ token นี้เข้าถึงได้ : ${pages.length ? pages.map((p) => `${p.name} (${p.id})`).join(', ') : 'ไม่มีเลย'}`)
    const target = pages.find((p) => p.id === fb.account_id) || pages[0]
    if (target) {
      if (target.id !== fb.account_id) {
        notes.push(`channels.json ตั้ง account_id เป็น ${fb.account_id} แต่ token เข้าถึงเพจ ${target.id} (${target.name}) — ใช้ของ token`)
        fb.account_id = target.id
      }
      // ★ ต้องใช้ token ของ "เพจ" ไม่ใช่ token ของผู้ใช้ ไม่งั้นส่งข้อความไม่ได้
      pageToken = target.access_token || ''
    }
  }

  // สิทธิ์ที่ขาดบ่อยที่สุดและเจ็บที่สุด
  const perms = await getJson(
    `https://graph.facebook.com/${fb.api_version || 'v23.0'}/me/permissions?access_token=${encodeURIComponent(metaToken)}`)
  let canMessage = false
  if (!perms.error) {
    const granted = (perms.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission)
    canMessage = granted.includes('pages_messaging')
    console.log(`  สิทธิ์ pages_messaging : ${canMessage ? 'มี' : 'ไม่มี'}`)
    if (!canMessage) {
      notes.push('token Meta ไม่มีสิทธิ์ pages_messaging — จะรับข้อความได้แต่ตอบกลับลูกค้าไม่ได้ ' +
        'ต้อง generate token ใหม่ที่ Meta for Developers โดยติ๊ก pages_messaging มาด้วย')
    }
  }

  if (!metaSecret) {
    notes.push('ไม่พบ app_secret ของ Meta ในไฟล์ secrets — ถ้าคีย์ชื่ออื่น บอกชื่อคีย์มา จะเพิ่มให้')
  }

  const token = pageToken || metaToken
  if (metaSecret && token && fb.account_id && canMessage) {
    fb.secret = metaSecret
    fb.access_token = token
    fb.verify_token ||= 'asher-' + randomBytes(12).toString('hex')
    fb.enabled = true
    changed++
    console.log(`  verify_token         : ${fb.verify_token}   ← เอาค่านี้ไปวางใน Meta console`)
    console.log('  → พร้อมเปิดใช้')
  } else {
    // เก็บค่าที่ได้ไว้ก่อน แต่ไม่เปิด เพราะเปิดทั้งที่ไม่ครบจะกลายเป็นรับได้แต่ตอบไม่ได้
    if (metaSecret) fb.secret = metaSecret
    if (token) fb.access_token = token
    fb.enabled = false
    console.log('  → ยังไม่เปิด (ดูรายการที่ขาดด้านล่าง)')
  }
}

// ══════════════════════════════════════════════════ สรุป
if (notes.length) {
  console.log('\nเรื่องที่ต้องรู้')
  for (const n of notes) console.log(`  • ${n}`)
}

console.log(`\nช่องทางที่จะเปิดใช้: ${channels.filter((c) => c.enabled).map((c) => c.key).join(', ') || 'ไม่มี'}`)

if (!APPLY) {
  console.log('\nนี่คือโหมดดูอย่างเดียว — ใส่ --apply เพื่อเขียนจริง\n')
  process.exit(0)
}

copyFileSync(path, path + '.bak')
writeFileSync(path, JSON.stringify(channels, null, 2) + '\n')
console.log(`\nเขียนแล้ว: ${path} (สำรองของเดิมไว้ที่ channels.json.bak)`)
console.log('ขั้นต่อไป:')
console.log('  docker restart asher-connect')
console.log('  cd ../asher-web && npm run smoke:channel\n')
