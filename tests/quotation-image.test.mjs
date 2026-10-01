import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuotationImageStore, isPng, quotationImagePath } from '../lib/quotation-image.mjs'

const id = '67fabe8b-80a5-4c0d-b3b3-6841d1d68fdc'
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')])

const setup = ({ stored = new Map(), readFails = false, writeFails = false, crm = async () => png } = {}) => {
  const calls = { crm: 0, write: 0 }
  const store = createQuotationImageStore({
    async readObject (path) { if (readFails) throw new Error('storage_500'); return stored.get(path) ?? null },
    async writeObject (path, bytes) { calls.write++; if (writeFails) throw new Error('storage_500'); stored.set(path, bytes) },
    async fetchFromCrm (quotationId) { calls.crm++; return crm(quotationId) },
  })
  return { store, stored, calls }
}

test('path is scoped by quotation id and rejects anything that is not a uuid', () => {
  assert.equal(quotationImagePath(id.toUpperCase()), `quotation/${id}.png`)
  assert.throws(() => quotationImagePath('../secrets'), /invalid_quotation_id/)
})

test('isPng checks the file signature', () => {
  assert.equal(isPng(png), true)
  assert.equal(isPng(Buffer.from('<html>error</html>')), false)
  assert.equal(isPng(null), false)
})

test('first request fetches from CRM once and stores; later requests never call CRM', async () => {
  const { store, stored, calls } = setup()
  assert.deepEqual(await store.get(id), png)
  assert.equal(stored.has(`quotation/${id}.png`), true)
  await store.get(id)
  await store.get(id)
  assert.equal(calls.crm, 1)
})

test('LINE fetching original + preview at the same time costs one CRM call', async () => {
  const { store, calls } = setup()
  await Promise.all([store.get(id), store.get(id)])
  assert.equal(calls.crm, 1)
  assert.equal(calls.write, 1)
})

test('storage outage still serves the image from CRM', async () => {
  const { store, calls } = setup({ readFails: true, writeFails: true })
  assert.deepEqual(await store.get(id), png)
  assert.equal(calls.crm, 1)
})

test('a non-PNG CRM response is neither stored nor served', async () => {
  const { store, stored } = setup({ crm: async () => Buffer.from('{"error":"boom"}') })
  await assert.rejects(store.get(id), /quotation_image_not_png/)
  assert.equal(stored.size, 0)
})

test('a failed CRM call can be retried', async () => {
  let fail = true
  const { store, calls } = setup({ crm: async () => { if (fail) throw new Error('service_unavailable'); return png } })
  await assert.rejects(store.get(id))
  fail = false
  assert.deepEqual(await store.get(id), png)
  assert.equal(calls.crm, 2)
})
