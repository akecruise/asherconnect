import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync('public/app.js', 'utf8')
const css = fs.readFileSync('public/app.css', 'utf8')

test('channel badges keep LINE green, Messenger blue and Instagram red', () => {
  assert.match(app, /line:'line'/)
  assert.match(app, /messenger:'fb'/)
  assert.match(app, /instagram:'ig'/)
  assert.match(css, /\.channel-badge\.line\s*\{[^}]*#06C755/i)
  assert.match(css, /\.channel-badge\.fb\s*\{[^}]*#0866FF/i)
  assert.match(css, /\.channel-badge\.ig\s*\{[^}]*#E1306C/i)
})

test('chat bubbles use Facebook-style grey inbound and blue outbound colors', () => {
  assert.match(css, /\.message-row\.inbound \.bubble\s*\{[^}]*#F0F2F5[^}]*#050505/i)
  assert.match(css, /\.message-row\.outbound \.bubble\s*\{[^}]*#0084FF[^}]*#FFFFFF/i)
})
