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
import { verifySignature, matchesDestination, normalizeWebhook, deliver, sendMulticast, lineQuota } from './providers.mjs'
import { fetchProfile } from './lib/profile.mjs'
import { mediaTasks, storagePath, enrichMessageMedia, MEDIA_MAX_BYTES } from './lib/media.mjs'
import { createMediaHandler } from './lib/media-http.mjs'
import { randomUUID } from 'node:crypto'
import { createOutboundMediaUrl, safeOutboundPath, verifyOutboundMedia } from './lib/outbound-media.mjs'
import { createQuotationImageUrl, verifyQuotationImageUrl, verifyQuotationUrl } from './lib/quotation-link.mjs'
import { createQuotationImageStore } from './lib/quotation-image.mjs'
import { createUnitQuotationImages, UNIT_QUOTE_PREFIX } from './lib/unit-quotation-images.mjs'
// ตัวนำเข้า Saved Replies — zero-dependency ตามบ้านนี้ (image ไม่มีขั้น npm install)
import { parseImport, previewRows, validateRow, CATEGORIES, MAX_IMPORT_BYTES, MAX_ROWS as MAX_IMPORT_ROWS } from './lib/quick-replies-import.mjs'
import { generateReply, maskPII, loadProjectData } from './bots/reply.mjs'
import { classifyOnly, intentRow } from './bots/classify.mjs'
import { formatNotify, notifyTargets } from './bots/notify.mjs'
import { testUserIds, splitTestEvents } from './bots/testcmd.mjs'
import { buildDailyDigest } from './reports/reply-digest.mjs'
import { flagRpc } from './lib/case-flags.mjs'
import { classifyCrmFailure, crmBackoffMs, parseProjectMap, projectRefFor } from './lib/crm-publisher.mjs'
import { tokenMatches, bearerToken, validateMessages, normalizeRecipients, parseAllowlist,
         classifyMulticast, quotaAllows, MULTICAST_MAX } from './lib/broadcast.mjs'

// ───────────────────────────────────────────────────────── ตั้งค่า

const root = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 3200)
const origin = new URL(process.env.CONNECT_PUBLIC_URL || `http://localhost:${port}`).origin
const upstream = process.env.SUPABASE_URL
const anon = process.env.SUPABASE_ANON_KEY
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!upstream || !anon || !service) throw new Error('Supabase configuration required')
const outboundMediaSigningKey = process.env.OUTBOUND_MEDIA_SIGNING_KEY || service
const crmUrl = (process.env.ASHER_CRM_URL || '').replace(/\/$/, '')
const crmToken = process.env.ASHER_CRM_CONNECT_TOKEN || ''
const crmWorkspaceId = process.env.ASHER_CRM_WORKSPACE_ID || ''

// ───────────────────────────────────────────── Connect -> CRM publisher
//
// ★★ ตัวนี้ "หายไป" จาก server.mjs ตอน 20a7799 (snapshot ของ VPS เขียนทับ repo ด้วยไฟล์
//    ที่เก่ากว่า −870 บรรทัด) ผลคือ trigger ยังเขียนแถวเข้า inbox.crm_publish_outbox
//    เรื่อย ๆ แต่ไม่มีใครดูด — คิวค้างเงียบ ๆ มาตั้งแต่ 29 ก.ย.
//    กู้กลับจาก 20a7799^:server.mjs ซึ่งเป็นรุ่นล่าสุดก่อนถูกลบ (มี project_ref ครบ
//    ต่างจากรุ่นแรกใน 8295043 ที่ยังไม่มี)
//
// ★ ปิดไว้เป็นค่าตั้งต้น: ต้องตั้ง ASHER_CRM_PUBLISH_ENABLED เอง และต้องมี url/token/workspace
//   ครบถึงจะเดิน ขาดอย่างใดอย่างหนึ่ง = ไม่เดิน แต่ยังรายงานสถิติให้เห็นว่าคิวค้างเท่าไร
const crmPublisherEnabled = process.env.ASHER_CRM_PUBLISH_ENABLED === 'true' || process.env.ASHER_CRM_PUBLISH_ENABLED === '1'
// ★ ปิดไว้เป็นค่าตั้งต้น — crm_retry_profile_updates ยังไม่มีในฐานโปรดักชัน
//   เปิดได้เมื่อ migration ของฝั่งนั้นขึ้นแล้ว ไม่งั้นรอบ publisher จะเสียเที่ยวทุกครั้ง
const crmProfileRetryEnabled = process.env.ASHER_CRM_PROFILE_RETRY_ENABLED === 'true'
const crmProducer = process.env.ASHER_CRM_PRODUCER || 'connect-sandbox'
const crmPublisherConfigured = Boolean(crmPublisherEnabled && crmUrl && crmToken && crmWorkspaceId)
// ช่องทาง -> โครงการ: CRM สร้าง Lead ได้ต่อเมื่อ conversation.created พก project_ref
// ที่ชี้ไป crm_project_refs ซึ่ง active และ verified_at ไม่ว่าง
const { map: crmProjectMap, invalid: crmProjectMapInvalid } = parseProjectMap(process.env.ASHER_CRM_PROJECT_MAP)
const CRM_PUBLISH_INTERVAL = Number(process.env.ASHER_CRM_PUBLISH_INTERVAL_MS || 3000)
// ★★ ของเดิมตั้งแข็งไว้ 20 ต่อรอบ 3 วินาที = ~400 ใบ/นาที
//    ตอนกู้กลับมีคิวค้างสะสมตั้งแต่ 29 ก.ย. การเปิดสวิตช์จึงเท่ากับยิง backlog
//    ทั้งก้อนเข้า CRM ทันที — ทำให้ปรับได้และตั้งค่าตั้งต้นต่ำ เพื่อให้ค่อย ๆ เร่งได้
//    (เพดาน 100 เป็นของ crm_publish_claim เองอยู่แล้ว)
const CRM_PUBLISH_BATCH = Math.max(1, Math.min(Number(process.env.ASHER_CRM_PUBLISH_BATCH || 5), 100))
const CRM_PUBLISH_LEASE_SECONDS = 60
let crmPublisherRunning = false
let crmPublisherLastSuccess = null
let crmPublisherLastError = null
let crmPublisherStats = { pending: 0, processing: 0, delivered: 0, dead_letter: 0, last_success_at: null, last_error_at: null, oldest_pending_at: null }

async function refreshCrmPublisherStats() {
  try {
    const stats = await rpcDirect(service, 'crm_publish_stats')
    if (stats && typeof stats === 'object') crmPublisherStats = { ...crmPublisherStats, ...stats }
  } catch (e) {
    crmPublisherLastError = new Date().toISOString()
    log.warn('crm_publisher_stats_failed', { reason: e.message })
  }
}

async function crmPublisherWorker() {
  if (crmPublisherRunning) return
  if (!crmPublisherConfigured) {
    // ยังไม่เปิด แต่ถ้ามีใครตั้งค่าไว้บางส่วน ให้ยังเห็นยอดคิวค้างบน /health
    if (crmPublisherEnabled || crmUrl || crmToken || crmWorkspaceId) await refreshCrmPublisherStats()
    return
  }
  crmPublisherRunning = true
  try {
    if (crmProfileRetryEnabled) {
      try { await rpcDirect(service, 'crm_retry_profile_updates', { p_limit: CRM_PUBLISH_BATCH }) }
      catch { log.warn('crm_profile_retry_failed', { code: 'profile_retry_unavailable' }) }
    }
    const rows = await rpcDirect(service, 'crm_publish_claim', {
      p_limit: CRM_PUBLISH_BATCH,
      p_lease_seconds: CRM_PUBLISH_LEASE_SECONDS,
    })
    for (const row of Array.isArray(rows) ? rows : []) {
      let result = 'delivered'
      let errorCode = null
      let errorDetail = null
      let nextAttemptAt = null
      // event ที่ทำให้ CRM เปิด Lead ได้ ต้องพก project_ref ไปด้วย — CRM ใช้ตัวนี้ตัดสิน
      // ไม่มีคู่ที่แมปไว้ = ส่งไปโดยไม่มี project_ref แล้ว CRM ลง project_ref_missing
      // (ไม่มี Lead แต่ contact/conversation ยังเข้าตามปกติ) ดีกว่าผูก Lead ผิดโครงการ
      //
      // ★ follow_changed ต้องอยู่ในรายการนี้ด้วย (เพิ่ม 2026-10-02 ตอนทำ Phase 2):
      //   ฝั่ง CRM เปิด Lead จาก "คนเพิ่มเพื่อน" ซึ่งยังไม่มีบทสนทนา จึงไม่มีทางได้
      //   project_ref จากที่อื่นเลย — และตารางแมปอยู่ใน env ของ Connect โดยเจตนา
      //   (ASHER_CRM_PROJECT_MAP) CRM ไม่ควรต้องรู้ว่า inbox id ไหนคือโครงการอะไร
      const needsProjectRef = ['conversation.created', 'channel_identity.follow_changed']
      let payload = row.payload
      if (needsProjectRef.includes(row.event_type)) {
        const projectRef = projectRefFor(crmProjectMap, payload?.account_scope)
        if (projectRef) {
          payload = { ...payload, project_ref: projectRef }
        } else {
          log.warn('crm_project_map_miss', { account_scope: payload?.account_scope, event_id: row.event_id })
        }
      }
      try {
        const response = await fetch(`${crmUrl}/internal/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${crmToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: row.event_id,
            producer: crmProducer,
            type: row.event_type,
            schema_version: 1,
            workspace_id: crmWorkspaceId,
            aggregate_type: row.aggregate_type,
            aggregate_id: row.aggregate_id,
            aggregate_version: 1,
            occurred_at: row.occurred_at,
            emitted_at: new Date().toISOString(),
            correlation_id: row.aggregate_id,
            causation_id: row.event_id,
            source_is_test: false,
            payload,
          }),
          signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) {
          result = classifyCrmFailure({ status: response.status })
          errorCode = `http_${response.status}`
          errorDetail = (await response.text()).slice(0, 1000)
        }
      } catch (e) {
        result = 'retry'
        errorCode = e.name === 'TimeoutError' ? 'timeout' : 'network_error'
        errorDetail = e.message
      }
      if (result === 'retry') {
        const attempts = Number(row.attempts || 1)
        nextAttemptAt = new Date(Date.now() + crmBackoffMs(attempts)).toISOString()
      }
      await rpcDirect(service, 'crm_publish_finish', {
        p_id: row.id,
        p_status: result,
        p_error_code: errorCode,
        p_error_detail: errorDetail,
        p_next_attempt_at: nextAttemptAt,
      })
      if (result === 'delivered') crmPublisherLastSuccess = new Date().toISOString()
      if (result === 'dead_letter' || result === 'retry') crmPublisherLastError = new Date().toISOString()
    }
    await refreshCrmPublisherStats()
  } catch (e) {
    crmPublisherLastError = new Date().toISOString()
    log.warn('crm_publisher_failed', { reason: e.message })
  } finally {
    crmPublisherRunning = false
  }
}

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

const rpcDirect = (token, fn, body = {}) =>
  callSupabase(DATA, `/rest/v1/rpc/${fn}`, {
    token, method: 'POST', body,
    headers: { 'Content-Profile': 'inbox', 'Accept-Profile': 'inbox' },
  })

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
      if (result.blocked && job.conversation_id) await markBlocked(job.conversation_id)
      return await rpc(service, 'finish', result, true)
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
  const known = [
    context.known_phone ? `Customer ALREADY gave phone number: ${context.known_phone}. Do NOT ask for phone again.` : '',
  ].filter(Boolean).join('\n')

  const { reply, offTopic, intent } = await generateReply({
    text, history: context.history, known, project: context.project,
    style: context.style ?? {}, model: context.model, minConfidence: Number(context.min_confidence ?? 0.6),
    ctx: { is_new_chat: context.is_new_chat },
  })

  await rpc(service, 'bot_reply',
    { conversation_id: job.conversation_id, text: reply, offtopic: offTopic }, true)
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
    return finishJob(job, result)
  }

  const targets = notifyTargets(job.payload ?? {}, process.env)
  if (!targets.length) {
    log.warn('notify_no_target', { job_id: job.id })
    return finishJob(job, { status: 'skipped', skip_reason: 'no_notify_target' })
  }

  const text = formatNotify({ ...job.payload, channel_label: channelLabel(job) }, { inboxUrl: inboxUrlFor(job) })
  const results = await Promise.all(targets.map(t =>
    deliver({ ...job, kind: 'notify', channel: t.channel, target: t.target, payload: { type: 'text', text } }, t.config)))

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
    for (const event of events) received.push(await rpc(service, 'receive', event, true))
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

// ───────────────────────────────────────────── ตัวส่ง LINE หลายคน
//
// spec: docs/handoff/2026-10-02-line-broadcast-sender.md · docs/BOUNDARIES.md
// Connect เป็น "ตัวส่ง" อย่างเดียว — หน้าจอ campaign (เลือกกลุ่ม/เขียน/อนุมัติ/ตั้งเวลา)
// อยู่ที่ CRM ที่นี่จึงไม่มี UI และไม่มีทางเข้าด้วย session ของพนักงาน
//
// ★★ โหมดปลอดภัยเป็นค่าตั้งต้น: LINE_BROADCAST_LIVE ต้องเป็น '1' เป๊ะ ๆ ถึงจะยิงจริง
//    ค่าอื่นทั้งหมด (ไม่ตั้ง / 'true' / '0' / 'yes') = dry run ไม่แตะ network
//    เขียนแบบ allowlist ไม่ใช่ blocklist เพราะพิมพ์ผิดหนึ่งตัวต้องแปลว่า "ไม่ส่ง"
const broadcastLive = process.env.LINE_BROADCAST_LIVE === '1'
const serviceToken = process.env.CONNECT_SERVICE_TOKEN || ''
const broadcastTestAllowlist = parseAllowlist(process.env.BROADCAST_TEST_ALLOWLIST)

/**
 * ด่านของ /internal/* — token ของเครื่องต่อเครื่อง ไม่ใช่ของคน
 *
 * ไม่มี checkOrigin และไม่มีคุกกี้: ผู้เรียกคือ CRM ในวงใน ไม่ใช่เบราว์เซอร์
 * ไม่ตั้ง CONNECT_SERVICE_TOKEN = ประตูปิดสนิท (tokenMatches คืน false เมื่อ expected ว่าง)
 */
function requireServiceToken(req) {
  if (!tokenMatches(bearerToken(req.headers.authorization), serviceToken)) {
    log.warn('service_token_rejected', { path: req.url?.split('?')[0] ?? null })
    throw fail(401, 'unauthorized')
  }
}

// rate limit ต่อ token แบบ fixed window — กันยิงรัวจนฐานล้ม ไม่ได้กันคนร้ายที่ตั้งใจ
// (ด่านตัวจริงคือ token) เก็บในหน่วยความจำพอ เพราะมีผู้เรียกรายเดียวและรีสตาร์ตแล้วเริ่มใหม่ได้
const INTERNAL_RATE_WINDOW_MS = 60000
const INTERNAL_RATE_MAX = Number(process.env.CONNECT_SERVICE_RATE_MAX || 120)
let internalWindowStart = 0, internalHits = 0
function internalRateLimit() {
  const now = Date.now()
  if (now - internalWindowStart > INTERNAL_RATE_WINDOW_MS) { internalWindowStart = now; internalHits = 0 }
  if (++internalHits > INTERNAL_RATE_MAX) throw fail(429, 'rate_limited')
}

const lineChannel = key => activeChannels.find(c => c.key === key && c.channel === 'line') ?? null

/**
 * ลิงก์รูปที่คนนอกเปิดได้ โดยไม่ต้องมี session ของพนักงาน
 *
 * ใช้ตัวเซ็นชื่อตัวเดียวกับที่ส่งรูปให้ LINE/Messenger อยู่แล้ว (lib/outbound-media.mjs)
 * ★ ไม่สร้างกลไกเซ็นชื่อชุดที่สอง — path ที่ไม่ผ่าน safeOutboundPath คืน null
 *   จึงไม่มีทางหลุดเป็นลิงก์ของไฟล์นอกคลัง
 * ★ ถ้า origin ไม่ใช่ https (เช่นตอน dev) ลิงก์จะเป็น http แล้ว validateMessages
 *   จะปฏิเสธเองตอนเอาไปใส่ broadcast — ถูกต้องแล้ว LINE ไม่รับ http
 */
const signedMediaUrl = path =>
  path ? createOutboundMediaUrl(origin, path, outboundMediaSigningKey) : null

// แปลงแถวจาก inbox.media_list ให้ CRM ใช้ได้ — ตัดฟิลด์ที่เป็นเรื่องภายในของ Connect ออก
const mediaForCrm = a => ({
  id: a?.id ?? null,
  title: a?.title ?? null,
  project: a?.project ?? null,
  category: a?.category ?? null,
  mime: a?.mime ?? null,
  width: a?.width ?? null,
  height: a?.height ?? null,
  bytes: a?.bytes ?? null,
  // ชื่อฟิลด์ตรงกับที่ LINE ต้องการใน message type image เพื่อให้ CRM ยกไปใส่ได้ตรง ๆ
  originalContentUrl: signedMediaUrl(a?.storage_path),
  previewImageUrl: signedMediaUrl(a?.preview_path ?? a?.storage_path),
})

async function internalRoute(req, res, url) {
  requireServiceToken(req)
  internalRateLimit()
  const path = url.pathname

  if (req.method === 'POST' && path === '/internal/broadcasts') {
    return json(res, 200, await createBroadcast(JSON.parse((await readBody(req, 1048576)).toString('utf8'))))
  }

  const jobMatch = /^\/internal\/broadcasts\/([0-9a-f-]{36})(\/cancel)?$/i.exec(path)
  if (jobMatch) {
    const [, jobId, cancel] = jobMatch
    if (cancel && req.method === 'POST') {
      const result = await rpcDirect(service, 'broadcast_cancel', { p: { job_id: jobId } })
      log.info('broadcast_cancelled', { job_id: jobId, batches: result?.cancelled_batches ?? 0 })
      return json(res, 200, result)
    }
    if (!cancel && req.method === 'GET') {
      return json(res, 200, await rpcDirect(service, 'broadcast_status', { p: { job_id: jobId } }))
    }
    throw fail(405, 'method_not_allowed')
  }

  if (req.method === 'GET' && path === '/internal/line/quota') {
    const config = lineChannel(url.searchParams.get('channel_key') ?? '')
    if (!config) throw fail(404, 'channel_not_found')
    return json(res, 200, await lineQuota({ accessToken: config.access_token }))
  }

  // ★ คลังรูปของ Connect — CRM ต้องเลือกรูปมาใส่ bubble ของ campaign
  //   (สเปก CRM ส่วน B ข้อ 3: "รูปจาก media library ของ Connect หรือ URL https")
  //   ลิงก์ที่คืนไปเป็นลิงก์เซ็นชื่อ ใช้ได้โดยไม่ต้องมี session — LINE ดึงรูปเองได้
  if (req.method === 'GET' && path === '/internal/media-library') {
    const assets = await rpcDirect(service, 'media_list', {
      p_project: url.searchParams.get('project') || null,
      p_category: url.searchParams.get('category') || null,
      p_query: url.searchParams.get('q') || null,
      p_sort: 'recent', p_conversation_id: null, p_scope: 'library',
    })
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 200))
    return json(res, 200, { items: (Array.isArray(assets) ? assets : []).slice(0, limit).map(mediaForCrm) })
  }

  const contactMatch = /^\/internal\/contacts\/([0-9a-f-]{36})\/(recent-messages|profile)$/i.exec(path)
  if (contactMatch && req.method === 'GET') {
    const [, ref, kind] = contactMatch
    if (kind === 'profile') {
      return json(res, 200, await rpcDirect(service, 'broadcast_contact_profile', { p: { contact_ref: ref } }))
    }
    const messages = await rpcDirect(service, 'broadcast_recent_messages', {
      p: { contact_ref: ref, limit: Number(url.searchParams.get('limit') || 20),
           include_test: url.searchParams.get('include_test') === '1' },
    })
    // ★ ฐานคืนมาเป็น path เพราะมันไม่รู้ origin และไม่ควรรู้กุญแจเซ็นชื่อ
    //   เติมลิงก์ที่ใช้ได้จริงที่ชั้นนี้ — CRM เอาไปโชว์ thumbnail ได้โดยไม่ต้องมี session ของเรา
    //   (ปิดข้อค้างข้อ 5 ของ handoff: เดิมคืนแต่ path ซึ่ง CRM เปิดไม่ได้)
    return json(res, 200, {
      messages: (Array.isArray(messages) ? messages : []).map(m => ({
        ...m,
        media: (Array.isArray(m?.media) ? m.media : []).map(entry => ({
          ...entry, url: signedMediaUrl(entry?.path),
        })),
      })),
    })
  }

  throw fail(404, 'not_found')
}

/**
 * รับงาน broadcast จาก CRM
 *
 * ★ log บันทึกแค่ id กับจำนวน — ห้ามมีเนื้อความหรือ userId เต็มลง log เด็ดขาด
 *   (log ไปอยู่ใน docker logs ซึ่งคนอ่านได้มากกว่าคนที่ควรเห็นข้อมูลลูกค้า)
 */
async function createBroadcast(body) {
  const config = lineChannel(String(body?.channel_key ?? ''))
  if (!config) throw fail(400, 'channel_not_found')

  const messages = validateMessages(body?.messages)
  if (!messages.ok) throw fail(400, messages.error)

  const test = body?.test === true
  const people = normalizeRecipients(body?.recipients, { test, allowlist: broadcastTestAllowlist })
  if (!people.ok) throw fail(400, people.error)

  const result = await rpcDirect(service, 'broadcast_enqueue', {
    p: {
      idempotency_key: String(body?.idempotency_key ?? ''),
      inbox_id: config.inbox_id, channel_key: config.key,
      messages: body.messages, requested_by: body?.requested_by ?? null,
      crm_campaign_id: body?.crm_campaign_id ?? null, is_test: test,
      batch_size: MULTICAST_MAX, recipients: people.recipients,
    },
  })
  log.info('broadcast_accepted', {
    job_id: result?.job_id ?? null, channel: config.key, reused: result?.reused ?? false,
    accepted: result?.accepted ?? 0, skipped: result?.skipped?.length ?? 0, test, live: broadcastLive,
  })
  return { job_id: result?.job_id ?? null, accepted: result?.accepted ?? 0,
           skipped: result?.skipped ?? [], reused: result?.reused ?? false, dry_run: !broadcastLive }
}

let broadcastRunning = false
let broadcastLastSuccess = null

/**
 * ตัวเดินงานส่ง — รอบละหนึ่งก้าว เหมือน worker/inboundWorker
 *
 * ก้าวที่หนึ่ง: งานที่ยังไม่เริ่ม → เช็คโควตาก่อน ไม่พอ = ล้มทั้งงาน ไม่ส่งบางส่วน
 * ก้าวที่สอง: claim batch หนึ่งชุด (FOR UPDATE SKIP LOCKED + lease ในฐาน) แล้วยิง
 *
 * ★ crash ระหว่างทางปลอดภัย: batch ที่ส่งไปแล้วถูก mark 'sent' ในฐาน รอบใหม่จึงไม่หยิบซ้ำ
 *   batch ที่ค้างอยู่ 'sending' จะถูกหยิบอีกครั้งเมื่อ lease หมด แต่ใช้ retry_key ตัวเดิม
 *   LINE จึงตอบ 409 แทนที่จะส่งซ้ำ (classifyMulticast นับ 409 เป็นสำเร็จ)
 */
async function broadcastWorker() {
  if (broadcastRunning || !activeChannels.length) return
  broadcastRunning = true
  try {
    const pending = await rpcDirect(service, 'broadcast_next_job', { p: {} })
    if (pending) await startBroadcastJob(pending)

    const batch = await rpcDirect(service, 'broadcast_claim_batch', { p: {} })
    if (batch) await sendBroadcastBatch(batch)
    broadcastLastSuccess = new Date().toISOString()
  } catch (e) {
    log.error('broadcast_worker_failed', { reason: e.message, status: e.status ?? null })
  } finally {
    broadcastRunning = false
  }
}

async function startBroadcastJob(job) {
  const config = lineChannel(job.channel_key)
  if (!config) {
    await rpcDirect(service, 'broadcast_job_fail', { p: { job_id: job.job_id, reason: 'channel_not_found' } })
    return log.warn('broadcast_job_failed', { job_id: job.job_id, reason: 'channel_not_found' })
  }
  // dry run ห้ามแตะ network แม้แต่การถามโควตา — ไม่งั้นเทสต์ "ไม่ยิงเน็ต" ไม่จริง
  if (broadcastLive) {
    const quota = await lineQuota({ accessToken: config.access_token })
    const check = quotaAllows(quota, job.recipient_count)
    if (!check.ok) {
      await rpcDirect(service, 'broadcast_job_fail', { p: { job_id: job.job_id, reason: 'quota_exceeded' } })
      return log.warn('broadcast_job_failed', {
        job_id: job.job_id, reason: 'quota_exceeded',
        need: job.recipient_count, remaining: check.remaining })
    }
  }
  await rpcDirect(service, 'broadcast_job_start', { p: { job_id: job.job_id } })
  log.info('broadcast_job_started', {
    job_id: job.job_id, channel: job.channel_key,
    recipients: job.recipient_count, live: broadcastLive, test: job.is_test })
}

async function sendBroadcastBatch(batch) {
  const to = Array.isArray(batch.recipients) ? batch.recipients : []
  const common = { job_id: batch.job_id, batch_no: batch.batch_no }
  if (to.length === 0) {
    return void await rpcDirect(service, 'broadcast_batch_finish', { p: { ...common, outcome: 'sent' } })
  }

  let verdict
  if (!broadcastLive) {
    // ตัวส่งปลอม: ไม่มี fetch ไม่มี token ถือว่าสำเร็จ แล้วบอกให้ชัดใน log ว่ายังไม่ได้ส่งจริง
    log.info('broadcast_dry_run', { ...common, recipients: to.length, retry_key: batch.retry_key })
    verdict = { outcome: 'sent', http_status: null, line_request_id: null }
  } else {
    const config = lineChannel(batch.channel_key)
    if (!config) {
      verdict = { outcome: 'failed', error: 'channel_not_found' }
    } else {
      const raw = await sendMulticast({
        to, messages: batch.messages, retryKey: batch.retry_key, accessToken: config.access_token,
      })
      verdict = classifyMulticast({ ...raw, attempts: batch.attempts })
      if (verdict.outcome !== 'sent') {
        // detail เป็น body ที่ LINE ตอบ (รหัส+คำอธิบาย) ไม่มี userId ของลูกค้าอยู่ในนั้น
        verdict.error = [verdict.error, raw.detail].filter(Boolean).join(' · ').slice(0, 500)
      }
    }
  }

  const done = await rpcDirect(service, 'broadcast_batch_finish', { p: { ...common, ...verdict } })
  log.info('broadcast_batch_done', {
    ...common, outcome: verdict.outcome, recipients: to.length,
    http_status: verdict.http_status ?? null, job_status: done?.status ?? null, live: broadcastLive })
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

// เลขรุ่น schema จากทะเบียน inbox.sql_applied (sql/039) — ดึงแบบข้างหลังและแคชไว้
// เพราะ /health ต้องเร็วและห้ามล้มเพราะฐาน: ตัวเลขช้าไปหนึ่งรอบ (30 วิ) ไม่เป็นไร
let schemaVersion = null
let schemaVersionAt = 0
function refreshSchemaVersion() {
  if (Date.now() - schemaVersionAt < 300000) return
  schemaVersionAt = Date.now()
  rpcDirect(service, 'schema_version_latest').then(v => {
    if (v !== null && v !== undefined) schemaVersion = Number(v)
  }).catch(() => { /* ยังไม่ลง 039 = ยังไม่มีเลขให้รายงาน */ })
}

function health() {
  const mem = process.memoryUsage()
  const rssMb = Math.round(mem.rss / 1048576)
  // เตือนได้ แต่ห้ามถี่ — /health ถูกเรียกทุก 30 วินาทีจาก healthcheck ของ docker
  if (rssMb >= RSS_WARN_MB && Date.now() - rssWarnedAt > 600000) {
    rssWarnedAt = Date.now()
    log.warn('memory_high', { rssMb, heapUsedMb: Math.round(mem.heapUsed / 1048576), limitMb: 160 })
  }
  const idle = since => Date.now() - (since ? Date.parse(since) : startedAt)
  refreshSchemaVersion()
  const idleFor = idle(workerLastSuccess), inboundIdleFor = idle(inboundLastSuccess)
  const outboundOk = shadow || !activeChannels.length || idleFor <= WORKER_STALE_MS
  const inboundOk = !activeChannels.length || inboundIdleFor <= WORKER_STALE_MS
  return { ok: outboundOk && inboundOk, service: 'asher-connect', shadow, shadowDefault, authentication: 'individual',
           workerLastSuccess, idleFor, inboundLastSuccess, inboundIdleFor,
           schemaVersion,
           activeChannels: activeChannels.length, edgeFunctions, projects,
           // หน่วยเป็น MB เพราะไบต์ดิบไม่มีใครอ่านออกตอนตีสาม
           // rss คือของที่ docker วัดจริง ส่วน heapUsed คือของที่ V8 ถืออยู่
           memory: { rssMb, heapUsedMb: Math.round(mem.heapUsed / 1048576), limitMb: 160 },
           // สวิตช์ของบอทต้องมองเห็นจากข้างนอกเสมอ
           // ไม่งั้น "บอทไม่ตอบ" กับ "บอทถูกปิดไว้" จะแยกกันไม่ออกตอนมีคนถามว่าทำไมเงียบ
           bot: jobQueue,
           // เหตุผลเดียวกับ bot: "ยังไม่ได้ส่งจริง" ต้องอ่านได้จากข้างนอก ไม่ใช่เดาจาก log
           // ★ ไม่ถ่วง ok ของ health — ตัวส่งหลายคนเงียบเป็นเรื่องปกติ (ส่วนใหญ่ไม่มีงาน)
           broadcast: { live: broadcastLive, serviceTokenSet: serviceToken !== '',
                        testAllowlist: broadcastTestAllowlist.length, lastSuccess: broadcastLastSuccess },
           // ท่อ Connect -> CRM: ต้องเห็นยอดคิวค้างจากข้างนอกเสมอ ไม่ใช่เดาจาก log
           // ★ ไม่ถ่วง ok ของ health — CRM ล่มต้องไม่ทำให้ container ของ Connect ขึ้น unhealthy
           crmPublisher: {
             enabled: crmPublisherEnabled,
             configured: crmPublisherConfigured,
             status: !crmPublisherEnabled ? 'disabled' : crmPublisherConfigured ? 'healthy' : 'misconfigured',
             batchPerTick: CRM_PUBLISH_BATCH,
             profileRetryEnabled: crmProfileRetryEnabled,
             pending: Number(crmPublisherStats.pending || 0),
             processing: Number(crmPublisherStats.processing || 0),
             delivered: Number(crmPublisherStats.delivered || 0),
             deadLetter: Number(crmPublisherStats.dead_letter || 0),
             lastSuccessAt: crmPublisherLastSuccess || crmPublisherStats.last_success_at || null,
             lastErrorAt: crmPublisherLastError || crmPublisherStats.last_error_at || null,
             oldestPendingAt: crmPublisherStats.oldest_pending_at || null,
           } }
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

  // ★ ติดดาว · การติดตาม · Tag — ทางเดียวกับหน้าสถิติ ยิงด้วย token ของคนที่ล็อกอิน
  //   ด่านสิทธิ์ (can_read, role, test_only) อยู่ที่ inbox.* ใน sql/202610011000_contact_star_tags.sql
  //   ไม่ผ่าน connect_private.api — ตัวบน VPS ใหม่กว่า repo ห้ามเขียนทับ
  const flag = flagRpc(input.action, input.data)
  if (flag) return json(res, 200, await rpcDirect(accessToken, flag.fn, flag.body))

  // Quick Reply management uses dedicated security-definer RPCs. The browser
  // only sends the user's session token; role checks remain in Supabase.
  if (input.action === 'quick_replies_list') {
    // หน้า admin ขอเห็นรายการที่ปิดใช้งานด้วย — สิทธิ์ admin ตรวจที่นี่และที่ qr_list_all อีกชั้น
    if (input.data.include_inactive) {
      const who = await rpc(accessToken, 'bootstrap')
      if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
      return json(res, 200, await rpcDirect(accessToken, 'qr_list_all', { p_query: input.data.query || null, p_category: input.data.category || null }))
    }
    return json(res, 200, await rpcDirect(accessToken, 'qr_list', { p_project: null, p_query: input.data.query || null, p_category: input.data.category || null }))
  }
  if (input.action === 'quick_reply_upsert') {
    const who = await rpc(accessToken, 'bootstrap')
    if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
    const data = { ...input.data }
    // ไฟล์แนบจากหน้า admin เป็น URL/พาธ → เก็บที่ quick_reply.image_url (sql/038)
    // ของที่ไม่ใช่รูปยังไม่มีที่พักจริง (media_asset จำกัด image/) จึงปฏิเสธให้อ่านออก
    if (Array.isArray(data.attachments)) {
      const urls = data.attachments.map(a => safeAssetUrl(a.public_url ?? a.url ?? '')).filter(Boolean)
      if (data.attachments.length && !urls.length) throw fail(400, 'attachment_image_only')
      data.image_url = urls[0] ?? ''
      delete data.attachments
    }
    if (data.category != null && String(data.category).trim() !== '' && !CATEGORIES.has(String(data.category).trim())) throw fail(400, 'category_not_allowed')
    if (typeof data.title === 'string' && data.title.trim().length > 160) throw fail(400, 'invalid_input')
    if (typeof data.body === 'string' && data.body.length > 10000) throw fail(400, 'invalid_input')
    return json(res, 200, await rpcDirect(accessToken, 'qr_upsert', { p_data: data }))
  }
  if (input.action === 'quick_reply_toggle') {
    const who = await rpc(accessToken, 'bootstrap')
    if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
    return json(res, 200, await rpcDirect(accessToken, 'qr_toggle', { p_id: input.data.id, p_active: input.data.active, p_bot_enabled: null }))
  }
  // Sale เลือก Quick Reply ใส่ composer — บันทึก usage แบบยิงทิ้ง ต้องไม่เคยพา composer ล้ม
  // (ฝั่งหน้าจอ .catch(() => {}) อยู่แล้ว ที่นี่ก็แค่เดินหน้าให้ RPC ตัดสินสิทธิ์เอง)
  if (input.action === 'quick_reply_use') {
    return json(res, 200, await rpcDirect(accessToken, 'qr_use', { p_id: input.data.id, p_conversation_id: input.data.conversation_id || null }))
  }
  // บันทึกผล import หลัง admin ตัดสินใจต่อแถว — validate ซ้ำที่นี่ ไม่เชื่อหน้าจอ
  if (input.action === 'quick_reply_import') {
    const who = await rpc(accessToken, 'bootstrap')
    if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
    const rows = Array.isArray(input.data.rows) ? input.data.rows : []
    if (!rows.length || rows.length > MAX_IMPORT_ROWS) throw fail(400, 'invalid_input')
    const prepared = rows.map((row, index) => {
      const base = validateRow(row, Number.isInteger(row.row_number) ? row.row_number - 2 : index)
      const decision = ['skip', 'create', 'update'].includes(row.decision) ? row.decision : 'skip'
      const target = decision === 'update' && typeof row.target_id === 'string' ? row.target_id : null
      return { ...base, decision, ...(target ? { target_id: target } : {}) }
    })
    if (prepared.some(r => r.decision !== 'skip' && r.errors.length)) throw fail(400, 'invalid_input')
    return json(res, 200, { summary: await rpcDirect(accessToken, 'qr_import_apply', { p_rows: prepared }) })
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

  if (input.action === 'send_image') {
    await refreshSendMode()
    if (shadow) throw fail(503, 'shadow_mode')
    const detail = await rpc(accessToken, 'messages', { id: input.data.id })
    const list = await rpc(accessToken, 'bootstrap')
    if (!list.user) throw fail(403, 'not_allowed')
    if (!activeChannels.some(c => c.channel === detail.channel)) throw fail(503, 'channel_not_configured')
    const raw = safeAssetUrl(input.data.url)
    const url = raw?.startsWith('/media/')
      ? createOutboundMediaUrl(origin, raw.slice('/media/'.length), outboundMediaSigningKey)
      : raw
    if (!url) throw fail(400, 'invalid_message')
    return json(res, 200, await rpcDirect(accessToken, 'send_image', { p_conversation_id: input.data.id, p_url: url }))
  }

  if (input.action === 'quotation_png') {
    const [detail, who] = await Promise.all([
      rpc(accessToken, 'messages', { id: input.data.id }),
      rpc(accessToken, 'bootstrap'),
    ])
    if (!who.user?.id) throw fail(403, 'not_allowed')
    await assertConversationSendable(accessToken, detail, who)
    const requestId = typeof input.data.request_id === 'string' ? input.data.request_id : randomUUID()
    const response = await crmQuotation('/api/integrations/connect/quotations', {
      method: 'POST',
      requestId,
      body: {
        workspace_id: crmWorkspaceId,
        actor_subject_id: who.user.id,
        conversation_id: input.data.id,
        unit_id: input.data.unit_id,
        recipient_name: detail.contact?.display_name || 'ลูกค้า',
      },
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      log.warn('crm_quotation_failed', { status: response.status, code: result.error?.code ?? null })
      if (response.status === 404 || result.error?.code === 'unit_not_available') throw fail(409, 'unit_unavailable')
      if (response.status === 403) throw fail(403, 'not_allowed')
      throw fail(503, 'service_unavailable')
    }
    const quotation = result.data
    if (!quotation?.id) throw fail(503, 'service_unavailable')
    const publicUrl = createQuotationImageUrl(origin, quotation.id, outboundMediaSigningKey)
    if (!publicUrl) throw fail(503, 'service_unavailable')
    // เก็บรูปไว้ก่อนส่งลิงก์ ตอน LINE/Messenger มาดึงรูปจะได้ไม่ต้องไปถึง CRM
    // ถ้าเก็บไม่ทัน ยังส่งได้ — ตอนเปิดรูปครั้งแรกจะดึงจาก CRM แล้วเก็บเอง
    await quotationImages.get(quotation.id).catch(e => log.warn('quotation_image_warm_failed', { reason: e.message }))
    await rpc(accessToken, 'send', { id: input.data.id, text: publicUrl, request_id: quotation.id })
    return json(res, 200, { ...quotation, download_url: publicUrl, sent: true })
  }

  // ใบเสนอราคาสำเร็จรูปต่อห้อง: รูปทำรอไว้แล้ว — ส่งเป็นรูปเข้าแชททันที ไม่ต้องรอ CRM
  if (input.action === 'quotation_unit_png') {
    const [detail, who] = await Promise.all([
      rpc(accessToken, 'messages', { id: input.data.id }),
      rpc(accessToken, 'bootstrap'),
    ])
    if (!who.user?.id) throw fail(403, 'not_allowed')
    await assertConversationSendable(accessToken, detail, who)
    let path
    try { path = await unitQuotations.pathFor(String(input.data.unit_id ?? '')) } catch (e) {
      if (e.status) throw e
      log.warn('unit_quotation_send_failed', { reason: e.message })
      throw fail(503, 'service_unavailable')
    }
    const url = createOutboundMediaUrl(origin, path, outboundMediaSigningKey)
    if (!url) throw fail(503, 'service_unavailable')
    return json(res, 200, await rpcDirect(accessToken, 'send_image', { p_conversation_id: input.data.id, p_url: url }))
  }

  if (input.action === 'quotation_units') {
    // เซลส์กำลังจะเลือกห้อง — เติมรูปห้องที่ยังไม่มีไว้เบื้องหลัง
    warmUnitQuotations()
    const [detail, who] = await Promise.all([
      rpc(accessToken, 'messages', { id: input.data.id }),
      rpc(accessToken, 'bootstrap'),
    ])
    if (!detail?.conversation?.id || !who.user?.id) throw fail(403, 'not_allowed')
    const response = await crmQuotation('/api/integrations/connect/quotation-units', { actorId: who.user.id })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      log.warn('crm_quotation_units_failed', { status: response.status, code: result.error?.code ?? null })
      if (response.status === 403) throw fail(403, 'not_allowed')
      throw fail(503, 'service_unavailable')
    }
    return json(res, 200, Array.isArray(result.data) ? result.data : [])
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

// ──────────────────────────────── Quick Replies: ทางอัปโหลดของหน้า /quick-replies
// สองทางนี้ส่งไฟล์ ไม่ใช่ JSON จึงตรวจ origin เอง (origin คือด่านกัน CSRF ตัวจริงของบ้านนี้)
// สิทธิ์ admin ตรวจสองชั้นเสมอ: ที่นี่ (bootstrap) และที่ฐาน (qr_list_all เป็น security definer)

// ลิงก์รูปที่เก็บลง quick_reply.image_url: https ภายนอก หรือพาธ /media/ ที่ตัวเองเสิร์ฟ
// (CHECK ในฐาน sql/038 กันไว้อีกชั้น — ตรงนี้กันก่อนให้ error อ่านออก)
const safeAssetUrl = value => {
  const text = String(value ?? '').trim()
  if (/^\/media\/[A-Za-z0-9._/-]+$/.test(text)) return text
  return httpsOnly(text)
}
const httpsOnly = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !/[\r\n]/.test(value) ? url.href : null } catch { return null } }

const QR_IMPORT_LIMIT = MAX_IMPORT_BYTES + 65536 // เผื่อตัวครอบ multipart
const QR_ATTACHMENT_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' }
const OUTBOUND_IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

// แยกไฟล์จาก multipart/form-data — หน้า admin ส่ง field เดียวชื่อ file
function multipartFile(req, body) {
  const boundary = /boundary=("?)([^";]+)\1/i.exec(req.headers['content-type'] ?? '')?.[2]
  if (!boundary) throw fail(400, 'invalid_multipart')
  const parts = body.split(Buffer.from(`--${boundary}`))
  for (const part of parts.slice(1, -1)) {
    const split = part.indexOf('\r\n\r\n')
    if (split < 0) continue
    const head = part.subarray(0, split).toString('utf8')
    if (!/content-disposition:[^\r]*filename\*?=/i.test(head)) continue
    let data = part.subarray(split + 4)
    if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2)
    const raw = /filename\*=(?:[^']*''){1,3}([^;\r]+)|filename="?([^";\r]+)"?/i.exec(head)
    const name = raw?.[1] ?? raw?.[2] ?? ''
    let filename = name
    try { filename = decodeURIComponent(name) } catch { /* ชื่อไฟล์ถมว์อยู่แล้ว ใช้ตามเดิม */ }
    return { data, filename: filename.replace(/[\r\n\0]/g, '').trim() || 'upload.csv' }
  }
  throw fail(400, 'file_missing')
}

async function requireAdmin(accessToken) {
  const who = await rpc(accessToken, 'bootstrap')
  if (who.user?.role !== 'admin') throw fail(403, 'not_allowed')
}

// Upload → Parse → Validate → ตรวจซ้ำกับของจริงในฐาน (active + inactive)
// การตัดสินใจ skip/update เป็นของ admin บนหน้าจอ ที่นี่เตรียมข้อมูลให้ตัดสินเท่านั้น
async function quickReplyImportPreview(req, res) {
  if (req.headers.origin !== origin) throw fail(403, 'invalid_origin')
  const accessToken = await sessions.access(req)
  const body = await readBody(req, QR_IMPORT_LIMIT)
  await requireAdmin(accessToken)
  const { data, filename } = multipartFile(req, body)
  let rows
  try { rows = parseImport(data, filename) } catch (e) { return json(res, e.status || 400, { error: 'invalid_file', message: e.message }) }
  const existing = await rpcDirect(accessToken, 'qr_list_all')
  return json(res, 200, { rows: previewRows(rows, Array.isArray(existing) ? existing : []) })
}

// อัปโหลดรูป/เอกสารแนบ — เก็บ bucket เดียวกับท่อสื่อแนบ (private)
// คืนพาธ /media/… เสมอ เพราะเบราว์เซอร์เข้าถึงได้ทางเดียวคือผ่าน handleMedia ที่คุมสิทธิ์ด้วยเซสชัน
async function quickReplyAttachment(req, res) {
  if (req.headers.origin !== origin) throw fail(403, 'invalid_origin')
  const accessToken = await sessions.access(req)
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const ext = QR_ATTACHMENT_TYPES[type]
  if (!ext) throw fail(415, 'unsupported_media_type')
  const bytes = await readBody(req, 10 * 1024 * 1024 + 1024)
  if (!bytes.length) throw fail(400, 'empty_file')
  await requireAdmin(accessToken)
  const filename = (() => { try { return decodeURIComponent(req.headers['x-filename'] ?? '') } catch { return String(req.headers['x-filename'] ?? '') } })().replace(/[\r\n\0]/g, '').slice(0, 120) || 'attachment'
  const path = `qr/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`
  const response = await fetch(`${upstream}/storage/v1/object/inbox-media/${path}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${service}`, 'Content-Type': type, 'x-upsert': 'true' },
    body: bytes,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
  if (!response.ok) throw fail(502, `storage_${response.status}`)
  return json(res, 200, { public_url: `/media/${path}`, file_name: filename, mime_type: type })
}

async function assertConversationSendable(accessToken, detail, who) {
  await refreshSendMode()
  if (shadow) throw fail(503, 'shadow_mode')
  const account = who ?? await rpc(accessToken, 'bootstrap')
  if (!account.user) throw fail(403, 'not_allowed')
  if (!activeChannels.some(c => c.channel === detail.channel)) throw fail(503, 'channel_not_configured')
}

async function crmQuotation(path, { method = 'GET', body, actorId, requestId } = {}) {
  if (!crmUrl || !crmToken || !crmWorkspaceId) throw fail(503, 'service_unavailable')
  return fetch(`${crmUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${crmToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(requestId ? { 'Idempotency-Key': requestId } : {}),
      'X-Asher-Workspace-Id': crmWorkspaceId,
      ...(actorId ? { 'X-Asher-Actor-Id': actorId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
}

const quotationImages = createQuotationImageStore({
  async readObject(path) {
    const response = await fetch(`${upstream}/storage/v1/object/authenticated/inbox-media/${path}`, {
      headers: { apikey: anon, Authorization: `Bearer ${service}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    })
    // storage ของ Supabase ตอบ 400 {"statusCode":"404"} เมื่อไม่มีไฟล์ในบางรุ่น
    if (response.status === 404 || response.status === 400) return null
    if (!response.ok) throw new Error(`storage_${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  },
  writeObject: (path, bytes) => uploadMediaObject(path, { bytes, type: 'image/png' }),
  async fetchFromCrm(id) {
    const response = await crmQuotation(`/api/integrations/connect/quotations/${id}/public-image`)
    if (!response.ok) {
      log.warn('crm_public_quotation_image_failed', { status: response.status })
      throw fail(response.status === 404 ? 404 : 503, response.status === 404 ? 'not_found' : 'service_unavailable')
    }
    return Buffer.from(await response.arrayBuffer())
  },
  log,
})

const unitQuotations = createUnitQuotationImages({
  async listFromCrm() {
    const response = await crmQuotation('/api/integrations/connect/unit-quotation-images')
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`crm_${response.status}`)
    return Array.isArray(result.data) ? result.data : []
  },
  async fetchFromCrm(unitId) {
    const response = await crmQuotation(`/api/integrations/connect/units/${unitId}/quotation-image`)
    if (response.status === 404 || response.status === 409) throw fail(409, 'unit_unavailable')
    if (!response.ok) throw new Error(`crm_${response.status}`)
    return { bytes: Buffer.from(await response.arrayBuffer()), version: response.headers.get('x-quotation-version') || '' }
  },
  async listStored() {
    const paths = []
    for (let offset = 0; ; offset += 1000) {
      const response = await fetch(`${upstream}/storage/v1/object/list/inbox-media`, {
        method: 'POST',
        headers: { apikey: anon, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: 'outbound', search: UNIT_QUOTE_PREFIX, limit: 1000, offset }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      })
      if (!response.ok) throw new Error(`storage_${response.status}`)
      const page = await response.json()
      for (const item of page) if (item?.name) paths.push(`outbound/${item.name}`)
      if (page.length < 1000) return paths
    }
  },
  writeObject: (path, bytes) => uploadMediaObject(path, { bytes, type: 'image/png' }),
  log,
})
const warmUnitQuotations = () => { if (crmUrl && crmToken && crmWorkspaceId) unitQuotations.warmAll().catch(e => log.warn('unit_quotation_prerender_failed', { reason: e.message })) }

async function outboundImageUpload(req, res) {
  if (req.headers.origin !== origin) throw fail(403, 'invalid_origin')
  const accessToken = await sessions.access(req)
  const who = await rpc(accessToken, 'bootstrap')
  if (!['sales','senior_sales','manager','admin'].includes(who.user?.role)) throw fail(403, 'not_allowed')
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const ext = OUTBOUND_IMAGE_TYPES[type]
  if (!ext) throw fail(415, 'unsupported_media_type')
  const bytes = await readBody(req, 10 * 1024 * 1024 + 1024)
  if (!bytes.length) throw fail(400, 'empty_file')
  const path = `outbound/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`
  const response = await fetch(`${upstream}/storage/v1/object/inbox-media/${path}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${service}`, 'Content-Type': type, 'x-upsert': 'false' },
    body: bytes,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
  if (!response.ok) throw fail(502, `storage_${response.status}`)
  return json(res, 200, { public_url: `/media/${path}`, mime_type: type })
}

async function outboundMedia(req, res, url) {
  if (req.method !== 'GET') throw fail(405, 'method_not_allowed')
  const path = safeOutboundPath(url.pathname.slice('/outbound-media/'.length))
  if (!path || !verifyOutboundMedia(path, url.searchParams.get('expires'), url.searchParams.get('signature'), outboundMediaSigningKey)) throw fail(403, 'not_allowed')
  const response = await fetch(`${upstream}/storage/v1/object/authenticated/inbox-media/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${service}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
  if (!response.ok) throw fail(response.status === 404 ? 404 : 502, 'media_unavailable')
  const type = response.headers.get('content-type') || 'application/octet-stream'
  if (!type.startsWith('image/')) throw fail(415, 'unsupported_media_type')
  const bytes = Buffer.from(await response.arrayBuffer())
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
  return res.end(bytes)
}

async function staffLibraryMedia(req, res, url) {
  if (req.method !== 'GET') throw fail(405, 'method_not_allowed')
  const accessToken = await sessions.access(req)
  const who = await rpc(accessToken, 'bootstrap')
  if (!['sales','senior_sales','manager','admin'].includes(who.user?.role)) throw fail(403, 'not_allowed')
  const path = safeOutboundPath(url.pathname.slice('/media/'.length))
  if (!path) throw fail(404, 'not_found')
  const response = await fetch(`${upstream}/storage/v1/object/authenticated/inbox-media/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${service}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
  if (!response.ok) throw fail(response.status === 404 ? 404 : 502, 'media_unavailable')
  const type = response.headers.get('content-type') || 'application/octet-stream'
  const bytes = Buffer.from(await response.arrayBuffer())
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' })
  return res.end(bytes)
}

async function quickReplyMedia(req, res, url) {
  if (req.method !== 'GET') throw fail(405, 'method_not_allowed')
  const path = safeOutboundPath(url.pathname.slice('/quick-reply-media/'.length))
  if (!path) throw fail(404, 'not_found')
  const asset = await rpcDirect(service, 'quick_reply_media_lookup', { p_path: path })
  if (!asset) throw fail(404, 'not_found')
  const response = await fetch(`${upstream}/storage/v1/object/authenticated/inbox-media/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${service}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  })
  if (!response.ok) throw fail(response.status === 404 ? 404 : 502, 'media_unavailable')
  const type = asset.mime || response.headers.get('content-type') || 'application/octet-stream'
  if (!type.startsWith('image/')) throw fail(415, 'unsupported_media_type')
  const bytes = Buffer.from(await response.arrayBuffer())
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
  return res.end(bytes)
}

// ไฟล์หน้าเว็บรับเฉพาะชื่อที่ตรงแบบเป๊ะ ไม่ประกอบ path จากสิ่งที่ผู้ใช้ส่งมา
// ตัวชี้ขาดคือตารางกับ regex นี้ ไม่ใช่การกรอง ".." ทีหลัง ซึ่งพลาดได้หลายทาง
const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/image-library.js': 'image-library.js', '/login.css': 'login.css', '/fonts/plex.css': 'fonts/plex.css',
  '/privacy': 'privacy.html', '/meta-reviewer-avatar.png': 'meta-reviewer-avatar.png',
  '/sla.mjs': 'sla.mjs', '/case-flags.mjs': 'case-flags.mjs', '/app-nav.js': 'app-nav.js', '/quick-replies.js': 'quick-replies.js', '/media-library.js': 'media-library.js', '/quick-replies': 'quick-replies-admin.html', '/quick-replies-admin.js': 'quick-replies-admin.js',
  '/quick-replies.css': 'quick-replies.css', '/quick-replies-admin.css': 'quick-replies-admin.css',
  '/stats': 'stats.html', '/stats.js': 'stats.js', '/stats.css': 'stats.css', '/contacts': 'index.html',
  '/logs': 'logs.html', '/logs.js': 'logs.js', '/logs.css': 'logs.css' }

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
  if (url.pathname === '/health' && req.method === 'GET') {
    const state = health()
    return json(res, state.ok ? 200 : 503, state)
  }
  if (url.pathname.startsWith('/webhooks/')) return handleWebhook(req, res, url)

  if (req.method === 'GET' && /^\/quotation-pdf\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    const accessToken = await sessions.access(req)
    const who = await rpc(accessToken, 'bootstrap')
    if (!who.user?.id) throw fail(403, 'not_allowed')
    const quotationId = url.pathname.split('/')[2]
    const response = await crmQuotation(`/api/integrations/connect/quotations/${quotationId}/pdf`, { actorId: who.user.id })
    if (!response.ok) {
      log.warn('crm_quotation_download_failed', { status: response.status })
      if (response.status === 404) throw fail(404, 'not_found')
      if (response.status === 403) throw fail(403, 'not_allowed')
      throw fail(503, 'service_unavailable')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': bytes.length,
      'Content-Disposition': response.headers.get('content-disposition') || `inline; filename="quotation-${quotationId}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    return res.end(bytes)
  }

  if (req.method === 'GET' && /^\/quotation-document\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    const quotationId = url.pathname.split('/')[2]
    if (!verifyQuotationUrl(quotationId, url.searchParams.get('expires'), url.searchParams.get('signature'), outboundMediaSigningKey)) throw fail(403, 'not_allowed')
    const response = await crmQuotation(`/api/integrations/connect/quotations/${quotationId}/public-pdf`)
    if (!response.ok) {
      log.warn('crm_public_quotation_download_failed', { status: response.status })
      if (response.status === 404) throw fail(404, 'not_found')
      throw fail(503, 'service_unavailable')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': bytes.length,
      'Content-Disposition': response.headers.get('content-disposition') || `inline; filename="quotation-${quotationId}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    return res.end(bytes)
  }

  if (req.method === 'GET' && /^\/quotation-image\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    const quotationId = url.pathname.split('/')[2]
    if (!verifyQuotationImageUrl(quotationId, url.searchParams.get('expires'), url.searchParams.get('signature'), outboundMediaSigningKey)) throw fail(403, 'not_allowed')
    const bytes = await quotationImages.get(quotationId)
    // เลขใบเดียวกันได้รูปเดิมเสมอ — ให้ LINE/เบราว์เซอร์เก็บแคชได้ตลอดอายุลิงก์
    res.writeHead(200, {
      'Content-Type': 'image/png', 'Content-Length': bytes.length,
      'Cache-Control': 'private, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff',
    })
    return res.end(bytes)
  }

  // ★ อยู่ก่อน /api/ และไม่ผ่าน checkOrigin โดยตั้งใจ — ผู้เรียกคือ CRM ในวงใน
  //   ไม่ใช่เบราว์เซอร์ จึงไม่มี Origin ให้ตรวจ ด่านคือ CONNECT_SERVICE_TOKEN อย่างเดียว
  if (url.pathname.startsWith('/internal/')) return internalRoute(req, res, url)

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') throw fail(405, 'method_not_allowed')
    if (url.pathname === '/api/quick-replies/import/preview') return quickReplyImportPreview(req, res)
    if (url.pathname === '/api/quick-replies/attachment') return quickReplyAttachment(req, res)
    if (url.pathname === '/api/outbound-image') return outboundImageUpload(req, res)
    checkOrigin(req)
    if (url.pathname === '/api/login') return json(res, 200, await sessions.login(req, res, JSON.parse((await readBody(req, 4096)).toString('utf8'))))
    if (url.pathname === '/api/logout') return json(res, 200, await sessions.logout(req, res))
    if (url.pathname !== '/api/command') throw fail(404, 'not_found')
    return handleCommand(req, res)
  }

  if (url.pathname.startsWith('/media/qr/') || url.pathname.startsWith('/media/outbound/')) return staffLibraryMedia(req, res, url)
  if (url.pathname.startsWith('/media/')) return handleMedia(req, res, url)
  if (url.pathname.startsWith('/quick-reply-media/')) return quickReplyMedia(req, res, url)
  if (url.pathname.startsWith('/outbound-media/')) return outboundMedia(req, res, url)

  return handleStatic(req, res, url)
}

// ───────────────────────────────────────────────────────── เริ่มทำงาน

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // img-src เปิด https: ได้เพราะ thumbnail ของ Quick Reply ที่ import จาก Facebook เป็น URL ภายนอก
  // (แท็ก img ตั้ง referrerpolicy=no-referrer ให้แล้ว) — script/connect ยังคุมติด self เหมือนเดิม
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
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
// ตัวส่งหลายคนเดินช้ากว่าคิวแชทได้ — งานเป็นก้อน ไม่มีใครรออยู่หน้าจอ
// และเดินถี่เท่ากันจะกลายเป็นการถาม "มีงานไหม" ทุก 3 วิ ทั้งที่ส่วนใหญ่ไม่มี
const broadcastTimer = setInterval(broadcastWorker, 5000); broadcastTimer.unref()
const crmPublisherTimer = setInterval(crmPublisherWorker, CRM_PUBLISH_INTERVAL); crmPublisherTimer.unref()
if (crmPublisherConfigured) {
  log.info('crm_publisher_started', { batchPerTick: CRM_PUBLISH_BATCH, intervalMs: CRM_PUBLISH_INTERVAL })
  crmPublisherWorker().catch(e => log.warn('crm_publisher_start_failed', { reason: e.message }))
} else if (crmPublisherEnabled) {
  log.warn('crm_publisher_misconfigured', { urlConfigured: Boolean(crmUrl), tokenConfigured: Boolean(crmToken), workspaceConfigured: Boolean(crmWorkspaceId) })
}
if (crmProjectMapInvalid.length) log.warn('crm_project_map_invalid', { entries: crmProjectMapInvalid.length })
else if (crmPublisherConfigured && crmProjectMap.size === 0) {
  log.warn('crm_project_map_empty', { hint: 'ASHER_CRM_PROJECT_MAP ว่าง — conversation.created จะไม่มี project_ref และ CRM จะไม่เปิด Lead' })
}
// ของดิบมีข้อความลูกค้าจริงอยู่ในนั้น เก็บ 30 วันตามที่ตั้งไว้ในฝั่งฐาน
// เดินวันละสี่ครั้งก็พอ ไม่ใช่งานที่ต้องตรงเวลา ขอแค่ไม่มีวันที่ลืมทำ
const sweepTimer = setInterval(() => {
  rpc(service, 'sweep', {}, true)
    .then(r => log.info('webhook_log_swept', { deleted: r?.deleted ?? 0 }))
    .catch(e => log.warn('webhook_log_sweep_failed', { reason: e.message }))
}, 21600000); sweepTimer.unref()

// เซสชันที่หมดอายุไม่มีเจ้าของกลับมาลบให้ ทิ้งไว้คือ refresh token ที่ยังใช้ได้นอนอยู่ในดิสก์
// ทำรูปใบเสนอราคาต่อห้องรอไว้: หลังเปิดเครื่องครู่หนึ่ง แล้วทุก 15 นาที (ห้องใหม่/ราคาเปลี่ยน)
setTimeout(warmUnitQuotations, 20_000).unref()
const unitQuotationTimer = setInterval(warmUnitQuotations, 15 * 60_000); unitQuotationTimer.unref()
const sessionTimer = setInterval(() => {
  sessions.sweep()
    .then(r => { if (r.deleted) log.info('session_swept', { deleted: r.deleted }) })
    .catch(e => log.warn('session_sweep_failed', { reason: e.message }))
}, 600000); sessionTimer.unref()

server.listen(port, '0.0.0.0', () => console.log(`ASHER Connect listening on ${port}; ${activeChannels.length} active channel(s)${shadow ? ' · โหมดเงา: รับเข้าอย่างเดียว ไม่ส่งออก' : ''} · ล็อกอินรายบุคคล`))

process.on('SIGTERM', () => {
  clearInterval(workerTimer)
  clearInterval(inboundTimer)
  clearInterval(broadcastTimer)
  clearInterval(crmPublisherTimer)
  clearInterval(sweepTimer)
  clearInterval(sessionTimer)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 20000).unref()
})
