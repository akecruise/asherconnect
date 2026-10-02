// หน้าเว็บโหลดได้เฉพาะไฟล์ที่อยู่ใน staticFiles ของ server.mjs (ตารางชื่อแบบเป๊ะ)
// ★ เพิ่มไฟล์ใน public/ แล้วลืมลงตาราง = 404 บน production และถ้าเป็น import ของ app.js หน้าแชทจะพังทั้งหน้า
//   เทสต์ในเบราว์เซอร์ที่เสิร์ฟทุกไฟล์ใน public/ จับเรื่องนี้ไม่ได้ จึงตรวจจากตัวโค้ดตรง ๆ ที่นี่
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
// ★ \r?\n เพราะ working tree บน Windows เป็น CRLF (git normalize เป็น LF ตอน commit)
//   ของเดิมจับแค่ \n จึงพังเงียบ ๆ เมื่อมีคนแก้ไฟล์บนเครื่อง Windows
const table = /const staticFiles = \{([\s\S]*?)\}\r?\n/.exec(server)[1]
const served = new Set([...table.matchAll(/'(\/[^']*)'\s*:/g)].map(m => m[1]))

test('every module app.js imports is served', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const imports = [...app.matchAll(/(?:^|\n)import [^\n]*? from '\.\/([^']+)'/g), ...app.matchAll(/import\('\.\/([^']+)'\)/g)].map(m => '/' + m[1])
  assert.ok(imports.includes('/case-flags.mjs'))
  for (const path of imports) assert.ok(served.has(path), path + ' is imported by app.js but missing from staticFiles')
})

test('every local script and stylesheet in index.html is served', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|mjs|css))"/g)].map(m => m[1])
  for (const path of refs) assert.ok(served.has(path), path + ' is referenced by index.html but missing from staticFiles')
})
