// ตัวนำเข้า Saved Replies จาก Facebook (CSV UTF-8 / XLSX) สำหรับหน้า /quick-replies
//
// ★ ตั้งใจไม่มี dependency แม้แต่ตัวเดียว — image ของ asher-connect ไม่มีขั้น npm install
//   (Dockerfile COPY ไฟล์ตรง ๆ) เพิ่ม exceljs ปุ๋ยเดียว build พังทันที จึงแยกไฟล์เองทั้งหมด:
//   CSV ตาม RFC 4180 · XLSX = zip (แยกเองจาก central directory) + XML (regex แบบกำหนดขอบเขต)
//   ทุกไฟล์ XLSX ผ่านด่านตรวจโครงสร้างก่อนแตะเนื้อหา — ห้าม zip bomb, เข้ารหัส, macro, path แปลก
import { inflateRawSync } from 'node:zlib'

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const MAX_ROWS = 500
const MAX_COLUMNS = 30
const MAX_XLSX_EXPANDED = 20 * 1024 * 1024

const error = message => Object.assign(new Error(message), { status: 400 })

// ชุดหมวดหมู่ต้องตรงกับ CHECK ใน sql/038 ทุกตัวอักษร — แก้ข้างหนึ่งต้องแก้อีกข้าง
export const CATEGORIES = new Set([
  'greeting', 'rooms_price', 'floorplan', 'facilities', 'location', 'promo', 'visit', 'other',
  'ราคา', 'โปรโมชั่น', 'นัดชม', 'ทำเล', 'ห้องว่าง', 'การจอง', 'ทั่วไป', 'ข้อมูลโครงการ', 'คัดกรอง', 'ติดตาม',
])

export const normalizedMessage = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
export const normalizedShortcut = value => String(value ?? '').normalize('NFKC').trim().replace(/^\/+/, '').toLowerCase()

// ลำดับตรวจตาม spec E: ราคา → โปรโมชั่น → นัดชม → ทำเล → ห้องว่าง → การจอง
export function autoCategory(value) {
  const text = String(value).toLowerCase()
  for (const [category, words] of [
    ['ราคา', ['ราคา', 'บาท', 'ล้าน', 'เริ่มต้น', 'ผ่อน']],
    ['โปรโมชั่น', ['โปรโมชั่น', 'โปร', 'ส่วนลด', 'ฟรี']],
    ['นัดชม', ['นัด', 'ชม', 'ดูห้อง', 'เยี่ยมชม']],
    ['ทำเล', ['ทำเล', 'bts', 'mrt', 'ถนน', 'เดินทาง']],
    ['ห้องว่าง', ['ห้องว่าง', 'ยูนิต', 'พร้อมอยู่']],
    ['การจอง', ['จอง', 'booking', 'มัดจำ']],
  ]) if (words.some(word => text.includes(word))) return category
  return 'ทั่วไป'
}

export function safeHttps(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !/[\r\n]/.test(value) ? url.href : null } catch { return null }
}

export function validateRow(input, index = 0) {
  const errors = []
  const row = {
    row_number: index + 2,
    shortcut: String(input.shortcut ?? '').normalize('NFKC').trim().replace(/^\/+/, ''),
    name: String(input.name ?? input.title ?? '').trim(),
    message: String(input.message ?? input.body ?? '').trim(),
    category: String(input.category ?? '').trim(),
    source: 'facebook',
    source_shortcut: String(input.source_shortcut ?? input.shortcut ?? '').trim(),
    image_url: String(input.image_url ?? '').trim(),
  }
  if (!row.shortcut || row.shortcut.length > 80 || /[\s/\x00-\x1f]/u.test(row.shortcut)) errors.push('Shortcut ต้องมี 1–80 ตัวอักษร ไม่มีช่องว่างหรือ /')
  if (!row.name || row.name.length > 160) errors.push('Name ต้องมี 1–160 ตัวอักษร')
  if (!row.message || row.message.length > 10000 || row.message.includes('\0')) errors.push('Message ต้องมี 1–10,000 ตัวอักษร')
  if (!row.category) row.category = autoCategory(`${row.name} ${row.message}`)
  if (!CATEGORIES.has(row.category)) errors.push(`Category ต้องเป็นหมวดในระบบ เช่น ${[...CATEGORIES].filter(c => !/^[a-z_]+$/.test(c)).slice(0, 6).join(' ')} หรือภาษาอังกฤษตามยุคบอท`)
  const active = String(input.active ?? '').trim().toLowerCase()
  if (!['', 'true', 'false', '1', '0'].includes(active)) errors.push('Active ต้องเป็น true หรือ false')
  row.active = !['false', '0'].includes(active)
  row.sort_order = input.sort_order === '' || input.sort_order == null ? 100 : Number(input.sort_order)
  if (!Number.isInteger(row.sort_order) || Math.abs(row.sort_order) > 2147483647) errors.push('Sort order ต้องเป็นจำนวนเต็ม')
  if (row.image_url && !safeHttps(row.image_url)) errors.push('Image URL ต้องเป็น HTTPS')
  return { ...row, errors }
}

// ── CSV ตาม RFC 4180: ครอบด้วย " ได้, "" = " ตัวจริง, ขึ้นบรรทัด \r\n \n \r ──
export function parseCsvMatrix(text) {
  if (text.includes('\0')) throw error('รูปแบบ CSV ไม่ถูกต้อง')
  const matrix = []
  let row = [], value = '', inQuotes = false
  const endRow = () => { if (row.some(cell => cell !== '') || value !== '') matrix.push([...row, value]); else matrix.push([]); row = []; value = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { value += '"'; i++ } else inQuotes = false }
      else value += ch
    } else if (ch === '"' && value === '') inQuotes = true
    else if (ch === ',') { row.push(value); value = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow() }
    else value += ch
  }
  if (value !== '' || row.length) endRow()
  // เทียบเท่า skip_empty_lines ของ csv-parse — บรรทัดว่างไม่นับเป็นข้อมูล
  const data = matrix.filter(r => r.some(cell => String(cell).trim() !== ''))
  if (data.length > MAX_ROWS + 1) throw error(`ต้องมีข้อมูลไม่เกิน ${MAX_ROWS} รายการ`)
  return data
}

// ── XLSX: อ่าน zip เองจาก central directory พร้อมด่านตรวจความปลอดภัย ──
// คืน Map(ชื่อไฟล์ใน zip → Buffer ที่ขยายแล้ว) ทุก entry ต้องผ่านก่อนใช้เนื้อหา
export function readXlsxEntries(buffer) {
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw error('ไฟล์ XLSX ไม่ถูกต้อง')
  const count = buffer.readUInt16LE(end + 10), directory = buffer.readUInt32LE(end + 16)
  if (!count || count > 1000 || directory >= end || buffer.readUInt16LE(end + 4) !== 0) throw error('ไฟล์ XLSX ซับซ้อนเกินขนาดที่อนุญาต')
  let cursor = directory, total = 0
  const names = new Set(), entries = new Map()
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw error('ไฟล์ XLSX ไม่ถูกต้อง')
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20), expanded = buffer.readUInt32LE(cursor + 24)
    const length = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32), offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + length).toString('utf8')
    if ((flags & 1) || ![0, 8].includes(method) || expanded > MAX_XLSX_EXPANDED || /vbaProject|\.bin$|\.zip$|\.\.\/|^\//i.test(name) || names.has(name)) throw error('ไฟล์ XLSX มีเนื้อหาที่ไม่รองรับ')
    names.add(name); total += expanded
    if (total > MAX_XLSX_EXPANDED || offset + 30 > directory || buffer.readUInt32LE(offset) !== 0x04034b50) throw error('ไฟล์ XLSX ขยายตัวเกินขนาดที่อนุญาต')
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    if (start + compressed > directory) throw error('ไฟล์ XLSX ไม่ถูกต้อง')
    const data = buffer.subarray(start, start + compressed)
    let output; try { output = method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(1, expanded) }) : data } catch { throw error('ไฟล์ XLSX ไม่ถูกต้อง') }
    if (output.length !== expanded || /<!DOCTYPE|<!ENTITY/i.test(output.toString('utf8'))) throw error('ไฟล์ XLSX มีเนื้อหาที่ไม่รองรับ')
    entries.set(name, output)
    cursor += 46 + length + extra + comment
  }
  if (!entries.has('xl/workbook.xml') || !entries.has('[Content_Types].xml')) throw error('ต้องเป็นไฟล์ XLSX')
  return entries
}

const decodeEntities = value => value
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// <si> หนึ่งก้อนอาจแตกเป็น <r><t> หลายท่อน (rich text) — ประกบกลับเป็นข้อความเดียว
const parseSharedStrings = entries => {
  const xml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g)].map(m =>
    decodeEntities([...(m[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(t => t[1] ?? '').join('')))
}

const columnIndexOf = ref => {
  const letters = /^([A-Z]+)/.exec(ref)?.[1]
  if (!letters) throw error('ไฟล์ XLSX ไม่ถูกต้อง')
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

// เลือกแผ่นแรกตามลำดับของ workbook.xml ผ่าน rels — เดิม ExcelJS ใช้ worksheets[0]
function firstSheetPath(entries) {
  const workbook = entries.get('xl/workbook.xml').toString('utf8')
  const sheetRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1]
  if (sheetRid) {
    const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
    const target = new RegExp(`<Relationship\\b[^>]*\\bId="${sheetRid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${sheetRid}"`).exec(rels)?.[1]
    if (target) {
      const normalized = target.replace(/^\/xl\//, '').replace(/^xl\//, '').replace(/^\//, '')
      const path = `xl/${target.startsWith('/xl/') ? target.slice(4) : target.startsWith('xl/') ? target.slice(3) : target}`
      if (entries.has(path)) return path
      if (entries.has(normalized)) return normalized
    }
  }
  const fallback = [...entries.keys()].filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))[0]
  if (!fallback) throw error('ไฟล์ XLSX ไม่มีแผ่นงาน')
  return fallback
}

export function parseXlsxMatrix(buffer) {
  const entries = readXlsxEntries(buffer)
  const shared = parseSharedStrings(entries)
  const xml = entries.get(firstSheetPath(entries)).toString('utf8')
  const matrix = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const cells = []
    let width = 0
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? '', inner = cellMatch[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /\bt="([A-Za-z]+)"/.exec(attrs)?.[1] ?? 'n'
      if (/<f[\s/>]/.test(inner)) throw error('XLSX ต้องเป็นค่าข้อความ ไม่รองรับสูตร')
      let value = ''
      if (type === 's') {
        const index = Number(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1])
        if (!Number.isInteger(index) || index < 0 || index >= shared.length) throw error('ไฟล์ XLSX ไม่ถูกต้อง')
        value = shared[index]
      } else if (type === 'inlineStr') {
        value = decodeEntities([...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(t => t[1] ?? '').join(''))
      } else if (type === 'e') value = '' // ช่อง error ของสูตร/อ้างอิงพัง = ถือว่าว่าง ให้ validateRow เตือนเอง
      else if (type === 'b') value = /<v(?:\s[^>]*)?>\s*1\s*<\/v>/.test(inner) ? 'true' : 'false'
      else value = decodeEntities((/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '').trim())
      if (ref) {
        const at = columnIndexOf(ref)
        if (at >= MAX_COLUMNS) throw error(`XLSX ต้องไม่เกิน ${MAX_COLUMNS} คอลัมน์`)
        while (cells.length < at) cells.push('')
        cells[at] = value
        width = Math.max(width, at + 1)
      } else { cells.push(value); width = Math.max(width, cells.length) }
    }
    if (cells.some(cell => String(cell).trim() !== '')) matrix.push(width ? cells.slice(0, Math.max(cells.length, width)) : cells)
    if (matrix.length > MAX_ROWS + 1) throw error(`XLSX ต้องไม่เกิน ${MAX_ROWS} รายการ`)
  }
  return matrix
}

export async function parseImport(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMPORT_BYTES) throw error('ไฟล์ต้องมีขนาด 1 byte ถึง 5 MB')
  let matrix
  if (/\.csv$/i.test(filename)) {
    let value; try { value = new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { throw error('CSV ต้องเป็น UTF-8') }
    matrix = parseCsvMatrix(value)
  } else if (/\.xlsx$/i.test(filename)) matrix = parseXlsxMatrix(buffer)
  else throw error('รองรับเฉพาะ CSV UTF-8 และ XLSX')
  if (matrix.length < 2 || matrix.length > MAX_ROWS + 1) throw error('ต้องมีข้อมูล 1–500 รายการ')
  const headers = matrix.shift().map(value => String(value).replace(/^﻿/, '').trim().toLowerCase())
  if (new Set(headers).size !== headers.length || !['shortcut', 'name', 'message'].every(key => headers.includes(key))) throw error('Missing required column: shortcut, name, message หรือชื่อคอลัมน์ซ้ำ')
  return matrix.map((cells, index) => validateRow(Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? ''])), index))
}

// ตรวจซ้ำกับของที่มีอยู่จริงในฐาน (shortcut หรือข้อความ normalized ตรงกัน)
// ผลคือต่อท้ายแต่ละแถว: duplicate_ids + duplicate_reason — การตัดสินใจเป็นของ admin
export function previewRows(rows, existing) {
  const seen = existing.map(x => ({
    id: x.id,
    shortcut: normalizedShortcut(x.shortcut),
    message: normalizedMessage(x.body ?? x.message ?? x.content ?? ''),
  }))
  return rows.map(row => {
    const shortcut = normalizedShortcut(row.shortcut), message = normalizedMessage(row.message)
    const duplicate_ids = [...new Set(seen.filter(x => x.shortcut === shortcut || x.message === message).map(x => x.id))]
    if (!duplicate_ids.length) return { ...row, duplicate_ids }
    const reasons = []
    if (shortcut && seen.some(x => x.shortcut === shortcut)) reasons.push('shortcut เดิมมีในระบบแล้ว')
    if (message && seen.some(x => x.message === message)) reasons.push('ข้อความเดียวกันมีในระบบแล้ว')
    return { ...row, duplicate_ids, duplicate_reason: reasons.join(' · ') || 'ตรงกับรายการที่มีอยู่' }
  })
}
