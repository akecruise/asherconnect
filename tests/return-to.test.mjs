import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentReturnTo, safeReturnTo } from '../lib/return-to.mjs'

test('return-to keeps a same-origin conversation path only', () => {
  assert.equal(safeReturnTo('/conversations/c-1?x=1'), '/conversations/c-1?x=1')
  assert.equal(safeReturnTo('https://evil.test'), null)
  assert.equal(safeReturnTo('//evil.test'), null)
  assert.equal(safeReturnTo('/\\evil'), null)
  assert.equal(currentReturnTo({ pathname: '/conversations/c-2', search: '' }), '/conversations/c-2')
})
