import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessions } from '../auth.mjs'

// ชุดนี้ไม่แตะฐานจริงและไม่ส่งข้อความหาลูกค้า — ปลายทาง Supabase เป็นของจำลองทั้งหมด
// รันซ้ำได้ ไม่ทิ้งขยะ (โฟลเดอร์เซสชันสร้างใน temp แล้วลบทิ้งท้ายเทสต์)

const err = status => Object.assign(new Error('denied'), { status })
const temp = () => mkdtemp(join(tmpdir(), 'connect-sessions-'))

test('ตัวตนแยกกัน · คุกกี้ · ออกจากระบบแล้วใช้ซ้ำไม่ได้ · หมุน token ทีละครั้ง · หมดอายุ', async () => {
  const sessionDir = await temp()
  try {
    let clock = 0, refreshes = 0
    const deps = {
      origin: 'https://inbox.example', sessionDir, now: () => clock, log: { warn() {}, info() {} },
      rpc: async token => ({ user: { id: token } }),
      authCall: async (path, o) => {
        if (path.includes('logout')) return {}
        if (path.includes('refresh_token')) {
          refreshes++
          await new Promise(r => setTimeout(r, 10))
          return { access_token: o.body.refresh_token, refresh_token: o.body.refresh_token, expires_in: 3600 }
        }
        if (o.body.password !== 'correct') throw err(401)
        return { access_token: o.body.email, refresh_token: o.body.email, expires_in: 3600 }
      },
    }
    const sessions = createSessions(deps)
    const login = async email => {
      let cookie
      await sessions.login({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { setHeader: (_, v) => cookie = v }, { email, password: 'correct' })
      assert.match(cookie, /HttpOnly; SameSite=Lax/)
      assert.match(cookie, /; Secure/)
      return { headers: { cookie: cookie.split(';')[0] } }
    }

    const a = await login('a@example.com'), b = await login('b@example.com')
    assert.equal(await sessions.access(a), 'a@example.com')
    assert.equal(await sessions.access(b), 'b@example.com')

    // คุกกี้ที่แต่งเองต้องไม่ผ่าน และต้องตกด้วยรหัสเดียวกับ "ไม่มีเซสชัน"
    await assert.rejects(sessions.access({ headers: { cookie: 'asher_session=forged' } }), { status: 401 })

    // ★ หัวใจของการเก็บเป็นไฟล์: สร้างตัวจัดการใหม่บนโฟลเดอร์เดิม = จำลองการรีสตาร์ตบริการ
    //   คนที่ล็อกอินค้างไว้ต้องยังใช้งานต่อได้ ไม่ใช่ถูกเด้งออกพร้อมกันทั้งออฟฟิศ
    const afterRestart = createSessions(deps)
    assert.equal(await afterRestart.access(a), 'a@example.com')

    // refresh token ใช้ได้ครั้งเดียว สองคำขอพร้อมกันต้องหมุนแค่หนึ่งรอบ
    clock = 3550000
    await Promise.all([sessions.access(a), sessions.access(a)])
    assert.equal(refreshes, 1)

    await sessions.logout(a, { setHeader() {} })
    await assert.rejects(sessions.access(a), { status: 401 })
    assert.equal(await sessions.access(b), 'b@example.com')

    // เลยเพดาน 8 ชั่วโมงแล้วต้องตก ต่อให้ access token ยังไม่หมดอายุ
    clock = 8 * 3600000
    await assert.rejects(sessions.access(b), { status: 401 })

    // กวาดแล้วไฟล์ที่หมดอายุต้องหายจริง ไม่ใช่แค่ปฏิเสธตอนอ่าน
    await sessions.sweep()
    assert.equal((await readdir(sessionDir)).filter(f => f.endsWith('.json')).length, 0)
  } finally {
    await rm(sessionDir, { recursive: true, force: true })
  }
})

test('เส้นทาง HTTP บังคับล็อกอินและต้นทาง ส่วน webhook ไม่เกี่ยวกับเซสชัน', async () => {
  const sessionDir = await temp()
  const messageId = '22222222-2222-2222-2222-222222222222'
  const mediaPath = `11111111-1111-1111-1111-111111111111/${messageId}.jpg`
  const media = [{ path: mediaPath, mime: 'image/jpeg', bytes: 5 }]
  let storageReads = 0
  const upstream = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : {}
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/auth/v1/token')) {
      if (body.password !== 'correct') { res.writeHead(400); return res.end('{"msg":"bad credentials"}') }
      return res.end(JSON.stringify({ access_token: body.email, refresh_token: body.email, expires_in: 3600 }))
    }
    if (req.url.startsWith('/auth/v1/logout')) return res.end('{}')
    if (req.url === '/rest/v1/rpc/user_access_state')
      return res.end(JSON.stringify({ active: true, role: 'sales', modules: ['connect'], revoked_after: null }))
    const identity = req.headers.authorization?.slice(7)
    if (req.url === '/rest/v1/rpc/media_of') {
      assert.equal(req.headers['content-profile'], 'inbox')
      return res.end(JSON.stringify({ [messageId]: media }))
    }
    if (req.url === '/rest/v1/rpc/media_access') {
      assert.equal(req.headers['content-profile'], 'inbox')
      return res.end(JSON.stringify(body.p_path === mediaPath && identity === 'a@example.com'))
    }
    if (req.url.startsWith('/storage/v1/object/authenticated/inbox-media/')) {
      assert.equal(identity, 'mock-service')
      storageReads++
      res.setHeader('Content-Type', 'image/jpeg')
      return res.end('image')
    }
    if (['detail', 'messages'].includes(body.p_action)) return res.end(JSON.stringify({ messages: [{ id: messageId }] }))
    res.end(JSON.stringify(body.p_action === 'bootstrap' ? { user: { id: identity, email: identity }, projects: [], assignees: [], canned: [] } : []))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')

  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(r => reservation.close(r))
  const base = 'http://127.0.0.1:' + port

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), CONNECT_PUBLIC_URL: base, SESSION_DIR: sessionDir,
           SUPABASE_URL: 'http://127.0.0.1:' + upstream.address().port, SUPABASE_ANON_KEY: 'mock',
           SUPABASE_SERVICE_ROLE_KEY: 'mock-service', CONNECT_CHANNELS_FILE: '', CONNECT_SHADOW_MODE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('startup timeout')), 10000)
      child.stdout.on('data', c => { if (c.toString().includes('listening')) { clearTimeout(timeout); resolve() } })
      child.once('exit', () => { clearTimeout(timeout); reject(Error('startup failed')) })
    })
    const post = (path, data, cookie, origin = base) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(data),
    })

    assert.equal((await post('/api/command', { action: 'bootstrap', data: {} })).status, 401)
    assert.equal((await post('/api/login', { email: 'a@example.com', password: 'correct' }, null, 'https://evil.example')).status, 403)
    assert.equal((await post('/api/login', { email: 'a@example.com', password: 'wrong' })).status, 401)

    const login = await post('/api/login', { email: 'a@example.com', password: 'correct' })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]

    for (const action of ['detail', 'messages']) {
      const response = await post('/api/command', { action, data: { id: messageId } }, cookie)
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).messages[0].media, media)
    }
    assert.equal((await fetch(`${base}/media/${mediaPath}`)).status, 401)
    assert.equal(storageReads, 0)
    assert.equal((await fetch(`${base}/media/${mediaPath}`, { headers: { authorization: 'Bearer denied-user' } })).status, 403)
    assert.equal(storageReads, 0)
    for (const headers of [{ cookie }, { authorization: 'Bearer a@example.com' }]) {
      const response = await fetch(`${base}/media/${mediaPath}`, { headers })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'image')
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
    }
    assert.equal(storageReads, 2)

    // ★ ข้อพิสูจน์ว่าฐานเห็นคนจริง ไม่ใช่บัญชีกลาง: ตัวตนที่ตอบกลับมาคือ token ของคนที่ล็อกอิน
    const boot = await post('/api/command', { action: 'bootstrap', data: {} }, cookie)
    assert.equal(boot.status, 200)
    assert.equal((await boot.json()).user.id, 'a@example.com')

    assert.equal((await post('/api/logout', {}, cookie)).status, 200)
    assert.equal((await post('/api/command', { action: 'bootstrap', data: {} }, cookie)).status, 401)

    // webhook ต้องไม่ถูกลากเข้าชั้นเซสชัน — ไม่มีคุกกี้ก็ต้องไม่ตกด้วย session_expired
    const hook = await fetch(base + '/webhooks/unknown', { method: 'POST', body: '{}' })
    assert.notEqual(hook.status, 401)
    assert.notEqual((await hook.json()).error, 'session_expired')

    const page = await (await fetch(base)).text()
    assert.match(page, /id="login-form"/)
    assert.match(page, /id="workspace" hidden/)
    assert.match(page, /id="logout"/)
    assert.equal((await fetch(base + '/login.css')).status, 200)

    for (let i = 0; i < 10; i++) await post('/api/login', { email: 'blocked@example.com', password: 'wrong' })
    assert.equal((await post('/api/login', { email: 'blocked@example.com', password: 'wrong' })).status, 429)
  } finally {
    const closed = once(child, 'exit')
    child.kill()
    await closed
    upstream.closeAllConnections()
    await new Promise(r => upstream.close(r))
    await rm(sessionDir, { recursive: true, force: true })
  }
})
