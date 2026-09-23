/**
 * ดึงชื่อและรูปโปรไฟล์ลูกค้าจาก LINE / Messenger
 *
 * ★ โมดูลนี้ไม่รู้จักฐานข้อมูลและไม่อ่าน process.env เลย
 *   token ถูกส่งเข้ามาทาง config (มาจาก channels.json) เหมือน providers.mjs
 *   เหตุผลเดียวกัน: กติกาข้อ 6 ของโปรเจกต์ — secret มาจาก channels.json เท่านั้น
 *   และเทสต์ยิงฟังก์ชันตรง ๆ ได้โดยไม่ต้องตั้งค่าอะไร
 *
 * ★ ห้าม log token และห้าม log เนื้อคำตอบ — คำตอบมีชื่อจริงกับรูปของลูกค้า
 *   ที่พิมพ์ออกได้มีแค่ channel, สถานะ HTTP และรหัส error
 */

const TIMEOUT_MS = 5000
const CACHE_TTL_MS = 6 * 60 * 60 * 1000   // 6 ชม. — กันยิงซ้ำภายในโพรเซสเดียว

import { instagramUrl } from './instagram.mjs'

// ผลที่ดึงได้ล่าสุดต่อหนึ่งคน · คีย์ = channel|account_key|external_id
const cache = new Map()
// คนที่กำลังยิงอยู่ ณ ตอนนี้ — ★ ข้อความหลายก้อนจากคนเดียวกันมาติด ๆ กันได้
// ถ้าไม่กันไว้จะยิง API พร้อมกันหลายนัดสำหรับคนเดียว เปลืองโควตาและได้ผลเท่ากัน
const inflight = new Map()

const keyOf = (channel, accountKey, externalId) => `${channel}|${accountKey ?? ''}|${externalId}`

/** แปลงผลดิบให้เหลือเฉพาะที่ต้องใช้ — ไม่ให้ฟิลด์อื่นของแพลตฟอร์มหลุดออกไปที่อื่น */
const shape = (status, displayName, pictureUrl) => ({
  status,
  display_name: (displayName ?? '').trim() || null,
  picture_url: (pictureUrl ?? '').trim() || null,
})

/** LINE เลือก endpoint ตามที่มาของข้อความ — คนละ endpoint กันคนละสิทธิ์ */
function lineUrl(externalId, source) {
  const id = encodeURIComponent(externalId)
  if (source?.type === 'group' && source.id) return `https://api.line.me/v2/bot/group/${encodeURIComponent(source.id)}/member/${id}`
  if (source?.type === 'room' && source.id) return `https://api.line.me/v2/bot/room/${encodeURIComponent(source.id)}/member/${id}`
  return `https://api.line.me/v2/bot/profile/${id}`
}

async function callProvider(channel, externalId, config, source, fetcher) {
  if (channel === 'instagram') {
    const r = await fetcher(`${instagramUrl(config, externalId)}?fields=name,username,profile_pic`, {
      headers: { Authorization: `Bearer ${config.access_token}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const b = await r.json().catch(() => ({}))
    if (r.status === 404) return shape('not_found')
    if (!r.ok || b.error) return { status: 'error', http: r.status, code: b.error?.code }
    return shape('ok', b.name || b.username, b.profile_pic)
  }
  if (channel === 'line') {
    const r = await fetcher(lineUrl(externalId, source), {
      headers: { Authorization: `Bearer ${config.access_token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (r.status === 404) return shape('not_found')
    if (!r.ok) return { status: 'error', http: r.status }
    const b = await r.json()
    return shape('ok', b.displayName, b.pictureUrl)
  }

  // Messenger: ต่อ first_name + last_name เอง — ฟิลด์ name ต้องใช้สิทธิ์คนละตัว
  const v = config.api_version || 'v23.0'
  const url = `https://graph.facebook.com/${v}/${encodeURIComponent(externalId)}` +
    `?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(config.access_token)}`
  const r = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const b = await r.json().catch(() => ({}))
  if (r.status === 404 || b?.error?.code === 100) return shape('not_found')
  if (!r.ok) return { status: 'error', http: r.status, code: b?.error?.code ?? null }
  return shape('ok', [b.first_name, b.last_name].filter(Boolean).join(' '), b.profile_pic)
}

/**
 * ดึงโปรไฟล์หนึ่งคน
 *
 * คืนเสมอ ไม่เคย throw — ผู้เรียกอยู่ในเส้นทางบันทึกข้อความ
 * ถ้าโมดูลนี้โยน error ข้อความของลูกค้าจะหายไปทั้งก้อน ซึ่งแย่กว่าไม่มีชื่อมาก
 *
 * @param {object} args
 * @param {'line'|'messenger'} args.channel
 * @param {string} args.externalId      userId ของ LINE หรือ PSID ของ Messenger
 * @param {object} args.config          แถวจาก channels.json (ต้องมี access_token)
 * @param {object} [args.source]        { type: 'user'|'group'|'room', id }
 * @param {object} [args.deps]          { fetch, log, now } สำหรับเทสต์
 * @returns {Promise<{status:'ok'|'not_found'|'error', display_name:string|null, picture_url:string|null}>}
 */
export async function fetchProfile({ channel, externalId, config, source, deps = {} }) {
  const fetcher = deps.fetch ?? fetch
  const log = deps.log ?? console
  const now = deps.now ?? Date.now

  if (!externalId || !config?.access_token) return shape('error')

  const key = keyOf(channel, config.inbox_id, externalId)

  const hit = cache.get(key)
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value

  // ★ คนเดียวกันส่งมาสามข้อความรวดเดียว = รอผลนัดเดียวกัน ไม่ยิงสามนัด
  const running = inflight.get(key)
  if (running) return running

  const task = (async () => {
    try {
      const out = await callProvider(channel, externalId, config, source, fetcher)
      if (out.status === 'error') {
        // ★ พิมพ์ได้แค่รหัส ห้ามพิมพ์ token และห้ามพิมพ์เนื้อคำตอบ
        log.warn?.('[profile] ' + channel + ' http=' + (out.http ?? '-') +
                   (out.code != null ? ' code=' + out.code : ''))
        return shape('error')
      }
      return out
    } catch (e) {
      // timeout ของ AbortSignal มาเป็น TimeoutError
      const reason = e?.name === 'TimeoutError' ? 'timeout' : (e?.name || 'error')
      log.warn?.('[profile] ' + channel + ' ' + reason)
      return shape('error')
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  const value = await task
  cache.set(key, { at: now(), value })
  return value
}

/** ใช้ในเทสต์เท่านั้น — ล้างของที่จำไว้ระหว่างเคส */
export function _resetProfileCache() { cache.clear(); inflight.clear() }
