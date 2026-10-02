// ติดดาว · การติดตาม · Tag — ส่วนที่ไม่แตะ DOM แยกไว้ที่นี่ให้เทสต์ด้วย node ได้
// (spec: docs/handoff/2026-10-01-star-follow-tags.md)

// palette ตายตัว ต้องตรงกับ check constraint ของ connect_private.tag
// ★ ไม่มีแดง — แดงแบรนด์สงวนไว้ให้ SLA/error เท่านั้น
export const TAG_COLORS = ['grey', 'blue', 'green', 'amber', 'purple', 'pink', 'teal']
export const TAG_COLOR_NAMES = { grey: 'เทา', blue: 'น้ำเงิน', green: 'เขียว', amber: 'อำพัน', purple: 'ม่วง', pink: 'ชมพู', teal: 'เขียวอมฟ้า' }
export const tagColor = c => TAG_COLORS.includes(c) ? c : 'grey'

// ตัวกรองใหม่ที่ไปทาง flag_list — ตัวกรองเดิมยังไปทาง list ของ connect_api
export const isFlagFilter = f => f === 'starred' || (typeof f === 'string' && f.startsWith('tag:'))
export function flagListArgs(filter, search, offset) {
  if (filter === 'starred') return { filter: 'starred', search, offset }
  return { filter: 'tag', tag_id: filter.slice(4), search, offset }
}

const BKK = 7 * 3600000
// เวลาไทย 10:00 ของวันที่ +days นับจากวันนี้ (เวลาไทย) → ISO UTC
export function bkkAt(now, days, hour = 10) {
  const local = new Date(now + BKK)
  const d = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour) - BKK
  return new Date(d).toISOString()
}
export function followPresets(now = Date.now()) {
  return [
    { key: 'tomorrow', label: 'พรุ่งนี้ 10:00', at: bkkAt(now, 1) },
    { key: '3d', label: '3 วัน', at: bkkAt(now, 3) },
    { key: '1w', label: '1 สัปดาห์', at: bkkAt(now, 7) },
  ]
}

// ป้ายบนการ์ด: ⏰ 3 ต.ค. · เลยกำหนด = อำพัน (ไม่ใช่แดง)
export function followBadge(at, now = Date.now()) {
  if (!at) return null
  const t = Date.parse(at)
  if (Number.isNaN(t)) return null
  const day = new Date(t).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' })
  return { label: '⏰ ' + day, overdue: t <= now }
}

// tag บนการ์ดโชว์ได้ 2 อัน ที่เหลือเป็น +N
export function cardTags(tags, max = 2) {
  const list = Array.isArray(tags) ? tags : []
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) }
}

// ค้นหา tag ใน popover — ไม่เจอชื่อตรงตัวให้เสนอ "สร้าง tag ใหม่" (แบบ LINE)
export function matchTags(tags, query) {
  const q = String(query ?? '').trim().toLowerCase()
  const list = Array.isArray(tags) ? tags : []
  const hits = q ? list.filter(t => t.name.toLowerCase().includes(q)) : list
  const exact = q && list.some(t => t.name.trim().toLowerCase() === q)
  return { hits, create: q && !exact && q.length <= 30 ? String(query).trim() : '' }
}

// เปลี่ยน checkbox ที่ติ๊กใน popover เป็น add/remove ที่ case_tags_set ต้องการ
export function tagDiff(before, after) {
  const a = new Set(before), b = new Set(after)
  return { add: [...b].filter(id => !a.has(id)), remove: [...a].filter(id => !b.has(id)) }
}

// ───────────────────────── หน้ารายชื่อติดต่อ (sql/202610021000_contacts_page.sql)
// ระยะ = lifecycle ที่ฐานคำนวณจากหลักฐาน (crm.stage + มีคนตอบแล้วหรือยัง) — หน้าจอแปลชื่ออย่างเดียว
export const STAGES = [
  ['new', 'ใหม่', 'blue', 'ทักเข้ามาแล้ว ยังไม่มีพนักงานตอบ'],
  ['talking', 'กำลังคุย', 'teal', 'พนักงานตอบแล้ว ยังไม่มีนัด/จอง'],
  ['appointment', 'นัดชม', 'purple', 'มีนัดเข้าชมโครงการ หรือ walk-in แล้ว'],
  ['booking', 'จอง', 'amber', 'มีเอกสารจองในระบบ'],
  ['sale', 'ปิดการขาย', 'green', 'ปิดการขายแล้ว'],
  ['lost', 'หลุด', 'grey', 'ปิดเคสพร้อมเหตุผลว่าไม่ซื้อ'],
]
export const stageOf = code => STAGES.find(s => s[0] === code) ?? null

// ป้าย SLA มาจาก inbox.case_status ผ่าน contact_sla — ไม่คิดจากเวลาฝั่งเบราว์เซอร์
export const SLA_LABELS = { over: 'เกิน SLA', near: 'ใกล้เกิน', ok: 'ปกติ' }
export function slaBadge(sla, waitingMinutes) {
  const label = SLA_LABELS[sla] ?? SLA_LABELS.ok
  const tone = sla === 'over' ? 'over' : sla === 'near' ? 'near' : 'ok'
  const title = Number.isFinite(Number(waitingMinutes)) && waitingMinutes !== null && sla !== 'ok'
    ? `ลูกค้ารอมา ${waitingMinutes} นาที` : label
  return { label, tone, title }
}

export const CHANNELS = [['line', 'LINE'], ['messenger', 'Messenger'], ['instagram', 'Instagram'], ['tiktok', 'TikTok']]

// สถานะตัวกรองของหน้า → อาร์กิวเมนต์ของ inbox.contacts_list (ตัดค่าว่างทิ้ง ฐานจะได้ไม่ต้องเดา)
export function contactsQuery(f = {}) {
  const q = { sort: f.sort === 'asc' ? 'asc' : 'desc', offset: Math.max(0, Number(f.offset) || 0) }
  for (const k of ['search', 'tag_id', 'stage', 'assignee', 'channel', 'sla']) {
    const v = String(f[k] ?? '').trim()
    if (v) q[k] = v
  }
  if (f.starred) q.starred = true
  return q
}

// ผลการทำทีละหลายแถว (ติดแท็ก/มอบหมาย) → ข้อความสรุปเดียว · บอกสาเหตุที่พลาดตามจริง ไม่รวบว่า "สำเร็จ"
export function bulkSummary(action, results, reasons = {}) {
  const ok = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok)
  if (!failed.length) return `${action}แล้ว ${ok} รายการ`
  const why = {}
  for (const r of failed) { const k = reasons[r.code] || r.message || r.code || 'ไม่ทราบสาเหตุ'; why[k] = (why[k] || 0) + 1 }
  return `${action}แล้ว ${ok} รายการ · ไม่สำเร็จ ${failed.length}: ` + Object.entries(why).map(([k, n]) => `${k} ${n}`).join(', ')
}
