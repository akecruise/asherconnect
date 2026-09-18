// unit test ของ services/answer-hub/service.mjs (Phase 6 — S01–S17 ฝั่ง service logic)
// ยิงผ่าน fake callRpc — พฤติกรรมฝั่ง SQL พิสูจน์แยกใน sql/_selftest/ (ah_*)
// รัน: node --test tests/answer-hub.service.test.mjs (อยู่ใน chain ของ npm test)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnswerHubService, buildFlags, CODES } from '../services/answer-hub/service.mjs'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

test('Phase 9 preview is gated by master before any RPC', async () => {
  const { service, calls } = makeService()
  assert.equal((await service.handle('ah_preview', 'tok', {})).code, 'HUB_DISABLED')
  assert.equal(calls.length, 0)
})
test('Phase 9 static preview authorizes and never saves', async () => {
  const { service, calls } = makeService({ env: { ANSWER_HUB_ENABLED: '1' } })
  const r = await service.handle('ah_preview', 'tok', { answer_type: 'static', body_template: '<script>x</script> {{unknown}}' })
  assert.equal(r.rendered_text, '<script>x</script> {{unknown}}')
  assert.deepEqual(r.missing, ['unknown'])
  assert.equal(r.requires_human_review, true)
  assert.deepEqual(calls.map(c => c.fn), ['ah_editor_options'])
})
test('Phase 9 denies static preview and editor reads for non-editor roles', async () => {
  const { service, calls } = makeService({ env: { ANSWER_HUB_ENABLED: '1' }, rpc: () => throwCode('ah_not_allowed') })
  for (const action of ['ah_preview', 'ah_editor_get']) assert.equal((await service.handle(action, 'sales', { id: U1, body_template: 'text', answer_type: 'static' })).code, 'ANSWER_NOT_ALLOWED')
  assert.deepEqual(calls.map(c => c.fn), ['ah_editor_options', 'ah_editor_options'])
})
test('Phase 9 dynamic preview respects flag and renders unsaved values with the shared renderer', async () => {
  const env = { ANSWER_HUB_ENABLED: '1' }
  const { service, calls } = makeService({ env, rpc: fn => fn === 'ah_preview_data'
    ? { values: { name: 'ERP value' }, missing: ['price'], sources: ['PROJECT_PROFILE'], detail: [{ status: 'missing', variable: 'price' }] } : {} })
  const input = { answer_type: 'dynamic', body_template: '{{name}} {{price}}', bindings: [], context: { project_id: U1 } }
  assert.equal((await service.handle('ah_preview', 'tok', input)).code, 'FEATURE_DISABLED')
  env.ANSWER_HUB_DYNAMIC_DATA_ENABLED = '1'
  const r = await service.handle('ah_preview', 'tok', input)
  assert.equal(r.rendered_text, 'ERP value {{price}}')
  assert.deepEqual(r.missing, ['price'])
  assert.deepEqual(r.sources_used, ['PROJECT_PROFILE'])
  assert.equal(r.warnings.length, 1)
  assert.deepEqual(calls.at(-1).body.context, input.context)
  assert.ok(!calls.some(c => c.fn === 'ah_save'))
})
test('Phase 9 editor can load expired answers for correction', async () => {
  const { service } = makeService({ env: { ANSWER_HUB_ENABLED: '1' }, rpc: fn => fn === 'ah_get' ? approvedDynamic({ valid_to: '2000-01-01' }) : {} })
  const r = await service.handle('ah_editor_get', 'tok', { id: U1 })
  assert.equal(r.ok, true)
  assert.equal(r.data.item.valid_to, '2000-01-01')
})
test('Phase 9 resolve command dispatch reaches renderer', async () => {
  const { service } = makeService({ env: { ANSWER_HUB_ENABLED: '1' }, rpc: () => approvedDynamic({ answer_type: 'static', body_template: 'hello' }) })
  assert.equal((await service.handle('ah_resolve', 'tok', { answer_id: U1 })).rendered_text, 'hello')
})

test('Phase 11 learning queue and review are independently flag-gated and use RPC', async () => {
  const { service, calls } = makeService({ env: { ANSWER_HUB_ENABLED: '1' } })
  assert.equal((await service.handle('ah_learning_list', 'tok', {})).code, CODES.FEATURE_DISABLED)
  const enabled = makeService({ env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_LEARNING_ENABLED: 'true' }, rpc: (fn) => fn === 'ah_learning_list' ? { rows: [] } : { candidate: { status: 'rejected' } } })
  assert.deepEqual((await enabled.service.handle('ah_learning_list', 'tok', { status: 'pending' })).data.rows, [])
  assert.equal((await enabled.service.learningReview('tok', { id: U1, decision: 'reject' })).data.candidate.status, 'rejected')
  assert.equal(calls.length, 0)
  assert.deepEqual(enabled.calls.map(c => c.fn), ['ah_learning_list', 'ah_learning_review'])
})

function makeService({ rpc = () => ({}), env = {}, logs = [] } = {}) {
  const calls = []
  const service = createAnswerHubService({
    callRpc: async (token, fn, body) => {
      calls.push({ token, fn, body })
      return rpc(fn, body ?? {}, token)
    },
    flags: buildFlags({ env }),
    log: (event, fields) => logs.push({ event, ...fields }),
  })
  return { service, calls, logs }
}

const throwCode = (code) => {
  const e = new Error(code)
  e.status = 400
  throw e
}

const approvedDynamic = (over = {}) => ({
  item: {
    id: U1, status: 'approved', answer_type: 'dynamic', audience: 'both',
    bot_auto_answer: true, valid_from: null, valid_to: null,
    body_template: 'ราคา {{price_start}} ว่าง {{units_avail}}',
    ...over,
  },
  versions: [],
  bindings: [],
})

test('S15 invalid answer id → ANSWER_NOT_FOUND โดยไม่ยิง rpc เลย', async () => {
  const { service, calls } = makeService({ env: { ANSWER_HUB_ENABLED: '1' } })
  const r = await service.getAnswer('tok', 'ไม่ใช่uuid')
  assert.equal(r.ok, false)
  assert.equal(r.code, CODES.ANSWER_NOT_FOUND)
  assert.equal(calls.length, 0)
})

test('S01 get approved answer → ok พร้อม item/versions/bindings + log', async () => {
  const logs = []
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    logs,
    rpc: (fn) => (fn === 'ah_get' ? approvedDynamic() : {}),
  })
  const r = await service.getAnswer('tok', U1)
  assert.equal(r.ok, true)
  assert.equal(r.answer.id, U1)
  assert.deepEqual(r.versions, [])
  assert.ok(logs.some((l) => l.event === 'answer_service_get'))
})

test('S02 rpc ปฏิเสธ (ah_not_allowed) → mapped ANSWER_NOT_ALLOWED', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    rpc: () => throwCode('ah_not_allowed'),
  })
  const r = await service.getAnswer('tok', U1)
  assert.equal(r.code, CODES.ANSWER_NOT_ALLOWED)
})

test('S03 admin อ่าน draft ผ่าน (SQL อนุญาต) — service บอกสถานะไม่ block', async () => {
  const logs = []
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    logs,
    rpc: (fn) => (fn === 'ah_get' ? approvedDynamic({ status: 'draft' }) : {}),
  })
  const r = await service.getAnswer('tok', U1)
  assert.equal(r.ok, true)
  assert.equal(r.answer.status, 'draft')
  assert.ok(logs.some((l) => l.event === 'answer_service_get' && l.not_approved))
})

test('S06 answer หมดอายุ (valid_to ผ่านมาแล้ว) → ANSWER_EXPIRED', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    rpc: () => approvedDynamic({ valid_to: '2026-01-01T00:00:00Z' }),
  })
  const r = await service.getAnswer('tok', U1)
  assert.equal(r.code, CODES.ANSWER_EXPIRED)
})

test('S06 answer ยังไม่ถึงวันเริ่ม (valid_from อนาคต) → ANSWER_EXPIRED', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    rpc: () => approvedDynamic({ valid_from: '2099-01-01T00:00:00Z' }),
  })
  const r = await service.getAnswer('tok', U1)
  assert.equal(r.code, CODES.ANSWER_EXPIRED)
})

test('S04 bot ห้ามใช้ answer สำหรับคน (audience=human) → ANSWER_NOT_ALLOWED', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_BOT_ENABLED: '1' },
    rpc: (fn) => (fn === 'ah_get' ? approvedDynamic({ audience: 'human' }) : {}),
  })
  const r = await service.botResolve('tok', { answer_id: U1 })
  assert.equal(r.code, CODES.ANSWER_NOT_ALLOWED)
})

test('S05 bot ห้ามใช้ answer ที่ bot_auto_answer=false → ANSWER_NOT_ALLOWED', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_BOT_ENABLED: '1' },
    rpc: (fn) => (fn === 'ah_get' ? approvedDynamic({ bot_auto_answer: false }) : {}),
  })
  const r = await service.botResolve('tok', { answer_id: U1 })
  assert.equal(r.code, CODES.ANSWER_NOT_ALLOWED)
})

test('bot ห้ามใช้ของยังไม่ approved → ANSWER_NOT_APPROVED', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_BOT_ENABLED: '1' },
    rpc: (fn) => (fn === 'ah_get' ? approvedDynamic({ status: 'review' }) : {}),
  })
  const r = await service.botResolve('tok', { answer_id: U1 })
  assert.equal(r.code, CODES.ANSWER_NOT_APPROVED)
})

test('S10 resolve static → ไม่ยิง ah_resolve เลย + ไม่โดน dynamic flag', async () => {
  const { service, calls } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' }, // dynamic ปิด
    rpc: (fn) => (fn === 'ah_get' ? approvedDynamic({ answer_type: 'static', body_template: 'สวัสดีค่ะ' }) : {}),
  })
  const r = await service.resolveAnswer('tok', { answer_id: U1, context: { project_id: U2 } })
  assert.equal(r.ok, true)
  assert.equal(r.rendered_text, 'สวัสดีค่ะ')
  assert.deepEqual(r.sources_used, [])
  assert.equal(calls.filter((c) => c.fn === 'ah_resolve').length, 0)
})

test('S11 resolve dynamic → render จากค่าจริง + sources_used ตามที่ฐานรายงาน', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_DYNAMIC_DATA_ENABLED: '1' },
    rpc: (fn) => {
      if (fn === 'ah_get') return approvedDynamic()
      if (fn === 'ah_resolve') {
        return {
          values: { price_start: '2900000.00', units_avail: '12' },
          missing: [],
          sources: ['PROJECT_PRICE', 'AVAILABLE_UNITS'],
          detail: [
            { variable: 'price_start', source_code: 'PROJECT_PRICE', status: 'ok' },
            { variable: 'units_avail', source_code: 'AVAILABLE_UNITS', status: 'ok' },
          ],
          ok: true,
        }
      }
      return {}
    },
  })
  const r = await service.resolveAnswer('tok', { answer_id: U1, context: { project_id: U2 } })
  assert.equal(r.ok, true)
  assert.equal(r.rendered_text, 'ราคา 2900000.00 ว่าง 12')
  assert.deepEqual(r.sources_used, ['PROJECT_PRICE', 'AVAILABLE_UNITS'])
  assert.equal(r.requires_human_review, false)
})

test('S12 resolve hybrid (มี ok/fallback/missing ปน) → review=true + {{}} ค้าง', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_DYNAMIC_DATA_ENABLED: '1' },
    rpc: (fn) => {
      if (fn === 'ah_get') return approvedDynamic({ body_template: 'ราคา {{price_start}} ที่ตั้ง {{location_note}} สิ่งอำนวย {{facilities_note}}' })
      if (fn === 'ah_resolve') {
        return {
          values: { price_start: '2900000.00', location_note: 'สอบถามพนักงาน' },
          missing: ['facilities_note'],
          sources: ['PROJECT_PRICE', 'PROJECT_LOCATION', 'FACILITIES'],
          detail: [
            { variable: 'price_start', source_code: 'PROJECT_PRICE', status: 'ok' },
            { variable: 'location_note', source_code: 'PROJECT_LOCATION', status: 'fallback', reason: 'fact_not_found' },
            { variable: 'facilities_note', source_code: 'FACILITIES', status: 'missing', reason: 'fact_not_found' },
          ],
          ok: false,
        }
      }
      return {}
    },
  })
  const r = await service.resolveAnswer('tok', { answer_id: U1, context: {} })
  assert.equal(r.ok, true)
  assert.equal(r.requires_human_review, true)
  assert.match(r.rendered_text, /ราคา 2900000\.00/)
  assert.match(r.rendered_text, /ที่ตั้ง สอบถามพนักงาน/)
  assert.match(r.rendered_text, /{{facilities_note}}/) // required ขาด = คง {{}} ห้ามส่ง
  assert.equal(r.missing.length, 1)
})

test('S13 required binding missing → requires_human_review (ห้ามส่งอัตโนมัติ)', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_DYNAMIC_DATA_ENABLED: '1' },
    rpc: (fn) => {
      if (fn === 'ah_get') return approvedDynamic()
      if (fn === 'ah_resolve') {
        return {
          values: {}, missing: ['price_start', 'units_avail'], sources: [],
          detail: [
            { variable: 'price_start', source_code: 'PROJECT_PRICE', status: 'missing', reason: 'no_priced_unit' },
            { variable: 'units_avail', source_code: 'AVAILABLE_UNITS', status: 'missing', reason: 'no_priced_unit' },
          ],
          ok: false,
        }
      }
      return {}
    },
  })
  const r = await service.resolveAnswer('tok', { answer_id: U1, context: { project_id: U2 } })
  assert.equal(r.requires_human_review, true)
  assert.equal(r.rendered_text.includes('{{'), true) // ยังมี {{}} ค้าง — ข้อความนี้ส่งไม่ได้
})

test('S14 disabled source → warning SOURCE_DISABLED (ไม่ใช่ค่ามั่ว)', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_DYNAMIC_DATA_ENABLED: '1' },
    rpc: (fn) => {
      if (fn === 'ah_get') return approvedDynamic()
      if (fn === 'ah_resolve') {
        return {
          values: {}, missing: ['appointment_note'], sources: ['APPOINTMENT_SLOT'],
          detail: [
            { variable: 'appointment_note', source_code: 'APPOINTMENT_SLOT', status: 'missing', reason: 'source_inactive' },
          ],
          ok: false,
        }
      }
      return {}
    },
  })
  const r = await service.resolveAnswer('tok', { answer_id: U1, context: {} })
  assert.equal(r.warnings[0].kind, CODES.SOURCE_DISABLED)
  assert.equal(r.warnings[0].source_code, 'APPOINTMENT_SLOT')
})

test('S16+S17 rpc ล้มด้วย raw error แปลก → INTERNAL_ERROR ไม่หลุดข้อความดิบ', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1', ANSWER_HUB_DYNAMIC_DATA_ENABLED: '1' },
    rpc: (fn) => {
      if (fn === 'ah_get') return approvedDynamic()
      if (fn === 'ah_resolve') throwCode('invalid input syntax for type uuid: "xx"')
      return {}
    },
  })
  const r = await service.resolveAnswer('tok', { answer_id: U1, context: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, CODES.INTERNAL_ERROR)
  assert.equal(JSON.stringify(r).includes('syntax'), false)
})

test('flag master ปิด → ทุก action คืน HUB_DISABLED', async () => {
  const { service, calls } = makeService({ env: {} })
  const r = await service.handle('ah_list', 'tok', {})
  assert.equal(r.code, CODES.HUB_DISABLED)
  assert.equal(calls.length, 0)
})

test('flag dynamic ปิด → resolve ของ dynamic คืน FEATURE_DISABLED (static ไม่โดน)', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    rpc: (fn) => (fn === 'ah_get' ? approvedDynamic() : {}),
  })
  const blocked = await service.resolveAnswer('tok', { answer_id: U1 })
  assert.equal(blocked.code, CODES.FEATURE_DISABLED)
})

test('S18 pagination — ค่าตามผ่านถึง rpc + page_size เกินถูก clamp + filter uuid ผิดรูปโดนกัน', async () => {
  const { service, calls } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    rpc: (fn) => (fn === 'ah_list' ? { rows: [], total: 0 } : {}),
  })
  await service.listAnswers('tok', { page: 2, page_size: 9999, project_id: U2 })
  const body = calls.at(-1).body
  assert.equal(body.page, 2)
  assert.equal(body.page_size, 200)
  assert.equal(body.project_id, U2)

  const bad = await service.listAnswers('tok', { project_id: 'abc' })
  assert.equal(bad.code, CODES.ANSWER_INVALID)
})

test('S09 searchAnswers → รูปทรง normalized + score null (คะแนนเป็นของ Phase 14)', async () => {
  const { service } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    rpc: (fn) => (fn === 'ah_list' ? { rows: [{ id: U1, title: 'ราคา', category_id: U2, intent_id: null, answer_type: 'static', source_type: 'manual', project_id: U2, audience: 'both' }], total: 1 } : {}),
  })
  const r = await service.searchAnswers('tok', { query: 'ราคา' })
  assert.equal(r.ok, true)
  assert.equal(r.rows[0].answer_id, U1)
  assert.equal(r.rows[0].score, null)
  const empty = await service.searchAnswers('tok', { query: '   ' })
  assert.equal(empty.code, CODES.ANSWER_INVALID)
})

test('boundary ของ Phase ที่ยังไม่ถึง → usage/feedback คืน NOT_AVAILABLE_YET ไม่แต่งผล', async () => {
  const { service } = makeService({ env: { ANSWER_HUB_ENABLED: '1' } })
  assert.equal((await service.recordUsage()).phase, 16)
  assert.equal((await service.submitFeedback()).phase, 17)
})

test('buildFlags — env เปิด/override ชนะ env/override พังแล้วใช้ env ต่อ', async () => {
  const flags = buildFlags({ env: { ANSWER_HUB_ENABLED: '1' } })
  assert.equal(await flags.isEnabled('master'), true)

  const override = buildFlags({
    env: { ANSWER_HUB_ENABLED: '1' },
    loadOverrides: async () => ({ master: false }),
  })
  assert.equal(await override.isEnabled('master'), false)

  const broken = buildFlags({
    env: { ANSWER_HUB_BOT_ENABLED: '1' },
    loadOverrides: async () => { throw new Error('settings ยังไม่มี') },
  })
  assert.equal(await broken.isEnabled('bot'), true)
})

test('Phase 13 quick answer validates client filters before RPC and preserves server filtering', async () => {
  const { service, calls } = makeService({
    env: { ANSWER_HUB_ENABLED: '1' },
    rpc: (fn, body) => (fn === 'ah_quick_answer' ? { rows: [], categories: [], received: body } : {}),
  })
  const invalid = await service.handle('ah_quick_answer', 'tok', { project_id: 'not-a-uuid' })
  assert.equal(invalid.code, CODES.ANSWER_INVALID)
  assert.equal(calls.length, 0)
  const valid = await service.handle('ah_quick_answer', 'tok', { project_id: U1, category_id: U2, query: 'price' })
  assert.equal(valid.ok, true)
  assert.equal(calls.at(-1).fn, 'ah_quick_answer')
  assert.deepEqual(calls.at(-1).body, { project_id: U1, category_id: U2, query: 'price' })
})
