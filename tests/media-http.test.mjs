import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createMediaHandler, createPublicMediaHandler } from '../lib/media-http.mjs'
import { buildPublicMediaUrl } from '../lib/media-public.mjs'

const path = '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg'
const url = new URL(`https://connect.test/media/${path}`)
const fail = (status, message) => Object.assign(new Error(message), { status })
function setup({ authenticated = true, allowed = true, mime = 'image/jpeg' } = {}) {
  const calls = []
  const headers = {}
  const chunks = []
  const res = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done() } })
  res.setHeader = (key, value) => { headers[key] = value }
  res.writeHead = (status, values) => { res.status = status; Object.assign(headers, values) }
  const handler = createMediaHandler({
    fail,
    sessions: { access: async () => { if (!authenticated) throw fail(401, 'no_session'); return 'session-token' } },
    rpcDirect: async (token, name, data) => { calls.push({ token, name, data }); return allowed },
    fetchObject: async requested => { calls.push({ storage: requested }); return new Response('image-bytes', { headers: { 'content-type': mime } }) },
  })
  return { handler, res, calls, headers, chunks }
}
test('anonymous media read returns 401 without accessing storage', async () => {
  const t = setup({ authenticated: false })
  await assert.rejects(t.handler({ method: 'GET', headers: {} }, t.res, url), { status: 401 })
  assert.equal(t.calls.length, 0)
})
test('authenticated but unauthorized media read returns 403 before storage', async () => {
  const t = setup({ allowed: false })
  await assert.rejects(t.handler({ method: 'GET', headers: {} }, t.res, url), { status: 403 })
  assert.equal(t.calls.length, 1)
})
test('workspace bearer token is authorized before streaming private media', async () => {
  const t = setup({ authenticated: false })
  await t.handler({ method: 'GET', headers: { authorization: 'Bearer workspace-token' } }, t.res, url)
  assert.deepEqual(t.calls, [{ token: 'workspace-token', name: 'media_access', data: { p_path: path } }, { storage: path }])
  assert.equal(Buffer.concat(t.chunks).toString(), 'image-bytes')
  assert.equal(t.headers['Cache-Control'], 'private, no-store')
})
test('active content is downloaded, never executed on the application origin', async () => {
  const t = setup({ mime: 'text/html' })
  await t.handler({ method: 'GET', headers: {} }, t.res, url)
  assert.equal(t.headers['Content-Disposition'], 'attachment')
  assert.equal(t.headers['X-Content-Type-Options'], 'nosniff')
})

test('Messenger public media proxy streams only a valid short-lived URL', async () => {
  const t = setup()
  const secret = 'test-only-media-secret'
  const publicUrl = new URL(buildPublicMediaUrl('https://connect.test', path, secret))
  const handler = createPublicMediaHandler({
    secret,
    fail,
    fetchObject: async requested => {
      assert.equal(requested, path)
      return new Response('image-bytes', { headers: { 'content-type': 'image/jpeg' } })
    },
  })
  await handler({ method: 'GET', headers: {} }, t.res, publicUrl)
  assert.equal(Buffer.concat(t.chunks).toString(), 'image-bytes')
  assert.equal(t.headers['Cache-Control'], 'public, max-age=300')
  await assert.rejects(handler({ method: 'GET', headers: {} }, t.res, new URL(`${publicUrl}?token=bad`)), { status: 404 })
})
