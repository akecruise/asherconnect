import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { matchesDestination, normalizeWebhook, verifySignature, deliver } from '../providers.mjs'
import { instagramMedia } from '../lib/instagram.mjs'
import { mediaTasks } from '../lib/media.mjs'
import { fetchProfile, _resetProfileCache } from '../lib/profile.mjs'
import { messageSenderLabel } from '../public/conversation-presentation.mjs'

const config = { inbox_id: 'ig-inbox', account_id: '17890000001', login_type: 'instagram', access_token: 'test-token', api_version: 'v23.0' }
const incoming = (message = { mid: 'mid1', text: 'สนใจห้องค่ะ' }) => ({ sender: { id: 'customer1' }, recipient: { id: config.account_id }, timestamp: 1790150000000, message })
const body = (...events) => ({ object: 'instagram', entry: [{ id: config.account_id, messaging: events }] })
const job = (extra = {}) => ({ id: 'job1', message_id: 'message1', channel: 'instagram', target: 'customer1', text: 'สวัสดีค่ะ', last_inbound_at: new Date(Date.now() - 1000).toISOString(), ...extra })
const response = (status = 200, data = { message_id: 'ig-mid' }) => new Response(JSON.stringify(data), { status })

test('IG validates its own webhook object, account, and HMAC', () => {
  assert.equal(matchesDestination('instagram', body(incoming()), config), true)
  assert.equal(matchesDestination('messenger', body(incoming()), config), false)
  assert.equal(matchesDestination('instagram', { ...body(), object: 'page' }, config), false)
  assert.equal(matchesDestination('instagram', body(), { ...config, account_id: 'other' }), false)
  const raw = Buffer.from(JSON.stringify(body(incoming())))
  const signature = 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex')
  assert.equal(verifySignature(raw, signature, 'secret', 'instagram'), true)
  assert.equal(verifySignature(Buffer.from('changed'), signature, 'secret', 'instagram'), false)
})
test('incoming IG uses the customer identity, keeps MID and user-source extraction', () => {
  const [e] = normalizeWebhook('instagram', body(incoming()), config)
  assert.equal(e.event_type, 'message'); assert.equal(e.external_id, 'customer1')
  assert.equal(e.customer_psid, 'customer1'); assert.equal(e.page_id, config.account_id)
  assert.equal(e.event_id, 'mid1'); assert.equal(e.platform, 'instagram'); assert.equal(e.source_type, 'user')
})
test('IG echo uses recipient; it never presents an outbound as inbound', () => {
  const e = incoming({ mid: 'echo1', text: 'ตอบจาก IG', is_echo: true })
  ;[e.sender, e.recipient] = [e.recipient, e.sender]
  const [normalized] = normalizeWebhook('instagram', body(e), config)
  assert.equal(normalized.event_type, 'echo'); assert.equal(normalized.external_id, 'customer1')
  assert.equal(normalizeWebhook('instagram', body(incoming({ mid: 'bad', is_echo: true })), config).length, 0)
})
test('IG rejects wrong recipient, own-account identities, malformed timestamps, and self tests', () => {
  for (const e of [ { ...incoming(), recipient: { id: 'other' } }, { ...incoming(), sender: { id: config.account_id } },
    { ...incoming(), timestamp: 'invalid' }, incoming({ mid: 'self', is_self: true }) ]) {
    assert.deepEqual(normalizeWebhook('instagram', body(e), config), [])
  }
})
test('read, delivery and reaction events do not create customer messages or restart SLA', () => {
  for (const prop of ['read', 'delivery', 'reaction']) {
    assert.deepEqual(normalizeWebhook('instagram', body({ ...incoming(), message: undefined, [prop]: {} }), config), [])
  }
})
test('IG unsend is routed separately from the normal receive deduplication key', () => {
  const [e] = normalizeWebhook('instagram', body(incoming({ mid: 'mid1', is_deleted: true })), config)
  assert.equal(e.event_type, 'message_deleted'); assert.equal(e.provider_message_id, 'mid1')
  assert.equal(e.event_id, 'deleted:mid1')
})
test('IG postback identity is stable across webhook redelivery', () => {
  const e = { ...incoming(), message: undefined, postback: { payload: 'view-room', title: 'ดูห้อง' } }
  const first = normalizeWebhook('instagram', body(e), config)
  assert.deepEqual(first, normalizeWebhook('instagram', body(e), config))
  assert.equal(first[0].event_type, 'postback')
})
test('IG stores attachment references only and rejects unsafe URL protocols', () => {
  const [e] = normalizeWebhook('instagram', body(incoming({ mid: 'media1', attachments: [
    { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/image.jpg' } },
    { type: 'image', payload: { url: 'javascript:alert(1)' } },
  ] })), config)
  assert.equal(instagramMedia(e).length, 1)
  assert.deepEqual(mediaTasks(e, { message_id: 'm' }), [])
})
test('IG send uses Instagram Login endpoint and no Messenger-only fields', async () => {
  const calls = []
  const r = await deliver(job(), config, async (url, init) => { calls.push({ url, init }); return response() })
  assert.equal(r.status, 'sent'); assert.equal(r.provider_id, 'ig-mid')
  assert.equal(calls[0].url, 'https://graph.instagram.com/v23.0/17890000001/messages')
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient: { id: 'customer1' }, message: { text: 'สวัสดีค่ะ' } })
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token')
})
test('IG image send omits Messenger reusable-attachment flag', async () => {
  const r = await deliver(job({ text: '', payload: { type: 'media', media: [{ url: 'https://media.example/image.jpg' }] } }), config,
    async (_, init) => { assert.deepEqual(JSON.parse(init.body).message, { attachment: { type: 'image', payload: { url: 'https://media.example/image.jpg' } } }); return response() })
  assert.equal(r.status, 'sent')
})
test('IG blocks missing, stale, invalid and future messaging windows before network I/O', async () => {
  for (const date of [undefined, 'bad', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 60000).toISOString()]) {
    const r = await deliver(job({ last_inbound_at: date }), config, () => { throw new Error('must not call') })
    assert.equal(r.error, 'instagram_24h_window_closed')
  }
})
test('IG rejects Facebook tokens setup and oversized/multipart jobs before sending', async () => {
  assert.equal((await deliver(job(), { ...config, login_type: 'facebook' })).error, 'instagram_login_configuration_required')
  assert.equal((await deliver(job({ text: 'x'.repeat(1001) }), config)).error, 'instagram_text_too_long')
  assert.equal((await deliver(job({ payload: { text: 'caption', media: [{ url: 'https://media.example/a.jpg' }] } }), config)).error, 'instagram_one_message_at_a_time')
})
test('IG transport ambiguity does not retry and does not log access tokens', async () => {
  const r = await deliver(job(), config, async () => { throw new Error('test-token') })
  assert.equal(r.status, 'uncertain'); assert.equal(JSON.stringify(r).includes('test-token'), false)
})
test('IG 429 retries, 5xx is uncertain, permission failure is terminal', async () => {
  for (const [code, expected] of [[429, 'retry'], [503, 'uncertain'], [403, 'failed']]) {
    assert.equal((await deliver(job(), config, async () => response(code, { error: { code: 10 } }))).status, expected)
  }
  assert.equal((await deliver(job(), config, async () => response(200, {}))).status, 'uncertain')
})
test('IG typing never accidentally calls the Facebook endpoint', async () => {
  assert.equal((await deliver(job({ kind: 'typing' }), config, () => { throw new Error('unexpected') })).status, 'skipped')
})
test('IG profile uses scoped ID and falls back to username', async () => {
  _resetProfileCache()
  const r = await fetchProfile({ channel: 'instagram', externalId: 'customer1', config,
    deps: { fetch: async (url, opts) => { assert.match(url, /graph.instagram.com\/v23.0\/customer1\?fields=name,username,profile_pic/); assert.ok(opts.headers.Authorization); return response(200, { username: 'customer.ig', profile_pic: 'https://cdn.example/p.jpg' }) } } })
  assert.equal(r.display_name, 'customer.ig')
  assert.equal(messageSenderLabel({ sender_type: 'contact' }, {}, 'instagram'), 'ลูกค้า Instagram')
  assert.equal(messageSenderLabel({ sender_type: 'agent', responder_display_name: 'Nan' }, {}, 'instagram'), 'Nan')
  assert.equal(messageSenderLabel({ sender_type: 'agent' }, {}, 'instagram'), 'ไม่ระบุผู้ตอบ')
})
