/**
 * สื่อแนบ (รูป/วิดีโอ/เสียง/ไฟล์) — ชิ้นส่วนกลางของ media pipeline
 *
 * ★ โมดูลนี้ไม่รู้จักฐานข้อมูล ไม่ยิงเน็ต และไม่อ่าน process.env เลย (กติกาเดียวกับ lib/profile.mjs)
 *   หน้าที่มีแค่: ตัดสินว่า event ไหนมีสื่อที่ควรเก็บ, คิดเส้นทางไฟล์บน Storage, และด่านตรวจ path
 *   ตัวดาวน์โหลด/อัปโหลดจริงอยู่ที่ server.mjs เพราะต้องใช้ token กับ log ของชั้นนั้น
 *
 * ทำไมต้องเก็บไฟล์เอง: Messenger ให้ URL รูปมาแบบใช้ได้ชั่วคราว ส่วน LINE ไม่ส่ง URL มาเลย
 *   (ต้องเรียก Content API เอา) — ระบบเดิมเก็บแต่ข้อความ "[ลูกค้าส่งสื่อแนบ]"
 *   สื่อทุกก้อนจึงหายตั้งแต่ขั้นรับเข้า (หลักฐานใน docs/media-pipeline.md)
 */

/** ชนิดแนบของ Messenger ที่เป็นไฟล์เก็บได้ — นอกนี้ (location/template/fallback) ไม่ใช่ไฟล์ */
export const MESSENGER_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file'])

/** content_type ฝั่ง LINE ที่แปลว่ามีสื่อให้ไปดึงจาก Content API — สติกเกอร์ตัดสินใจเก็บเป็นข้อความไปแล้ว */
export const LINE_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file'])

/** ฝากไฟล์ได้ไม่เกิน 25 MB — เพดานเดียวกับที่ bucket ตั้งไว้ (scripts/ensure-media-bucket.mjs) */
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
}

export const extFor = mime => EXT_BY_MIME[(mime || '').split(';')[0].trim().toLowerCase()] || 'bin'

/**
 * ตัดสินว่า event ที่ normalize แล้วมีสื่อที่ต้องไปดึงหรือไม่
 *
 * คืนรายการงานให้ server.mjs หยิบไปทำต่อ · แต่ละก้อนเป็นรูปแบบใดรูปแบบหนึ่ง:
 *   { message_id, source:'url', url }                       ← Messenger (URL ต้องรีบดึง เพราะหมดอายุ)
 *   { message_id, source:'line_content', line_message_id }  ← LINE (Content API ใช้ token ของ channel นั้น)
 *
 * ★ อ่านอย่างเดียว — ทั้ง event และผลลัพธ์ของ rpc('receive') ไม่ถูกแก้
 *   media_tasks เรียกได้ก่อนรู้ message_id (received เป็น null) แล้วคืน [] พอ ไม่ throw
 */
export function mediaTasks(event, received) {
  // Instagram attachment bytes stay at Meta. Persist references only.
  if (event?.platform === 'instagram') return []
  const messageId = received?.message_id
  if (!messageId || !event) return []
  // Messenger — ทั้งข้อความลูกค้าและ echo ของทีม ใส่ attachments ไว้ใน attribution เหมือนกัน
  const attachments = event.attribution?.attachments
  if (Array.isArray(attachments)) {
    return attachments
      .filter(a => MESSENGER_MEDIA_TYPES.has(a?.type) && /^https:\/\//i.test(a?.payload?.url || ''))
      .map(a => ({ message_id: messageId, source: 'url', url: a.payload.url }))
  }
  if (LINE_MEDIA_TYPES.has(event.content_type) && event.attribution?.provider_message_id) {
    const provider = event.attribution.content_provider
    if (provider?.type === 'external') {
      return /^https:\/\//i.test(provider.originalContentUrl || '')
        ? [{ message_id: messageId, source: 'url', url: provider.originalContentUrl }]
        : []
    }
    return [{ message_id: messageId, source: 'line_content', line_message_id: event.attribution.provider_message_id }]
  }
  return []
}

/** เส้นทางไฟล์บน bucket — <inbox_id>/<message_id>[-ลำดับที่].<นามสกุล> · ลำดับเริ่มที่ 1 ไฟล์แรกไม่ต้องมีเลข */
export function storagePath(inboxId, messageId, index, mime) {
  return `${inboxId}/${messageId}${index > 1 ? `-${index}` : ''}.${extFor(mime)}`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * ด่านเดียวที่ยอมรับ path ของ /media/ — ตัวอักษรกับรูปร่างตายตัว ".." กับสิ่งแปลกปลอมจึงผ่านไม่ได้เลย
 * สไตล์เดียวกับ staticFiles ของ server.mjs: ตัวชี้ขาดคือรูปแบบ ไม่ใช่การกรองทีหลัง
 */
export const safeMediaPath = candidate =>
  new RegExp(`^${UUID}/${UUID}(?:-[1-9][0-9]*)?\\.(?:jpg|png|gif|webp|mp4|m4a|mp3|ogg|pdf|bin)$`, 'i')
    .test(candidate || '') ? candidate : null

/** Both initial detail and subsequent polling/pagination must retain media. */
export async function enrichMessageMedia(action, data, conversationId, lookup) {
  if (!['detail', 'messages'].includes(action) || !Array.isArray(data?.messages)) return data
  const mediaMap = await lookup(conversationId)
  if (mediaMap) for (const message of data.messages) {
    if (mediaMap[message.id]) message.media = mediaMap[message.id]
  }
  return data
}
