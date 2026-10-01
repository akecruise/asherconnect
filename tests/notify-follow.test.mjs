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

// กันไฟล์ถูกเซฟผ่าน PowerShell 5 / cp874 จนภาษาไทยเพี้ยน (เคยเกิดกับ 202609211200_messenger_identity_p0.sql)
// ★ ตรวจทุกไฟล์ที่ git ติดตาม ไม่ใช่แค่ sql/ — โค้ดใน bots/ lib/ public/ ก็มีภาษาไทย
//   ยกเว้น docs/ ที่ยกตัวอย่างข้อความเพี้ยนไว้โดยตั้งใจ
test('ไม่มีไฟล์ไหนมีภาษาไทยเพี้ยนแบบ UTF-8 → cp874', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const { mojibakeLines } = await import('../sql/mojibake.mjs')
  const root = new URL('../', import.meta.url)
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter((f) => /\.(sql|mjs|js|html|css|json|md|txt|sh|py)$/.test(f) && !f.startsWith('docs/'))
  const bad = files.flatMap((f) => {
    const lines = mojibakeLines(readFileSync(new URL(f, root), 'utf8'))
    return lines.length ? [f + ':' + lines.slice(0, 3).join(',')] : []
  })
  assert.deepEqual(bad, [])
})

test('ตัวตรวจไม่จับภาษาไทยจริง แต่จับของที่เพี้ยน', async () => {
  const { MOJIBAKE } = await import('../sql/mojibake.mjs')
  assert.equal(MOJIBAKE.test('เธอเนียนมาก เธอเน้นเรื่องราคา'), false)
  // ต่อจากชิ้นย่อย ไม่งั้นไฟล์เทสต์นี้เองจะโดนเทสต์ข้างบนจับ
  assert.equal(MOJIBAKE.test(['[เธฅ', 'เธน', 'เธเ', 'เธเ', 'เนเ', 'ธฒ]'].join('')), true)
})
