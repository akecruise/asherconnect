import { randomBytes, randomUUID } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLES = new Set(['sales', 'senior_sales', 'manager', 'admin'])
const MODULES = new Set(['connect', 'crm'])
const fail = (status, code) => Object.assign(new Error(code), { status })

export function createUserAdmin({ upstream, serviceKey, rpc, sessions, fetchImpl = fetch, now = Date.now }) {
  const resetAttempts = new Map()

  async function auth(path, method = 'GET', body) {
    const response = await fetchImpl(`${upstream}/auth/v1/admin/users${path}`, {
      method,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw fail(response.status === 422 ? 409 : 503,
      response.status === 422 ? 'duplicate_login' : 'user_service_failed')
    return data
  }

  async function actor(token) {
    const who = await rpc(token, 'bootstrap')
    if (!UUID.test(who?.user?.id ?? '') || who.user.role !== 'admin') throw fail(403, 'not_allowed')
    const state = await rpc(serviceKey, 'user_access_state', { p_user: who.user.id }, 'core')
    if (!state?.active || !state.modules?.includes('connect')) throw fail(403, 'not_allowed')
    return who.user.id
  }

  function fields(input, creating = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'invalid_user')
    const email = String(input.email ?? '').trim().toLowerCase()
    const displayName = String(input.display_name ?? '').trim()
    const team = input.team == null ? '' : String(input.team).trim()
    const role = String(input.role ?? '')
    const modules = input.modules
    if (!EMAIL.test(email) || email.length > 254 || !displayName || displayName.length > 200 ||
        team.length > 100 || !ROLES.has(role) || !Array.isArray(modules) ||
        modules.some(m => !MODULES.has(m)) || new Set(modules).size !== modules.length ||
        typeof input.is_active !== 'boolean') throw fail(400, 'invalid_user')
    if (creating && input.is_active && modules.length === 0) throw fail(400, 'invalid_user')
    return { email, display_name: displayName, role, team, modules, is_active: input.is_active }
  }

  function password(input, optional = false) {
    if (optional && input.password == null && input.confirm_password == null) return null
    if (typeof input.password !== 'string' || input.password !== input.confirm_password)
      throw fail(400, 'password_mismatch')
    if (input.password.length < 12 || input.password.length > 1024 ||
        !/[A-Za-z]/.test(input.password) || !/[0-9]/.test(input.password))
      throw fail(400, 'weak_password')
    return input.password
  }

  const temporaryPassword = () => `A${randomBytes(24).toString('base64url')}9`

  async function list(actorId, query) {
    const all = await rpc(serviceKey, 'user_admin_list', { p_actor: actorId }, 'core')
    const authUsers = await auth('?page=1&per_page=1000')
    const authById = new Map((authUsers.users ?? []).map(u => [u.id, u]))
    for (const user of all) {
      user.last_sign_in_at = authById.get(user.id)?.last_sign_in_at ?? null
      user.provisioned = true
    }
    const known = new Set(all.map(user => user.id))
    for (const user of authUsers.users ?? []) {
      if (known.has(user.id)) continue
      all.push({ id: user.id, email: user.email ?? '', display_name: user.email ?? user.id,
        role: null, team: null, modules: [], is_active: false,
        last_sign_in_at: user.last_sign_in_at ?? null, updated_at: user.updated_at ?? null,
        provisioned: false })
    }
    const search = String(query.get('q') ?? '').trim().toLocaleLowerCase()
    const status = query.get('status')
    const role = query.get('role')
    const module = query.get('module')
    const page = Math.max(1, Math.min(100000, Number.parseInt(query.get('page') ?? '1', 10) || 1))
    const pageSize = Math.max(1, Math.min(100, Number.parseInt(query.get('page_size') ?? '20', 10) || 20))
    if (status && !['active', 'disabled'].includes(status)) throw fail(400, 'invalid_filter')
    if (role && !ROLES.has(role)) throw fail(400, 'invalid_filter')
    if (module && !MODULES.has(module)) throw fail(400, 'invalid_filter')
    const rows = all.filter(u => (!search || [u.display_name, u.email, u.team].some(v => String(v ?? '').toLocaleLowerCase().includes(search))) &&
      (!status || u.is_active === (status === 'active')) && (!role || u.role === role) &&
      (!module || u.modules.includes(module)))
    return { users: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, page_size: pageSize }
  }

  async function get(actorId, targetId) {
    if (!UUID.test(targetId)) throw fail(400, 'invalid_user')
    const all = await rpc(serviceKey, 'user_admin_list', { p_actor: actorId }, 'core')
    const user = all.find(u => u.id === targetId)
    if (!user) throw fail(404, 'invalid_user')
    return user
  }

  async function save(actorId, targetId, input, requestId = randomUUID()) {
    const data = fields(input, !targetId)
    let temporary = null
    let created = false
    let oldEmail = null
    if (!targetId) {
      const chosen = password(input, true)
      temporary = chosen ? null : temporaryPassword()
      const createdUser = await auth('', 'POST', { email: data.email, password: chosen ?? temporary,
        email_confirm: true })
      targetId = createdUser.id ?? createdUser.user?.id
      if (!UUID.test(targetId ?? '')) throw fail(503, 'user_service_failed')
      created = true
    } else {
      if (!UUID.test(targetId)) throw fail(400, 'invalid_user')
      const current = await auth(`/${targetId}`)
      oldEmail = current.email ?? current.user?.email
      if (!oldEmail) throw fail(404, 'invalid_user')
      if (oldEmail.toLowerCase() !== data.email) await auth(`/${targetId}`, 'PUT', { email: data.email, email_confirm: true })
    }
    try {
      await rpc(serviceKey, 'user_admin_save', {
        p_actor: actorId, p_target: targetId, p_email: data.email,
        p_display_name: data.display_name, p_role: data.role, p_team: data.team,
        p_modules: data.modules, p_active: data.is_active, p_request_id: requestId,
      }, 'core')
    } catch (error) {
      if (created) await auth(`/${targetId}`, 'DELETE').catch(() => {})
      else if (oldEmail && oldEmail.toLowerCase() !== data.email)
        await auth(`/${targetId}`, 'PUT', { email: oldEmail, email_confirm: true }).catch(() => {})
      throw error
    }
    if (!data.is_active) await revoke(actorId, targetId, requestId)
    return { id: targetId, ...data, ...(temporary ? { temporary_password: temporary } : {}) }
  }

  async function revoke(actorId, targetId, requestId = randomUUID()) {
    if (!UUID.test(targetId)) throw fail(400, 'invalid_user')
    await rpc(serviceKey, 'user_admin_revoke', { p_actor: actorId, p_target: targetId, p_request_id: requestId }, 'core')
    await sessions.revokeUser(targetId)
    return { ok: true }
  }

  async function reset(actorId, targetId, input, requestId = randomUUID()) {
    if (!UUID.test(targetId)) throw fail(400, 'invalid_user')
    const key = `${actorId}:${targetId}`
    const a = resetAttempts.get(key)
    if (a && a.until > now() && a.count >= 5) throw fail(429, 'too_many_attempts')
    resetAttempts.set(key, a && a.until > now() ? { ...a, count: a.count + 1 } : { count: 1, until: now() + 900000 })
    const chosen = input?.generate === true ? temporaryPassword() : password(input)
    await revoke(actorId, targetId, requestId)
    await auth(`/${targetId}`, 'PUT', { password: chosen })
    await rpc(serviceKey, 'user_admin_event', { p_actor: actorId, p_target: targetId,
      p_action: 'password.reset', p_request_id: requestId }, 'core')
    return input?.generate === true ? { ok: true, temporary_password: chosen } : { ok: true }
  }

  async function audit(actorId, targetId) {
    if (!UUID.test(targetId)) throw fail(400, 'invalid_user')
    return rpc(serviceKey, 'user_admin_audit_list', { p_actor: actorId, p_target: targetId }, 'core')
  }

  return { actor, list, get, save, revoke, reset, audit, fields, password }
}
