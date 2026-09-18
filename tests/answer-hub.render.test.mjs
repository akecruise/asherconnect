// unit test ของ services/answer-hub/render.mjs (Phase 5 — T09/T10 ฝั่ง render)
// รัน: node --test tests/answer-hub.render.test.mjs (อยู่ใน chain ของ npm test ด้วย)
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate, renderFromResolve } from '../services/answer-hub/render.mjs'

test('render: แทนค่าหลายตัวแปรพร้อมข้อความไทยครบ', () => {
  const r = renderTemplate('โครงการ {{name}} เริ่ม {{price}} บาท', { name: 'A คอนโด', price: '2.9 ล้าน' })
  assert.equal(r.text, 'โครงการ A คอนโด เริ่ม 2.9 ล้าน บาท')
  assert.deepEqual(r.missing, [])
  assert.equal(r.ok, true)
})

test('render: required ขาด → missing list + คง {{}} เดิมไว้ (ห้ามส่งออก)', () => {
  const r = renderTemplate('ราคา {{price}} ว่าง {{units}}', { units: '12' }, { required: ['price'] })
  assert.equal(r.text, 'ราคา {{price}} ว่าง 12')
  assert.deepEqual(r.missing, ['price'])
  assert.equal(r.ok, false)
})

test('render: ตัวแปรที่ไม่ได้ประกาศ required ขาด → แทนค่าว่าง', () => {
  const r = renderTemplate('โปร {{promo}} จบ', {})
  assert.equal(r.text, 'โปร  จบ')
  assert.deepEqual(r.missing, [])
})

test('render: ค่าที่มี {{ตัวแปร}} ข้างใน ไม่เกิด recursion', () => {
  const r = renderTemplate('ค่าคือ {{a}} จบ', { a: 'ดู {{b}} ต่อ' })
  assert.equal(r.text, 'ค่าคือ ดู {{b}} ต่อ จบ')
})

test('render: รองรับช่องว่างในปีกกา {{ name }}', () => {
  const r = renderTemplate('สวัสดี {{ name }}', { name: 'คุณลูกค้า' })
  assert.equal(r.text, 'สวัสดี คุณลูกค้า')
})

test('render: ตัวอักษรพิเศษ regex ($&) ใส่ตรงตามค่า', () => {
  const r = renderTemplate('ราคา {{price}}', { price: '1,000$ & เซ็นเซอร์' })
  assert.equal(r.text, 'ราคา 1,000$ & เซ็นเซอร์')
})

test('render: ค่าว่าง/ค่าว่างเปล่า นับเป็นขาด', () => {
  const r = renderTemplate('{{a}}{{b}}{{c}}', { a: '', b: '   ' }, { required: ['a', 'b'] })
  assert.deepEqual(r.missing.sort(), ['a', 'b'])
})

test('render: body null/undefined ไม่พัง', () => {
  assert.deepEqual(renderTemplate(null, {}), { text: '', missing: [], ok: true })
})

test('renderFromResolve: ประกอบร่างจากรูปทรง ah_resolve ตรง ๆ', () => {
  const resolve = {
    values: { name: 'A คอนโด' },
    missing: ['price'],
  }
  const r = renderFromResolve('โครงการ {{name}} ราคา {{price}}', resolve)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['price'])
  assert.equal(r.text, 'โครงการ A คอนโด ราคา {{price}}')
})

test('renderFromResolve: ผล resolve แปลก ๆ (null / ไม่มี keys) ไม่พัง', () => {
  assert.deepEqual(renderFromResolve('ล้วน ๆ', null), { text: 'ล้วน ๆ', missing: [], ok: true })
  const r = renderFromResolve('{{x}}', {})
  assert.equal(r.text, '')
})
