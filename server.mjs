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
 * ทุกคำสั่งจากหน้าเว็บวิ่งด้วยตัวตนของคนที่ล็อกอินอยู่ ส่วน worker กับ webhook ยังใช้สิทธิ์ service เหมือนเดิม
 * ฐานข้อมูลจึงเห็น auth.uid() เป็นคนจริง ไม่ใช่บัญชีกลาง — RLS และแท็บ "งานของฉัน" ถึงทำงานได้
 */

import http from 'node:http'
import { createSessions } from './auth.mjs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySignature, matchesDestination, normalizeWebhook, deliver } from './providers.mjs'
import { fetchProfile } from './lib/profile.mjs'
import { mediaTasks, storagePath, enrichMessageMedia, MEDIA_MAX_BYTES } from './lib/media.mjs'
import { createMediaHandler } from './lib/media-http.mjs'
import { generateReply, maskPII, loadProjectData } from './bots/reply.mjs'
import { classifyOnly, intentRow } from './bots/classify.mjs'
import { formatNotify, notifyTargets } from './bots/notify.mjs'
import { testUserIds, splitTestEvents } from './bots/testcmd.mjs'
import { reviewCode, tagReviewCode } from './bots/reviewcode.mjs'
import { buildDailyDigest } from './reports/reply-digest.mjs'
import { createHealth } from './health/health.mjs'
import { createAnswerHubService, buildFlags } from './services/answer-hub/service.mjs'
import { parseQuickReplyFile, classifyQuickReplies } from './services/answer-hub/quick-reply-import.mjs'

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
// ★ ค่านี้ไม่ใช่ของตายอีกต่อไป — เจ้าของจริงคือ inbox.bot_config ในฐาน (ดู sql/016)
// env เหลือหน้าที่เดียว: เป็นค่าตั้งต้นตอนที่ฐานยังไม่เคยถูกตั้งมาก่อน
// ทำแบบนี้เพราะ "ตอนนี้ส่งจริงหรือยัง" ต้องมีคำตอบเดียวทั้งระบบ และคนหน้างานต้องเปลี่ยนเองได้
// โดยไม่ต้องสร้างคอนเทนเนอร์ใหม่ ซึ่งเดิมทำให้ทุกคนหลุดจากหน้าจอพร้อมกัน
const shadowDefault = process.env.CONNECT_SHADOW_MODE === 'true'
let shadow = shadowDefault
let sendModeAt = 0

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

// ข้อมูลโครงการอ่านครั้งเดียวตอนบูต ไม่ใช่ทุกครั้งที่ตอบ
// ไฟล์พวกนี้เป็นของนิ่ง แก้แล้วรีสตาร์ตทีเดียว
const projects = await loadProjectData()

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

const safeCodes = new Set(['not_allowed','conversation_not_found','request_id_conflict','already_assigned','case_closed','claim_required','assignee_not_allowed','version_conflict','project_required','invalid_profile','invalid_budget','invalid_interest','invalid_message','channel_disabled','message_not_found','message_not_retryable','invalid_stage','reason_required','future_appointment_required','walk_in_required','invalid_amount','unit_unavailable','sale_reference_required','booking_required','stage_transition_not_allowed','booked_project_locked','ah_not_allowed','ah_not_found','ah_invalid','ah_state_not_allowed','ah_duplicate','ah_missing_required_data'])

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
  let response
  try {
    response = await fetch(`${upstream}${path}`, {
      method,
      headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    })
  } catch (e) {
    // ต่อ Supabase ไม่ถึงเลย (ล่ม/คอขาด) ต่างจาก "ตอบกลับมาว่าผิด" คนละอาการ จึงต้องบันทึกแยก
    // ผลที่ผู้เรียกเห็นเท่าเดิมคือ 503 service_unavailable ส่วนเหตุผลจริงอยู่ใน log กับ flow_event
    log.warn('upstream_failed', { layer, path, status: 0, reason: e.message })
    flowHealth.log('rpc', { ok: false, detail: `${path} ${e.message}` })
    throw fail(503, 'service_unavailable')
  }
  const data = await response.json().catch(() => ({}))
  if (response.ok) {
    if (Date.now() - rpcOkLoggedAt > 60000) {
      rpcOkLoggedAt = Date.now()
      flowHealth.log('rpc', { ok: true })
    }
    return data
  }

  const reason = data.message ?? data.msg ?? ''
  // เหตุที่เราออกแบบไว้แล้ว ส่งต่อให้หน้าเว็บได้ตรง ๆ ไม่ต้อง log เพราะไม่ใช่ความผิดปกติ
  if (safeCodes.has(reason)) throw fail(response.status === 401 ? 401 : response.status === 403 ? 403 : 400, reason)

  // ที่เหลือคือของที่ไม่ได้ออกแบบไว้ ต้องเก็บหลักฐานก่อนยุบเป็น code กลาง ๆ
  log.warn('upstream_failed', { layer, path, status: response.status, reason: reason || null })
  flowHealth.log('rpc', { ok: false, detail: `${path} → ${response.status}` })
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

// ───────────────────────────────────────────── เซสชันของคนที่ล็อกอิน
//
// เก็บเป็นไฟล์นอกโพรเซส เพื่อให้รีสตาร์ต/deploy แล้วคนที่กำลังทำงานอยู่ไม่หลุดพร้อมกันทั้งออฟฟิศ
// บน VPS โฟลเดอร์นี้ผูกเป็น volume ไว้ใน docker-compose.yml ไม่งั้นสร้าง container ใหม่แล้วหายอยู่ดี
const sessionDir = process.env.SESSION_DIR || join(root, '.sessions')
const sessions = createSessions({ authCall, rpc, origin, log, sessionDir })

// เรียกฟังก์ชันในฐานตรง ๆ ไม่ผ่านประตู connect_api/connect_worker
// ใช้กับของที่เป็นเรื่องของชั้นนี้เอง ไม่ใช่คำสั่งของผู้ใช้ เช่นสถานะช่องทาง
// ทะเบียน RPC ที่หน้าสถิติเรียกได้ — ชื่อต้องตรงกับ inbox.stats_* ใน sql/018
const STATS_ACTIONS = new Set(['stats_overview', 'stats_agents', 'stats_timeline', 'stats_open_windows'])

// ทะเบียน RPC ที่หน้า log เรียกได้ — ชื่อต้องตรงกับ inbox.logs_* ใน sql/029
// ★ ด่านสิทธิ์ (admin เท่านั้น) อยู่ที่ inbox.stats_scope('admin') ในฐาน ไม่ใช่ที่นี่
//   ที่นี่ทำแค่กันไม่ให้เรียกฟังก์ชันนอกทะเบียน เหมือน STATS_ACTIONS
const LOG_ACTIONS = new Set(['logs_timeline', 'logs_summary'])

// ทะเบียน RPC ของคลังคำตอบ (Answer Knowledge Hub — docs/answer-hub/) — ชื่อตรงกับ inbox.ah_* ใน sql/
// ยึดแบบเดียวกับ STATS/LOG: ยิงด้วย token ของคนล็อกอิน ด่านสิทธิ์จริง (sales/manager/admin)
// อยู่บรรทัดแรกของฟังก์ชันในฐาน (core.current_user_role) ที่นี่กันแค่เรียกนอกทะเบียน
// ขยายทะเบียนเมื่อไฟล์ sql/ ถัดไปของ answer-hub เพิ่มฟังก์ชัน — แก้ที่เดียวเสมอ
const AH_ACTIONS = new Set(['ah_editor_options', 'ah_editor_get', 'ah_preview', 'ah_import_preview', 'ah_import_commit', 'ah_learning_list', 'ah_learning_review', 'ah_quick_answer', 'ah_recommend', 'ah_usage_record', 'ah_feedback', 'ah_health', 'ah_list', 'ah_get', 'ah_save', 'ah_approve', 'ah_retire', 'ah_versions', 'ah_source_list', 'ah_source_save', 'ah_resolve', 'ah_binding_list', 'ah_binding_save', 'ah_binding_delete'])

const rpcDirect = (token, fn, body = {}) =>
  callSupabase(DATA, `/rest/v1/rpc/${fn}`, {
    token, method: 'POST', body,
    headers: { 'Content-Profile': 'inbox', 'Accept-Profile': 'inbox' },
  })

// ชั้นบริการคลังคำตอบ (Phase 6) — ประตูเดียวของทุก action ah_* ในตัวจัดการด้านล่าง
// flags default ปิดหมด (ANSWER_HUB_ENABLED ฯลฯ) — เปิดทีละตัวทาง env / inbox.settings
const answerHub = createAnswerHubService({
  callRpc: (token, fn, body) => rpcDirect(token, fn, { p_data: body }),
  flags: buildFlags({ env: process.env }),
  log: (event, fields) => log.info(event, fields),
})

// ───────────────────────────────────────────── ระบบเช็คสถานะ (health/)
//
// channelStates() ด้านบนตอบว่า "ช่องทางยังทักได้ไหม" ส่วน health/ ตอบว่า "ท่อทั้งเส้นยังเดินไหม"
// ตั้งแต่ DNS/TLS ของ Caddy ยันคิวขาออก — เห็นทั้งหมดบน /admin/health (ด่าน manager/admin อยู่ใน SQL)
// ทุกจุดวิ่งด้วย health.log ซึ่งยิงทิ้ง ไม่ throw ไม่รอ — พังแล้วของเดิมต้องยังเดินต่อ
// ★ ตั้งชื่อ flowHealth ไม่ใช่ health — ชื่อ health ถูก function health() ด้านล่าง (จุด healthcheck
//   ของ docker) ใช้อยู่แล้ว สองอย่างนี้ตอบคนละคำถาม: ตัวนี้คือ "ท่อทั้งเส้น" ส่วนอีกตัวคือ "คิวของโพรเซสนี้"
const flowHealth = createHealth({
  // ประตูที่ตัวเช็คยิงเข้าหาตัวเอง (ผ่าน Caddy กลับมา) — โดเมนจริงถ้ามี ไม่งั้นคือ origin ที่ตั้งไว้
  publicUrl: process.env.PUBLIC_URL ?? origin,
  getChannels: async () => activeChannels.map(c => ({
    key: c.key,
    type: c.channel === 'line' ? 'line' : 'messenger',
    accessToken: c.access_token,
  })),
  // สถานะรวมของโพรเซส (overall/database/workers/queue) — snapshot แนบไปกับคำตอบของหน้า admin
  getSystemStatus: () => refreshSystemStatus(),
  // ข้อทดสอบเพิ่มของชั้นโพรเซส ต่อท้าย self-test: worker สองคิว · คิวงาน · โหมดเงา · ตัวแปรที่จำเป็น
  extraSelfTests: () => systemExtraTests(),
})

// stage 'rpc' บันทึกความสำเร็จแบบ heartbeat นาทีละครั้งพอ — ทุก claim_job ล่ะครั้งจะกลายเป็น
// event วันละหมื่นกว่าแถวเปล่า ๆ ส่วนความล้มเหลวบันทึกทุกครั้ง เพราะกฎนับว่า "ล้มกี่ครั้งใน 10 นาที"
let rpcOkLoggedAt = 0

// ───────────────────────────────────────────── ไฟสถานะของช่องทาง
//
// จุดบน chip เคยเป็นสีคงที่ บอกได้แค่ "ตั้งค่าครบไหม" ซึ่งคนละคำถามกับ
// "ช่องทางนี้ยังรับข้อความอยู่ไหม" — เช้า 15 ก.ย. 2026 ลูกค้าทักเพจแล้วไม่มีเคสเข้า
// ติดกันหลายชั่วโมงโดยหน้าจอไม่มีอะไรบอกเลยสักตัว
//
// ★ token ไม่เคยออกไปถึงเบราว์เซอร์ การตรวจทั้งหมดเกิดที่นี่ ส่งออกไปแค่ผลสรุป
// ★ แคชไว้ 10 นาที เพราะหน้าเว็บเรียก bootstrap ทุกครั้งที่เปิด/รีเฟรช
//   ถ้ายิงจริงทุกครั้งจะกลายเป็นการถล่ม Graph API ด้วยคำถามที่คำตอบไม่เปลี่ยน

const HEALTH_TTL = 600000        // 10 นาที
const HEALTH_TIMEOUT = 8000
const FAILS_FOR_RED = 3          // ล้มติดกันเกินนี้ = แดง (ใบเดียวอาจเป็นของหลงมา สามใบคือมีปัญหาจริง)
const IDLE_AFTER = 86400000      // ไม่มีอะไรเข้าเลยเกิน 24 ชม. = เทา

let healthCache = null, healthAt = 0, healthPending = null

/**
 * token ของช่องทางนี้ยังใช้ได้ไหม
 *
 * ถามปลายทางด้วยคำถามที่เบาที่สุดที่ยังพิสูจน์ได้ว่า token ยังมีชีวิต
 * แยก "token ตาย" ออกจาก "ต่อเน็ตไม่ได้" เพราะสองอย่างนี้แก้คนละทาง
 * และการต่อไม่ได้ชั่วคราวไม่ควรทำให้ทั้งแถบขึ้นแดง
 */
async function checkToken(config) {
  // ★ Messenger ต้องถามด้วย debug_token ไม่ใช่ /me
  //   token ของเรามีแค่ pages_messaging ส่วน /me?fields=id,name ต้องการ pages_read_engagement
  //   ถามผิดข้อแล้วจะได้ (#100) ทั้งที่ token ยังใช้งานได้ปกติ = ขึ้นแดงหลอก
  //   debug_token ตอบตรงคำถามว่า "ใบนี้ยังมีชีวิตไหม" และไม่ต้องใช้สิทธิ์เพิ่ม
  const url = config.channel === 'line'
    ? 'https://api.line.me/v2/bot/info'
    : `https://graph.facebook.com/${config.api_version || 'v23.0'}/debug_token`
      + `?input_token=${encodeURIComponent(config.access_token)}`
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.access_token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT),
    })
    const data = await response.json().catch(() => ({}))
    if (config.channel !== 'line' && response.ok && !data.error) {
      if (data.data?.is_valid) return { ok: true }
      return { ok: false, reason: `token ใช้ไม่ได้: ${data.data?.error?.message ?? 'Facebook แจ้งว่าใบนี้ใช้ไม่ได้แล้ว'}`.slice(0, 140) }
    }
    if (response.ok && !data.error) return { ok: true }
    const reason = data.error?.message ?? data.message ?? `HTTP ${response.status}`
    log.warn('channel_token_invalid', { channel: config.key, status: response.status })
    return { ok: false, reason: `token ใช้ไม่ได้: ${String(reason).slice(0, 120)}` }
  } catch (e) {
    // ตรวจไม่ได้ ไม่ใช่ตรวจแล้วไม่ผ่าน — ห้ามตัดสินว่าแดงจากเหตุนี้
    log.warn('channel_token_check_failed', { channel: config.key, reason: e.message })
    return { ok: null, reason: 'ตรวจ token ไม่ได้ในรอบนี้' }
  }
}

async function buildHealth() {
  const [db, tokens] = await Promise.all([
    rpcDirect(service, 'channel_health').catch(e => {
      log.warn('channel_health_failed', { reason: e.message })
      return {}
    }),
    Promise.all(activeChannels.map(async c => [c.key, await checkToken(c)])),
  ])
  const token = Object.fromEntries(tokens)
  const now = Date.now()

  // ★ แสดงเฉพาะช่องทางที่เปิดใช้ — ช่องที่เลิกใช้แล้วไม่ควรกินที่บนแถบหัว
  //   ของที่ปิดอยู่ยังมีข้อมูลเดิมครบในฐาน แค่ไม่ต้องขึ้นหน้าจอ
  return channels.filter(c => c.enabled === true).map(c => {
    const base = { name: c.name || c.key, channel: c.channel, enabled: activeChannels.includes(c) }
    if (!base.enabled) return { ...base, state: 'off', last_message_at: null, reason: 'ยังตั้งค่าไม่ครบใน channels.json' }

    const h = db?.[c.key] ?? {}
    // ★ ใช้ last_event_at ไม่ใช่ last_ok_at — ดู sql/023 ว่าทำไม
    //   สรุปสั้น: การกด Verify และ echo ของ Meta เป็น done แต่ไม่มีข้อความเข้าระบบเลย
    const lastEvent = h.last_event_at ? Date.parse(h.last_event_at) : null
    const t = token[c.key] ?? { ok: null }

    if (t.ok === false) return { ...base, state: 'down', last_message_at: h.last_event_at ?? null, reason: t.reason }
    if ((h.fails_since_ok ?? 0) >= FAILS_FOR_RED) {
      return { ...base, state: 'down', last_message_at: h.last_event_at ?? null,
               reason: `คำขอล่าสุดถูกปฏิเสธ ${h.fails_since_ok} ครั้งติด (${h.last_error || 'ไม่ทราบสาเหตุ'})` }
    }
    if (lastEvent && now - lastEvent <= IDLE_AFTER) {
      return { ...base, state: 'ok', last_message_at: h.last_event_at, reason: t.ok === null ? t.reason : null }
    }
    // แตะเซิร์ฟเวอร์ได้แต่ไม่มีข้อความ = ต่อถึงกัน แต่ลูกค้าทักไม่ถึง — ต้องบอกให้ต่างกัน
    const ทักไม่ถึง = h.last_ok_at && !lastEvent
    return { ...base, state: 'idle', last_message_at: null,
             reason: ทักไม่ถึง ? 'มีสัญญาณเข้ามาแต่ไม่มีข้อความจริง — ตรวจว่า webhook ชี้มาที่นี่และเปิด field ข้อความไว้'
                   : lastEvent ? 'ไม่มีข้อความเข้ามาใน 24 ชั่วโมง'
                   : 'ยังไม่เคยมีข้อความเข้ามาทางนี้เลย' }
  })
}

// คำขอที่มาพร้อมกันตอนแคชหมดอายุต้องรอผลของตัวแรก ไม่ใช่ต่างคนต่างยิง Graph API
function channelStates() {
  if (healthCache && Date.now() - healthAt < HEALTH_TTL) return Promise.resolve(healthCache)
  if (!healthPending) {
    healthPending = buildHealth()
      .then(result => { healthCache = result; healthAt = Date.now(); return result })
      .catch(e => {
        log.warn('channel_states_failed', { reason: e.message })
        // ล้มเหลวทั้งก้อนต้องไม่ทำให้เปิดหน้าเว็บไม่ได้ — คืนของเดิมแบบไม่มีสถานะ
        return channels.map(c => ({ name: c.name || c.key, channel: c.channel,
                                    enabled: activeChannels.includes(c),
                                    state: 'unknown', last_message_at: null, reason: 'ตรวจสถานะไม่ได้' }))
      })
      .finally(() => { healthPending = null })
  }
  return healthPending
}

// ───────────────────────────────────────────────────────── คิวขาออก
//
// งานในคิวมีหลายชนิด ไม่ใช่แค่ "ส่งข้อความ" อีกต่อไป
//
//   generate  คิดคำตอบด้วย Claude แล้วบันทึกเป็นข้อความของบอท
//   classify  ถอดหมวดคำถามเก็บไว้ ตอนที่บอทไม่ได้ตอบ
//   notify    แจ้งทีม (กลุ่ม LINE / Telegram / อีเมล)
//   typing    สัญญาณกำลังพิมพ์
//   send      ส่งข้อความออกไปหาลูกค้า — ยังอยู่ในคิวเดิม (connect_private.delivery)
//             เพราะข้อความของบอทกับของเซลส์เข้าคิวด้วย trigger ตัวเดียวกัน
//             ทางออกสู่ลูกค้าจึงมีทางเดียวทั้งระบบ ไม่ว่าใครเป็นคนพิมพ์
//
// ★ โหมดเงากันการส่งด้วย "ไม่ขอชนิดนั้นมาตั้งแต่แรก" ไม่ใช่หยิบมาแล้วค่อย if ทิ้ง
//   งานส่งจะไม่ถูกแตะเลยแม้แต่การ claim — attempts ไม่ขยับ ลำดับไม่เสีย
//   วันที่ปิดโหมดเงา ของที่ค้างอยู่จะถูกส่งตามลำดับเดิมทุกชิ้น

const WORKER_BATCH = 20
const BOT_KINDS = ['generate', 'classify']
// ★ แจ้งทีม ≠ ส่งหาลูกค้า
//   โหมดเงามีไว้กันข้อความหลุดไปถึงลูกค้า ไม่ใช่กันทีมรับรู้ว่ามีคนทัก
//   ระหว่างช่วงเทียบผลกับ cloud ทีมต้องเห็นว่าระบบใหม่ "จะแจ้งอะไรบ้าง" — นั่นคือข้อมูลที่ใช้เทียบ
//   ก่อนหน้านี้ notify ถูกรวมอยู่ใน SEND_KINDS จึงถูกโหมดเงาบล็อกไปด้วย และทีมไม่ได้รับอะไรเลย
const TEAM_KINDS = ['notify']
const SEND_KINDS = ['typing']

let workerRunning = false, workerLastSuccess = null
// ภาพคิวล่าสุด อ่านนาทีละครั้งพอ — /health ต้องเบาและต้องไม่พังเพราะฐานช้า
let jobQueue = null, jobQueueAt = 0

async function refreshQueue() {
  if (Date.now() - jobQueueAt < 60000) return
  jobQueueAt = Date.now()
  try {
    jobQueue = await rpc(service, 'job_counts', {}, true)
    // งานค้างเพราะสวิตช์ปิดอยู่ ต้องดังพอให้คนเห็น ไม่ใช่เงียบหายไปในคิว
    const off = (jobQueue?.switches ?? []).filter(x => !x.generate && x.pending_generate > 0)
    for (const x of off) log.warn('generate_disabled_backlog', { inbox: x.name, pending: x.pending_generate })
  } catch (e) {
    log.warn('job_counts_failed', { reason: e.message })
  }
}

// สถานะ "ส่งจริง / เก็บข้อมูล" ต้องอ่านจากฐานเสมอ ไม่ใช่จำไว้ตั้งแต่ตอนบูต
// เพราะ admin กดสลับจากหน้าจอได้ และอาจมีคอนเทนเนอร์มากกว่าหนึ่งตัว
//
// ★ ถ้าถามฐานไม่ได้ ให้คงค่าเดิมไว้ ห้ามตกไปเป็นค่าใดค่าหนึ่งโดยอัตโนมัติ
//   ตกไปเป็น "ส่งจริง" = ฐานสะดุดแล้วข้อความหลุดหาลูกค้า
//   ตกไปเป็น "เก็บข้อมูล" = ระบบเงียบโดยไม่มีใครรู้ว่าทำไม
async function refreshSendMode() {
  if (Date.now() - sendModeAt < 3000) return
  sendModeAt = Date.now()
  try {
    const mode = await rpc(service, 'send_mode', { default_live: !shadowDefault }, true)
    const next = !mode.live
    if (next !== shadow) log.warn('send_mode_changed', { โหมด: next ? 'เก็บข้อมูล' : 'ส่งจริง' })
    shadow = next
  } catch (e) {
    log.warn('send_mode_unreadable', { reason: e.message, คงโหมดเดิมไว้: shadow ? 'เก็บข้อมูล' : 'ส่งจริง' })
  }
}

async function worker() {
  if (workerRunning || !activeChannels.length) return
  workerRunning = true
  try {
    await refreshSendMode()
    // วนจนคิวว่าง แต่ไม่เกินรอบละ 20 ชิ้น
    // ไม่จำกัดเลย = คิวยาว ๆ จะกินทั้งรอบแล้วงานอื่นไม่ได้เดิน
    let done = 0
    while (done < WORKER_BATCH) {
      const job = await nextJob()
      if (!job) break
      await runJob(job)
      done++
    }
    await refreshQueue()
    // ในโหมดเงาตัวส่งข้อความไม่เดินโดยตั้งใจ จึงไม่นับว่า "ยังส่งได้อยู่"
    if (!shadow) workerLastSuccess = new Date().toISOString()
  } catch (e) {
    // ของเดิมพิมพ์ประโยคคงที่ออกมาโดยไม่รับตัว error เลย ทำให้ไล่สาเหตุไม่ได้จนต้องเดา
    log.error('worker_failed', { reason: e.message, status: e.status ?? null })
  } finally {
    workerRunning = false
  }
}

async function nextJob() {
  // งานแจ้งทีมเดินได้ทั้งสองโหมด · งานที่ถึงลูกค้าจริงเดินเฉพาะตอนไม่ใช่โหมดเงา
  const kinds = shadow ? [...BOT_KINDS, ...TEAM_KINDS] : [...BOT_KINDS, ...TEAM_KINDS, ...SEND_KINDS]
  const job = await rpc(service, 'claim_job',
    { kinds, inbox_ids: activeChannels.map(c => c.inbox_id) }, true)
  if (job) return { ...job, source: 'job' }

  if (shadow) return null
  const outbound = await rpc(service, 'claim', { inbox_ids: activeChannels.map(c => c.inbox_id) }, true)
  return outbound ? { ...outbound, kind: 'send', source: 'delivery' } : null
}

async function runJob(job) {
  try {
    if (job.source === 'delivery') {
      const config = activeChannels.find(c => c.inbox_id === job.inbox_id)
      const result = await deliver(job, config)
      // ทางส่งหาลูกค้ามีทางเดียวทั้งระบบ (บอทกับเซลส์เข้าคิวเดียวกัน) — จุดเดียวที่บอกได้ว่า "ถึงมือลูกค้าหรือยัง"
      flowHealth.log('reply_sent', { channel: config?.key ?? null, ref: result.message_id ?? job.message_id,
                                 ok: result.status === 'sent', detail: result.error ?? null })
      if (result.blocked && job.conversation_id) await markBlocked(job.conversation_id)
      const finished = await rpc(service, 'finish', result, true)
      if (result.status === 'sent') { captureAnswerUsage(job, config?.key); if (job.message_id) captureLearning(job.conversation_id, job.message_id) }
      return finished
    }
    if (job.kind === 'generate') return await runGenerate(job)
    if (job.kind === 'classify') return await runClassify(job)
    return await runOutbound(job)
  } catch (e) {
    log.error('job_failed', { job_id: job.id, kind: job.kind, reason: e.message })
    // error ที่บอกว่าลองใหม่ไม่ช่วย (ไม่มี key, ข้อมูลไม่ครบ) ไม่ต้องวนกลับมาอีก
    await finishJob(job, { status: e.retryable === false ? 'failed' : 'retry', error: e.message })
      .catch(err => log.error('finish_job_failed', { job_id: job.id, reason: err.message }))
  }
}

const finishJob = (job, body) =>
  rpc(service, 'finish_job', { job_id: job.id, lease_id: job.lease_id, ...body }, true)

// Learning is deliberately best-effort and only begins after delivery has
// succeeded. A capture outage must never retry, delay, or alter a human reply.
const captureLearning = (conversationId, messageId) => {
  const enabled = ['1', 'true'].includes(String(process.env.ANSWER_HUB_LEARNING_ENABLED ?? '').toLowerCase())
  if (!enabled || !conversationId) return
  void rpc(service, 'ah_learning_create', { conversation_id: conversationId, message_id: messageId }, true)
    .then(result => log.info('learning_candidate_capture', { conversation_id: conversationId, created: Boolean(result?.created) }))
    .catch(error => log.warn('learning_candidate_capture_failed', { conversation_id: conversationId, reason: error.message }))
}

// Best-effort usage telemetry; core delivery result is never affected.
const captureAnswerUsage = (job, channel) => {
  const answerId = job?.payload?.answer_id
  if (!answerId) return
  void rpc(service, 'ah_usage_record', { answer_id: answerId, conversation_id: job.conversation_id, channel }, true)
    .catch(error => log.warn('answer_usage_record_failed', { reason: error.message }))
}

// ลูกค้าบล็อกบัญชีเราแล้ว — ติดธงไว้ที่ผู้ติดต่อ จะได้ไม่เสียโควตากับคนที่ไม่ได้ยินเราอีก
// ล้มตรงนี้ไม่ควรทำให้งานที่เพิ่งส่งไม่สำเร็จกลายเป็นล้มซ้ำ จึงกลืนไว้แต่ต้องบันทึก
const markBlocked = conversationId =>
  rpc(service, 'mark_blocked', { conversation_id: conversationId }, true)
    .catch(e => log.warn('mark_blocked_failed', { conversation: conversationId, reason: e.message }))

async function runGenerate(job) {
  // เช็คอีกรอบก่อนคิด — งานนี้อาจรออยู่ในคิวมา 30 นาที ระหว่างนั้นคนอาจตอบไปแล้ว
  const context = await rpc(service, 'reply_context',
    { conversation_id: job.conversation_id, since: job.created_at,
      history_limit: 12, is_new_chat: job.payload?.is_new_chat ?? false }, true)
  if (context.skip_reason) {
    log.info('generate_skipped', { job_id: job.id, reason: context.skip_reason })
    return finishJob(job, { status: 'skipped', skip_reason: context.skip_reason })
  }

  const last = [...(context.history ?? [])].reverse().find(m => m.role === 'user')
  const text = last?.content ?? ''
  // Phase 15 MVP: a Hub response is allowed only when SQL has already
  // enforced approved/bot-or-both/bot_auto_answer. Dynamic answers remain on
  // the human-review path until their bindings can be resolved safely.
  if (['1', 'true'].includes(String(process.env.ANSWER_HUB_ENABLED ?? '').toLowerCase())
    && ['1', 'true'].includes(String(process.env.ANSWER_HUB_BOT_ENABLED ?? '').toLowerCase()) && text) {
    try {
      const recommended = await rpc(service, 'ah_recommend', { question: text, project_id: context.project?.id, audience: 'bot' }, true)
      const candidate = recommended?.rows?.find(item => item.answer_type === 'static' && typeof item.body_template === 'string' && item.body_template.trim())
      if (candidate) {
        const queued = await rpc(service, 'bot_reply', { conversation_id: job.conversation_id, text: candidate.body_template, offtopic: false }, true)
        if (!shadow) flowHealth.log('reply_queued', { channel: activeChannels.find(c => c.inbox_id === job.inbox_id)?.key ?? null, ref: queued?.message_id })
        log.info('answer_hub_bot_replied', { job_id: job.id, answer_id: candidate.id })
        return finishJob(job, { status: 'done' })
      }
    } catch (e) { log.warn('answer_hub_bot_fallback', { job_id: job.id, reason: e.message }) }
  }
  const known = [
    context.known_phone ? `Customer ALREADY gave phone number: ${context.known_phone}. Do NOT ask for phone again.` : '',
  ].filter(Boolean).join('\n')

  const { reply, offTopic, intent } = await generateReply({
    text, history: context.history, known, project: context.project,
    style: context.style ?? {}, model: context.model, minConfidence: Number(context.min_confidence ?? 0.6),
    ctx: { is_new_chat: context.is_new_chat },
  })

  const queued = await rpc(service, 'bot_reply',
    { conversation_id: job.conversation_id, text: reply, offtopic: offTopic }, true)
  // จับคู่กับ reply_sent ด้วย message_id เพื่อหา "คิวค้าง" — ในโหมดเงาคิวขาออกไม่เดินโดยตั้งใจ
  // จึงไม่บันทึก ไม่งั้นกฎคิวค้างจะยิงเตือนทุกข้อความของบอททั้งที่เป็นพฤติกรรมปกติของโหมดนั้น
  if (!shadow) flowHealth.log('reply_queued', {
    channel: activeChannels.find(c => c.inbox_id === job.inbox_id)?.key ?? null,
    ref: queued?.message_id })
  await rpc(service, 'store_intent', intentRow(intent, {
    conversation_id: job.conversation_id, message_id: job.message_id, external_id: job.target,
    project: context.project, ad_id: context.ad_id, ad_title: context.ad_title,
    is_new_chat: context.is_new_chat, bot_replied: true, raw_question: maskPII(text).slice(0, 500),
  }), true).catch(e => log.warn('store_intent_failed', { job_id: job.id, reason: e.message }))

  log.info('bot_replied', { job_id: job.id, conversation: job.conversation_id, offtopic: offTopic })
  return finishJob(job, { status: 'done' })
}

async function runClassify(job) {
  const text = job.payload?.text ?? ''
  const intent = await classifyOnly(text, job.payload?.ad_title ?? null,
    { onError: e => log.warn('classify_degraded', { job_id: job.id, reason: e.message }) })
  await rpc(service, 'store_intent', intentRow(intent, {
    conversation_id: job.conversation_id, message_id: job.message_id,
    ad_title: job.payload?.ad_title ?? null, bot_replied: false,
    raw_question: maskPII(text).slice(0, 500),
  }), true)
  return finishJob(job, { status: 'done' })
}

/**
 * งานที่ออกไปข้างนอก — แจ้งทีม หรือสัญญาณกำลังพิมพ์
 *
 * ข้อความแจ้งหนึ่งชิ้นอาจไปได้หลายทาง (กลุ่ม LINE + Telegram + อีเมล)
 * ถือว่าสำเร็จเมื่อมีอย่างน้อยหนึ่งทางถึง — ทีมเห็นแล้วคือเห็นแล้ว
 * ถ้าไม่ถึงสักทางค่อยให้คิวลองใหม่
 */
async function runOutbound(job) {
  const inboxConfig = activeChannels.find(c => c.inbox_id === job.inbox_id) ?? {}

  if (job.kind === 'typing') return finishJob(job, await deliver(job, inboxConfig))

  // งานที่รู้ปลายทางของตัวเองอยู่แล้ว (เช่นตอบกลับเข้ากลุ่ม LINE) ส่งตรงไปเลย
  // ตัวกระจายของทีมข้างล่างมีไว้สำหรับ channel 'team' ซึ่งแปลว่า "แจ้งใครก็ได้ที่เฝ้าอยู่"
  if (job.channel !== 'team') {
    const { config, target, payload } = outboundRoute(job, inboxConfig)
    if (!target) return finishJob(job, { status: 'skipped', skip_reason: 'no_target' })
    const result = await deliver({ ...job, target, payload }, config)
    if (result.blocked && job.conversation_id) await markBlocked(job.conversation_id)
    const finished = await finishJob(job, result)
    if (result.status === 'sent') { captureAnswerUsage(job, inboxConfig.channel); if (job.message_id) captureLearning(job.conversation_id, job.message_id) }
    return finished
  }

  const targets = notifyTargets(job.payload ?? {}, process.env)
  if (!targets.length) {
    log.warn('notify_no_target', { job_id: job.id })
    return finishJob(job, { status: 'skipped', skip_reason: 'no_notify_target' })
  }

  const text = formatNotify({ ...job.payload, channel_label: channelLabel(job) }, { inboxUrl: inboxUrlFor(job) })
  const results = await Promise.all(targets.map(t =>
    deliver({ ...job, kind: 'notify', channel: t.channel, target: t.target, payload: { type: 'text', text } }, t.config)))

  // ทาง telegram ของการแจ้งทีมคือท่อเดียวกับที่ระบบเช็คใช้ยิงเตือน มันตายเมื่อไหร่ทั้งระบบจึงต้องรู้ตัว
  for (const [i, r] of results.entries()) {
    if (targets[i].channel === 'telegram') flowHealth.log('telegram', { ok: r.status === 'sent', detail: r.error ?? null })
  }

  const sent = results.filter(r => r.status === 'sent')
  if (sent.length) return finishJob(job, { status: 'done', provider_id: sent[0].provider_id ?? null })
  return finishJob(job, { status: 'retry', error: results.map(r => r.error).filter(Boolean).join(' · ') || 'notify_failed' })
}

/**
 * ปลายทางกับกุญแจของงานขาออกที่ไม่ได้ส่งหาลูกค้า
 *
 * ★ ปลายทางพวกนี้มาจาก env เสมอ ไม่ได้อยู่ในฐาน (กติกาข้อ 6)
 *   ฐานสั่งว่า "ส่งทาง telegram" ส่วนส่งเข้าห้องไหนเป็นเรื่องของเครื่องที่รันอยู่
 *
 * รายงานรายวันถูกแปลงเป็นข้อความตรงนี้ ไม่ใช่ตอนเข้าคิว
 * เพราะสิ่งที่เก็บไว้ในคิวควรเป็นตัวเลข ไม่ใช่ถ้อยคำ — วันที่อยากเปลี่ยนสำนวน
 * จะได้ไม่ต้องไปแก้ของที่ค้างอยู่ในคิว
 */
function outboundRoute(job, inboxConfig) {
  const env = process.env
  const payload = job.payload?.kind === 'daily_report'
    ? { type: 'text', text: buildDailyDigest(job.payload.report ?? {}) }
    : job.payload

  if (job.channel === 'telegram') {
    return { config: { telegram_bot_token: env.TELEGRAM_BOT_TOKEN },
             target: job.target ?? env.TELEGRAM_CHAT_ID ?? null, payload }
  }
  if (job.channel === 'email') {
    return { config: { resend_api_key: env.RESEND_API_KEY, email_from: env.LEAD_EMAIL_FROM },
             target: job.target ?? env.LEAD_EMAIL_TO ?? null, payload }
  }
  if (job.channel === 'line_group') {
    return { config: inboxConfig.access_token ? inboxConfig : { access_token: env.LINE_NOTIFY_TOKEN },
             target: job.target ?? env.LINE_NOTIFY_GROUP_ID ?? null, payload }
  }
  return { config: inboxConfig, target: job.target ?? null, payload }
}

const channelLabel = job => {
  const config = activeChannels.find(c => c.inbox_id === job.inbox_id)
  return config?.channel === 'line' ? ' LINE' : config?.channel === 'messenger' ? ' Messenger' : ''
}
const inboxUrlFor = job => {
  const config = activeChannels.find(c => c.inbox_id === job.inbox_id)
  return config?.channel === 'line' ? 'https://chat.line.biz/' : 'https://business.facebook.com/latest/inbox/all'
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

// เติมชื่อ/รูปลูกค้าจากแพลตฟอร์ม — ทำหลังบันทึกข้อความเสร็จแล้วเท่านั้น
//
// ★ ถามฐานก่อนว่า "ต้องดึงไหม" (profile_state) แล้วค่อยยิง API
//   เกณฑ์อยู่ในฐานที่เดียว: ยังไม่มีชื่อ · ไม่เคยดึง · หรือดึงไว้เกิน 7 วัน
//   เคสที่ได้ 404 ถูกประทับ profile_fetched_at ไว้แล้ว จึงไม่ยิงซ้ำทุกข้อความ
//
// ★ ข้อความหลายก้อนจากคนเดียวกันในก้อนเดียว = ดึงครั้งเดียว (Set ข้างล่าง)
//   ส่วนก้อนที่มาติด ๆ กันคนละ webhook ถูกกันอีกชั้นด้วย inflight ใน profile.mjs
async function syncProfiles(config, events) {
  const seen = new Set()
  for (const e of events) {
    const id = e.external_id
    if (!id || seen.has(id)) continue
    seen.add(id)
    try {
      const state = await rpc(service, 'profile_state',
        { channel: config.channel, account_key: config.inbox_id, external_id: id }, true)
      if (!state?.due) continue

      // LINE ในกลุ่ม/ห้องต้องใช้คนละ endpoint — providers.mjs ติด source_type มาให้แล้ว
      const source = e.group_id
        ? { type: e.source_type === 'room' ? 'room' : 'group', id: e.group_id }
        : { type: 'user' }

      const p = await fetchProfile({ channel: config.channel, externalId: id, config, source, deps: { log } })
      await rpc(service, 'profile_update', {
        channel: config.channel, account_key: config.inbox_id, external_id: id,
        display_name: p.display_name, picture_url: p.picture_url, status: p.status,
      }, true)
    } catch (err) {
      // คนเดียวพังไม่ควรทำให้คนที่เหลือในก้อนเดียวกันไม่ได้ชื่อ
      log.warn('profile_sync_failed', { channel: config.key, reason: err.message })
    }
  }
}

// ── รอบรีเฟรชโปรไฟล์ประจำวัน ──
// ★ ตัวจับเวลาอยู่ในฐาน (inbox.settings.profile_refresh_at) ไม่ใช่ตัวแปรในเครื่อง
//   เพราะ setInterval เริ่มนับใหม่ทุกครั้งที่ deploy — วันที่ deploy หลายรอบจะไม่ได้รีเฟรชเลย
//   และถ้ามีหลายคอนเทนเนอร์ ฐานเป็นคนกันไม่ให้สองตัวทำพร้อมกัน
let refreshCheckedAt = 0
const REFRESH_BATCH = 100
async function refreshProfiles() {
  // ถามฐานไม่ถี่เกิน 10 นาทีต่อครั้ง — worker เดินทุก 3 วินาที ถ้าถามทุกรอบจะเปลือง
  if (Date.now() - refreshCheckedAt < 600000) return
  refreshCheckedAt = Date.now()
  try {
    const claim = await rpc(service, 'profile_refresh_due', { every_hours: 24 }, true)
    if (!claim?.due) return

    const rows = await rpc(service, 'profile_backlog', { limit: REFRESH_BATCH, include_stale: true }, true)
    if (!Array.isArray(rows) || !rows.length) return
    log.info('profile_refresh_started', { count: rows.length })

    let ok = 0, notFound = 0, failed = 0
    for (const row of rows) {
      const config = activeChannels.find(c => c.inbox_id === row.account_key)
      if (!config) continue
      const p = await fetchProfile({
        channel: row.channel, externalId: row.external_id, config,
        source: row.group_id ? { type: 'group', id: row.group_id } : { type: 'user' },
        deps: { log },
      })
      if (p.status === 'ok') ok++; else if (p.status === 'not_found') notFound++; else failed++
      await rpc(service, 'profile_update', {
        channel: row.channel, account_key: row.account_key, external_id: row.external_id,
        display_name: p.display_name, picture_url: p.picture_url, status: p.status,
      }, true).catch(() => { failed++ })
      // หน่วงเท่ากับสคริปต์ backfill เพื่อไม่ให้ชนโควตาของ LINE/Meta
      await new Promise(r => setTimeout(r, 200))
    }
    log.info('profile_refresh_done', { ok, not_found: notFound, failed })
  } catch (e) {
    log.warn('profile_refresh_failed', { reason: e.message })
  }
}

// ───────────────────────────────────────────── สื่อแนบ (รูป/วิดีโอ/เสียง/ไฟล์)
//
// ของที่ลูกค้าส่งมามีแค่ทางใดทางหนึ่ง: Messenger แถม URL ชั่วคราวมาใน webhook ซึ่งหมดอายุ
// ภายในไม่กี่ชั่วโมง ส่วน LINE ไม่ให้ URL เลย ต้องเรียก Content API ด้วย token ของ channel นั้นเอง
// ระบบจึงต้องกาฝากไฟล์มาเก็บที่ Storage ทันทีที่รับเข้า ไม่งั้นสื่อหายตามอายุของ URL
//
// ★ ทั้งหมด "ยิงทิ้ง" จาก processInbound — ข้อความลงฐานเสร็จแล้ว และ 200 ตอบ Meta/LINE ไปแล้ว
//   ความพลาดที่นี่ต้อง log เสมอ (กติกาข้อ 1) แต่ห้ามพาคิวขาเข้าช้าหรือพังด้วย
//   และเหมือน lib/profile.mjs: ห้าม log token กับ URL ของไฟล์ที่มีของลูกค้า — มีแต่ id กับเหตุผล

const MEDIA_RETRIES = 3
const MEDIA_TIMEOUT_MS = 30_000
const MEDIA_GAP_MS = 150        // เว้นจังหวะ — รูปมาหลายก้อนติดกันไม่ควรยิง LINE/Meta รัว ๆ

async function downloadMediaBytes(task, config) {
  const isLine = task.source === 'line_content'
  const url = isLine
    ? `https://api-data.line.me/v2/bot/message/${task.line_message_id}/content`
    : task.url
  const headers = isLine ? { Authorization: `Bearer ${config.access_token}` } : undefined
  for (let attempt = 1; attempt <= MEDIA_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) })
      // 403/404 = ของหมดอายุหรือถูกถอดไปแล้ว ยิงซ้ำไม่มีทางดีขึ้น จึงไม่ retry
      if (response.status === 403 || response.status === 404) {
        log.warn('media_unreachable', { message_id: task.message_id, status: response.status })
        return null
      }
      if (!response.ok) throw new Error(`http_${response.status}`)
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream'
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw new Error('empty_body')
      if (bytes.length > MEDIA_MAX_BYTES) {
        log.warn('media_too_large', { message_id: task.message_id, bytes: bytes.length })
        return null
      }
      return { bytes, type }
    } catch (e) {
      if (attempt === MEDIA_RETRIES) {
        log.warn('media_download_failed', { message_id: task.message_id, source: task.source, attempts: attempt, reason: e.message })
        return null
      }
      await new Promise(r => setTimeout(r, 800 * attempt * attempt))
    }
  }
}

async function uploadMediaObject(path, { bytes, type }) {
  const response = await fetch(`${upstream}/storage/v1/object/inbox-media/${path}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${service}`, 'Content-Type': type, 'x-upsert': 'true' },
    body: bytes,
    signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`storage_${response.status}`)
}

async function syncMedia(config, events, received) {
  const jobs = events.flatMap((event, i) => mediaTasks(event, received[i]))
  if (!jobs.length) return
  log.info('media_sync_started', { channel: config.key, count: jobs.length })
  // ข้อความเดียวมีหลายไฟล์ได้ (Messenger) — สะสมผลต่อ message_id แล้วค่อยผูกกับข้อความครั้งเดียว
  const byMessage = new Map()
  const order = new Map()
  for (const task of jobs) {
    const n = (order.get(task.message_id) ?? 0) + 1
    order.set(task.message_id, n)
    try {
      const got = await downloadMediaBytes(task, config)
      if (!got) continue
      const path = storagePath(config.inbox_id, task.message_id, n, got.type)
      await uploadMediaObject(path, got)
      const media = byMessage.get(task.message_id) ?? []
      media.push({ path, mime: got.type, bytes: got.bytes.length })
      byMessage.set(task.message_id, media)
      log.info('media_stored', { message_id: task.message_id, path })
    } catch (e) {
      log.warn('media_store_failed', { message_id: task.message_id, reason: e.message })
    }
    await new Promise(r => setTimeout(r, MEDIA_GAP_MS))
  }
  for (const [messageId, media] of byMessage) {
    try {
      const attached = await rpcDirect(service, 'media_attach', { p_message_id: messageId, p_media: media })
      // false = ไม่พบข้อความ (เช่นโดน purge ระหว่างทาง) — ไฟล์บน Storage คงอยู่เป็นขยะ ไม่ใช่ความเสียหาย
      if (!attached) log.warn('media_attach_missed', { message_id: messageId })
    } catch (e) {
      log.warn('media_attach_failed', { message_id: messageId, reason: e.message })
    }
  }
}

async function processInbound(job) {
  const config = activeChannels.find(c => c.key === job.channel_key)
  const finish = body => rpc(service, 'finish_inbound', { log_id: job.id, lease_id: job.lease_id, ...body }, true)

  // ช่องทางถูกปิดหรือถูกถอดออกจาก channels.json หลังจากของเข้ามาแล้ว
  // ของดิบยังอยู่ในฐาน เปิดช่องทางกลับมาแล้วค่อยหยิบมาทำใหม่ได้
  if (!config) return finish({ status: 'failed', error: 'channel_not_configured' })

  try {
    const events = normalizeWebhook(config.channel, job.payload, config)
    const received = []
    for (const event of events) received.push(await rpc(service, 'receive', tagReviewCode(event, config, META_REVIEW_CODE), true))
    await finish({ status: 'done', events_count: events.length })
    log.info('webhook_processed', { channel: job.channel_key, log_id: job.id, events: events.length })
    // ★ ยิงทิ้งไว้ ไม่ await — ข้อความลงฐานเสร็จไปแล้ว โปรไฟล์เป็นของแถมที่ขาดได้
    //   ถ้า await ตรงนี้ คิวขาเข้าจะช้าลงตามเวลาที่ LINE/Meta ตอบ และถ้า API ล่ม คิวจะตัน
    syncProfiles(config, events).catch(e =>
      log.warn('profile_sync_failed', { channel: job.channel_key, reason: e.message }))
    // ★ สื่อแนบยิงทิ้งด้วยหลักเดียวกัน — เก็บช้าลงหนึ่งรอบยังทันก่อน URL หมดอายุ
    //   แต่ห้ามให้การดาวน์โหลดพาคิวขาเข้าไปด้วย
    syncMedia(config, events, received)
      .catch(e => log.warn('media_sync_failed', { channel: job.channel_key, reason: e.message }))
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
    // ไม่ await — รอบรีเฟรชต้องไม่ทำให้คิวข้อความขาเข้าช้าลง
    if (!job) refreshProfiles().catch(e => log.warn('profile_refresh_failed', { reason: e.message }))
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
// เพดาน heap ของ V8 คือ 160 MB (ตั้งใน Dockerfile) เตือนตั้งแต่ 140
// เพื่อให้เห็นก่อนที่มันจะเริ่มเก็บกวาดถี่จนช้า และก่อนที่ container จะถูกฆ่าที่ 256
const RSS_WARN_MB = 140
let rssWarnedAt = 0

function health() {
  const mem = process.memoryUsage()
  const rssMb = Math.round(mem.rss / 1048576)
  // เตือนได้ แต่ห้ามถี่ — /health ถูกเรียกทุก 30 วินาทีจาก healthcheck ของ docker
  if (rssMb >= RSS_WARN_MB && Date.now() - rssWarnedAt > 600000) {
    rssWarnedAt = Date.now()
    log.warn('memory_high', { rssMb, heapUsedMb: Math.round(mem.heapUsed / 1048576), limitMb: 160 })
  }
  const idle = since => Date.now() - (since ? Date.parse(since) : startedAt)
  const idleFor = idle(workerLastSuccess), inboundIdleFor = idle(inboundLastSuccess)
  const outboundOk = shadow || !activeChannels.length || idleFor <= WORKER_STALE_MS
  const inboundOk = !activeChannels.length || inboundIdleFor <= WORKER_STALE_MS
  // สถานะรวมใช้ของที่คำนวณไว้แล้วเท่านั้น (refreshSystemStatus เดินเป็นรอบของตัวเอง)
  // /health ต้องเบาและห้ามรอใคร — ครั้งแรกก่อนรอบแรกจะยังไม่มีคำตอบ จึงรายงาน unknown ไปก่อนได้
  const sys = sysCache
  return { ok: outboundOk && inboundOk, status: sys?.overall ?? 'unknown',
           service: 'asher-connect', shadow, shadowDefault, authentication: 'individual',
           checkedAt: sys?.checkedAt ?? null, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
           version: APP_VERSION, environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
           database: sys?.database ?? null, channels: sys?.channels ?? null,
           workers: sys?.workers ?? null, queue: sys?.queue ?? null, shadowMode: shadow,
           workerLastSuccess, idleFor, inboundLastSuccess, inboundIdleFor,
           activeChannels: activeChannels.length, edgeFunctions, projects,
           // หน่วยเป็น MB เพราะไบต์ดิบไม่มีใครอ่านออกตอนตีสาม
           // rss คือของที่ docker วัดจริง ส่วน heapUsed คือของที่ V8 ถืออยู่
           memory: { rssMb, heapUsedMb: Math.round(mem.heapUsed / 1048576), limitMb: 160 },
           // สวิตช์ของบอทต้องมองเห็นจากข้างนอกเสมอ
           // ไม่งั้น "บอทไม่ตอบ" กับ "บอทถูกปิดไว้" จะแยกกันไม่ออกตอนมีคนถามว่าทำไมเงียบ
           bot: jobQueue }
}

// ───────────────────────────────────────────── สถานะรวมของระบบ (Admin System Status)
//
// คำตอบเดียวของทั้งระบบว่า HEALTHY / DEGRADED / DOWN — คำนวณ "ที่นี่" เท่านั้น
// หน้าเว็บห้ามสรุปเอง (หลักการเดียวกับด่านสิทธิ์: การซ่อนปุ่มคือความสะอาดตา ตัวเลขจริงต้องมาจาก backend)
//
//   DOWN     ฐานข้อมูลใช้ไม่ได้ หรือ inbound worker เงียบเกินเกณฑ์ critical — ข้อความลูกค้าหายแน่ ๆ
//   DEGRADED บางส่วนผิดปกติแต่ยังให้บริการได้ (ช่องทางตาย, worker ขาออกเงียบ, คิวค้างเกินเกณฑ์)
//   HEALTHY  ทุกชิ้นส่วนที่สำคัญยังเดิน
//
// เกณฑ์นาทีอ่านจากกฎ worker_age/pending-* ใน inbox.monitor_rule (admin แก้จากหน้าเว็บ มีผลทันที)
// ช่องทางเงียบ "ไม่ใช่" ความเสียหาย — แยก enabled/reachable/recent activity ให้ชัดตามจริง
const APP_VERSION = process.env.APP_VERSION ?? null
const SYS_TTL = 15000
let sysCache = null, sysAt = 0, sysPending = null

function workerState(idleForMs, thresholds, enabled) {
  const ageMin = idleForMs / 60000
  const base = { lastSuccessAt: null, ageMin: Math.round(ageMin * 10) / 10, warnMin: thresholds.warn, critMin: thresholds.crit }
  if (!enabled) return { ...base, status: 'disabled' }
  if (ageMin >= thresholds.crit) return { ...base, status: 'down' }
  if (ageMin >= thresholds.warn) return { ...base, status: 'degraded' }
  return { ...base, status: 'healthy' }
}

async function computeSystemStatus() {
  const checkedAt = new Date().toISOString()

  // ฐานข้อมูล: ยิง health_ping จริง (ตรวจว่าตอบ ไม่ใช่ดูว่าพอร์ตเปิด)
  const t0 = Date.now()
  let dbErr = null
  try { await rpcDirect(service, 'health_ping') } catch (e) { dbErr = e.message }
  const database = { status: dbErr ? 'down' : 'healthy', latencyMs: dbErr ? null : Date.now() - t0,
                     lastSuccessAt: dbErr ? null : new Date().toISOString(), error: dbErr }

  // เกณฑ์นาทีจากตารางกฎ — อ่านไม่ได้ก็ใช้ค่าตั้งต้นเดิมของระบบ ไม่พาทั้งหน้าล้ม
  let th = { inbound_worker: { warn: 1, crit: 5 }, outbound_worker: { warn: 1, crit: 5 }, queue_age: { warn: 3, crit: 10 } }
  try { th = { ...th, ...(await rpcDirect(service, 'health_thresholds')) } } catch (e) {
    log.warn('health_thresholds_unreadable', { reason: e.message })
  }

  // worker: อายุความสำเร็จล่าสุดของสองคิว — โหมดเงากับหน้างานไม่มีช่องทาง ขาออกเงียบคือเรื่องปกติ
  const h = health()
  const workers = {
    inbound: { ...workerState(h.inboundIdleFor, th.inbound_worker, activeChannels.length > 0),
               lastSuccessAt: inboundLastSuccess },
    outbound: { ...workerState(h.idleFor, th.outbound_worker, activeChannels.length > 0 && !shadow),
                lastSuccessAt: workerLastSuccess, shadow: shadow },
  }

  // ช่องทาง: สถานะจริงจาก channelStates (token + ข้อความล่าสุด) — เงียบ ≠ เสีย จึงแยกเกณฑ์ไว้คนละชั้น
  let channels = {}
  try {
    for (const c of await channelStates()) {
      channels[c.channel === 'line' ? 'line' : 'messenger'] = {
        name: c.name, enabled: c.enabled, reachable: c.enabled && c.state !== 'off',
        status: !c.enabled ? 'disabled' : c.state === 'ok' || c.state === 'idle' ? 'healthy'
              : c.state === 'down' ? 'down' : 'unknown',
        lastWebhookAt: c.last_message_at ?? null, detail: c.reason ?? null,
      }
    }
  } catch (e) {
    log.warn('system_channels_failed', { reason: e.message })
  }

  // คิว: ตัวเลขจาก connect_private.job ที่มีอยู่แล้ว — คิวค้างนานเกินเกณฑ์ถือว่าเสื่อม ไม่ใช่ล่ม
  let queue = { pending: null, processing: null, failed: null, oldest_min: null, status: 'unknown' }
  try {
    const q = await rpcDirect(service, 'health_queue')
    const age = q.oldest_min ?? 0
    queue = { ...q, status: age >= th.queue_age.crit ? 'degraded' : age >= th.queue_age.warn ? 'warn' : 'healthy' }
  } catch (e) {
    log.warn('health_queue_unreadable', { reason: e.message })
  }

  const channelDown = Object.values(channels).some(c => c.status === 'down')
  const overall =
    database.status === 'down' || workers.inbound.status === 'down' ? 'down'
    : channelDown || workers.outbound.status !== 'healthy' || workers.inbound.status !== 'healthy'
      || queue.status !== 'healthy' ? 'degraded'
    : 'healthy'

  return { overall, checkedAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: APP_VERSION,
           environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
           database, channels, workers, queue, shadowMode: shadow, shadowDefault }
}

// รอบคำนวณของตัวเอง (15 วินาที) — คำขอไหนมาถี่กว่านั้นใช้ของเดิม ใครมาตอนกำลังคำนวณรอผลตัวแรก
// คำนวณไม่สำเร็จไม่เป็นไร รอบหน้าลองใหม่ ของเก่ายังตอบได้
function refreshSystemStatus() {
  if (sysPending) return sysPending
  if (Date.now() - sysAt < SYS_TTL) return Promise.resolve(sysCache)
  sysPending = computeSystemStatus()
    .then(r => { sysCache = r; sysAt = Date.now(); return r })
    .catch(e => log.warn('system_status_failed', { reason: e.message }))
    .finally(() => { sysPending = null })
  return sysPending
}

// คำตอบเต็มสำหรับหน้า admin — สถานะสด (บังคับคำนวณใหม่) บวกกฎ/เหตุการณ์จาก snapshot ของฐาน
async function fullSystemStatus(userToken) {
  const system = await refreshSystemStatus()
  let snapshot = null
  try { snapshot = await rpcDirect(userToken, 'health_snapshot') } catch (e) {
    log.warn('system_snapshot_failed', { reason: e.message })
  }
  return { ...system, rules: snapshot?.rules ?? [], stats: snapshot?.stats ?? [],
           events: snapshot?.events ?? [], pending: snapshot?.pending ?? null,
           workspace: snapshot?.workspace ?? null, can_edit: snapshot?.can_edit ?? false,
           tls_days: snapshot?.tls_days ?? null }
}

// ข้อทดสอบฝั่งโพรเซสสำหรับปุ่ม Run Self-Test — รายงานแค่ configured/missing/healthy/stale
// ★ ห้ามมีค่าตัวแปรออกไปเป็นไม้ตาย ไม่ว่าจะ secret หรือ URL ภายใน
async function systemExtraTests() {
  const t0 = Date.now()
  const tests = []
  const h = health()

  let th = { inbound_worker: { warn: 1, crit: 5 }, outbound_worker: { warn: 1, crit: 5 }, queue_age: { warn: 3, crit: 10 } }
  try { th = { ...th, ...(await rpcDirect(service, 'health_thresholds')) } } catch { /* ใช้ค่าตั้งต้น */ }

  const ageOf = ms => Math.round(ms / 6000) / 10
  tests.push({ name: 'Inbound Worker', ok: h.inboundIdleFor <= WORKER_STALE_MS, ms: 0,
               detail: !activeChannels.length ? 'ไม่มีช่องทางเปิดใช้'
                     : `สำเร็จล่าสุด ${ageOf(h.inboundIdleFor)} นาทีที่แล้ว (เกณฑ์ ${th.inbound_worker.warn}/${th.inbound_worker.crit} นาที)` })
  tests.push({ name: 'Outbound Worker', ok: h.idleFor <= WORKER_STALE_MS, ms: 0,
               detail: shadow ? 'โหมดเงา: ตั้งใจไม่ส่งออก จึงไม่นับว่าเงียบ'
                     : !activeChannels.length ? 'ไม่มีช่องทางเปิดใช้'
                     : `สำเร็จล่าสุด ${ageOf(h.idleFor)} นาทีที่แล้ว (เกณฑ์ ${th.outbound_worker.warn}/${th.outbound_worker.crit} นาที)` })
  try {
    const q = await rpcDirect(service, 'health_queue')
    tests.push({ name: 'Queue', ok: true, ms: 0,
                 detail: `pending ${q.pending} · processing ${q.processing} · failed ${q.failed}` +
                         (q.oldest_min != null ? ` · เก่าสุด ${q.oldest_min} นาที` : '') })
  } catch (e) {
    tests.push({ name: 'Queue', ok: false, ms: 0, detail: 'อ่านตัวเลขคิวไม่ได้' })
  }
  tests.push({ name: 'Shadow Mode', ok: true, ms: 0,
               detail: shadow ? 'ON — รับเข้าอย่างเดียว ไม่ส่งออกหาลูกค้า' : 'OFF — ส่งจริง' })
  // ตัวแปรที่จำเป็น: รายงานแค่ชื่อว่า configured/missing — ไม่มีค่า
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
  const missing = required.filter(k => !process.env[k])
  if (!channels.length && !process.env.CONNECT_CHANNELS_FILE) missing.push('CONNECT_CHANNELS_FILE')
  tests.push({ name: 'Environment', ok: missing.length === 0, ms: 0,
               detail: missing.length ? `missing: ${missing.join(', ')}` : `configured ครบ ${required.length} รายการ` })
  return tests.map(t => ({ ...t, ms: t.ms || Date.now() - t0 }))
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

// คุกกี้กลับมาแล้ว ด่านนี้จึงเป็นด่านกัน CSRF ตัวจริงอีกครั้ง ไม่ใช่แค่กันเว็บอื่นสั่งงานแทน
// เบราว์เซอร์แนบคุกกี้ให้เองทุกคำขอ ถ้าไม่ตรวจต้นทาง เว็บอื่นที่ผู้ใช้เปิดค้างไว้จะสั่งงานในนามเขาได้
// (Content-Type: application/json บังคับให้ต้อง preflight ก่อน ซึ่งเราไม่ตอบ — ด่านนี้คือชั้นที่สอง)
// บังคับกับทุกทางที่เปลี่ยนข้อมูล รวมทั้ง /api/login และ /api/logout
function checkOrigin(req) {
  if (req.headers.origin !== origin) throw fail(403, 'invalid_origin')
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'json_required')
}

// ───────────────────────────────────────────────────────── เส้นทาง

async function handleWebhook(req, res, url) {
  const key = url.pathname.split('/')[2]
  const config = activeChannels.find(c => c.key === key)

  // ★ ช่องทางที่ "เลิกใช้แล้วโดยตั้งใจ" ต้องตอบ 200 ไม่ใช่ 503
  //   LINE/Meta ยิงซ้ำเมื่อไม่ได้ 200 และถ้าล้มเหลวติดกันนาน ๆ จะปิด endpoint ทิ้งเอง
  //   ซึ่งวันที่อยากเปิดช่องนี้กลับ จะต้องไปตั้งใหม่ทั้งหมดโดยไม่มีใครรู้ว่าทำไม
  //   ตอบ 200 แล้วทิ้ง = บอกปลายทางว่า "รับแล้ว ไม่ต้องส่งซ้ำ" แต่เราไม่เอาเข้าระบบ
  //
  //   แยกจาก "ตั้งค่าไม่ครบ" ชัดเจน — อันนั้นคือความผิดพลาดที่ต้องดังพอให้คนเห็น
  //   จึงยังตอบ 503 ต่อไป ไม่ควรกลบด้วย 200 เหมือนกัน
  if (!config) {
    const retired = channels.find(c => c.key === key && c.enabled === false)
    if (retired) {
      log.info('webhook_ignored', { channel: key, เหตุ: 'ช่องทางนี้ปิดใช้งานไว้' })
      return json(res, 200, { accepted: false, ignored: 'channel_disabled' })
    }
    throw webhookFail(503, 'channel_not_configured', key, { ตั้งค่าไว้: channels.map(c => c.key), เปิดใช้อยู่: activeChannels.map(c => c.key) })
  }

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
    // ★ ลายเซ็นไม่ผ่าน = ยังไม่รู้ว่าใครส่งมา จึงต้องเก็บเบาะแสให้พอไล่ต้นทางได้
    //   "ค่าลับผิด" กับ "มีคนอื่นยิงมั่ว" เป็นคนละเรื่องและแก้คนละทาง แต่ log เดิมแยกไม่ออก
    //   ห้ามบันทึกตัวข้อความลูกค้า — เก็บแค่เปลือกนอกที่บอกได้ว่ามาจากไหน
    let เค้าโครง = null
    try {
      const b = JSON.parse(raw.toString('utf8'))
      เค้าโครง = { object: b?.object ?? null,
                   entries: Array.isArray(b?.entry) ? b.entry.length : null,
                   entry_id: b?.entry?.[0]?.id ?? null,
                   destination: b?.destination ?? null }
    } catch { เค้าโครง = 'ไม่ใช่ JSON' }

    // ★ ต้องลงฐานด้วย ไม่ใช่ลง stdout อย่างเดียว — ไฟแดงบน chip ตัดสินจากตารางนี้
    //   log ของ container หายทุกครั้งที่สร้างใหม่ ถ้าเก็บแค่ที่นั่น สถานะจะรีเซ็ตตัวเองเงียบ ๆ
    //   เขียนไม่สำเร็จก็ยังต้องปฏิเสธคำขอต่อ การบันทึกล้มเหลวไม่ใช่เหตุให้ยอมรับของที่พิสูจน์ไม่ได้
    await rpcDirect(service, 'webhook_reject', {
      p_data: { channel_key: key, channel: config.channel, inbox_id: config.inbox_id ?? null,
                reason: 'invalid_signature', bytes: raw.length,
                ua: req.headers['user-agent'] ?? null, shape: เค้าโครง },
    }).catch(e => log.warn('webhook_reject_log_failed', { channel: key, reason: e.message }))
    flowHealth.log('signature_fail', { channel: key, ok: false })

    throw webhookFail(401, 'invalid_signature', key, {
      ส่งลายเซ็นมาด้วย: Boolean(signature),
      ขนาด: raw.length,
      ua: req.headers['user-agent'] ?? null,
      เค้าโครง,
    })
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

  // ★ คำสั่ง "test" ของบัญชีทดสอบ — ถอดออกก่อนเข้าคิวขาเข้า
  //   ต้องอยู่หลัง verify signature (ไม่งั้นใครก็ยิงคำสั่งนี้ได้) แต่ก่อน log
  //   เพราะข้อความนี้ไม่ใช่ข้อความลูกค้า ไม่ควรเปิดเคสหรือนับเป็นงาน
  //
  //   ★ ถอด "เฉพาะ event ที่เป็นคำสั่ง" ไม่ใช่ตัดทั้งก้อน — ก้อนเดียวอาจมี
  //     ข้อความลูกค้าจริงคนอื่นปนมาด้วย ตัดทั้งก้อนแล้วข้อความนั้นจะหายเงียบ ๆ
  const { hits, rest, remaining } = splitTestEvents(config.channel, body, TEST_USER_IDS)
  if (hits.length) await runTestResets(hits, config, key)
  if (hits.length && remaining === 0) {
    return json(res, 200, { accepted: true, test_reset: hits.length })
  }

  const logged = await rpc(service, 'log',
    { channel_key: key, channel: config.channel, inbox_id: config.inbox_id,
      payload: hits.length ? rest : body }, true)
  log.info('webhook_accepted', { channel: key, log_id: logged.log_id,
                                 ...(hits.length ? { test_reset: hits.length } : {}) })
  // จุดหมายของกฎ "ไม่มีข้อความเข้า" — ช่องทางไหนเงียบผิดปกติ ตัวเลขบน /admin/health จะหยุดก่อนใครจะรู้ตัว
  flowHealth.log('webhook', { channel: key, ref: logged.log_id })
  return json(res, 200, { accepted: true, log_id: logged.log_id })
}

// ───────────────────────────────────────────── คำสั่งทดสอบ
//
// ทีมต้องทดสอบบอทบ่อย แต่แชทที่เคยถูกตั้ง mode='human' จะเงียบถาวร
// พิมพ์ "test" จากบัญชีในรายชื่อ = ล้างสถานะแชทนั้นให้กลับไปเริ่มใหม่
//
// ★ รายชื่อบัญชีทดสอบอยู่ใน env ไม่ได้อยู่ในฐาน (เหมือน token ทุกตัวในระบบนี้)
//   ฐานไม่ต้องรู้ว่าใครเป็นบัญชีทดสอบ รู้แค่ว่าถูกสั่งให้รีเซ็ตแชทไหน
//
// ★ ต้องตรงทั้งข้อความเท่านั้น — "test ระบบ" เป็นข้อความลูกค้าปกติ
//   ถ้าจับแบบขึ้นต้นด้วย test ลูกค้าจริงที่พิมพ์คำนี้จะโดนรีเซ็ตแชทตัวเอง
const TEST_USER_IDS = testUserIds()

// ───────────────────────────────────────────── Meta App Review
//
// ผู้ตรวจสอบ (test_only) ต้องทดสอบ pages_messaging ด้วยบัญชี Messenger จริง
// พิมพ์ข้อความขึ้นต้นด้วยรหัสนี้จาก asher-messenger เท่านั้น = ติดธง is_test ให้บทสนทนา
// เพื่อไม่ให้ปนกับงานขายจริง — คนละกลไกกับ TEST_USER_IDS ข้างบน (นั่นคือรีเซ็ตแชทให้บอทเริ่มใหม่
// ส่วนนี้คือกันบอทตอบ/ไม่นับสถิติ ดู sql/202609191500_review_code.sql)
const META_REVIEW_CODE = reviewCode()

async function runTestResets(hits, config, key) {
  for (const hit of hits) {
    try {
      const r = await rpc(service, 'reset_test', {
        inbox_id: config.inbox_id, channel: config.channel, external_id: hit.userId,
      }, true)
      log.warn('test_reset', { channel: key, conversation: r.conversation_id,
                               previous_mode: r.previous_mode, cancelled_jobs: r.cancelled_jobs })
      await deliver({
        kind: 'send', channel: config.channel, inbox_id: config.inbox_id, target: hit.userId,
        payload: { type: 'text', text: '🧪 รีเซ็ตแล้ว — บอทพร้อมตอบ เริ่มทดสอบได้เลย' },
      }, { ...config, reply_token: hit.replyToken })
    } catch (e) {
      // รีเซ็ตไม่สำเร็จก็ยังต้องกินข้อความนี้ทิ้ง ไม่ปล่อยให้ไหลไปเป็นข้อความลูกค้า
      log.error('test_reset_failed', { channel: key, reason: e.message })
    }
  }
}

async function handleCommand(req, res) {
  const accessToken = await sessions.access(req)
  const input = JSON.parse((await readBody(req)).toString('utf8'))
  if (typeof input.action !== 'string' || !input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
    throw fail(400, 'invalid_request')
  }

  // ทางไป Edge Function: action ขึ้นต้นด้วย fn: แล้วตามด้วยชื่อในทะเบียน
  // แยกทางกันตั้งแต่ตรงนี้ เพราะคำตอบไม่ผ่านตัวแปลของ connect_api และไม่ควรผ่าน
  // ★ จำนวนเคสของทุกตัวกรอง — นับที่ฐานทีเดียว ไม่ใช่ให้เบราว์เซอร์ไล่ขอทีละหน้าแล้วนับเอง
  //   ยิงด้วย token ของคนที่ล็อกอิน ไม่ใช่ service — auth.uid() จึงเป็นคนจริงและ can_read() ยังบังคับ
  //   ไม่ได้ผ่านประตู connect_api เพราะเป็นการอ่านของชั้นนี้เอง ไม่ใช่คำสั่งที่ต้องลง audit
  if (input.action === 'queue_counts') {
    return json(res, 200, await rpcDirect(accessToken, 'queue_counts', { p_search: String(input.data.search ?? '') }))
  }

  // ★ หน้าสถิติ — ทางเดียวกันกับ queue_counts คือยิงด้วย token ของคนที่ล็อกอิน
  //   ★★ ด่านสิทธิ์อยู่ที่ inbox.stats_scope() ในฐาน (manager ขึ้นไป) ไม่ใช่ที่บรรทัดนี้
  //   ที่นี่ทำแค่กันไม่ให้เรียกฟังก์ชันนอกทะเบียน — ใครยิง /api/command ตรง ๆ
  //   ด้วย action stats_agents ก็จะไปตายที่ฐานด้วย 42501 ตามที่ควรเป็น
  //   การซ่อนปุ่มบนหน้าเว็บเป็นเรื่องความสะอาดตาเท่านั้น ไม่นับเป็นการป้องกัน
  if (STATS_ACTIONS.has(input.action)) {
    return json(res, 200, await rpcDirect(accessToken, input.action, { p: input.data }))
  }

  // ★ หน้า log — ทางเดียวกับหน้าสถิติ ยิงด้วย token ของคนที่ล็อกอิน
  //   ด่านสิทธิ์ (admin เท่านั้น) อยู่ที่ inbox.stats_scope('admin') ในฐาน
  //   log มีข้อความลูกค้าดิบ จึงแคบกว่าหน้าสถิติที่เปิดถึง manager
  if (LOG_ACTIONS.has(input.action)) {
    return json(res, 200, await rpcDirect(accessToken, input.action, { p: input.data }))
  }

  // ★ คลังคำตอบ (Phase 6) — เดินผ่าน Answer Service เป็นชั้นกลางเท่านั้น
  //   ด่านสิทธิ์จริงอยู่ในฟังก์ชัน inbox.ah_* ของฐาน (sales อ่าน approved · manager แก้ ·
  //   admin อนุมัติ/ปลดใช้) · service เพิ่ม: flags (default ปิด), error model ANSWER_*,
  //   validity/bot rules, orchestrate resolve+render — รายละเอียด services/answer-hub/service.mjs
  if (AH_ACTIONS.has(input.action)) {
    return json(res, 200, await answerHub.handle(input.action, accessToken, input.data ?? {}))
  }

  // Quick Reply management uses dedicated security-definer RPCs. The browser
  // only sends the user's session token; role checks remain in Supabase.
  if (input.action === 'quick_replies_list') {
    return json(res, 200, await rpcDirect(accessToken, 'qr_list', { p_project: null, p_query: input.data.query || null, p_category: input.data.category || null }))
  }
  if (input.action === 'quick_reply_upsert') {
    const who = await rpc(accessToken, 'bootstrap')
    if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
    return json(res, 200, await rpcDirect(accessToken, 'qr_upsert', { p_data: input.data }))
  }
  if (input.action === 'quick_reply_toggle') {
    const who = await rpc(accessToken, 'bootstrap')
    if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
    return json(res, 200, await rpcDirect(accessToken, 'qr_toggle', { p_id: input.data.id, p_active: input.data.active, p_bot_enabled: null }))
  }
  if (input.action === 'quick_reply_import_preview' || input.action === 'quick_reply_import_apply') {
    const who = await rpc(accessToken, 'bootstrap')
    if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
    const parsed = parseQuickReplyFile({ filename: input.data.filename, content: input.data.content })
    const existing = await rpcDirect(accessToken, 'qr_list', { p_project: null, p_query: null, p_category: null })
    const classified = classifyQuickReplies(parsed.rows, existing)
    const summary = {
      total: classified.length + parsed.invalid.length,
      ready: classified.filter(x => x.status === 'NEW').length,
      update: classified.filter(x => x.status === 'UPDATE').length,
      duplicate: classified.filter(x => x.status === 'SKIP').length,
      inactive: classified.filter(x => !x.active).length,
      errors: parsed.invalid.length,
    }
    if (input.action === 'quick_reply_import_preview') return json(res, 200, { summary, rows: classified, invalid: parsed.invalid })
    if (parsed.invalid.length) throw fail(400, 'invalid_import_rows')
    const result = { imported: 0, updated: 0, skipped: 0, errors: [], inactive: classified.filter(x => !x.active).map(x => x.shortcut) }
    for (const row of classified) {
      if (row.status === 'SKIP') { result.skipped++; continue }
      try {
        await rpcDirect(accessToken, 'qr_upsert', { p_data: {
          id: row.id || '', project: 'all', title: row.title, shortcut: row.shortcut,
          category: row.category, body: row.body, sort_order: row.sort_order,
          active: row.active, intents: [], source: row.source, image_url: row.image_url,
        } })
        if (row.status === 'UPDATE') result.updated++; else result.imported++
      } catch (error) {
        result.errors.push({ row: row._row, shortcut: row.shortcut, code: 'import_row_failed' })
      }
    }
    return json(res, 200, { summary, result })
  }

  if (input.action.startsWith('fn:')) {
    const name = input.action.slice(3)
    if (!edgeFunctions.includes(name)) throw fail(404, 'function_not_registered')
    const reply = await edgeCall(name, input.data, accessToken)
    res.writeHead(reply.status, { 'Content-Type': reply.type })
    return res.end(reply.text)
  }

  if (input.action === 'send') {
    // ด่านแรกสุด ก่อนแตะอะไรทั้งนั้น — ในโหมดเงายังมีบอทตัวเดิมคุยกับลูกค้าอยู่
    // ถามฐานก่อนเสมอ (มีตัวกันถี่ 3 วินาทีอยู่แล้ว) เพราะ admin อาจเพิ่งกดปิดไปเมื่อครู่
    await refreshSendMode()
    if (shadow) throw fail(503, 'shadow_mode')
    const detail = await rpc(accessToken, 'messages', { id: input.data.id })
    // ปลายทางมาจากบทสนทนาในฐานเท่านั้น ไม่เคยมาจากเบราว์เซอร์
    const list = await rpc(accessToken, 'bootstrap')
    if (!list.user) throw fail(403, 'not_allowed')
    if (!activeChannels.some(c => c.channel === detail.channel)) throw fail(503, 'channel_not_configured')
  }

  const data = await rpc(accessToken, input.action, input.data)

  // ท่อรูป: media เก็บที่คอลัมน์ inbox.message.media โดยไม่แตะ connect_private.api
  // (เหตุผลใน sql/037) — ตรงนี้จึงเติมเข้าคำตอบของ detail ก่อนส่งกลับหน้าจอ
  // ถ้าอ่านแผนที่ไม่สำเร็จให้ข้ามไป หน้าจอต้องยังเปิดได้ ขาดได้แค่รูป
  await enrichMessageMedia(input.action, data, input.data?.id, id =>
    rpcDirect(accessToken, 'media_of', { p_conversation_id: id })
      .catch(e => { log.warn('media_lookup_failed', { reason: e.message }); return null }))

  if (input.action === 'bootstrap') {
    data.channels = await channelStates()
    // Quick replies are team-shared templates.  Loading them server-side keeps
    // the service role key out of the browser and lets the existing canned
    // response fallback continue working if this optional RPC is unavailable.
    try {
      data.quick_replies = await rpcDirect(accessToken, 'qr_list', { p_project: null, p_query: null, p_category: null })
    } catch (e) {
      log.warn('quick_replies_unavailable', { reason: e.message })
      data.quick_replies = []
    }
  }
  // ตัวเลขมาจากฐาน ถ้อยคำมาจากที่นี่ — คนละหน้าที่กัน และแยกกันไว้ตั้งแต่แรก
  if (input.action === 'report_preview' && data?.report) data.text = buildDailyDigest(data.report)
  return json(res, 200, data)
}

// ไฟล์หน้าเว็บรับเฉพาะชื่อที่ตรงแบบเป๊ะ ไม่ประกอบ path จากสิ่งที่ผู้ใช้ส่งมา
// ตัวชี้ขาดคือตารางกับ regex นี้ ไม่ใช่การกรอง ".." ทีหลัง ซึ่งพลาดได้หลายทาง
const staticFiles = { '/answer-hub': 'index.html', '/answer-hub.js': 'answer-hub.js', '/answer-hub.css': 'answer-hub.css', '/quick-answer.js': 'quick-answer.js', '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/login.css': 'login.css', '/fonts/plex.css': 'fonts/plex.css',
  '/sla.mjs': 'sla.mjs', '/quick-replies.js': 'quick-replies.js', '/quick-replies': 'quick-replies-admin.html', '/quick-replies-admin.js': 'quick-replies-admin.js',
  '/stats': 'stats.html', '/stats.js': 'stats.js', '/stats.css': 'stats.css',
  '/logs': 'logs.html', '/logs.js': 'logs.js', '/logs.css': 'logs.css',
  // แผ่นสไตล์กับสคริปต์ของหน้า /admin/health — ตัวหน้าเองเสิร์ฟโดย health.handle
  '/health.css': 'health.css', '/health.js': 'health.js' }

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'method_not_allowed')

  const font = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname)
  const target = font ? `fonts/${font[1]}` : staticFiles[url.pathname]
  if (!target) throw fail(404, 'not_found')

  const data = await readFile(join(root, 'public', target)).catch(() => { throw fail(404, 'not_found') })
  const type = font ? 'font/woff2'
    : url.pathname.endsWith('.js') || url.pathname.endsWith('.mjs') ? 'text/javascript; charset=utf-8'
    : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8'
    : 'text/html; charset=utf-8'

  // ฟอนต์เปลี่ยนเมื่อเปลี่ยนชื่อไฟล์เท่านั้น จึงแคชได้ยาว
  // ส่วนหน้าเว็บกับสคริปต์ยังคง no-store ตามที่ตั้งไว้ด้านบน
  if (font) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.writeHead(200, { 'Content-Type': type })
  res.end(req.method === 'HEAD' ? undefined : data)
}

// รูป/ไฟล์ที่ท่อสื่อแนบเก็บไว้ — เสิร์ฟผ่านตัวเองเพื่อคุมสิทธิ์ด้วยเซสชันเดียวกับหน้าจอ
// bucket เป็น private และห้ามให้เบราว์เซอร์คุยกับ Storage ตรง ๆ จึงส่งผ่านตรงนี้
const handleMedia = createMediaHandler({
  sessions, rpcDirect, fail,
  fetchObject: path => fetch(`${upstream}/storage/v1/object/authenticated/inbox-media/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${service}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  }),
})

async function route(req, res, url) {
  // หน้า /admin/health ใช้เปลือกเดียวกับแอปหลัก (header/sidebar/เซสชันคุกกี้เดิม — ไม่มีล็อกอินแยกอีกแล้ว)
  // เสิร์ฟ index.html เหมือน "/" ล็อกอินเป็นหน้าที่ของ app.js (bootstrap ไม่ผ่าน → ฟอร์มเดิม → กลับมาหน้าเดิม)
  // ★ ต้องตัดมาก่อน flowHealth.handle ไม่งั้นหน้า standalone (health.html + password grant แยก) ชิงไปเสิร์ฟ
  if (url.pathname === '/admin/health' && req.method === 'GET') return handleStatic(req, res, new URL('/', origin))
  // ประตูของระบบเช็ค: /healthz สำหรับ monitor ภายนอก · /api/health/* (เส้นเก่าของตัวเช็ค ยังใช้กับเทสต์ SQL)
  // ด่านสิทธิ์ของหน้านี้อยู่ใน SQL (health_can_view) ไม่ได้พึ่งการซ่อนทางเข้า
  if (await flowHealth.handle(req, res)) return
  if (url.pathname === '/health' && req.method === 'GET') {
    const state = health()
    return json(res, state.ok ? 200 : 503, state)
  }
  if (url.pathname.startsWith('/webhooks/')) return handleWebhook(req, res, url)

  if (url.pathname.startsWith('/api/')) {
    // ── Admin System Status: ด่านสิทธิ์อยู่ที่ health_can_view() ในฐาน (manager ขึ้นไป)
    //    ที่นี่ด่านเดียวคือเซสชันต้องถูกต้อง — ใครยิงตรง ๆ โดยไม่ล็อกอินตายที่ sessions.access
    if (url.pathname === '/api/admin/system-health' && req.method === 'GET') {
      const token = await sessions.access(req)
      if (!(await rpcDirect(token, 'health_can_view'))) throw fail(403, 'not_allowed')
      return json(res, 200, await fullSystemStatus(token))
    }
    if (url.pathname === '/api/admin/system-health/test' && req.method === 'POST') {
      checkOrigin(req)
      const token = await sessions.access(req)
      if (!(await rpcDirect(token, 'health_can_view'))) throw fail(403, 'not_allowed')
      const steps = await flowHealth.selftest()
      const passed = steps.filter(s => s.ok).length
      return json(res, 200, { ok: passed === steps.length, passed, failed: steps.length - passed,
        tests: steps.map(s => ({ name: s.name, result: s.ok ? 'PASS' : 'FAIL', ms: s.ms ?? 0, detail: s.detail ?? null })) })
    }
    // บันทึกกฎแจ้งเตือนผ่านเซสชันเดิมของหน้าจอ (เดิมหน้า standalone ใช้ token Supabase แยก)
    // ด่าน "ดู" อยู่ที่ health_can_view — ด่าน "แก้" อยู่ใน health_rule_save เอง (admin เท่านั้น ตรวจค่าใน SQL ต่อ)
    if (url.pathname === '/api/admin/health-rule' && req.method === 'POST') {
      checkOrigin(req)
      const token = await sessions.access(req)
      if (!(await rpcDirect(token, 'health_can_view'))) throw fail(403, 'not_allowed')
      const b = JSON.parse((await readBody(req)).toString('utf8'))
      await rpcDirect(token, 'health_rule_save', {
        p_id: b.id, p_enabled: b.enabled ?? null, p_params: b.params ?? null, p_level: b.level ?? null,
        p_notify: b.notify ?? null, p_hour_from: b.hour_from ?? null, p_hour_to: b.hour_to ?? null,
      })
      // ประเมินกฎทันทีแทนรอ tick รอบหน้า — health_tick เป็น service_only จึงต้องยิงด้วย service key
      // (health.mjs ก็เรียกแบบไม่ใส่ token ผู้ใช้ด้วยเหตุผลเดียวกัน)
      await rpcDirect(service, 'health_tick')
      return json(res, 200, { ok: true })
    }
    if (req.method !== 'POST') throw fail(405, 'method_not_allowed')
    checkOrigin(req)
    if (url.pathname === '/api/login') return json(res, 200, await sessions.login(req, res, JSON.parse((await readBody(req, 4096)).toString('utf8'))))
    if (url.pathname === '/api/logout') return json(res, 200, await sessions.logout(req, res))
    if (url.pathname !== '/api/command') throw fail(404, 'not_found')
    return handleCommand(req, res)
  }

  if (url.pathname.startsWith('/media/')) return handleMedia(req, res, url)

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

// เซสชันที่หมดอายุไม่มีเจ้าของกลับมาลบให้ ทิ้งไว้คือ refresh token ที่ยังใช้ได้นอนอยู่ในดิสก์
const sessionTimer = setInterval(() => {
  sessions.sweep()
    .then(r => { if (r.deleted) log.info('session_swept', { deleted: r.deleted }) })
    .catch(e => log.warn('session_sweep_failed', { reason: e.message }))
}, 600000); sessionTimer.unref()

// ตัวเช็ควิ่งเป็นรอบเอง (ทุกนาที: ประตู+ฐาน · ทุกชั่วโมง: TLS+token · ประเมินกฎแล้วยิง Telegram)
// ปิดได้ด้วย CONNECT_HEALTH=off เช่นตอนรันชุดทดสอบ — ไม่งั้นมาจะยิงออกนอกเครื่องเอง
if (process.env.CONNECT_HEALTH !== 'off') flowHealth.start()

// สถานะรวมคำนวณเป็นรอบของตัวเอง — /health กับหน้า admin หยิบของที่คำนวณไว้เสมอ ไม่มีใครไปบล็อกใคร
// รอบแรกหลังบูต 1.5 วินาที กัน status ค้าง unknown จนครบ 15 วินาทีแรก
setTimeout(refreshSystemStatus, 1500).unref()
const sysTimer = setInterval(refreshSystemStatus, SYS_TTL); sysTimer.unref()

server.listen(port, '0.0.0.0', () => console.log(`ASHER Connect listening on ${port}; ${activeChannels.length} active channel(s)${shadow ? ' · โหมดเงา: รับเข้าอย่างเดียว ไม่ส่งออก' : ''} · ล็อกอินรายบุคคล`))

process.on('SIGTERM', () => {
  clearInterval(workerTimer)
  clearInterval(inboundTimer)
  clearInterval(sweepTimer)
  clearInterval(sessionTimer)
  clearInterval(sysTimer)
  flowHealth.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 20000).unref()
})
