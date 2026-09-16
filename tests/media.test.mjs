import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWebhook } from '../providers.mjs'
import { enrichMessageMedia } from '../lib/media.mjs'
import { mediaTasks, storagePath, safeMediaPath, extFor, MEDIA_MAX_BYTES } from '../lib/media.mjs'

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'
const MSG = '33333333-3333-3333-3333-333333333333'

test('external LINE content survives normalization and uses its original URL', () => {
  for (const type of ['image', 'video', 'audio']) {
    const url = 'https://example.com/media'
    const [event] = normalizeWebhook('line', { destination: 'ours', events: [{
      type: 'message', webhookEventId: 'event', timestamp: 1000,
      source: { type: 'user', userId: 'user' },
      message: { id: 'provider-id', type, contentProvider: { type: 'external', originalContentUrl: url } },
    }] }, { account_id: 'ours', inbox_id: UUID_A })
    assert.deepEqual(mediaTasks(event, { message_id: MSG }), [{ message_id: MSG, source: 'url', url }])
    event.attribution.content_provider.originalContentUrl = 'http://example.com/media'
    assert.deepEqual(mediaTasks(event, { message_id: MSG }), [])
  }
})

test('initial detail and polling/pagination both include stored media', async () => {
  const files = [{ path: `${UUID_A}/${MSG}.jpg`, mime: 'image/jpeg' }]
  for (const action of ['detail', 'messages']) {
    const data = { messages: [{ id: MSG }] }
    await enrichMessageMedia(action, data, UUID_B, async id => {
      assert.equal(id, UUID_B)
      return { [MSG]: files }
    })
    assert.deepEqual(data.messages[0].media, files)
  }
  await enrichMessageMedia('bootstrap', {}, null, () => assert.fail('unexpected lookup'))
})

test('LINE image → งานเดียวแบบ line_content โดยใช้ provider_message_id', () => {
  const event = { content_type: 'image', attribution: { provider_message_id: '9876543210' } }
  assert.deepEqual(mediaTasks(event, { message_id: MSG }), [
    { message_id: MSG, source: 'line_content', line_message_id: '9876543210' },
  ])
})

test('LINE สติกเกอร์/ข้อความ = ไม่มีงาน (สติกเกอร์ตัดสินใจเก็บเป็นข้อความไปแล้ว)', () => {
  assert.deepEqual(mediaTasks({ content_type: 'sticker', attribution: { provider_message_id: 'x' } }, { message_id: MSG }), [])
  assert.deepEqual(mediaTasks({ content_type: 'text', attribution: { provider_message_id: 'x' } }, { message_id: MSG }), [])
})

test('Messenger รูปผ่าน attribution.attachments — ตัด location กับ URL ที่ไม่ใช่ https ทิ้ง', () => {
  const event = { content_type: 'attachment', attribution: { attachments: [
    { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/a.jpg' } },
    { type: 'location', payload: { coordinates: { lat: 1, long: 2 } } },
    { type: 'image', payload: { url: 'http://not-secure/a.jpg' } },
    { type: 'file', payload: { url: 'https://cdn.fbsbx.com/doc.pdf' } },
  ] } }
  assert.deepEqual(mediaTasks(event, { message_id: MSG }), [
    { message_id: MSG, source: 'url', url: 'https://lookaside.fbsbx.com/a.jpg' },
    { message_id: MSG, source: 'url', url: 'https://cdn.fbsbx.com/doc.pdf' },
  ])
})

test('echo ของทีม (Messenger) ผ่านทางเดียวกัน — ทีมส่งรูปก็ต้องเก็บด้วย', () => {
  const event = { content_type: 'attachment', attribution: { attachments: [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/b.png' } }] } }
  assert.equal(mediaTasks(event, { message_id: MSG }).length, 1)
})

test('ยังไม่รู้ message_id หรือ event ว่าง = ไม่มีงาน ไม่ throw', () => {
  assert.deepEqual(mediaTasks({ content_type: 'image', attribution: { provider_message_id: 'x' } }, null), [])
  assert.deepEqual(mediaTasks(null, { message_id: MSG }), [])
})

test('storagePath — ไฟล์แรกไม่มีเลข ไฟล์ถัดไปมี -2 -3', () => {
  assert.equal(storagePath(UUID_A, MSG, 1, 'image/jpeg'), `${UUID_A}/${MSG}.jpg`)
  assert.equal(storagePath(UUID_A, MSG, 2, 'video/mp4'), `${UUID_A}/${MSG}-2.mp4`)
  assert.equal(storagePath(UUID_A, MSG, 3, 'application/octet-stream'), `${UUID_A}/${MSG}-3.bin`)
})

test('extFor รู้จักชนิดหลัก ชนิดแปลกลง bin', () => {
  assert.equal(extFor('image/png'), 'png')
  assert.equal(extFor('IMAGE/JPEG'), 'jpg')   // ใจดีกับตัวพิมพ์ — เคยเจอ mime ตัวใหญ่จากผู้ให้บริการ
  assert.equal(extFor('image/jpeg; charset=binary'), 'jpg')  // แต่ถ้าใครลืมตัด param ก็ยังทำงาน
  assert.equal(extFor('weird/thing'), 'bin')
  assert.equal(extFor(undefined), 'bin')
})

test('safeMediaPath รับเฉพาะรูปร่าง <uuid>/<uuid>[-n].<สกุลที่รู้จัก>', () => {
  assert.equal(safeMediaPath(`${UUID_A}/${MSG}.jpg`), `${UUID_A}/${MSG}.jpg`)
  assert.equal(safeMediaPath(`${UUID_A}/${MSG}-2.png`), `${UUID_A}/${MSG}-2.png`)
  assert.equal(safeMediaPath(`${UUID_B}/${MSG}.PDF`), `${UUID_B}/${MSG}.PDF`)
  // ทางเดินขึ้นไปข้างบน / path เด็ดข้าม bucket / ตัวอักษรแปลก — คืน null หมด
  assert.equal(safeMediaPath(`../../etc/passwd`), null)
  assert.equal(safeMediaPath(`${UUID_A}/${MSG}.jpg/../../secret`), null)
  assert.equal(safeMediaPath(`not-a-uuid/${MSG}.jpg`), null)
  assert.equal(safeMediaPath(`${UUID_A}/${MSG}.html`), null)
  assert.equal(safeMediaPath(`${UUID_A}/${MSG}.svg`), null)
  assert.equal(safeMediaPath(`${UUID_A}/${MSG}.jpg%00.png`), null)
  assert.equal(safeMediaPath(null), null)
})

test('เพดานขนาดไฟล์เป็น 25 MB — ตัวเลขนี้ต้องตรงกับ bucket (scripts/ensure-media-bucket.mjs)', () => {
  assert.equal(MEDIA_MAX_BYTES, 25 * 1024 * 1024)
})
