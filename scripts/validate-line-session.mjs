#!/usr/bin/env node
/** Check the exported browser session against the LINE OA account, without logging secrets. */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) throw new Error('Cookie file argument is required')
const payload = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const cookies = payload?.data?.cookies || payload?.cookies || payload
if (!Array.isArray(cookies)) throw new Error('Invalid LINE cookie export')
const line = cookies.filter(item => String(item.domain || '').endsWith('line.biz'))
const session = line.find(item => item.name === '__Host-chat-ses')
if (!session || Number(session.expires) * 1000 <= Date.now() + 15 * 60_000) {
  throw new Error('LINE Business session is missing or expires within 15 minutes')
}
const bot = 'U0f8a4998da40e9e0fa908abd13be3793'
const response = await fetch(`https://chat.line.biz/api/v1/bots/${bot}/owners`, {
  headers: {
    cookie: line.map(item => `${item.name}=${item.value}`).join('; '),
    referer: `https://chat.line.biz/${bot}`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
  },
  signal: AbortSignal.timeout(15_000),
})
if (!response.ok) throw new Error(`LINE Business session validation failed (HTTP ${response.status})`)
const body = await response.json()
if (!Array.isArray(body.list) || body.list.length === 0) throw new Error('LINE Business owner list is empty')
console.log(`LINE session valid; expires ${new Date(Number(session.expires) * 1000).toISOString()}`)
