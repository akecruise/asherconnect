// LIFF นัดชมโครงการ (lib/liff.mjs) — Phase 4
//
// ★ ไม่ต่อฐาน ไม่ต่อเน็ต: verifyIdToken รับ fetcher เข้ามา จึงยัด stub ได้ตรง ๆ
// ★★ ชุดนี้คือด่านกัน "จองนัดในชื่อคนอื่น" — ถ้า assertion ไหนหลุด ความเสียหายคือ
//    ใครก็ปลอมตัวเป็นลูกค้าคนใดก็ได้

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyIdToken, validateSiteVisit,
  MIN_LEAD_MINUTES, MAX_AHEAD_DAYS, MAX_VISITORS, MAX_NOTE,
} from '../lib/liff.mjs'

const CHANNEL = '1234567890'
const NOW = 1_800_000_000_000
const ok = claims => async () => ({ ok: true, status: 200, json: async () => claims })

const valid = {
  iss: 'https://access.line.me', sub: 'Uabcdef', aud: CHANNEL,
  exp: Math.floor(NOW / 1000) + 600, name: 'ลูกค้า ทดสอบ',
}

test('token ที่ถูกต้องคืน userId จาก sub ไม่ใช่จากที่ client ส่งมา', async () => {
  const out = await verifyIdToken({ idToken: 't', channelId: CHANNEL }, ok(valid), NOW)
  assert.equal(out.ok, true)
  assert.equal(out.userId, 'Uabcdef')
  assert.equal(out.displayName, 'ลูกค้า ทดสอบ')
})

test('★ aud ไม่ตรงช่องของเรา = ไม่ผ่าน', async () => {
  // ถ้าไม่ตรวจข้อนี้ ใครมี LINE Login channel ของตัวเองก็ออก token มาใช้กับเราได้
  const other = await verifyIdToken({ idToken: 't', channelId: CHANNEL },
    ok({ ...valid, aud: '9999999999' }), NOW)
  assert.equal(other.ok, false)
  assert.equal(other.reason, 'audience_mismatch')

  // aud เป็น array ก็ต้องมีช่องของเราอยู่ในนั้น
  assert.equal((await verifyIdToken({ idToken: 't', channelId: CHANNEL },
    ok({ ...valid, aud: ['1111', CHANNEL] }), NOW)).ok, true)
  assert.equal((await verifyIdToken({ idToken: 't', channelId: CHANNEL },
    ok({ ...valid, aud: ['1111', '2222'] }), NOW)).reason, 'audience_mismatch')
})

test('token หมดอายุ = ไม่ผ่าน', async () => {
  const expired = await verifyIdToken({ idToken: 't', channelId: CHANNEL },
    ok({ ...valid, exp: Math.floor(NOW / 1000) - 1 }), NOW)
  assert.equal(expired.reason, 'id_token_expired')
})

test('ไม่มี sub / sub ว่าง = ไม่ผ่าน (ไม่มีตัวตนให้ผูกนัด)', async () => {
  for (const sub of [undefined, '', '   ', 123]) {
    const out = await verifyIdToken({ idToken: 't', channelId: CHANNEL },
      ok({ ...valid, sub }), NOW)
    assert.equal(out.ok, false, `sub ${JSON.stringify(sub)} ต้องไม่ผ่าน`)
  }
})

test('LINE ปฏิเสธ token = ไม่ผ่าน · LINE ไม่ตอบ = ยังยืนยันไม่ได้ ไม่ใช่ผ่าน', async () => {
  const rejected = await verifyIdToken({ idToken: 't', channelId: CHANNEL },
    async () => ({ ok: false, status: 400, json: async () => ({}) }), NOW)
  assert.equal(rejected.reason, 'id_token_rejected')

  // ★ timeout ต้องไม่ถูกตีความว่าผ่าน — ไม่งั้นแค่ทำให้ LINE ช้าก็ปลอมตัวได้
  const down = await verifyIdToken({ idToken: 't', channelId: CHANNEL },
    async () => { throw new Error('timeout') }, NOW)
  assert.equal(down.ok, false)
  assert.equal(down.reason, 'verify_unavailable')

  const garbage = await verifyIdToken({ idToken: 't', channelId: CHANNEL },
    async () => ({ ok: true, status: 200, json: async () => null }), NOW)
  assert.equal(garbage.reason, 'id_token_rejected')
})

test('ไม่มี token / ยังไม่ตั้งค่า = ไม่ยิงเน็ตเลย', async () => {
  let calls = 0
  const spy = async () => { calls++; return { ok: true, status: 200, json: async () => valid } }
  assert.equal((await verifyIdToken({ idToken: '', channelId: CHANNEL }, spy, NOW)).reason, 'id_token_required')
  assert.equal((await verifyIdToken({ idToken: 't', channelId: '' }, spy, NOW)).reason, 'liff_not_configured')
  assert.equal(calls, 0)
})

test('ส่ง id_token + client_id ไปที่ปลายทางของ LINE และไม่มีอย่างอื่นหลุดไป', async () => {
  let seen = null
  await verifyIdToken({ idToken: 'the-token', channelId: CHANNEL }, async (url, init) => {
    seen = { url, body: init.body, headers: init.headers }
    return { ok: true, status: 200, json: async () => valid }
  }, NOW)
  assert.equal(seen.url, 'https://api.line.me/oauth2/v2.1/verify')
  const params = new URLSearchParams(seen.body)
  assert.deepEqual([...params.keys()].sort(), ['client_id', 'id_token'])
  assert.equal(params.get('id_token'), 'the-token')
  assert.equal(params.get('client_id'), CHANNEL)
})

// ───────────────────────────────────────────── ตรวจคำขอจองนัด

const future = ms => new Date(NOW + ms).toISOString()

test('เวลาต้องมีเขตเวลาติดมา', () => {
  // ★ "2026-10-10T14:00" เปล่า ๆ จะถูกตีความด้วยเขตเวลาของ server แล้วนัดเพี้ยนชั่วโมง
  assert.equal(validateSiteVisit({ scheduled_at: '2026-10-10T14:00' }, NOW).error,
               'scheduled_at_must_have_timezone')
  assert.equal(validateSiteVisit({ scheduled_at: '2026-10-10' }, NOW).error,
               'scheduled_at_must_have_timezone')
  assert.equal(validateSiteVisit({ scheduled_at: future(86400000) }, NOW).ok, true)
  assert.equal(validateSiteVisit({ scheduled_at: '2026-10-10T14:00+07:00' }, Date.parse('2026-10-01')).ok, true)
})

test('นัดเร็วเกินไป / ไกลเกินไป = ไม่รับ', () => {
  assert.equal(validateSiteVisit({ scheduled_at: future(10 * 60000) }, NOW).error, 'too_soon')
  assert.equal(validateSiteVisit({ scheduled_at: future(MIN_LEAD_MINUTES * 60000 + 1000) }, NOW).ok, true)
  assert.equal(validateSiteVisit({ scheduled_at: future((MAX_AHEAD_DAYS + 1) * 86400000) }, NOW).error,
               'too_far_ahead')
  // เวลาในอดีตก็คือเร็วเกินไป
  assert.equal(validateSiteVisit({ scheduled_at: new Date(NOW - 86400000).toISOString() }, NOW).error, 'too_soon')
})

test('จำนวนคน: 1 เป็นค่าตั้งต้น · นอกช่วง / ไม่ใช่จำนวนเต็ม = ไม่รับ', () => {
  const at = future(86400000)
  assert.equal(validateSiteVisit({ scheduled_at: at }, NOW).visit.visitor_count, 1)
  assert.equal(validateSiteVisit({ scheduled_at: at, visitor_count: MAX_VISITORS }, NOW).ok, true)
  for (const bad of [0, -1, MAX_VISITORS + 1, 1.5, 'สอง', NaN]) {
    assert.equal(validateSiteVisit({ scheduled_at: at, visitor_count: bad }, NOW).error,
                 'invalid_visitor_count', `${bad} ต้องไม่ผ่าน`)
  }
})

test('โน้ตยาวเกิน = ไม่รับ · ว่างเปล่ากลายเป็น null', () => {
  const at = future(86400000)
  assert.equal(validateSiteVisit({ scheduled_at: at, note: 'x'.repeat(MAX_NOTE) }, NOW).ok, true)
  assert.equal(validateSiteVisit({ scheduled_at: at, note: 'x'.repeat(MAX_NOTE + 1) }, NOW).error,
               'note_too_long')
  assert.equal(validateSiteVisit({ scheduled_at: at, note: '   ' }, NOW).visit.note, null)
  assert.equal(validateSiteVisit({ scheduled_at: at, note: ' สนใจ 2 นอน ' }, NOW).visit.note, 'สนใจ 2 นอน')
})

test('project_ref รับเฉพาะรูปที่ปลอดภัย', () => {
  const at = future(86400000)
  assert.equal(validateSiteVisit({ scheduled_at: at, project_ref: 'asher-vibe' }, NOW).visit.project_ref,
               'asher-vibe')
  assert.equal(validateSiteVisit({ scheduled_at: at }, NOW).visit.project_ref, null)
  for (const bad of ["a'; drop table x--", 'มีไทย', 'a b', 'x'.repeat(65)]) {
    assert.equal(validateSiteVisit({ scheduled_at: at, project_ref: bad }, NOW).error,
                 'invalid_project_ref', `${bad} ต้องไม่ผ่าน`)
  }
})

test('เวลาที่ผ่านการตรวจถูกทำให้เป็น ISO มาตรฐานเสมอ', () => {
  const out = validateSiteVisit({ scheduled_at: '2026-10-10T14:00:00+07:00' }, Date.parse('2026-10-01'))
  assert.equal(out.visit.scheduled_at, '2026-10-10T07:00:00.000Z')
})
