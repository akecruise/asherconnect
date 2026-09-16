/**
 * คำสั่ง "test" ของบัญชีทดสอบ — ส่วนที่เป็นตรรกะล้วน
 *
 * แยกออกจาก server.mjs เพื่อให้เทสต์ได้โดยไม่ต้องเปิดเซิร์ฟเวอร์จริง
 * ที่นี่ไม่ยิงอะไรออกไปและไม่แตะฐาน — ตอบแค่ว่า "ก้อนนี้มีคำสั่ง test จากใครบ้าง"
 *
 * ★ รายชื่อบัญชีทดสอบอยู่ใน env ไม่ได้อยู่ในฐาน (เหมือน token ทุกตัวในระบบนี้)
 *   ฐานไม่ต้องรู้ว่าใครเป็นบัญชีทดสอบ รู้แค่ว่าถูกสั่งให้รีเซ็ตแชทไหน
 */

/** อ่านรายชื่อจาก env — คั่นด้วยจุลภาค ตัดช่องว่าง ทิ้งค่าว่าง */
export function testUserIds(env = process.env) {
  return new Set((env.TEST_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean))
}

/**
 * ★ ต้องตรงทั้งข้อความเท่านั้น
 *   ถ้าจับแบบ "ขึ้นต้นด้วย test" ลูกค้าจริงที่พิมพ์ "test ระบบ" จะโดนรีเซ็ตแชทตัวเอง
 *   และข้อความนั้นจะหายไปจาก pipeline โดยไม่มีใครรู้
 */
export const isTestKeyword = (t) =>
  ['test', '#test'].includes(String(t ?? '').trim().toLowerCase())

/**
 * ดึง (ผู้ส่ง, ข้อความ, replyToken) จากก้อนดิบของแต่ละเจ้า
 *
 * อ่านตื้น ๆ ตรงนี้โดยตั้งใจ ไม่เรียก normalizeWebhook เพราะงานนั้นหนัก
 * และควรอยู่หลังตอบ 200 ไปแล้ว — ตรงนี้ LINE/Meta ยังถือสายรออยู่
 *
 * echo ของ Messenger ถูกตัดทิ้ง ไม่งั้นข้อความที่ "เรา" ส่งออกไปเองจะถูกนับเป็นคำสั่ง
 */
export function testCandidates(channel, body) {
  if (channel === 'line') {
    return (body?.events ?? [])
      .filter(e => e?.type === 'message' && e?.message?.type === 'text' && e?.source?.type === 'user')
      .map(e => ({ userId: e.source.userId, text: e.message.text, replyToken: e.replyToken ?? null }))
  }
  return (body?.entry ?? []).flatMap(en => (en?.messaging ?? [])
    .filter(m => m?.message?.text && !m?.message?.is_echo)
    .map(m => ({ userId: m.sender?.id, text: m.message.text, replyToken: null })))
}

/** ใครในก้อนนี้สั่ง test บ้าง — ว่าง = ก้อนนี้เป็นข้อความปกติ ปล่อยเข้า pipeline ตามเดิม */
export function testResetTargets(channel, body, allow) {
  if (!allow?.size) return []
  return testCandidates(channel, body)
    .filter(c => c.userId && isTestKeyword(c.text) && allow.has(c.userId))
}

/**
 * แยกคำสั่ง test ออกจากก้อน แล้วคืนส่วนที่เหลือไว้เข้า pipeline ตามปกติ
 *
 * ★ เหตุที่ต้องแยกทีละ event ไม่ใช่ตัดทั้งก้อน:
 *   LINE กับ Meta ส่งมาเป็นชุดได้ ก้อนเดียวอาจมีทั้งคำสั่ง test ของเรา
 *   และข้อความของลูกค้าจริงคนอื่น ถ้าตัดทั้งก้อน ข้อความลูกค้าจะหายเงียบ ๆ
 *   ไม่มี log ไม่มีเคส ไม่มีใครรู้ว่าหาย
 *
 * ★ ไม่แก้ body เดิมแบบ in-place — คืน object ใหม่เสมอ
 *   (ตรวจแล้วว่า raw ถูกใช้ verify signature ไปก่อนหน้าแล้ว และ body ไม่ถูกอ่านที่อื่น
 *    แต่การแก้ของที่คนอื่นถืออยู่เป็นบั๊กที่รอเกิด ไม่ใช่เรื่องที่ควรพึ่งโชค)
 *
 * ★ Messenger: กรองเฉพาะ messaging — standby ต้องอยู่ครบ
 *   providers.mjs:161-162 อ่านทั้งสองอัน การทิ้ง standby = ทิ้ง event ที่แอปอื่นถือ thread อยู่
 *
 * คืน { hits, rest, remaining }
 *   hits      = คำสั่ง test ที่ต้องรีเซ็ต
 *   rest      = ก้อนใหม่ที่ถอดคำสั่ง test ออกแล้ว
 *   remaining = จำนวน event ที่ยังเหลือ · 0 = ก้อนนี้มีแต่คำสั่ง ไม่ต้อง log
 */
export function splitTestEvents(channel, body, allow) {
  const none = { hits: [], rest: body, remaining: countEvents(channel, body) }
  if (!allow?.size || !body) return none

  const isHit = (userId, text) => userId && isTestKeyword(text) && allow.has(userId)
  const hits = []

  if (channel === 'line') {
    const events = body.events ?? []
    const kept = events.filter(e => {
      const hit = e?.type === 'message' && e?.message?.type === 'text' && e?.source?.type === 'user'
                  && isHit(e.source.userId, e.message.text)
      if (hit) hits.push({ userId: e.source.userId, text: e.message.text, replyToken: e.replyToken ?? null })
      return !hit
    })
    if (!hits.length) return none
    return { hits, rest: { ...body, events: kept }, remaining: kept.length }
  }

  const entries = []
  for (const en of body.entry ?? []) {
    const messaging = (en?.messaging ?? []).filter(m => {
      const hit = m?.message?.text && !m?.message?.is_echo && isHit(m.sender?.id, m.message.text)
      if (hit) hits.push({ userId: m.sender.id, text: m.message.text, replyToken: null })
      return !hit
    })
    const next = en?.messaging ? { ...en, messaging } : { ...en }
    // entry ที่ไม่เหลือ event เลยต้องทิ้ง ไม่งั้นจะส่งเปลือกเปล่าเข้า pipeline
    if (messaging.length || (next.standby?.length ?? 0)) entries.push(next)
  }
  if (!hits.length) return none

  const remaining = entries.reduce(
    (n, en) => n + (en.messaging?.length ?? 0) + (en.standby?.length ?? 0), 0)
  return { hits, rest: { ...body, entry: entries }, remaining }
}

/** นับ event ในก้อน — ใช้ตัดสินว่ายังมีอะไรให้ log ต่อไหม */
export function countEvents(channel, body) {
  if (!body) return 0
  if (channel === 'line') return (body.events ?? []).length
  return (body.entry ?? []).reduce(
    (n, en) => n + (en?.messaging?.length ?? 0) + (en?.standby?.length ?? 0), 0)
}
