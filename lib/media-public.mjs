import { createHmac, timingSafeEqual } from 'node:crypto'
import { safeMediaPath } from './media.mjs'

const tokenFor = (path, expires, secret) =>
  createHmac('sha256', secret).update(`${expires}:${path}`).digest('hex')

export function buildPublicMediaUrl(origin, path, secret, now = Math.floor(Date.now() / 1000), ttl = 3600) {
  const safePath = safeMediaPath(path)
  if (!safePath || !secret) throw new Error('media_public_url_unavailable')
  const base = new URL(origin)
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('media_public_https_required')
  }
  const expires = now + ttl
  const token = tokenFor(safePath, expires, secret)
  return `${base.origin}/media/public/${safePath}?expires=${expires}&token=${token}`
}

export function verifyPublicMediaToken(path, expires, token, secret, now = Math.floor(Date.now() / 1000)) {
  const safePath = safeMediaPath(path)
  if (!safePath || !secret || !Number.isInteger(expires) || expires < now || !/^[a-f0-9]{64}$/i.test(token || '')) return false
  const expected = Buffer.from(tokenFor(safePath, expires, secret), 'hex')
  const actual = Buffer.from(token, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
