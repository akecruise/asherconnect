import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuotationUrl, verifyQuotationUrl } from '../lib/quotation-link.mjs'

const id = '67fabe8b-80a5-4c0d-b3b3-6841d1d68fdc'
const now = Date.parse('2026-09-28T12:00:00Z')

test('creates and verifies a signed quotation URL', () => {
  const value = new URL(createQuotationUrl('https://inbox.example.com', id, 'secret', now, 60))
  assert.equal(value.pathname, `/quotation-document/${id}`)
  assert.equal(verifyQuotationUrl(id, value.searchParams.get('expires'), value.searchParams.get('signature'), 'secret', now), true)
})

test('rejects tampered and expired quotation URLs', () => {
  const value = new URL(createQuotationUrl('https://inbox.example.com', id, 'secret', now, 60))
  assert.equal(verifyQuotationUrl(id, value.searchParams.get('expires'), value.searchParams.get('signature'), 'wrong', now), false)
  assert.equal(verifyQuotationUrl(id, value.searchParams.get('expires'), value.searchParams.get('signature'), 'secret', now + 61_000), false)
})
