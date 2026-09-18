// ชุดทดสอบระดับ HTTP ของ ASHER Connect
//
//   npm test --prefix ../asher-connect        (จาก asher-web: npm run test:webhook)
//
// ต่างจาก providers.test.mjs ตรงที่ชุดนั้นทดสอบฟังก์ชันล้วน ๆ
// ส่วนชุดนี้ยกเซิร์ฟเวอร์จริงขึ้นมาแล้วยิงเข้าไปตามเส้นทางเดียวกับที่ LINE/Meta และเบราว์เซอร์ใช้
// จึงครอบของที่ฟังก์ชันเดี่ยว ๆ ไม่เห็น: ลายเซ็นบนสายจริง · ด่านต้นทางของคำขอ · lease ของ worker
//
// ★ ยกจาก server.mjs ในโฟลเดอร์นี้ตรง ๆ ไม่ผ่าน docker image
//   เทสต์จึงเห็นโค้ดที่เพิ่งแก้เสมอ ไม่ใช่ image ที่ build ไว้เมื่อวาน
//
// ★ ชุดนี้เขียนลงฐานจริง (ไม่มี transaction ให้ rollback เพราะคุยผ่าน HTTP)
//   ของทุกชิ้นติดป้าย __httptest__ และถูกลบตอนจบเสมอ แม้เทสต์จะล้มกลางคัน

import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { createHmac, createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const PORT = Number(process.env.HTTP_TEST_PORT || 3299)
const BASE = `http://127.0.0.1:${PORT}`
const TAG = '__httptest__'
const LINE_SECRET = 'secret-line-' + randomUUID()
const META_SECRET = 'secret-meta-' + randomUUID()
const PAGE_ID = '100000000000001'
const VERIFY_TOKEN = 'verify-' + randomUUID()

// บัญชีที่เซิร์ฟเวอร์ในเทสต์ทุกตัวทำงานในนามของมัน — ตั้งค่าใน main() ก่อนยกตัวแรก
let account = null
const results = []
const ck = (no, name, ok, detail = '') => { results.push({ no, name, ok: !!ok, detail }); return !!ok }
const sign = (raw, secret, enc) => createHmac('sha256', secret).update(raw).digest(enc)

/**
 * รอให้คิวขาเข้าว่าง
 *
 * webhook ตอบ 200 ตั้งแต่ตอนเก็บของดิบ งานจริงเกิดทีหลังในรอบของ worker (ทุก 3 วินาที)
 * เทสต์ที่ยิง webhook แล้วอ่านฐานทันทีจึงเห็นของก่อนที่มันจะถูกทำ — ต้องรอตรงนี้
 * รอแบบดูสถานะจริง ไม่ใช่ sleep เผื่อ ๆ ไว้ เพราะเวลาที่ใช้ต่างกันทุกรอบ
 */
async function settle(timeout = 30000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const left = await one(`select count(*) from connect_private.webhook_log
                             where channel_key in ('line-test','fb-test') and status in ('pending','processing')`)
    if (Number(left) === 0) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

// ── คุยกับฐานผ่าน container เพื่อไม่ต้องมี pg client บนเครื่อง
async function sql(text) {
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', text], { maxBuffer: 8 << 20 })
  return stdout.trim().split('\n').filter(Boolean).map(line => line.split('|'))
}
const one = async text => (await sql(text))[0]?.[0] ?? null

// connect_private.worker ดูสิทธิ์จาก request.jwt.claims ที่ PostgREST เป็นคนใส่ให้
// เรียกผ่าน psql จึงต้องสวม claim เองในธุรกรรมเดียวกัน ไม่งั้นตกด่าน service_only ทุกครั้ง
// (ถ้าลืม แล้วเทสต์ดักด้วย catch ไว้ ผลที่ได้คือเทสต์ผ่านโดยไม่ได้ทดสอบอะไรเลย)
const asService = body => `begin; set local request.jwt.claims = '{"role":"service_role"}'; ${body} commit;`

async function env() {
  const raw = await readFile(join(root, '.env'), 'utf8')
  const map = Object.fromEntries(raw.split(/\r?\n/).filter(l => l.includes('=')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }))
  if (!map.SUPABASE_ANON_KEY || !map.SUPABASE_SERVICE_ROLE_KEY) throw new Error('asher-connect/.env ไม่มีคีย์ Supabase')
  return map
}

async function testUser(prefix = 'sales.a.test@') {
  const raw = await readFile(join(root, '..', '.asher-test-users'), 'utf8')
  const line = raw.split(/\r?\n/).find(l => l.startsWith(prefix))
  if (!line) throw new Error(`ไม่พบบัญชีทดสอบ ${prefix} — รัน node scripts/seed-test-users.mjs --apply ก่อน`)
  const [email, password] = line.split('|')
  return { email, password }
}

// ────────────────────────────────── เตรียมฉากในฐาน
async function setup() {
  const project = await one(`select id from core.project where code='asher-naii'`)
  if (!project) throw new Error('ไม่พบโครงการ asher-naii')

  const lineInbox = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
    values('line','${project}','LINE ${TAG}','TEST_ONLY',true) returning id`)
  const fbInbox = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
    values('messenger','${project}','Messenger ${TAG}','TEST_ONLY',true) returning id`)

  const agent = await one(`select id from auth.users where email='sales.a.test@asher.local'`)
  const contact = await one(`select core.resolve_identity('line','U-${TAG}','${lineInbox}','ลูกค้า ${TAG}','${project}')`)
  const conv = await one(`insert into inbox.conversation(inbox_id,contact_id,assignee_id,status)
    values('${lineInbox}','${contact}','${agent}','open') returning id`)
  await sql(`insert into inbox.message(conversation_id,sender_type,content,external_message_id)
    values('${conv}','contact','ทักมาจากเทสต์ HTTP','${TAG}-in-1')`)
  await sql(`select connect_private.ensure_lead('${conv}')`)

  return { project, lineInbox, fbInbox, agent, contact, conv }
}

async function teardown(scene) {
  if (!scene) return
  // ลบจากปลายทางกลับมาต้นทาง ไม่งั้นติด foreign key
  await sql(`
    begin;
    create temp table _c on commit drop as
      select c.id from inbox.conversation c join inbox.inbox i on i.id=c.inbox_id where i.name like '%${TAG}%';
    create temp table _ct on commit drop as
      select distinct contact_id as id from core.contact_identity where external_id like '%${TAG}%';
    create temp table _l on commit drop as
      select id from crm.lead where extra->>'connect_conversation_id' in (select id::text from _c);
    delete from connect_private.delivery d using inbox.message m
      where d.message_id=m.id and m.conversation_id in (select id from _c);
    delete from connect_private.command where conversation_id in (select id from _c);
    delete from connect_private.audit where conversation_id in (select id from _c);
    delete from connect_private.case_state where conversation_id in (select id from _c);
    delete from crm.activity where conversation_id in (select id from _c) or lead_id in (select id from _l);
    delete from core.event_log where entity_id in (select id from _c) or entity_id in (select id from _l);
    delete from inbox.message where conversation_id in (select id from _c);
    delete from inbox.conversation where id in (select id from _c);
    delete from crm.lead where id in (select id from _l);
    delete from core.contact_identity where external_id like '%${TAG}%';
    delete from crm.lead where contact_id in (select id from _ct);
    delete from core.contact where display_name like '%${TAG}%' or id in (select id from _ct);
    delete from inbox.inbox where name like '%${TAG}%';
    delete from connect_private.webhook_log where channel_key in ('line-test','fb-test');
    delete from inbox.sales_staff_identity where external_id like '%${TAG}%';
    delete from inbox.sales_staff where name like '%${TAG}%';
    commit;`)
}

// ────────────────────────────────── ยกเซิร์ฟเวอร์จากซอร์ส
async function startServer(scene, cfg, extraEnv = {}, port = PORT) {
  const base = `http://127.0.0.1:${port}`
  const dir = await mkdtemp(join(tmpdir(), 'connect-http-'))
  const channels = join(dir, 'channels.json')
  await writeFile(channels, JSON.stringify([
    { key: 'line-test', name: 'LINE ทดสอบ', channel: 'line', enabled: true,
      inbox_id: scene.lineInbox, account_id: 'U-bot-destination',
      secret: LINE_SECRET, access_token: 'token-ปลอม' },
    { key: 'fb-test', name: 'Messenger ทดสอบ', channel: 'messenger', enabled: true,
      inbox_id: scene.fbInbox, account_id: PAGE_ID, api_version: 'v23.0',
      secret: META_SECRET, access_token: 'token-ปลอม', verify_token: VERIFY_TOKEN },
  ], null, 2))

  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    env: { ...process.env,
      PORT: String(port),
      CONNECT_PUBLIC_URL: base,
      CONNECT_CHANNELS_FILE: channels,
      // ไม่มีชั้นล็อกอินแล้ว เซิร์ฟเวอร์ทำงานในนามบัญชีนี้ตั้งแต่บูต
      CONNECT_ACCOUNT_EMAIL: account.email,
      CONNECT_ACCOUNT_PASSWORD: account.password,
      // ทะเบียน Edge Function ที่หน้าจอเรียกได้ — ใช้ของจริงที่รันอยู่ในสแตก
      CONNECT_EDGE_FUNCTIONS: 'webhook-receiver',
      // ระบบเช็คสถานะวิ่งเป็นรอบเองและยิงออกนอกเครื่อง (gateway probe ไปที่โดเมนจริง)
      // ชุดทดสอบต้องคุยกับฐานทดสอบเท่านั้น จึงปิดมันตั้งแต่บูต
      CONNECT_HEALTH: 'off',
      // จากบนโฮสต์ต้องเข้าทาง envoy ที่ map ออกมา ไม่ใช่ชื่อภายใน docker
      SUPABASE_URL: process.env.HTTP_TEST_SUPABASE_URL || 'http://127.0.0.1:8055',
      SUPABASE_ANON_KEY: cfg.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: cfg.SUPABASE_SERVICE_ROLE_KEY,
      ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/health')
      if (r.ok) return { child, dir, base, log: () => log }
    } catch { /* ยังไม่ขึ้น */ }
    await new Promise(r => setTimeout(r, 250))
  }
  child.kill()
  throw new Error('เซิร์ฟเวอร์ไม่ขึ้นใน 15 วินาที\n' + log)
}

// ────────────────────────────────── ตัวช่วยยิง
const post = async (path, raw, headers = {}) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw })
  return { status: r.status, body: await r.text(), headers: r.headers }
}
const command = (action, data) => post('/api/command', JSON.stringify({ action, data }), { origin: BASE })

// ล็อกอินรายบุคคล: /api/login คืนคุกกี้ asher_session — สั่งงานทุกอย่างในนามบัญชีนั้นด้วยคุกกี้ใบนี้
// ต่างจากยุค "ไม่มีล็อกอิน" ที่คำสั่งใช้ได้เลย ตอนนี้ทุกคำสั่งต้องมีเซสชันก่อนเสมอ
const login = async (base, creds) => {
  const r = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: base },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  })
  const cookie = /asher_session=[a-f0-9]{64}/.exec(r.headers.get('set-cookie') || '')?.[0] ?? ''
  return { status: r.status, cookie }
}
const commandAs = (cookie, action, data) =>
  post('/api/command', JSON.stringify({ action, data }), { origin: BASE, cookie })

async function main() {
  const cfg = await env()
  const user = await testUser()
  account = user
  let scene, server
  const extraServers = []
  try {
    scene = await setup()
    server = await startServer(scene, cfg)

    const stamp = Date.now()
    const lineBody = (eventId, text) => JSON.stringify({
      destination: 'U-bot-destination',
      events: [{ type: 'message', webhookEventId: eventId, timestamp: stamp,
        source: { type: 'user', userId: `U-${TAG}` },
        message: { id: 'lm-' + eventId, type: 'text', text } }],
    })

    // ── 1-5 ทางเข้า webhook ของ LINE
    {
      const raw = lineBody(`${TAG}-bad`, 'ลายเซ็นผิด')
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': 'ZmFrZQ==' })
      ck(1, 'LINE ลายเซ็นผิดถูกปฏิเสธ', r.status === 401, `HTTP ${r.status}`)
    }
    {
      const raw = JSON.stringify({ destination: 'U-คนอื่น', events: [] })
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      ck(2, 'LINE ยิงผิดบัญชีปลายทางถูกปฏิเสธ', r.status === 400, `HTTP ${r.status}`)
    }
    const eventId = `${TAG}-ok-${stamp}`
    {
      const raw = lineBody(eventId, 'สนใจห้อง 1 นอนครับ')
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      await settle()
      const landed = await one(`select count(*) from inbox.message where external_message_id='${eventId}'`)
      ck(3, 'LINE ข้อความจริงเข้าระบบ', r.status === 200 && r.body.includes('accepted') && Number(landed) === 1,
        `HTTP ${r.status} ${r.body} · ในฐาน ${landed} แถว`)
    }
    {
      // LINE ยิงซ้ำเองเมื่อไม่ได้ 200 ภายในเวลา — ห้ามกลายเป็นข้อความสองข้อความ
      const raw = lineBody(eventId, 'สนใจห้อง 1 นอนครับ')
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      await settle()
      // นับด้วย event_id ไม่ใช่เนื้อความ — ในฐานมีข้อความจริงที่เนื้อความชนกันได้
      const n = await one(`select count(*) from inbox.message where external_message_id='${eventId}'`)
      ck(4, 'LINE ยิง event เดิมซ้ำ ไม่เกิดข้อความซ้ำ', r.status === 200 && Number(n) === 1,
        `HTTP ${r.status} · ${n} ข้อความ`)
    }
    {
      const raw = JSON.stringify({ destination: 'U-bot-destination', big: 'x'.repeat(1_100_000) })
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      ck(5, 'ก้อนข้อมูลเกิน 1MB ไม่ถูกอ่านทั้งก้อน', r.status === 413 || r.status === 503, `HTTP ${r.status}`)
    }

    // ── 6-8 ทางเข้า webhook ของ Messenger
    {
      const bad = await fetch(`${BASE}/webhooks/fb-test?hub.mode=subscribe&hub.verify_token=ผิด&hub.challenge=1234`)
      ck(6, 'Messenger verify_token ผิดถูกปฏิเสธ', bad.status === 403, `HTTP ${bad.status}`)
      const ok = await fetch(`${BASE}/webhooks/fb-test?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234`)
      const text = await ok.text()
      ck(7, 'Messenger verify_token ถูกคืน challenge กลับไป', ok.status === 200 && text === '1234', `HTTP ${ok.status} "${text}"`)
    }
    {
      const raw = JSON.stringify({ object: 'page', entry: [{ id: PAGE_ID, time: stamp, messaging: [{
        sender: { id: `FB-${TAG}` }, recipient: { id: PAGE_ID }, timestamp: stamp,
        message: { mid: 'fbm-' + stamp, text: 'สอบถามโปรโมชั่นครับ' } }] }] })
      const r = await post('/webhooks/fb-test', raw, { 'x-hub-signature-256': 'sha256=' + sign(raw, META_SECRET, 'hex') })
      await settle()
      const ch = await one(`select ci.channel from core.contact_identity ci where ci.external_id='FB-${TAG}'`)
      ck(8, 'Messenger ข้อความจริงเข้าระบบด้วยช่องทางที่ถูก', r.status === 200 && ch === 'messenger',
        `HTTP ${r.status} · ช่องทาง ${ch}`)
    }
    {
      const r = await post('/webhooks/ไม่มีช่องทางนี้', '{}', {})
      ck(9, 'ช่องทางที่ไม่ได้ตั้งค่าไว้ไม่รับของ', r.status === 503, `HTTP ${r.status}`)
    }

    // ── 10-18 ประตูของหน้าจอ ยุคล็อกอินรายบุคคล
    //    ทุกคำสั่งต้องมีเซสชันของคนที่ล็อกอินก่อน และคำขอที่เปลี่ยนข้อมูลต้องมาจากหน้าเว็บของเราจริง
    let ses = null
    {
      const r = await command('bootstrap', {})
      ck(10, 'ยังไม่ล็อกอิน เรียกคำสั่งไม่ได้ — ตายที่ session_expired',
        r.status === 401 && r.body.includes('session_expired'), `HTTP ${r.status} ${r.body.slice(0, 80)}`)
    }
    {
      const bad = await post('/api/login', JSON.stringify({ email: user.email, password: 'รหัสผ่านผิด' }), { origin: BASE })
      const r = await login(BASE, user)
      ck(11, 'ล็อกอิน: รหัสผิดถูกปฏิเสธ รหัสถูกได้คุกกี้เซสชันกลับมา',
        bad.status === 401 && r.status === 200 && r.cookie.includes('asher_session='),
        `รหัสผิด ${bad.status} · รหัสถูก ${r.status} · คุกกี้ ${r.cookie ? 'มี' : 'ไม่มี'}`)
      ses = r
    }
    {
      // คำขอที่ตกด่านไม่มีคุกกี้อะไรติดกลับไปให้เบราว์เซอร์เก็บ
      const r = await command('bootstrap', {})
      ck(12, 'คำขอที่ยังไม่ล็อกอิน ไม่มีคุกกี้ติดกลับไป', !r.headers.get('set-cookie'),
        'ได้ ' + (r.headers.get('set-cookie') || '(ไม่มี)'))
    }
    {
      // เว็บอื่นที่ผู้ใช้เปิดค้างไว้ สั่งงานบริการนี้ผ่านเบราว์เซอร์ของผู้ใช้ไม่ได้
      const r = await post('/api/command', JSON.stringify({ action: 'bootstrap', data: {} }),
        { origin: 'https://evil.example' })
      ck(13, 'คำสั่งจากเว็บอื่นถูกปฏิเสธ', r.status === 403, `HTTP ${r.status} ${r.body}`)
    }
    {
      const r = await commandAs(ses.cookie, 'bootstrap', {})
      const body = JSON.parse(r.body || '{}')
      ck(14, 'bootstrap ด้วยเซสชัน คืนตัวตนของคนล็อกอิน และรายการช่องทาง',
        r.status === 200 && body.user?.email === user.email && Array.isArray(body.channels) && body.channels.length === 2,
        `HTTP ${r.status}`)
    }
    {
      const r = await commandAs(ses.cookie, 'ทำลายโลก', { id: scene.conv })
      ck(15, 'คำสั่งที่ไม่มีอยู่จริงถูกปฏิเสธ', r.status >= 400 && !r.body.includes('unknown_action'),
        `HTTP ${r.status} ${r.body} (ห้ามหลุดรายละเอียดภายในออกมา)`)
    }
    {
      // สวิตช์ปิดฉุกเฉิน: ปิดช่องทางในฐานแล้วต้องส่งอะไรไม่ได้ทันที ทั้งที่ session ยังอยู่
      await sql(`update inbox.inbox set is_active=false where id='${scene.lineInbox}'`)
      const r = await commandAs(ses.cookie, 'send', { id: scene.conv, request_id: randomUUID(), text: 'ทดสอบหลังปิดช่องทาง' })
      await sql(`update inbox.inbox set is_active=true where id='${scene.lineInbox}'`)
      ck(16, 'ปิดช่องทางในฐานแล้วส่งข้อความไม่ได้ทันที (สวิตช์ฉุกเฉิน)',
        r.status >= 400 && r.body.includes('channel_disabled'), `HTTP ${r.status} ${r.body}`)
    }
    {
      const r = await post('/api/command', JSON.stringify({ action: 'bootstrap', data: { ขยะ: 'x'.repeat(300_000) } }),
        { origin: BASE, cookie: ses.cookie })
      ck(17, 'คำสั่งที่ใหญ่เกิน 256KB ถูกตัด', r.status === 413 || r.status === 400, `HTTP ${r.status}`)
    }
    {
      // ออกจากระบบด้วยเซสชันที่สอง (ไม่แตะของหลัก) — ออกแล้วคุกกี้ใบนั้นใช้ซ้ำไม่ได้จริง
      const r2 = await login(BASE, user)
      const out = await post('/api/logout', '{}', { origin: BASE, cookie: r2.cookie })
      const after = await post('/api/command', JSON.stringify({ action: 'bootstrap', data: {} }),
        { origin: BASE, cookie: r2.cookie })
      ck(18, 'ออกจากระบบ: ได้ 200 และเซสชันใบนั้นใช้ซ้ำไม่ได้อีก',
        out.status === 200 && after.status === 401, `ออก ${out.status} · คำสั่งหลังออก ${after.status}`)
    }

    // ── 19-20 worker สองตัวแย่งงานกัน
    {
      const agent = scene.agent
      const msg = await one(`insert into inbox.message(conversation_id,sender_type,sender_id,content)
        values('${scene.conv}','agent','${agent}','ข้อความสำหรับทดสอบ lease') returning id`)
      const queued = await one(`select count(*) from connect_private.delivery where message_id='${msg}'`)
      ck(19, 'ข้อความของเซลส์เข้าคิวขาออกอัตโนมัติแถวเดียว', Number(queued) === 1, `${queued} แถว`)

      // ยิง claim พร้อมกันสองเส้น = worker ในแอปกับงานตั้งเวลาทำงานชนกัน
      const claim = () => sql(asService(`select coalesce(connect_private.worker('claim',
        jsonb_build_object('inbox_ids', jsonb_build_array('${scene.lineInbox}')))->>'message_id','-');`))
        .then(r => r.map(x => x[0]).find(v => v && v !== 'BEGIN' && v !== 'COMMIT') ?? '-')
        .catch(e => 'error: ' + e.message.slice(0, 60))
      const [a, b] = await Promise.all([claim(), claim()])
      const got = [a, b].filter(v => v === msg).length
      // ★ ต้องดักด้วยว่า "ไม่ error" ด้วย ไม่ใช่แค่ "ได้ไม่เกินหนึ่ง"
      //   ของเดิมดัก error ทิ้งแล้วเทียบแค่จำนวน พอ claim พังทั้งคู่ ผลก็ยังไม่เกินหนึ่ง
      //   เทสต์จึงผ่านมาตลอดทั้งที่ claim ใช้งานไม่ได้เลยสักครั้ง
      const failed = [a, b].filter(v => String(v).startsWith('error'))
      ck(20, 'worker สองตัวแย่งงานพร้อมกัน ได้ข้อความเดียวกันแค่ตัวเดียว และไม่มีใคร error',
        got <= 1 && failed.length === 0, `ได้ไปคนละ: ${a} · ${b}`)
    }

    // ── 21-23 โหมดเงา: รับเข้าได้ แต่ห้ามส่งออกหาลูกค้า
    //    ยกเซิร์ฟเวอร์ตัวที่สองที่เปิดโหมดเงาไว้ ตัวหลักยังทำงานปกติอยู่คนละพอร์ต
    {
      const s2 = await startServer(scene, cfg, { CONNECT_SHADOW_MODE: 'true' }, PORT + 1)
      extraServers.push(s2)
      const s2ses = await login(s2.base, user)

      const sent = await fetch(s2.base + '/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: s2.base, cookie: s2ses.cookie },
        body: JSON.stringify({ action: 'send', data: { id: '00000000-0000-0000-0000-000000000000', text: 'ทดสอบ' } }) })
      const sentBody = await sent.text()
      ck(21, 'โหมดเงา: กดส่งถูกปฏิเสธด้วย shadow_mode ไม่ใช่หมดเซสชัน',
        sent.status === 503 && sentBody.includes('shadow_mode'), `ได้ ${sent.status} ${sentBody}`)

      // ปล่อยให้เลยรอบ worker ไปหลายรอบ (รอบละ 3 วินาที)
      await new Promise(r => setTimeout(r, 4000))
      const h = await (await fetch(s2.base + '/health')).json()
      ck(22, 'โหมดเงา: worker ไม่เคยหยิบงานเลยสักรอบ',
        h.workerLastSuccess === null, JSON.stringify(h))
      ck(23, 'โหมดเงา: /health ยังตอบว่าไหว แม้ worker ไม่เคยสำเร็จ',
        h.ok === true && h.shadow === true && h.activeChannels > 0, JSON.stringify(h))
    }

    // ── 24 /health ต้องยอมตอบว่าไม่ไหวได้จริง
    //    ชี้ปลายทาง Supabase ไปที่พอร์ตที่ไม่มีใครฟัง worker จึงล้มทุกรอบ
    {
      const s3 = await startServer(scene, cfg, {
        CONNECT_WORKER_STALE_MS: '3000',
        SUPABASE_URL: 'http://127.0.0.1:9',
      }, PORT + 2)
      extraServers.push(s3)
      await new Promise(r => setTimeout(r, 7000))
      const r = await fetch(s3.base + '/health')
      ck(24, '/health ตอบ 503 เมื่อตัวส่งข้อความเงียบเกินกำหนด', r.status === 503, 'ได้ ' + r.status)
    }

    // ── 25-27 บันทึกคำตอบของบอทตัวเดิม โดยไม่สร้างงานขาออก
    {
      const SB = process.env.HTTP_TEST_SUPABASE_URL || 'http://127.0.0.1:8055'
      const callRpc = (key, payload) => fetch(SB + '/rest/v1/rpc/connect_replay', {
        method: 'POST',
        headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + key,
                   'Content-Type': 'application/json', 'Content-Profile': 'inbox', 'Accept-Profile': 'inbox' },
        body: JSON.stringify(payload) })

      const count = async () => Number((await sql('select count(*) from connect_private.delivery'))[0][0])
      const before = await count()
      const ev = 'replay-' + TAG + '-' + Date.now()
      const data = { inbox_id: scene.lineInbox, external_id: `U-${TAG}`, event_id: ev,
                     text: 'คำตอบของบอทตัวเดิม', sender_type: 'bot' }

      const r1 = await callRpc(cfg.SUPABASE_SERVICE_ROLE_KEY, { p_action: 'replay', p_data: data })
      const b1 = await r1.text()
      const after = await count()
      ck(25, 'บันทึกคำตอบบอทแล้วไม่เกิดงานขาออกสักแถว',
        r1.status === 200 && after === before, `${r1.status} ${b1.slice(0, 80)} · delivery ${before}→${after}`)

      const r2 = await callRpc(cfg.SUPABASE_SERVICE_ROLE_KEY, { p_action: 'replay', p_data: data })
      const b2 = await r2.text()
      ck(26, 'ยิงคำตอบเดิมซ้ำ ไม่เกิดข้อความซ้ำ',
        r2.status === 200 && b2.includes('duplicate'), `${r2.status} ${b2.slice(0, 80)}`)

      const r3 = await callRpc(cfg.SUPABASE_ANON_KEY, { p_action: 'replay', p_data: { ...data, event_id: ev + '-anon' } })
      ck(27, 'anon เรียกเส้นทางบันทึกคำตอบบอทไม่ได้',
        r3.status === 401 || r3.status === 403, 'ได้ ' + r3.status)
    }

    // ── 28 บัญชีเดียวถูกใช้จากหลายที่พร้อมกัน
    //    token ใบเดียวถูกแชร์ทั้งบริการ ถ้าการล็อกอินที่อื่นทำให้ใบเดิมตาย หน้าจอจะค้างยกแผง
    //    เทสต์นี้จึงยืนยันว่าเปิดใช้พร้อมกันได้จริง ไม่ใช่แค่เชื่อว่าได้
    {
      const SB = process.env.HTTP_TEST_SUPABASE_URL || 'http://127.0.0.1:8055'
      const again = await fetch(SB + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password: user.password }) })
      // เซสชันของเราอยู่บนคุกกี้ฝั่งเซิร์ฟเวอร์ ไม่ผูกกับ token ของ gotrue ที่ถูกล็อกอินทับที่อื่น
      const r = await commandAs(ses.cookie, 'bootstrap', {})
      ck(28, 'ล็อกอินบัญชีเดียวกันจากที่อื่น แล้วเซสชันเดิมยังใช้งานต่อได้',
        again.status === 200 && r.status === 200, `ล็อกอินซ้ำ ${again.status} · คำสั่งถัดมา ${r.status}`)
    }

    // ── 29 ตอนเพิ่งบูตยังไม่มี token อยู่ในมือ หน้าเว็บยิงหลายคำขอพร้อมกันทันทีที่เปิด
    //    ถ้าปล่อยให้ต่างคนต่างล็อกอิน จะกดทับกันเองจนเข้าไม่ได้ ทั้งที่แต่ละคำขอถูกต้อง
    {
      const s5 = await startServer(scene, cfg, {}, PORT + 3)
      extraServers.push(s5)
      // ล็อกอินครั้งเดียวแล้วยิงหกคำขอพร้อมกันด้วยคุกกี้ใบเดียวกัน — ถ้าหมุน token ต่างคนต่างหมุน
      // ใบที่ทำร้ายจะตอบ 400 แล้วทุกหน้าจอหลุดพร้อมกัน
      const s5ses = await login(s5.base, user)
      const shoot = () => fetch(s5.base + '/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: s5.base, cookie: s5ses.cookie },
        body: JSON.stringify({ action: 'bootstrap', data: {} }) }).then(r => r.status).catch(() => 0)
      const many = await Promise.all([1, 2, 3, 4, 5, 6].map(shoot))
      ck(29, 'ยิงพร้อมกันหกคำขอด้วยเซสชันเดียว ไม่กดทับกันเอง', many.every(v => v === 200), 'ได้ ' + many.join(' '))
    }

    // ── 30 หน้าเว็บกับเซิร์ฟเวอร์ต้องเล่าเรื่องเดียวกัน
    //    ฝั่งเซิร์ฟเวอร์มี /api/login จริง และหน้าเว็บก็มีฟอร์มจริง — ไม่มีฝั่งใดสวมของยุคเก่า
    {
      const page = await (await fetch(BASE + '/')).text()
      const app = await (await fetch(BASE + '/app.js')).text()
      const serverHasLogin = (await post('/api/login', '{}', { origin: BASE })).status !== 404
      ck(30, 'หน้าเว็บกับเซิร์ฟเวอร์มีระบบล็อกอินคู่กันทั้งสองฝั่ง',
        serverHasLogin && page.includes('id="login-panel"') && app.includes('/api/login'),
        'เซิร์ฟเวอร์ ' + (serverHasLogin ? 'มี' : 'ไม่มี') + ' · หน้าเว็บ ' +
        (page.includes('id="login-panel"') ? 'มีฟอร์ม' : 'ไม่มีฟอร์ม') + ' · app.js ' +
        (app.includes('/api/login') ? 'ยิงจริง' : 'ไม่ยิง'))
    }

    // ── 31-33 ทางไป Edge Function
    //    โปรแกรมจะทยอยย้ายลงมาทีละตัว ทางนี้จึงต้องรับของใหม่ได้โดยไม่ต้องแก้โค้ด
    //    และต้องไม่กลายเป็นประตูหลังที่ยิงถึงทุกฟังก์ชันในโปรเจกต์
    {
      const r = await commandAs(ses.cookie, 'fn:ยังไม่ได้ลงทะเบียน', {})
      ck(31, 'Edge Function ที่ไม่อยู่ในทะเบียน เรียกไม่ได้',
        r.status === 404 && r.body.includes('function_not_registered'), `HTTP ${r.status} ${r.body}`)
    }
    {
      // ยิงถึงฟังก์ชันจริงที่รันอยู่ ไม่ใช่ของปลอม — ไม่มีลายเซ็นจึงต้องถูกฟังก์ชันปฏิเสธเอง
      const r = await commandAs(ses.cookie, 'fn:webhook-receiver', { hello: 'จากเทสต์' })
      ck(32, 'Edge Function ในทะเบียน ถูกเรียกถึงจริง',
        r.status >= 400 && r.status < 500 && r.body.includes('error'), `HTTP ${r.status} ${r.body.slice(0, 120)}`)
    }
    {
      // คำตอบของโปรแกรมต้องมาถึงหน้าจอทั้งอย่างนั้น ไม่ถูกยุบเป็น request_rejected ของชั้นนี้
      const r = await commandAs(ses.cookie, 'fn:webhook-receiver', {})
      ck(33, 'คำตอบของ Edge Function ไม่ถูกชั้นนี้ตีความใหม่',
        !r.body.includes('request_rejected') && !r.body.includes('service_unavailable'), r.body.slice(0, 120))
    }

    // ── 34 /health บอกได้ว่าตอนนี้รับโปรแกรมอะไรลงมาแล้วบ้าง และมีสถานะรวมให้ด้วย
    {
      const h = await (await fetch(BASE + '/health')).json()
      ck(34, '/health บอกทะเบียน Edge Function และสถานะรวมของระบบ',
        Array.isArray(h.edgeFunctions) && h.edgeFunctions.includes('webhook-receiver')
          && ['healthy', 'degraded', 'down', 'unknown'].includes(h.status)
          && h.database && typeof h.database.latencyMs === 'number',
        JSON.stringify({ status: h.status, database: h.database, edgeFunctions: h.edgeFunctions }))
    }

    // ── 35-41 ของเข้ามาแล้วเกิดอะไรขึ้นต่อ: บันทึกดิบ · คิว · event_type · กันซ้ำที่ฐาน · payload ขาออก
    {
      // ก้อนที่มีทั้งข้อความและ event ที่ normalize ไม่รู้จัก
      // ของที่ normalize ทิ้งต้องยังอยู่ในบันทึกดิบ ไม่งั้นวันที่อยากรองรับชนิดใหม่ จะไม่มีตัวอย่างให้ดูเลย
      const id = `${TAG}-mixed-${Date.now()}`
      const raw = JSON.stringify({ destination: 'U-bot-destination', events: [
        { type: 'message', webhookEventId: id, timestamp: Date.now(),
          source: { type: 'user', userId: `U-${TAG}` }, message: { id: 'lm-' + id, type: 'text', text: 'ข้อความปกติ' } },
        { type: 'ชนิดที่ยังไม่รู้จัก', webhookEventId: id + '-x', timestamp: Date.now(),
          source: { type: 'user', userId: `U-${TAG}` }, อะไรสักอย่าง: 'ค่าที่เราไม่รู้จัก' },
      ] })
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      await settle()
      const row = await sql(`select status, events_count,
                                    payload->'events'->1->>'type',
                                    jsonb_array_length(payload->'events')
                               from connect_private.webhook_log where id=${JSON.parse(r.body).log_id}`)
      const [status, count, unknownType, total] = row[0] || []
      ck(35, 'บันทึกดิบเก็บทั้งก้อน รวม event ที่ normalize ไม่รู้จัก',
        status === 'done' && Number(count) === 1 && Number(total) === 2 && unknownType === 'ชนิดที่ยังไม่รู้จัก',
        `สถานะ ${status} · ทำจริง ${count} จาก ${total} event · ชนิดที่ไม่รู้จัก ${unknownType}`)
    }
    {
      // ตอบ 200 ตั้งแต่ตอนเก็บของดิบ ไม่ใช่หลังประมวลผลเสร็จ — log_id ที่ติดกลับมาคือหลักฐาน
      const id = `${TAG}-fast-${Date.now()}`
      const raw = lineBody(id, 'ยิงแล้วต้องได้ 200 ทันที')
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      const body = JSON.parse(r.body || '{}')
      const stored = await one(`select payload->'events'->0->>'webhookEventId' from connect_private.webhook_log where id=${body.log_id || 0}`)
      ck(36, 'ตอบ 200 พร้อมเลขบันทึกดิบที่มีอยู่จริงในฐาน',
        r.status === 200 && Number.isInteger(body.log_id) && stored === id, `${r.status} ${r.body} · ในฐาน ${stored}`)
      await settle()
    }
    {
      // ของเดิมทิ้ง postback ทั้งหมด บอทจึงไม่มีทางรู้ว่าลูกค้ากดปุ่มอะไร
      const id = `${TAG}-pb-${Date.now()}`
      const raw = JSON.stringify({ destination: 'U-bot-destination', events: [{
        type: 'postback', webhookEventId: id, timestamp: Date.now(),
        source: { type: 'user', userId: `U-${TAG}` }, postback: { data: 'action=ดูห้อง&type=1BR' } }] })
      await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      await settle()
      const row = await sql(`select event_type, content from inbox.message where external_message_id='${id}'`)
      const [type, content] = row[0] || []
      ck(37, 'postback เข้าระบบพร้อม event_type ไม่ถูกทิ้งอีกต่อไป',
        type === 'postback' && (content || '').includes('action=ดูห้อง'), `ชนิด ${type} · เนื้อความ ${content}`)
    }
    {
      // การกดเพิ่มเพื่อนไม่ใช่คำถาม ถ้าเริ่มจับเวลา SLA หน้าจอจะเต็มไปด้วยเคสที่ไม่มีใครรออะไร
      const id = `${TAG}-fl-${Date.now()}`
      const follower = `U-${TAG}-follow`
      const raw = JSON.stringify({ destination: 'U-bot-destination', events: [{
        type: 'follow', webhookEventId: id, timestamp: Date.now(),
        source: { type: 'user', userId: follower } }] })
      await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      await settle()
      const waiting = await one(`select coalesce(cs.waiting_since::text,'(ว่าง)')
                                   from inbox.message m
                                   join connect_private.case_state cs on cs.conversation_id=m.conversation_id
                                  where m.external_message_id='${id}'`)
      const type = await one(`select event_type from inbox.message where external_message_id='${id}'`)
      ck(38, 'follow เข้าระบบโดยไม่เริ่มนาฬิกา SLA',
        type === 'follow' && waiting === '(ว่าง)', `ชนิด ${type} · waiting_since ${waiting}`)
    }
    {
      // ด่านกันซ้ำต้องอยู่ที่ฐาน ไม่ใช่ที่ Node — ยิงพร้อมกันสองสายต้องเหลือข้อความเดียว
      const id = `${TAG}-race-${Date.now()}`
      const raw = lineBody(id, 'ยิงพร้อมกันสองสาย')
      const headers = { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') }
      await Promise.all([post('/webhooks/line-test', raw, headers), post('/webhooks/line-test', raw, headers)])
      await settle()
      const messages = await one(`select count(*) from inbox.message where external_message_id='${id}'`)
      const events = await one(`select count(*) from connect_private.inbound_event where event_id='${id}'`)
      ck(39, 'ยิงก้อนเดิมพร้อมกันสองสาย ฐานกันซ้ำให้เหลือครั้งเดียว',
        Number(messages) === 1 && Number(events) === 1, `ข้อความ ${messages} · ทะเบียน ${events}`)
    }
    {
      // ตอนนี้ยังส่งได้แต่ข้อความล้วน แต่คิวต้องเก็บเป็นโครงสร้างไว้ตั้งแต่ตอนนี้
      // วันที่ต้องส่ง quick reply / รูป / flex จะได้ไม่ต้องรื้อ schema กับ RPC พร้อมกัน
      const msg = await one(`insert into inbox.message(conversation_id,sender_type,sender_id,content)
        values('${scene.conv}','agent','${scene.agent}','ทดสอบ payload ขาออก') returning id`)
      const row = await sql(`select payload->>'type', payload->>'text' from connect_private.delivery where message_id='${msg}'`)
      const [type, text] = row[0] || []
      ck(40, 'งานขาออกเก็บ payload เป็น JSON ไม่ใช่ข้อความล้วน',
        type === 'text' && text === 'ทดสอบ payload ขาออก', `ชนิด ${type} · เนื้อความ ${text}`)
    }
    {
      // ในของดิบมีข้อความลูกค้าจริง ต้องมีวันหมดอายุ ไม่ใช่เก็บไปตลอดกาล
      await sql(`insert into connect_private.webhook_log(channel_key,channel,payload,status,received_at)
                 values('line-test','line','{"__เก่า__":true}','done',now()-interval '31 days')`)
      const before = await one(`select count(*) from connect_private.webhook_log where payload ? '__เก่า__'`)
      await sql(asService(`select connect_private.worker('sweep','{}');`))
      const after = await one(`select count(*) from connect_private.webhook_log where payload ? '__เก่า__'`)
      ck(41, 'ของดิบที่เกิน 30 วันถูกลบทิ้งตาม retention',
        Number(before) === 1 && Number(after) === 0, `ก่อน ${before} · หลัง ${after}`)
    }

    // ── 42 claim หยิบงานได้จริง
    //    ใช้กล่องแยกที่ไม่มีอยู่ใน channels.json ของเซิร์ฟเวอร์ในเทสต์
    //    ไม่งั้น worker ของเซิร์ฟเวอร์อาจชิงงานไปก่อน แล้วผลจะขึ้นกับจังหวะ ไม่ใช่ตรรกะ
    {
      const inbox = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
        values('line','${scene.project}','LINE ${TAG} นอกสายตา worker','TEST_ONLY',true) returning id`)
      const contact = await one(`select core.resolve_identity('line','U-${TAG}-solo','${inbox}','ลูกค้า ${TAG} solo','${scene.project}')`)
      const conv = await one(`insert into inbox.conversation(inbox_id,contact_id,assignee_id,status)
        values('${inbox}','${contact}','${scene.agent}','open') returning id`)
      const msg = await one(`insert into inbox.message(conversation_id,sender_type,sender_id,content)
        values('${conv}','agent','${scene.agent}','ข้อความที่ต้องถูกหยิบไปส่ง') returning id`)

      const row = await sql(asService(`select coalesce(connect_private.worker('claim',
        jsonb_build_object('inbox_ids', jsonb_build_array('${inbox}')))::text,'(ว่าง)');`))
      const job = row.map(x => x[0]).find(v => v && v !== 'BEGIN' && v !== 'COMMIT' && v !== 'SET') ?? '(ไม่ได้อะไรกลับมา)'
      let parsed = null
      try { parsed = JSON.parse(job) } catch { /* ไม่ใช่ JSON แปลว่าล้ม */ }
      ck(42, 'claim หยิบงานขาออกได้จริง พร้อมปลายทางและ lease',
        parsed?.message_id === msg && !!parsed?.lease_id && parsed?.recipient === `U-${TAG}-solo`
          && parsed?.payload?.type === 'text',
        String(job).slice(0, 200))
    }

    // ── 43-45 receive() ตัดสินใจแล้วเข้าคิวจริง (Phase 3)
    //    ใช้กล่องแยกที่ seed ค่าของ LINE ไว้ (ตอบ 22:00-08:00 · คนตอบแล้วเงียบ 30 นาที)
    //    แล้วป้อน p_now เองเพื่อคุมว่าอยู่ในช่วงไหน ไม่ต้องรอเวลาจริง
    {
      const ib = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
        values('line','${scene.project}','LINE ${TAG} ตัดสินใจ','TEST_ONLY',true) returning id`)
      await sql(asService(`select inbox.seed_bot_defaults('${ib}');`))
      const uid = `U-${TAG}-decide`
      const fire = (id, text, now, extra = {}) => sql(asService(
        `select connect_private.receive_event('${JSON.stringify({ inbox_id: ib, external_id: uid,
          event_id: id, event_type: 'message', text, ...extra })}'::jsonb, '${now}'::timestamptz, 0);`))

      // 23:00 อยู่ในช่วงที่บอทตอบ → ต้องได้งานคิดคำตอบพร้อมเวลาหน่วง 15 วินาที
      await fire(`${TAG}-d1`, 'สนใจห้อง 1 นอนค่ะ', '2026-01-02 23:00:00+07')
      const row = await sql(`select d.reply_go, d.reply_reason, d.notify_go, d.notify_action,
                                    j.kind, extract(epoch from (j.send_after - d.decided_at))::int
                               from inbox.bot_decisions d
                               join inbox.conversation c on c.id=d.conversation_id
                               left join connect_private.job j on j.conversation_id=c.id and j.kind='generate'
                              where c.inbox_id='${ib}'`)
      const [replyGo, reason, notifyGo, action, kind, delay] = row[0] || []
      ck(43, 'บอทตอบได้ → บันทึกการตัดสินใจ และเข้าคิวงานคิดคำตอบพร้อมเวลาหน่วง',
        replyGo === 't' && reason === 'immediate' && kind === 'generate' && Number(delay) === 15,
        `reply ${replyGo}/${reason} · notify ${notifyGo}/${action} · งาน ${kind} หน่วง ${delay} วิ`)

      // คนตอบจาก Business Suite (echo) → งานที่บอทจ่อจะส่งต้องถูกยกเลิกทันที
      await fire(`${TAG}-d2`, 'สวัสดีค่ะ เดี๋ยวส่งรายละเอียดให้นะคะ', '2026-01-02 23:01:00+07',
        { event_type: 'echo' })
      const after = await sql(`select j.status, j.skip_reason,
                                      (c.last_human_reply_at is not null)::text
                                 from connect_private.job j
                                 join inbox.conversation c on c.id=j.conversation_id
                                where c.inbox_id='${ib}' and j.kind='generate'`)
      const [status, skip, humanAt] = after[0] || []
      ck(44, 'คนตอบแล้ว งานที่บอทจ่อจะส่งถูกยกเลิก ไม่ใช่รอให้ถึงเวลาแล้วค่อยเช็ค',
        status === 'skipped' && skip === 'human_replied' && humanAt === 'true',
        `งาน ${status}/${skip} · บันทึกเวลาคนตอบ ${humanAt}`)

      // 14:00 นอกช่วง → บอทเงียบ แต่ยังอยากรู้ว่าลูกค้าถามเรื่องอะไร
      await fire(`${TAG}-d3`, 'ห้องว่างไหมคะ', '2026-01-03 14:00:00+07')
      const silent = await sql(`select d.reply_go, d.reply_reason,
                                       (select string_agg(distinct j.kind, ',' order by j.kind)
                                          from connect_private.job j where j.message_id=d.message_id)
                                  from inbox.bot_decisions d
                                  join inbox.conversation c on c.id=d.conversation_id
                                 where c.inbox_id='${ib}' and d.event_id='${TAG}-d3'`)
      const [go3, reason3, kinds] = silent[0] || []
      ck(45, 'บอทเงียบนอกเวลา → ไม่มีงานคิดคำตอบ แต่ยังเก็บหมวดคำถามไว้ทำโฆษณา',
        go3 === 'f' && reason3.startsWith('outside_schedule') && (kinds || '').includes('classify')
          && !(kinds || '').includes('generate'),
        `reply ${go3}/${reason3} · งานที่เกิด ${kinds}`)
    }

    // ── 46 โหมดเงากันการส่งด้วยโครงสร้าง ไม่ใช่ด้วย if ในโค้ด
    //    worker ตอนโหมดเงาขอเฉพาะชนิด generate/classify งานส่งจึงไม่ถูกแตะแม้แต่การ claim
    //    (ถ้ากันด้วย if หลัง claim งานจะถูกนับ attempts และเสียลำดับไปเรื่อย ๆ)
    {
      const ib = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
        values('line','${scene.project}','LINE ${TAG} คิวงาน','TEST_ONLY',true) returning id`)
      // เปิดสวิตช์บอทของกล่องนี้ก่อน — ข้อนี้ทดสอบเรื่องโหมดเงา ไม่ใช่เรื่องสวิตช์
      await sql(`insert into inbox.bot_config(inbox_id,key,value)
                 values('${ib}','bot.generate_enabled','true'::jsonb)
                 on conflict (inbox_id,key) do update set value=excluded.value`)
      await sql(`insert into connect_private.job(kind,channel,inbox_id,payload,send_after)
                 values('notify','team','${ib}','{}'::jsonb, now() - interval '1 minute'),
                        ('generate','line','${ib}','{}'::jsonb, now() - interval '1 minute')`)

      const claim = kinds => sql(asService(
        `select coalesce(connect_private.worker('claim_job', jsonb_build_object(
           'kinds', '${JSON.stringify(kinds)}'::jsonb,
           'inbox_ids', jsonb_build_array('${ib}')))->>'kind', '(ไม่ได้งาน)');`))
        .then(r => r.map(x => x[0]).find(v => v && !['BEGIN','COMMIT','SET'].includes(v)) ?? '(ไม่ได้งาน)')

      const shadowPick = await claim(['generate', 'classify'])
      const livePick = await claim(['generate', 'classify', 'notify', 'typing'])
      const notifyStatus = await one(`select status from connect_private.job where inbox_id='${ib}' and kind='notify'`)

      ck(46, 'โหมดเงา: ขอเฉพาะงานของบอท งานส่งไม่ถูกแตะแม้แต่การหยิบ',
        shadowPick === 'generate' && livePick === 'notify' && notifyStatus === 'processing',
        `โหมดเงาได้ ${shadowPick} · โหมดปกติได้ ${livePick} · งานแจ้งตอนนี้ ${notifyStatus}`)
    }

    // ── 47-49 ปุ่มเปิด/ปิดบอท
    //    สวิตช์นี้คุม "การลงมือทำ" ไม่ใช่ "การตัดสินใจ" — ปิดแล้วยังต้องบันทึก bot_decisions
    //    ตามปกติ ไม่งั้นตัวเลขที่เอาไปเทียบกับ cloud ตอน shadow จะเพี้ยนทันที
    {
      const ib = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
        values('line','${scene.project}','LINE ${TAG} สวิตช์','TEST_ONLY',true) returning id`)
      await sql(asService(`select inbox.seed_bot_defaults('${ib}'); select inbox.seed_bot_switches('${ib}');`))
      await sql(`insert into connect_private.job(kind,channel,inbox_id,payload,send_after)
                 values('generate','line','${ib}','{}'::jsonb, now() - interval '1 minute')`)

      const claim = () => sql(asService(
        `select coalesce(connect_private.worker('claim_job', jsonb_build_object(
           'kinds', '["generate","classify"]'::jsonb,
           'inbox_ids', jsonb_build_array('${ib}')))->>'kind', '(ไม่ได้งาน)');`))
        .then(r => r.map(x => x[0]).find(v => v && !['BEGIN','COMMIT','SET'].includes(v)) ?? '(ไม่ได้งาน)')

      const whileOff = await claim()
      const stillPending = await one(`select status||' · หยิบไป '||attempts||' ครั้ง' from connect_private.job where inbox_id='${ib}'`)
      ck(47, 'ปิดอยู่: งานไม่ถูกหยิบเลย และตัวนับครั้งไม่ขยับ',
        whileOff === '(ไม่ได้งาน)' && stillPending === 'pending · หยิบไป 0 ครั้ง',
        `หยิบได้ ${whileOff} · งานตอนนี้ ${stillPending}`)

      // เปิดผ่านทางเดียวกับที่ปุ่มบนหน้าจอใช้
      // ต้องยกเซิร์ฟเวอร์ที่ทำงานในนามผู้จัดการ เพราะตัวหลักทำงานในนามเซลส์
      // ซึ่งกดสวิตช์ไม่ได้โดยตั้งใจ (ดูข้อ 49)
      const manager = await testUser('manager.test@')
      const s6 = await startServer(scene, cfg,
        { CONNECT_ACCOUNT_EMAIL: manager.email, CONNECT_ACCOUNT_PASSWORD: manager.password }, PORT + 4)
      extraServers.push(s6)
      const s6ses = await login(s6.base, manager)
      const flip = await fetch(s6.base + '/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: s6.base, cookie: s6ses.cookie },
        body: JSON.stringify({ action: 'bot_switch', data: { switch: 'generate', enabled: true, inbox_id: ib } }) })
      const whileOn = await claim()
      ck(48, 'ผู้จัดการกดเปิดจากหน้าจอแล้วงานเดินต่อจากของที่ค้างไว้ ไม่ได้หายไป',
        flip.status === 200 && whileOn === 'generate', `HTTP ${flip.status} · หยิบได้ ${whileOn}`)
    }
    {
      // เซลส์ทั่วไปกดสวิตช์ไม่ได้ — เป็นเรื่องเงินและเป็นเรื่องที่ลูกค้าเห็น
      const salesId = await one(`select id from auth.users where email='sales.a.test@asher.local'`)
      const denied = await sql(`begin;
        set local request.jwt.claims = '{"sub":"${salesId}","role":"authenticated"}';
        select coalesce((select connect_private.api('bot_switch', '{"switch":"generate","enabled":true}')::text), 'ไม่มีข้อความ');
        commit;`).catch(e => ['ปฏิเสธ: ' + e.message])
      const text = Array.isArray(denied) ? denied.map(x => Array.isArray(x) ? x[0] : x).join(' ') : String(denied)
      ck(49, 'เซลส์ทั่วไปกดสวิตช์บอทไม่ได้', text.includes('not_allowed'), text.slice(0, 120))
    }

    // ── 50 echo เดินครบเส้นทางจริง: webhook → คิวขาเข้า → receive → last_human_reply_at
    //    เส้นนี้คือหัวใจของการเทียบผลกับ cloud — ถ้าฝั่งเราไม่รู้ว่าทีมตอบไปแล้ว
    //    decide_reply จะไม่มีวันตอบ human_owns_convo แล้วตัวเลขจะไม่ตรงกันตลอดกาล
    {
      const id = `${TAG}-echo-${Date.now()}`
      const raw = JSON.stringify({ object: 'page', entry: [{ id: PAGE_ID, time: Date.now(), messaging: [{
        sender: { id: PAGE_ID }, recipient: { id: `FB-${TAG}` }, timestamp: Date.now(),
        message: { mid: id, is_echo: true, text: 'ทีมตอบจาก Business Suite แล้วนะคะ' } }] }] })
      const r = await post('/webhooks/fb-test', raw, { 'x-hub-signature-256': 'sha256=' + sign(raw, META_SECRET, 'hex') })
      await settle()
      const row = await sql(`select m.sender_type, m.content,
                                    (c.last_human_reply_at is not null)::text
                               from inbox.message m join inbox.conversation c on c.id=m.conversation_id
                              where m.external_message_id='${id}'`)
      const [sender, content, humanAt] = row[0] || []
      const outbound = await one(`select count(*) from connect_private.delivery d
                                    join inbox.message m on m.id=d.message_id
                                   where m.external_message_id='${id}'`)
      ck(50, 'คำตอบของทีมจาก Business Suite เข้าระบบเป็นข้อความของเรา และไม่ถูกส่งกลับหาลูกค้า',
        r.status === 200 && sender === 'agent' && humanAt === 'true' && Number(outbound) === 0,
        `HTTP ${r.status} · ผู้ส่ง ${sender} · บันทึกเวลาคนตอบ ${humanAt} · งานขาออกที่เกิด ${outbound}`)
    }

    // ── 51-58 ของที่เป็นเรื่องเฉพาะ LINE (Phase 6)
    //    ทุกข้อยิงผ่าน webhook จริงพร้อมลายเซ็น ไม่ได้เรียกฟังก์ชันลัด
    const lineEvent = (ev) => JSON.stringify({ destination: 'U-bot-destination', events: [ev] })
    const fireLine = async (ev) => {
      const raw = lineEvent(ev)
      const r = await post('/webhooks/line-test', raw, { 'x-line-signature': sign(raw, LINE_SECRET, 'base64') })
      await settle()
      return r
    }
    const CODE = 'abc123'
    const CUSTOMER = `U-${TAG}-${CODE}`
    const SALES = `U-${TAG}-sale01`
    const GROUP = `C${TAG}group`

    {
      // เพิ่มเพื่อนใหม่ → ต้องได้ข้อความต้อนรับเข้าคิว และแจ้งทีม
      await sql(asService(`select inbox.seed_bot_defaults('${scene.lineInbox}');`))
      const r = await fireLine({ type: 'follow', webhookEventId: `${TAG}-follow-1`, timestamp: Date.now(),
        source: { type: 'user', userId: CUSTOMER }, replyToken: 'rt-follow' })
      const welcome = await one(`select count(*) from inbox.message m
                                   join inbox.conversation c on c.id=m.conversation_id
                                   join core.contact_identity ci on ci.contact_id=c.contact_id
                                  where ci.external_id='${CUSTOMER}' and m.sender_type='bot'
                                    and m.content like '%เพิ่มเพื่อน%'`)
      const notified = await one(`select count(*) from connect_private.job j
                                    join inbox.conversation c on c.id=j.conversation_id
                                    join core.contact_identity ci on ci.contact_id=c.contact_id
                                   where ci.external_id='${CUSTOMER}' and j.kind='notify'
                                     and j.payload->>'kind'='follow'`)
      ck(51, 'เพิ่มเพื่อนใหม่: ได้ข้อความต้อนรับเข้าคิว และทีมได้รับแจ้ง',
        r.status === 200 && Number(welcome) === 1 && Number(notified) === 1,
        `HTTP ${r.status} · ข้อความต้อนรับ ${welcome} · งานแจ้ง ${notified}`)
    }
    {
      // [AD:xxx] จากลิงก์โฆษณา → ad_id ติดทั้งบทสนทนา และ prefix ต้องไม่ปนอยู่ในข้อความ
      await fireLine({ type: 'message', webhookEventId: `${TAG}-ad-1`, timestamp: Date.now(),
        source: { type: 'user', userId: CUSTOMER }, replyToken: 'rt-ad',
        message: { id: 'lm-ad-1', type: 'text', text: '[AD:naii_carousel_01] สนใจห้อง 1 นอนค่ะ' } })
      const row = await sql(`select c.ad_id, m.content from inbox.message m
                               join inbox.conversation c on c.id=m.conversation_id
                              where m.external_message_id='${TAG}-ad-1'`)
      const [adId, content] = row[0] || []
      ck(52, 'ข้อความจากลิงก์โฆษณา: ติด ad_id ให้บทสนทนา และตัด prefix ออกก่อนเก็บ',
        adId === 'naii_carousel_01' && content === 'สนใจห้อง 1 นอนค่ะ',
        `ad_id ${adId} · ข้อความที่เก็บ "${content}"`)
    }
    {
      // ยิงซ้ำที่ผู้ให้บริการติดธงมาให้ ต้องไม่ถูกประมวลผลอีกรอบ
      const before = await one(`select count(*) from inbox.message where external_message_id='${TAG}-redeliver'`)
      await fireLine({ type: 'message', webhookEventId: `${TAG}-redeliver`, timestamp: Date.now(),
        source: { type: 'user', userId: CUSTOMER }, replyToken: 'rt-re',
        deliveryContext: { isRedelivery: true },
        message: { id: 'lm-re', type: 'text', text: 'ของที่ยิงซ้ำ' } })
      const after = await one(`select count(*) from inbox.message where external_message_id='${TAG}-redeliver'`)
      ck(53, 'ของที่ผู้ให้บริการยิงซ้ำ ไม่ถูกประมวลผลอีกรอบ',
        Number(before) === 0 && Number(after) === 0, `ก่อน ${before} · หลัง ${after}`)
    }
    {
      // คำสั่งกลุ่มที่ไม่ต้องมีเคส
      const ask = async (no, text, expect) => {
        await fireLine({ type: 'message', webhookEventId: `${TAG}-g-${no}`, timestamp: Date.now(),
          source: { type: 'group', groupId: GROUP, userId: SALES }, replyToken: `rt-g-${no}`,
          message: { id: `lm-g-${no}`, type: 'text', text } })
        return one(`select payload->>'text' from connect_private.job
                     where channel='line_group' and target='${GROUP}'
                     order by id desc limit 1`)
      }

      const gid = await ask(1, 'ไอดีกลุ่ม')
      const status = await ask(2, 'สถานะ')
      const reg = await ask(3, `ลงทะเบียน มิ้นท์ ${TAG}`)
      const who = await ask(4, 'ฉันใคร')
      ck(54, 'คำสั่งกลุ่ม: ไอดีกลุ่ม · สถานะ · ลงทะเบียน · ฉันใคร',
        (gid || '').includes(GROUP) && (status || '').includes('สถานะบอท')
          && (reg || '').includes('ลงทะเบียนให้แล้ว') && (who || '').includes('มิ้นท์'),
        `ไอดีกลุ่ม "${(gid||'').slice(0,40)}" · สถานะ "${(status||'').slice(0,30)}" · ` +
        `ลงทะเบียน "${(reg||'').slice(0,30)}" · ฉันใคร "${(who||'').slice(0,30)}"`)

      const staff = await one(`select count(*) from inbox.sales_staff_identity si
                                 join inbox.sales_staff st on st.id=si.staff_id
                                where si.external_id='${SALES}' and st.name like '%${TAG}%'`)
      ck(55, 'ลงทะเบียนแล้วผูก LINE ของคนในทีมกับชื่อไว้จริง', Number(staff) === 1, `${staff} แถว`)

      // ตอบแล้ว <รหัส> — สัญญาณสำรองตอนทีมตอบจาก chat.line.biz
      const convId = await one(`select c.id from inbox.conversation c
                                 join core.contact_identity ci on ci.contact_id=c.contact_id
                                where ci.external_id='${CUSTOMER}' limit 1`)
      await sql(`insert into connect_private.job(kind,channel,inbox_id,conversation_id,payload,send_after)
                 values('generate','line','${scene.lineInbox}','${convId}','{}'::jsonb, now()+interval '20 minutes')`)
      const done = await ask(5, `ตอบแล้ว ${CODE}`)
      const after = await sql(`select (c.last_human_reply_at is not null)::text,
                                      (select j.status from connect_private.job j
                                        where j.conversation_id=c.id and j.kind='generate' order by j.id desc limit 1),
                                      (select e.source from inbox.human_reply_events e
                                        where e.conversation_id=c.id order by e.id desc limit 1)
                                 from inbox.conversation c where c.id='${convId}'`)
      const [humanAt, jobStatus, source] = after[0] || []
      ck(56, 'ตอบแล้ว <รหัส>: บันทึกเวลาคนตอบ · ยกเลิกงานที่บอทจ่อจะส่ง · ลงบันทึกว่าใครบอก',
        (done || '').includes('บอทจะเงียบ') && humanAt === 'true'
          && jobStatus === 'skipped' && source === 'group_cmd',
        `ตอบ "${(done||'').slice(0,40)}" · เวลาคนตอบ ${humanAt} · งาน ${jobStatus} · ที่มา ${source}`)

      const stop = await ask(6, `หยุด ${CODE}`)
      const modeOff = await one(`select mode from inbox.conversation where id='${convId}'`)
      const go = await ask(7, `บอท ${CODE}`)
      const modeOn = await one(`select mode from inbox.conversation where id='${convId}'`)
      ck(57, 'หยุด / บอท <รหัส>: สลับโหมดของเคสได้จากกลุ่ม',
        (stop || '').includes('ปิดบอท') && modeOff === 'human'
          && (go || '').includes('เปิดบอท') && modeOn === 'bot',
        `หยุด → ${modeOff} · บอท → ${modeOn}`)

      const unknown = await one(`select count(*) from connect_private.job
                                  where channel='line_group' and payload->>'text' like '%ไม่พบเคส%'`)
      await fireLine({ type: 'message', webhookEventId: `${TAG}-g-8`, timestamp: Date.now(),
        source: { type: 'group', groupId: GROUP, userId: SALES }, replyToken: 'rt-g-8',
        message: { id: 'lm-g-8', type: 'text', text: 'วันนี้กินอะไรดี' } })
      const chatter = await one(`select count(*) from connect_private.job where channel='line_group'`)
      const before8 = Number(await one(`select count(*) from connect_private.inbound_event where event_id='${TAG}-g-8'`))
      ck(58, 'คุยกันเองในกลุ่ม บอทไม่ตอบ แต่ยังบันทึกว่าเคยเห็น event นั้น',
        Number(chatter) === 7 && before8 === 1, `งานตอบกลับทั้งหมด ${chatter} ชิ้น · บันทึก event ${before8}`)
    }
    {
      // unfollow: ติดธงว่าบล็อกแล้ว จะได้ไม่เสียโควตายิงหาคนที่ไม่ได้ยินเรา
      await fireLine({ type: 'unfollow', webhookEventId: `${TAG}-unfollow-1`, timestamp: Date.now(),
        source: { type: 'user', userId: CUSTOMER } })
      const blocked = await one(`select ct.blocked::text from core.contact ct
                                   join core.contact_identity ci on ci.contact_id=ct.id
                                  where ci.external_id='${CUSTOMER}'`)
      ck(59, 'ลูกค้าบล็อกบัญชี: ติดธงไว้ที่ผู้ติดต่อ', blocked === 'true', `blocked=${blocked}`)
    }
    {
      // endpoint สำรองให้ Marketing OS บอกว่าคนตอบจาก chat.line.biz แล้ว
      const convId = await one(`select c.id from inbox.conversation c
                                 join core.contact_identity ci on ci.contact_id=c.contact_id
                                where ci.external_id='${CUSTOMER}' limit 1`)
      await sql(`update inbox.conversation set last_human_reply_at=null where id='${convId}'`)
      const r = await commandAs(ses.cookie, 'human_reply', { channel: 'line', external_id: CUSTOMER, note: 'ตอบจาก chat.line.biz' })
      const row = await sql(`select (c.last_human_reply_at is not null)::text,
                                    (select e.source from inbox.human_reply_events e
                                      where e.conversation_id=c.id order by e.id desc limit 1)
                               from inbox.conversation c where c.id='${convId}'`)
      const [humanAt, source] = row[0] || []
      ck(60, 'endpoint human_reply: ระบุลูกค้าด้วยช่องทาง+id ได้ ไม่ต้องรู้จัก conversation ของเรา',
        r.status === 200 && humanAt === 'true' && source === 'api',
        `HTTP ${r.status} ${r.body.slice(0, 60)} · เวลาคนตอบ ${humanAt} · ที่มา ${source}`)
    }

    // ── 61 สัญญาณ "คนตอบแล้ว" ตัวหลัก: เซลส์กดส่งจากหน้าจอเรา
    //    ใช้กล่องนอกสายตา worker เพื่อให้คุมจังหวะ claim/finish ได้เอง
    {
      const ib = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
        values('line','${scene.project}','LINE ${TAG} เซลส์ตอบ','TEST_ONLY',true) returning id`)
      const ct = await one(`select core.resolve_identity('line','U-${TAG}-ws','${ib}','ลูกค้า ${TAG} ws','${scene.project}')`)
      const cv = await one(`insert into inbox.conversation(inbox_id,contact_id,assignee_id,status)
        values('${ib}','${ct}','${scene.agent}','open') returning id`)
      await sql(`insert into inbox.message(conversation_id,sender_type,content)
                 values('${cv}','contact','ราคาเท่าไหร่คะ')`)
      await sql(`insert into connect_private.job(kind,channel,inbox_id,conversation_id,payload,send_after)
                 values('generate','line','${ib}','${cv}','{}'::jsonb, now()+interval '20 minutes')`)
      const msg = await one(`insert into inbox.message(conversation_id,sender_type,sender_id,content)
        values('${cv}','agent','${scene.agent}','เริ่ม 2.39 ลบ. ค่ะ') returning id`)

      // หยิบงานส่งแล้วรายงานว่าส่งถึงลูกค้าแล้ว — เส้นเดียวกับที่ worker เดินจริง
      const claimed = await sql(asService(`select connect_private.worker('claim',
        jsonb_build_object('inbox_ids', jsonb_build_array('${ib}')))::text;`))
      const job = JSON.parse(claimed.map(x => x[0]).find(v => v && v.startsWith('{')) ?? '{}')
      await sql(asService(`select connect_private.worker('finish', jsonb_build_object(
        'message_id','${msg}','lease_id','${job.lease_id}','status','sent','provider_id','p1'));`))

      const row = await sql(`select (c.last_human_reply_at is not null)::text,
                                    (select e.source from inbox.human_reply_events e
                                      where e.conversation_id=c.id order by e.id desc limit 1),
                                    (select j.status from connect_private.job j
                                      where j.conversation_id=c.id and j.kind='generate' order by j.id desc limit 1)
                               from inbox.conversation c where c.id='${cv}'`)
      const [humanAt, source, jobStatus] = row[0] || []
      ck(61, 'เซลส์กดส่งจากหน้าจอ: นับเป็นคนตอบทันทีที่ถึงลูกค้า และบอทหยุดจ่อ',
        humanAt === 'true' && source === 'workspace' && jobStatus === 'skipped',
        `เวลาคนตอบ ${humanAt} · ที่มา ${source} · งานที่บอทจ่อ ${jobStatus}`)
    }

    // ── 62-64 Admin System Status: ด่านสิทธิ์ + ข้อมูลจริงจาก backend
    {
      const r = await fetch(BASE + '/api/admin/system-health')
      ck(62, 'ยังไม่ล็อกอิน เข้าถึง system-health ไม่ได้', r.status === 401, 'ได้ ' + r.status)
    }
    {
      const r = await fetch(BASE + '/api/admin/system-health', { headers: { cookie: ses.cookie } })
      ck(63, 'เซลส์ทั่วไปเข้า system-health ไม่ได้ (ด่านอยู่ในฐาน)', r.status === 403, 'ได้ ' + r.status)
    }
    {
      const admin = await testUser('admin.test@')
      const a = await login(BASE, admin)
      const r = await fetch(BASE + '/api/admin/system-health', { headers: { cookie: a.cookie } })
      const body = await r.json().catch(() => ({}))
      const ok = r.status === 200
        && ['healthy', 'degraded', 'down', 'unknown'].includes(body.overall)
        && body.database?.status !== undefined && typeof body.database?.latencyMs === 'number'
        && body.workers?.inbound && body.workers?.outbound
        && body.queue?.pending !== undefined
        && typeof body.shadowMode === 'boolean'
        && Array.isArray(body.rules) && body.rules.length >= 11
        && typeof body.checkedAt === 'string' && typeof body.uptimeSec === 'number'
        && body.environment !== undefined
        // ห้ามมีความลับหลุดมาในคำตอบเด็ดขาด
        && !JSON.stringify(body).includes(cfg.SUPABASE_SERVICE_ROLE_KEY.slice(0, 20))
      ck(64, 'admin เปิด system-health ได้ ครบทุกส่วน และไม่มี secret หลุด', ok,
        `HTTP ${r.status} · overall ${body.overall} · db ${body.database?.status} · กฎ ${body.rules?.length}`)
    }

    // ── 65 /health contract: ของใหม่เพิ่มเข้ามา ของเดิมต้องอยู่ครบ (ไม่ breaking change)
    {
      const h = await (await fetch(BASE + '/health')).json()
      const kept = 'ok' in h && 'workerLastSuccess' in h && h.memory && Array.isArray(h.edgeFunctions) && 'bot' in h
      const added = typeof h.uptimeSec === 'number' && 'checkedAt' in h && 'version' in h
        && h.database && h.channels && h.workers && h.queue && typeof h.shadowMode === 'boolean'
        && ['healthy', 'degraded', 'down', 'unknown'].includes(h.status)
      ck(65, '/health คง field เดิมครบ และเพิ่มสถานะรวม/ฐานข้อมูล/worker/คิวให้ด้วย',
        kept && added, `ของเดิม ${kept ? 'ครบ' : 'ขาด'} · ของเพิ่ม ${added ? 'ครบ' : 'ขาด'}`)
    }

    // ── 66 ฐานล่ม → สถานะรวมต้องลงเป็น down และ /health ตอบ 503 (ไม่ใช่ 200 หลอก ๆ)
    {
      const s7 = await startServer(scene, cfg, {
        CONNECT_WORKER_STALE_MS: '3000',
        SUPABASE_URL: 'http://127.0.0.1:9',
      }, PORT + 5)
      extraServers.push(s7)
      await new Promise(r => setTimeout(r, 8000))
      const r = await fetch(s7.base + '/health')
      const h = await r.json().catch(() => ({}))
      ck(66, 'ฐานข้อมูลใช้ไม่ได้: สถานะรวมเป็น down และ /health ตอบ 503',
        r.status === 503 && h.status === 'down' && h.database?.status === 'down',
        `HTTP ${r.status} · status ${h.status} · db ${h.database?.status}`)
    }

    // ── 67 Run Self-Test: admin กดได้ ผลรวมถูกต้อง และไม่มี secret หลุด
    {
      const admin = await testUser('admin.test@')
      const a = await login(BASE, admin)
      const sales = await fetch(BASE + '/api/admin/system-health/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: BASE, cookie: ses.cookie }, body: '{}' })
      const r = await fetch(BASE + '/api/admin/system-health/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: BASE, cookie: a.cookie }, body: '{}' })
      const body = await r.json().catch(() => ({}))
      const ok = sales.status === 403 && r.status === 200
        && typeof body.ok === 'boolean' && Array.isArray(body.tests) && body.tests.length >= 5
        && body.passed + body.failed === body.tests.length
        && body.tests.every(t => ['PASS', 'WARN', 'FAIL'].includes(t.result) && typeof t.ms === 'number')
        && !JSON.stringify(body).includes(cfg.SUPABASE_SERVICE_ROLE_KEY.slice(0, 20))
      ck(67, 'Run Self-Test: เซลส์โดนปฏิเสธ admin ได้ผลครบ และไม่มี secret หลุด',
        ok, `เซลส์ ${sales.status} · admin ${r.status} · ผ่าน ${body.passed}/${body.tests?.length}`)
    }

    // ── 68 Health Rules: ตรวจค่าก่อนเขียน — ค่าผิดถูกปฏิเสธ ค่าถูกบันทึกได้ แล้วคืนค่าเดิม
    {
      const admin = await testUser('admin.test@')
      const SB = process.env.HTTP_TEST_SUPABASE_URL || 'http://127.0.0.1:8055'
      const grant = await fetch(SB + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { apikey: cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: admin.email, password: admin.password }) })
      const token = (await grant.json()).access_token
      const save = (params) => fetch(BASE + '/api/health/rule', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ id: 'line-oa-silence', params }) })
      const before = await one(`select params->>'minutes' from inbox.monitor_rule where id='line-oa-silence'`)
      const bad = await save({ minutes: 0 })
      const badHour = await fetch(BASE + '/api/health/rule', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ id: 'line-oa-silence', hour_from: 20, hour_to: 6 }) })
      const good = await save({ minutes: 30 })
      const stored = await one(`select params->>'minutes' from inbox.monitor_rule where id='line-oa-silence'`)
      await save({ minutes: Number(before) })
      ck(68, 'แก้กฎ: ค่า <1 กับช่วงเวลากลับด้านถูกปฏิเสธ ค่าถูกบันทึกและคืนค่าเดิมได้',
        bad.status === 400 && badHour.status === 400 && good.status === 200
          && stored === '30' && Number(before) > 0,
        `ค่า 0 → ${bad.status} · ชั่วโมงกลับด้าน → ${badHour.status} · 30 นาที → ${good.status} · คืนค่า ${before}→${await one(`select params->>'minutes' from inbox.monitor_rule where id='line-oa-silence'`)}`)
    }

    // ── 69 /admin/health คือหน้าเดียวกับแอปหลัก — ไม่มีหน้าล็อกอินแยกของระบบเช็คอีกต่อไป
    {
      const r = await fetch(BASE + '/admin/health')
      const html = await r.text()
      const shell = r.status === 200 && html.includes('id="app-nav"') && html.includes('id="workspace"')
      const noStandalone = !html.includes('health-token') && !html.includes('id="email"') && !html.includes('id="testBtn"')
      ck(69, '/admin/health เสิร์ฟเปลือกแอปหลัก (nav/header เดิม) ไม่มีฟอร์มล็อกอินแยก',
        shell && noStandalone, `HTTP ${r.status} · เปลือกหลัก ${shell} · standalone ${noStandalone ? 'หายไปแล้ว' : 'ยังอยู่'}`)
    }
    // ── 70 admin ล็อกอินแล้วเปิดหน้าเดิมได้ — เปลือกเดียวกับหน้าจอทีม
    {
      const admin = await testUser('admin.test@')
      const a = await login(BASE, admin)
      const r = await fetch(BASE + '/admin/health', { headers: { cookie: a.cookie } })
      const html = await r.text()
      ck(70, 'admin เข้า /admin/health ด้วยเซสชันเดิมและเห็นเปลือกแอปหลัก',
        r.status === 200 && html.includes('id="app-nav"'), `HTTP ${r.status}`)
    }
    // ── 71 manager ดูสถานะระบบได้ แต่บันทึกกฎถูกปฏิเสธ (ด่านแก้อยู่ใน health_rule_save)
    {
      const mgr = await testUser('manager.test@')
      const m = await login(BASE, mgr)
      const view = await fetch(BASE + '/api/admin/system-health', { headers: { cookie: m.cookie } })
      const save = await fetch(BASE + '/api/admin/health-rule', { method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: BASE, cookie: m.cookie },
        body: JSON.stringify({ id: 'line-oa-silence', enabled: true }) })
      ck(71, 'manager เปิดดูสถานะระบบได้ แต่บันทึกกฎโดนปฏิเสธ',
        view.status === 200 && save.status >= 400 && save.status < 500,
        `ดู ${view.status} · บันทึก ${save.status}`)
    }
    // ── 72 admin บันทึกกฎผ่านเซสชันเดิม อ่านใหม่ค่าคงอยู่ แล้วคืนค่าเดิม
    {
      const admin = await testUser('admin.test@')
      const a = await login(BASE, admin)
      const before = await one(`select params->>'minutes' from inbox.monitor_rule where id='line-oa-silence'`)
      const save = (body) => fetch(BASE + '/api/admin/health-rule', { method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: BASE, cookie: a.cookie }, body: JSON.stringify(body) })
      const r1 = await save({ id: 'line-oa-silence', params: { minutes: 45 } })
      const view = await fetch(BASE + '/api/admin/system-health', { headers: { cookie: a.cookie } })
      const body = await view.json().catch(() => ({}))
      const rule = (body.rules ?? []).find(x => x.id === 'line-oa-silence')
      const persisted = view.status === 200 && rule && Number(rule.params?.minutes) === 45
      const back = await save({ id: 'line-oa-silence', params: { minutes: Number(before) } })
      const after = await one(`select params->>'minutes' from inbox.monitor_rule where id='line-oa-silence'`)
      ck(72, 'admin บันทึกกฎผ่านเซสชันเดิม รีเฟรชแล้วค่าคงอยู่ และคืนค่าเดิมได้',
        r1.status === 200 && persisted && back.status === 200 && Number(after) === Number(before),
        `บันทึก ${r1.status} · คงอยู่ ${persisted} · คืนค่า ${after}→${before}`)
    }
  } finally {
    for (const s of extraServers) { s.child.kill('SIGTERM'); await rm(s.dir, { recursive: true, force: true }).catch(() => {}) }
    if (server) { server.child.kill('SIGTERM'); await rm(server.dir, { recursive: true, force: true }).catch(() => {}) }
    await teardown(scene).catch(e => console.error('ลบของทดสอบไม่สำเร็จ:', e.message))
  }

  const pass = results.filter(r => r.ok).length
  console.log('')
  for (const r of results) console.log(` ${r.ok ? '[ ผ่าน  ]' : '[ ไม่ผ่าน ]'} ${String(r.no).padStart(2)}  ${r.name}${r.ok ? '' : '  — ' + r.detail}`)
  console.log(`\n รวม ${results.length} ข้อ · ผ่าน ${pass} · ล้ม ${results.length - pass}\n`)
  if (pass !== results.length) process.exitCode = 1
}

main().catch(e => { console.error('\nชุดทดสอบล้มกลางคัน:', e.message, '\n'); process.exitCode = 1 })
