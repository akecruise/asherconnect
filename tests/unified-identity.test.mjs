import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../sql/202609221000_unified_identity.sql', import.meta.url), 'utf8')

test('unified identity migration keeps Supabase UUID canonical and legacy mappings additive', () => {
  assert.match(sql, /core\.user_identity_map/)
  assert.match(sql, /core\.user_module_access/)
  assert.match(sql, /auth\.uid\(\)/)
  assert.match(sql, /\('senior_sales','Senior sales user'\)/)
  assert.match(sql, /m\.auth_subject_id::text ~\*/) 
  assert.match(sql, /ON CONFLICT \(system_code,legacy_user_id\) DO NOTHING/)
  assert.match(sql, /asher_crm\.crm_memberships/)
  assert.doesNotMatch(sql, /DROP TABLE|DROP SCHEMA|DELETE FROM/i)
})

test('unified identity access is fail-closed for missing authenticated user', () => {
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION core.current_user_has_module'))
  assert.match(fn, /auth\.uid\(\) IS NOT NULL/)
  assert.match(fn, /a\.is_enabled/)
})
