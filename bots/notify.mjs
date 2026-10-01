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

export const TEST_PREFIX = '[TEST] '

/**
 * ★ ต้องบอกชัดว่า "ใช่" เท่านั้นจึงนับเป็นแชททดสอบ — ห้ามใช้ truthy ลอย ๆ
 *
 * ปกติฐานส่ง JSON boolean จริง (คอลัมน์ boolean → jsonb_build_object → true/false)
 * แต่ความเสียหายของสองทางไม่เท่ากัน จึงออกแบบให้เอียงไปทางปลอดภัย:
 *
 *   ติดป้ายผิดให้ลูกค้าจริง → ทีมเห็น [TEST] แล้วมองข้าม = เสียลูกค้า
 *   ไม่ติดป้ายให้แชททดสอบ  → ทีมเผลอตอบแชททดสอบ = เสียเวลาไม่กี่นาที
 *
 * กับดักที่ทำให้ truthy ใช้ไม่ได้: สตริง "false" เป็น truthy ใน JS
 * ถ้าวันไหนมีใคร stringify payload ระหว่างทาง แชทลูกค้าทุกคนจะติด [TEST] ทันที
 *
 * จึงรับเฉพาะสามค่านี้: true (ปกติ) · 1 (เผื่อ driver คืน boolean เป็นเลข) · "true"
 */
const isTestFlag = (v) => v === true || v === 1 || v === 'true'

/**
 * ติด [TEST] ให้แชททดสอบ — ทีมจะได้ไม่วิ่งไปตอบเคสที่เราสร้างขึ้นเอง
 *
 * ★ ติดซ้ำไม่ได้ — ถ้าข้อความขึ้นต้นด้วย [TEST] อยู่แล้วให้คืนตามเดิม
 *   ไม่งั้นวันที่มีใครเรียกซ้อนกันจะได้ "[TEST] [TEST] 🟡 มีคนทัก"
 *   ซึ่งดูเหมือนบั๊กของระบบแจ้งเตือน ทั้งที่เป็นแค่การต่อสตริงสองรอบ
 */
export const withTestPrefix = (text, isTest) => {
  // ★ แปลงเป็นสตริงก่อนเสมอ — เคยได้ "[TEST] undefined" เพราะต่อสตริงกับ undefined ตรง ๆ
  const s = String(text ?? '')
  // ไม่มีข้อความก็ไม่ต้องติดป้าย — "[TEST] " เปล่า ๆ บอกอะไรไม่ได้เลย
  if (!s || !isTestFlag(isTest) || s.startsWith(TEST_PREFIX)) return s
  return TEST_PREFIX + s
}

/** สีของหัวข้อบอกความเร่งด่วนตั้งแต่บรรทัดแรก ไม่ต้องอ่านจบถึงจะรู้ */
function headline(p) {
  // ★ follow = ลูกค้ากดเพิ่มเพื่อน ยังไม่ได้พิมพ์อะไร — ห้ามขึ้นว่า "มีคนทัก"
  //   ไม่งั้นทีมเปิด chat.line.biz แล้วไม่เจอข้อความ นึกว่าระบบแจ้งมั่ว
  if (p.kind === 'follow') {
    return withTestPrefix(`👋 มีคนเพิ่มเพื่อน${p.channel_label ?? ''} (${bangkok()} น.)`, p.is_test)
  }
  const line = p.kind === 'watchdog'
    ? `🟠 ค้างตอบ ${p.min_since_msg ?? '?'} นาที (${bangkok()} น.)`
    : `${p.phone || p.line_id || p.verbatim_repeat ? '🔴' : p.reply_go ? '🟡' : '🟠'} มีคนทัก${p.channel_label ?? ''} (${bangkok()} น.)`
  return withTestPrefix(line, p.is_test)
}

function botLine(p) {
  if (p.kind === 'watchdog') return 'ยังไม่มีใครตอบ'
  if (p.kind === 'follow') return 'ยังไม่ได้ทัก ไม่ต้องตอบ (ถ้าเขาพิมพ์มาจะแจ้งอีกรอบ)'
  if (!p.reply_go) return `ไม่ตอบ (${p.reply_reason ?? 'ไม่ระบุเหตุผล'}) → คนต้องตอบ`
  if (p.wait_min) return `รอคนตอบ ${p.wait_min} นาที ถ้าไม่มีใครตอบบอทจะตอบเอง`
  return `จะตอบใน ${p.delay_sec ?? 0} วิ`
}

export function formatNotify(payload = {}, { inboxUrl = null } = {}) {
  const p = payload ?? {}
  const who = [
    `👤 ${p.display_name ? 'คุณ ' + p.display_name : 'ลูกค้า'}`,
    p.kind === 'watchdog' || p.kind === 'follow' ? null : (p.is_new_chat ? 'แชทใหม่' : 'แชทเดิม'),
    p.verbatim_repeat ? 'ถามซ้ำคำต่อคำ' : null,
    p.queued ? 'รวมส่งรอบ digest' : null,
  ].filter(Boolean).join(' · ')

  return [
    headline(p),
    who,
    p.topic ? `📌 เรื่อง: ${p.topic}` : null,
    p.ad_title ? 'ad: ' + String(p.ad_title).slice(0, 50) : null,
    // follow ไม่มีข้อความจากลูกค้า — text ของ follow เป็นแค่ป้ายที่ฐานใส่มา
    p.text && p.kind !== 'follow' ? 'ข้อความ: ' + String(p.text).slice(0, 200) : null,
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
    const recipients = String(env.LEAD_EMAIL_TO).split(',').map(email => email.trim()).filter(Boolean)
    for (const target of recipients) {
      out.push({ channel: 'email', target,
                 config: { resend_api_key: env.RESEND_API_KEY, email_from: env.LEAD_EMAIL_FROM } })
    }
  }
  return out
}
