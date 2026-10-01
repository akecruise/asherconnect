#!/usr/bin/env node
/** Run the existing LINE OA reconciliation on a schedule from the VPS host. */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const appDir = '/opt/asher-inbox/app'
const cookieFile = process.env.LINE_OA_COOKIE_FILE || '/opt/asher-inbox/secrets/line-oa-cookies.json'
const channels = JSON.parse(readFileSync(join(appDir, 'channels.json'), 'utf8'))
const entries = Array.isArray(channels) ? channels : channels.channels || []
const line = entries.filter(c => c.channel === 'line' && c.enabled === true && c.inbox_id && c.account_id)
if (line.length !== 1) throw new Error(`Expected one enabled LINE channel, found ${line.length}`)
// The Manager chat bot ID differs from the Messaging API account ID.
const chatBotId = process.env.LINE_OA_CHAT_BOT_ID
if (!/^U[0-9a-f]{32}$/i.test(chatBotId || '')) throw new Error('LINE_OA_CHAT_BOT_ID is missing or invalid')

if (!existsSync(cookieFile)) {
  console.error('LINE OA sync waiting for a session cookie file')
  process.exit(2)
}
if ((statSync(cookieFile).mode & 0o077) !== 0) {
  console.error('LINE OA cookie file must be readable only by its owner (mode 0600)')
  process.exit(2)
}
const exported = JSON.parse(readFileSync(cookieFile, 'utf8').replace(/^\uFEFF/, ''))
const cookies = exported?.data?.cookies || exported?.cookies || exported
const session = Array.isArray(cookies) && cookies.find(c => c.name === '__Host-chat-ses')
if (!session || Number(session.expires) * 1000 <= Date.now()) {
  console.error('LINE OA session expired or missing; sign in to the dedicated Chrome profile')
  process.exit(3)
}

const source = join(appDir, 'scripts/backfill-line-oa-replies.mjs')
if (!existsSync(source)) throw new Error('LINE OA reconciliation script is missing')
const args = [source, '--cookies', cookieFile, '--inbox', line[0].inbox_id,
  '--bot', chatBotId, '--apply']
const run = spawnSync('/usr/bin/node', args, {
  cwd: appDir, encoding: 'utf8', timeout: 12 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
})
if (run.stdout) process.stdout.write(run.stdout)
if (run.stderr) process.stderr.write(run.stderr)
if (run.error) throw run.error
process.exit(run.status ?? 1)
