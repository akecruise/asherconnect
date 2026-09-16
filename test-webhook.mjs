#!/usr/bin/env node
//
// ยิง webhook ปลอมใส่ ASHER Connect ตัวที่รันอยู่จริง แล้วตามไปดูในฐานว่าของเข้าครบไหม
//
//   node test-webhook.mjs                               ยิงใส่ 127.0.0.1:3200 ช่องทางแรกที่เปิดใช้
//   node test-webhook.mjs --channel asher-messenger     เลือกช่องทาง
//   node test-webhook.mjs --keep                        ไม่เก็บกวาด เอาไว้เปิด Workspace ดูด้วยตา
//   node test-webhook.mjs --cleanup-only __wht__1a2b3c4d   ลบของที่ --keep ทิ้งไว้
//
// ★ ทดสอบตัวบน VPS: พอร์ต 3200 ผูกไว้ที่ 127.0.0.1 เท่านั้น ยิงจากข้างนอกไม่ถึง
//   ต้องเปิดอุโมงค์ก่อน แล้วบอกให้คำสั่งฐานวิ่งผ่าน ssh ด้วย
//
//     ssh -N -L 3200:127.0.0.1:3200 root@187.53.139.175 &
//     node test-webhook.mjs --ssh root@187.53.139.175
//
//   (หรือ scp ไฟล์นี้ขึ้นไปรันบนเครื่องนั้นเลย ก็ไม่ต้องใช้ทั้งอุโมงค์และ --ssh)
//
// ต่างจาก tests/http.integration.mjs ตรงที่ชุดนั้นยกเซิร์ฟเวอร์ของตัวเองขึ้นมาด้วย secret ปลอม
// ส่วนไฟล์นี้ยิงใส่ "ตัวที่รันอยู่" ด้วย secret จริงจาก channels.json — จึงตอบคำถามคนละข้อ:
// ไม่ใช่ "โค้ดถูกไหม" แต่เป็น "ของที่เพิ่ง deploy ไป ใช้ได้จริงไหม"
//
// ★ ไฟล์นี้เขียนลงฐานจริง ไม่มี transaction ให้ rollback เพราะคุยผ่าน HTTP
//   ของทุกชิ้นติดป้าย __wht__<สุ่ม> เฉพาะรอบนั้น และถูกลบตอนจบเสมอ แม้จะล้มกลางคัน
//   ใช้ป้ายไม่ซ้ำแทนป้ายคงที่ เพราะยิงพร้อมกันสองหน้าต่างแล้วต้องไม่ลบของกันเอง
//
// ★ ไม่มีข้อความออกไปหาลูกค้าจริง ขาออกเป็นคนละเส้นทาง (connect_private.delivery)
//   และถ้า CONNECT_SHADOW_MODE=true ก็ถูกกันไว้อีกชั้นตั้งแต่ต้นทาง
//   แต่ผู้ใช้ปลอมที่สร้างขึ้นจะโผล่ในกล่องของทีมจริง ๆ จนกว่าจะเก็บกวาด

import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf('--' + name)
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const flag = name => argv.includes('--' + name)

const BASE    = arg('base', process.env.CONNECT_TEST_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '')
const SSH     = arg('ssh', process.env.CONNECT_TEST_SSH || null)
const DB      = arg('db', 'supabase-db')
const CHFILE  = arg('channels', join(root, 'channels.json'))
const TIMEOUT = Number(arg('timeout', 30000))
const KEEP    = flag('keep')
const FULL    = flag('full')

const TAG_RE = /^__wht__[0-9a-f]{8}$/

const results = []
const ck = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); return !!ok }

// ── คุยกับฐานผ่าน container เพื่อไม่ต้องมี pg client บนเครื่อง
//
// ต่อ ssh ให้ด้วยเมื่อฐานอยู่คนละเครื่องกับที่รันสคริปต์ ซึ่งเป็นกรณีปกติเวลาทดสอบของบน VPS
const shq = s => `'` + String(s).replace(/'/g, `'\\''`) + `'`
async function sql(text) {
  const parts = ['docker', 'exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', text]
  const { stdout } = SSH
    ? await run('ssh', ['-o', 'BatchMode=yes', SSH, parts.map(shq).join(' ')], { maxBuffer: 8 << 20 })
    : await run(parts[0], parts.slice(1), { maxBuffer: 8 << 20 })
  return stdout.trim().split('\n').filter(Boolean).map(line => line.split('|'))
}
const one = async text => (await sql(text))[0]?.[0] ?? null

// ── เก็บกวาด: ลบจากปลายทางย้อนกลับมาต้นทาง ไม่งั้นติด foreign key
//
// ผูกกับ external_id ของรอบนั้นแบบตรงตัว ไม่ใช่ like '%test%'
// เพราะฐานนี้มีลูกค้าจริงอยู่ด้วย เผลอกวาดโดนคือลบบทสนทนาจริงทิ้ง
const cleanupSql = (extId, tag) => `
  begin;
  create temp table _ct on commit drop as
    select distinct contact_id as id from core.contact_identity where external_id = '${extId}';
  create temp table _c on commit drop as
    select id from inbox.conversation where contact_id in (select id from _ct);
  create temp table _l on commit drop as
    select id from crm.lead where contact_id in (select id from _ct)
       or extra->>'connect_conversation_id' in (select id::text from _c);
  delete from connect_private.delivery d using inbox.message m
    where d.message_id = m.id and m.conversation_id in (select id from _c);
  delete from connect_private.command    where conversation_id in (select id from _c);
  delete from connect_private.audit      where conversation_id in (select id from _c);
  delete from connect_private.case_state where conversation_id in (select id from _c);
  delete from crm.activity   where conversation_id in (select id from _c) or lead_id in (select id from _l);
  delete from core.event_log where entity_id in (select id from _c) or entity_id in (select id from _l);
  delete from connect_private.inbound_event where event_id like '${tag}%';
  delete from inbox.message      where conversation_id in (select id from _c);
  delete from inbox.conversation where id in (select id from _c);
  delete from crm.lead           where id in (select id from _l);
  delete from core.contact_identity where external_id = '${extId}';
  delete from core.contact          where id in (select id from _ct);
  delete from connect_private.webhook_log where payload::text like '%${tag}%';
  commit;`

async function loadChannels() {
  const parsed = JSON.parse(await readFile(CHFILE, 'utf8'))
  return Array.isArray(parsed) ? parsed : (parsed.channels || [])
}

async function pickChannel() {
  const all = await loadChannels()
  const want = arg('channel')
  const hit = want ? all.find(c => c.key === want) : all.find(c => c.enabled)
  if (!hit) {
    const names = all.map(c => `${c.key}${c.enabled ? '' : ' (ปิดอยู่)'}`).join(', ')
    throw new Error(want ? `ไม่มีช่องทาง "${want}" ใน ${CHFILE} — มีอยู่: ${names}` : `ไม่มีช่องทางที่เปิดใช้ใน ${CHFILE}`)
  }
  // ตกสองด่านนี้แล้วอาการจะไปโผล่เป็น 401 หรือ 400 ซึ่งอ่านไม่ออกว่าเพราะ config ไม่ครบ
  if (!hit.secret) throw new Error(`ช่องทาง ${hit.key} ไม่มี secret ใน channels.json — ลงลายเซ็นให้ไม่ได้`)
  if (!hit.account_id) throw new Error(`ช่องทาง ${hit.key} ไม่มี account_id — จะตกด่าน "ส่งผิดบ้าน" (400) เสมอ`)
  return hit
}

// ── ก้อนข้อมูลแบบเดียวกับที่ LINE/Meta ส่งมาจริง
//
// destination (LINE) และ entry[].id (Meta) ต้องตรงกับ account_id ที่ตั้งไว้
// ไม่งั้นตกด่าน matchesDestination เป็น 400 ก่อนถึงฐาน
const bodyFor = (cfg, userId, tag, text, stamp) => cfg.channel === 'line'
  ? JSON.stringify({
      destination: cfg.account_id,
      events: [{
        type: 'message', mode: 'active', timestamp: stamp,
        webhookEventId: `${tag}-ev`,
        deliveryContext: { isRedelivery: false },
        source: { type: 'user', userId },
        replyToken: '0'.repeat(32),
        message: { id: `${tag}-msg`, type: 'text', text },
      }],
    })
  : JSON.stringify({
      object: 'page',
      entry: [{
        id: cfg.account_id, time: stamp,
        messaging: [{
          sender: { id: userId }, recipient: { id: cfg.account_id }, timestamp: stamp,
          message: { mid: `${tag}-msg`, text },
        }],
      }],
    })

// LINE = base64 · Meta = hex แล้วนำหน้าด้วย sha256=  (ตรงกับ verifySignature ใน providers.mjs)
const sign = (raw, secret, channel) => channel === 'line'
  ? createHmac('sha256', secret).update(raw).digest('base64')
  : 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

async function post(cfg, raw, signature) {
  const headers = { 'Content-Type': 'application/json' }
  if (signature != null) headers[cfg.channel === 'line' ? 'X-Line-Signature' : 'X-Hub-Signature-256'] = signature
  try {
    const r = await fetch(`${BASE}/webhooks/${encodeURIComponent(cfg.key)}`, { method: 'POST', headers, body: raw })
    return { status: r.status, body: (await r.text()).slice(0, 300) }
  } catch (e) {
    throw new Error(`ต่อ ${BASE} ไม่ได้ (${e.cause?.code || e.message})` +
      (SSH ? ` — ใช้ --ssh อยู่ อย่าลืมเปิดอุโมงค์: ssh -N -L 3200:127.0.0.1:3200 ${SSH}` : ''))
  }
}

/**
 * รอให้คิวขาเข้าของรอบนี้ว่าง
 *
 * webhook ตอบ 200 ตั้งแต่ตอนเก็บของดิบ งานจริงเกิดทีหลังในรอบของ worker
 * ถ้าเช็คฐานทันทีหลังได้ 200 จะเจอศูนย์แถวแล้วสรุปผิดว่าโค้ดพัง
 */
async function settle(tag, timeout = TIMEOUT) {
  const until = Date.now() + timeout
  let last = []
  while (Date.now() < until) {
    last = await sql(`select status, coalesce(last_error,'') from connect_private.webhook_log
                       where payload::text like '%${tag}%'`)
    if (last.length && last.every(r => r[0] === 'done' || r[0] === 'failed')) return last
    await new Promise(r => setTimeout(r, 300))
  }
  return last
}

/**
 * ชุดเต็มของ LINE — ชนิดข้อความ · กันยิงซ้ำ · ความเร็วที่ตอบ 200
 *
 * แยกออกมาเป็น --full เพราะชุดหลักต้องเบาพอจะยิงทุกครั้งที่แก้โค้ด
 * ส่วนชุดนี้ยิงหลายก้อนติดกัน ใช้ตอนตรวจรับก่อนเปิดใช้จริงมากกว่า
 */
async function fullLineSuite(cfg, userId, tag, stamp) {
  const envelope = events => JSON.stringify({ destination: cfg.account_id, events })
  const ev = (id, extra) => ({
    type: 'message', mode: 'active', timestamp: stamp,
    webhookEventId: id, deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId }, replyToken: '0'.repeat(32), ...extra,
  })

  // content_type ที่คาดไว้มาจาก lineMessageContent() ใน providers.mjs
  // image ไม่มีสาขาของตัวเอง ตกลงมาที่กิ่ง generic จึงได้ชื่อชนิดตามที่ LINE ส่งมา
  const cases = [
    ['sticker',  ev(`${tag}-sticker`,  { message: { id: 'm1', type: 'sticker', packageId: '446', stickerId: '1988' } }), 'sticker'],
    ['image',    ev(`${tag}-image`,    { message: { id: 'm2', type: 'image', contentProvider: { type: 'line' } } }),     'image'],
    ['location', ev(`${tag}-location`, { message: { id: 'm3', type: 'location', title: 'คอนโด', address: 'สุขุมวิท', latitude: 13.7, longitude: 100.5 } }), 'location'],
    ['follow',   { type: 'follow',   mode: 'active', timestamp: stamp, webhookEventId: `${tag}-follow`,   deliveryContext: { isRedelivery: false }, source: { type: 'user', userId }, replyToken: '0'.repeat(32) }, 'follow'],
    ['unfollow', { type: 'unfollow', mode: 'active', timestamp: stamp, webhookEventId: `${tag}-unfollow`, deliveryContext: { isRedelivery: false }, source: { type: 'user', userId } }, 'unfollow'],
  ]

  for (const [name, event, want] of cases) {
    const raw = envelope([event])
    const r = await post(cfg, raw, sign(raw, cfg.secret, cfg.channel))
    if (r.status !== 200) { ck(`รับ ${name}`, false, `HTTP ${r.status} ${r.body}`); continue }
    await settle(tag)
    const got = await one(`select content_type from inbox.message
                            where external_message_id = '${tag}-${name}'`)
    ck(`รับ ${name} แล้วบันทึกเป็น content_type=${want}`, got === want, got ? `ได้ ${got}` : 'ไม่เจอแถว')
  }

  // ── ยิง event เดิมซ้ำ ต้องไม่เกิดแถวที่สอง
  //
  // LINE ยิงซ้ำเองทุกครั้งที่ไม่ได้ 200 ในเวลาที่กำหนด ถ้ากันไม่อยู่
  // ลูกค้าจะเห็นข้อความตัวเองสองครั้งและสถิติจะเพี้ยนตามไปหมด
  {
    const raw = envelope([ev(`${tag}-sticker`, { message: { id: 'm1', type: 'sticker', packageId: '446', stickerId: '1988' } })])
    const r = await post(cfg, raw, sign(raw, cfg.secret, cfg.channel))
    await settle(tag)
    const n = await one(`select count(*) from inbox.message where external_message_id='${tag}-sticker'`)
    ck('ยิง event เดิมซ้ำ ไม่เกิดแถวซ้ำ', r.status === 200 && Number(n) === 1, `HTTP ${r.status} · ในฐาน ${n} แถว`)
  }

  // ── ต้องตอบ 200 ก่อนลงมือทำงานหนัก
  //
  // LINE ถือสายรออยู่และยิงซ้ำทั้งก้อนถ้าช้าเกิน ค่าที่วัดได้จึงต้องเป็นเวลาของ
  // "เก็บของดิบแล้วตอบ" ไม่ใช่เวลาที่ประมวลผลจนจบ
  {
    const raw = envelope([ev(`${tag}-speed`, { message: { id: 'm9', type: 'text', text: 'วัดความเร็ว' } })])
    const t0 = Date.now()
    const r = await post(cfg, raw, sign(raw, cfg.secret, cfg.channel))
    const ms = Date.now() - t0
    ck('ตอบ 200 ภายใน 1 วินาที', r.status === 200 && ms < 1000, `${ms} ms`)
    await settle(tag)
  }
}

async function runTest() {
  const cfg = await pickChannel()
  const tag = '__wht__' + randomBytes(4).toString('hex')
  const stamp = Date.now()
  // รูปแบบ id ไม่ถูกตรวจ แต่ทำให้อ่านออกว่าเป็นของเทสต์ เผื่อเก็บกวาดพลาดแล้วมีคนมาเจอทีหลัง
  const userId = (cfg.channel === 'line' ? 'U' : '') + tag
  const text = `[เทสต์ระบบ ${tag}] สนใจห้อง 1 นอน ราคาเท่าไหร่ครับ`

  console.log(`ช่องทาง    ${cfg.key} (${cfg.channel}) · inbox ${cfg.inbox_id}`)
  console.log(`ปลายทาง    ${BASE}/webhooks/${cfg.key}${SSH ? ` · ฐานผ่าน ssh ${SSH}` : ''}`)
  console.log(`ป้ายรอบนี้  ${tag}\n`)

  let conv = null
  try {
    // ── ลายเซ็นผิด: ต้องถูกปฏิเสธ และห้ามมีอะไรตกถึงฐาน
    //
    // ใช้ป้ายคนละอันกับของจริง จะได้แยกออกว่าแถวในฐานมาจากการยิงครั้งไหน
    {
      const raw = bodyFor(cfg, userId, tag + '-bad', 'ก้อนนี้ลายเซ็นผิด ไม่ควรเข้าระบบ', stamp)
      const r = await post(cfg, raw, sign(raw, 'ไม่ใช่ secret ตัวจริง', cfg.channel))
      ck('ลายเซ็นผิดถูกปฏิเสธด้วย 401', r.status === 401, `HTTP ${r.status} ${r.body}`)

      const leaked = await one(`select count(*) from connect_private.webhook_log
                                 where payload::text like '%${tag}-bad%'`)
      ck('ลายเซ็นผิดแล้วไม่มีอะไรเข้าฐาน', Number(leaked) === 0, `${leaked} แถวใน webhook_log`)
    }

    // ── ไม่ส่งลายเซ็นมาเลย ก็ต้องตกเหมือนกัน
    {
      const raw = bodyFor(cfg, userId, tag + '-nosig', 'ก้อนนี้ไม่มีลายเซ็น', stamp)
      const r = await post(cfg, raw, null)
      ck('ไม่ส่งลายเซ็นมาถูกปฏิเสธด้วย 401', r.status === 401, `HTTP ${r.status} ${r.body}`)
    }

    // ── ลายเซ็นถูก: ต้องได้ 200 แล้วของไหลถึงฐานครบสาย
    const raw = bodyFor(cfg, userId, tag, text, stamp)
    const r = await post(cfg, raw, sign(raw, cfg.secret, cfg.channel))
    ck('ลายเซ็นถูกได้ 200 accepted', r.status === 200 && r.body.includes('accepted'), `HTTP ${r.status} ${r.body}`)

    const queue = await settle(tag)
    const seen = queue.map(q => q[0]).join(',') || '(ไม่มีแถวในคิว)'
    const err = queue.map(q => q[1]).filter(Boolean).join(' · ')
    ck('worker ประมวลผลจนจบ', queue.length > 0 && queue.every(q => q[0] === 'done'),
      `status=${seen}${err ? ` · ${err}` : ''}`)

    const contact = await one(`select ci.contact_id from core.contact_identity ci
                                where ci.external_id = '${userId}' and ci.channel = '${cfg.channel}'`)
    ck('สร้าง contact_identity แล้ว', Boolean(contact), contact ? `contact ${contact}` : 'ไม่เจอ')

    conv = contact && await one(`select id from inbox.conversation
                                  where contact_id = '${contact}' order by created_at desc limit 1`)
    ck('สร้าง conversation แล้ว', Boolean(conv), conv ? `conversation ${conv}` : 'ไม่เจอ')

    // เช็คจาก conversation ไม่ใช่จาก external_message_id ที่เราเดาเอง
    //
    // ★ id ที่ถูกเก็บเป็นคนละตัวกันในแต่ละช่องทาง: LINE ใช้ webhookEventId ส่วน Messenger ใช้ mid
    //   (providers.mjs:96 กับ :197) ถ้าผูกเช็คไว้กับตัวใดตัวหนึ่ง เทสต์จะแดงเพราะเดาผิด
    //   ไม่ใช่เพราะโค้ดพัง — ซึ่งแย่กว่าไม่มีเทสต์ เพราะทำให้ไม่เชื่อผลอีกต่อไป
    if (FULL && cfg.channel === 'line') await fullLineSuite(cfg, userId, tag, stamp)

    const msg = conv ? await sql(`select sender_type, content, coalesce(external_message_id,'-')
                                    from inbox.message where conversation_id = '${conv}'`) : []
    const mine = msg.filter(m => m[1] === text)
    ck('สร้าง message แล้ว และเป็นฝั่งลูกค้า',
      mine.length === 1 && mine[0][0] === 'contact',
      mine.length ? `sender_type=${mine[0][0]} · external_message_id=${mine[0][2]}`
                  : `ไม่เจอข้อความ (ในบทสนทนามี ${msg.length} ข้อความ)`)
  } finally {
    if (KEEP) {
      if (conv) console.log(`\nเปิดดูในกล่องได้ที่ conversation ${conv}`)
      console.log(`--keep : ไม่เก็บกวาด ของยังอยู่ในฐาน ลบเองภายหลังด้วย`)
      console.log(`  node test-webhook.mjs --cleanup-only ${tag}${SSH ? ` --ssh ${SSH}` : ''}`)
    } else {
      await sql(cleanupSql(userId, tag))
      console.log('\nเก็บกวาดแล้ว (ใช้ --keep ถ้าอยากให้ของค้างไว้เปิด Workspace ดู)')
    }
  }
}

async function cleanupOnly(tag) {
  if (!TAG_RE.test(tag)) {
    console.error('ต้องระบุป้ายรูปแบบ __wht__ ตามด้วยเลขฐานสิบหกแปดตัว — กันไม่ให้เผลอลบของจริง')
    process.exit(2)
  }
  // ไม่รู้ว่าป้ายนั้นมาจากช่องทางไหน จึงลบทั้งสองรูปแบบของ external_id
  for (const extId of ['U' + tag, tag]) await sql(cleanupSql(extId, tag))
  console.log(`ลบของที่ป้าย ${tag} แล้ว`)
}

const only = arg('cleanup-only')
if (flag('cleanup-only')) {
  await cleanupOnly(only ?? '')
} else {
  let failed = false
  try {
    await runTest()
  } catch (e) {
    console.error('\nล้ม:', e.message)
    failed = true
  }
  const bad = results.filter(x => !x.ok)
  console.log('')
  for (const x of results) console.log(`  ${x.ok ? 'ผ่าน   ' : 'ไม่ผ่าน'}  ${x.name}${x.detail ? ` — ${x.detail}` : ''}`)
  console.log(`\n${results.length - bad.length}/${results.length} ผ่าน`)
  process.exit(failed || bad.length ? 1 : 0)
}
