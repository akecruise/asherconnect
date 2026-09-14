/**
 * ข้อความแจ้งทีม — แปลง payload ที่ฐานตัดสินใจไว้ ให้เป็นข้อความที่คนอ่านรู้เรื่อง
 *
 * ฐานเป็นคนตัดสินว่า "ต้องแจ้งไหม เพราะอะไร" (กติกาข้อ 3)
 * ที่นี่ทำแค่เรียงคำ — ไม่มีเงื่อนไขทางธุรกิจสักข้อ
 *
 * รูปแบบยกจาก reference/bot-webhook.ts เพื่อให้ทีมที่เคยชินกับข้อความเดิมอ่านได้เหมือนเดิม
 */

const bangkok = (at = new Date()) =>
  at.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' })

/** สีของหัวข้อบอกความเร่งด่วนตั้งแต่บรรทัดแรก ไม่ต้องอ่านจบถึงจะรู้ */
function headline(p) {
  if (p.kind === 'watchdog') return `🟠 ค้างตอบ ${p.min_since_msg ?? '?'} นาที (${bangkok()} น.)`
  const urgent = p.phone || p.line_id || p.verbatim_repeat
  return `${urgent ? '🔴' : p.reply_go ? '🟡' : '🟠'} มีคนทัก${p.channel_label ?? ''} (${bangkok()} น.)`
}

function botLine(p) {
  if (p.kind === 'watchdog') return 'ยังไม่มีใครตอบ'
  if (!p.reply_go) return `ไม่ตอบ (${p.reply_reason}) → คนต้องตอบ`
  if (p.wait_min) return `รอคนตอบ ${p.wait_min} นาที ถ้าไม่มีใครตอบบอทจะตอบเอง`
  return `จะตอบใน ${p.delay_sec ?? 0} วิ`
}

export function formatNotify(payload = {}, { inboxUrl = null } = {}) {
  const p = payload ?? {}
  const who = [
    `👤 ${p.display_name ? 'คุณ ' + p.display_name : 'ลูกค้า'}`,
    p.kind === 'watchdog' ? null : (p.is_new_chat ? 'แชทใหม่' : 'แชทเดิม'),
    p.verbatim_repeat ? 'ถามซ้ำคำต่อคำ' : null,
    p.queued ? 'รวมส่งรอบ digest' : null,
  ].filter(Boolean).join(' · ')

  return [
    headline(p),
    who,
    p.topic ? `📌 เรื่อง: ${p.topic}` : null,
    p.ad_title ? 'ad: ' + String(p.ad_title).slice(0, 50) : null,
    p.text ? 'ข้อความ: ' + String(p.text).slice(0, 200) : null,
    p.phone ? 'เบอร์: ' + p.phone : null,
    p.line_id ? 'LINE: ' + p.line_id : null,
    'บอท: ' + botLine(p),
    inboxUrl ? 'ตอบที่: ' + inboxUrl : null,
  ].filter(Boolean).join('\n')
}

/**
 * ช่องทางที่ต้องยิงข้อความแจ้งนี้ออกไป
 *
 * ★ ปลายทางมาจาก env ที่นี่ ไม่ได้อยู่ในฐาน (กติกาข้อ 6)
 *   ฐานสั่งแค่ว่า "แจ้ง" ส่วนแจ้งไปที่ไหนเป็นเรื่องของเครื่องที่รันอยู่
 *
 * telegram กับ email ใช้เฉพาะตอนได้เบอร์/LINE มา เหมือนของเดิม (fanout)
 * เพราะสองทางนั้นไว้สะกิดคนที่ไม่ได้เฝ้าจอ ไม่ใช่รายงานทุกข้อความ
 */
export function notifyTargets(payload = {}, env = process.env) {
  const isLead = Boolean(payload.phone || payload.line_id)
  const out = []
  if (env.LINE_NOTIFY_GROUP_ID && env.LINE_NOTIFY_TOKEN) {
    out.push({ channel: 'line_group', target: env.LINE_NOTIFY_GROUP_ID,
               config: { access_token: env.LINE_NOTIFY_TOKEN } })
  }
  if (isLead && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    out.push({ channel: 'telegram', target: env.TELEGRAM_CHAT_ID,
               config: { telegram_bot_token: env.TELEGRAM_BOT_TOKEN } })
  }
  if (isLead && env.RESEND_API_KEY && env.LEAD_EMAIL_TO) {
    out.push({ channel: 'email', target: env.LEAD_EMAIL_TO,
               config: { resend_api_key: env.RESEND_API_KEY, email_from: env.LEAD_EMAIL_FROM } })
  }
  return out
}
