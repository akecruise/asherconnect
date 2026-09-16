/**
 * รันชุดทดสอบชั้น stats บน PostgreSQL 16 ที่ยกขึ้นมาชั่วคราว
 *
 *   npm run test:stats
 *
 * ทำไมต้องยก container ใหม่แทนที่จะใช้ฐานของโปรเจกต์:
 * ชุดนี้ truncate ตารางของตัวเองทุกครั้ง ถ้าเผลอชี้ไปฐานจริงจะล้างของจริงทิ้ง
 * จึงบังคับให้รันบนฐานเปล่าที่สร้างแล้วลบทิ้งทุกครั้ง ไม่มีทางไปโดนของใครได้
 *
 * ★ tests/stats/00_stubs.sql เป็นโครงที่คัดมาจาก information_schema ของฐานจริง
 *   ไม่ใช่โครงที่คิดขึ้นเอง — ถ้าวันหนึ่ง inbox.message เปลี่ยนคอลัมน์
 *   ต้องแก้ไฟล์นั้นตามด้วย ไม่งั้นเทสต์จะเขียวทั้งที่ของจริงพัง
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const NAME = 'stats-test'
const MIGRATIONS = ['016_stats_schema', '017_stats_functions', '018_stats_api', '019_stats_seed_cron',
                    '020_capture_layer', '021_outbox',
                    // ★ 023 ต้องมาก่อน 027 — 027 อ่าน inbox.settings กับ setting_int/setting_time จาก 023
                    //   และใช้ sla_elapsed_minutes() ของ 023 ใน stats_open_windows
                    '023_sla_case_status', '027_stats_v2']
// ★ ลำดับห้ามสลับ: 021 นิยาม purge_channel_events ทับของ 020 โดยตั้งใจ (ชื่อและลายเซ็นเดียวกัน)
//   ถ้าลง 021 ก่อน 020 จะได้ตัวที่ไม่อ่าน retention_policy แล้วไม่มีอะไรฟ้อง
// ★ 04 ต้องรันก่อน 01 — 01_scenario จบด้วย commit และมัน delete+insert
//   inbox.sla_policy เป็น 09:00-20:00 ของตัวเอง ทับค่าที่ 027 ตั้งไว้
//   ถ้าให้ 04 รันทีหลัง มันจะวัดนโยบายของเทสต์ก่อนหน้า ไม่ใช่ของ 027
//   (04 ปิดท้ายด้วย rollback จึงไม่ทิ้งร่องรอยให้ชุดอื่น)
const SCENARIOS = ['04_stats_v2.sql', '01_scenario.sql', '03_outbox.sql']

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts })
const quiet = (cmd, args) => { try { return run(cmd, args, { stdio: 'pipe' }) } catch { return '' } }

quiet('docker', ['rm', '-f', NAME])
try {
  run('docker', ['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=x', '-e', 'POSTGRES_DB=stats', 'postgres:16'], { stdio: 'pipe' })
} catch (e) {
  console.error('ยก postgres:16 ไม่ขึ้น — Docker เปิดอยู่หรือเปล่า\n' + e.message)
  process.exit(1)
}

try {
  // ★ image ของ postgres เปิดเซิร์ฟเวอร์ชั่วคราวตอน initdb แล้ว "ปิดลง" ก่อนเปิดจริง
  //   ถ้าเช็คแค่ pg_isready จะผ่านตั้งแต่ตัวชั่วคราว แล้วคำสั่งถัดไปจะชนตอนมันกำลังปิด
  //   ("the database system is shutting down") จึงต้องรอให้ init จบก่อน แล้วค่อยเช็คว่าต่อได้
  const nap = ms => execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`])
  let ready = false
  for (let i = 0; i < 60; i++) {
    const logs = quiet('docker', ['logs', NAME])
    if (logs.includes('PostgreSQL init process complete')) {
      try { run('docker', ['exec', NAME, 'psql', '-U', 'postgres', '-d', 'stats', '-tAc', 'select 1'], { stdio: 'pipe' }); ready = true; break }
      catch { /* เพิ่งเปิดใหม่ ยังไม่รับ */ }
    }
    nap(1000)
  }
  if (!ready) throw new Error('ฐานไม่พร้อมใน 60 วินาที')

  run('docker', ['cp', join(ROOT, 'sql'), `${NAME}:/sql`], { stdio: 'pipe' })
  run('docker', ['cp', HERE, `${NAME}:/t`], { stdio: 'pipe' })

  const psql = ['exec', NAME, 'psql', '-U', 'postgres', '-d', 'stats', '-q']
  run('docker', [...psql, '-v', 'ON_ERROR_STOP=1',
    '-f', '/t/00_stubs.sql', ...MIGRATIONS.flatMap(m => ['-f', `/sql/${m}.sql`])], { stdio: 'pipe' })

  // psql ส่ง RAISE NOTICE ออกทาง stderr — ผลเทสต์ทั้งหมดอยู่ในนั้น ไม่ใช่ stdout
  const lines = []
  for (const file of SCENARIOS) {
    const out = run('docker', ['exec', NAME, 'bash', '-c',
      `psql -U postgres -d stats -q -f /t/${file} 2>&1`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const got = (out + '').split(/\r?\n/).filter(l => /PASS|FAIL/.test(l))
      .map(l => l.replace(/^psql:\S+\s+/, '').replace(/^NOTICE:\s+/, ''))
    console.log(`\n── ${file}`)
    for (const l of got) console.log(l)
    lines.push(...got)
  }

  const failed = lines.filter(l => l.startsWith('FAIL')).length
  console.log(`\n${lines.length - failed} ผ่าน · ${failed} ตก · ทั้งหมด ${lines.length} ข้อ`)
  process.exitCode = failed ? 1 : 0
} catch (e) {
  console.error(e.stderr || e.message)
  process.exitCode = 1
} finally {
  quiet('docker', ['rm', '-f', NAME])
}
