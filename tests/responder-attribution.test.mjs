import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)

test('responder attribution migration is additive and snapshot-based', async () => {
  const sql = await readFile(new URL('sql/202609231500_responder_attribution.sql', root), 'utf8')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS responder_user_id/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS responder_display_name/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS sent_at/)
  assert.match(sql, /capture_responder_attribution/)
  assert.match(sql, /responder_attribution_unresolved/)
  assert.doesNotMatch(sql, /DROP TABLE\s+inbox\.message/i)
})

test('Inbox UI renders responder snapshot and explicit historical fallback', async () => {
  const app = await readFile(new URL('public/app.js', root), 'utf8')
  assert.match(app, /ตอบโดย:/)
  assert.match(app, /ไม่ระบุผู้ตอบ/)
  assert.match(app, /responder_display_name/)
  assert.match(app, /sent_at\|\|m\.created_at/)
})
