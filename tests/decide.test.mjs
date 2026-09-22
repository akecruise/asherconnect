import { disposableTarget } from './db-target.mjs';
const testTarget = disposableTarget();
/**
 * Phase 3 — ชุดทดสอบตรรกะตัดสินใจของบอท
 *
 *   node --test tests/decide.test.mjs
 *
 * ★ ยก SCENARIOS 20 ข้อ และ WATCHDOG_SCENARIOS 9 ข้อ มาจาก reference/bot-webhook.ts
 *   ทั้งชื่อ args และผลที่คาดไว้ คัดลอกมาตรง ๆ ห้ามแก้
 *   ถ้าข้อไหนไม่ผ่าน แปลว่าตรรกะที่ port ลง Postgres ไม่ตรงกับของเดิม — ต้องแก้ที่ตรรกะ
 *
 * ★ เวลาเป็น p_now ที่เราป้อนเอง ไม่ใช่นาฬิกาจริง จึงทดสอบขอบ 08:59 / 09:00 ได้ทันที
 *   ไม่ต้องรอถึงเวลานั้น และผลเหมือนเดิมทุกครั้งที่รัน
 *
 * ★ jitter ส่งเป็น 0 เสมอ ของเดิมสุ่มอยู่ในตรรกะทำให้เทียบตัวเลขวินาทีไม่ได้เลย
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// คุยกับฐานผ่าน container เพื่อไม่ต้องมี pg client บนเครื่อง
// ฟังก์ชันฝั่งฐานตรวจ role จาก request.jwt.claims ที่ปกติ PostgREST เป็นคนใส่
// เรียกจาก psql จึงต้องสวม claim เองในธุรกรรมเดียวกัน
async function sql(text) {
  const wrapped = `begin; set local request.jwt.claims = '{"role":"service_role"}'; ${text} commit;`
  const { stdout } = await run('docker', ['exec', testTarget.container, 'psql', '-U', testTarget.user, '-d', testTarget.database,
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', wrapped], { maxBuffer: 8 << 20 })
  return stdout.split('\n').map(s => s.trim())
    .filter(s => s && !['BEGIN', 'COMMIT', 'SET', 'ROLLBACK'].includes(s))
}

const quote = value => "'" + JSON.stringify(value).replace(/'/g, "''") + "'"
// เวลาไทยที่กำหนดเอง — วันที่ไม่มีผลต่อตรรกะ มีแต่ชั่วโมงกับนาที
const at = (hour, minute) => `2026-01-01 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07`

let FB = null
async function fbInbox() {
  if (!FB) {
    const [id] = await sql(`select id from inbox.inbox where channel='messenger' order by created_at limit 1;`)
    if (!id) throw new Error('ไม่พบ inbox ของ Messenger — ต้องลง sql/001_bot_schema.sql ก่อน')
    FB = id
  }
  return FB
}

// ── ประกอบ ctx จาก args แบบเดียวกับ simCtx()/parseSim() ของเดิม ────────────
// ค่าที่เป็น Infinity ในของเดิม แทนด้วย null ที่นี่
// (inbox.ctx_min() แปลง null เป็น 'Infinity'::float8 ให้ตรงกับพฤติกรรม JS ทุกกรณี)
const baseCtx = () => ({
  text: 'ราคาเท่าไหร่', has_text: true, is_admin: false, is_new_chat: true,
  gap_hours: null, unanswered_since_notify_min: null, human_replied_min: null,
  phone_in_text: null, line_in_text: null, verbatim_repeat: false,
  convo_mode: 'bot', is_standby: false,
})

function parseSim(args) {
  let hour = 0, minute = 0
  const patch = {}
  const returning = () => {
    patch.is_new_chat = false
    if (patch.unanswered_since_notify_min === undefined) patch.unanswered_since_notify_min = 0
  }
  for (const a of args) {
    let m
    if ((m = a.match(/^(\d{1,2})(?::(\d{2}))?$/))) { hour = +m[1] % 24; minute = +(m[2] ?? 0) }
    else if (a === 'ใหม่') patch.is_new_chat = true
    else if (a === 'เดิม') returning()
    else if ((m = a.match(/^คนตอบ(\d+)$/))) { patch.human_replied_min = +m[1]; returning() }
    else if ((m = a.match(/^แจ้งแล้ว(\d+)$/))) { patch.unanswered_since_notify_min = +m[1]; patch.is_new_chat = false }
    else if ((m = a.match(/^ห่าง(\d+)$/))) { patch.gap_hours = +m[1]; returning() }
    else if (a === 'เบอร์') { patch.phone_in_text = '0812345678'; patch.text = '0812345678' }
    else if (a === 'ไลน์') { patch.line_in_text = 'somchai'; patch.text = 'line: somchai' }
    else if (a === 'ซ้ำ') patch.verbatim_repeat = true
    else if (a === 'รูป') { patch.has_text = false; patch.text = '[แนบ: image]' }
    else if (a.startsWith('mode:')) patch.convo_mode = a.slice(5)
    else if (a === 'admin') patch.is_admin = true
    else if (a === 'standby') patch.is_standby = true
  }
  return { hour, minute, ctx: { ...baseCtx(), ...patch } }
}

function parseWd(args) {
  let hour = 0, minute = 0, gotMin = false
  const w = { min_since_msg: 0, page_replied_after_msg: false, notified_after_msg: false,
              min_since_notified: 0, convo_mode: 'bot', is_admin: false }
  for (const a of args) {
    let m
    if ((m = a.match(/^(\d{1,2}):(\d{2})$/))) { hour = +m[1] % 24; minute = +m[2] }
    else if (!gotMin && /^\d+$/.test(a)) { w.min_since_msg = +a; gotMin = true }
    else if (a === 'ตอบแล้ว') w.page_replied_after_msg = true
    else if ((m = a.match(/^แจ้งแล้ว(\d+)$/))) { w.notified_after_msg = true; w.min_since_notified = +m[1] }
    else if (a.startsWith('mode:')) w.convo_mode = a.slice(5)
    else if (a === 'admin') w.is_admin = true
  }
  return { hour, minute, w }
}

// ── ชุดสถานการณ์: คัดลอกจาก reference/bot-webhook.ts ตรง ๆ ────────────────
const SCENARIOS = [
  { name: 'กลางวัน แชทใหม่',                            args: ['14:00'],                          expect: { bot: 'silent', notify: 'skip' } },
  { name: 'กลางวัน ให้เบอร์ (leadsIgnoreHours=false)',     args: ['14:00', 'เบอร์'],                  expect: { bot: 'silent', notify: 'skip' } },
  { name: 'กลางวัน แอดมิน',                             args: ['14:00', 'admin'],                 expect: { bot: 'now',    notify: 'none' } },
  { name: 'ค่ำ แชทใหม่',                                args: ['20:00'],                          expect: { bot: 'wait',   notify: 'send' } },
  { name: 'ค่ำ แชทเดิม เพิ่งแจ้ง 5 นาที → ไม่เตือนซ้ำ',      args: ['20:00', 'แจ้งแล้ว5'],              expect: { bot: 'wait',   notify: 'none' } },
  { name: 'ค่ำ แชทเดิม แจ้งแล้ว 20 นาที → ยังไม่เตือนซ้ำ',   args: ['20:00', 'แจ้งแล้ว20'],             expect: { bot: 'wait',   notify: 'none' } },
  { name: 'ค่ำ ทีมตอบไป 10 นาที → บอทหยุด',               args: ['20:00', 'คนตอบ10'],                expect: { bot: 'silent', notify: 'none' } },
  { name: 'ค่ำ ทีมตอบไป 13 ชม. → บอทกลับมา',              args: ['20:00', 'คนตอบ800', 'แจ้งแล้ว20'],  expect: { bot: 'wait',   notify: 'none' } },
  { name: 'ค่ำ ถามซ้ำคำต่อคำ → แจ้งเสมอ',                 args: ['20:00', 'ซ้ำ', 'แจ้งแล้ว5'],         expect: { bot: 'wait',   notify: 'send' } },
  { name: 'ค่ำ standby (เพจไม่ใช่เจ้าของ thread)',         args: ['20:00', 'standby'],               expect: { bot: 'silent', notify: 'send' } },
  { name: 'ดึก แชทใหม่ → ตอบเลย',                        args: ['03:00'],                          expect: { bot: 'now',    notify: 'send' } },
  { name: 'ดึก ส่งรูปอย่างเดียว',                         args: ['03:00', 'รูป'],                    expect: { bot: 'silent', notify: 'send' } },
  { name: 'ดึก mode=human',                             args: ['03:00', 'mode:human'],            expect: { bot: 'silent', notify: 'send' } },
  { name: 'เช้า แชทใหม่ → รอคน',                         args: ['07:00'],                          expect: { bot: 'wait',   notify: 'send' } },
  { name: 'ขอบ 08:59',                                  args: ['08:59'],                          expect: { bot: 'wait',   notify: 'send' } },
  { name: 'ขอบ 09:00',                                  args: ['09:00'],                          expect: { bot: 'silent', notify: 'skip' } },
  { name: 'ขอบ 18:59',                                  args: ['18:59'],                          expect: { bot: 'silent', notify: 'skip' } },
  { name: 'ขอบ 19:00',                                  args: ['19:00'],                          expect: { bot: 'wait',   notify: 'send' } },
  { name: 'ขอบ 23:59',                                  args: ['23:59'],                          expect: { bot: 'wait',   notify: 'send' } },
  { name: 'ขอบ 00:00',                                  args: ['00:00'],                          expect: { bot: 'now',    notify: 'send' } },
]

const WATCHDOG_SCENARIOS = [
  { name: 'กลางวัน ค้าง 90 นาที → ยังไม่ถึง 2 ชม.',        args: ['10:00', '90'],                 expect: false },
  { name: 'กลางวัน ค้าง 130 นาที ไม่มีใครตอบ → แจ้ง',      args: ['10:00', '130'],                expect: true },
  { name: 'กลางวัน ค้าง 130 แต่ตอบแล้ว → ไม่แจ้ง',         args: ['10:00', '130', 'ตอบแล้ว'],      expect: false },
  { name: 'กลางวัน แจ้งไปแล้ว 60 นาที → ไม่ซ้ำ',            args: ['10:00', '200', 'แจ้งแล้ว60'],   expect: false },
  { name: 'กลางวัน แจ้งไปแล้ว 200 นาที ยังค้าง → ไม่ซ้ำ',    args: ['10:00', '260', 'แจ้งแล้ว200'],  expect: false },
  { name: 'กลางวัน แอดมิน → ไม่แจ้ง',                      args: ['10:00', '130', 'admin'],       expect: false },
  { name: 'ขอบ 18:59 ค้าง 130 → แจ้ง',                     args: ['18:59', '130'],                expect: true },
  { name: 'ค่ำ 21:00 ค้าง 130 → ไม่ใช่หน้าที่ watchdog',     args: ['21:00', '130'],                expect: false },
  { name: 'ขอบ 09:00 ค้าง 130 → แจ้ง',                     args: ['09:00', '130'],                expect: true },
]

// ── รัน ─────────────────────────────────────────────────────────────────────
for (const [i, s] of SCENARIOS.entries()) {
  test(`${String(i + 1).padStart(2)}. ${s.name}`, async () => {
    const { hour, minute, ctx } = parseSim(s.args)
    const inbox = await fbInbox()
    const [raw] = await sql(
      `select inbox.decide_all('${inbox}'::uuid, ${quote(ctx)}::jsonb, '${at(hour, minute)}'::timestamptz, 0);`)
    const d = JSON.parse(raw)
    const got = {
      bot: !d.reply.go ? 'silent' : d.reply.wait_min ? 'wait' : 'now',
      notify: d.notify_action,
    }
    assert.deepEqual(got, s.expect,
      `\n   คาด ${s.expect.bot}/${s.expect.notify}` +
      `\n   ได้  ${got.bot}/${got.notify}` +
      `\n   เหตุผล reply=${d.reply.reason} · notify=${d.notify.reason} · ชั่วโมง ${d.hour} · หน่วง ${d.delay_sec} วิ`)
  })
}

for (const [i, s] of WATCHDOG_SCENARIOS.entries()) {
  test(`W${i + 1}. ${s.name}`, async () => {
    const { hour, minute, w } = parseWd(s.args)
    const inbox = await fbInbox()
    const [raw] = await sql(
      `select inbox.decide_watchdog('${inbox}'::uuid, ${quote(w)}::jsonb, '${at(hour, minute)}'::timestamptz);`)
    const v = JSON.parse(raw)
    assert.equal(v.go, s.expect,
      `\n   คาด ${s.expect ? 'แจ้ง' : 'ไม่แจ้ง'}` +
      `\n   ได้  ${v.go ? 'แจ้ง' : 'ไม่แจ้ง'}` +
      `\n   เหตุผล ${v.reason}`)
  })
}

// ── ตัวดึงเบอร์/LINE จากข้อความ ─────────────────────────────────────────────
//    เพิ่มหลังเจอว่า extract_phone ไม่เคยทำงานเลยตั้งแต่ Phase 3
//    (substring(text from pattern) คืนเฉพาะวงเล็บกลุ่มแรก ไม่ใช่ทั้งก้อน)
//    29 ข้อข้างบนจับไม่ได้เพราะป้อน phone_in_text เข้า ctx ตรง ๆ ไม่ได้เดินผ่านตัวดึง
const EXTRACT = [
  ['ติดต่อกลับที่ 0812345678 นะคะ', '0812345678', 'เบอร์ปนอยู่กลางข้อความไทย'],
  ['081-234-5678',                  '0812345678', 'มีขีดคั่น'],
  ['โทร +66 81 2345678',            '0812345678', 'รูปแบบสากล +66'],
  ['0912345678',                    '0912345678', 'ขึ้นต้น 09'],
  ['0612345678',                    '0612345678', 'ขึ้นต้น 06'],
  ['ราคาเท่าไหร่คะ',                 null,         'ไม่มีเบอร์'],
  ['021234567',                     null,         'เบอร์บ้าน ไม่ใช่มือถือ'],
  ['08123456',                      null,         'สั้นเกินไป'],
]

for (const [text, want, name] of EXTRACT) {
  test(`ดึงเบอร์: ${name}`, async () => {
    const [got] = await sql(`select coalesce(inbox.extract_phone(${quote(text)}), '(null)');`)
    assert.equal(got === '(null)' ? null : got, want, `จาก "${text}"`)
  })
}

test('ดึง LINE id จากข้อความ', async () => {
  for (const [text, want] of [['line: somchai123', 'somchai123'], ['ไลน์ @asherdev', 'asherdev'],
                              ['ราคาเท่าไหร่', null]]) {
    const [got] = await sql(`select coalesce(inbox.extract_line_id(${quote(text)}), '(null)');`)
    assert.equal(got === '(null)' ? null : got, want, `จาก "${text}"`)
  }
})
