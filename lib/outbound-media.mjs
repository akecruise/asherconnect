import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID_MEDIA = /^[0-9a-f-]{36}\/[0-9a-f-]{36}(?:-[1-9][0-9]*)?\.(?:jpg|png|gif|webp)$/i
const OUTBOUND_MEDIA = /^(?:qr|outbound)\/[a-z0-9-]+\.(?:jpg|png|webp)$/i

export const safeOutboundPath = value => {
  const path = String(value || '')
  return UUID_MEDIA.test(path) || OUTBOUND_MEDIA.test(path) ? path : null
}

const signature = (path, expires, key) => createHmac('sha256', key).update(`${path}\n${expires}`).digest('hex')

export function createOutboundMediaUrl(origin, path, key, now = Date.now(), ttlSeconds = 7 * 24 * 3600) {
  const safe = safeOutboundPath(path)
  if (!safe) return null
  const expires = Math.floor(now / 1000) + ttlSeconds
  return `${origin}/outbound-media/${safe}?expires=${expires}&signature=${signature(safe, expires, key)}`
}

export function verifyOutboundMedia(path, expiresValue, supplied, key, now = Date.now()) {
  const safe = safeOutboundPath(path)
  const expires = Number(expiresValue)
  if (!safe || !Number.isInteger(expires) || expires < Math.floor(now / 1000) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false
  const expected = Buffer.from(signature(safe, expires, key), 'hex')
  const actual = Buffer.from(supplied, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
