import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserAdmin } from '../services/user-admin/service.mjs'

const actorId = '11111111-1111-4111-8111-111111111111'
const targetId = '22222222-2222-4222-8222-222222222222'
const valid = { email: 'new@asher.local', display_name: 'New User', role: 'sales', team: 'A', modules: ['connect', 'crm'], is_active: true }

test('admin guard checks canonical role and active Connect access', async () => {
  const rpc = async (_token, action) => action === 'bootstrap'
    ? { user: { id: actorId, role: 'admin' } }
    : { active: false, modules: ['connect'] }
  const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'secret', rpc, sessions: { revokeUser() {} } })
  await assert.rejects(() => admin.actor('jwt'), { status: 403 })
})

test('Auth creation is compensated when canonical profile/access transaction fails', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body })
    return new Response(JSON.stringify(options.method === 'POST' ? { id: targetId } : {}), { status: 200 })
  }
  const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'secret', fetchImpl,
    rpc: async () => { throw new Error('profile insert failed') }, sessions: { revokeUser() {} } })
  await assert.rejects(() => admin.save(actorId, null, valid), /profile insert failed/)
  assert.deepEqual(calls.map(c => c.method), ['POST', 'DELETE'])
  assert.equal(calls[1].url.endsWith(targetId), true)
})

test('password validation rejects mismatch and weak values before Auth request', async () => {
  let requests = 0
  const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'secret',
    fetchImpl: async () => { requests++; throw new Error('should not be called') },
    rpc: async () => ({}), sessions: { revokeUser() {} } })
  await assert.rejects(() => admin.reset(actorId, targetId, { password: 'LongPassword123', confirm_password: 'different' }), { status: 400 })
  await assert.rejects(() => admin.reset(actorId, targetId, { password: 'short', confirm_password: 'short' }), { status: 400 })
  assert.equal(requests, 0)
})

test('list search, role, module and pagination use canonical rows', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ users: [{ id: targetId, last_sign_in_at: '2026-09-23T00:00:00Z' }] }), { status: 200 })
  const rpc = async () => [
    { id: targetId, email: 'new@asher.local', display_name: 'New User', team: 'A', role: 'sales', modules: ['crm'], is_active: true },
    { id: actorId, email: 'admin@asher.local', display_name: 'Admin', team: 'B', role: 'admin', modules: ['connect','crm'], is_active: true },
  ]
  const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'secret', fetchImpl, rpc, sessions: { revokeUser() {} } })
  const result = await admin.list(actorId, new URLSearchParams({ q: 'new', role: 'sales', module: 'crm', page_size: '1' }))
  assert.equal(result.total, 1)
  assert.equal(result.users[0].last_sign_in_at, '2026-09-23T00:00:00Z')
})

test('admin save preserves module isolation and never returns a password', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    return new Response(JSON.stringify(options.method === 'POST' ? { id: targetId } : {}), { status: 200 })
  }
  const rpc = async (_token, action, data) => {
    calls.push({ action, data })
    return action === 'user_admin_save' ? { ok: true } : undefined
  }
  const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'service-role-secret', fetchImpl, rpc,
    sessions: { revokeUser() {} } })
  const result = await admin.save(actorId, null, {
    ...valid, modules: ['crm'], password: 'A-secure-password-123', confirm_password: 'A-secure-password-123',
  })
  assert.deepEqual(result.modules, ['crm'])
  assert.equal(Object.hasOwn(result, 'password'), false)
  const saveCall = calls.find(call => call.action === 'user_admin_save')
  assert.deepEqual(saveCall.data.p_modules, ['crm'])
  assert.equal(JSON.stringify(result).includes('service-role-secret'), false)
})

test('duplicate Auth email is rejected before canonical profile mutation', async () => {
  let rpcCalls = 0
  const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'service-role-secret',
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 422 }),
    rpc: async () => { rpcCalls++ }, sessions: { revokeUser() {} } })
  await assert.rejects(() => admin.save(actorId, null, valid), { status: 409, message: 'duplicate_login' })
  assert.equal(rpcCalls, 0)
})

test('reset revokes sessions, changes Auth password server-side, and returns no password for explicit reset', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    return new Response('{}', { status: 200 })
  }
  const rpc = async (_token, action, data) => { calls.push({ action, data }); return undefined }
  const revoked = []
  const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'service-role-secret', fetchImpl, rpc,
    sessions: { revokeUser: id => revoked.push(id) } })
  const result = await admin.reset(actorId, targetId, { password: 'A-secure-password-123', confirm_password: 'A-secure-password-123' })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(revoked, [targetId])
  assert.equal(calls.find(call => call.action === 'user_admin_revoke').data.p_target, targetId)
  assert.equal(calls.find(call => call.action === 'user_admin_event').data.p_action, 'password.reset')
  assert.equal(calls.find(call => call.method === 'PUT').body.password, 'A-secure-password-123')
  assert.equal(Object.hasOwn(result, 'temporary_password'), false)
})

test('disabled or non-admin actors cannot use the admin service', async () => {
  for (const role of ['manager', 'sales']) {
    const admin = createUserAdmin({ upstream: 'http://mock', serviceKey: 'service-role-secret',
      rpc: async (_token, action) => action === 'bootstrap'
        ? { user: { id: actorId, role } }
        : { active: true, modules: ['connect'] }, sessions: { revokeUser() {} } })
    await assert.rejects(() => admin.actor('jwt'), { status: 403 })
  }
  const disabled = createUserAdmin({ upstream: 'http://mock', serviceKey: 'service-role-secret',
    rpc: async (_token, action) => action === 'bootstrap'
      ? { user: { id: actorId, role: 'admin' } }
      : { active: false, modules: ['connect'] }, sessions: { revokeUser() {} } })
  await assert.rejects(() => disabled.actor('jwt'), { status: 403 })
})
