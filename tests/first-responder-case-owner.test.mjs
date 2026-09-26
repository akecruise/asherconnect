import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)

test('first responder ownership is identity-based, serialized, and does not attribute bots or echoes', async () => {
  const sql = await readFile(new URL('sql/202609251400_first_responder_case_owner.sql', root), 'utf8')
  assert.match(sql, /NEW\.sender_type <> 'agent' OR NEW\.sender_id IS NULL/)
  assert.match(sql, /FROM inbox\.conversation[\s\S]*FOR UPDATE/)
  assert.match(sql, /NOT EXISTS[\s\S]*m\.sender_type = 'agent'[\s\S]*m\.sender_id IS NOT NULL/)
  assert.match(sql, /SET assignee_id = NEW\.sender_id/)
  assert.match(sql, /AFTER INSERT ON inbox\.message/)
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE/i)
})

test('migration order includes first responder ownership after the CRM publisher', async () => {
  const order = await readFile(new URL('sql/ORDER.txt', root), 'utf8')
  assert.ok(order.indexOf('202609221200_crm_publish_profile_content.sql') <
    order.indexOf('202609251400_first_responder_case_owner.sql'))
})
