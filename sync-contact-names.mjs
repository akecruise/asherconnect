/**
 * เติมชื่อ/อีเมลของลูกค้า Messenger ลง core.contact
 *
 *   node sync-contact-names.mjs            ทำจริง
 *   node sync-contact-names.mjs --dry      ดูว่าจะได้อะไรบ้าง ไม่เขียนฐาน
 *   node sync-contact-names.mjs --pages 5  จำกัดจำนวนหน้าที่ไล่ (ค่าเริ่มต้น 10)
 *
 * ทำไมต้องมีไฟล์นี้:
 * webhook ของ Messenger ให้มาแต่ PSID ซึ่งเป็นเลขทึบ ๆ บอกไม่ได้ว่าใคร
 * และ `GET /{PSID}?fields=name` เรียกไม่ได้ — ต้องมีสิทธิ์ pages_user_profile ซึ่งยังไม่มี
 * แต่ `GET /{page}/conversations?fields=participants` คืนทั้ง name และ email
 * ด้วยสิทธิ์ pages_messaging ที่มีอยู่แล้ว จึงเป็นทางที่ทำได้วันนี้โดยไม่ต้องยื่นขอสิทธิ์
 *
 * ★ ได้เป็นรอบ ไม่ใช่ทันที — เป็นข้อแลกของทางนี้ ไม่ใช่ข้อบกพร่องของสคริปต์
 * ★ ชื่อจาก Facebook ไม่ใช่ชื่อจริงเสมอ การตัดสินว่าจะเขียนทับอะไรอยู่ในฐาน
 *   (inbox.sync_contact_profile) ไม่ได้อยู่ในไฟล์นี้ ดูเหตุผลใน sql/022
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const DRY = process.argv.includes('--dry')
const MAX_PAGES = Number(arg('pages', 10))

const upstream = process.env.SUPABASE_URL
const anon = process.env.SUPABASE_ANON_KEY
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!upstream || !anon || !service) throw new Error('ต้องมี SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')

const channelsFile = process.env.CONNECT_CHANNELS_FILE || join(root, 'channels.json')
const channels = JSON.parse(await readFile(channelsFile, 'utf8'))
const targets = channels.filter(c => c.channel === 'messenger' && c.enabled === true && c.account_id && c.access_token)
if (!targets.length) { console.log('ไม่มีช่องทาง messenger ที่เปิดใช้อยู่'); process.exit(0) }

/**
 * ไล่กล่องข้อความของเพจทีละหน้า
 *
 * ★ เพจอยู่ใน participants ด้วย ต้องคัดออกด้วยการเทียบกับ account_id
 *   ไม่ใช่เดาจากลำดับ — ลำดับไม่คงที่ และบางเหตุการณ์เพจอยู่ตัวแรก บางเหตุการณ์อยู่ตัวหลัง
 *   (เหตุผลเดียวกับที่ providers.mjs ต้องอ่าน recipient ตอน echo ไม่ใช่ sender)
 */
async function collect(config) {
  const version = config.api_version || 'v23.0'
  let url = `https://graph.facebook.com/${version}/${config.account_id}/conversations`
         + `?platform=MESSENGER&fields=participants,updated_time&limit=100`
  const people = new Map()

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.access_token}` },
      signal: AbortSignal.timeout(20000),
    })
    const data = await response.json().catch(() => ({}))
    if (data.error) throw new Error(`Graph API: ${data.error.message}`)

    for (const conversation of data.data || []) {
      for (const p of conversation.participants?.data || []) {
        if (!p.id || p.id === config.account_id) continue      // ตัวเพจเอง ไม่ใช่ลูกค้า
        if (!p.name && !p.email) continue                       // ไม่มีอะไรให้เติม
        people.set(p.id, { external_id: p.id, name: p.name ?? null, email: p.email ?? null })
      }
    }
    url = data.paging?.next || null
  }
  return [...people.values()]
}

const rpc = async (action, body) => {
  const response = await fetch(`${upstream}/rest/v1/rpc/${action}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json',
               'Content-Profile': 'inbox', 'Accept-Profile': 'inbox' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${action}: HTTP ${response.status} ${data.message ?? ''}`)
  return data
}

let total = 0
for (const config of targets) {
  const people = await collect(config)
  total += people.length
  console.log(`\n${config.name || config.key} — พบลูกค้าที่มีชื่อ ${people.length} คน`)

  if (DRY) {
    // โหมดลองดู: ไม่เขียนฐาน และไม่พิมพ์ชื่อเต็มออกมา เพราะเป็นข้อมูลส่วนบุคคล
    for (const p of people.slice(0, 5)) {
      console.log(`   ${p.external_id.slice(0, 5)}… · ชื่อ ${p.name ? p.name.slice(0, 2) + '…' : '(ไม่มี)'}`
                + ` · อีเมล ${p.email ? 'มี' : 'ไม่มี'}`)
    }
    if (people.length > 5) console.log(`   … อีก ${people.length - 5} คน`)
    continue
  }

  // ส่งทีละ 200 คน ไม่ยัดก้อนเดียว — ก้อนใหญ่เกินจะชน statement timeout ของ PostgREST
  for (let i = 0; i < people.length; i += 200) {
    const batch = people.slice(i, i + 200)
    const r = await rpc('sync_contact_profile', { p_data: { channel: 'messenger', people: batch } })
    console.log(`   เติมชื่อใหม่ ${r.named} · มีชื่ออยู่แล้วไม่แตะ ${r.kept}`
              + ` · ยังไม่เคยคุยผ่านระบบ ${r.unknown} · ขอลบข้อมูลแล้วข้ามไป ${r.skipped}`)
  }
}

console.log(`\nรวมลูกค้าที่ไล่เจอ ${total} คน${DRY ? ' (โหมดลองดู ไม่ได้เขียนฐาน)' : ''}`)
