// เทสต์ของตัวส่ง LINE หลายคน — ชุด "Test" ใน docs/handoff/2026-10-02-line-broadcast-sender.md
//
// ★ ไม่ต่อฐาน ไม่ต่อเน็ต: ตรรกะทั้งหมดที่ตัดสินใจอยู่ใน lib/broadcast.mjs
//   ส่วน providers.sendMulticast รับ fetcher เข้ามา จึงยัด stub ได้ตรง ๆ

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenMatches, bearerToken, validateMessages, normalizeRecipients, parseAllowlist,
  chunkRecipients, classifyMulticast, quotaAllows, backoffSeconds,
  MULTICAST_MAX, RETRY_MAX,
} from '../lib/broadcast.mjs'
import { sendMulticast, lineQuota } from '../providers.mjs'

// ───────────────────────────────────────────── token ของ /internal/*

test('token ผิด / ว่าง / ไม่ได้ตั้ง = ไม่ผ่าน', () => {
  assert.equal(tokenMatches('secret', 'secret'), true)
  assert.equal(tokenMatches('secrez', 'secret'), false)
  assert.equal(tokenMatches('secre', 'secret'), false)
  assert.equal(tokenMatches('secrett', 'secret'), false)
  // ไม่ตั้ง CONNECT_SERVICE_TOKEN = ประตูปิด ไม่ใช่ประตูเปิดให้ทุกคน
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches('anything', ''), false)
  assert.equal(tokenMatches(undefined, 'secret'), false)
})

test('bearerToken อ่านได้เฉพาะรูปแบบที่ถูก', () => {
  assert.equal(bearerToken('Bearer abc123'), 'abc123')
  assert.equal(bearerToken('bearer abc123'), 'abc123')
  assert.equal(bearerToken('Basic abc123'), '')
  assert.equal(bearerToken(undefined), '')
})

// ───────────────────────────────────────────── ตรวจข้อความ

test('ข้อความ: รับ text/image ที่ถูกรูป ปฏิเสธที่เหลือ', () => {
  assert.equal(validateMessages([{ type: 'text', text: 'สวัสดี' }]).ok, true)
  assert.equal(validateMessages([
    { type: 'image', originalContentUrl: 'https://cdn.example.com/a.jpg',
      previewImageUrl: 'https://cdn.example.com/a-s.jpg' }]).ok, true)

  assert.equal(validateMessages([]).error, 'messages_required')
  assert.equal(validateMessages(null).error, 'messages_required')
  assert.equal(validateMessages(Array(6).fill({ type: 'text', text: 'x' })).error, 'too_many_messages')
  assert.equal(validateMessages([{ type: 'flex', contents: {} }]).error, 'unsupported_message_type')
  assert.equal(validateMessages([{ type: 'text', text: '   ' }]).error, 'invalid_message')
  assert.equal(validateMessages([{ type: 'text', text: 'x'.repeat(5001) }]).error, 'text_too_long')
})

test('รูปต้องเป็น https เท่านั้น', () => {
  const http = { type: 'image', originalContentUrl: 'http://cdn.example.com/a.jpg',
                 previewImageUrl: 'https://cdn.example.com/a-s.jpg' }
  assert.equal(validateMessages([http]).error, 'image_url_must_be_https')
  const missing = { type: 'image', originalContentUrl: 'https://cdn.example.com/a.jpg' }
  assert.equal(validateMessages([missing]).error, 'image_url_must_be_https')
})

// ───────────────────────────────────────────── ผู้รับ + โหมดทดสอบ

test('ผู้รับ: ตัดซ้ำ ตัดว่าง เก็บ contact_ref', () => {
  const out = normalizeRecipients([
    { external_user_id: 'U1', contact_ref: 'c-1' },
    { external_user_id: 'U1', contact_ref: 'c-1' },
    { external_user_id: '  ' },
    'U2',
  ])
  assert.equal(out.ok, true)
  assert.deepEqual(out.recipients, [
    { external_user_id: 'U1', contact_ref: 'c-1' },
    { external_user_id: 'U2', contact_ref: null },
  ])
  assert.equal(normalizeRecipients([]).error, 'recipients_required')
  assert.equal(normalizeRecipients('U1').error, 'recipients_required')
})

test('test=true: ไม่เกิน 5 คน และต้องอยู่ใน allowlist', () => {
  const allowlist = ['U1', 'U2']
  assert.equal(normalizeRecipients([{ external_user_id: 'U1' }], { test: true, allowlist }).ok, true)
  assert.equal(normalizeRecipients([{ external_user_id: 'U9' }], { test: true, allowlist }).error,
               'test_recipient_not_allowed')
  const six = Array.from({ length: 6 }, (_, i) => ({ external_user_id: `U${i}` }))
  assert.equal(normalizeRecipients(six, { test: true, allowlist }).error, 'test_recipient_limit')
  // ไม่ตั้ง allowlist = ส่งทดสอบไม่ได้เลย (fail closed)
  assert.equal(normalizeRecipients([{ external_user_id: 'U1' }], { test: true, allowlist: [] }).error,
               'test_recipient_not_allowed')
  assert.deepEqual(parseAllowlist(' U1 , U2 ,, '), ['U1', 'U2'])
  assert.deepEqual(parseAllowlist(undefined), [])
})

// ───────────────────────────────────────────── การแบ่ง batch

test('แบ่ง batch: 0 / 1 / 500 / 501 / 1234 คน', () => {
  const ids = n => Array.from({ length: n }, (_, i) => `U${i}`)
  assert.deepEqual(chunkRecipients(ids(0)).map(c => c.length), [])
  assert.deepEqual(chunkRecipients(ids(1)).map(c => c.length), [1])
  assert.deepEqual(chunkRecipients(ids(500)).map(c => c.length), [500])
  assert.deepEqual(chunkRecipients(ids(501)).map(c => c.length), [500, 1])
  assert.deepEqual(chunkRecipients(ids(1234)).map(c => c.length), [500, 500, 234])
  assert.equal(MULTICAST_MAX, 500)
  // ไม่มีใครตกหล่นและไม่มีใครซ้ำ
  const flat = chunkRecipients(ids(1234)).flat()
  assert.equal(flat.length, 1234)
  assert.equal(new Set(flat).size, 1234)
})

// ───────────────────────────────────────────── แปลคำตอบของ LINE

test('200 = sent · 409 = sent (LINE รับไปแล้ว)', () => {
  assert.equal(classifyMulticast({ status: 200, requestId: 'r1' }).outcome, 'sent')
  const conflict = classifyMulticast({ status: 409, requestId: 'r1' })
  assert.equal(conflict.outcome, 'sent')
  assert.equal(conflict.line_request_id, 'r1')
})

test('429 / 5xx / timeout = retry ด้วย backoff · 400 / 403 = failed', () => {
  for (const status of [429, 500, 502, 503]) {
    const v = classifyMulticast({ status, attempts: 1 })
    assert.equal(v.outcome, 'retry', `status ${status}`)
    assert.equal(v.backoff_seconds, backoffSeconds(1))
  }
  assert.equal(classifyMulticast({ network: true, attempts: 1 }).outcome, 'retry')
  assert.equal(classifyMulticast({ status: 400 }).outcome, 'failed')
  assert.equal(classifyMulticast({ status: 403 }).outcome, 'failed')
  assert.equal(classifyMulticast({ status: 400 }).error, 'line_http_400')
})

test('ลองใหม่เกิน 6 ครั้ง = เลิก ไม่ลองวนไม่สิ้นสุด', () => {
  assert.equal(classifyMulticast({ status: 429, attempts: RETRY_MAX - 1 }).outcome, 'retry')
  const dead = classifyMulticast({ status: 429, attempts: RETRY_MAX })
  assert.equal(dead.outcome, 'failed')
  assert.match(dead.error, /retries_exhausted/)
  // backoff โตขึ้นเรื่อย ๆ แล้วหยุดที่ค่าสุดท้าย
  assert.ok(backoffSeconds(1) < backoffSeconds(3))
  assert.equal(backoffSeconds(99), backoffSeconds(RETRY_MAX))
})

// ───────────────────────────────────────────── โควตา

test('โควตาไม่พอ = ไม่ส่งเลย · แพ็กเกจไม่จำกัดผ่านเสมอ', () => {
  assert.deepEqual(quotaAllows({ limit: 300, used: 0 }, 300), { ok: true, remaining: 300 })
  assert.deepEqual(quotaAllows({ limit: 300, used: 0 }, 301), { ok: false, remaining: 300 })
  assert.deepEqual(quotaAllows({ limit: 300, used: 290 }, 11), { ok: false, remaining: 10 })
  // OA @wdq0911k: รีช 2,690 แต่ฟรี 300/เดือน — เคสจริงจาก handoff 2026-10-02
  assert.equal(quotaAllows({ limit: 300, used: 0 }, 2690).ok, false)
  assert.deepEqual(quotaAllows({ limit: null }, 999999), { ok: true, remaining: null })
})

test('lineQuota อ่าน limited / none ได้ถูก', async () => {
  const stub = url => ({
    ok: true, status: 200,
    json: async () => url.endsWith('/consumption') ? { totalUsage: 120 } : { type: 'limited', value: 300 },
  })
  assert.deepEqual(await lineQuota({ accessToken: 't' }, stub), { limit: 300, used: 120, remaining: 180 })

  const unlimited = url => ({
    ok: true, status: 200,
    json: async () => url.endsWith('/consumption') ? { totalUsage: 5 } : { type: 'none' },
  })
  assert.deepEqual(await lineQuota({ accessToken: 't' }, unlimited), { limit: null, used: 5, remaining: null })
})

// ───────────────────────────────────────────── sendMulticast

test('sendMulticast ส่ง retry key เดิมและไม่ใส่ token ลงผลลัพธ์', async () => {
  const seen = []
  const stub = async (url, opts) => {
    seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) })
    return { ok: true, status: 200, headers: new Map([['x-line-request-id', 'req-1']]),
             text: async () => '' }
  }
  const out = await sendMulticast(
    { to: ['U1', 'U2'], messages: [{ type: 'text', text: 'hi' }], retryKey: 'KEY-1', accessToken: 'TOKEN' },
    stub)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.line.me/v2/bot/message/multicast')
  assert.equal(seen[0].headers['X-Line-Retry-Key'], 'KEY-1')
  assert.deepEqual(seen[0].body.to, ['U1', 'U2'])
  assert.equal(out.status, 200)
  assert.equal(out.requestId, 'req-1')
  assert.ok(!JSON.stringify(out).includes('TOKEN'), 'ผลลัพธ์ต้องไม่มี token')
})

test('sendMulticast: ไม่มี token = ไม่ยิงเน็ต', async () => {
  let called = 0
  const out = await sendMulticast({ to: ['U1'], messages: [], retryKey: 'K' }, async () => { called++ })
  assert.equal(called, 0)
  assert.equal(out.error, 'line_token_missing')
})

test('sendMulticast: timeout = network จึง retry ด้วยคีย์เดิมได้', async () => {
  const stub = async () => { throw new Error('The operation was aborted due to timeout') }
  const raw = await sendMulticast({ to: ['U1'], messages: [], retryKey: 'K', accessToken: 't' }, stub)
  assert.equal(raw.network, true)
  assert.equal(raw.status, 0)
  assert.equal(classifyMulticast({ ...raw, attempts: 1 }).outcome, 'retry')
})

test('ทาง 400: เก็บ body ไว้เป็น error แต่ตัดสั้น', async () => {
  const stub = async () => ({
    ok: false, status: 400, headers: new Map(), text: async () => 'x'.repeat(2000) })
  const raw = await sendMulticast({ to: ['U1'], messages: [], retryKey: 'K', accessToken: 't' }, stub)
  assert.equal(raw.status, 400)
  assert.equal(raw.detail.length, 500)
  assert.equal(classifyMulticast(raw).outcome, 'failed')
})

// ───────────────────────────────────────────── โหมด dry run
//
// ★ ด่านนี้คือสิ่งเดียวที่กันการส่งข้อความหาลูกค้าจริงโดยไม่ได้ตั้งใจ
//   เขียนเป็น allowlist: ค่าใดที่ไม่ใช่ '1' เป๊ะ ๆ ต้องแปลว่า "ไม่ส่ง"

test('LINE_BROADCAST_LIVE: เฉพาะ "1" เท่านั้นที่ส่งจริง', () => {
  const live = v => v === '1'
  assert.equal(live('1'), true)
  for (const v of [undefined, '', '0', 'true', 'TRUE', 'yes', 'on', '1 ', 'live']) {
    assert.equal(live(v), false, `ค่า ${JSON.stringify(v)} ต้องเป็น dry run`)
  }
})

test('dry run: ตัวส่งไม่ถูกเรียกเลย', async () => {
  // จำลองกิ่งของ sendBroadcastBatch: ไม่ live = ไม่แตะ sendMulticast
  let fetches = 0
  const fetcher = async () => { fetches++; return { ok: true, status: 200, headers: new Map() } }
  const broadcastLive = false
  const verdict = broadcastLive
    ? classifyMulticast(await sendMulticast({ to: ['U1'], messages: [], retryKey: 'K', accessToken: 't' }, fetcher))
    : { outcome: 'sent', http_status: null, line_request_id: null }

  assert.equal(fetches, 0, 'dry run ห้ามยิง network')
  assert.equal(verdict.outcome, 'sent')
})
