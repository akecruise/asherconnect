import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCustomerContact, normalizeThaiPhone } from '../lib/customer-contact-extraction.mjs'

test('extracts Thai name and local phone', () => {
  assert.deepEqual(extractCustomerContact('ศิริพร 0892366169'), { name: 'ศิริพร', phone: '0892366169', sourceText: 'ศิริพร 0892366169' })
})
test('normalizes dashed and international Thai phones to one key', () => {
  assert.equal(normalizeThaiPhone('089-236-6169'), '0892366169')
  assert.equal(normalizeThaiPhone('+66892366169'), '0892366169')
})
test('supports labels and does not invent a name', () => {
  assert.deepEqual(extractCustomerContact('ชื่อ: ศิริพร\nเบอร์โทร: 089-236-6169'), { name: 'ศิริพร', phone: '0892366169', sourceText: 'ชื่อ: ศิริพร\nเบอร์โทร: 089-236-6169' })
  assert.equal(extractCustomerContact('ขอรายละเอียดโครงการ').phone, null)
})
