import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWebhook } from '../providers.mjs'
import { extractCustomerContact } from '../lib/customer-contact-extraction.mjs'
import { fetchProfile, _resetProfileCache } from '../lib/profile.mjs'

const config = { channel: 'messenger', inbox_id: 'test-inbox', account_id: 'test-page', access_token: 'test-token' }
const response = (status, data) => ({ ok: status === 200, status, json: async () => data })
const log = { warn() {} }

test('first Messenger text reaches the worker contact extraction gate', () => {
  const body = { object: 'page', entry: [{ id: config.account_id, messaging: [{
    sender: { id: 'customer' }, recipient: { id: config.account_id }, timestamp: 1700000000000,
    message: { mid: 'message-1', text: 'ชื่อ: สมชาย เบอร์: +66 81-234-5678' },
  }] }] }
  const [event] = normalizeWebhook('messenger', body, config)
  assert.equal(event.event_type, 'message')
  assert.equal(event.source_type, 'user')
  assert.equal(event.page_id, config.account_id)
  assert.equal(event.customer_psid, 'customer')
  const contact = extractCustomerContact(event.text)
  assert.equal(contact.name, 'สมชาย')
  assert.equal(contact.phone, '0812345678')
  assert.equal(normalizeWebhook('messenger', body, config)[0].event_id, event.event_id)

  body.entry[0].messaging[0].message.is_echo = true
  body.entry[0].messaging[0].sender.id = config.account_id
  body.entry[0].messaging[0].recipient.id = 'customer'
  const [echo] = normalizeWebhook('messenger', body, config)
  assert.equal(echo.event_type, 'echo')
  assert.notEqual(echo.source_type, 'user')
})

test('profile fallback never substitutes the page or another customer', async () => {
  _resetProfileCache()
  const result = await fetchProfile({ channel: 'messenger', externalId: 'customer', config,
    deps: { log, fetch: async (url, options) => {
      assert.ok(!url.includes(config.access_token))
      assert.equal(options.headers.Authorization, `Bearer ${config.access_token}`)
      return url.includes('/conversations?')
        ? response(200, { data: [{ participants: { data: [
          { id: config.account_id, name: 'Page name' }, { id: 'someone-else', name: 'Another customer' },
        ] } }] })
        : response(400, { error: { code: 100, error_subcode: 33 } })
    } } })
  assert.equal(result.display_name, null)
  assert.equal(result.status, 'error')
})

test('a failed Conversations lookup can recover on the next worker attempt', async () => {
  _resetProfileCache()
  let attempts = 0
  const deps = { log, fetch: async (url) => {
    if (!url.includes('/conversations?')) return response(400, { error: { code: 100 } })
    if (++attempts === 1) return response(503, { error: { code: 2 } })
    return response(200, { data: [{ participants: [{ id: 'customer', name: 'Correct customer' }] }] })
  } }
  assert.equal((await fetchProfile({ channel: 'messenger', externalId: 'customer', config, deps })).status, 'error')
  assert.equal((await fetchProfile({ channel: 'messenger', externalId: 'customer', config, deps })).display_name, 'Correct customer')
  assert.equal(attempts, 2)
})

test('same PSID in different pages does not share a cached name', async () => {
  _resetProfileCache()
  let calls = 0
  const deps = { log, fetch: async () => response(200, { first_name: `Person ${++calls}` }) }
  const a = await fetchProfile({ channel: 'messenger', externalId: 'customer', config, deps })
  const b = await fetchProfile({ channel: 'messenger', externalId: 'customer', config: { ...config, account_id: 'other-page' }, deps })
  assert.notEqual(a.display_name, b.display_name)
})

test('long IDs, mixed alphanumeric IDs and separated numbers are not phones', () => {
  for (const text of ['10812345678', '081234567890', 'ABC0812345678', '0812345678XYZ', '08123\n45678', '08123abc45678']) {
    assert.equal(extractCustomerContact(text).phone, null, text)
  }
  assert.equal(extractCustomerContact('โทร 081-234-5678').phone, '0812345678')
})
