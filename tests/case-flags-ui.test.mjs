import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TAG_COLORS, tagColor, isFlagFilter, flagListArgs, bkkAt, followPresets, followBadge, cardTags, matchTags, tagDiff } from '../public/case-flags.mjs'

test('palette matches the database check constraint and has no red', () => {
  const sql = readFileSync(new URL('../sql/202610011000_contact_star_tags.sql', import.meta.url), 'utf8')
  const allowed = /color in \(([^)]*)\)/.exec(sql)[1].match(/'([a-z]+)'/g).map(s => s.slice(1, -1))
  assert.deepEqual(TAG_COLORS, allowed)
  assert.ok(!TAG_COLORS.includes('red'))
  assert.equal(tagColor('red'), 'grey')
})

test('star and tag filters go to flag_list, others stay on list', () => {
  assert.equal(isFlagFilter('starred'), true)
  assert.equal(isFlagFilter('tag:abc'), true)
  for (const f of ['all', 'unassigned', 'followup', 'proj-naii']) assert.equal(isFlagFilter(f), false)
  assert.deepEqual(flagListArgs('tag:abc', 'x', 50), { filter: 'tag', tag_id: 'abc', search: 'x', offset: 50 })
  assert.deepEqual(flagListArgs('starred', '', 0), { filter: 'starred', search: '', offset: 0 })
})

test('follow presets land on 10:00 Bangkok time', () => {
  // 2026-10-01 23:30 เวลาไทย = 16:30Z → "พรุ่งนี้" คือ 2 ต.ค. 10:00 ไทย = 03:00Z
  const now = Date.parse('2026-10-01T16:30:00Z')
  assert.equal(bkkAt(now, 1), '2026-10-02T03:00:00.000Z')
  // 2026-10-02 00:30 ไทย (= 1 ต.ค. 17:30Z) ยังนับวันตามเวลาไทย
  assert.equal(bkkAt(Date.parse('2026-10-01T17:30:00Z'), 1), '2026-10-03T03:00:00.000Z')
  assert.deepEqual(followPresets(now).map(p => p.at), ['2026-10-02T03:00:00.000Z', '2026-10-04T03:00:00.000Z', '2026-10-08T03:00:00.000Z'])
})

test('follow badge marks overdue without using red', () => {
  const now = Date.parse('2026-10-03T00:00:00Z')
  assert.equal(followBadge(null), null)
  assert.equal(followBadge('2026-10-02T03:00:00Z', now).overdue, true)
  assert.equal(followBadge('2026-10-05T03:00:00Z', now).overdue, false)
  assert.match(followBadge('2026-10-05T03:00:00Z', now).label, /^⏰ 5/)
})

test('cards show two tags and +N', () => {
  const t = n => Array.from({ length: n }, (_, i) => ({ id: String(i), name: 't' + i }))
  assert.deepEqual(cardTags(t(4)), { shown: t(2), more: 2 })
  assert.deepEqual(cardTags(undefined), { shown: [], more: 0 })
})

test('tag search offers creation only when no exact name exists', () => {
  const tags = [{ id: '1', name: 'สนใจ 1BR' }, { id: '2', name: 'Hot' }]
  assert.deepEqual(matchTags(tags, 'hot'), { hits: [tags[1]], create: '' })
  assert.equal(matchTags(tags, 'นักลงทุน ').create, 'นักลงทุน')
  assert.equal(matchTags(tags, '').create, '')
  assert.equal(matchTags(tags, 'x'.repeat(31)).create, '')
})

test('tag diff turns checkboxes into add/remove', () => {
  assert.deepEqual(tagDiff(['a', 'b'], ['b', 'c']), { add: ['c'], remove: ['a'] })
})

test('lead form save still sends the current follow_up_at so save does not clear it', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  assert.match(app, /follow_up_at:detail\.state\?\.follow_up_at\|\|''/)
  assert.doesNotMatch(app, /\$\('followup'\)/)
})
