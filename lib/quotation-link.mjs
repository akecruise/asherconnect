import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const signature = (id, expires, key) => createHmac('sha256', key).update(`${id}\n${expires}`).digest('hex')
const imageSignature = (id, expires, key) => createHmac('sha256', key).update(`image:${id}\n${expires}`).digest('hex')

export function createQuotationUrl(origin, id, key, now = Date.now(), ttlSeconds = 7 * 24 * 3600) {
  if (!UUID.test(String(id)) || !key) return null
  const expires = Math.floor(now / 1000) + ttlSeconds
  return `${origin}/quotation-document/${id}?expires=${expires}&signature=${signature(id, expires, key)}`
}

export function verifyQuotationUrl(id, expiresValue, supplied, key, now = Date.now()) {
  const expires = Number(expiresValue)
  if (!UUID.test(String(id)) || !key || !Number.isInteger(expires) || expires < Math.floor(now / 1000) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false
  const expected = Buffer.from(signature(id, expires, key), 'hex')
  const actual = Buffer.from(supplied, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function createQuotationImageUrl(origin, id, key, now = Date.now(), ttlSeconds = 7 * 24 * 3600) {
  if (!UUID.test(String(id)) || !key) return null
  const expires = Math.floor(now / 1000) + ttlSeconds
  return `${origin}/quotation-image/${id}?expires=${expires}&signature=${imageSignature(id, expires, key)}`
}

export function verifyQuotationImageUrl(id, expiresValue, supplied, key, now = Date.now()) {
  const expires = Number(expiresValue)
  if (!UUID.test(String(id)) || !key || !Number.isInteger(expires) || expires < Math.floor(now / 1000) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false
  const expected = Buffer.from(imageSignature(id, expires, key), 'hex')
  const actual = Buffer.from(supplied, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
