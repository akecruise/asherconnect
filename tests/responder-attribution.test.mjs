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
  const presentation = await readFile(new URL('public/conversation-presentation.mjs', root), 'utf8')
  assert.match(app, /messageSenderLabel/)
  assert.match(presentation, /ไม่ระบุผู้ตอบ/)
  assert.match(presentation, /responder_display_name/)
  assert.match(app, /stamp=m\.sent_at\|\|m\.created_at/)
})

test('LINE OA backfill snapshots owner name and repairs mojibake system labels', async () => {
  const sql = await readFile(new URL('sql/202609252200_line_oa_responder_name.sql', root), 'utf8')
  assert.match(sql, /line_oa_reply_event_attribution/)
  assert.match(sql, /responder_display_name/)
  assert.match(sql, /LINE OA owner/)
  assert.match(sql, /\[ลูกค้าเพิ่มเพื่อน\]/)
  assert.match(sql, /\[ลูกค้าบล็อกบัญชี\]/)
  assert.match(sql, /event_type = 'follow'/)
  assert.match(sql, /event_type = 'unfollow'/)
})

test('canonical lifecycle labels also repair the denormalized conversation preview', async () => {
  const sql = await readFile(new URL('sql/202609252300_system_preview_label.sql', root), 'utf8')
  assert.match(sql, /last_message_preview/)
  assert.match(sql, /event_type in \('follow', 'unfollow'\)/)
  assert.match(sql, /is distinct from/)
})

test('responder backfill worker is bounded, idempotent, and scheduled', async () => {
  const sql = await readFile(new URL('sql/202609241000_responder_backfill_worker.sql', root), 'utf8')
  assert.match(sql, /CREATE OR REPLACE FUNCTION inbox\.backfill_responder_attribution/) 
  assert.match(sql, /m\.responder_user_id IS NULL/)
  assert.match(sql, /LIMIT p_batch_size/)
  assert.match(sql, /pg_try_advisory_xact_lock/)
  assert.match(sql, /responder-attribution-backfill/)
  assert.match(sql, /\*\/|--/) // migration remains reviewable as SQL, not generated code
})
