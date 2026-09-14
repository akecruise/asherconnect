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

async function testUser() {
  const raw = await readFile(join(root, '..', '.asher-test-users'), 'utf8')
  const line = raw.split(/\r?\n/).find(l => l.startsWith('sales.a.test@'))
  if (!line) throw new Error('ไม่พบบัญชีทดสอบ — รัน node scripts/seed-test-users.mjs --apply ก่อน')
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

    // ── 10-18 ประตูของหน้าจอ หลังถอดชั้นล็อกอินออก
    //    ด่านที่เหลือไม่ใช่ "คุณเป็นใคร" แล้ว แต่เป็น "คำขอนี้มาจากหน้าเว็บของเราจริงไหม"
    {
      const r = await command('bootstrap', {})
      ck(10, 'ไม่มีล็อกอิน: เปิดมาก็เรียกคำสั่งได้ทันที', r.status === 200, `HTTP ${r.status} ${r.body.slice(0, 80)}`)
    }
    {
      const r = await post('/api/login', JSON.stringify(user), { origin: BASE })
      ck(11, 'ทางเข้า /api/login ถูกถอดออกแล้ว', r.status === 404, `HTTP ${r.status}`)
    }
    {
      // ไม่มีเซสชันรายคนแล้ว จึงต้องไม่มีคุกกี้อะไรติดกลับไปให้เบราว์เซอร์เก็บ
      const r = await command('bootstrap', {})
      ck(12, 'ไม่มีคุกกี้เซสชันติดกลับไปอีกต่อไป', !r.headers.get('set-cookie'),
        'ได้ ' + (r.headers.get('set-cookie') || '(ไม่มี)'))
    }
    {
      // เว็บอื่นที่ผู้ใช้เปิดค้างไว้ สั่งงานบริการนี้ผ่านเบราว์เซอร์ของผู้ใช้ไม่ได้
      const r = await post('/api/command', JSON.stringify({ action: 'bootstrap', data: {} }),
        { origin: 'https://evil.example' })
      ck(13, 'คำสั่งจากเว็บอื่นถูกปฏิเสธ', r.status === 403, `HTTP ${r.status} ${r.body}`)
    }
    {
      const r = await command('bootstrap', {})
      const body = JSON.parse(r.body || '{}')
      ck(14, 'bootstrap คืนตัวตนของบัญชีที่บริการใช้ และรายการช่องทาง',
        r.status === 200 && body.user?.email === user.email && Array.isArray(body.channels) && body.channels.length === 2,
        `HTTP ${r.status}`)
    }
    {
      const r = await command('ทำลายโลก', { id: scene.conv })
      ck(15, 'คำสั่งที่ไม่มีอยู่จริงถูกปฏิเสธ', r.status >= 400 && !r.body.includes('unknown_action'),
        `HTTP ${r.status} ${r.body} (ห้ามหลุดรายละเอียดภายในออกมา)`)
    }
    {
      // สวิตช์ปิดฉุกเฉิน: ปิดช่องทางในฐานแล้วต้องส่งอะไรไม่ได้ทันที ทั้งที่ session ยังอยู่
      await sql(`update inbox.inbox set is_active=false where id='${scene.lineInbox}'`)
      const r = await command('send', { id: scene.conv, request_id: randomUUID(), text: 'ทดสอบหลังปิดช่องทาง' })
      await sql(`update inbox.inbox set is_active=true where id='${scene.lineInbox}'`)
      ck(16, 'ปิดช่องทางในฐานแล้วส่งข้อความไม่ได้ทันที (สวิตช์ฉุกเฉิน)',
        r.status >= 400 && r.body.includes('channel_disabled'), `HTTP ${r.status} ${r.body}`)
    }
    {
      const r = await post('/api/command', JSON.stringify({ action: 'bootstrap', data: { ขยะ: 'x'.repeat(300_000) } }),
        { origin: BASE })
      ck(17, 'คำสั่งที่ใหญ่เกิน 256KB ถูกตัด', r.status === 413 || r.status === 400, `HTTP ${r.status}`)
    }
    {
      const r = await post('/api/logout', '{}', { origin: BASE })
      ck(18, 'ทางออก /api/logout ถูกถอดออกแล้ว', r.status === 404, `HTTP ${r.status}`)
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

      const sent = await fetch(s2.base + '/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: s2.base },
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
      const r = await command('bootstrap', {})
      ck(28, 'ล็อกอินบัญชีเดียวกันจากที่อื่น แล้วหน้าจอยังใช้งานต่อได้',
        again.status === 200 && r.status === 200, `ล็อกอินซ้ำ ${again.status} · คำสั่งถัดมา ${r.status}`)
    }

    // ── 29 ตอนเพิ่งบูตยังไม่มี token อยู่ในมือ หน้าเว็บยิงหลายคำขอพร้อมกันทันทีที่เปิด
    //    ถ้าปล่อยให้ต่างคนต่างล็อกอิน จะกดทับกันเองจนเข้าไม่ได้ ทั้งที่แต่ละคำขอถูกต้อง
    {
      const s5 = await startServer(scene, cfg, {}, PORT + 3)
      extraServers.push(s5)
      const shoot = () => fetch(s5.base + '/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: s5.base },
        body: JSON.stringify({ action: 'bootstrap', data: {} }) }).then(r => r.status).catch(() => 0)
      const many = await Promise.all([1, 2, 3, 4, 5, 6].map(shoot))
      ck(29, 'ยิงพร้อมกันตอนเพิ่งบูต ไม่กดทับกันเอง', many.every(v => v === 200), 'ได้ ' + many.join(' '))
    }

    // ── 30 หน้าเว็บกับเซิร์ฟเวอร์ต้องเล่าเรื่องเดียวกัน
    //    ถ้าหน้าจอยังมีฟอร์มล็อกอินค้างอยู่ทั้งที่ฝั่งเซิร์ฟเวอร์ถอดออกแล้ว คนใช้จะเจอฟอร์มที่กดแล้วไม่มีอะไรเกิดขึ้น
    {
      const page = await (await fetch(BASE + '/')).text()
      const app = await (await fetch(BASE + '/app.js')).text()
      ck(30, 'หน้าเว็บไม่มีร่องรอยหน้าล็อกอินหลงเหลือ',
        !page.includes('id="login"') && !page.includes('id="logout"') && !app.includes('/api/login'),
        'ยังเจอใน ' + [page.includes('id="login"') && 'index.html:login',
                       page.includes('id="logout"') && 'index.html:logout',
                       app.includes('/api/login') && 'app.js'].filter(Boolean).join(' · '))
    }

    // ── 31-33 ทางไป Edge Function
    //    โปรแกรมจะทยอยย้ายลงมาทีละตัว ทางนี้จึงต้องรับของใหม่ได้โดยไม่ต้องแก้โค้ด
    //    และต้องไม่กลายเป็นประตูหลังที่ยิงถึงทุกฟังก์ชันในโปรเจกต์
    {
      const r = await command('fn:ยังไม่ได้ลงทะเบียน', {})
      ck(31, 'Edge Function ที่ไม่อยู่ในทะเบียน เรียกไม่ได้',
        r.status === 404 && r.body.includes('function_not_registered'), `HTTP ${r.status} ${r.body}`)
    }
    {
      // ยิงถึงฟังก์ชันจริงที่รันอยู่ ไม่ใช่ของปลอม — ไม่มีลายเซ็นจึงต้องถูกฟังก์ชันปฏิเสธเอง
      const r = await command('fn:webhook-receiver', { hello: 'จากเทสต์' })
      ck(32, 'Edge Function ในทะเบียน ถูกเรียกถึงจริง',
        r.status >= 400 && r.status < 500 && r.body.includes('error'), `HTTP ${r.status} ${r.body.slice(0, 120)}`)
    }
    {
      // คำตอบของโปรแกรมต้องมาถึงหน้าจอทั้งอย่างนั้น ไม่ถูกยุบเป็น request_rejected ของชั้นนี้
      const r = await command('fn:webhook-receiver', {})
      ck(33, 'คำตอบของ Edge Function ไม่ถูกชั้นนี้ตีความใหม่',
        !r.body.includes('request_rejected') && !r.body.includes('service_unavailable'), r.body.slice(0, 120))
    }

    // ── 34 /health บอกได้ว่าตอนนี้รับโปรแกรมอะไรลงมาแล้วบ้าง
    {
      const h = await (await fetch(BASE + '/health')).json()
      ck(34, '/health บอกทะเบียน Edge Function และบัญชีที่ใช้ทำงาน',
        Array.isArray(h.edgeFunctions) && h.edgeFunctions.includes('webhook-receiver') && h.account === user.email,
        JSON.stringify(h))
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
