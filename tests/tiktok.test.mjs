import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyTikTokSignature, matchesTikTokDestination, normalizeTikTokWebhook, sendTikTokText, refreshTikTokToken } from '../lib/tiktok.mjs'

const config = { app_id: 'app-1', account_id: 'business-open-id', inbox_id: 'inbox-1', access_token: 'test-token' }
const content = { unique_identifier: 'customer-1', from_user: { id: 'customer-1', role: 'personal_account' },
  to_user: { id: 'business-open-id', role: 'business_account' }, conversation_id: 'thread+1',
  message_id: 'mid-1', timestamp: 1701090879815, type: 'text', text: { body: 'ขอดูห้อง' },
  message_tag: { source: 'APP' } }
const inbound = { client_key: 'app-1', event: 'im_receive_msg', user_openid: 'business-open-id',
  create_time: 1701090882, content: JSON.stringify(content) }

test('TikTok signature binds timestamp and JSON body, rejects replay and Meta signature', () => {
  const secret = 'test-app-secret', raw = Buffer.from(JSON.stringify(inbound))
  const timestamp = '1701090882'
  const signature = createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(inbound)}`).digest('hex')
  assert.equal(verifyTikTokSignature(raw, `t=${timestamp},s=${signature}`, secret, 1701090882000), true)
  assert.equal(verifyTikTokSignature(raw, `t=${timestamp},s=${signature}`, secret, 1701091183000), false)
  assert.equal(verifyTikTokSignature(Buffer.from('{}'), `t=${timestamp},s=${signature}`, secret, 1701090882000), false)
  assert.equal(verifyTikTokSignature(raw, `sha256=${signature}`, secret, 1701090882000), false)
})

test('TikTok account and app must both match before receiving customer data', () => {
  assert.equal(matchesTikTokDestination(inbound, config), true)
  assert.equal(matchesTikTokDestination({ ...inbound, user_openid: 'other' }, config), false)
  assert.equal(matchesTikTokDestination({ ...inbound, client_key: 'other' }, config), false)
  const event = normalizeTikTokWebhook(inbound, config)[0]
  assert.equal(event.event_type, 'message')
  assert.equal(event.external_id, 'customer-1')
  assert.equal(event.tiktok_conversation_id, 'thread+1')
  assert.equal(event.event_id, 'mid-1')
  assert.equal(event.text, 'ขอดูห้อง')
  assert.throws(() => normalizeTikTokWebhook({ ...inbound, content: JSON.stringify({ ...content, to_user: { id: 'other', role: 'business_account' } }) }, config), /invalid_tiktok_message/)
})

test('native business echo has customer identity; EU notification cannot create a conversation', () => {
  const outbound = { ...inbound, event: 'im_send_msg', content: JSON.stringify({ ...content,
    from_user: content.to_user, to_user: content.from_user, message_tag: { source: 'APP' } }) }
  const event = normalizeTikTokWebhook(outbound, config)[0]
  assert.equal(event.event_type, 'echo')
  assert.equal(event.external_id, 'customer-1')
  assert.equal(event.attribution.source, 'APP')
  assert.deepEqual(normalizeTikTokWebhook({ ...inbound, event: 'im_receive_msg_eu', content: '{}' }, config), [])
})

test('TikTok sends one text to conversation ID only when provider confirms message ID', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  const job = { kind: 'send', id: 'job-1', tiktok_conversation_id: 'thread+1',
    last_inbound_at: new Date(now - 3600000).toISOString(), payload: { type: 'text', text: 'สวัสดี' } }
  let sent
  const success = await sendTikTokText(job, config, async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ code: 0, data: { message: { message_id: 'mid-out' } } }), { status: 200 })
  }, now)
  assert.equal(sent.url, 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/')
  assert.equal(sent.headers['Access-Token'], 'test-token')
  assert.deepEqual(sent.body, { business_id: 'business-open-id', recipient_type: 'CONVERSATION',
    recipient: 'thread+1', message_type: 'TEXT', text: { body: 'สวัสดี' } })
  assert.equal(success.status, 'sent')
  assert.equal(success.provider_id, 'mid-out')
  const unknown = await sendTikTokText(job, config, async () => new Response('{"code":0,"data":{"message":{}}}', { status: 200 }), now)
  assert.equal(unknown.status, 'uncertain')
  const malformed = await sendTikTokText(job, config, async () => new Response('not json', { status: 200 }), now)
  assert.equal(malformed.status, 'uncertain')
})

test('TikTok rejects unverified window and image; rate limit retries but timeout stays uncertain', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  const job = { tiktok_conversation_id: 'thread', last_inbound_at: new Date(now - 3600000).toISOString(),
    payload: { type: 'text', text: 'hello' } }
  const never = () => { throw Error('must not call provider') }
  assert.equal((await sendTikTokText({ ...job, last_inbound_at: '2020-01-01' }, config, never, now)).status, 'failed')
  assert.equal((await sendTikTokText({ ...job, payload: { type: 'image', media: [{ url: 'https://example.com/a.jpg' }] } }, config, never, now)).status, 'failed')
  assert.equal((await sendTikTokText(job, config, async () => new Response('{"code":40100}', { status: 200 }), now)).status, 'retry')
  assert.equal((await sendTikTokText(job, config, async () => { throw Error('timeout') }, now)).status, 'uncertain')
  assert.equal((await sendTikTokText(job, config, async () => new Response('{"code":40105}', { status: 200 }), now)).error, 'tiktok_token_invalid')
})

test('token refresh returns rotated pair only for the authorized business', async () => {
  const credential = { ...config, secret: 'app-secret', refresh_token: 'old-refresh' }
  const renewed = await refreshTikTokToken(credential, async (url, init) => {
    assert.equal(url, 'https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/')
    assert.deepEqual(JSON.parse(init.body), { client_id: 'app-1', client_secret: 'app-secret',
      grant_type: 'refresh_token', refresh_token: 'old-refresh' })
    return new Response(JSON.stringify({ code: 0, data: { open_id: 'business-open-id', access_token: 'new-access',
      refresh_token: 'new-refresh', expires_in: 86400, refresh_token_expires_in: 31536000 } }), { status: 200 })
  })
  assert.equal(renewed.access_token, 'new-access')
  assert.equal(renewed.refresh_token, 'new-refresh')
  await assert.rejects(refreshTikTokToken(credential, async () => new Response(JSON.stringify({ code: 0,
    data: { open_id: 'other', access_token: 'bad', refresh_token: 'bad', expires_in: 86400,
      refresh_token_expires_in: 31536000 } }), { status: 200 })), /tiktok_refresh_failed/)
})
