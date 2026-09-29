import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
if (!process.argv.includes('--allow-local-db-tests')) throw new Error('Pass --allow-local-db-tests for the local rollback-only test')
const context = JSON.parse(execFileSync('docker', ['context', 'inspect'], { encoding: 'utf8' }))[0]
const host = process.env.DOCKER_HOST || context.Endpoints?.docker?.Host || ''
if (!/^(npipe|unix):/.test(host)) throw new Error('This test only accepts a local Docker engine')
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const sql = [
  "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
  read('sql/037_media_pipeline.sql'),
  read('sql/202609231500_responder_attribution.sql'),
  read('sql/20260923090119_instagram_inbox.sql'),
  read('tests/sql/instagram_inbox.sql'),
  'ROLLBACK;',
].join('\n')
execFileSync('docker', ['exec', '-i', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
  input: sql, stdio: ['pipe', 'inherit', 'inherit'], timeout: 60000,
})
