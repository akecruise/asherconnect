// Instagram API with Instagram Login. Tokens never leave the server.
// account_id is the professional IG account ID; recipients are Instagram-scoped IDs.
export function instagramUrl(config, resource = config.account_id) {
  const version = config.api_version || 'v23.0'
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('instagram_api_version_invalid')
  if (!config.account_id || (config.login_type && config.login_type !== 'instagram')) {
    throw new Error('instagram_login_configuration_required')
  }
  return `https://graph.instagram.com/${version}/${encodeURIComponent(resource)}`
}

export function instagramEvents(body, config) {
  if (body?.object !== 'instagram') throw new Error('wrong_object')
  const out = []
  for (const entry of body.entry || []) {
    if (String(entry.id) !== String(config.account_id)) continue
    for (const e of entry.messaging || []) {
      if (e.message?.is_self || e.read || e.delivery || e.reaction) continue
      const echo = e.message?.is_echo === true
      const owner = echo ? e.sender?.id : e.recipient?.id
      const customer = echo ? e.recipient?.id : e.sender?.id
      if (String(owner) !== String(config.account_id) || !customer || String(customer) === String(config.account_id)) continue
      if (!Number.isFinite(e.timestamp) || !Number.isFinite(new Date(e.timestamp).getTime())) continue
      const base = {
        inbox_id: config.inbox_id, platform: 'instagram', source_type: 'user',
        // Existing direction-aware SQL contract uses these historical field names.
        page_id: String(config.account_id), customer_psid: String(customer),
        external_id: String(customer), occurred_at: new Date(e.timestamp).toISOString(),
        reply_token: null, is_redelivery: false, is_standby: false,
      }
      if (e.message?.mid) {
        if (e.message.is_deleted) {
          out.push({ ...base, event_type: 'message_deleted', event_id: `deleted:${e.message.mid}`,
            provider_message_id: e.message.mid })
          continue
        }
        out.push({ ...base, event_type: echo ? 'echo' : 'message', event_id: e.message.mid,
          app_id: e.message.app_id == null ? null : String(e.message.app_id),
          content_type: e.message.text ? 'text' : 'attachment',
          text: e.message.text || '[สื่อแนบจาก Instagram]',
          attribution: { attachments: e.message.attachments || [], reply_to: e.message.reply_to || null,
            referral: e.message.referral || e.referral || null },
        })
      } else if (e.postback) {
        out.push({ ...base, event_type: 'postback',
          event_id: e.postback.mid || `ig-postback:${entry.id}:${customer}:${e.timestamp}:${e.postback.payload || ''}`,
          content_type: 'postback', text: e.postback.title || '[กดปุ่ม Instagram]',
          attribution: { postback: e.postback } })
      }
    }
  }
  return out
}

export function instagramMedia(event) {
  return (Array.isArray(event.attribution?.attachments) ? event.attribution.attachments : []).flatMap(a => {
    try {
      const url = new URL(a?.payload?.url)
      if (url.protocol !== 'https:' || url.username || url.password) return []
      return [{ provider: 'instagram', url: url.href, type: String(a.type || 'file') }]
    } catch { return [] }
  })
}

export async function sendInstagram(job, base, target, config, fetcher) {
  const fail = (error, status = 'failed') => ({ ...base, status, error })
  const age = Date.now() - Date.parse(job.last_inbound_at)
  if (!Number.isFinite(age) || age < 0 || age >= 86400000) return fail('instagram_24h_window_closed')
  if (!config.access_token) return fail('instagram_token_missing')
  let url
  try { url = `${instagramUrl(config)}/messages` } catch (e) { return fail(e.message) }
  const p = job.payload || {}
  if (p.type === 'raw') return fail('instagram_raw_payload_not_supported')
  const messages = []
  const content = p.text ?? job.text
  if (content && p.type !== 'image') messages.push({ text: content })
  const media = p.type === 'image' ? [{ url: p.url }] : (p.media || [])
  for (const item of media) {
    try { if (new URL(item.url).protocol !== 'https:') return fail('instagram_image_url_invalid') }
    catch { return fail('instagram_image_url_invalid') }
    messages.push({ attachment: { type: 'image', payload: { url: item.url } } })
  }
  if (!messages.length) return fail('instagram_message_empty')
  if (messages.some(m => m.text && [...m.text].length > 1000)) return fail('instagram_text_too_long')
  // One provider message per queue item keeps echo correlation and retries exact.
  if (messages.length > 1) return fail('instagram_one_message_at_a_time')
  try {
    const response = await fetcher(url, {
      method: 'POST', headers: { Authorization: `Bearer ${config.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: target }, message: messages[0] }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      const status = response.status === 429 ? 'retry' : response.status >= 500 ? 'uncertain' : 'failed'
      return fail(`instagram_http_${response.status}${data.error?.code ? `_code_${data.error.code}` : ''}`, status)
    }
    if (!data.message_id) return fail('instagram_delivery_confirmation_missing', 'uncertain')
    return { ...base, status: 'sent', provider_id: data.message_id }
  } catch {
    // Meta has no idempotency key: never blindly resend after an ambiguous result.
    return fail('instagram_delivery_confirmation_unavailable', 'uncertain')
  }
}
