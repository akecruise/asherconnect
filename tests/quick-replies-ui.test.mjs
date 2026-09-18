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
  assert.match(source, /message\.focus\(\); setTimeout\(close, 80\)/)
  assert.doesNotMatch(source, /sendMessage\(item\.content\)/)
})

test('category chips filter in place and keep search state', () => {
  assert.match(source, /category = c; cats\.querySelectorAll\('button'\)/)
  assert.match(source, /chip\.classList\.toggle\('active', chip === b\)/)
  assert.match(source, /chip === b\)\); render\(\)/)
  assert.match(source, /search\.addEventListener\('input', \(\) => \{ query = search\.value; render\(\) \}\)/)
  assert.match(source, /select\.addEventListener\('change', \(\) => \{ sort = select\.value; render\(\) \}\)/)
})

test('card interaction has pressed feedback and remains manual-send only', () => {
  assert.match(source, /b\.setAttribute\('aria-pressed', 'false'\)/)
  assert.match(source, /b\.classList\.add\('selected'\)/)
  assert.match(source, /b\.disabled = true/)
  assert.match(source, /touch-action:manipulation/)
})

test('saved reply cards are safe, clamped and hide inactive rows', () => {
  assert.match(source, /\.filter\(x => x\.active !== false\)/)
  assert.match(source, /p\.className = 'quick-reply-preview'/)
  assert.match(source, /textContent = item\.displayName/)
  assert.match(source, /-webkit-line-clamp:3/)
  assert.match(source, /quick-reply-card:focus-visible/)
})
