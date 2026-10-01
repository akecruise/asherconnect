/**
 * meta-review-preflight.mjs — ตรวจความพร้อมก่อนส่ง Meta App Review
 *
 *   node scripts/meta-review-preflight.mjs --docker supabase-db [--base https://inbox.apluscondo.com]
 *
 * env (ไม่บังคับ): META_REVIEWER_EMAIL / META_REVIEWER_PASSWORD → เช็ค login จริง
 *                  ALLOW_META_REVIEW_LIVE_TEST=true → ยังไม่ใช้ (สคริปต์นี้ไม่ส่งข้อความหาลูกค้าเด็ดขาด)
 * exit 0 = READY FOR MANUAL META DASHBOARD CHECK · exit 1 = NOT READY
 * ไม่พิมพ์ token/secret/password — ทุกค่าที่อาจเป็นความลับถูก mask
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = dirname(HERE)
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d }
const DOCKER = flag('--docker')
if (!DOCKER) { console.error('ต้องระบุ --docker <container>'); process.exit(1) }

const env = {}
try { for (const l of readFileSync(join(APP, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(l); if (m) env[m[1]] = m[2] } } catch { }
const BASE = flag('--base') ?? env.CONNECT_PUBLIC_URL ?? 'https://inbox.apluscondo.com'
const EMAIL = process.env.META_REVIEWER_EMAIL ?? null
const PASSWORD = process.env.META_REVIEWER_PASSWORD ?? null
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? null
const mask = v => (v ? '****' : '-')

let pass = 0, fail = 0, warn = 0
const line = (icon, name, detail = '') => { console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`) }
const P = (n, d) => { pass++; line('✅', n, d) }
const F = (n, d) => { fail++; line('❌', n, d) }
const W = (n, d) => { warn++; line('⚠️ ', n, d) }
const q = sql => execFileSync('docker', ['exec', '-i', DOCKER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim()

console.log('META REVIEW PRE-SUBMIT\n======================\n')

// ── [PUBLIC] ─────────────────────────────────────────────────────────
let privacy = ''
try { const r = await fetch(`${BASE}/privacy`); privacy = r.ok ? await r.text() : `HTTP ${r.status}` } catch (e) { privacy = 'ERROR: ' + e.message }
privacy.startsWith('HTTP') ? F('Privacy Policy URL 200', privacy) : P('Privacy Policy URL 200', BASE + '/privacy');
privacy.includes('id="data-deletion"') ? P('Data Deletion anchor (#data-deletion) มีในหน้า') : F('Data Deletion anchor หายไปจากหน้า privacy');
const placeholder = /(REPLACE|TODO|example\.com|ใส่อีเมลจริง|Lorem ipsum)/i
placeholder.test(privacy) ? F('privacy page ไม่มี placeholder', 'เจอคำ placeholder ในหน้า') : P('privacy page ไม่มี placeholder');
const deletionVisible = /Data Deletion|ขอลบข้อมูล/.test(privacy)
deletionVisible ? P('หัวข้อวิธีขอลบข้อมูล แสดงบนหน้า') : F('ไม่พบหัวข้อ Data Deletion')

// ── [AUTH] ───────────────────────────────────────────────────────────
let reviewer = null
try { reviewer = q(`select p.user_id::text || '|' || p.role || '|' || p.test_only
  from core.profile p join core."user" u on u.id = p.user_id
  where p.test_only and p.is_active
    and (${EMAIL ? `lower(u.email) = lower('${EMAIL.replace(/'/g, "''")}')"` : 'true'})
  limit 1`) || null } catch { }
reviewer ? P('มีบัญชี test_only reviewer', reviewer.split('|')[1] + ' · test_only=true') : (EMAIL ? F('ไม่พบ reviewer account ตามอีเมลที่ให้') : W('ยังไม่ได้สร้าง reviewer account — รัน scripts/create-meta-reviewer.mjs'))
if (EMAIL && PASSWORD && reviewer) {
  let loginOk = false
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY ?? SERVICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    loginOk = r.ok
  } catch { }
  loginOk ? P('reviewer login ใช้ได้จริง (GoTrue)') : F('reviewer login ไม่ผ่าน — ตรวจ email/password หรือสร้างบัญชีใหม่')
} else W('ข้ามการทดสอบ login (ไม่ได้ให้ META_REVIEWER_EMAIL/PASSWORD มา)')

// ── [ISOLATION] — รัน selftest 040 บนฐานจริง ─────────────────────────
let iso = 1
try {
  execFileSync('docker', ['exec', '-i', DOCKER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', "select set_config('asher.allow_db_tests','1',false)"], { stdio: 'ignore' })
  execFileSync('docker', ['exec', '-i', DOCKER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: "select set_config('asher.allow_db_tests','1',false);\n" +
        readFileSync(join(APP, 'sql', '_selftest', '040_meta_review_isolation_selftest.sql'), 'utf8') + '\nrollback;\n', stdio: ['pipe', 'ignore', 'pipe'] })
  iso = 0
} catch (e) { console.error(String(e.stderr ?? '').slice(0, 200)) }
iso === 0 ? P('isolation selftest (TEST1–7 + queue) ผ่านบนฐานจริง') : F('isolation selftest ไม่ผ่าน — ห้าม deploy ต่อ')

// ── [MESSENGER] ──────────────────────────────────────────────────────
let messenger = null
try {
  // อ่าน channels.json จาก container แอป (ตัวเดียวที่มี node + env CONNECT_CHANNELS_FILE)
  messenger = JSON.parse(execFileSync('docker', ['exec', process.env.APP_CONTAINER ?? 'asher-connect', 'node', '-e',
    'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.env.CONNECT_CHANNELS_FILE,"utf8"));const l=Array.isArray(c)?c:(c.channels||[]);const m=l.find(x=>x.channel==="messenger");console.log(JSON.stringify({enabled:m?.enabled===true,hasToken:Boolean(m?.access_token)}))']),
    { encoding: 'utf8' })
} catch { }
messenger?.enabled ? P('Messenger channel configured + enabled') : F('Messenger channel ยังไม่เปิดใช้งาน')
let healthOk = false
try { healthOk = JSON.parse(await (await fetch('http://127.0.0.1:3200/health')).text()).ok === true } catch { }
healthOk ? P('webhook/app health ปกติ (/health ok:true)') : F('/health ไม่ปกติ')
let seed = null
try { seed = q(`select coalesce(picture_url,''), coalesce(profile_status,''), profile_fetched_at is not null,
  coalesce(display_name,'') from core.contact where display_name like 'Meta Reviewer%' limit 1`).split('|') } catch { }
seed?.[3] ? P('test contact มี display name', seed[3]) : W('ยังไม่มี test contact — รัน scripts/create-meta-reviewer.mjs')
seed?.[0] ? P('test contact มี picture/avatar URL') : W('test contact ยังไม่มีรูปโปรไฟล์')
seed?.[2] ? P('profile_fetched_at มีค่า') : W('profile_fetched_at ยังว่าง')

// ── [SECRETS] ────────────────────────────────────────────────────────
const secretNeedles = [SERVICE, PASSWORD, process.env.META_REVIEWER_PASSWORD].filter(Boolean)
const scanDirs = [join(APP, 'docs', 'meta-review'), join(APP, 'public'), join(APP, 'reports')]
let leaked = null
for (const dir of scanDirs) {
  let files = []
  try { files = readdirSync(dir, { recursive: true }).filter(f => /\.(md|html|js|mjs|txt)$/i.test(f)) } catch { }
  for (const f of files) {
    const content = readFileSync(join(dir, f), 'utf8')
    for (const needle of secretNeedles) if (needle.length > 8 && content.includes(needle)) leaked = join(dir, f)
  }
}
leaked ? F('พบ secret หลุดในไฟล์: ' + leaked) : P('ไม่มี secret/password หลุดใน docs/pages/reports')

console.log(`\nMETA REVIEW PRE-SUBMIT\n======================\nPASS: ${pass}\nFAIL: ${fail}\nWARN: ${warn}\n`)
console.log(fail ? 'overall = NOT READY' : 'overall = READY FOR MANUAL META DASHBOARD CHECK')
process.exit(fail ? 1 : 0)
