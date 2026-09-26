import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createMediaLibrary, planSendItems, decodeLibraryImage, libraryMeta, LIBRARY_FOLDER,
} from '../lib/media-library.mjs'
import { safeMediaPath, storagePath } from '../lib/media.mjs'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const b64 = buf => buf.toString('base64')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const INBOX = '33333333-3333-4333-8333-333333333333'
const MSG = '44444444-4444-4444-8444-444444444444'
const fail = (status, code) => Object.assign(new Error(code), { status })

function harness(rows = {}) {
  const calls = { rpc: [], upload: [], copy: [] }
  const lib = createMediaLibrary({
    fail, origin: 'https://inbox.apluscondo.com',
    newId: () => A,
    rpcDirect: async (token, fn, body) => { calls.rpc.push({ token, fn, body }); return rows[fn] ?? { ok: true } },
    uploadObject: async (path, obj) => { calls.upload.push({ path, type: obj.type, size: obj.bytes.length }) },
    copyObject: async (from, to) => { calls.copy.push({ from, to }) },
    fetchObject: async () => ({ ok: false }),
  })
  return { lib, calls }
}

test('decode: รับ JPEG/PNG จาก magic bytes ไม่เชื่อ type ของเบราว์เซอร์', () => {
  assert.equal(decodeLibraryImage({ data: b64(JPEG), type: 'image/png' }, 1e6).mime, 'image/jpeg')
  assert.equal(decodeLibraryImage({ data: b64(PNG) }, 1e6).ext, 'png')
})

test('decode: WEBP ต้องถูกแปลงที่เบราว์เซอร์ก่อน — server ปฏิเสธ', () => {
  assert.throws(() => decodeLibraryImage({ data: b64(WEBP) }, 1e6), /JPG หรือ PNG/)
})

test('decode: เกินขนาด → error 400 ภาษาไทย', () => {
  const e = assert.throws(() => decodeLibraryImage({ data: b64(JPEG) }, 4, 'รูป'), err => err.status === 400 && /ใหญ่เกิน/.test(err.message))
})

test('meta: ชื่อบังคับ, โครงการ/หมวดเป็นชุดปิด, วันหมดอายุเป็น ISO', () => {
  assert.throws(() => libraryMeta({ title: ' ' }), /ตั้งชื่อ/)
  assert.throws(() => libraryMeta({ title: 'x', project: 'other' }), /โครงการ/)
  assert.throws(() => libraryMeta({ title: 'x', category: 'floorplan' }), /หมวด/)
  assert.equal(libraryMeta({ title: 'x', category: 'exterior' }).category, 'exterior')
  const m = libraryMeta({ title: ' แปลน ', project: 'Naii', category: 'plan', expires_at: '2026-12-31', bot_enabled: 'yes' })
  assert.deepEqual(m, { title: 'แปลน', project: 'naii', category: 'plan', expires_at: '2026-12-31T00:00:00.000Z', bot_enabled: false })
})

test('plan: ค่าเริ่มต้น = รูปคลังก่อน แล้วไฟล์แนบ', () => {
  assert.deepEqual(planSendItems({ mediaIds: [A], fileCount: 1 }),
    [{ kind: 'media', id: A }, { kind: 'file', index: 0 }])
})

test('plan: เคารพลำดับที่เซลส์เลือก และตัดรูปคลังซ้ำ', () => {
  assert.deepEqual(planSendItems({ mediaIds: [A, B, A], fileCount: 1, order: ['f:0', `m:${B}`, `m:${A}`] }),
    [{ kind: 'file', index: 0 }, { kind: 'media', id: B }, { kind: 'media', id: A }])
})

test('plan: order ไม่ตรงกับของที่แนบ / เกิน 5 รูป / id ปลอม → ปฏิเสธ', () => {
  assert.throws(() => planSendItems({ mediaIds: [A], fileCount: 0, order: [`m:${B}`] }), /ลำดับ/)
  assert.throws(() => planSendItems({ mediaIds: [A, B], fileCount: 4 }), /สูงสุด 5/)
  assert.throws(() => planSendItems({ mediaIds: ['../../etc'] }), /ไม่ถูกต้อง/)
})

test('plan: ไม่มีรูปเลย = []', () => {
  assert.deepEqual(planSendItems({}), [])
})

test('upload: เก็บตัวจริง + preview ใต้โฟลเดอร์คลัง แล้วเรียก media_create ด้วย token ผู้ใช้', async () => {
  const { lib, calls } = harness()
  await lib.command('user-token', 'media_library_upload', {
    title: 'ห้อง 1 นอน', project: 'naii', category: 'room',
    file: { data: b64(JPEG), width: 1200, height: 800 }, preview: { data: b64(JPEG) },
  })
  assert.deepEqual(calls.upload.map(u => u.path), [`${LIBRARY_FOLDER}/${A}.jpg`, `${LIBRARY_FOLDER}/${A}-2.jpg`])
  assert.ok(calls.upload.every(u => safeMediaPath(u.path)), 'path ต้องผ่าน safeMediaPath ไม่งั้นเสิร์ฟไม่ได้')
  const create = calls.rpc.find(c => c.fn === 'media_create')
  assert.equal(create.token, 'user-token')
  assert.equal(create.body.p_data.public_url, `https://inbox.apluscondo.com/library-media/${LIBRARY_FOLDER}/${A}.jpg`)
  assert.equal(create.body.p_data.width, 1200)
})

test('upload: ไฟล์ผิดประเภทต้องไม่แตะ storage เลย', async () => {
  const { lib, calls } = harness()
  await assert.rejects(lib.command('t', 'media_library_upload', { title: 'x', file: { data: b64(WEBP) } }))
  assert.equal(calls.upload.length, 0)
  assert.equal(calls.rpc.length, 0)
})

test('list: แปลง filter เป็นพารามิเตอร์ RPC และกรอง conversation_id ที่ไม่ใช่ uuid', async () => {
  const { lib, calls } = harness({ media_list: [] })
  await lib.command('t', 'media_library_list', { project: 'naii', sort: 'recent', conversation_id: 'x; drop', scope: 'manage' })
  assert.deepEqual(calls.rpc[0].body, { p_project: 'naii', p_category: null, p_query: null, p_sort: 'recent', p_conversation_id: null, p_scope: 'manage' })
})

test('update: ส่งเฉพาะฟิลด์ที่เปลี่ยน, ลบวันหมดอายุด้วยค่าว่าง', async () => {
  const { lib, calls } = harness()
  await lib.command('t', 'media_library_update', { id: A, expires_at: '', status: 'approved' })
  assert.deepEqual(calls.rpc[0].body, { p_id: A, p_data: { expires_at: '', status: 'approved' } })
})

test('action ที่ไม่รู้จัก → undefined (server ตอบ invalid_request)', async () => {
  const { lib } = harness()
  assert.equal(await lib.command('t', 'media_library_delete_everything', {}), undefined)
})

test('resolve: รูปที่ฐานไม่คืน (archived/หมดอายุ/ไม่มีสิทธิ์) → 409 ก่อนสร้างข้อความ', async () => {
  const { lib } = harness({ media_get: [{ id: A, storage_path: 'x', mime: 'image/jpeg' }] })
  await assert.rejects(lib.resolve('t', [A, B]), e => e.status === 409)
  assert.equal((await lib.resolve('t', [A])).get(A).mime, 'image/jpeg')
})

test('materialize: รูปคลัง = copy ภายใน storage, ไฟล์แนบ = upload, ลำดับ path ตามแผน', async () => {
  const { lib, calls } = harness()
  const assets = new Map([[A, { id: A, storage_path: `${LIBRARY_FOLDER}/${A}.jpg`, mime: 'image/jpeg', bytes: 99 }]])
  const media = await lib.materialize({
    plan: [{ kind: 'file', index: 0 }, { kind: 'media', id: A }],
    assets, files: [{ bytes: PNG, mime: 'image/png' }], inboxId: INBOX, messageId: MSG, storagePath,
  })
  assert.deepEqual(calls.upload.map(u => u.path), [storagePath(INBOX, MSG, 1, 'image/png')])
  assert.deepEqual(calls.copy, [{ from: `${LIBRARY_FOLDER}/${A}.jpg`, to: storagePath(INBOX, MSG, 2, 'image/jpeg') }])
  assert.deepEqual(media.map(m => m.mime), ['image/png', 'image/jpeg'])
  assert.equal(media[1].library_id, A)
})

test('handleFile: path นอกแบบหรือฐานไม่อนุญาต → 404 โดยไม่แตะ storage', async () => {
  let fetched = 0
  const lib = createMediaLibrary({ fail, origin: 'https://x', rpcDirect: async () => false,
    uploadObject() {}, copyObject() {}, fetchObject: async () => { fetched++; return { ok: false } } })
  const req = { method: 'GET' }
  await assert.rejects(lib.handleFile(req, {}, new URL('https://x/library-media/../../secret'), 't'), e => e.status === 404)
  await assert.rejects(lib.handleFile(req, {}, new URL(`https://x/library-media/${LIBRARY_FOLDER}/${A}.jpg`), 't'), e => e.status === 404)
  assert.equal(fetched, 0)
})
