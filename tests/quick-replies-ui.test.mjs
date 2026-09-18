import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('public/quick-replies.js', 'utf8')

test('saved reply display mapping keeps technical shortcut searchable', () => {
  assert.match(source, /NAII_LOC:\s*'ที่ตั้งโครงการ'/)
  assert.match(source, /displayName.*shortcut.*content.*category/)
  assert.match(source, /x\.displayName} \$\{x\.shortcut\} \$\{x\.content\} \$\{x\.category\}/)
})

test('saved reply card inserts the full content without sending', () => {
  assert.match(source, /p\.textContent = item\.content/)
  assert.match(source, /message\.value = item\.content/)
  assert.match(source, /message\.dispatchEvent\(new Event\('input'/)
  assert.match(source, /message\.focus\(\); close\(\)/)
  assert.doesNotMatch(source, /sendMessage\(item\.content\)/)
})

test('saved reply cards are safe, clamped and hide inactive rows', () => {
  assert.match(source, /\.filter\(x => x\.active !== false\)/)
  assert.match(source, /p\.className = 'quick-reply-preview'/)
  assert.match(source, /textContent = item\.displayName/)
  assert.match(source, /-webkit-line-clamp:3/)
  assert.match(source, /quick-reply-card:focus-visible/)
})
