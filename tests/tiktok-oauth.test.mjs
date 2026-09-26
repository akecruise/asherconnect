import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTikTokOAuthCallback, TIKTOK_OAUTH_CALLBACK_PATH } from '../lib/tiktok-oauth.mjs'

test('defines the production callback path', () => {
  assert.equal(TIKTOK_OAUTH_CALLBACK_PATH, '/api/integrations/tiktok/oauth/callback')
})

test('does not expose an authorization code', () => {
  const parsed = parseTikTokOAuthCallback(new URL('https://example.test/callback?code=secret-code&state=opaque'))
  assert.deepEqual(parsed, { status: 'received', state_present: true })
  assert.equal(JSON.stringify(parsed).includes('secret-code'), false)
})

test('handles denied and malformed callbacks without secrets', () => {
  assert.deepEqual(
    parseTikTokOAuthCallback(new URL('https://example.test/callback?error=access_denied&error_description=nope')),
    { status: 'denied', error: 'access_denied', error_description: 'nope', state_present: false },
  )
  assert.deepEqual(
    parseTikTokOAuthCallback(new URL('https://example.test/callback?state=opaque')),
    { status: 'missing_code', state_present: true },
  )
})

