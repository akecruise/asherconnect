/**
 * create-meta-reviewer.mjs — เตรียมบัญชีผู้ทดสอบ + test conversation สำหรับ Meta App Review
 *
 * รันบน VPS ที่ /opt/asher-inbox/app (อ่าน SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY จาก .env เอง)
 *
 *   META_REVIEWER_EMAIL=... META_REVIEWER_PASSWORD=... \
 *     node scripts/create-meta-reviewer.mjs --docker supabase-db
 *   node scripts/create-meta-reviewer.mjs --docker supabase-db --seed-only   # สร้างเฉพาะ test conversation
 *
 * ทำอะไร:
 *   1. seed test contact + conversation (is_test = true) + ข้อความตัวอย่าง — idempotent
 *   2. (ถ้าให้ email/password มา) สร้าง/อัปเดตบัญชี reviewer ผ่าน GoTrue admin API
 *      แล้วตั้ง core.profile: role='sales', test_only=true
 *
 * ★ ไม่พิมพ์ password/token/secret ออกทาง log แม้แต่ตัวเดียว (mask เป็น **** เสมอ)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = dirname(HERE)
const argv = process.argv.slice(2)
const DOCKER = argv[argv.indexOf('--docker') + 1] ?? null
if (!DOCKER) { console.error('ต้องระบุ --docker <container>'); process.exit(1) }
const SEED_ONLY = argv.includes('--seed-only')

const EMAIL = process.env.META_REVIEWER_EMAIL ?? null
const PASSWORD = process.env.META_REVIEWER_PASSWORD ?? null
const PSID = process.env.META_REVIEWER_PSID ?? 'meta-reviewer-seed'
const BASE = process.env.CONNECT_PUBLIC_URL ?? 'https://inbox.apluscondo.com'
if (!SEED_ONLY && (!EMAIL || !PASSWORD)) {
  console.error('ต้องมี META_REVIEWER_EMAIL + META_REVIEWER_PASSWORD (หรือใช้ --seed-only เพื่อ seed อย่างเดียว)')
  process.exit(1)
}
const mask = v => (v ? `****(${v.length} ตัวอักษร)` : '(ไม่มี)')

// .env ของแอป — อ่านเฉพาะค่าที่ต้องใช้ ห้ามพิมพ์ค่าอื่น
let SUPABASE_URL = process.env.SUPABASE_URL ?? null
let SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null
try {
  const env = readFileSync(join(APP, '.env'), 'utf8')
  for (const line of env.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line)
    if (!m) continue
    if (m[1] === 'SUPABASE_URL' && !SUPABASE_URL) SUPABASE_URL = m[2]
    if (m[1] === 'SUPABASE_SERVICE_ROLE_KEY' && !SERVICE) SERVICE = m[2]
  }
} catch { /* รันจากที่ไม่มี .env — ต้องยิง env เอง */ }
if (!SEED_ONLY && (!SUPABASE_URL || !SERVICE)) {
  console.error('ไม่พบ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (อ่านจาก .env ในโฟลเดอร์แอป) — ยกเลิกการสร้างบัญชี')
  process.exit(1)
}

const psql = sql => execFileSync('docker', ['exec', '-i', DOCKER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim()
const esc = s => s.replace(/'/g, "''")

// ── 1) seed test conversation ────────────────────────────────────────
const inboxId = psql(`select id from inbox.inbox where channel='messenger' and is_active order by created_at limit 1`)
if (!inboxId) { console.error('ไม่พบ channel messenger ที่เปิดใช้งาน'); process.exit(1) }

const contactId = psql(`
with c as (
  insert into core.contact(id, display_name, picture_url, profile_fetched_at, profile_status)
  select gen_random_uuid(), 'Meta Reviewer (ทดสอบ)', '${BASE}/meta-reviewer-avatar.png', now(), 'ok'
  where not exists (select 1 from core.contact_identity ci where ci.channel='messenger' and ci.external_id='${esc(PSID)}')
  returning id
), existing as (
  select ci.contact_id as id from core.contact_identity ci where ci.channel='messenger' and ci.external_id='${esc(PSID)}'
)
select id from existing union all select id from c limit 1`)
psql(`insert into core.contact_identity(contact_id, channel, external_id, account_key)
  values ('${contactId}','messenger','${esc(PSID)}','${inboxId}')
  on conflict do nothing`)
psql(`update core.contact set display_name='Meta Reviewer (ทดสอบ)', picture_url='${BASE}/meta-reviewer-avatar.png',
      profile_fetched_at=coalesce(profile_fetched_at, now()), profile_status=coalesce(profile_status,'ok') where id='${contactId}'`)

const convId = psql(`
with c as (
  insert into inbox.conversation(id, inbox_id, contact_id, status, is_test, last_message_at, last_message_preview, unread_count)
  select gen_random_uuid(), '${inboxId}', '${contactId}', 'open', true, now(), 'ข้อความทดสอบ Meta review', 0
  where not exists (select 1 from inbox.conversation cc join core.contact ct on ct.id=cc.contact_id
                     where cc.is_test and ct.display_name like 'Meta Reviewer%')
  returning id
), existing as (
  select cc.id from inbox.conversation cc join core.contact ct on ct.id=cc.contact_id
   where cc.is_test and ct.display_name like 'Meta Reviewer%' order by cc.last_message_at desc nulls last limit 1
)
select id from existing union all select id from c limit 1`)
psql(`insert into inbox.message(conversation_id, sender_type, content, created_at)
  select '${convId}','contact','สวัสดี — ข้อความทดสอบสำหรับ Meta App Review', now() - interval '3 minutes'
  where not exists (select 1 from inbox.message where conversation_id='${convId}')`)
console.log('SEED OK')
console.log('  test_conversation_id = ' + convId)
console.log('  contact_id           = ' + contactId)
console.log('  is_test              = true')

// ── 2) บัญชี reviewer ผ่าน GoTrue admin ──────────────────────────────
if (SEED_ONLY) { console.log('(--seed-only — ข้ามการสร้างบัญชี)'); process.exit(0) }

const create = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { purpose: 'meta_app_review' } }),
}).then(r => r.json().then(b => ({ status: r.status, body: b }))).catch(e => ({ status: 0, body: { msg: e.message } }))

let userId = create.body?.id ?? null
if (create.status === 200 || create.status === 201) console.log('สร้างบัญชี GoTrue ใหม่ · user_id = ' + userId)
else if (create.status === 422) {
  console.log('บัญชีมีอยู่แล้ว (422) — ค้นหา user id ตามอีเมล')
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(EMAIL)}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  }).then(r => r.json())
  userId = list?.users?.find(u => u.email?.toLowerCase() === EMAIL.toLowerCase())?.id ?? null
  if (!userId) { console.error('พบบัญชีซ้ำแต่หา user id ไม่เจอ — หยุด'); process.exit(1) }
  // อัปเดตรหัสสำรองให้ตรงกับที่ระบุมา (idempotent — reviewer ใช้รหัสชุดเดียวเสมอ)
  const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, email_confirm: true }),
  })
  console.log('อัปเดตรหัสผ่านบัญชีเดิม: ' + (upd.ok ? 'สำเร็จ' : 'ล้มเหลว ' + upd.status))
} else {
  console.error('สร้างบัญชีไม่สำเร็จ: HTTP ' + create.status + ' ' + String(create.body?.msg ?? create.body?.error ?? '').slice(0, 120))
  process.exit(1)
}

// core."user" mirror + profile (test_only)
const mirrored = psql(`select count(*) from core."user" where id='${userId}'`)
if (mirrored === '0') psql(`insert into core."user"(id, email) values ('${userId}','${esc(EMAIL)}')`)
psql(`insert into core.profile(user_id, role, is_active, test_only)
  values ('${userId}','sales',true,true)
  on conflict (user_id) do update set role='sales', is_active=true, test_only=true`)
console.log('PROFILE OK — role=sales · test_only=true')
console.log('\nเสร็จ — ล็อกอินที่ ' + BASE + ' ด้วยบัญชี reviewer แล้วหน้า Inbox ต้องเห็นเฉพาะเคสทดสอบ')
console.log('credentials: แสดงใน App Review form เท่านั้น (' + mask(EMAIL) + ' / ' + mask(PASSWORD) + ')')
