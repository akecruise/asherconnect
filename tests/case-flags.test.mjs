import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FLAG_ACTIONS, flagRpc } from '../lib/case-flags.mjs'

test('flag actions map to inbox RPCs with a single p argument', () => {
  assert.deepEqual(flagRpc('case_star', { conversation_id: 'x', starred: true }),
    { fn: 'case_star', body: { p: { conversation_id: 'x', starred: true } } })
  assert.deepEqual(flagRpc('tags_list', undefined), { fn: 'tags_list', body: { p: {} } })
})

test('actions outside the allow-list do not reach the database', () => {
  for (const action of ['flag_actor', 'flag_contact_of', 'flag_tags_of', 'list', 'case_star;drop', ''])
    assert.equal(flagRpc(action, {}), null)
})

test('every allow-listed action exists in the migration and is granted to authenticated', () => {
  const files = ['202610011000_contact_star_tags.sql', '202610021000_contacts_page.sql']
  const sql = files.map(f => readFileSync(new URL('../sql/' + f, import.meta.url), 'utf8')).join('\n')
  const grant = [...sql.matchAll(/grant execute on function([\s\S]*?)to authenticated/g)].map(m => m[1]).join(' ')
  for (const action of FLAG_ACTIONS) {
    assert.match(sql, new RegExp(`create or replace function inbox\\.${action}\\(p jsonb`), action)
    assert.match(grant, new RegExp(`inbox\\.${action}\\(jsonb\\)`), action + ' granted')
  }
})

test('server routes flag actions through the allow-list', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(server, /flagRpc\(input\.action, input\.data\)/)
})

test('contacts page migration only reads — never writes messages or their timestamps', () => {
  const sql = readFileSync(new URL('../sql/202610021000_contacts_page.sql', import.meta.url), 'utf8')
    .replace(/--[^\n]*/g, '')
  assert.doesNotMatch(sql, /\b(update|delete\s+from|insert\s+into|alter\s+table|truncate)\s+inbox\.message\b/i)
  assert.doesNotMatch(sql, /\bcreated_at\s*=/i)
  assert.doesNotMatch(sql, /\bcreate\s+table\b/i)
})
