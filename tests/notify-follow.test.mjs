import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatNotify } from '../bots/notify.mjs'

// เคสจริง 2026-10-01 19:02: ลูกค้ากดเพิ่มเพื่อน แต่ทีมได้ "🟠 มีคนทัก ... ไม่ตอบ (undefined) → คนต้องตอบ"
// แล้วเปิด chat.line.biz ไม่เจออะไร เพราะเขายังไม่ได้พิมพ์
test('follow: ไม่ขึ้นว่า "มีคนทัก" ไม่ขอให้คนตอบ และไม่มี undefined', () => {
  const msg = formatNotify({ kind: 'follow', reason: 'follow', text: 'เพิ่มเพื่อนใหม่', is_new_chat: true, code: 'abc123' },
                           { inboxUrl: 'https://chat.line.biz/' })
  assert.equal(msg.split('\n')[0].startsWith('👋 มีคนเพิ่มเพื่อน'), true)
  assert.equal(msg.includes('มีคนทัก'), false)
  assert.equal(msg.includes('คนต้องตอบ'), false)
  assert.equal(msg.includes('undefined'), false)
  assert.equal(msg.includes('ข้อความ:'), false)
})

test('ไม่มี reply_reason ก็ไม่พิมพ์ undefined', () => {
  assert.equal(formatNotify({ text: 'สวัสดี', reply_go: false }).includes('undefined'), false)
})

// กันไฟล์ SQL ถูกเซฟผ่าน PowerShell 5 / cp874 จนภาษาไทยเพี้ยน (เคยเกิดกับ 202609211200_messenger_identity_p0.sql)
test('ไฟล์ sql/ ต้องไม่มีภาษาไทยเพี้ยนแบบ UTF-8 → cp874', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = new URL('../sql/', import.meta.url)
  const bad = readdirSync(dir).filter(f => f.endsWith('.sql'))
    .filter(f => /เธ[฀-๿]|เน€/.test(readFileSync(new URL(f, dir), 'utf8')))
  assert.deepEqual(bad, [])
})
