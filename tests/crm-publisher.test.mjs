import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCrmFailure, crmBackoffMs } from '../lib/crm-publisher.mjs'

test('CRM publisher retries network and transient HTTP failures', () => {
  assert.equal(classifyCrmFailure({ network: true }), 'retry')
  for (const status of [408, 425, 429, 500, 503]) assert.equal(classifyCrmFailure({ status }), 'retry')
})

test('CRM publisher dead-letters permanent contract/auth failures', () => {
  for (const status of [400, 401, 403, 409, 422]) assert.equal(classifyCrmFailure({ status }), 'dead_letter')
})

test('CRM publisher backoff is bounded and restart-safe by attempt number', () => {
  assert.equal(crmBackoffMs(1), 5000)
  assert.equal(crmBackoffMs(6), 7200000)
  assert.equal(crmBackoffMs(99), 7200000)
})
