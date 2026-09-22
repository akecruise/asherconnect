import test from 'node:test'
import assert from 'node:assert/strict'
import { validateOutboundImages, OUTBOUND_IMAGE_MAX_BYTES } from '../lib/outbound-media.mjs'
import { renderPayloads } from '../providers.mjs'

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64')
const file = (name = 'x.png', data = png) => ({ name, type: 'image/png', data })

test('server validates image bytes, rejects non-images and enforces max five', () => {
  assert.equal(validateOutboundImages([file()]).length, 1)
  assert.throws(() => validateOutboundImages([file('x.txt')]), /JPG/)
  assert.throws(() => validateOutboundImages(Array.from({ length: 6 }, (_, i) => file(`${i}.png`))), /สูงสุด 5/)
  assert.throws(() => validateOutboundImages([file('x.png', Buffer.alloc(OUTBOUND_IMAGE_MAX_BYTES + 1).toString('base64'))]), /10 MB/)
  assert.throws(() => validateOutboundImages([file('x.png', Buffer.from('not an image').toString('base64'))]), /ไม่ใช่รูป/)
})

test('image-only and mixed text+image produce provider messages without auto-send semantics', () => {
  assert.deepEqual(renderPayloads('messenger', { type: 'media', text: '', media: [{ url: 'https://cdn/a.png' }] }, ''), [
    { attachment: { type: 'image', payload: { url: 'https://cdn/a.png', is_reusable: true } } },
  ])
  assert.deepEqual(renderPayloads('line', { type: 'media', text: 'ดูรูปนี้', media: [{ url: 'https://cdn/a.png' }, { url: 'https://cdn/b.webp' }] }, ''), [
    { type: 'text', text: 'ดูรูปนี้' },
    { type: 'image', originalContentUrl: 'https://cdn/a.png', previewImageUrl: 'https://cdn/a.png' },
    { type: 'image', originalContentUrl: 'https://cdn/b.webp', previewImageUrl: 'https://cdn/b.webp' },
  ])
})
