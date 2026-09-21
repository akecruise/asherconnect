export const CRM_PUBLISH_BACKOFF_MS = [5000, 30000, 120000, 600000, 1800000, 7200000]

export function isRetryableCrmResponse(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export function classifyCrmFailure({ status = 0, network = false } = {}) {
  if (network || status === 0 || isRetryableCrmResponse(status)) return 'retry'
  return 'dead_letter'
}

export function crmBackoffMs(attempts) {
  const index = Math.max(0, Math.min(CRM_PUBLISH_BACKOFF_MS.length - 1, attempts - 1))
  return CRM_PUBLISH_BACKOFF_MS[index]
}

// ── ช่องทาง -> โครงการ ────────────────────────────────────────────────────
// รูปแบบ: "<inbox_id>=<project_code>;<inbox_id>=<project_code>"
// อ่านจาก ASHER_CRM_PROJECT_MAP ไม่ฝัง id ของ production ไว้ในโค้ด
// คู่ที่เขียนผิดรูปจะถูกทิ้งและรายงานใน invalid เพื่อให้ตอนบูตเห็นว่าพัง ไม่เงียบ
export function parseProjectMap(raw) {
  const map = new Map()
  const invalid = []
  for (const part of String(raw || '').split(';')) {
    const entry = part.trim()
    if (entry === '') continue
    const at = entry.indexOf('=')
    if (at < 1) { invalid.push(entry); continue }
    const scope = entry.slice(0, at).trim()
    const project = entry.slice(at + 1).trim()
    if (scope === '' || project === '') { invalid.push(entry); continue }
    map.set(scope, project)
  }
  return { map, invalid }
}

// ไม่มีคู่ที่ตรง = คืน null ตั้งใจให้ CRM บันทึก project_ref_missing แล้วไม่สร้าง Lead
// ดีกว่าเดาโครงการผิดแล้วได้ Lead ที่ผูกผิดโครงการ
export function projectRefFor(map, accountScope) {
  if (!map || typeof map.get !== 'function') return null
  return map.get(accountScope) ?? null
}
