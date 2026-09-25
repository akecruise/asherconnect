// Local, read-only preview of the episode-aware customer-reply monitor.
// Usage: node scripts/pending-replies-preview.mjs [minutes-from-now]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const minutes = Number(process.argv[2] ?? 0)
const now = new Date(Date.now() + (Number.isFinite(minutes) ? minutes * 60000 : 0)).toISOString()
const sql = `select inbox.pending_reply_preview('${now}'::timestamptz, 200);`
const { stdout } = await run('docker', [
  'exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql,
])
const value = stdout.trim()
console.log(value ? JSON.stringify(JSON.parse(value), null, 2) : '{"rows":[]}')
