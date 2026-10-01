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
