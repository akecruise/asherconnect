// รูปขาออก (รูปแนบ, คลังรูป, ใบเสนอราคา) ส่งให้ LINE/Messenger เป็นลิงก์ /outbound-media/ ที่เซ็นไว้
// ไฟล์จริงอยู่ใน bucket private — ลิงก์ต้องเปิดได้เฉพาะ path ที่อนุญาต และหมดอายุตามเวลา
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutboundMediaUrl, safeOutboundPath, verifyOutboundMedia } from '../lib/outbound-media.mjs'
import { renderPayload } from '../providers.mjs'

const now = Date.parse('2026-09-29T03:00:00Z')
const key = 'secret'

test('only known outbound media paths are allowed', () => {
  assert.equal(safeOutboundPath('outbound/unit-quote-abc-123.png'), 'outbound/unit-quote-abc-123.png')
  assert.equal(safeOutboundPath('qr/a1b2.jpg'), 'qr/a1b2.jpg')
  assert.equal(safeOutboundPath('67fabe8b-80a5-4c0d-b3b3-6841d1d68fdc/67fabe8b-80a5-4c0d-b3b3-6841d1d68fdc-2.webp'), '67fabe8b-80a5-4c0d-b3b3-6841d1d68fdc/67fabe8b-80a5-4c0d-b3b3-6841d1d68fdc-2.webp')
  for (const bad of ['../secrets.png', 'outbound/../x.png', 'quotation/a.png', 'outbound/a.svg', 'outbound/A B.png', '']) assert.equal(safeOutboundPath(bad), null, bad)
})

test('signed URL verifies, and rejects tampering, other paths, wrong key and expiry', () => {
  const url = new URL(createOutboundMediaUrl('https://inbox.example.com', 'outbound/a.png', key, now, 60))
  const path = url.pathname.slice('/outbound-media/'.length)
  const expires = url.searchParams.get('expires'), signature = url.searchParams.get('signature')
  assert.equal(path, 'outbound/a.png')
  assert.equal(verifyOutboundMedia(path, expires, signature, key, now), true)
  assert.equal(verifyOutboundMedia('outbound/b.png', expires, signature, key, now), false)
  assert.equal(verifyOutboundMedia(path, String(Number(expires) + 1), signature, key, now), false)
  assert.equal(verifyOutboundMedia(path, expires, signature.replace(/.$/, c => c === '0' ? '1' : '0'), key, now), false)
  assert.equal(verifyOutboundMedia(path, expires, signature, 'other', now), false)
  assert.equal(verifyOutboundMedia(path, expires, signature, key, now + 61_000), false)
})

test('no URL is created for a path that is not allowed', () => {
  assert.equal(createOutboundMediaUrl('https://inbox.example.com', '../x.png', key, now), null)
})

test('a signed quotation image link is delivered as an image, not as text', () => {
  const link = 'https://inbox.example.com/quotation-image/67fabe8b-80a5-4c0d-b3b3-6841d1d68fdc?expires=1&signature=a'
  assert.deepEqual(renderPayload('line', null, link), { type: 'image', originalContentUrl: link, previewImageUrl: link })
})
