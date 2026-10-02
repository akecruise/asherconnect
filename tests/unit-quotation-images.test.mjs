import assert from 'node:assert/strict'
import test from 'node:test'
import { createUnitQuotationImages, unitQuotationPath } from '../lib/unit-quotation-images.mjs'
import { safeOutboundPath } from '../lib/outbound-media.mjs'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')])
const v1 = 'a'.repeat(24), v2 = 'b'.repeat(24)

const setup = ({ units = [{ id: A, quotation_version: v1 }, { id: B, quotation_version: v1 }], stored = [], render, crmDown = false } = {}) => {
  const calls = { list: 0, render: 0, write: [] }
  let clock = 0
  let catalog = units
  let down = crmDown
  const images = createUnitQuotationImages({
    async listFromCrm () { calls.list++; if (down) throw new Error('crm_404'); return catalog },
    async fetchFromCrm (id) { calls.render++; return render ? render(id) : { bytes: png, version: catalog.find(u => u.id === id)?.quotation_version ?? v1 } },
    async listStored () { return stored },
    async writeObject (path) { calls.write.push(path) },
    now: () => clock,
  })
  return { images, calls, tick: ms => { clock += ms }, setCatalog: c => { catalog = c }, setDown: d => { down = d } }
}

test('stored path is accepted by the signed outbound-media route', () => {
  const path = unitQuotationPath(A.toUpperCase(), v1)
  assert.equal(path, `outbound/unit-quote-${A}-${v1}.png`)
  assert.equal(safeOutboundPath(path), path)
  assert.throws(() => unitQuotationPath('../x', v1), /invalid_unit_id/)
})

test('warmAll renders only units that are not stored yet', async () => {
  const { images, calls } = setup({ stored: [unitQuotationPath(A, v1)] })
  assert.deepEqual(await images.warmAll(), { total: 2, made: 1, failed: 0 })
  assert.deepEqual(calls.write, [unitQuotationPath(B, v1)])
})

test('after warming, sending a room never asks CRM to render', async () => {
  const { images, calls } = setup()
  await images.warmAll()
  const rendered = calls.render
  assert.equal(await images.pathFor(A), unitQuotationPath(A, v1))
  assert.equal(calls.render, rendered)
})

test('a price change produces a new image version; the old one is kept', async () => {
  const { images, calls, tick, setCatalog } = setup()
  await images.warmAll()
  setCatalog([{ id: A, quotation_version: v2 }, { id: B, quotation_version: v1 }])
  tick(3 * 60_000)
  assert.equal(await images.pathFor(A), unitQuotationPath(A, v2))
  assert.ok(calls.write.includes(unitQuotationPath(A, v1)))
  assert.ok(calls.write.includes(unitQuotationPath(A, v2)))
})

test('recent room list is reused; stale list is refreshed before sending', async () => {
  const { images, calls, tick } = setup()
  await images.warmAll()
  await images.pathFor(A)
  assert.equal(calls.list, 1)
  tick(3 * 60_000)
  await images.pathFor(A)
  assert.equal(calls.list, 2)
})

test('a room that is no longer available cannot be sent', async () => {
  const { images } = setup({ units: [{ id: A, quotation_version: v1 }] })
  await assert.rejects(images.pathFor(B), e => e.status === 409 && e.message === 'unit_unavailable')
})

test('concurrent sends of the same room render once', async () => {
  const { images, calls } = setup()
  await images.refresh()
  await Promise.all([images.pathFor(A), images.pathFor(A)])
  assert.equal(calls.render, 1)
})

test('one room failing to render does not stop the others', async () => {
  const { images } = setup({ render: id => { if (id === A) throw new Error('boom'); return { bytes: png, version: v1 } } })
  assert.deepEqual(await images.warmAll(), { total: 2, made: 1, failed: 1 })
})

test('a non-PNG response is not stored', async () => {
  const { images, calls } = setup({ render: () => ({ bytes: Buffer.from('{"error":1}'), version: v1 }) })
  await images.refresh()
  await assert.rejects(images.pathFor(A), /not_png/)
  assert.equal(calls.write.length, 0)
})

test('CRM down on a fresh start: the newest stored image of the room is sent', async () => {
  const { images } = setup({ crmDown: true, stored: [
    { path: unitQuotationPath(A, v1), at: '2026-09-28T10:00:00Z' },
    { path: unitQuotationPath(A, v2), at: '2026-09-29T10:00:00Z' },
  ] })
  assert.equal(await images.pathFor(A), unitQuotationPath(A, v2))
})

test('CRM down after a stale list: the last known version is sent without CRM', async () => {
  const { images, calls, tick, setDown } = setup()
  await images.warmAll()
  const rendered = calls.render
  setDown(true)
  tick(3 * 60_000)
  assert.equal(await images.pathFor(A), unitQuotationPath(A, v1))
  assert.equal(calls.render, rendered)
})

test('CRM fails to render: fall back to a stored image of the room', async () => {
  const { images, setCatalog } = setup({ stored: [unitQuotationPath(A, v1)], render: () => { throw new Error('crm_500') } })
  setCatalog([{ id: A, quotation_version: v2 }])
  assert.equal(await images.pathFor(A), unitQuotationPath(A, v1))
})

test('CRM down and nothing stored for the room: the CRM error surfaces', async () => {
  const { images } = setup({ crmDown: true, stored: [unitQuotationPath(B, v1)] })
  await assert.rejects(images.pathFor(A), /crm_404/)
})

test('CRM up and says the room is gone: a stored image is never sent', async () => {
  const { images } = setup({ units: [{ id: B, quotation_version: v1 }], stored: [unitQuotationPath(A, v1)] })
  await assert.rejects(images.pathFor(A), e => e.status === 409 && e.message === 'unit_unavailable')
})
