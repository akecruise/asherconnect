/**
 * แปลงรายงานจาก inbox.reply_report() เป็นข้อความไทย
 *
 * ★ ไฟล์นี้ไม่รู้จักฐานข้อมูลและไม่นับอะไรเลย — ตัวเลขทุกตัวถูกคำนวณมาแล้วในฐาน
 *   ที่นี่มีแต่การเรียงคำ ถ้าวันไหนต้องแก้สูตร ให้ไปแก้ที่ inbox.reply_report()
 *   ไม่ใช่มาบวกลบตรงนี้ ไม่งั้นตัวเลขในข้อความกับตัวเลขในฐานจะเริ่มไม่ตรงกัน
 *
 * รูปแบบข้อความยกสำนวนจาก sendReplyDigest() ใน reference/bot-webhook.ts
 * (fbline_report_TG.ts ที่ PLAN อ้างถึงยังหาไม่เจอ — ดู docs/switchover.md)
 */

/** นาที: ปัดเป็นจำนวนเต็ม · ไม่มีข้อมูลใช้ขีด ไม่ใช่ 0 เพราะศูนย์แปลว่า "ตอบทันที" */
export const fmtMin = v => (v === null || v === undefined || v === '' ? '-' : String(Math.round(Number(v))))

/** 13 ก.ย. 69 — รูปแบบเดียวกับที่ทีมเคยเห็นในรายงานเดิม */
export function thDate(date) {
  const d = date instanceof Date ? date : new Date(String(date) + 'T00:00:00+07:00')
  return d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit' })
}

const CHANNEL_LABEL = { line: 'LINE', messenger: 'Messenger', line_group: 'กลุ่ม LINE' }
const label = ch => CHANNEL_LABEL[ch] ?? ch

export function buildDailyDigest(report = {}) {
  const t = report.total ?? {}
  const pending = report.pending ?? []
  const people = report.people ?? []
  const platforms = report.platforms ?? []
  const fallback = Number(report.line_fallback ?? 0)

  const lines = [
    `📊 สรุปการตอบแชท ${thDate(report.date)}`,
    `ลูกค้าทัก ${t.asked ?? 0} รอบ · ทีมตอบ ${t.human_first ?? 0} · บอทตอบ ${t.bot_first ?? 0}` +
      (t.unanswered ? ` · ⚠ ค้าง ${t.unanswered}` : ''),
    `เฉลี่ยรอ: ทีม ${fmtMin(t.human_avg_min)} นาที · บอท ${fmtMin(t.bot_avg_min)} นาที` +
      (t.human_median_min != null ? ` · กลาง ${fmtMin(t.human_median_min)} นาที` : '') +
      (t.over30 ? ` · ทีมตอบช้ากว่า 30 นาที ${t.over30} รอบ` : ''),
  ]

  // แยกช่องทางเฉพาะตอนมีมากกว่าหนึ่ง — มีทางเดียวแล้วซ้ำกับบรรทัดบนเปล่า ๆ
  if (platforms.length > 1) {
    lines.push('', 'แยกตามช่องทาง')
    for (const p of platforms) {
      lines.push(`• ${label(p.channel)}: ทัก ${p.asked} · ทีม ${p.human_first} · บอท ${p.bot_first}` +
        (p.unanswered ? ` · ค้าง ${p.unanswered}` : '') +
        ` · เฉลี่ย ${fmtMin(p.human_avg_min)} นาที`)
    }
  }

  if (people.length) {
    lines.push('', 'รายคน')
    for (const r of people) {
      lines.push(`${r.responder === 'unknown' ? 'ไม่ระบุชื่อ' : r.responder}: ${r.replies} ข้อความ` +
        ` · เป็นคนแรกที่ตอบ ${r.first_responses} รอบ` +
        (r.avg_min != null ? ` · เฉลี่ย ${fmtMin(r.avg_min)} นาที` : ''))
    }
  }

  if (pending.length) {
    lines.push('', 'ยังไม่มีใครตอบ:')
    for (const e of pending) {
      lines.push(`• ${e.at} คุณ${e.name} (${label(e.channel)}): ${e.text}`)
    }
    const more = Number(t.unanswered ?? 0) - pending.length
    if (more > 0) lines.push(`…และอีก ${more} ราย`)
  }

  // ตัวเลขที่ไม่ได้มาจากสำเนาคำตอบจริง ต้องบอกให้รู้ ไม่ใช่ปนไปเงียบ ๆ
  if (fallback) {
    lines.push('', `* LINE ${fallback} รอบนับเวลาจากบันทึก "คนตอบแล้ว" เพราะ LINE ไม่ส่งสำเนาคำตอบกลับมา`)
  }

  return lines.join('\n')
}

/**
 * ตัดข้อความยาวเป็นท่อน
 *
 * Telegram รับได้ 4096 ตัวอักษรต่อข้อความ ตัดที่ 3,500 เผื่อไว้
 * ★ ตัดที่ขึ้นบรรทัดใหม่เสมอ ไม่ตัดกลางบรรทัด — รายงานที่ถูกผ่าครึ่งประโยคอ่านไม่รู้เรื่อง
 *   บรรทัดเดียวที่ยาวเกินท่อนจริง ๆ ค่อยยอมตัดดิบ
 */
export function chunkText(text, limit = 3500) {
  const out = []
  let buf = ''
  for (const line of String(text ?? '').split('\n')) {
    if (line.length > limit) {
      if (buf) { out.push(buf); buf = '' }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit))
      continue
    }
    if (buf && buf.length + 1 + line.length > limit) { out.push(buf); buf = line }
    else buf = buf ? buf + '\n' + line : line
  }
  if (buf) out.push(buf)
  return out.length ? out : ['']
}
