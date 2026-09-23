/**
 * ชั้นที่คุยกับผู้ให้บริการแชท — ตรวจลายเซ็น · แปล webhook · ส่งของออก
 *
 * ไฟล์นี้ไม่รู้จักฐานข้อมูลและไม่อ่าน process.env เลยแม้แต่ที่เดียว
 * ทุกอย่างที่ต้องใช้ถูกส่งเข้ามาทาง argument — ทั้ง token ทั้งปลายทาง
 * เพราะสองเหตุผล
 *   1. กติกาข้อ 6: secret มาจาก env / channels.json เท่านั้น ผู้เรียกเป็นคนหยิบมา ไม่ใช่ที่นี่
 *   2. เทสต์ยิงฟังก์ชันตรง ๆ ได้โดยไม่ต้องตั้งค่าอะไรทั้งสิ้น
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { chunkText } from './reports/reply-digest.mjs'
import { instagramEvents, sendInstagram } from './lib/instagram.mjs'

export function verifySignature(raw, supplied, secret, channel) {
  if (!supplied || !secret) return false
  const expected = createHmac('sha256', secret).update(raw).digest(channel === 'line' ? 'base64' : 'hex')
  const value = channel === 'line' ? supplied : supplied.replace(/^sha256=/, '')
  const a = Buffer.from(expected), b = Buffer.from(value)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * ของก้อนนี้ส่งมาให้บัญชีของเราจริงไหม
 *
 * แยกออกมาจาก normalize เพราะคำถามคนละข้อกัน: นี่คือ "ส่งผิดบ้านหรือเปล่า"
 * ซึ่งต้องตอบให้ได้ *ก่อน* เก็บลงฐาน ส่วน normalize เป็นการแปลความ ทำทีหลังได้
 * ถ้าไม่แยก ของที่ส่งผิดบ้านจะถูกเก็บไว้ในบันทึกดิบของเราด้วย ซึ่งไม่ใช่ของเรา
 */
export function matchesDestination(channel, body, config) {
  if (channel === 'line') return body?.destination === config.account_id
  if (channel === 'instagram') return body?.object === 'instagram' && Array.isArray(body.entry)
    && body.entry.some(entry => String(entry.id) === String(config.account_id))
  if (body?.object !== 'page') return false
  return (body.entry || []).some(entry => entry.id === config.account_id)
}

// ───────────────────────────────────────────────────────── แปล webhook
//
// มีสองประตูออกจากชั้นนี้ และแยกกันโดยตั้งใจ
//
//   normalizeEvents()   แปลทุก event ที่ก้อนนั้นมี ไม่ทิ้งอะไรเลย
//   normalizeWebhook()  กรองเหลือเฉพาะที่ worker('receive') รับได้ *ในวันนี้*
//
// ทำไมต้องมีสองตัว: ของอย่าง echo (คำตอบของเพจเอง) กับคำสั่งในกลุ่ม LINE
// ไม่ใช่ "ข้อความจากลูกค้า" ถ้าปล่อยเข้า receive ตรง ๆ มันจะถูกบันทึกเป็น
// sender_type='contact' คือคำตอบของทีมกลายเป็นคำถามของลูกค้า ซึ่งพังทั้งสถิติและบทสนทนา
//
// ตัวที่รู้ว่าจะทำอะไรกับ echo/กลุ่ม คือ receive() รุ่นใหม่ใน Phase 3
// จนกว่าจะถึงตอนนั้น เส้นทางที่วิ่งอยู่จริงต้องเห็นเท่าเดิม — จึงกรองไว้ตรงนี้
// ไม่ใช่ไปแก้ที่ผู้เรียก (Phase 2 ห้ามแตะ server.mjs)

/**
 * event ที่ receive() รุ่นปัจจุบันรับได้
 *
 * echo อยู่ในนี้ตั้งแต่ Phase 3 เพราะ receive() รู้วิธีจัดการแล้ว —
 * บันทึกเป็นข้อความของฝั่งเรา ตั้ง last_human_reply_at และยกเลิกงานที่บอทจ่อจะส่ง
 * ★ ขาดตัวนี้ไม่ได้: last_human_reply_at คือค่าที่ decide_reply ใช้ตัดสิน human_owns_convo
 *   ถ้าไม่รับ echo ฝั่งเราจะไม่มีวันรู้ว่าทีมตอบไปแล้ว แล้วผลการตัดสินใจจะไม่มีทางตรงกับ cloud
 *
 * group_command เข้าได้ตั้งแต่ Phase 6 — receive() ส่งต่อให้ connect_private.group_command()
 * แล้วตอบกลับเข้ากลุ่มผ่านคิวขาออก ไม่ได้แตะ contact หรือบทสนทนาของลูกค้าเลย
 *
 * ที่ยังไม่รับคือ join (บอทถูกเชิญเข้ากลุ่ม) — ยังไม่มีอะไรต้องทำนอกจาก log
 */
const RECEIVE_TYPES = new Set(['message', 'echo', 'postback', 'follow', 'unfollow', 'referral', 'group_command', 'message_deleted'])

const iso = ms => new Date(ms ?? Date.now()).toISOString()

/**
 * แปลทุก event ในก้อน — ไม่ทิ้งอะไรเลย
 *
 * ทุกชิ้นที่คืนออกไปมี event_type เสมอ เพราะบอทตัดสินใจจาก *ชนิดของเหตุการณ์*
 * ไม่ใช่จากเนื้อความ — "กดปุ่มดูห้อง 1 นอน" กับ "พิมพ์ว่าดูห้อง 1 นอน" คนละเรื่องกัน
 *
 * ชนิดที่คืนได้
 *   message        ลูกค้าพิมพ์ / ส่งสื่อ           (is_standby=true ถ้าเพจไม่ใช่เจ้าของ thread)
 *   echo           เพจเป็นคนส่ง — คนตอบจาก Business Suite หรือบอทของเราเอง (ฐานเป็นคนแยก)
 *   postback       ลูกค้ากดปุ่ม
 *   referral       ลูกค้ามาจากโฆษณา โดยยังไม่พิมพ์อะไร
 *   follow         เพิ่มเพื่อน (LINE)
 *   unfollow       บล็อกบัญชี (LINE)
 *   group_command  ข้อความในกลุ่ม/ห้อง LINE — ทีมสั่งงานบอทจากตรงนี้
 *   join           บอทถูกเชิญเข้ากลุ่ม (LINE)
 */
export function normalizeEvents(channel, body, config) {
  if (channel === 'instagram') return instagramEvents(body, config)
  return channel === 'line' ? lineEvents(body, config) : messengerEvents(body, config)
}

function lineEvents(body, config) {
  if (body.destination !== config.account_id) throw new Error('wrong_destination')
  const out = []

  for (const e of body.events || []) {
    const src = e.source || {}
    const base = {
      inbox_id: config.inbox_id,
      occurred_at: iso(e.timestamp),
      event_id: e.webhookEventId || e.message?.id || null,
      reply_token: e.replyToken ?? null,
      // LINE ยิงซ้ำเองเมื่อฝั่งเราตอบช้า และติดธงมาให้ว่าเป็นของซ้ำ
      // ด่านกันซ้ำที่ฐานรับไหวอยู่แล้ว แต่ไม่มีเหตุผลให้เสียแรงทำงานซ้ำทั้งชุด
      is_redelivery: e.deliveryContext?.isRedelivery === true,
    }

    // ── กลุ่ม / ห้อง: ไม่ใช่ลูกค้า แต่เป็นทีมสั่งงาน — ห้ามทิ้ง
    if (src.type === 'group' || src.type === 'room') {
      if (!base.event_id) continue
      out.push({
        ...base,
        event_type: e.type === 'join' ? 'join' : 'group_command',
        external_id: src.userId ?? null,          // LINE ไม่ส่ง userId มาเสมอในกลุ่ม
        group_id: src.groupId ?? src.roomId ?? null,
        source_type: src.type,
        content_type: 'text',
        text: e.type === 'message' ? (e.message?.text ?? '') : `[${e.type}]`,
        attribution: {},
      })
      continue
    }

    if (src.type !== 'user' || !base.event_id) continue
    const withUser = { ...base, external_id: src.userId, group_id: null, source_type: 'user' }

    if (e.type === 'message' && e.message) {
      out.push({ ...withUser, event_type: 'message', ...lineMessageContent(e.message) })
    } else if (e.type === 'postback') {
      // data คือสิ่งที่บอทอ่าน ส่วนคนอ่านหน้าจอต้องเห็นว่ามีการกดปุ่มเกิดขึ้น
      out.push({ ...withUser, event_type: 'postback', content_type: 'postback',
        text: `[กดปุ่ม] ${e.postback?.data ?? ''}`.trim(),
        attribution: { postback: e.postback ?? null } })
    } else if (e.type === 'follow' || e.type === 'unfollow') {
      out.push({ ...withUser, event_type: e.type, content_type: e.type,
        text: e.type === 'follow' ? '[ลูกค้าเพิ่มเพื่อน]' : '[ลูกค้าบล็อกบัญชี]',
        attribution: {} })
    }
    // ชนิดอื่นที่ยังไม่รองรับถูกข้ามที่นี่ แต่ไม่ได้หายไปไหน —
    // ของดิบทั้งก้อนอยู่ใน connect_private.webhook_log ย้อนกลับมาทำใหม่ได้เสมอ
  }
  return out
}

function lineMessageContent(m) {
  if (m.type === 'text') return { content_type: 'text', text: m.text ?? '', attribution: { provider_message_id: m.id } }
  if (m.type === 'sticker') return { content_type: 'sticker', text: '[สติกเกอร์]', attribution: { provider_message_id: m.id, sticker: { packageId: m.packageId ?? null, stickerId: m.stickerId ?? null } } }
  if (m.type === 'location') {
    const label = [m.title, m.address].filter(Boolean).join(' ')
    return { content_type: 'location', text: `[โลเคชั่น: ${label}]`.replace(' ]', ']'),
             attribution: { provider_message_id: m.id, location: { lat: m.latitude ?? null, lng: m.longitude ?? null } } }
  }
  return { content_type: m.type ?? 'unknown', text: `[${m.type ?? 'แนบ'}] ${m.fileName || 'ลูกค้าส่งสื่อแนบ'}`.trim(),
           attribution: { provider_message_id: m.id, ...(m.contentProvider ? { content_provider: m.contentProvider } : {}) } }
}

function messengerEvents(body, config) {
  if (body.object !== 'page') throw new Error('wrong_object')
  const out = []

  for (const entry of body.entry || []) {
    if (entry.id !== config.account_id) continue
    // standby = ลูกค้าทักมาแต่เพจไม่ใช่เจ้าของ thread ตอนนั้น (มีแอปอื่นถืออยู่)
    // ข้อความยังเป็นของลูกค้าจริง ต้องเก็บ แต่บอทห้ามตอบ — ธงนี้ไปตัดสินใจกันที่ Phase 3
    const events = [
      ...(entry.messaging || []).map(e => ({ e, standby: false })),
      ...(entry.standby || []).map(e => ({ e, standby: true })),
    ]

    for (const { e, standby } of events) {
      // read / delivery receipt ไม่ใช่เหตุการณ์ของบทสนทนา ไม่มีอะไรให้บันทึก
      if (e.read || e.delivery) continue

      const base = {
        inbox_id: config.inbox_id,
        page_id: entry.id,
        occurred_at: iso(e.timestamp),
        is_standby: standby,
        reply_token: null,
        is_redelivery: false,
      }

      if (e.message?.is_echo) {
        // เพจเป็นคนส่ง — ปลายทางคือ "ลูกค้า" จึงอยู่ที่ recipient ไม่ใช่ sender
        // ★ ที่นี่ส่งต่อ app_id ดิบอย่างเดียว ไม่ตัดสินว่าใครส่ง — ฐานเป็นคนตัดสิน
        //   (connect_private.receive_event ตั้งแต่ sql/036_echo_source_from_queue.sql)
        // ★ app_id เชื่อได้ไม่หมด — สองข้อเท็จจริงจากของจริง 2026-09-14..15:
        //   1. echo ของข้อความที่ "เราส่งเอง" 8 ก้อน มาด้วย app_id สองค่า ไม่ใช่ค่าเดียว
        //   2. Page Inbox ส่ง app_id ของ Business Suite มาด้วย ไม่ใช่ค่าว่าง
        //   ฐานจึงผูก mid กับคิวขาออกก่อน แล้วค่อยดู app_id เป็นตัวรอง
        if (!e.recipient?.id || !e.message.mid) continue
        out.push({ ...base, event_type: 'echo', external_id: e.recipient.id, customer_psid: e.recipient.id,
          event_id: e.message.mid,
          app_id: e.message.app_id != null ? String(e.message.app_id) : null,
          content_type: e.message.text ? 'text' : 'attachment',
          text: e.message.text || `[แนบ: ${e.message.attachments?.[0]?.type ?? 'unknown'}]`,
          attribution: { attachments: e.message.attachments || [] } })
        continue
      }

      if (!e.sender?.id) continue
      const withUser = { ...base, external_id: e.sender.id, customer_psid: e.sender.id }
      const referral = e.referral || e.postback?.referral || e.message?.referral || null
      const adId = referral?.ad_id ?? null
      const adTitle = referral?.ads_context_data?.ad_title ?? null

      if (e.message) {
        out.push({ ...withUser, event_type: 'message', event_id: e.message.mid,
          content_type: e.message.text ? 'text' : 'attachment',
          text: e.message.text || '[ลูกค้าส่งสื่อแนบ]',
          ad_id: adId, ad_title: adTitle,
          attribution: { referral: referral ?? null, attachments: e.message.attachments || [] } })
      } else if (e.postback) {
        // Messenger รุ่นเก่าไม่ส่ง mid มากับ postback จึงประกอบคีย์เองจากของที่คงที่
        // ยิงซ้ำก้อนเดิมจะได้คีย์เดิม ด่านกันซ้ำที่ฐานจึงยังทำงาน
        out.push({ ...withUser, event_type: 'postback',
          event_id: e.postback.mid || `pb:${entry.id}:${e.sender.id}:${e.timestamp}`,
          content_type: 'postback',
          text: `[กดปุ่ม] ${e.postback.title || e.postback.payload || ''}`.trim(),
          ad_id: adId, ad_title: adTitle,
          attribution: { postback: e.postback } })
      } else if (referral) {
        // คลิกโฆษณาแล้วเปิดแชทค้างไว้ ยังไม่พิมพ์อะไร — ยังไม่มีข้อความ แต่มีที่มา
        out.push({ ...withUser, event_type: 'referral',
          event_id: `ref:${entry.id}:${e.sender.id}:${e.timestamp}`,
          content_type: 'referral',
          text: `[คลิก ad: ${adTitle ?? adId ?? '?'}]`,
          ad_id: adId, ad_title: adTitle,
          attribution: { referral } })
      }
    }
  }
  return out
}

/**
 * เฉพาะ event ที่ worker('receive') รุ่นปัจจุบันรับได้
 *
 * ★ ตัวนี้คือของที่ server.mjs เรียกอยู่ตอนนี้ หน้าตาผลลัพธ์จึงห้ามเปลี่ยน
 *   ของที่ถูกกรองออกไม่ได้หายไปไหน — normalizeEvents() คืนให้ครบ และของดิบอยู่ใน webhook_log
 */
export function normalizeWebhook(channel, body, config) {
  return normalizeEvents(channel, body, config)
    .filter(e => RECEIVE_TYPES.has(e.event_type) && !e.is_redelivery)
}

// ───────────────────────────────────────────────────────── ส่งของออก

/**
 * แปลง payload กลางเป็นรูปแบบของผู้ให้บริการ
 *
 * payload เป็น JSON มาตั้งแต่ในคิว ไม่ใช่ข้อความล้วน
 * เพราะวันที่ต้องส่ง quick reply / รูป / flex จะได้ไม่ต้องรื้อ schema, RPC และ deliver พร้อมกัน
 *
 *   {type:'text',  text, quick_replies?:[{label,payload}]}
 *   {type:'image', url, preview_url?}
 *   {type:'raw',   line?:{...}, messenger?:{...}}   ← ทางออกสำหรับของที่ยังไม่มีชนิดรองรับ
 *
 * ของที่ไม่รู้จักตกลงมาเป็นข้อความล้วนเสมอ ดีกว่าส่งไม่ออกแล้วลูกค้าไม่ได้ยินอะไรเลย
 */
export function renderPayload(channel, payload, fallbackText) {
  const p = payload && typeof payload === 'object' && payload.type ? payload : { type: 'text', text: fallbackText }
  const line = channel === 'line' || channel === 'line_group'

  if (p.type === 'raw') {
    const raw = line ? p.line : p.messenger
    if (raw) return raw
    return line ? { type: 'text', text: fallbackText } : { text: fallbackText }
  }

  if (line) {
    const message = p.type === 'image' && p.url
      ? { type: 'image', originalContentUrl: p.url, previewImageUrl: p.preview_url || p.url }
      : { type: 'text', text: p.text ?? fallbackText }
    if (Array.isArray(p.quick_replies) && p.quick_replies.length) {
      message.quickReply = { items: p.quick_replies.slice(0, 13).map(q => ({
        type: 'action', action: { type: 'postback', label: q.label, data: q.payload ?? q.label, displayText: q.label } })) }
    }
    return message
  }

  const message = p.type === 'image' && p.url
    ? { attachment: { type: 'image', payload: { url: p.url, is_reusable: true } } }
    : { text: p.text ?? fallbackText }
  if (Array.isArray(p.quick_replies) && p.quick_replies.length) {
    message.quick_replies = p.quick_replies.slice(0, 13).map(q => ({
      content_type: 'text', title: q.label, payload: q.payload ?? q.label }))
  }
  return message
}

export function renderPayloads(channel, payload, fallbackText) {
  if (!payload?.media?.length) return [renderPayload(channel, payload, fallbackText)]
  const out = []
  if (payload.text?.trim()) out.push(renderPayload(channel, { type: 'text', text: payload.text }, fallbackText))
  for (const media of payload.media) out.push(renderPayload(channel, { type: 'image', url: media.url, preview_url: media.url }))
  return out
}

/** ข้อความล้วนสำหรับช่องทางที่ไม่มีรูปแบบอะไรให้เล่น (Telegram, Email, ข้อความแจ้งทีม) */
export function payloadText(payload, fallbackText = '') {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return fallbackText
  return payload.text ?? payload.message ?? fallbackText
}

// ผลของการยิงหนึ่งครั้ง แปลเป็นสถานะที่คิวเข้าใจ
//
//   retry      ลองใหม่ได้ปลอดภัย
//   uncertain  ไม่รู้ว่าถึงหรือไม่ถึง และยิงซ้ำแล้วลูกค้าอาจได้สองครั้ง → ให้คนดู
//   failed     ปลายทางปฏิเสธชัดเจน ยิงอีกกี่ครั้งก็เหมือนเดิม
//
// Messenger ไม่มี idempotency key จึงเป็นตัวเดียวที่มี uncertain
// ส่วนช่องทางแจ้งทีม (group/telegram/email) ยิงซ้ำแล้วแค่ทีมเห็นสองรอบ — ยอมได้ ดีกว่าไม่เห็นเลย
const outcome = (status, channel) => {
  if (status === 429) return 'retry'
  if (status >= 500) return channel === 'messenger' ? 'uncertain' : 'retry'
  return 'failed'
}

const LINE_PUSH = 'https://api.line.me/v2/bot/message/push'
const LINE_REPLY = 'https://api.line.me/v2/bot/message/reply'
const LINE_LOADING = 'https://api.line.me/v2/bot/chat/loading/start'

/**
 * ตอบด้วย reply token ได้ไหม
 *
 * token ของ LINE ใช้ได้ครั้งเดียวและหมดอายุไวมาก ตอบทันได้จะถูกกว่าและไม่กินโควตา push
 * แต่ถ้าเลยเวลาแล้วยังดันใช้ จะได้ 400 กลับมาแล้วลูกค้าไม่ได้ข้อความเลย
 * จึงยอมเสียโควตา push ดีกว่าเสี่ยงไม่ถึง — เพดานเวลาอยู่ใน bot_config ต่อ inbox
 *
 * ใช้กับห้องแชทเดี่ยวเท่านั้น กลุ่มใช้ push เสมอเพราะคำสั่งมาจากคนละ event กับที่เราตอบ
 */
const canReplyToken = job =>
  job.channel === 'line' && !!job.reply_token &&
  Number.isFinite(Number(job.reply_token_age_sec)) &&
  Number(job.reply_token_age_sec) <= Number(job.reply_token_max_sec ?? 20)

/**
 * ส่งงานหนึ่งชิ้นออกไป
 *
 * รับได้ทั้งงานแบบเก่า (คิว connect_private.delivery: message_id + text + recipient)
 * และงานแบบใหม่ (connect_private.job: kind + payload + target)
 * ของเก่าไม่มี kind → ถือว่าเป็น 'send' ผลลัพธ์จึงเท่าเดิมทุกอย่าง
 *
 * ★ ไม่อ่าน env — token ทุกตัวมาทาง config ผู้เรียกเป็นคนหยิบมาจาก env/channels.json
 */
export async function deliver(job, config = {}, fetcher = fetch) {
  const kind = job.kind ?? 'send'
  const channel = job.channel
  const target = job.target ?? job.recipient ?? null
  const base = { job_id: job.id ?? null, message_id: job.message_id ?? null, lease_id: job.lease_id ?? null }
  const fail = (error, status = 'failed') => ({ ...base, status, error })

  if (!target) return fail('recipient_not_configured')

  try {
    if (kind === 'typing') return await sendTyping(base, channel, target, config, fetcher)

    switch (channel) {
      case 'line':
      case 'line_group':
        return await sendLine(job, base, channel, target, config, fetcher)
      case 'messenger':
        return await sendMessenger(job, base, kind, target, config, fetcher)
      case 'instagram':
        return await sendInstagram(job, base, target, config, fetcher)
      case 'telegram':
        return await sendTelegram(job, base, target, config, fetcher)
      case 'email':
        return await sendEmail(job, base, target, config, fetcher)
      default:
        return fail('channel_not_supported')
    }
  } catch (e) {
    // ปลายทางไม่ตอบ หรือหมดเวลา — แยกไม่ได้ว่าของถึงหรือไม่ถึง
    // Messenger ยิงซ้ำแล้วลูกค้าอาจได้สองครั้ง ที่เหลือยิงซ้ำได้
    return { ...base, status: channel === 'messenger' && kind === 'send' ? 'uncertain' : 'retry',
             error: `delivery_confirmation_unavailable: ${e.message}` }
  }
}

async function sendLine(job, base, channel, target, config, fetcher) {
  if (!config.access_token) return { ...base, status: 'failed', error: 'line_token_missing' }
  const rendered = renderPayloads(channel, job.payload, job.text)
  const reply = canReplyToken(job)
  const response = await fetcher(reply ? LINE_REPLY : LINE_PUSH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.access_token}`, 'Content-Type': 'application/json',
               // retry key ทำให้ยิงซ้ำแล้วไม่เกิดข้อความซ้ำ — ใช้ได้เฉพาะงานที่มีตัวตนถาวร
               // ทาง reply ไม่ต้องมี เพราะ token ใช้ได้ครั้งเดียวอยู่แล้ว
               ...(base.message_id && !reply ? { 'X-Line-Retry-Key': base.message_id } : {}) },
    body: JSON.stringify(reply ? { replyToken: job.reply_token, messages: rendered }
                               : { to: target, messages: rendered }),
    signal: AbortSignal.timeout(15000),
  })
  // ยิงซ้ำด้วย retry key เดิมแล้วปลายทางบอกว่า "รับไปแล้ว" = สำเร็จ ไม่ใช่ชนกัน
  if (response.status === 409 && response.headers.get('x-line-accepted-request-id')) {
    return { ...base, status: 'sent', provider_id: response.headers.get('x-line-accepted-request-id') }
  }
  if (!response.ok) {
    // 403 ของ push แปลว่าลูกค้าบล็อกบัญชีไปแล้ว ยิงอีกกี่ครั้งก็ไม่ถึง
    // blocked บอกชั้นบนให้ไปติดธงไว้ที่ผู้ติดต่อ จะได้ไม่เสียโควตากับคนที่บล็อกเราแล้ว
    if (response.status === 403 && !reply) {
      return { ...base, status: 'failed', error: 'line_recipient_blocked', blocked: true }
    }
    return { ...base, status: outcome(response.status, channel), error: `provider_http_${response.status}` }
  }
  const data = await response.json().catch(() => ({}))
  return { ...base, status: 'sent',
           provider_id: data?.sentMessages?.[0]?.id ?? response.headers.get('x-line-request-id') ?? null }
}

async function sendMessenger(job, base, kind, target, config, fetcher) {
  // หน้าต่าง 24 ชั่วโมงเป็นกฎของการตอบลูกค้า ไม่ใช่ของการแจ้งทีม
  // ตรวจก่อนเรื่อง token เพราะเป็นเหตุผลที่ *ตรงกว่า* ว่าทำไมงานนี้ส่งไม่ได้
  if (kind === 'send' && (!job.last_inbound_at || Date.now() - Date.parse(job.last_inbound_at) > 86400000)) {
    return { ...base, status: 'failed', error: 'messenger_24h_window_closed' }
  }
  if (!config.access_token) return { ...base, status: 'failed', error: 'meta_token_missing' }
  const url = `https://graph.facebook.com/${config.api_version || 'v23.0'}/${encodeURIComponent(config.account_id)}/messages`
  let providerId = null
  for (const message of renderPayloads('messenger', job.payload, job.text)) {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: target }, messaging_type: 'RESPONSE', message }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return { ...base, status: outcome(response.status, 'messenger'), error: `provider_http_${response.status}` }
    const data = await response.json()
    providerId = data.message_id ?? providerId
  }
  return { ...base, status: 'sent', provider_id: providerId }
}

/**
 * Telegram รับข้อความละไม่เกิน 4,096 ตัวอักษร รายงานรายวันยาวเกินนั้นได้ง่าย
 *
 * ตัดที่ 3,500 เผื่อไว้ แล้วเว้น 1.1 วินาทีระหว่างท่อน เพราะ Telegram จำกัดอัตราการส่ง
 * ยิงรัวจะโดน 429 แล้วท่อนหลัง ๆ หายไปโดยที่ท่อนแรกส่งไปแล้ว — รายงานครึ่งเดียว
 * แย่กว่าไม่มีรายงาน เพราะคนอ่านไม่รู้ว่ามันขาด
 *
 * ★ การหน่วงตรงนี้อยู่ใน worker ไม่ใช่ในเส้นทางที่มีใครรอสายอยู่ (กติกาข้อ 1)
 */
async function sendTelegram(job, base, target, config, fetcher) {
  if (!config.telegram_bot_token) return { ...base, status: 'failed', error: 'telegram_token_missing' }
  const url = `https://api.telegram.org/bot${config.telegram_bot_token}/sendMessage`
  const parts = chunkText(payloadText(job.payload, job.text), Number(config.telegram_chunk ?? 3500))
  let last = null

  for (const [i, part] of parts.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, Number(config.telegram_gap_ms ?? 1100)))
    const response = await fetcher(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text: part, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      // ท่อนแรกไม่ผ่าน = ยังไม่มีอะไรถึงใคร ลองใหม่ได้ทั้งก้อน
      // ท่อนหลังไม่ผ่าน = ทีมเห็นครึ่งเดียวไปแล้ว ยิงซ้ำจะกลายเป็นเห็นซ้ำ ให้คนตัดสิน
      return { ...base, status: i === 0 ? outcome(response.status, 'telegram') : 'uncertain',
               error: `provider_http_${response.status} (ท่อนที่ ${i + 1}/${parts.length})` }
    }
    last = await response.json().catch(() => ({}))
  }
  return { ...base, status: 'sent', parts: parts.length,
           provider_id: last?.result?.message_id != null ? String(last.result.message_id) : null }
}

async function sendEmail(job, base, target, config, fetcher) {
  if (!config.resend_api_key) return { ...base, status: 'failed', error: 'resend_key_missing' }
  const p = job.payload && typeof job.payload === 'object' ? job.payload : {}
  const text = payloadText(job.payload, job.text)
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resend_api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: p.from ?? config.email_from ?? 'onboarding@resend.dev',
      to: [target],
      subject: p.subject ?? 'แจ้งเตือนจาก ASHER Connect',
      // ส่ง html ถ้ามีมาให้ ไม่งั้นส่งข้อความล้วน — ไม่ประกอบ html เองจากข้อความลูกค้า
      ...(p.html ? { html: p.html } : { text }),
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) return { ...base, status: outcome(response.status, 'email'), error: `provider_http_${response.status}` }
  const data = await response.json().catch(() => ({}))
  return { ...base, status: 'sent', provider_id: data?.id ?? null }
}

/**
 * สัญญาณ "กำลังพิมพ์"
 *
 * ล้มแล้วไม่ต้องลองใหม่ — มันคือของประดับที่มีอายุไม่กี่วินาที
 * ยิงซ้ำทีหลังจะกลายเป็นจุดไข่ปลาขึ้นมาตอนที่ไม่มีใครกำลังพิมพ์
 */
async function sendTyping(base, channel, target, config, fetcher) {
  if (channel === 'instagram') return { ...base, status: 'skipped', error: 'instagram_typing_not_enabled' }
  if (!config.access_token) return { ...base, status: 'skipped', error: 'token_missing' }
  const response = channel === 'line'
    ? await fetcher(LINE_LOADING, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: target, loadingSeconds: 20 }),
        signal: AbortSignal.timeout(10000) })
    : await fetcher(`https://graph.facebook.com/${config.api_version || 'v23.0'}/${encodeURIComponent(config.account_id)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: target }, sender_action: 'typing_on' }),
        signal: AbortSignal.timeout(10000) })

  return response.ok
    ? { ...base, status: 'sent' }
    : { ...base, status: 'skipped', error: `provider_http_${response.status}` }
}
