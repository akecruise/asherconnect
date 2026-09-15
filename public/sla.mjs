/**
 * ป้าย SLA บนการ์ดแชท — แยกออกมาเป็นโมดูลเดี่ยว เพื่อให้เทสต์ได้โดยไม่ต้องพึ่ง DOM
 *
 * ★ ไฟล์นี้ไม่คำนวณ "นาทีที่รอ" เองจาก timestamp ดิบ — รับตัวเลขที่ฐานคำนวณมาให้แล้ว
 *   (inbox.case_status.waiting_minutes ผ่าน inbox.sla_elapsed_minutes() ซึ่งหักช่วง
 *   00:00–06:00 เวลาไทยออกแล้ว) เหตุผล: ถ้าคำนวณซ้ำอีกที่ฝั่งนี้ วันหนึ่งจะเพี้ยนกัน
 *   คนละตัวเลข (เคยเกิดปัญหาทำนองนี้มาแล้วกับตัวกรองที่ฐานกับ UI คิดคนละสูตร)
 *   slaTag() จึงเป็นแค่ "แปลตัวเลข → ป้าย" ไม่ใช่ "คิดตัวเลขเอง"
 *
 * ★ แต่โจทย์ขอเทสต์กรณี 00:00–06:00 ด้วย — export elapsedSlaMinutes() แยกไว้ต่างหาก
 *   เป็นสำเนาของตรรกะเดียวกับ inbox.sla_elapsed_minutes() (sql/023_sla_case_status.sql)
 *   ไว้ "พิสูจน์ว่าสูตรตรงกัน" ผ่านเทสต์ ไม่ได้ตั้งใจให้ path การเรนเดอร์จริงเรียกใช้ฟังก์ชันนี้
 *   ★ ถ้าวันไหนแก้ช่วงหยุดนับหรือ sla_minutes ที่ฐาน ต้องแก้ตรงนี้ให้ตรงกันด้วยมือ
 *     (เทียบได้จาก inbox.settings: sla_pause_start/sla_pause_end/sla_minutes)
 */

// ค่าตั้งต้นเดียวกับ inbox.settings บนฐาน ณ วันที่เขียนไฟล์นี้ (2026-09-15)
export const SLA_WARN_MINUTES = 5     // เริ่มขึ้นป้ายแดงอ่อนที่นาทีนี้
export const SLA_OVER_MINUTES = 10    // เกินแล้วขึ้นป้ายแดงเข้ม (ตรงกับ inbox.settings.sla_minutes)
export const PAUSE_START_HOUR = 0     // หยุดนับ 00:00
export const PAUSE_END_HOUR = 6       // เลิกหยุดนับ 06:00 เวลาไทย

/**
 * นาทีที่นับเข้า SLA ระหว่างสองเวลา หักช่วงหยุดนับ (ค่าตั้งต้น 00:00–06:00 เวลาไทย) ออก
 *
 * มีไว้ให้เทสต์พิสูจน์ว่าตรรกะฝั่งนี้ตรงกับฐาน ไม่ใช่ตัวที่หน้าเว็บเรียกใช้จริงตอนเรนเดอร์
 * (ดูคำอธิบายหัวไฟล์) รับ Date หรือ ISO string ก็ได้ทั้งคู่
 *
 * @param {Date|string} from
 * @param {Date|string} to
 * @param {{pauseStartHour?:number, pauseEndHour?:number}} [opts]
 * @returns {number} จำนวนนาที ปัดลง ไม่ติดลบ
 */
export function elapsedSlaMinutes(from, to, opts = {}) {
  const f = from instanceof Date ? from : new Date(from)
  const t = to instanceof Date ? to : new Date(to)
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) return 0

  const ps = opts.pauseStartHour ?? PAUSE_START_HOUR
  const pe = opts.pauseEndHour ?? PAUSE_END_HOUR
  const totalMs = t.getTime() - f.getTime()
  if (ps === pe) return Math.floor(totalMs / 60000)

  // ★ ต้องแปลงเป็น "เวลาไทยตามนาฬิกา" ก่อนหาว่าทับช่วงหยุดนับตรงไหน ไม่ใช่ทำกับ UTC ตรง ๆ
  //   ไม่งั้นช่วง 00:00–06:00 ไทยจะไปตกที่ 17:00–23:00 UTC ของวันก่อนหน้า คำนวณผิดทันที
  const toBkk = ms => new Date(ms + 7 * 3600000) // เลื่อนให้ตัวเลข wall-clock อ่านเป็นเวลาไทยเมื่อใช้ getUTC*
  const fB = toBkk(f.getTime()), tB = toBkk(t.getTime())
  const dayStart = ms => Math.floor(ms / 86400000) * 86400000

  let pauseMs = 0
  // ไล่ทีละวันตั้งแต่วันก่อนหน้า f ถึงวันหลัง t หนึ่งวัน เผื่อหน้าต่างคร่อมเที่ยงคืน
  for (let day = dayStart(fB.getTime()) - 86400000; day <= dayStart(tB.getTime()) + 86400000; day += 86400000) {
    const winStart = day + ps * 3600000
    const winEnd = day + (ps < pe ? pe * 3600000 : 24 * 3600000)
    const s = Math.max(fB.getTime(), winStart)
    const e = Math.min(tB.getTime(), winEnd)
    if (e > s) pauseMs += e - s
    if (ps >= pe) {
      // หน้าต่างคร่อมเที่ยงคืน (เช่น 22:00–06:00): มีอีกชิ้นตั้งแต่ต้นวันถึง pe
      const s2 = Math.max(fB.getTime(), day)
      const e2 = Math.min(tB.getTime(), day + pe * 3600000)
      if (e2 > s2) pauseMs += e2 - s2
    }
  }
  return Math.max(0, Math.floor((totalMs - pauseMs) / 60000))
}

/**
 * แปลงนาทีที่รอ (คำนวณมาแล้วจากฐาน) + สถานะเคส ให้เป็นป้าย SLA
 *
 * ตอบแล้ว (case_status = 'wait' หรือ 'closed') → ไม่มีป้าย
 * รอ 0–4 นาที → ไม่มีป้าย (ยังไม่ถึงเกณฑ์เตือน)
 * รอ 5–9 นาที → แดงอ่อน "รอ X นาที"
 * รอ 10 นาทีขึ้นไป → แดงเข้ม (#8E1116) ตัวอักษรขาว "เกิน X นาที"
 *
 * @param {number|null|undefined} waitingMinutes
 * @param {string} [caseStatus] 'new'|'late'|'wait'|'closed'
 * @returns {{label:string, tone:'none'|'warn'|'over'}}
 */
export function slaTag(waitingMinutes, caseStatus) {
  if (caseStatus === 'wait' || caseStatus === 'closed') return { label: '', tone: 'none' }
  const m = Number(waitingMinutes)
  if (!Number.isFinite(m) || m < SLA_WARN_MINUTES) return { label: '', tone: 'none' }
  if (m >= SLA_OVER_MINUTES) return { label: `เกิน ${m} นาที`, tone: 'over' }
  return { label: `รอ ${m} นาที`, tone: 'warn' }
}
