import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const sql = readFileSync(new URL('./sql/037_media_pipeline.sql', import.meta.url), 'utf8')
const checks = readFileSync(new URL('./sql/_selftest/037_media_pipeline_selftest.sql', import.meta.url), 'utf8')
const result = spawnSync('docker', ['exec', '-i', 'supabase-db', 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
  input: `begin;\nset local asher.allow_db_tests = '1';\n${sql}\n${checks}\nrollback;\n`,
  encoding: 'utf8',
})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
