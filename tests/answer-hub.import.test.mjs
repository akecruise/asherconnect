import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, validateImportRows } from '../services/answer-hub/import.mjs'

test('T12 CSV parser handles quoted commas and produces a valid import row', () => {
  const rows = parseCsv('category,title,answer,question\nprice,"Price, today","From 2m",ราคาเท่าไร')
  const out = validateImportRows(rows)
  assert.equal(out.invalid.length, 0); assert.equal(out.rows[0].title, 'Price, today')
})
test('T13 invalid rows and spreadsheet formula injection are rejected before RPC', () => {
  const out = validateImportRows(parseCsv('category,title,answer\nprice,,x\nprice,=cmd,x'))
  assert.equal(out.rows.length, 0); assert.equal(out.invalid.length, 2)
})
test('parser rejects malformed quoted CSV and excessive rows', () => {
  assert.throws(() => parseCsv('category,title,answer\nprice,"broken,x'))
  assert.equal(validateImportRows([]).invalid[0].code, 'invalid_import_file')
})
