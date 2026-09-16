/**
 * เปลี่ยน App Secret / Page Access Token ของช่องทาง Messenger ใน channels.json
 *
 *   node set-meta-credentials.mjs
 *   (แล้วพิมพ์ App Secret กด Enter · พิมพ์ Page Access Token กด Enter)
 *
 * ★ รับค่าทาง stdin ไม่ใช่ argument — ค่าลับจึงไม่โผล่ใน `ps` และไม่ติดใน history
 * ★ ไม่พิมพ์ค่าที่ใส่ออกมาเลย แสดงแค่ 6 ตัวท้ายไว้ยืนยันว่าวางถูกใบ
 *
 * ทำไมต้องมีไฟล์นี้แทนที่จะแก้ channels.json ตรง ๆ:
 * ใส่ secret ผิดใบแล้วจะไม่มีอะไรฟ้องจนกว่า Facebook จะยิงเข้ามาแล้วโดนปัดทิ้ง
 * ซึ่งเงียบมาก — เคยเกิดมาแล้ว 15 ก.ย. 2026 คำขอจริงของลูกค้าถูกปฏิเสธ 400+ ครั้ง
 * โดยหน้าจอไม่มีอะไรบอก สคริปต์นี้จึงตรวจกับ Facebook ให้ก่อนเขียนไฟล์
 *   1. token ใช้ได้จริงไหม และเป็นของแอปไหน
 *   2. secret ที่ให้มา เป็นของแอปเดียวกับ token นั้นไหม
 *   3. เพจที่ token ถืออยู่ ตรงกับ account_id ที่ตั้งไว้ไหม
 * ผิดข้อใดข้อหนึ่ง = ไม่เขียนไฟล์
 */
import { readFileSync, writeFileSync, statSync, chmodSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.CONNECT_CHANNELS_FILE || join(HERE, 'channels.json')
const KEY = process.argv[2] || 'asher-messenger'
const tail = v => '…' + String(v).slice(-6)

const channels = JSON.parse(readFileSync(FILE, 'utf8'))
const target = channels.find(c => c.key === KEY)
if (!target) { console.error(`ไม่พบช่องทาง key=${KEY} ใน ${FILE}`); process.exit(1) }
if (target.channel !== 'messenger') { console.error(`${KEY} ไม่ใช่ช่องทาง messenger`); process.exit(1) }

// รับได้สองทาง: พิมพ์เองตอนรันบนเครื่อง หรือ pipe สองบรรทัดเข้ามา (secret แล้ว token)
// ★ ทาง pipe ต้องอ่านทั้งก้อนทีเดียว ใช้ readline ถามทีละคำถามไม่ได้ —
//   คำถามที่สองจะเจอ EOF แล้วค้างตลอดกาล (unsettled top-level await)
let secret, token
if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  secret = (await rl.question('App Secret ของแอปตัวจริง: ')).trim()
  token = (await rl.question('Page Access Token ของเพจ: ')).trim()
  rl.close()
} else {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (lines.length < 2) { console.error('ต้อง pipe สองบรรทัด: App Secret แล้วตามด้วย Page Access Token'); process.exit(1) }
  ;[secret, token] = lines
}
if (!secret || !token) { console.error('ต้องใส่ทั้งสองค่า'); process.exit(1) }

const version = target.api_version || 'v23.0'
const ask = async url => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
  return r.json().catch(() => ({}))
}

// ── 1) token เป็นของแอปไหน และยังใช้ได้ไหม
const dbg = await ask(`https://graph.facebook.com/${version}/debug_token`
  + `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`)
if (dbg.error) { console.error('ตรวจ token ไม่ผ่าน: ' + dbg.error.message); process.exit(1) }
const info = dbg.data ?? {}
if (!info.is_valid) { console.error('token นี้ใช้ไม่ได้แล้ว'); process.exit(1) }
if (info.type !== 'PAGE') { console.error(`ต้องเป็น Page Access Token ไม่ใช่ ${info.type}`); process.exit(1) }

// ── 2) secret เป็นของแอปเดียวกับ token ไหม — ข้อที่พลาดกันบ่อยที่สุด
const app = await ask(`https://graph.facebook.com/${version}/oauth/access_token`
  + `?grant_type=client_credentials&client_id=${encodeURIComponent(info.app_id)}`
  + `&client_secret=${encodeURIComponent(secret)}`)
if (app.error) {
  console.error(`App Secret ไม่ใช่ของแอป ${info.app_id} (${info.application || 'ไม่ทราบชื่อ'})`)
  console.error('  Facebook ตอบ: ' + app.error.message)
  console.error('  ★ นี่คือกรณีที่ลายเซ็นจะไม่มีวันตรง แล้ว webhook จะถูกปัดทิ้งเงียบ ๆ ทุกใบ')
  process.exit(1)
}

// ── 3) token ถือเพจตรงกับที่ตั้งไว้ไหม
const me = await ask(`https://graph.facebook.com/${version}/me?fields=id&access_token=${encodeURIComponent(token)}`)
const pageId = me.id ?? null
if (pageId && target.account_id && pageId !== target.account_id) {
  console.error(`token เป็นของเพจ ${pageId} แต่ channels.json ตั้ง account_id ไว้เป็น ${target.account_id}`)
  process.exit(1)
}

// ── ผ่านหมด ค่อยเขียน
const mode = statSync(FILE).mode
copyFileSync(FILE, FILE + '.bak-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))
target.secret = secret
target.access_token = token
// เขียนทับ inode เดิม เจ้าของไฟล์จึงไม่เปลี่ยน — channels.json ต้องเป็นของ uid 1000
writeFileSync(FILE, JSON.stringify(channels, null, 2) + '\n', { encoding: 'utf8' })
chmodSync(FILE, mode & 0o777)

console.log(`\nเขียนลง ${FILE} แล้ว`)
console.log(`  แอป        : ${info.app_id} · ${info.application || '(ไม่ทราบชื่อ)'}`)
console.log(`  เพจ        : ${pageId || target.account_id}`)
console.log(`  secret     : ${tail(secret)}`)
console.log(`  token      : ${tail(token)}`)
console.log(`  scopes     : ${(info.scopes || []).join(', ')}`)
console.log('\nขั้นต่อไป: docker compose up -d --force-recreate asher-connect')
