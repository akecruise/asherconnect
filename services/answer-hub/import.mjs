// Phase 10 import parser. Deliberately dependency-free and server-side: the
// browser never evaluates spreadsheet input or receives privileged database access.
import { unzipSync } from 'node:zlib'
const FORMULA = /^[=+\-@]/
const REQUIRED = new Set(['category', 'title', 'answer'])
const ENUMS = { answer_type: new Set(['static', 'dynamic', 'hybrid']), audience: new Set(['both', 'human', 'bot']) }

export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('invalid_import_file')
  const rows = []; let row = [], field = '', quote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote && c === '"' && text[i + 1] === '"') { field += '"'; i++; continue }
    if (c === '"') { quote = !quote; continue }
    if (!quote && c === ',') { row.push(field); field = ''; continue }
    if (!quote && (c === '\n' || c === '\r')) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); if (row.some(x => x !== '')) rows.push(row); row = []; field = ''; continue }
    field += c
  }
  if (quote) throw new Error('invalid_import_file')
  row.push(field); if (row.some(x => x !== '')) rows.push(row)
  if (!rows.length) return []
  const headers = rows.shift().map(x => x.trim().toLowerCase().replace(/^\ufeff/, ''))
  return rows.map((values, i) => Object.fromEntries(headers.map((h, n) => [h, (values[n] ?? '').trim()])))
    .map((r, i) => ({ ...r, _row: i + 2 }))
}

const xml = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
const col = ref => { let n = 0; for (const c of ref.replace(/\d/g, '')) n = n * 26 + c.charCodeAt(0) - 64; return n - 1 }
// XLSX is a ZIP of XML files. This intentionally accepts only the first simple
// worksheet and scalar cells; formulas are rejected by validation below.
export function parseXlsx(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 2_000_000) throw new Error('invalid_import_file')
  let files; try { files = unzipSync(bytes) } catch { throw new Error('invalid_import_file') }
  const shared = [...String(files['xl/sharedStrings.xml'] ?? '').matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)]
    .map(m => xml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')))
  const sheet = String(files['xl/worksheets/sheet1.xml'] ?? '')
  if (!sheet) throw new Error('invalid_import_file')
  const grid = []
  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = /r="([A-Z]+\d+)"/.exec(cm[1])?.[1]; if (!ref) continue
      const type = /t="([^"]+)"/.exec(cm[1])?.[1]; const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cm[2])?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cm[2])?.[1] ?? ''
      row[col(ref)] = type === 's' ? (shared[Number(raw)] ?? '') : xml(raw)
    }
    grid.push(row)
  }
  if (!grid.length) return []
  const headers = grid.shift().map(x => String(x ?? '').trim().toLowerCase())
  return grid.filter(r => r.some(v => String(v ?? '').trim())).map((r, i) => Object.fromEntries(headers.map((h, n) => [h, String(r[n] ?? '').trim()])))
    .map((r, i) => ({ ...r, _row: i + 2 }))
}

export function parseImportFile({ content, filename = '' }) {
  if (/\.xlsx$/i.test(filename)) return parseXlsx(Buffer.from(String(content), 'base64'))
  if (/\.csv$/i.test(filename)) return parseCsv(content)
  throw new Error('invalid_import_file')
}

export function validateImportRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) return { rows: [], invalid: [{ row: 0, code: 'invalid_import_file' }] }
  const invalid = []; const clean = []
  for (const original of rows) {
    const row = { ...original }
    const missing = [...REQUIRED].filter(k => !String(row[k] ?? '').trim())
    const dangerous = Object.entries(row).find(([, v]) => FORMULA.test(String(v).trim()))
    if (missing.length || dangerous || (row.answer_type && !ENUMS.answer_type.has(row.answer_type)) || (row.audience && !ENUMS.audience.has(row.audience))) {
      invalid.push({ row: row._row ?? 0, code: dangerous ? 'csv_injection' : 'invalid_import_row', fields: missing })
      continue
    }
    clean.push({ category: row.category, intent: row.intent || null, title: row.title.slice(0, 300), body_template: row.answer.slice(0, 12000),
      question_examples: row.question ? [row.question.slice(0, 1000)] : [], project: row.project || null,
      answer_type: row.answer_type || 'static', audience: row.audience || 'both', show_in_quick_answer: row.show_in_quick_answer !== 'false',
      bot_auto_answer: row.bot_auto_answer === 'true', priority: Number.isInteger(Number(row.priority)) ? Number(row.priority) : 100,
      valid_from: row.valid_from || null, valid_to: row.valid_to || null, source_type: 'imported', _row: row._row })
  }
  return { rows: clean, invalid }
}
