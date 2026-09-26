/** TikTok Business Messaging v1.3. Contract checked 2026-09-23; see docs/tiktok/API-RESEARCH.md. */
import { createHmac, timingSafeEqual } from 'node:crypto'

const SEND_URL = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/'
const REFRESH_URL = 'https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/'
// Local replay policy. TikTok's documentation gives 5 seconds only as an example,
// not a requirement; a five-minute tolerance accommodates network delays.
const SIGNATURE_MAX_AGE_SECONDS = 300

export function verifyTikTokSignature(raw, header, appSecret, now = Date.now()) {
  if (!header || !appSecret) return false
  const fields = Object.fromEntries(String(header).split(',').map(part => part.trim().split('=')))
  if (!/^\d{10}$/.test(fields.t ?? '') || !/^[a-f0-9]{64}$/i.test(fields.s ?? '')) return false
  const age = Math.abs(Math.floor(now / 1000) - Number(fields.t))
  if (age > SIGNATURE_MAX_AGE_SECONDS) return false
  let body
  try { body = JSON.stringify(JSON.parse(Buffer.from(raw).toString('utf8'))) }
  catch { return false }
  const expected = createHmac('sha256', appSecret).update(`${fields.t}.${body}`).digest()
  const supplied = Buffer.from(fields.s, 'hex')
  return timingSafeEqual(expected, supplied)
}

export function matchesTikTokDestination(body, config) {
  return !!config?.account_id && !!config?.app_id &&
    body?.user_openid === config.account_id && body?.client_key === config.app_id
}

export function normalizeTikTokWebhook(body, config) {
  if (!matchesTikTokDestination(body, config)) throw new Error('wrong_destination')
  if (body.event === 'im_receive_msg_eu') return [] // TikTok omits sender, conversation and message ID.
  if (!['im_receive_msg', 'im_send_msg'].includes(body.event)) return []
  let content
  try { content = typeof body.content === 'string' ? JSON.parse(body.content) : null }
  catch { throw new Error('invalid_tiktok_content') }
  const inbound = body.event === 'im_receive_msg'
  const business = inbound ? content?.to_user : content?.from_user
  const customer = inbound ? content?.from_user : content?.to_user
  const externalId = content?.unique_identifier
  const occurredAt = Number(content?.timestamp)
  if (business?.role !== 'business_account' || business.id !== config.account_id ||
      customer?.role !== 'personal_account' || !externalId ||
      (customer.id && customer.id !== externalId) || !content?.conversation_id || !content?.message_id ||
      content.timestamp == null || !Number.isFinite(occurredAt) ||
      !Number.isFinite(new Date(occurredAt).getTime())) throw new Error('invalid_tiktok_message')

  const type = String(content.type ?? '').toLowerCase()
  const message = type === 'text' ? String(content.text?.body ?? '')
    : type === 'image' ? '[รูปภาพจาก TikTok]'
    : type === 'video' ? '[วิดีโอจาก TikTok]'
    : type === 'share_post' ? '[โพสต์จาก TikTok]'
    : '[ข้อความ TikTok ที่ยังไม่รองรับ]'
  return [{
    inbox_id: config.inbox_id,
    event_type: inbound ? 'message' : 'echo',
    event_id: String(content.message_id),
    external_id: String(externalId),
    page_id: config.account_id,
    customer_psid: String(externalId),
    tiktok_conversation_id: String(content.conversation_id),
    occurred_at: new Date(occurredAt).toISOString(),
    content_type: type || 'unknown', text: message,
    has_text: type === 'text', reply_token: null, is_redelivery: false,
    attribution: {
      provider_conversation_id: String(content.conversation_id),
      provider_message_id: String(content.message_id),
      source: content.message_tag?.source ?? null,
      media_id: type === 'image' ? content.image?.media_id ?? null
        : type === 'video' ? content.video?.media_id ?? null : null,
    },
  }]
}

/** One text per request. Without a documented idempotency key, uncertain sends are never retried automatically. */
export async function sendTikTokText(job, config, fetcher = fetch, now = Date.now()) {
  const base = { job_id: job.id ?? null, message_id: job.message_id ?? null, lease_id: job.lease_id ?? null }
  const fail = (error, status = 'failed') => ({ ...base, status, error })
  const text = job.payload?.type === 'text' ? job.payload.text : job.text
  if (!config?.account_id || !config?.access_token) return fail('tiktok_not_configured')
  if (!job.tiktok_conversation_id) return fail('tiktok_conversation_missing')
  if ((job.payload && job.payload.type !== 'text') ||
      typeof text !== 'string' || !text.trim() || text.length > 6000 || job.payload?.media?.length) {
    return fail('tiktok_text_only_limit')
  }
  const lastInbound = Date.parse(job.last_inbound_at ?? '')
  if (!Number.isFinite(lastInbound) || now - lastInbound < 0 || now - lastInbound > 48 * 3600 * 1000) {
    return fail('tiktok_reply_window_unverified')
  }
  try {
    const response = await fetcher(SEND_URL, {
      method: 'POST',
      headers: { 'Access-Token': config.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: config.account_id, recipient_type: 'CONVERSATION',
        recipient: job.tiktok_conversation_id, message_type: 'TEXT', text: { body: text } }),
      signal: AbortSignal.timeout(15000),
    })
    const result = await response.json().catch(() => null)
    if (response.status === 429 || result?.code === 40100) return fail('tiktok_rate_limited', 'retry')
    if (response.status >= 500 || result?.code === 51065) return fail('tiktok_result_uncertain', 'uncertain')
    if (result?.code === 40105 || response.status === 401) return fail('tiktok_token_invalid')
    if (!response.ok) return fail(`tiktok_rejected_${result?.code ?? response.status}`)
    if (typeof result?.code !== 'number') return fail('tiktok_response_unverified', 'uncertain')
    if (result.code !== 0) return fail(`tiktok_rejected_${result.code}`)
    const providerId = result?.data?.message?.message_id
    if (!providerId) return fail('tiktok_message_id_missing', 'uncertain')
    return { ...base, status: 'sent', provider_id: String(providerId) }
  } catch {
    return fail('tiktok_delivery_confirmation_unavailable', 'uncertain')
  }
}

/** Refresh result only; caller must persist both rotated tokens atomically before using them. */
export async function refreshTikTokToken(config, fetcher = fetch) {
  if (!config?.app_id || !config?.secret || !config?.refresh_token || !config?.account_id) {
    throw new Error('tiktok_refresh_not_configured')
  }
  const response = await fetcher(REFRESH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.app_id, client_secret: config.secret,
      grant_type: 'refresh_token', refresh_token: config.refresh_token }),
    signal: AbortSignal.timeout(15000),
  })
  const result = await response.json().catch(() => null)
  const data = result?.data
  if (!response.ok || result?.code !== 0 || !data?.access_token || !data?.refresh_token ||
      data.open_id !== config.account_id || !Number.isFinite(Number(data.expires_in)) ||
      !Number.isFinite(Number(data.refresh_token_expires_in))) {
    throw new Error('tiktok_refresh_failed')
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token,
    expires_in: Number(data.expires_in), refresh_token_expires_in: Number(data.refresh_token_expires_in),
    scope: data.scope ?? '' }
}
