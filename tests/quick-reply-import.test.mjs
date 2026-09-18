import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseCsv, parseQuickReplyFile, validateQuickReplyRows, classifyQuickReplies } from '../services/answer-hub/quick-reply-import.mjs'

test('CSV import preserves BOM and multiline Thai text', () => {
  const rows = parseCsv('\ufeffshortcut,name,message,category,active,sort_order,source,image_url\nNAII_X,ชื่อ,"บรรทัดหนึ่ง\nบรรทัดสอง",ทำเล,FALSE,10,facebook,')
  assert.equal(rows.length, 1); assert.equal(rows[0].message, 'บรรทัดหนึ่ง\nบรรทัดสอง')
  const result = validateQuickReplyRows(rows); assert.equal(result.invalid.length, 0); assert.equal(result.rows[0].active, false)
})

test('invalid active and duplicate shortcuts are rejected', () => {
  const base = { shortcut: 'X', name: 'ชื่อ', message: 'ข้อความ', category: 'อื่นๆ', active: 'TRUE', sort_order: '1', source: 'facebook', image_url: '' }
  const result = validateQuickReplyRows([base, { ...base, _row: 3 }, { ...base, shortcut: 'Y', active: 'maybe', _row: 4 }])
  assert.equal(result.rows.length, 1); assert.equal(result.invalid.length, 2); assert.equal(result.invalid[0].code, 'duplicate_shortcut'); assert.equal(result.invalid[1].code, 'invalid_active')
})

test('Asher Naii workbook reads Import_Data, Thai text, URLs and inactive price rows', async () => {
  const b = await readFile(new URL('../imports/asher-facebook-quick-replies-filled-naii.xlsx', import.meta.url))
  const result = parseQuickReplyFile({ filename: 'asher-facebook-quick-replies-filled-naii.xlsx', content: b.toString('base64') })
  assert.equal(result.invalid.length, 0); assert.equal(result.rows.length, 32)
  for (const key of ['NAII_PRICE', 'NAII_PSM', 'NAII_ROOM_PRICE']) assert.equal(result.rows.find(x => x.shortcut === key).active, false)
  assert.match(result.rows.find(x => x.shortcut === 'NAII_360').body, /https:\/\/dev\.wisdomstudio\.co\.th/)
  assert.match(result.rows.find(x => x.shortcut === 'NAII_ROOM_PRICE').body, /\n/)
})

test('classification skips identical and updates changed existing rows', () => {
  const rows = [{ shortcut: 'A', title: 'A', body: 'one', category: 'other', active: false, sort_order: 1 }, { shortcut: 'B', title: 'B2', body: 'two', category: 'other', active: true, sort_order: 2 }]
  const out = classifyQuickReplies(rows, [{ id: '1', shortcut: 'A', title: 'A', body: 'one', category: 'other', active: false, sort_order: 1 }, { id: '2', shortcut: 'B', title: 'B', body: 'old', category: 'other', active: true, sort_order: 2 }])
  assert.deepEqual(out.map(x => x.status), ['SKIP', 'UPDATE']); assert.equal(out[1].id, '2')
})

test('admin UI exposes file import and server route gates preview/apply to admins', async () => {
  const html = await readFile(new URL('../public/quick-replies-admin.html', import.meta.url), 'utf8')
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(html, /id="import-file"/); assert.match(html, /accept="\.csv,\.xlsx/)
  assert.match(server, /quick_reply_import_preview/); assert.match(server, /who\.user\?\.role !== 'admin'/)
})
