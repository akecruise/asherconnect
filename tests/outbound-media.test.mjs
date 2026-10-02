// ลิงก์สื่อขาออกที่เซ็นชื่อ (lib/outbound-media.mjs)
//
// ★ ไฟล์นี้เคยเทสต์ validateOutboundImages / renderPayloads ซึ่งถูกแทนที่ไปแล้ว:
//   - การอัปโหลดหลายรูปย้ายไปเป็นคลังรูป (lib/media-library.mjs · tests/media-library.test.mjs)
//   - lib/outbound-media.mjs ถูกเขียนใหม่ทั้งไฟล์ตอน 20a7799 เป็นตัวสร้าง/ตรวจลิงก์เซ็นชื่อ
//   เทสต์เก่าจึง import ของที่ไม่มีแล้วและพังมาตั้งแต่ commit นั้น (ไม่เคยอยู่ใน npm test จึงไม่มีใครเห็น)
//
// ★★ ท่อนี้ใช้งานจริงบนโปรดักชัน: LINE/Messenger ต้องโหลดรูปโดยไม่มี session ของเรา
//    ลายเซ็นคือสิ่งเดียวที่กันคนนอกเดา path แล้วดูดรูปของลูกค้าออกจาก bucket ส่วนตัว
//    ก่อนหน้านี้ไม่มีเทสต์คลุมเลย — ไฟล์นี้จึงเขียนใหม่ให้ตรงกับ API ปัจจุบัน

import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutboundMediaUrl, safeOutboundPath, verifyOutboundMedia } from '../lib/outbound-media.mjs'

const KEY = 'test-only-signing-key'
const ORIGIN = 'https://connect.test'
const MEDIA = '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg'
const NOW = 1_800_000_000_000

test('safeOutboundPath รับเฉพาะรูปร่างที่รู้จัก', () => {
  assert.equal(safeOutboundPath(MEDIA), MEDIA)
  assert.equal(safeOutboundPath('11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222-2.png'),
               '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222-2.png')
  assert.equal(safeOutboundPath('qr/promo-a.jpg'), 'qr/promo-a.jpg')
  assert.equal(safeOutboundPath('outbound/unit-01.webp'), 'outbound/unit-01.webp')

  // ★ ด่านนี้คือตัวกัน path traversal และการหยิบไฟล์นอกคลัง
  for (const bad of ['../secrets.jpg', 'qr/../../etc/passwd', 'qr/promo.svg', 'qr/promo.pdf',
                     'random/file.jpg', MEDIA.replace('.jpg', '.exe'), '', null, undefined]) {
    assert.equal(safeOutboundPath(bad), null, `ต้องปฏิเสธ ${JSON.stringify(bad)}`)
  }
})

test('ลิงก์ที่เพิ่งสร้าง ตรวจผ่าน', () => {
  const url = new URL(createOutboundMediaUrl(ORIGIN, MEDIA, KEY, NOW))
  assert.equal(url.pathname, `/outbound-media/${MEDIA}`)
  assert.equal(verifyOutboundMedia(MEDIA, url.searchParams.get('expires'),
                                   url.searchParams.get('signature'), KEY, NOW), true)
})

test('ลิงก์หมดอายุแล้วใช้ไม่ได้', () => {
  const ttl = 60
  const url = new URL(createOutboundMediaUrl(ORIGIN, MEDIA, KEY, NOW, ttl))
  const expires = url.searchParams.get('expires')
  const signature = url.searchParams.get('signature')
  assert.equal(verifyOutboundMedia(MEDIA, expires, signature, KEY, NOW + (ttl - 1) * 1000), true)
  assert.equal(verifyOutboundMedia(MEDIA, expires, signature, KEY, NOW + (ttl + 2) * 1000), false)
})

test('แก้ path / แก้เวลา / แก้ลายเซ็น / คนละกุญแจ = ไม่ผ่าน', () => {
  const url = new URL(createOutboundMediaUrl(ORIGIN, MEDIA, KEY, NOW))
  const expires = url.searchParams.get('expires')
  const signature = url.searchParams.get('signature')

  // ลายเซ็นผูกกับ path — เอาลายเซ็นของรูปหนึ่งไปใช้กับอีกรูปไม่ได้
  const other = MEDIA.replace('2222.jpg', '2223.jpg')
  assert.equal(verifyOutboundMedia(other, expires, signature, KEY, NOW), false)
  // ...และผูกกับเวลา — ยืดอายุเองไม่ได้
  assert.equal(verifyOutboundMedia(MEDIA, String(Number(expires) + 86400), signature, KEY, NOW), false)
  // ...และกุญแจต้องตรง
  assert.equal(verifyOutboundMedia(MEDIA, expires, signature, 'another-key', NOW), false)

  // ลายเซ็นรูปแบบผิดต้องตกตั้งแต่ด่านแรก ไม่ใช่ไปตกตอนเทียบ
  for (const bad of ['', 'deadbeef', signature.toUpperCase(), signature.slice(0, 63), signature + 'a',
                     signature.replace(/^./, 'z'), null, undefined, 12345]) {
    assert.equal(verifyOutboundMedia(MEDIA, expires, bad, KEY, NOW), false, `ต้องปฏิเสธลายเซ็น ${bad}`)
  }
  // expires ที่ไม่ใช่จำนวนเต็ม
  for (const bad of ['', 'abc', '1.5', null, undefined]) {
    assert.equal(verifyOutboundMedia(MEDIA, bad, signature, KEY, NOW), false, `ต้องปฏิเสธ expires ${bad}`)
  }
})

test('path ที่ไม่ผ่าน safeOutboundPath สร้างลิงก์ไม่ได้เลย', () => {
  assert.equal(createOutboundMediaUrl(ORIGIN, '../secrets.jpg', KEY, NOW), null)
  assert.equal(createOutboundMediaUrl(ORIGIN, 'qr/promo.svg', KEY, NOW), null)
})

test('ลิงก์ของสองรูปในกุญแจเดียวกันต้องไม่ซ้ำกัน', () => {
  const a = new URL(createOutboundMediaUrl(ORIGIN, 'qr/a.jpg', KEY, NOW)).searchParams.get('signature')
  const b = new URL(createOutboundMediaUrl(ORIGIN, 'qr/b.jpg', KEY, NOW)).searchParams.get('signature')
  assert.notEqual(a, b)
})
