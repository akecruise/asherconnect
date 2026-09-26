import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dateSeparatorLabel, messageSenderLabel, messageSide, messageStatus } from '../public/conversation-presentation.mjs'

test('customer inbound is left and uses channel/customer identity', () => {
  assert.equal(messageSide('contact'), 'inbound')
  assert.equal(messageSenderLabel({ sender_type: 'contact' }, { display_name: 'ศิริพร' }, 'line'), 'ศิริพร')
  assert.equal(messageSenderLabel({ sender_type: 'contact' }, {}, 'messenger'), 'ลูกค้า Messenger')
  assert.equal(messageSenderLabel({ sender_type: 'contact' }, { external_id: 'PSID-1234' }, 'messenger'), 'ลูกค้า Messenger ···1234')
  assert.equal(messageSenderLabel({ sender_type: 'contact' }, { display_name: 'ลูกค้าใหม่', external_id: 'PSID-5678' }, 'messenger'), 'ลูกค้า Messenger ···5678')
})

test('human outbound is right and uses immutable sender snapshot, never assignee', () => {
  assert.equal(messageSide('agent'), 'outbound')
  assert.equal(messageSenderLabel({ sender_type: 'agent', responder_display_name: 'Golf Phitcha', sender_name: 'Nan' }), 'Golf Phitcha')
  assert.equal(messageSenderLabel({ sender_type: 'agent' }), 'ไม่ระบุผู้ตอบ')
  assert.equal(messageSenderLabel({ sender_type: 'agent' }, {}, 'tiktok'), 'ตอบผ่าน TikTok — ไม่ทราบผู้ตอบ')
  assert.equal(messageSenderLabel({ sender_type: 'agent', responder_display_name: 'Nan' }, {}, 'tiktok'), 'Nan')
})

test('bot outbound is explicitly Asher Bot with bot delivery status', () => {
  assert.equal(messageSide('bot'), 'outbound')
  assert.equal(messageSenderLabel({ sender_type: 'bot', sender_name: 'Nan' }), 'Asher Bot')
  assert.equal(messageStatus({ sender_type: 'bot', delivery_status: 'sent' }), 'ส่งแล้ว')
})

test('delivery states prefer channel timestamps and expose safe labels', () => {
  assert.equal(messageStatus({ sender_type: 'agent', delivery_status: 'pending' }), 'กำลังส่ง')
  assert.equal(messageStatus({ sender_type: 'agent', delivered_at: '2026-09-23T15:00:00Z', delivery_status: 'sent' }), 'ส่งถึงแล้ว')
  assert.equal(messageStatus({ sender_type: 'agent', read_at: '2026-09-23T15:00:00Z' }), 'อ่านแล้ว')
  assert.equal(messageStatus({ sender_type: 'agent', delivery_status: 'failed' }), 'ส่งไม่สำเร็จ')
})

test('date separator groups Bangkok calendar days', () => {
  const now = new Date('2026-09-23T03:00:00Z')
  assert.equal(dateSeparatorLabel('2026-09-23T02:00:00Z', now), 'วันนี้')
  assert.equal(dateSeparatorLabel('2026-09-22T02:00:00Z', now), 'เมื่อวาน')
  assert.match(dateSeparatorLabel('2026-09-20T02:00:00Z', now), /20 ก\.ย\./)
})

test('system messages do not impersonate a human responder', () => {
  assert.equal(messageSide('system'), 'system')
  assert.equal(messageSenderLabel({ sender_type: 'system', sender_name: 'Golf' }), 'ระบบ')
  assert.equal(messageStatus({ sender_type: 'system', delivery_status: 'sent' }), '')
})

test('shared renderer keeps attachments and mobile layout hooks', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8')
  assert.match(app, /Array\.isArray\(m\.media\)/)
  assert.match(app, /message-row '\+side|message-row \+side/)
  assert.match(css, /@media \(max-width: 640px\)/)
  assert.match(css, /\.message-content \{ max-width: 88% \}/)
  assert.match(css, /\.message-row\.inbound \.bubble \{ background: var\(--messenger-inbound\)/)
  assert.match(css, /\.message-row\.outbound \.bubble \{ background: var\(--messenger-outbound\)/)
  assert.match(css, /\.message-row\.outbound:has\(\.bot-badge\) \.bubble \{ background: var\(--messenger-outbound\)/)
})

test('send path uses the actual actor and leaves conversation ownership unchanged', async () => {
  const sql = await readFile(new URL('../sql/202609221400_manual_name_guard.sql', import.meta.url), 'utf8')
  const send = sql.slice(sql.indexOf("elsif p_action='send'"), sql.indexOf("elsif p_action='retry'"))
  assert.match(send, /sender_type,sender_id,content\) values\(v_id,'agent',v_actor/)
  assert.doesNotMatch(send, /assignee_id\s*=/)
})
