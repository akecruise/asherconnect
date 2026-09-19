/**
 * รหัสรีวิวของ Meta App Review — ตรรกะล้วน ไม่แตะฐาน ไม่เปิดเซิร์ฟเวอร์
 *
 *   node --test tests/reviewcode.test.mjs
 *
 * ส่วนที่ต้องมีฐาน (is_test/mode ที่ตั้งจริงในบทสนทนา · ไม่โผล่ในสถิติ ·
 * ไม่มีงาน generate ให้บอทตอบ) อยู่ที่ tests/reviewcode.db.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewCode, tagReviewCode } from '../bots/reviewcode.mjs'

const CODE = 'META-REVIEW'
const messenger = { key: 'asher-messenger', channel: 'messenger' }
const otherMessenger = { key: 'other-page', channel: 'messenger' }
const line = { key: 'naii-line-oa', channel: 'line' }

const msg = (text, extra = {}) => ({ event_type: 'message', text, external_id: 'PSID1', ...extra })

// ── รหัสจาก env ──────────────────────────────────────────────────────────

test('รหัสรีวิวมาจาก env — ไม่ตั้งไว้ใช้ META-REVIEW', () => {
  assert.equal(reviewCode({}), 'META-REVIEW')
  assert.equal(reviewCode({ META_REVIEW_CODE: '' }), 'META-REVIEW')
  assert.equal(reviewCode({ META_REVIEW_CODE: 'ASHER-QA' }), 'ASHER-QA')
})

// ── สามเคสตามสเปค (regression a/b/c ของ STEP 1) ────────────────────────────

test('(a) asher-messenger + ขึ้นต้นด้วยรหัส → ติดธง review_code_hit', () => {
  const out = tagReviewCode(msg(`${CODE} ทดสอบ pages_messaging`), messenger, CODE)
  assert.equal(out.review_code_hit, true)
  assert.equal(out.text, `${CODE} ทดสอบ pages_messaging`, 'ข้อความเดิมต้องอยู่ครบ')
})

test('(b) asher-messenger + ข้อความปกติของลูกค้าจริง → ไม่ติดธง', () => {
  const out = tagReviewCode(msg('สนใจคอนโดครับ ราคาเท่าไหร่'), messenger, CODE)
  assert.equal('review_code_hit' in out, false)
})

test('(c) ช่องทางอื่นพิมพ์รหัสเดียวกัน → ไม่ติดธง', () => {
  assert.equal('review_code_hit' in tagReviewCode(msg(CODE), otherMessenger, CODE), false)
  assert.equal('review_code_hit' in tagReviewCode(msg(CODE), line, CODE), false)
})

// ── ขอบเขต ──────────────────────────────────────────────────────────────

test('ต้อง "ขึ้นต้นด้วย" ไม่ใช่ "มีอยู่ตรงไหนก็ได้" — คำตรงกลางข้อความไม่นับ', () => {
  const out = tagReviewCode(msg(`สนใจ ${CODE} ครับ`), messenger, CODE)
  assert.equal('review_code_hit' in out, false)
})

test('event_type อื่น (echo/postback/follow) ไม่เข้าเงื่อนไข แม้ text จะตรงรหัส', () => {
  for (const event_type of ['echo', 'postback', 'follow', 'unfollow']) {
    const out = tagReviewCode(msg(CODE, { event_type }), messenger, CODE)
    assert.equal('review_code_hit' in out, false, event_type)
  }
})

test('ไม่มี text (เช่นสื่อแนบ) ต้องไม่พัง และไม่ติดธง', () => {
  for (const bad of [undefined, null, 123]) {
    const out = tagReviewCode({ event_type: 'message', text: bad }, messenger, CODE)
    assert.equal('review_code_hit' in out, false, String(bad))
  }
})

test('ไม่ hit → คืน object เดิม (reference เท่าเดิม) ไม่คัดลอกโดยไม่จำเป็น', () => {
  const event = msg('สวัสดีค่ะ')
  assert.equal(tagReviewCode(event, messenger, CODE), event)
})

test('hit แล้วต้องไม่แก้ event เดิมแบบ in-place', () => {
  const event = msg(`${CODE} test`)
  const out = tagReviewCode(event, messenger, CODE)
  assert.notEqual(out, event)
  assert.equal('review_code_hit' in event, false, 'ต้นฉบับต้องไม่ถูกแก้')
})

test('รหัสตรงตัวพิมพ์เท่านั้น — ผู้ตรวจสอบพิมพ์ผิดตัวพิมพ์ต้องไม่ติดธงเงียบ ๆ', () => {
  // ★ ตั้งใจไม่ทำ case-insensitive: รหัสรีวิวควรพิมพ์ตามที่แจ้งผู้ตรวจสอบเป๊ะ ๆ
  //   กัน false positive จากลูกค้าจริงที่บังเอิญพิมพ์คำคล้ายกันแบบตัวพิมพ์เล็ก
  const out = tagReviewCode(msg('meta-review test'), messenger, CODE)
  assert.equal('review_code_hit' in out, false)
})
