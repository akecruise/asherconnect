/**
 * ASHER Connect — ชั้นแอปที่คั่นระหว่างเบราว์เซอร์/ผู้ให้บริการแชท กับ Supabase
 *
 * โครงของไฟล์นี้แบ่งตาม "ชั้นที่พังได้" ไม่ใช่ตามชนิดของโค้ด เพราะบทเรียนจากของเดิมคือ
 * เวลามีอะไรพัง สิ่งที่ต้องรู้ก่อนเสมอคือ *ชั้นไหน* พัง แล้วค่อยดูว่าเพราะอะไร
 *
 *   ตั้งค่า → log → ข้อผิดพลาด → คุยกับ Supabase → บัญชีของบริการ → คิวขาออก → คิวขาเข้า → เส้นทาง
 *
 * กติกาสามข้อที่ทั้งไฟล์นี้ยึด
 *   1. ไม่มี catch ไหนที่ทิ้ง error โดยไม่บันทึก — catch ที่ไม่รับตัว error คือการทำลายหลักฐาน
 *   2. เบราว์เซอร์ได้รับเฉพาะ code ที่อยู่ใน safeCodes ส่วนรายละเอียดจริงอยู่ใน log ฝั่งนี้เท่านั้น
 *      ยกเว้นทางเดียวคือคำตอบของ Edge Function ซึ่งเป็นของโปรแกรมนั้น เราส่งต่อโดยไม่ตีความ
 *   3. /health ต้องตอบว่า "ไม่ไหว" ได้จริง ไม่งั้นมันไม่ใช่สถานะสุขภาพ เป็นแค่การบอกว่าพอร์ตยังเปิด
 *
 * ไม่มีชั้นล็อกอินแล้ว — ทั้งบริการทำงานในนามบัญชีเดียว ดูเหตุผลและขอบเขตที่หัวข้อ "ตั้งค่า"
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySignature, matchesDestination, normalizeWebhook, deliver } from './providers.mjs'

// ───────────────────────────────────────────────────────── ตั้งค่า

const root = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 3200)
const origin = new URL(process.env.CONNECT_PUBLIC_URL || `http://localhost:${port}`).origin
const upstream = process.env.SUPABASE_URL
const anon = process.env.SUPABASE_ANON_KEY
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!upstream || !anon || !service) throw new Error('Supabase configuration required')

let channels = []
if (process.env.CONNECT_CHANNELS_FILE) channels = JSON.parse(await readFile(process.env.CONNECT_CHANNELS_FILE, 'utf8'))
// ช่องทางจะ "ใช้งานได้" ก็ต่อเมื่อมีครบทั้งปลายทาง ความลับ และถูกเปิดไว้
// ขาดอย่างใดอย่างหนึ่งถือว่ายังไม่เชื่อม ดีกว่าปล่อยให้ไปพังตอนยิงจริง
const activeChannels = channels.filter(c => c.inbox_id && c.account_id && c.secret && c.access_token && c.enabled === true)

const WORKER_INTERVAL = 3000
// ไม่สำเร็จนานกว่านี้ = ตัวส่งข้อความตาย
// ตั้งค่าได้เพื่อให้ชุดทดสอบไม่ต้องรอจริงหนึ่งนาทีต่อหนึ่งข้อ
const WORKER_STALE_MS = Number(process.env.CONNECT_WORKER_STALE_MS || 60000)
const UPSTREAM_TIMEOUT = 20000
// โหมดเงา: รับสำเนาข้อความเข้ามาสะสมได้ แต่ห้ามส่งอะไรออกไปหาลูกค้าเด็ดขาด
// ใช้ตอนที่ยังมีบอทตัวเดิมตอบลูกค้าอยู่ — ถ้าเครื่องนี้ส่งด้วย ลูกค้าจะได้คำตอบสองครั้ง
// กันด้วยโครงสร้าง ไม่ใช่ด้วยข้อตกลงว่าจะไม่มีใครกดปุ่มส่ง
const shadow = process.env.CONNECT_SHADOW_MODE === 'true'

// ไม่มีชั้นล็อกอิน — ทั้งบริการทำงานในนามบัญชีเดียวที่ตั้งไว้ตรงนี้
//
// ใครเปิดหน้าเว็บนี้ได้ ก็ใช้สิทธิ์ของบัญชีนี้ได้ทันที ไม่มีด่านไหนคั่นอีก
// ด่านที่เหลือจึงไม่ใช่เรื่องของแอปแล้ว แต่เป็นเรื่องว่า *ใครต่อถึงพอร์ตนี้ได้*
// ตอนนี้ผูกไว้ที่ 127.0.0.1 ใน docker-compose.yml — ถ้าจะเปิดออกเน็ต ต้องมีด่านชั้นนอกมาแทน
//
// สิทธิ์ฝั่งฐานข้อมูลยังบังคับตามเดิมทุกข้อ เพราะยังยิงด้วย token จริงของบัญชีนี้
// ไม่ได้ปลอม JWT และไม่ได้ข้าม RLS — ที่หายไปมีอย่างเดียวคือคำถามว่า "คุณเป็นใคร"
// role ของบัญชีนี้จึงเป็นตัวกำหนดว่าหน้าจอทำอะไรได้บ้าง
const accountEmail = process.env.CONNECT_ACCOUNT_EMAIL || ''
const accountPassword = process.env.CONNECT_ACCOUNT_PASSWORD || ''
if (!accountEmail || !accountPassword) {
  throw new Error('ต้องตั้ง CONNECT_ACCOUNT_EMAIL และ CONNECT_ACCOUNT_PASSWORD — บริการนี้ทำงานในนามบัญชีเดียว')
}
// ทะเบียน Edge Function ที่หน้าจอเรียกได้ — ชื่อคั่นด้วยจุลภาคใน CONNECT_EDGE_FUNCTIONS
//
// ตั้งใจให้ "เพิ่มโปรแกรมหนึ่งตัว" = เพิ่มชื่อลงตัวแปรนี้ ไม่ใช่แก้โค้ดที่นี่
// เพราะโปรแกรมจะทยอยย้ายลงมาทีละตัว ถ้าต้องแก้ไฟล์นี้ทุกครั้ง ไฟล์นี้จะกลายเป็นคอขวด
//
// ต้องมีทะเบียน ไม่ใช่ปล่อยให้เรียกชื่ออะไรก็ได้ ไม่งั้นหน้าเว็บจะยิงถึงทุกฟังก์ชัน
// ในโปรเจกต์รวมถึงตัวที่ตั้งใจให้เรียกจากหลังบ้านเท่านั้น
const edgeFunctions = (process.env.CONNECT_EDGE_FUNCTIONS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
const badName = edgeFunctions.find(n => !/^[a-z0-9][a-z0-9._-]*$/.test(n))
if (badName) throw new Error(`ชื่อ Edge Function ใช้ไม่ได้: ${badName}`)

const startedAt = Date.now()

// ───────────────────────────────────────────────────────── log
//
// ทุกบรรทัดเป็น JSON บรรทัดเดียว เพื่อให้ grep ทีหลังได้ด้วย event
// ไม่มีที่ไหน log ตัว payload เพราะมีข้อความลูกค้าอยู่ในนั้น — เก็บแค่ว่าตกตรงไหนและเพราะอะไร

const emit = (stream, event, fields) =>
  stream(JSON.stringify({ event, at: new Date().toISOString(), ...fields }))
const log = {
  info: (event, fields = {}) => emit(console.log, event, fields),
  warn: (event, fields = {}) => emit(console.warn, event, fields),
  error: (event, fields = {}) => emit(console.error, event, fields),
}

// ───────────────────────────────────────────────────────── ข้อผิดพลาด
//
// code ที่หน้าเว็บแปลเป็นภาษาไทยได้เท่านั้นที่ถูกส่งออกไป ที่เหลือยุบเป็น request_rejected
// เพื่อไม่ให้รายละเอียดภายในรั่วออกทางหน้าจอผู้ใช้

const fail = (status, code) => Object.assign(new Error(code), { status })

const safeCodes = new Set(['not_allowed','conversation_not_found','request_id_conflict','already_assigned','case_closed','claim_required','assignee_not_allowed','version_conflict','project_required','invalid_profile','invalid_budget','invalid_interest','invalid_message','channel_disabled','message_not_found','message_not_retryable','invalid_stage','reason_required','future_appointment_required','walk_in_required','invalid_amount','unit_unavailable','sale_reference_required','booking_required','stage_transition_not_allowed','booked_project_locked'])

/**
 * ปฏิเสธ webhook พร้อมบอกเหตุผลลง log
 *
 * ทางเข้านี้คุยกับเครื่องของคนอื่น (LINE/Meta) ที่เราสั่งให้ retry หรือให้บอกอะไรเพิ่มไม่ได้
 * เวลาปลายทางบอกว่า "ยิงไปแล้วได้ 503" แล้วฝั่งเราเงียบสนิท จะไม่มีอะไรให้ดูเลย
 * ว่าคำขอมาถึงไหม และตกด่านไหน — เสียเวลาไล่กันทีละฝั่งนานมาก
 */
const webhookFail = (status, code, channel, extra = {}) => {
  log.warn('webhook_rejected', { reason: code, status, channel: channel ?? '(ไม่ได้ระบุ)', ...extra })
  return fail(status, code)
}

// ───────────────────────────────────────────────────────── คุยกับ Supabase
//
// ปลายทางสองชั้นนี้ไม่ได้ตกลงกันว่าจะวางข้อความ error ไว้ที่ไหน
//   PostgREST (ชั้นข้อมูล) ใส่ไว้ที่ "message" และใช้ 401/403 ตามสิทธิ์
//   gotrue    (ชั้นตัวตน)  ใส่ไว้ที่ "msg" และตอบ 400 ตอน refresh token ถูกหมุนไปแล้ว
//                          กับ 403 ตอน bad_jwt — ทั้งคู่แปลว่า "เซสชันหมด" ไม่ใช่ "ข้อมูลผิด"
//
// ของเดิมใช้ตัวแปลตัวเดียวที่รู้จักแค่รูปแบบของ PostgREST ผลคือเซสชันหมดอายุถูกแปลงเป็น
// "บันทึกไม่สำเร็จ กรุณาตรวจข้อมูล" แล้วหน้าเว็บก็ไม่เด้งกลับ login เพราะมันดูแค่ 401
// ตรงนี้จึงบังคับให้ผู้เรียก *ระบุชั้น* มาเสมอ แทนที่จะให้ตัวแปลเดาเอาจากหน้าตาของ path

const AUTH = 'auth', DATA = 'data'

async function callSupabase(layer, path, { token = anon, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${upstream}${path}`, {
    method,
    headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
  const data = await response.json().catch(() => ({}))
  if (response.ok) return data

  const reason = data.message ?? data.msg ?? ''
  // เหตุที่เราออกแบบไว้แล้ว ส่งต่อให้หน้าเว็บได้ตรง ๆ ไม่ต้อง log เพราะไม่ใช่ความผิดปกติ
  if (safeCodes.has(reason)) throw fail(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, reason)

  // ที่เหลือคือของที่ไม่ได้ออกแบบไว้ ต้องเก็บหลักฐานก่อนยุบเป็น code กลาง ๆ
  log.warn('upstream_failed', { layer, path, status: response.status, reason: reason || null })
  if (layer === AUTH || response.status === 401) throw fail(401, 'session_expired')
  throw fail(response.status === 403 ? 403 : 400, 'request_rejected')
}

const authCall = (path, options) => callSupabase(AUTH, path, options)

/**
 * เรียก Edge Function แล้วส่งคำตอบของมันกลับไปทั้งอย่างนั้น
 *
 * ต่างจาก callSupabase ตรงที่ *ไม่* แปลและไม่ยุบข้อผิดพลาด เพราะคำตอบของแต่ละโปรแกรม
 * เป็นของโปรแกรมนั้น ไม่ใช่ของชั้นนี้ ถ้าเรามาตีความแทน วันที่โปรแกรมบอกว่า "ห้องเต็ม"
 * หน้าจอจะได้ยินว่า "บันทึกไม่สำเร็จ" ซึ่งเป็นคนละเรื่องกัน
 *
 * ยิงด้วย token ของบัญชีที่บริการนี้ใช้ ฟังก์ชันจึงเห็นตัวตนและสิทธิ์ตามจริง
 * ตัวที่ต้องใช้สิทธิ์ service ให้ใช้ SUPABASE_SERVICE_ROLE_KEY ของตัวเองในฟังก์ชัน ไม่ใช่รับมาจากทางนี้
 */
async function edgeCall(name, body, accessToken) {
  const response = await fetch(`${upstream}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
  const text = await response.text()
  if (!response.ok) log.warn('edge_function_failed', { name, status: response.status })
  return { status: response.status, text, type: response.headers.get('content-type') || 'application/json' }
}

const rpc = (token, action, data = {}, worker = false) =>
  callSupabase(DATA, `/rest/v1/rpc/${worker ? 'connect_worker' : 'connect_api'}`, {
    token, method: 'POST',
    body: { p_action: action, p_data: data },
    headers: { 'Content-Profile': 'inbox', 'Accept-Profile': 'inbox' },
  })

// ───────────────────────────────────────────────────────── เซสชันของบัญชีที่บริการนี้ใช้
//
// ไม่มีเซสชันรายคนแล้ว จึงไม่มีคุกกี้ ไม่มีไฟล์เซสชัน และไม่มีอะไรต้องกวาดทิ้ง
// เหลือ token ใบเดียวที่ทั้งบริการใช้ร่วมกัน เก็บไว้ในหน่วยความจำ ตายไปพร้อมโพรเซส
//
// ที่ต้องระวังคือ gotrue ออก session ใหม่ทุกครั้งที่ล็อกอิน แล้วใบเก่าจะใช้ไม่ได้ทันที
// ("Session from session_id claim in JWT does not exist") — หน้าเว็บยิงหลายคำขอพร้อมกันตอนเปิด
// ถ้าปล่อยให้ต่างคนต่างล็อกอิน จะกดทับกันเองจนเข้าไม่ได้เลย ทั้งที่แต่ละคำขอสำเร็จ
// จึงบังคับให้มีการล็อกอินได้ทีละหนึ่งครั้ง คำขอที่มาระหว่างนั้นรอผลของตัวแรก

let account = null, pending = null

function signIn() {
  if (pending) return pending
  pending = (async () => {
    const s = await authCall('/auth/v1/token?grant_type=password',
      { method: 'POST', body: { email: accountEmail, password: accountPassword } })
    // ด่านที่สอง: มีตัวตนแล้วยังต้องมีโปรไฟล์ในระบบนี้ด้วย บัญชีที่ไม่มีสิทธิ์จะตกตรงนี้
    await rpc(s.access_token, 'bootstrap')
    account = { access_token: s.access_token, token_expires: Date.now() + s.expires_in * 1000 }
    log.info('account_signed_in', { email: accountEmail })
    return account
  })().finally(() => { pending = null })
  return pending
}

// หมุนก่อนหมดอายุสองนาที เผื่อคำขอที่กำลังเดินทางอยู่
const token = async () =>
  (account && account.token_expires > Date.now() + 120000 ? account : await signIn()).access_token
// ทิ้งใบที่ถืออยู่แล้วขอใหม่ ใช้ตอนที่ปลายทางบอกว่าใบนี้ใช้ไม่ได้ทั้งที่ยังไม่หมดอายุ
const renew = () => { account = null; return token() }

/**
 * ยิงงานด้วย token ของบัญชี แล้วถ้าโดนปฏิเสธเพราะ token ตาย ให้ล็อกอินใหม่แล้วลองอีกครั้งเดียว
 *
 * ใบเดียวที่ใช้ร่วมกันตายได้โดยที่ยังไม่หมดอายุ — เช่นมีคนล็อกอินบัญชีเดียวกันจากที่อื่น
 * หรือ gotrue ถูกรีสตาร์ต ถ้าไม่ลองใหม่ หน้าจอจะค้างยาวจนกว่าจะถึงเวลาหมุนตามกำหนด
 * ลองซ้ำครั้งเดียวพอ ถ้ายังไม่ผ่านแปลว่าเป็นปัญหาอื่น ไม่ใช่เรื่องใบหมดอายุ
 */
async function withAccount(run) {
  try {
    return await run(await token())
  } catch (e) {
    if (e.status !== 401) throw e
    log.info('account_token_renewed', { reason: e.message })
    account = null
    return run(await token())
  }
}

// ───────────────────────────────────────────────────────── คิวขาออก

let workerRunning = false, workerLastSuccess = null

async function worker() {
  if (shadow || workerRunning || !activeChannels.length) return
  workerRunning = true
  try {
    const job = await rpc(service, 'claim', { inbox_ids: activeChannels.map(c => c.inbox_id) }, true)
    if (job) {
      const config = activeChannels.find(c => c.inbox_id === job.inbox_id)
      await rpc(service, 'finish', await deliver(job, config), true)
    }
    workerLastSuccess = new Date().toISOString()
  } catch (e) {
    // ของเดิมพิมพ์ประโยคคงที่ออกมาโดยไม่รับตัว error เลย ทำให้ไล่สาเหตุไม่ได้จนต้องเดา
    log.error('worker_failed', { reason: e.message, status: e.status ?? null })
  } finally {
    workerRunning = false
  }
}

// ───────────────────────────────────────────────────────── คิวขาเข้า
//
// webhook ไม่ประมวลผลอะไรเลยตอนที่ผู้ให้บริการยังรอสายอยู่ — เก็บของดิบแล้วตอบ 200
// งานจริงมาเกิดตรงนี้ ห่างจากนาฬิกาของ LINE/Meta
//
// ทำซ้ำได้เสมอโดยไม่ต้องระวัง เพราะด่านกันซ้ำอยู่ที่ฐาน (connect_private.inbound_event)
// ก้อนที่มีสาม event แล้วล้มที่ event ที่สอง จะถูกหยิบมาทำใหม่ทั้งก้อน
// event แรกจะถูกฐานปฏิเสธว่าซ้ำ เหลือทำจริงแค่ที่ยังไม่สำเร็จ

let inboundRunning = false, inboundLastSuccess = null

async function processInbound(job) {
  const config = activeChannels.find(c => c.key === job.channel_key)
  const finish = body => rpc(service, 'finish_inbound', { log_id: job.id, lease_id: job.lease_id, ...body }, true)

  // ช่องทางถูกปิดหรือถูกถอดออกจาก channels.json หลังจากของเข้ามาแล้ว
  // ของดิบยังอยู่ในฐาน เปิดช่องทางกลับมาแล้วค่อยหยิบมาทำใหม่ได้
  if (!config) return finish({ status: 'failed', error: 'channel_not_configured' })

  try {
    const events = normalizeWebhook(config.channel, job.payload, config)
    for (const event of events) await rpc(service, 'receive', event, true)
    await finish({ status: 'done', events_count: events.length })
    log.info('webhook_processed', { channel: job.channel_key, log_id: job.id, events: events.length })
  } catch (e) {
    log.warn('webhook_processing_failed', { channel: job.channel_key, log_id: job.id, reason: e.message })
    await finish({ status: 'failed', error: e.message })
      .catch(err => log.error('finish_inbound_failed', { log_id: job.id, reason: err.message }))
  }
}

async function inboundWorker() {
  // ขาเข้าเดินแม้ในโหมดเงา — โหมดเงาห้ามแค่การส่งออก การรับเข้าคือทั้งหมดของโหมดนั้น
  if (inboundRunning || !activeChannels.length) return
  inboundRunning = true
  try {
    const job = await rpc(service, 'claim_inbound', { channel_keys: activeChannels.map(c => c.key) }, true)
    if (job) await processInbound(job)
    inboundLastSuccess = new Date().toISOString()
  } catch (e) {
    log.error('inbound_worker_failed', { reason: e.message, status: e.status ?? null })
  } finally {
    inboundRunning = false
  }
}

/**
 * สถานะสุขภาพที่ยอมตอบว่าไม่ไหว
 *
 * worker เดินทุก 3 วินาที ถ้าไม่สำเร็จเกินหนึ่งนาทีแปลว่าคิวนั้นตายแล้ว
 * ตอนเพิ่งบูตยังไม่มีความสำเร็จให้วัด จึงนับจากเวลาที่เริ่มทำงานแทน — ได้เวลาตั้งตัวหนึ่งช่วง
 * โดยไม่ต้องมีข้อยกเว้นแยก และไม่ทำให้ container ขึ้น unhealthy ระหว่างรอบแรก
 *
 * สองคิวตัดสินแยกกัน เพราะตายคนละแบบและมีความหมายคนละอย่าง
 * ขาออกเงียบในโหมดเงาคือเรื่องปกติ แต่ขาเข้าเงียบแปลว่าข้อความลูกค้าค้างอยู่ในคิวไม่ถูกแตะ
 * ซึ่งไม่ปกติไม่ว่าโหมดไหน
 */
function health() {
  const idle = since => Date.now() - (since ? Date.parse(since) : startedAt)
  const idleFor = idle(workerLastSuccess), inboundIdleFor = idle(inboundLastSuccess)
  const outboundOk = shadow || !activeChannels.length || idleFor <= WORKER_STALE_MS
  const inboundOk = !activeChannels.length || inboundIdleFor <= WORKER_STALE_MS
  return { ok: outboundOk && inboundOk, service: 'asher-connect', shadow, account: accountEmail,
           workerLastSuccess, idleFor, inboundLastSuccess, inboundIdleFor,
           activeChannels: activeChannels.length, edgeFunctions }
}

// ───────────────────────────────────────────────────────── ตัวช่วย HTTP

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readBody(req, limit = 262144) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw fail(413, 'body_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// ไม่มีคุกกี้แล้ว CSRF แบบเดิมจึงหมดไป แต่ด่านนี้ยังจำเป็นอยู่ด้วยเหตุผลอื่น
// เว็บอื่นที่ผู้ใช้เปิดค้างไว้ยังสั่งงานบริการนี้ผ่านเบราว์เซอร์ของผู้ใช้ได้ ถ้าไม่ตรวจต้นทาง
// (Content-Type: application/json บังคับให้เบราว์เซอร์ต้อง preflight ก่อน ซึ่งเราไม่ตอบ — ด่านนี้คือชั้นที่สอง)
function checkOrigin(req) {
  if (req.headers.origin !== origin) throw fail(403, 'invalid_origin')
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'json_required')
}

// ───────────────────────────────────────────────────────── เส้นทาง

async function handleWebhook(req, res, url) {
  const key = url.pathname.split('/')[2]
  const config = activeChannels.find(c => c.key === key)
  if (!config) throw webhookFail(503, 'channel_not_configured', key, { ตั้งค่าไว้: channels.map(c => c.key), เปิดใช้อยู่: activeChannels.map(c => c.key) })

  // Messenger ยืนยันปลายทางด้วย GET ครั้งเดียวตอนตั้งค่า ต้องตอบ challenge กลับเป็น text ล้วน
  if (req.method === 'GET' && config.channel === 'messenger') {
    if (url.searchParams.get('hub.mode') !== 'subscribe' || !config.verify_token || url.searchParams.get('hub.verify_token') !== config.verify_token) {
      throw webhookFail(403, 'invalid_verification', key)
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end(url.searchParams.get('hub.challenge') || '')
  }
  if (req.method !== 'POST') throw webhookFail(405, 'method_not_allowed', key, { method: req.method })

  const raw = await readBody(req, 1048576)
  const signature = req.headers[config.channel === 'line' ? 'x-line-signature' : 'x-hub-signature-256']
  if (!verifySignature(raw, signature, config.secret, config.channel)) {
    throw webhookFail(401, 'invalid_signature', key, { ส่งลายเซ็นมาด้วย: Boolean(signature) })
  }

  // ตั้งแต่บรรทัดนี้ไปต้องเบาที่สุดในระบบ เพราะ LINE/Meta ถือสายรออยู่
  // และยิงซ้ำทั้งก้อนเมื่อไม่ได้ 200 ในเวลาที่กำหนด — ซึ่งแปลว่าลูกค้าได้คำตอบสองครั้ง
  // งานจริงจึงย้ายไปอยู่ที่ inboundWorker() หลังตอบ 200 ไปแล้ว
  let body
  try { body = JSON.parse(raw.toString('utf8')) }
  catch (e) { throw webhookFail(400, 'invalid_webhook', key, { เหตุ: e.message }) }

  // "ส่งผิดบ้านหรือเปล่า" ต้องตอบก่อนเก็บ ไม่งั้นบันทึกดิบของเราจะมีของของคนอื่นปนอยู่
  // ส่วนการแปลความว่าในก้อนมี event อะไรบ้าง ยกไปทำทีหลังได้
  if (!matchesDestination(config.channel, body, config)) {
    throw webhookFail(400, 'invalid_webhook', key, { เหตุ: 'wrong_destination', ปลายทางที่ตั้งไว้: config.account_id })
  }

  const logged = await rpc(service, 'log',
    { channel_key: key, channel: config.channel, inbox_id: config.inbox_id, payload: body }, true)
  log.info('webhook_accepted', { channel: key, log_id: logged.log_id })
  return json(res, 200, { accepted: true, log_id: logged.log_id })
}

async function handleCommand(req, res) {
  const input = JSON.parse((await readBody(req)).toString('utf8'))
  if (typeof input.action !== 'string' || !input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
    throw fail(400, 'invalid_request')
  }

  // ทางไป Edge Function: action ขึ้นต้นด้วย fn: แล้วตามด้วยชื่อในทะเบียน
  // แยกทางกันตั้งแต่ตรงนี้ เพราะคำตอบไม่ผ่านตัวแปลของ connect_api และไม่ควรผ่าน
  if (input.action.startsWith('fn:')) {
    const name = input.action.slice(3)
    if (!edgeFunctions.includes(name)) throw fail(404, 'function_not_registered')
    let reply = await edgeCall(name, input.data, await token())
    // 401 ตรงนี้แยกไม่ออกว่าโปรแกรมปฏิเสธเอง หรือใบที่เราถืออยู่ตายไปแล้ว
    // จึงลองใหม่ด้วยใบใหม่ครั้งเดียว ถ้ายัง 401 อีก แปลว่าเป็นคำตอบของโปรแกรมจริง ส่งกลับไปทั้งอย่างนั้น
    if (reply.status === 401) reply = await edgeCall(name, input.data, await renew())
    res.writeHead(reply.status, { 'Content-Type': reply.type })
    return res.end(reply.text)
  }

  const data = await withAccount(async access => {
    if (input.action === 'send') {
      // ด่านแรกสุด ก่อนแตะอะไรทั้งนั้น — ในโหมดเงายังมีบอทตัวเดิมคุยกับลูกค้าอยู่
      if (shadow) throw fail(503, 'shadow_mode')
      const detail = await rpc(access, 'messages', { id: input.data.id })
      // ปลายทางมาจากบทสนทนาในฐานเท่านั้น ไม่เคยมาจากเบราว์เซอร์
      const list = await rpc(access, 'bootstrap')
      if (!list.user) throw fail(403, 'not_allowed')
      if (!activeChannels.some(c => c.channel === detail.channel)) throw fail(503, 'channel_not_configured')
    }
    return rpc(access, input.action, input.data)
  })

  if (input.action === 'bootstrap') {
    data.channels = channels.map(c => ({ name: c.name || c.key, channel: c.channel, enabled: activeChannels.includes(c) }))
  }
  return json(res, 200, data)
}

// ไฟล์หน้าเว็บรับเฉพาะชื่อที่ตรงแบบเป๊ะ ไม่ประกอบ path จากสิ่งที่ผู้ใช้ส่งมา
// ตัวชี้ขาดคือตารางกับ regex นี้ ไม่ใช่การกรอง ".." ทีหลัง ซึ่งพลาดได้หลายทาง
const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/fonts/plex.css': 'fonts/plex.css' }

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'method_not_allowed')

  const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname)
  const target = font ? `fonts/${font[1]}` : staticFiles[url.pathname]
  if (!target) throw fail(404, 'not_found')

  const data = await readFile(join(root, 'public', target)).catch(() => { throw fail(404, 'not_found') })
  const type = font ? 'font/woff2'
    : url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8'
    : 'text/html; charset=utf-8'

  // ฟอนต์เปลี่ยนเมื่อเปลี่ยนชื่อไฟล์เท่านั้น จึงแคชได้ยาว
  // ส่วนหน้าเว็บกับสคริปต์ยังคง no-store ตามที่ตั้งไว้ด้านบน
  if (font) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.writeHead(200, { 'Content-Type': type })
  res.end(req.method === 'HEAD' ? undefined : data)
}

async function route(req, res, url) {
  if (url.pathname === '/health' && req.method === 'GET') {
    const state = health()
    return json(res, state.ok ? 200 : 503, state)
  }
  if (url.pathname.startsWith('/webhooks/')) return handleWebhook(req, res, url)

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname !== '/api/command' || req.method !== 'POST') throw fail(404, 'not_found')
    checkOrigin(req)
    return handleCommand(req, res)
  }

  return handleStatic(req, res, url)
}

// ───────────────────────────────────────────────────────── เริ่มทำงาน

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  try {
    await route(req, res, new URL(req.url, origin))
  } catch (error) {
    // error ที่ไม่มี status คือของที่หลุดออกมาโดยไม่ได้ตั้งใจ ต้องบันทึกไว้เสมอ
    // ส่วนที่มี status แปลว่าเราปฏิเสธเองอย่างตั้งใจ และ log ไว้ตั้งแต่จุดที่ปฏิเสธแล้ว
    if (!error.status) log.error('request_failed', { reason: error.message, kind: error.constructor?.name ?? null })
    if (!res.headersSent) {
      json(res, error.status || (error instanceof SyntaxError ? 400 : 503),
        { error: error.status ? error.message : 'service_unavailable' })
    } else {
      res.end()
    }
  }
})
server.requestTimeout = 30000
server.headersTimeout = 10000

const workerTimer = setInterval(worker, WORKER_INTERVAL); workerTimer.unref()
const inboundTimer = setInterval(inboundWorker, WORKER_INTERVAL); inboundTimer.unref()
// ของดิบมีข้อความลูกค้าจริงอยู่ในนั้น เก็บ 30 วันตามที่ตั้งไว้ในฝั่งฐาน
// เดินวันละสี่ครั้งก็พอ ไม่ใช่งานที่ต้องตรงเวลา ขอแค่ไม่มีวันที่ลืมทำ
const sweepTimer = setInterval(() => {
  rpc(service, 'sweep', {}, true)
    .then(r => log.info('webhook_log_swept', { deleted: r?.deleted ?? 0 }))
    .catch(e => log.warn('webhook_log_sweep_failed', { reason: e.message }))
}, 21600000); sweepTimer.unref()

server.listen(port, '0.0.0.0', () => console.log(`ASHER Connect listening on ${port}; ${activeChannels.length} active channel(s)${shadow ? ' · โหมดเงา: รับเข้าอย่างเดียว ไม่ส่งออก' : ''} · ไม่มีชั้นล็อกอิน ทำงานในนาม ${accountEmail}`))

process.on('SIGTERM', () => {
  clearInterval(workerTimer)
  clearInterval(inboundTimer)
  clearInterval(sweepTimer)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 20000).unref()
})
