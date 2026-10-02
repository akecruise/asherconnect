// ───────────────────────────────────────────── LIFF นัดชมโครงการ (ตรรกะล้วน)
//
// spec: line-roadmap-phases.md Phase 4
//
// ★★ หลักข้อเดียวที่ไฟล์นี้มีอยู่เพื่อรักษา: **ห้ามเชื่อ userId ที่มาจาก client**
//   หน้า LIFF วิ่งในเครื่องของลูกค้า แก้ค่าอะไรก็ได้ ถ้าเชื่อ userId ที่ส่งมา
//   ใครก็จองนัดในชื่อคนอื่นได้ · ตัวตนจริงมาจาก `sub` ของ ID token ที่ LINE ยืนยันแล้ว
//
// ★ ไม่ต่อฐาน ไม่อ่าน env — ผู้เรียกเป็นคนหยิบ channel id มาให้

const LINE_VERIFY = 'https://api.line.me/oauth2/v2.1/verify'

// นัดได้เร็วสุดอีก 1 ชั่วโมง (กันกดพลาดแล้วได้นัดในอีกห้านาที) และไกลสุด 90 วัน
export const MIN_LEAD_MINUTES = 60
export const MAX_AHEAD_DAYS = 90
export const MAX_VISITORS = 10
export const MAX_NOTE = 500

/**
 * ยืนยัน ID token กับ LINE แล้วคืน userId ที่เชื่อถือได้
 *
 * ★ ตรวจสามอย่างที่ LINE ไม่ได้ตรวจให้: `aud` ตรงกับช่องของเราไหม (token ของแอปอื่น
 *   ใช้กับเราไม่ได้) · หมดอายุหรือยัง · มี `sub` จริงไหม
 *   ★★ `aud` สำคัญที่สุด — ถ้าไม่ตรวจ ใครมี LINE Login channel ของตัวเองก็ออก token
 *      มาใช้กับเราได้ทั้งหมด
 *
 * คืน {ok:false, reason} เสมอ ไม่ throw — ผู้เรียกอยู่ในเส้นทาง HTTP
 */
export async function verifyIdToken({ idToken, channelId }, fetcher = fetch, now = Date.now()) {
  if (typeof idToken !== 'string' || idToken === '') return { ok: false, reason: 'id_token_required' }
  if (typeof channelId !== 'string' || channelId === '') return { ok: false, reason: 'liff_not_configured' }

  let response
  try {
    response = await fetcher(LINE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString(),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    // ปลายทางไม่ตอบ = ยังยืนยันไม่ได้ ไม่ใช่ "ผ่าน"
    return { ok: false, reason: 'verify_unavailable' }
  }
  if (!response.ok) return { ok: false, reason: 'id_token_rejected' }

  const claims = await response.json().catch(() => null)
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'id_token_rejected' }

  // ★ LINE ตอบ 200 ให้ token ที่ถูกต้องตามรูป แต่ "ถูกรูป" ไม่ได้แปลว่า "ของเรา"
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(channelId)) return { ok: false, reason: 'audience_mismatch' }
  if (Number.isFinite(Number(claims.exp)) && Number(claims.exp) * 1000 <= now) {
    return { ok: false, reason: 'id_token_expired' }
  }
  const userId = typeof claims.sub === 'string' ? claims.sub.trim() : ''
  if (userId === '') return { ok: false, reason: 'id_token_rejected' }

  return { ok: true, userId, displayName: typeof claims.name === 'string' ? claims.name : null }
}

/**
 * ตรวจคำขอจองนัด
 *
 * ★ เวลาต้องมาเป็น ISO ที่มี timezone — ถ้ารับ "2026-10-10 14:00" เปล่า ๆ
 *   เบราว์เซอร์ของลูกค้าที่ตั้งเขตเวลาอื่นจะได้นัดผิดชั่วโมงโดยไม่มีใครรู้
 */
export function validateSiteVisit(body, now = Date.now()) {
  const raw = body?.scheduled_at
  if (typeof raw !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(raw.trim())) {
    return { ok: false, error: 'scheduled_at_must_have_timezone' }
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return { ok: false, error: 'invalid_scheduled_at' }
  if (at < now + MIN_LEAD_MINUTES * 60000) return { ok: false, error: 'too_soon' }
  if (at > now + MAX_AHEAD_DAYS * 86400000) return { ok: false, error: 'too_far_ahead' }

  const visitors = body?.visitor_count === undefined || body?.visitor_count === null
    ? 1 : Number(body.visitor_count)
  if (!Number.isInteger(visitors) || visitors < 1 || visitors > MAX_VISITORS) {
    return { ok: false, error: 'invalid_visitor_count' }
  }

  const note = body?.note === undefined || body?.note === null ? '' : String(body.note)
  if (note.length > MAX_NOTE) return { ok: false, error: 'note_too_long' }

  const projectRef = body?.project_ref === undefined || body?.project_ref === null
    ? null : String(body.project_ref).trim()
  if (projectRef !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(projectRef)) {
    return { ok: false, error: 'invalid_project_ref' }
  }

  return {
    ok: true,
    visit: {
      scheduled_at: new Date(at).toISOString(),
      visitor_count: visitors,
      note: note.trim() === '' ? null : note.trim(),
      project_ref: projectRef,
    },
  }
}
