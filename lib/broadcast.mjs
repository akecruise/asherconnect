// ───────────────────────────────────────────── ตัวส่ง LINE หลายคน (ส่วนที่คิดเองได้)
//
// spec: docs/handoff/2026-10-02-line-broadcast-sender.md
//
// ที่นี่มีแต่ตรรกะล้วน ไม่ต่อฐาน ไม่ยิงเน็ต ไม่อ่าน env — ทดสอบได้ทั้งหมดโดยไม่ต้องมีของจริง
// ส่วนที่แตะโลกภายนอก (fetch LINE, rpcDirect) อยู่ที่ server.mjs / providers.mjs
//
// ★ token ไม่เคยผ่านไฟล์นี้ และไม่มีฟังก์ชันไหนรับ access_token เป็นอาร์กิวเมนต์

import { timingSafeEqual } from 'node:crypto'

// LINE multicast รับได้ครั้งละ 500 userId และ 5 ข้อความต่อครั้ง
export const MULTICAST_MAX = 500
export const MESSAGES_MAX = 5
// test=true ยอมรับได้ไม่เกินห้าคน (สเปกข้อ 3)
export const TEST_RECIPIENTS_MAX = 5
// 429/5xx/timeout ลองใหม่ได้สูงสุดหกครั้งด้วย retry key เดิม
export const RETRY_MAX = 6
export const BACKOFF_SECONDS = [5, 15, 60, 300, 900, 3600]

export const backoffSeconds = attempts =>
  BACKOFF_SECONDS[Math.max(0, Math.min(BACKOFF_SECONDS.length - 1, attempts - 1))]

/**
 * เทียบ token แบบไม่รั่วเวลา
 *
 * เทียบด้วย === ธรรมดาจะหยุดที่ไบต์แรกที่ต่าง เวลาที่ใช้จึงบอกได้ว่าเดาถูกกี่ตัว
 * ยิงซ้ำพอ ๆ กับจำนวนตัวอักษรก็เดาได้ทั้งเส้น — ด่านนี้เป็นทางเข้าที่ไม่ผ่าน login
 * จึงต้องปิดช่องนี้ตั้งแต่แรก (hash ก่อนเทียบเพื่อให้ความยาวไม่ต่างกันด้วย)
 */
export function tokenMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (expected === '') return false
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  // ความยาวต่างกันก็ยังต้องเทียบให้ครบรอบ ไม่งั้นความยาวรั่วออกไปทางเวลา
  const width = Math.max(a.length, b.length)
  const pa = Buffer.alloc(width)
  const pb = Buffer.alloc(width)
  a.copy(pa); b.copy(pb)
  return timingSafeEqual(pa, pb) && a.length === b.length
}

export function bearerToken(header) {
  const value = String(header || '')
  if (!value.toLowerCase().startsWith('bearer ')) return ''
  return value.slice(7).trim()
}

/**
 * ตรวจข้อความที่ CRM ส่งมา
 *
 * รับแค่ text กับ image ตามสเปก — ชนิดอื่น (flex/sticker/template) ปฏิเสธไปก่อน
 * ดีกว่าปล่อยผ่านแล้วให้ LINE ตอบ 400 ตอนยิงจริง เพราะตอนนั้นงานเข้าคิวไปแล้ว
 * รูปต้องเป็น https — LINE ไม่ยอมรับ http และ URL ภายในจะกลายเป็นรูปแตกทุกใบ
 */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: 'messages_required' }
  if (messages.length > MESSAGES_MAX) return { ok: false, error: 'too_many_messages' }
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'invalid_message' }
    if (m.type === 'text') {
      if (typeof m.text !== 'string' || m.text.trim() === '') return { ok: false, error: 'invalid_message' }
      if (m.text.length > 5000) return { ok: false, error: 'text_too_long' }
      continue
    }
    if (m.type === 'image') {
      if (!isHttpsUrl(m.originalContentUrl) || !isHttpsUrl(m.previewImageUrl)) {
        return { ok: false, error: 'image_url_must_be_https' }
      }
      continue
    }
    return { ok: false, error: 'unsupported_message_type' }
  }
  return { ok: true }
}

const isHttpsUrl = value => {
  if (typeof value !== 'string' || value === '') return false
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

/**
 * ตรวจผู้รับ
 *
 * ตัดซ้ำที่นี่ด้วย (ฐานก็ตัดอีกชั้นด้วย primary key) เพื่อให้ accepted ที่ตอบกลับไป
 * ตรงกับความจริงตั้งแต่ครั้งแรก ไม่ใช่ให้ CRM มารู้ทีหลังว่าจำนวนไม่ตรงที่ส่งมา
 */
export function normalizeRecipients(recipients, { test = false, allowlist = [] } = {}) {
  if (!Array.isArray(recipients)) return { ok: false, error: 'recipients_required' }
  const seen = new Set()
  const rows = []
  for (const r of recipients) {
    const id = typeof r === 'string' ? r : String(r?.external_user_id ?? '')
    const trimmed = id.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    rows.push({ external_user_id: trimmed, contact_ref: r?.contact_ref ? String(r.contact_ref) : null })
  }
  if (rows.length === 0) return { ok: false, error: 'recipients_required' }
  if (test) {
    if (rows.length > TEST_RECIPIENTS_MAX) return { ok: false, error: 'test_recipient_limit' }
    const allowed = new Set(allowlist)
    const outside = rows.filter(r => !allowed.has(r.external_user_id)).map(r => r.external_user_id)
    if (outside.length) return { ok: false, error: 'test_recipient_not_allowed' }
  }
  return { ok: true, recipients: rows }
}

// "A,B , ,C" -> ['A','B','C'] · ไม่ตั้งค่า = ลิสต์ว่าง = test ส่งไม่ได้เลย (fail closed)
export const parseAllowlist = raw =>
  String(raw || '').split(',').map(s => s.trim()).filter(s => s !== '')

/** ตัดผู้รับเป็นชุดละไม่เกิน 500 — ใช้ตรวจว่าแบ่งตรงกับที่ฐานแบ่งไว้ */
export function chunkRecipients(ids, size = MULTICAST_MAX) {
  const out = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * แปลคำตอบของ LINE multicast เป็นผลที่เก็บลงฐาน
 *
 * 409 + retry key เดิม = LINE รับคำขอนี้ไปแล้วรอบก่อน ยิงซ้ำไม่ได้ทำให้ลูกค้าได้สองครั้ง
 * จึงเป็น "สำเร็จ" ไม่ใช่ "ชนกัน" (ตรรกะเดียวกับ sendLine ใน providers.mjs)
 * 400/403 = คำขอผิดหรือสิทธิ์ไม่พอ ยิงอีกกี่ครั้งก็เหมือนเดิม → เลิกเลย
 */
export function classifyMulticast({ status = 0, network = false, attempts = 1, requestId = null } = {}) {
  if (network || status === 0) return retryOrFail(attempts, status, 'network_error')
  if (status === 409) return { outcome: 'sent', http_status: status, line_request_id: requestId }
  if (status >= 200 && status < 300) return { outcome: 'sent', http_status: status, line_request_id: requestId }
  if (status === 429 || status >= 500) return retryOrFail(attempts, status, `line_http_${status}`)
  return { outcome: 'failed', http_status: status, error: `line_http_${status}` }
}

const retryOrFail = (attempts, status, error) =>
  attempts >= RETRY_MAX
    ? { outcome: 'failed', http_status: status, error: `${error}_retries_exhausted` }
    : { outcome: 'retry', http_status: status, error, backoff_seconds: backoffSeconds(attempts) }

/**
 * โควตาพอไหม
 *
 * limit null = LINE ตอบ type 'none' (แพ็กเกจไม่จำกัด) → ผ่านเสมอ
 * ไม่พอ = ล้มทั้งงาน ไม่ส่งบางส่วน — ส่งครึ่งเดียวแล้วโควตาหมดกลางทางแย่กว่าไม่ส่งเลย
 * เพราะ CRM จะไม่รู้ว่าใครได้ใครไม่ได้ และยิงซ้ำทั้งก้อนก็ทำให้คนแรก ๆ ได้สองครั้ง
 */
export function quotaAllows({ limit = null, used = 0 } = {}, recipientCount = 0) {
  if (limit === null || limit === undefined) return { ok: true, remaining: null }
  const remaining = Math.max(0, Number(limit) - Number(used || 0))
  return { ok: recipientCount <= remaining, remaining }
}
