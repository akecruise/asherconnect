// เทสต์ lib/profile.mjs — ไม่ยิงเน็ตจริงสักนัด ใช้ fetch ปลอมทั้งหมด
//
// ★ สิ่งที่เทสต์ชุดนี้ต้องพิสูจน์ให้ได้คือ "ไม่มีทางทำให้ข้อความลูกค้าหาย"
//   ดังนั้นทุกเคสความล้มเหลวต้องคืนค่าปกติ ห้าม throw ออกมา
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchProfile, _resetProfileCache } from '../lib/profile.mjs'

const LINE = { key: 'naii-line-oa', channel: 'line', inbox_id: 'inbox-1', access_token: 'TOKEN-LINE' }
const FB = { key: 'asher-messenger', channel: 'messenger', inbox_id: 'inbox-2', access_token: 'TOKEN-FB', api_version: 'v23.0' }

const silent = { warn() {}, info() {}, error() {} }
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

test('LINE 200 — ได้ชื่อและรูป', async () => {
  _resetProfileCache()
  const calls = []
  const out = await fetchProfile({
    channel: 'line', externalId: 'U' + '1'.repeat(32), config: LINE,
    deps: { log: silent, fetch: async (u, o) => { calls.push({ u, o }); return res(200, { displayName: '  คุณอารีย์  ', pictureUrl: 'https://p/1.jpg' }) } },
  })
  assert.deepEqual(out, { status: 'ok', display_name: 'คุณอารีย์', picture_url: 'https://p/1.jpg' })
  assert.match(calls[0].u, /\/v2\/bot\/profile\/U1{32}$/)
  assert.equal(calls[0].o.headers.Authorization, 'Bearer TOKEN-LINE')
})

test('LINE ในกลุ่ม — ใช้ endpoint ของ group', async () => {
  _resetProfileCache()
  let url = ''
  await fetchProfile({
    channel: 'line', externalId: 'Uaaa', config: LINE, source: { type: 'group', id: 'Gxyz' },
    deps: { log: silent, fetch: async (u) => { url = u; return res(200, { displayName: 'ก' }) } },
  })
  assert.match(url, /\/v2\/bot\/group\/Gxyz\/member\/Uaaa$/)
})

test('LINE ในห้อง — ใช้ endpoint ของ room', async () => {
  _resetProfileCache()
  let url = ''
  await fetchProfile({
    channel: 'line', externalId: 'Ubbb', config: LINE, source: { type: 'room', id: 'Rxyz' },
    deps: { log: silent, fetch: async (u) => { url = u; return res(200, { displayName: 'ข' }) } },
  })
  assert.match(url, /\/v2\/bot\/room\/Rxyz\/member\/Ubbb$/)
})

test('404 — คืน not_found ไม่ throw', async () => {
  _resetProfileCache()
  const out = await fetchProfile({
    channel: 'line', externalId: 'Uccc', config: LINE,
    deps: { log: silent, fetch: async () => res(404, {}) },
  })
  assert.deepEqual(out, { status: 'not_found', display_name: null, picture_url: null })
})

test('500 — คืน error ไม่ throw', async () => {
  _resetProfileCache()
  const out = await fetchProfile({
    channel: 'line', externalId: 'Uddd', config: LINE,
    deps: { log: silent, fetch: async () => res(500, {}) },
  })
  assert.equal(out.status, 'error')
  assert.equal(out.display_name, null)
})

test('timeout — คืน error ไม่ throw', async () => {
  _resetProfileCache()
  const out = await fetchProfile({
    channel: 'line', externalId: 'Ueee', config: LINE,
    deps: { log: silent, fetch: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e } },
  })
  assert.equal(out.status, 'error')
})

test('เน็ตล่มสนิท — ยังคืนค่าปกติ ไม่ throw', async () => {
  _resetProfileCache()
  const out = await fetchProfile({
    channel: 'messenger', externalId: '123', config: FB,
    deps: { log: silent, fetch: async () => { throw new TypeError('fetch failed') } },
  })
  assert.equal(out.status, 'error')
})

test('Messenger 200 — ต่อ first_name กับ last_name', async () => {
  _resetProfileCache()
  let url = ''
  const out = await fetchProfile({
    channel: 'messenger', externalId: '2447', config: FB,
    deps: { log: silent, fetch: async (u) => { url = u; return res(200, { first_name: 'Cheiwchan', last_name: 'Lertakburut', profile_pic: 'https://fb/p.jpg' }) } },
  })
  assert.equal(out.display_name, 'Cheiwchan Lertakburut')
  assert.equal(out.picture_url, 'https://fb/p.jpg')
  assert.match(url, /fields=first_name,last_name,profile_pic/)
})

test('Messenger มีแต่ชื่อต้น — ไม่ได้ช่องว่างห้อยท้าย', async () => {
  _resetProfileCache()
  const out = await fetchProfile({
    channel: 'messenger', externalId: '2448', config: FB,
    deps: { log: silent, fetch: async () => res(200, { first_name: 'Ann' }) },
  })
  assert.equal(out.display_name, 'Ann')
})

test('Messenger error code 100 — นับเป็น not_found ไม่ใช่ error', async () => {
  _resetProfileCache()
  const out = await fetchProfile({
    channel: 'messenger', externalId: '2449', config: FB,
    deps: { log: silent, fetch: async () => res(400, { error: { code: 100, message: 'does not exist' } }) },
  })
  assert.equal(out.status, 'not_found')
})

test('★ ยิงซ้ำคนเดิม — เรียก API นัดเดียว (cache)', async () => {
  _resetProfileCache()
  let n = 0
  const deps = { log: silent, fetch: async () => { n++; return res(200, { displayName: 'ซ้ำ' }) } }
  await fetchProfile({ channel: 'line', externalId: 'Ufff', config: LINE, deps })
  await fetchProfile({ channel: 'line', externalId: 'Ufff', config: LINE, deps })
  await fetchProfile({ channel: 'line', externalId: 'Ufff', config: LINE, deps })
  assert.equal(n, 1, 'ต้องยิงครั้งเดียว')
})

test('★ สามข้อความพร้อมกันจากคนเดียว — ยังยิงนัดเดียว (inflight)', async () => {
  _resetProfileCache()
  let n = 0
  const deps = { log: silent, fetch: async () => { n++; await new Promise(r => setTimeout(r, 20)); return res(200, { displayName: 'พร้อมกัน' }) } }
  const all = await Promise.all([1, 2, 3].map(() =>
    fetchProfile({ channel: 'line', externalId: 'Uggg', config: LINE, deps })))
  assert.equal(n, 1, 'ต้องยิงครั้งเดียวแม้เรียกพร้อมกัน')
  assert.equal(all[0].display_name, 'พร้อมกัน')
  assert.equal(all[2].display_name, 'พร้อมกัน')
})

test('★ คนละ OA = คนละคีย์ ไม่ใช้ cache ปนกัน', async () => {
  _resetProfileCache()
  let n = 0
  const deps = { log: silent, fetch: async () => { n++; return res(200, { displayName: 'x' }) } }
  const other = { ...LINE, inbox_id: 'inbox-9' }
  await fetchProfile({ channel: 'line', externalId: 'Uhhh', config: LINE, deps })
  await fetchProfile({ channel: 'line', externalId: 'Uhhh', config: other, deps })
  assert.equal(n, 2, 'userId เดียวกันคนละ OA ต้องถือเป็นคนละคน')
})

test('ไม่มี token — คืน error ไม่ยิงเน็ต', async () => {
  _resetProfileCache()
  let n = 0
  const out = await fetchProfile({
    channel: 'line', externalId: 'Uiii', config: { ...LINE, access_token: '' },
    deps: { log: silent, fetch: async () => { n++; return res(200, {}) } },
  })
  assert.equal(out.status, 'error')
  assert.equal(n, 0)
})

test('★ log ต้องไม่มี token และไม่มีเนื้อคำตอบ', async () => {
  _resetProfileCache()
  const lines = []
  await fetchProfile({
    channel: 'line', externalId: 'Ujjj', config: LINE,
    deps: { log: { warn: m => lines.push(String(m)) }, fetch: async () => res(500, { secretish: 'คุณสมชาย' }) },
  })
  const joined = lines.join(' ')
  assert.ok(joined.length > 0, 'ต้อง log อะไรสักอย่าง')
  assert.ok(!joined.includes('TOKEN-LINE'), 'ห้ามมี token ใน log')
  assert.ok(!joined.includes('คุณสมชาย'), 'ห้ามมีเนื้อคำตอบใน log')
  assert.match(joined, /http=500/)
})
