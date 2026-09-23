import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

test('real HTTP Instagram webhook: verification, signature, isolation and worker dispatch', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'asher-instagram-'))
  const calls = [], queue = []
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const data = raw ? JSON.parse(raw) : {}
    const fn = req.url.split('/').at(-1)
    calls.push({ fn, ...data })
    let result = null
    if (fn === 'connect_worker') {
      if (data.p_action === 'log') { queue.push({ id: queue.length + 1, channel_key: data.p_data.channel_key, payload: data.p_data.payload, lease_id: 'lease' }); result = { log_id: 1 } }
      if (data.p_action === 'claim_inbound') result = queue.shift() || null
      if (data.p_action === 'receive') result = { id: 'conversation-test', message_id: 'message-test' }
      if (data.p_action === 'send_mode') result = { live: false }
      if (data.p_action === 'profile_due') result = []
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  const channel = { key: 'ig-test', channel: 'instagram', name: 'IG Test', enabled: true,
    inbox_id: '00000000-0000-4000-8000-000000000001', account_id: '17890000001', login_type: 'instagram',
    secret: 'fake-secret', access_token: 'fake-token', verify_token: 'fake-verify' }
  await writeFile(join(dir, 'channels.json'), JSON.stringify([channel]))
  // No network calls may escape this integration test (tokens are fake).
  await writeFile(join(dir, 'network.mjs'), `const original=globalThis.fetch;globalThis.fetch=(url,init)=>{if(new URL(url).hostname==='127.0.0.1')return original(url,init);return Promise.resolve(new Response('{}',{status:503}));};`)
  let logs = ''
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(dir, 'network.mjs')).href, 'server.mjs'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port),
      SUPABASE_URL: `http://127.0.0.1:${upstream.address().port}`, SUPABASE_ANON_KEY: 'fake-anon', SUPABASE_SERVICE_ROLE_KEY: 'fake-service',
      CONNECT_CHANNELS_FILE: join(dir, 'channels.json'), SESSION_DIR: join(dir, 'sessions'),
      CONNECT_HEALTH: 'off', CONNECT_SHADOW_MODE: 'true', ASHER_CRM_PUBLISH_ENABLED: 'false', TEST_USER_IDS: '',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { logs += chunk }); child.stderr.on('data', chunk => { logs += chunk })
  t.after(async () => { const stopped = child.exitCode == null ? once(child, 'exit').catch(() => {}) : Promise.resolve(); child.kill(); await Promise.race([stopped, new Promise(r => setTimeout(r, 1000))]); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${port}/webhooks/ig-test`
  for (let i = 0; i < 100 && !logs.includes('listening on'); i++) { if (child.exitCode != null) throw new Error(logs); await new Promise(r => setTimeout(r, 25)) }
  assert.match(logs, /1 active channel/)
  const verify = await fetch(base + '?hub.mode=subscribe&hub.verify_token=fake-verify&hub.challenge=12345')
  assert.equal(verify.status, 200); assert.equal(await verify.text(), '12345')
  assert.equal((await fetch(base + '?hub.mode=subscribe&hub.verify_token=wrong')).status, 403)
  const event = { sender: { id: 'customer-test' }, recipient: { id: channel.account_id }, timestamp: Date.now(), message: { mid: 'ig-mid', text: 'สนใจห้อง' } }
  const body = { object: 'instagram', entry: [{ id: channel.account_id, messaging: [event] }] }
  const post = (value, signed = true) => {
    const raw = JSON.stringify(value)
    return fetch(base, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
      'X-Hub-Signature-256': signed ? 'sha256=' + createHmac('sha256', channel.secret).update(raw).digest('hex') : 'invalid' } })
  }
  assert.equal((await post(body, false)).status, 401)
  assert.equal((await post({ ...body, object: 'page' })).status, 400)
  assert.equal((await post({ object: 'instagram', entry: [{ id: 'other-account', messaging: [event] }] })).status, 400)
  assert.equal((await post({ ...body, entry: [...body.entry, { id: 'foreign', messaging: [event] }] })).status, 200)
  const logged = calls.find(c => c.p_action === 'log')
  assert.equal(logged.p_data.channel, 'instagram'); assert.equal(logged.p_data.payload.entry.length, 1)
  for (let i = 0; i < 60 && !calls.some(c => c.p_action === 'receive'); i++) await new Promise(r => setTimeout(r, 100))
  const received = calls.find(c => c.p_action === 'receive')
  assert.equal(received?.p_data.external_id, 'customer-test'); assert.equal(received.p_data.event_type, 'message')
  assert.equal(received.p_data.inbox_id, channel.inbox_id)
  const deleted = structuredClone(body); deleted.entry[0].messaging[0].message = { mid: 'ig-mid', is_deleted: true }
  assert.equal((await post(deleted)).status, 200)
  for (let i = 0; i < 60 && !calls.some(c => c.fn === 'instagram_message_deleted'); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(calls.find(c => c.fn === 'instagram_message_deleted')?.p_message_id, 'ig-mid')
  assert.equal(logs.includes('fake-token'), false)
})
