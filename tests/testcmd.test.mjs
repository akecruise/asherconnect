/**
 * คำสั่ง "test" ของบัญชีทดสอบ — ตรรกะล้วน ไม่แตะฐาน ไม่เปิดเซิร์ฟเวอร์
 *
 *   node --test tests/testcmd.test.mjs
 *
 * ส่วนที่ต้องมีฐาน (human→bot · ไม่โผล่ในสถิติ) อยู่ที่ tests/testreset.db.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { testUserIds, isTestKeyword, testCandidates, testResetTargets,
         splitTestEvents, countEvents } from '../bots/testcmd.mjs'

const ALLOW = testUserIds({ TEST_USER_IDS: ' Uaaa , PSID111 ,, ' })

const lineBody = (userId, text) => ({
  events: [{ type: 'message', source: { type: 'user', userId }, message: { type: 'text', text }, replyToken: 'rt1' }],
})
const fbBody = (senderId, text, extra = {}) => ({
  entry: [{ messaging: [{ sender: { id: senderId }, message: { text, ...extra } }] }],
})

// ── รายชื่อจาก env ────────────────────────────────────────────────────────

test('รายชื่อบัญชีทดสอบมาจาก env และทนช่องว่าง/จุลภาคเกิน', () => {
  assert.deepEqual([...ALLOW].sort(), ['PSID111', 'Uaaa'])
  assert.equal(testUserIds({}).size, 0)                       // ไม่ตั้ง = ปิดฟีเจอร์
  assert.equal(testUserIds({ TEST_USER_IDS: '' }).size, 0)
})

// ── คำสั่ง ────────────────────────────────────────────────────────────────

test('รับเฉพาะข้อความที่เป็นคำสั่งทั้งข้อความ', () => {
  for (const ok of ['test', 'TEST', ' Test ', '#test', '#TEST']) {
    assert.equal(isTestKeyword(ok), true, ok)
  }
  // ★ ข้อสำคัญที่สุด — ลูกค้าจริงพิมพ์ "test ระบบ" ต้องไม่โดนรีเซ็ตแชทตัวเอง
  for (const no of ['test ระบบ', 'testing', 'ทดสอบ test', 'test123', '', null, undefined]) {
    assert.equal(isTestKeyword(no), false, String(no))
  }
})

// ── ดึงผู้ส่งจากก้อนดิบ ────────────────────────────────────────────────────

test('ดึงผู้ส่งจากก้อนดิบได้ทั้ง LINE และ Messenger', () => {
  assert.deepEqual(testCandidates('line', lineBody('Uaaa', 'test')),
    [{ userId: 'Uaaa', text: 'test', replyToken: 'rt1' }])
  assert.deepEqual(testCandidates('messenger', fbBody('PSID111', 'test')),
    [{ userId: 'PSID111', text: 'test', replyToken: null }])
})

test('echo ของเราเองต้องไม่ถูกนับเป็นคำสั่ง', () => {
  // ไม่กันไว้ = ข้อความที่บอทส่งออกไปเองอาจวนกลับมารีเซ็ตแชท
  assert.deepEqual(testCandidates('messenger', fbBody('PSID111', 'test', { is_echo: true })), [])
})

test('ก้อนที่ไม่ใช่ข้อความ (join/postback/ว่าง) ต้องไม่พัง', () => {
  for (const body of [{}, { events: [] }, { events: [{ type: 'join', source: { type: 'group' } }] },
                      { entry: [] }, { entry: [{}] }, null]) {
    assert.deepEqual(testResetTargets('line', body, ALLOW), [])
    assert.deepEqual(testResetTargets('messenger', body, ALLOW), [])
  }
})

// ── สามเคสตามสเปค ────────────────────────────────────────────────────────

test('อยู่ในรายชื่อ + "test" → รีเซ็ต', () => {
  assert.equal(testResetTargets('line', lineBody('Uaaa', 'test'), ALLOW).length, 1)
  assert.equal(testResetTargets('messenger', fbBody('PSID111', '#test'), ALLOW).length, 1)
})

test('ไม่อยู่ในรายชื่อ + "test" → ข้อความปกติ', () => {
  assert.deepEqual(testResetTargets('line', lineBody('Uลูกค้าจริง', 'test'), ALLOW), [])
  assert.deepEqual(testResetTargets('messenger', fbBody('PSID999', 'test'), ALLOW), [])
})

test('อยู่ในรายชื่อ + "test อะไรก็ได้" → ข้อความปกติ', () => {
  assert.deepEqual(testResetTargets('line', lineBody('Uaaa', 'test ระบบ'), ALLOW), [])
  assert.deepEqual(testResetTargets('messenger', fbBody('PSID111', 'test ราคา'), ALLOW), [])
})

test('ไม่ตั้ง TEST_USER_IDS = ปิดสนิท แม้คนในทีมพิมพ์ test', () => {
  assert.deepEqual(testResetTargets('line', lineBody('Uaaa', 'test'), new Set()), [])
})

// ── แยก event: ข้อความลูกค้าต้องไม่หายเมื่อ webhook มาเป็นชุด ──────────────
//
// บั๊กเดิม: เจอคำสั่ง test แค่ event เดียว แล้วตัดทั้งก้อนทิ้ง
// ข้อความลูกค้าจริงที่มาในก้อนเดียวกันจะหายโดยไม่มี log ไม่มีเคส

const lineBatch = (...events) => ({ destination: 'Uzz', events })
const lineEvent = (userId, text) => ({
  type: 'message', source: { type: 'user', userId },
  message: { type: 'text', text }, replyToken: 'rt-' + userId,
})

test('LINE: ก้อนมีทั้งคำสั่ง test และข้อความลูกค้า → ลูกค้าต้องยังอยู่', () => {
  const body = lineBatch(
    lineEvent('Uaaa', 'test'),
    lineEvent('Uลูกค้า1', 'ราคาเท่าไหร่คะ'),
    lineEvent('Uลูกค้า2', 'สนใจค่ะ'))

  const { hits, rest, remaining } = splitTestEvents('line', body, ALLOW)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].userId, 'Uaaa')
  assert.equal(remaining, 2)
  assert.deepEqual(rest.events.map(e => e.source.userId), ['Uลูกค้า1', 'Uลูกค้า2'])
  assert.equal(rest.destination, 'Uzz', 'key อื่นของก้อนต้องอยู่ครบ')
  assert.equal(body.events.length, 3, 'ห้ามแก้ body ต้นฉบับแบบ in-place')
})

test('Messenger: หลาย entry / หลาย messaging → ตัดเฉพาะคำสั่ง', () => {
  const body = { object: 'page', entry: [
    { id: 'PAGE', time: 1, messaging: [
      { sender: { id: 'PSID111' }, message: { text: 'test' } },
      { sender: { id: 'ลูกค้าA' }, message: { text: 'สนใจครับ' } },
    ]},
    { id: 'PAGE', time: 2, messaging: [
      { sender: { id: 'ลูกค้าB' }, message: { text: 'ห้องว่างไหม' } },
    ]},
  ]}

  const { hits, rest, remaining } = splitTestEvents('messenger', body, ALLOW)
  assert.equal(hits.length, 1)
  assert.equal(remaining, 2)
  assert.deepEqual(rest.entry.map(en => en.messaging.map(m => m.sender.id)),
    [['ลูกค้าA'], ['ลูกค้าB']])
  assert.equal(body.entry[0].messaging.length, 2, 'ห้ามแก้ body ต้นฉบับแบบ in-place')
})

test('Messenger: entry ที่เหลือแต่คำสั่ง ต้องถูกทิ้ง แต่ standby ต้องอยู่', () => {
  // providers.mjs อ่านทั้ง messaging และ standby — ทิ้ง standby = ทิ้ง event จริง
  const body = { entry: [
    { id: 'PAGE', messaging: [{ sender: { id: 'PSID111' }, message: { text: 'test' } }] },
    { id: 'PAGE', messaging: [{ sender: { id: 'PSID111' }, message: { text: '#test' } }],
      standby: [{ sender: { id: 'ลูกค้าC' }, message: { text: 'สวัสดี' } }] },
  ]}

  const { hits, rest, remaining } = splitTestEvents('messenger', body, ALLOW)
  assert.equal(hits.length, 2)
  assert.equal(rest.entry.length, 1, 'entry ที่ว่างเปล่าต้องถูกทิ้ง')
  assert.equal(rest.entry[0].standby.length, 1, 'standby ต้องอยู่ครบ')
  assert.equal(remaining, 1)
})

test('ก้อนที่มีแต่คำสั่ง → ไม่เหลืออะไรให้ log', () => {
  const line = splitTestEvents('line', lineBatch(lineEvent('Uaaa', 'test')), ALLOW)
  assert.equal(line.hits.length, 1)
  assert.equal(line.remaining, 0)

  const fb = splitTestEvents('messenger', fbBody('PSID111', 'test'), ALLOW)
  assert.equal(fb.hits.length, 1)
  assert.equal(fb.remaining, 0)
})

test('ไม่มีคำสั่งในก้อน → คืน body เดิมทั้งก้อน ไม่คัดลอกโดยไม่จำเป็น', () => {
  const body = lineBatch(lineEvent('Uลูกค้า1', 'ราคา'))
  const out = splitTestEvents('line', body, ALLOW)
  assert.deepEqual(out.hits, [])
  assert.equal(out.rest, body, 'ต้องเป็น object เดิม ไม่ใช่สำเนา')
  assert.equal(out.remaining, 1)
})

test('countEvents นับทั้ง messaging และ standby', () => {
  assert.equal(countEvents('line', lineBatch(lineEvent('U1', 'a'), lineEvent('U2', 'b'))), 2)
  assert.equal(countEvents('messenger', { entry: [
    { messaging: [1, 2], standby: [3] }, { messaging: [4] }] }), 4)
  assert.equal(countEvents('line', null), 0)
  assert.equal(countEvents('messenger', {}), 0)
})
