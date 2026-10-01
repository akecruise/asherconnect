import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCustomerContact, normalizeThaiPhone } from '../lib/customer-contact-extraction.mjs'

test('unlabelled text supplies a phone but never an inferred name', () => {
  assert.deepEqual(extractCustomerContact('ศิริพร 0892366169'), { name: null, phone: '0892366169', sourceText: 'ศิริพร 0892366169' })
})

test('requests and refusals alongside a phone never become a customer name', () => {
  for (const text of ['โทรกลับด้วย 0812345678', 'ไม่ต้องโทร 0812345678', 'ขอรายละเอียด 0812345678', 'เปลี่ยนชื่อ: สมชาย 0812345678']) {
    assert.equal(extractCustomerContact(text).name, null, text)
    assert.equal(extractCustomerContact(text).phone, '0812345678', text)
  }
})

test('explicit Thai name retains combining marks and requires a label boundary', () => {
  assert.equal(extractCustomerContact('ชื่อ: ศิริพร').name, 'ศิริพร')
  assert.equal(extractCustomerContact('ชื่อ: น้ำฝน\nเบอร์: 0812345678').name, 'น้ำฝน')
  assert.equal(extractCustomerContact('username: Alice').name, null)
})
test('normalizes dashed and international Thai phones to one key', () => {
  assert.equal(normalizeThaiPhone('089-236-6169'), '0892366169')
  assert.equal(normalizeThaiPhone('+66892366169'), '0892366169')
})
test('supports labels and does not invent a name', () => {
  assert.deepEqual(extractCustomerContact('ชื่อ: ศิริพร\nเบอร์โทร: 089-236-6169'), { name: 'ศิริพร', phone: '0892366169', sourceText: 'ชื่อ: ศิริพร\nเบอร์โทร: 089-236-6169' })
  assert.equal(extractCustomerContact('ขอรายละเอียดโครงการ').phone, null)
})
