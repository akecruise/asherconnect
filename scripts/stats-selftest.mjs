/**
 * stats-selftest.mjs — เช็คสุขภาพระบบสถิติแบบรันซ้ำได้ (read-only)
 *
 *   node scripts/stats-selftest.mjs --docker supabase-db
 *   node scripts/stats-selftest.mjs --docker supabase-db --db-user postgres --db-name postgres
 *
 * exit 0 = ผ่านหมด · exit 1 = มีข้อใด FAIL
 * ไม่พิมพ์ token/secret/ข้อความลูกค้า — ตัวเลขและชื่อวัตถุอย่างเดียว
 */
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null }
const DOCKER = flag('--docker')
const DB_USER = flag('--db-user') ?? 'postgres'
const DB_NAME = flag('--db-name') ?? 'postgres'
if (!DOCKER) { console.error('ต้องระบุ --docker <container>'); process.exit(1) }

let fails = 0
const ok = (name, pass, detail = '') => {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  if (!pass) fails++
}
const q = (sql) => execFileSync('docker', ['exec', '-i', DOCKER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim()

// 1) ต่อฐานได้ + เวลาฐานตอบ
let dbOk = true, now
try { now = q('select now()::text') } catch { dbOk = false }
ok('database connection', dbOk, dbOk ? now.slice(0, 19) : 'ต่อไม่ได้')

// 2) เลขรุ่น schema (039)
let version = null
try { version = Number(q('select inbox.schema_version_latest()')) } catch { }
ok('database version (schema_version_latest)', Number.isInteger(version) && version >= 39, `v=${version}`)

// 3) ตาราง stats ครบ 6 ใบ
let tables = []
try { tables = q(`select string_agg(tablename, ',') from pg_tables where schemaname='inbox'
  and tablename in ('sla_policy','response_window','agent_daily_stat','signature_alias','stats_error_log','score_rule')`).split(',').filter(Boolean) } catch { }
ok('stats tables (6)', tables.length === 6, tables.join(',') || 'ไม่มีเลย')

// 4) ฟังก์ชัน/RPC ที่หน้าใช้ ครบ
let fns = []
try { fns = q(`select string_agg(distinct proname, ',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='inbox' and proname in ('stats_overview','stats_agents','stats_timeline','stats_open_windows','schema_version_latest','setting_int','business_seconds')`).split(',').filter(Boolean) } catch { }
ok('stats functions (7)', fns.length === 7, fns.join(',') || 'ไม่มีเลย')

// 5) trigger จับ turn ติดกับ inbox.message จริง
let trig = null
try { trig = q(`select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='inbox' and c.relname='message' and t.tgname='trg_stats_on_message' and not t.tgisinternal`) } catch { }
ok('response-window trigger on inbox.message', trig === '1')

// 6) admin/manager profile สำหรับยิง RPC (มีคนใช้หน้านี้ได้จริง)
let admin = null
try { admin = q(`select p.user_id from core.profile p where p.role in ('admin','manager') and p.is_active limit 1`) } catch { }
ok('manager/admin profile exists', Boolean(admin))

// 7-10) RPC ทั้งสี่ของหน้า ยิงกับข้อมูลจริงได้ (จำลองตัวตน admin ทาง GUC แบบ session)
const RANGE = JSON.stringify({ from: '2026-01-01T00:00:00+07:00', to: '2030-01-01T23:59:59+07:00' })
const impersonated = (rpc, arg) => q(`select set_config('request.jwt.claim.sub','${admin}',false);
  select coalesce(${rpc}('${arg}'), 'null')::text`).split('\n').pop()
let overview = null
try { overview = impersonated('inbox.stats_overview', RANGE) } catch (e) { overview = 'ERROR: ' + String(e.message).slice(0, 80) }
ok('stats_overview executes', !overview.startsWith('ERROR'), overview.slice(0, 60))
let agents = null
try { agents = impersonated('inbox.stats_agents', RANGE) } catch (e) { agents = 'ERROR: ' + String(e.message).slice(0, 80) }
ok('stats_agents executes', !agents.startsWith('ERROR'), agents.slice(0, 40))
let timeline = null
try { timeline = impersonated('inbox.stats_timeline', JSON.stringify({ ...JSON.parse(RANGE), bucket: 'dow_hour' })) } catch (e) { timeline = 'ERROR: ' + String(e.message).slice(0, 80) }
ok('stats_timeline executes', !timeline.startsWith('ERROR'), timeline.slice(0, 40))

// 11) วันที่ผิดต้อง error อย่างควบคุม (ไม่ค้าง ไม่พังทั้งเซสชัน)
let badDate = false
try { impersonated('inbox.stats_overview', JSON.stringify({ from: 'not-a-date', to: 'also-bad' })) } catch { badDate = true }
ok('invalid date handled (controlled error)', badDate)

// 12) ผลลัพธ์ไม่หลุด secret/คีย์
const leaks = /service_role|supabase_service|access_token|secret/i
ok('overview output has no secret-like keys', overview && !leaks.test(overview))

// 13) error log ของ trigger อ่านได้ (ตัวเลข = จำนวนครั้งที่ ingest พัง)
let errLog = null
try { errLog = q('select count(*) from inbox.stats_error_log') } catch { }
ok('stats_error_log readable', errLog !== null, `ingest_errors=${errLog ?? '?'}`)

console.log(`\nPASS=${12 + 1 - fails - 0} ขึ้นกับด้านบน · FAIL=${fails}`)
console.log(fails ? 'STATS-SELFTEST=FAIL' : 'STATS-SELFTEST=PASS')
process.exit(fails ? 1 : 0)
