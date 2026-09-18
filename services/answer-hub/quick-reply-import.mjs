import { inflateRawSync } from 'node:zlib'

const MAX_BYTES = 2 * 1024 * 1024
const REQUIRED = ['shortcut', 'name', 'message', 'category', 'active', 'sort_order', 'source', 'image_url']
const ALLOWED_SOURCE = new Set(['facebook', 'line', 'messenger', 'manual', 'imported'])
const CATEGORY_MAP = new Map([
  ['greeting', 'greeting'], ['rooms_price', 'rooms_price'], ['floorplan', 'floorplan'], ['facilities', 'facilities'], ['location', 'location'], ['promo', 'promo'], ['visit', 'visit'], ['other', 'other'],
  ['ราคา', 'rooms_price'], ['โปรโมชั่น', 'promo'], ['นัดชม', 'visit'], ['ทำเล', 'location'], ['ห้องว่าง', 'rooms_price'], ['ข้อมูลโครงการ', 'facilities'], ['การจอง', 'other'], ['อื่นๆ', 'other'],
])

function xmlText(value) {
  return String(value).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

function zipEntries(bytes) {
  const b = Buffer.from(bytes); let eocd = -1
  for (let i = b.length - 22; i >= 0 && i >= b.length - 65557; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('invalid_xlsx')
  const count = b.readUInt16LE(eocd + 10); const cdSize = b.readUInt32LE(eocd + 12); const cdOffset = b.readUInt32LE(eocd + 16)
  if (cdOffset + cdSize > b.length) throw new Error('invalid_xlsx')
  const out = new Map(); let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('invalid_xlsx')
    const method = b.readUInt16LE(p + 10); const csize = b.readUInt32LE(p + 20); const usize = b.readUInt32LE(p + 24)
    const nlen = b.readUInt16LE(p + 28); const xlen = b.readUInt16LE(p + 30); const clen = b.readUInt16LE(p + 32); const off = b.readUInt32LE(p + 42)
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8'); const l = off
    if (b.readUInt32LE(l) !== 0x04034b50) throw new Error('invalid_xlsx')
    const ln = b.readUInt16LE(l + 26); const lx = b.readUInt16LE(l + 28); const raw = b.subarray(l + 30 + ln + lx, l + 30 + ln + lx + csize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data || data.length !== usize) throw new Error('invalid_xlsx')
    out.set(name, data); p += 46 + nlen + xlen + clen
  }
  return out
}

function colIndex(ref) {
  let n = 0; for (const c of ref.replace(/\d/g, '')) n = n * 26 + c.charCodeAt(0) - 64
  return n - 1
}

function parseXmlSheet(text, shared) {
  const grid = []
  for (const rm of text.matchAll(/<(?:[A-Za-z0-9_]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?row>/g)) {
    const row = []
    for (const cm of rm[1].matchAll(/<(?:[A-Za-z0-9_]+:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?c>/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(cm[1])?.[1]; if (!ref) continue
      const type = /\bt="([^"]+)"/.exec(cm[1])?.[1]
      const raw = /<(?:[A-Za-z0-9_]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?v>/.exec(cm[2])?.[1] ?? /<(?:[A-Za-z0-9_]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?t>/.exec(cm[2])?.[1] ?? ''
      row[colIndex(ref)] = type === 's' ? (shared[Number(raw)] ?? '') : xmlText(raw)
    }
    grid.push(row)
  }
  if (!grid.length) return []
  const headers = grid.shift().map(v => String(v ?? '').trim().toLowerCase())
  return grid.filter(r => r.some(v => String(v ?? '').trim())).map((r, i) => Object.fromEntries(headers.map((h, n) => [h, String(r[n] ?? '')])))
    .map((r, i) => ({ ...r, _row: i + 2 }))
}

export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('invalid_import_file')
  const rows = []; let row = []; let field = ''; let quote = false
  text = text.replace(/^\ufeff/, '')
  for (let i = 0; i < text.length; i++) { const c = text[i]
    if (quote && c === '"' && text[i + 1] === '"') { field += '"'; i++; continue }
    if (c === '"') { quote = !quote; continue }
    if (!quote && c === ',') { row.push(field); field = ''; continue }
    if (!quote && (c === '\n' || c === '\r')) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); if (row.some(x => x !== '')) rows.push(row); row = []; field = ''; continue }
    field += c
  }
  if (quote) throw new Error('invalid_import_file')
  row.push(field); if (row.some(x => x !== '')) rows.push(row)
  if (!rows.length) return []
  const headers = rows.shift().map(x => x.trim().toLowerCase())
  return rows.map((values, i) => ({ ...Object.fromEntries(headers.map((h, n) => [h, values[n] ?? ''])), _row: i + 2 }))
}

export function parseXlsx(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error('invalid_import_file')
  const files = zipEntries(bytes); const workbook = xmlText(files.get('xl/workbook.xml')?.toString('utf8') ?? '')
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const rid = /<(?:[A-Za-z0-9_]+:)?sheet\b[^>]*name="Import_Data"[^>]*r:id="([^"]+)"/.exec(workbook)?.[1]
  if (!rid) throw new Error('missing_import_data_sheet')
  const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/>/g)].find(m => new RegExp(`(?:^|\\s)Id="${rid}"(?:\\s|$)`).test(m[1]))
  const target = /(?:^|\s)Target="([^"]+)"/.exec(rel?.[1] ?? '')?.[1]
  if (!target) throw new Error('invalid_xlsx')
  const path = target.replace(/^\//, '').startsWith('xl/') ? target.replace(/^\//, '') : `xl/${target.replace(/^\//, '')}`
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<(?:[A-Za-z0-9_]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?si>/g)]
    .map(m => xmlText([...m[1].matchAll(/<(?:[A-Za-z0-9_]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?t>/g)].map(x => x[1]).join('')))
  const sheet = files.get(path); if (!sheet) throw new Error('invalid_xlsx')
  return parseXmlSheet(sheet.toString('utf8'), shared)
}

function formula(value) { return /^[=+\-@]/.test(String(value).trim()) }
function bool(value) { const v = String(value ?? '').trim().toLowerCase(); if (['true', '1', 'yes'].includes(v)) return true; if (['false', '0', 'no'].includes(v)) return false; return null }

export function validateQuickReplyRows(rows) {
  const invalid = []; const clean = []; const seen = new Set()
  if (!Array.isArray(rows) || rows.length > 500) return { rows: [], invalid: [{ row: 0, code: 'invalid_import_file' }] }
  for (const raw of rows) {
    const row = Object.fromEntries(REQUIRED.map(k => [k, String(raw?.[k] ?? '').trim()])); const no = raw?._row ?? 0
    const missing = ['shortcut', 'name', 'message', 'category', 'active', 'sort_order', 'source'].filter(k => !row[k])
    const active = bool(row.active); const sort = /^\d+$/.test(row.sort_order) ? Number(row.sort_order) : NaN
    const badFormula = Object.values(row).some(formula)
    const category = CATEGORY_MAP.get(row.category) ?? CATEGORY_MAP.get(row.category.toLowerCase())
    const reason = badFormula ? 'csv_injection' : missing.length ? 'missing_required' : active === null ? 'invalid_active' : !Number.isSafeInteger(sort) ? 'invalid_sort_order' : !category ? 'invalid_category' : !ALLOWED_SOURCE.has(row.source.toLowerCase()) ? 'invalid_source' : null
    if (reason) { invalid.push({ row: no, code: reason, fields: missing }); continue }
    if (seen.has(row.shortcut)) { invalid.push({ row: no, code: 'duplicate_shortcut', fields: ['shortcut'] }); continue }
    seen.add(row.shortcut)
    clean.push({ shortcut: row.shortcut, title: row.name, body: row.message, category, category_label: row.category, active, sort_order: sort, source: row.source.toLowerCase(), image_url: row.image_url || null, _row: no })
  }
  return { rows: clean, invalid }
}

export function parseQuickReplyFile({ filename, content }) {
  if (!/\.(csv|xlsx)$/i.test(filename || '')) throw new Error('unsupported_file')
  const bytes = Buffer.from(String(content || ''), 'base64'); if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('invalid_import_file')
  const rows = /\.xlsx$/i.test(filename) ? parseXlsx(bytes) : parseCsv(bytes.toString('utf8'))
  const headers = new Set(Object.keys(rows[0] || {}).filter(k => k !== '_row'))
  const missing = REQUIRED.filter(k => !headers.has(k)); if (missing.length) throw new Error(`missing_columns:${missing.join(',')}`)
  return validateQuickReplyRows(rows)
}

export function classifyQuickReplies(rows, existing) {
  const by = new Map((Array.isArray(existing) ? existing : []).map(x => [String(x.shortcut || '').trim(), x]))
  return rows.map(row => { const old = by.get(row.shortcut); if (!old) return { ...row, status: 'NEW' }
    const same = String(old.title ?? old.name ?? '') === row.title && String(old.body ?? old.content ?? '') === row.body && String(old.category ?? '') === row.category && Boolean(old.active ?? old.is_active) === row.active && Number(old.sort_order ?? 100) === row.sort_order
    return { ...row, status: same ? 'SKIP' : 'UPDATE', id: old.id }
  })
}
