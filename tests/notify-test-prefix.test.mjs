/**
 * [TEST] นำหน้าข้อความแจ้งทีม — แชททดสอบต้องแยกออกจากของจริงตั้งแต่บรรทัดแรก
 *
 *   node --test tests/notify-test-prefix.test.mjs
 *
 * ★ เรียก formatNotify() ตัวเดียวกับที่ server.mjs:515 ใช้จริง ไม่ก๊อปตรรกะมาเทสต์
 *   ถ้าวันหน้ามีคนแก้ headline แล้วลืม prefix เทสต์ชุดนี้จะล้มทันที
 *
 * ★ ไม่แตะฐาน ไม่ยิงข้อความออกจริง — formatNotify เป็นฟังก์ชันเรียงคำล้วน
 *   ส่วนที่ยิงออก (deliver) อยู่คนละชั้น จึงไม่มีอะไรให้ mock
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { formatNotify, withTestPrefix, TEST_PREFIX } from '../bots/notify.mjs'

// payload ตามที่ฐานส่งมาจริง (sql/002_decide.sql — งาน notify channel='team')
const base = {
  display_name: 'สมชาย', is_new_chat: true, topic: 'ราคา',
  text: 'ราคาเท่าไหร่คะ', reply_go: true, wait_min: 30, channel_label: ' LINE',
}
const head = (p) => formatNotify(p).split('\n')[0]

// ── headline ทั้ง 4 แบบที่ formatNotify สร้างได้ ────────────────────────────
// ไล่จาก headline() ใน notify.mjs — ทุกแบบต้องติด prefix ไม่ใช่แค่แบบเดียว
const VARIANTS = [
  ['บอทจะตอบ (🟡)',      { ...base, reply_go: true },                          '🟡'],
  ['บอทเงียบ (🟠)',      { ...base, reply_go: false },                         '🟠'],
  ['ได้เบอร์ (🔴)',       { ...base, phone: '0812345678' },                     '🔴'],
  ['ได้ LINE (🔴)',      { ...base, line_id: 'somchai' },                      '🔴'],
  ['ถามซ้ำคำต่อคำ (🔴)', { ...base, verbatim_repeat: true },                    '🔴'],
  ['ค้างตอบ (watchdog)', { kind: 'watchdog', min_since_msg: 130, text: 'ราคา' }, '🟠'],
]

// ── 1. is_test = true ────────────────────────────────────────────────────────

test('is_test = true → ขึ้นต้นด้วย [TEST] ทุกรูปแบบของ headline', () => {
  for (const [name, payload, icon] of VARIANTS) {
    const line = head({ ...payload, is_test: true })
    assert.equal(line.startsWith(TEST_PREFIX), true, `${name}: ได้ "${line}"`)
    // prefix ต้องมาก่อนไอคอน ไม่ใช่แทรกกลาง
    assert.equal(line.startsWith(TEST_PREFIX + icon), true, `${name}: ไอคอนต้องตามหลัง prefix`)
  }
})

test('เนื้อความอื่นต้องไม่เปลี่ยน — prefix แตะแค่บรรทัดแรก', () => {
  const plain = formatNotify({ ...base, is_test: false })
  const tagged = formatNotify({ ...base, is_test: true })
  assert.equal(tagged.split('\n').slice(1).join('\n'), plain.split('\n').slice(1).join('\n'))
  assert.equal(tagged.includes('ข้อความ: ราคาเท่าไหร่คะ'), true)
})

// ── 2. is_test = false ───────────────────────────────────────────────────────

test('is_test = false → ไม่มี [TEST]', () => {
  for (const [name, payload] of VARIANTS) {
    const line = head({ ...payload, is_test: false })
    assert.equal(line.includes(TEST_PREFIX), false, `${name}: ได้ "${line}"`)
  }
})

// ── 3. ไม่มีคีย์ is_test (payload จากฐานรุ่นเก่า) ─────────────────────────────
//
// ★ เคสนี้สำคัญที่สุด — sql/033 ยก receive_event มาจาก 006 ซึ่งไม่มี is_test
//   ระหว่างที่ยังไม่ได้แทรกกลับ payload จริงจะไม่มีคีย์นี้เลย ต้องไม่พังและไม่ติด prefix

test('ไม่มีคีย์ is_test → ไม่มี [TEST] และไม่ error', () => {
  for (const [name, payload] of VARIANTS) {
    const p = { ...payload }
    delete p.is_test
    assert.equal('is_test' in p, false)
    const line = head(p)
    assert.equal(line.includes(TEST_PREFIX), false, `${name}: ได้ "${line}"`)
    assert.equal(line.length > 0, true, `${name}: ต้องยังได้ข้อความ`)
  }
})

test('payload ว่าง / undefined ต้องไม่ error', () => {
  assert.doesNotThrow(() => formatNotify())
  assert.doesNotThrow(() => formatNotify({}))
  assert.doesNotThrow(() => formatNotify({ is_test: undefined }))
  assert.equal(formatNotify({}).includes(TEST_PREFIX), false)
})

// ── ชนิดของค่า is_test — ตัดสินว่าอะไรนับว่า "ใช่" ────────────────────────
//
// กติกา: รับเฉพาะ true · 1 · "true" — ที่เหลือถือว่าไม่ใช่แชททดสอบ
// เหตุผลอยู่ในคอมเมนต์ของ isTestFlag() ใน bots/notify.mjs
// สรุปสั้น: ติดป้ายผิดให้ลูกค้าจริง = เสียลูกค้า · ไม่ติดป้ายแชททดสอบ = เสียเวลา
// ความเสียหายไม่สมมาตร จึงต้อง "บอกชัดว่าใช่" เท่านั้นถึงติด

test('ค่าที่นับว่าเป็นแชททดสอบ: true · 1 · "true"', () => {
  for (const v of [true, 1, 'true']) {
    assert.equal(head({ ...base, is_test: v }).startsWith(TEST_PREFIX), true,
      `is_test=${JSON.stringify(v)} ควรติด prefix`)
    assert.equal(withTestPrefix('🟡 มีคนทัก', v), '[TEST] 🟡 มีคนทัก', `withTestPrefix กับ ${JSON.stringify(v)}`)
  }
})

test('★ สตริง "false" ต้องไม่ติด prefix — truthy ใน JS แต่หมายถึงไม่ใช่', () => {
  // เคสที่อันตรายที่สุด: ถ้าใช้ truthy ลอย ๆ แชทลูกค้าจริงทุกคนจะติด [TEST]
  // ทันทีที่มีใคร stringify payload ระหว่างทาง แล้วทีมจะมองข้ามลูกค้าจริง
  assert.equal(head({ ...base, is_test: 'false' }).includes(TEST_PREFIX), false)
  assert.equal(withTestPrefix('🟡 มีคนทัก', 'false'), '🟡 มีคนทัก')
})

test('ค่าที่ไม่นับว่าเป็นแชททดสอบ: false · "false" · 0 · null · undefined · "" · "TRUE"', () => {
  for (const v of [false, 'false', 0, null, undefined, '', '0', 'TRUE', 'yes', 2, {}, []]) {
    assert.equal(head({ ...base, is_test: v }).includes(TEST_PREFIX), false,
      `is_test=${JSON.stringify(v)} ต้องไม่ติด prefix`)
  }
})

test('null ต่างจาก false อย่างไร — ทั้งคู่แปลว่าไม่ใช่แชททดสอบ', () => {
  // คอลัมน์เป็น not null default false จึงไม่ควรเจอ null ในทางปฏิบัติ
  // แต่ payload ที่ไม่มีคีย์ (sql/033 ยก receive_event จาก 006) จะให้ undefined
  assert.equal(head({ ...base, is_test: null }), head({ ...base, is_test: false }))
  assert.equal(head({ ...base, is_test: undefined }), head({ ...base, is_test: false }))
})

// ── 4. ติดซ้ำไม่ได้ ──────────────────────────────────────────────────────────

test('ข้อความที่มี [TEST] อยู่แล้ว ต้องไม่กลายเป็น [TEST] [TEST]', () => {
  const once = withTestPrefix('🟡 มีคนทัก', true)
  const twice = withTestPrefix(once, true)
  assert.equal(once, '[TEST] 🟡 มีคนทัก')
  assert.equal(twice, once, 'เรียกซ้ำต้องได้ผลเดิม (idempotent)')
  assert.equal(twice.match(/\[TEST\]/g).length, 1, 'ต้องมี [TEST] แค่ครั้งเดียว')
})

test('withTestPrefix: ไม่ใช่แชททดสอบ → คืนข้อความเดิมไม่แตะ', () => {
  assert.equal(withTestPrefix('🟡 มีคนทัก', false), '🟡 มีคนทัก')
  assert.equal(withTestPrefix('[TEST] 🟡 มีคนทัก', false), '[TEST] 🟡 มีคนทัก')
  assert.equal(withTestPrefix(null, false), '')
  assert.equal(withTestPrefix(undefined, true), '')
})

// ── 5. ทางที่ไม่ใช้ is_test — บันทึกไว้ว่าเป็นความตั้งใจ ─────────────────────
//
// notify มีสองทาง: formatNotify (แจ้งทีมทุกข้อความ) กับ buildDailyDigest (สรุปรายวัน)
// ทางหลังไม่ติด [TEST] โดยตั้งใจ เพราะเป็นตัวเลขรวมซึ่งกรอง is_test ออก
// ตั้งแต่ inbox.reply_episodes แล้ว (sql/009_report.sql) — ไม่มีข้อมูลทดสอบให้ต้องเตือน

test('buildDailyDigest เป็นคนละทาง ไม่รับ is_test โดยตั้งใจ', async () => {
  const { buildDailyDigest } = await import('../reports/reply-digest.mjs')
  const out = buildDailyDigest({ asked: 0, human: 0, bot: 0, unanswered: [], rows: [] })
  assert.equal(typeof out, 'string')
  assert.equal(out.includes(TEST_PREFIX), false, 'รายงานสรุปต้องไม่มี [TEST]')
})
