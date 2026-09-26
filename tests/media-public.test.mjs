import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPublicMediaUrl, verifyPublicMediaToken } from '../lib/media-public.mjs'

const path = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg'
const secret = 'test-only-media-secret'

test('public media URL is HTTPS, short-lived, and verifiable', () => {
  const now = 1_700_000_000
  const url = new URL(buildPublicMediaUrl('https://inbox.apluscondo.com', path, secret, now, 3600))
  assert.equal(url.protocol, 'https:')
  assert.equal(url.pathname, `/media/public/${path}`)
  assert.equal(verifyPublicMediaToken(path, Number(url.searchParams.get('expires')), url.searchParams.get('token'), secret, now), true)
})

test('public media token rejects expiry, tampering, and unsafe paths', () => {
  const now = 1_700_000_000
  const url = new URL(buildPublicMediaUrl('https://inbox.apluscondo.com', path, secret, now, 60))
  const expires = Number(url.searchParams.get('expires'))
  const token = url.searchParams.get('token')
  assert.equal(verifyPublicMediaToken(path, expires, token, secret, now + 61), false)
  assert.equal(verifyPublicMediaToken(path.replace('.jpg', '.png'), expires, token, secret, now), false)
  assert.equal(verifyPublicMediaToken('../private.jpg', expires, token, secret, now), false)
})

test('public media URL refuses non-local HTTP origins', () => {
  assert.throws(() => buildPublicMediaUrl('http://inbox.apluscondo.com', path, secret), /media_public_https_required/)
})
