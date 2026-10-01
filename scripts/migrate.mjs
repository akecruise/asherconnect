/**
 * migrate.mjs — backup → apply → รายงาน
 *
 * ตัว apply จริงคือ sql/run.mjs (ทะเบียน inbox.sql_applied + sha256 + ลำดับ
 * ORDER.txt) ไฟล์นี้มีหน้าที่เดียวที่ run.mjs ไม่ทำ: **dump ฐานก่อนแตะทุกครั้ง**
 * เพราะกติกาบ้านนี้คือ migration ทุกครั้งต้องมีทางถอยที่จับต้องได้
 *
 *   node scripts/migrate.mjs --db "<connection string>"
 *   node scripts/migrate.mjs --docker supabase-db                # บน VPS ที่ psql อยู่ใน container
 *   node scripts/migrate.mjs --docker supabase-db --only 016,017,018,019,027
 *
 * options
 *   --only <เลขหรือชื่อไฟล์ คั่นด้วย ,>   ส่งต่อให้ sql/run.mjs apply (รันเฉพาะที่สั่ง)
 *   --schema-only                          dump เฉพาะโครงสร้าง (default: ข้อมูลด้วย)
 *   --out <dir>                            ที่เก็บ backup (default: backups/ ข้าง repo)
 *   --db-user / --db-name                  ใช้คู่กับ --docker (default: postgres/postgres)
 *
 * ไฟล์ backup ไม่เคยถูกลบอัตโนมัติ — rollback ด้วย psql กลับจากไฟล์นี้ หรือ
 * แก้เฉพาะจุดตามที่ migration ล่าสุดทำ แล้วรัน node sql/run.mjs plan เทียบอีกครั้ง
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i > -1 ? argv[i + 1] : null
}

const DOCKER = flag('--docker')
const DB_URL = flag('--db') ?? process.env.DATABASE_URL ?? null
const ONLY = flag('--only')
const OUT = flag('--out') ?? join(HERE, 'backups')
const SCHEMA_ONLY = argv.includes('--schema-only')
const DB_USER = flag('--db-user') ?? 'postgres'
const DB_NAME = flag('--db-name') ?? 'postgres'

if (!DOCKER && !DB_URL) {
  console.error('ต้องระบุ --db "<connection string>" หรือ --docker <container>')
  process.exit(1)
}

// ── 1) ตรวจลำดับ/ไฟล์ก่อนแตะฐาน (ไม่ต่อฐาน) ──────────────────────────
const check = spawnSync(process.execPath, [join(HERE, 'sql', 'run.mjs'), 'check'], { stdio: 'inherit' })
if (check.status !== 0) {
  console.error('\nหยุด — sql/ ยังไม่สม่ำเสมอ แก้ก่อนแล้วรันใหม่')
  process.exit(check.status ?? 1)
}

// ── 2) backup ────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupPath = join(OUT, `backup-${stamp}${SCHEMA_ONLY ? '.schema' : ''}.sql`)
const dumpArgs = DOCKER
  ? ['exec', DOCKER, 'pg_dump', '-U', DB_USER, '-d', DB_NAME, ...(SCHEMA_ONLY ? ['--schema-only'] : [])]
  : ['pg_dump', ...(SCHEMA_ONLY ? ['--schema-only'] : []), DB_URL]

process.stdout.write('backup → ' + backupPath + ' ... ')
const fd = openSync(backupPath, 'w')
const dump = spawnSync(DOCKER ? 'docker' : 'pg_dump', dumpArgs, { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' })
closeSync(fd)
if (dump.status !== 0) {
  console.error('ล้มเหลว')
  if (dump.stderr) console.error(dump.stderr)
  console.error('\nหยุด — ไม่ dump ได้ = ไม่ migrate (กติกาบ้านนี้)')
  process.exit(dump.status ?? 1)
}
console.log('ได้ไฟล์ ' + Math.round(statSync(backupPath).size / 1024) + ' KB')

// ── 3) apply ผ่าน sql/run.mjs ────────────────────────────────────────
const applyArgs = [join(HERE, 'sql', 'run.mjs'), 'apply']
if (DOCKER) {
  applyArgs.push('--docker', DOCKER, '--db-user', DB_USER, '--db-name', DB_NAME)
} else {
  applyArgs.push('--db', DB_URL)
}
if (ONLY) applyArgs.push('--only', ONLY)

console.log('')
const apply = spawnSync(process.execPath, applyArgs, { stdio: 'inherit' })
if (apply.status !== 0) {
  console.error('\napply ไม่ครบ — ไฟล์ที่ผ่านแล้วถูกบันทึกทะเบียนไว้ แก้จุดที่พังแล้วรันซ้ำได้เลย')
  console.error('ถ้าต้องถอย: ฐานก่อน migrate อยู่ที่ ' + backupPath)
  process.exit(apply.status ?? 1)
}

console.log('\nเสร็จ · backup อยู่ที่ ' + backupPath)
console.log('ตรวจซ้ำได้: node sql/run.mjs plan ' + (DOCKER ? '--docker ' + DOCKER : '--db "<url>"'))
