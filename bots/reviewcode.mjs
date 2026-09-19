/**
 * รหัสรีวิวของ Meta App Review — ส่วนที่เป็นตรรกะล้วน
 *
 * แยกออกจาก server.mjs เพื่อให้เทสต์ได้โดยไม่ต้องเปิดเซิร์ฟเวอร์จริง
 * ไม่แตะฐาน ไม่ยิงอะไรออกไป — ตอบแค่ว่า "ควรติดธง review_code_hit ให้ event นี้ไหม"
 *
 * ★ ทำไมต้องเช็คที่นี่แทนที่จะให้ฐานเช็คเอง
 *   รหัสรีวิวมาจาก env META_REVIEW_CODE ซึ่งฐาน (connect_private.receive_event)
 *   อ่านตรง ๆ ไม่ได้ — ไม่ใช่ inbox.settings ของแต่ละ inbox เหมือนค่าคอนฟิกอื่น
 *   ที่นี่เช็คแล้วส่งผลเป็นธง boolean เข้าไปใน p_data ให้ฐานเชื่อได้เลย
 */

/** อ่านรหัสรีวิวจาก env — ไม่ตั้งไว้ใช้ 'META-REVIEW' */
export function reviewCode(env = process.env) {
  return env.META_REVIEW_CODE || 'META-REVIEW'
}

/**
 * ★ เฉพาะ channel key 'asher-messenger' เท่านั้น (LINE ไม่เข้าเงื่อนไขนี้)
 *   ★ เฉพาะ event_type 'message' — postback/echo/follow ไม่ใช่ข้อความที่ผู้ตรวจสอบพิมพ์
 *   ★ ต้อง "ขึ้นต้นด้วย" ไม่ใช่ "เท่ากับ" — ผู้ตรวจสอบพิมพ์ต่อท้ายได้ (เช่น
 *     "META-REVIEW ทดสอบ pages_messaging")
 *
 * ★ ไม่แก้ event เดิม (normalizeWebhook ห้ามเปลี่ยนหน้าตาผลลัพธ์ของมัน — providers.mjs)
 *   ไม่ hit คืน event ตัวเดิม (reference เท่าเดิม) hit แล้วคืน object ใหม่เท่านั้น
 */
export function tagReviewCode(event, config, code) {
  if (config?.key !== 'asher-messenger' || event?.event_type !== 'message') return event
  if (typeof event.text !== 'string' || !event.text.startsWith(code)) return event
  return { ...event, review_code_hit: true }
}
