import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCrmFailure, crmBackoffMs, parseProjectMap, projectRefFor } from '../lib/crm-publisher.mjs'

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

test('project map reads channel -> project pairs from configuration', () => {
  const { map, invalid } = parseProjectMap('inbox-a=asher-naii;inbox-b=asher-vibe')
  assert.equal(map.size, 2)
  assert.equal(map.get('inbox-a'), 'asher-naii')
  assert.equal(map.get('inbox-b'), 'asher-vibe')
  assert.deepEqual(invalid, [])
})

test('project map tolerates spacing and empty entries', () => {
  const { map, invalid } = parseProjectMap(' inbox-a = asher-naii ; ; inbox-b=asher-vibe ')
  assert.equal(map.get('inbox-a'), 'asher-naii')
  assert.equal(map.get('inbox-b'), 'asher-vibe')
  assert.deepEqual(invalid, [])
})

test('project map reports malformed entries instead of silently dropping them', () => {
  const { map, invalid } = parseProjectMap('good=asher-naii;broken;=novalue;nokey=')
  assert.equal(map.size, 1)
  assert.equal(map.get('good'), 'asher-naii')
  assert.deepEqual(invalid, ['broken', '=novalue', 'nokey='])
})

test('empty or absent project map yields no bindings', () => {
  for (const raw of ['', undefined, null, '   ']) {
    assert.equal(parseProjectMap(raw).map.size, 0)
  }
})

test('unmapped channel resolves to null so CRM records project_ref_missing', () => {
  const { map } = parseProjectMap('inbox-a=asher-naii')
  assert.equal(projectRefFor(map, 'inbox-a'), 'asher-naii')
  assert.equal(projectRefFor(map, 'inbox-unknown'), null)
  assert.equal(projectRefFor(map, undefined), null)
  assert.equal(projectRefFor(null, 'inbox-a'), null)
})
