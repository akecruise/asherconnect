import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// ───────────────────────────────────────────────────────── เซสชันรายบุคคล
//
// คุกกี้เก็บแค่ "หมายเลขอ้างอิง" ที่สุ่มมา ไม่ได้เก็บ JWT
// ตัว access/refresh token อยู่ฝั่งเซิร์ฟเวอร์อย่างเดียว เหตุผลสามข้อ:
//   1. JWT ที่ออกไปอยู่ในเบราว์เซอร์แล้ว เรียกคืนกลางคันไม่ได้ ต่อให้ลบคุกกี้ก็ยังใช้ได้จนหมดอายุ
//      แต่หมายเลขอ้างอิงถอนได้ทันทีด้วยการลบไฟล์ — "ออกจากระบบ" จึงแปลว่าออกจริง
//   2. refresh token ต้องไม่เคยผ่านมือเบราว์เซอร์เลย มันคือกุญแจที่ต่ออายุตัวเองได้
//   3. คุกกี้มีเพดาน 4KB ส่วน JWT โตตาม claim จนชนเพดานได้
//
// ★ เก็บเป็น "ไฟล์" ไม่ใช่ในหน่วยความจำ เพราะรีสตาร์ตบริการแล้วถ้าเซสชันหายหมด
//   ทุกคนที่กำลังพิมพ์ตอบลูกค้าอยู่จะถูกเด้งออกพร้อมกันทั้งออฟฟิศ
//   การ deploy หนึ่งครั้งไม่ควรแปลว่าทุกคนต้องล็อกอินใหม่
//
// ชื่อไฟล์เป็น sha256 ของหมายเลขอ้างอิง ไม่ใช่ตัวหมายเลขเอง
// ใครอ่านโฟลเดอร์นี้ได้ก็ยังสวมเซสชันคนอื่นไม่ได้ เพราะย้อนกลับไปเป็นค่าที่ต้องใส่ในคุกกี้ไม่ได้

const TTL = 28800000          // อายุเซสชัน 8 ชั่วโมง นับจากตอนล็อกอิน ต่ออายุไม่ได้
const RENEW_BEFORE = 60000    // หมุน access token ก่อนหมดอายุหนึ่งนาที เผื่อคำขอที่กำลังเดินทาง
const RATE_WINDOW = 900000    // หน้าต่างนับความพยายามล็อกอิน 15 นาที
const RATE_PER_EMAIL = 10
const RATE_PER_IP = 60
const COOKIE = 'asher_session'

export function createSessions({ authCall, rpc, origin, log, sessionDir, authorize, now = Date.now }) {
  const refreshing = new Map(), attempts = new Map()
  const fail = (status, code) => Object.assign(new Error(code), { status })
  const hash = value => createHash('sha256').update(value).digest('hex')
  const pathOf = id => join(sessionDir, hash(id) + '.json')

  // สร้างโฟลเดอร์ครั้งเดียวตอนบูต แต่รอผลตอนใช้จริง
  // createSessions ถูกเรียกแบบไม่ await ตอนโหลดโมดูล การ mkdir จึงมาเป็นสัญญาไว้ก่อน
  const ready = mkdir(sessionDir, { recursive: true, mode: 0o700 })

  // รับเฉพาะรูปแบบที่เราออกเองเท่านั้น คุกกี้หน้าตาอื่นถือว่าไม่มี
  // กันไม่ให้ค่าที่ผู้ใช้แต่งเองกลายเป็นชื่อไฟล์ (ผ่าน hash อยู่แล้ว แต่ตัดตั้งแต่ต้นทางชัดกว่า)
  const idOf = req => {
    const value = (req.headers.cookie || '').split(';')
      .map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1)
    return value && /^[a-f0-9]{64}$/.test(value) ? value : ''
  }

  // SameSite=Lax ไม่ใช่ Strict — ทีมได้ลิงก์เข้าเคสทาง LINE/Telegram จากตัวแจ้งเตือน
  // ถ้าเป็น Strict คุกกี้จะไม่ถูกส่งตอนกดลิงก์จากแอปอื่น คนที่ล็อกอินค้างอยู่จะเจอหน้า login
  // ด่านกัน CSRF ไม่ได้อยู่ที่ตรงนี้อยู่แล้ว แต่อยู่ที่ checkOrigin ซึ่งบังคับทุกคำขอที่เปลี่ยนข้อมูล
  const setCookie = (res, value, maxAge) =>
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
      (origin.startsWith('https:') ? '; Secure' : ''))

  const read = async id => {
    await ready
    try { return JSON.parse(await readFile(pathOf(id), 'utf8')) } catch { return null }
  }

  // เขียนลงไฟล์ชั่วคราวก่อนแล้วค่อยสลับชื่อ
  // เขียนทับตรง ๆ แล้วไฟดับกลางทาง จะได้ไฟล์ครึ่งใบที่ JSON.parse ไม่ผ่าน = เซสชันหายทั้งที่ยังไม่หมดอายุ
  const write = async (id, data) => {
    await ready
    const target = pathOf(id), temp = target + '.' + randomBytes(6).toString('hex')
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
    await rename(temp, target)
  }

  const drop = async id => { await ready; await unlink(pathOf(id)).catch(() => {}) }

  // ถอน token ฝั่ง gotrue ด้วย แต่ถอนไม่สำเร็จก็ยังถือว่าออกจากระบบแล้ว เพราะไฟล์เซสชันหายไปแล้ว
  const revoke = async s => {
    if (!s?.access_token) return
    try { await authCall('/auth/v1/logout?scope=local', { method: 'POST', token: s.access_token }) }
    catch (e) { log.warn('session_revoke_failed', { reason: e.message }) }
  }

  /**
   * หมุน access token โดยให้คำขอที่มาพร้อมกันรอผลของตัวแรก
   *
   * refresh token ใช้ได้ครั้งเดียว ถ้าสองคำขอของคนเดียวกันต่างคนต่างหมุน
   * ตัวที่สองจะยื่นใบที่ถูกใช้ไปแล้ว แล้ว gotrue จะตอบ 400 ซึ่งแปลว่าเซสชันตายทั้งที่ยังดีอยู่
   * หน้าเว็บยิงหลายคำขอพร้อมกันตอนเปิด อาการนี้จึงเจอทุกครั้งที่รีเฟรช ไม่ใช่นาน ๆ ครั้ง
   *
   * ★ ตัวคุมคือ Map ในหน่วยความจำ จึงคุมได้ภายในโพรเซสเดียว — บริการนี้ต้องรันสำเนาเดียว
   *   ถ้าวันหนึ่งขยายเป็นหลายสำเนา ต้องย้ายตัวคุมนี้ลงฐานก่อน ไม่ใช่แค่แชร์โฟลเดอร์เซสชันกัน
   */
  const refresh = (id, s) => {
    let pending = refreshing.get(id)
    if (!pending) {
      pending = authCall('/auth/v1/token?grant_type=refresh_token',
        { method: 'POST', body: { refresh_token: s.refresh_token } })
        .then(async next => {
          const updated = { ...s, access_token: next.access_token, refresh_token: next.refresh_token,
                            expires: now() + next.expires_in * 1000 }
          await write(id, updated)
          return updated
        })
        .catch(async e => { await drop(id); throw e })
      refreshing.set(id, pending)
      pending.finally(() => refreshing.delete(id)).catch(() => {})
    }
    return pending
  }

  /**
   * คืน access token ของคนที่ถือคุกกี้ใบนี้ — ทุกคำสั่งจากหน้าเว็บต้องผ่านตรงนี้ก่อน
   *
   * ทุกทางที่ลงเอยว่า "ไม่มีเซสชันที่ใช้ได้" ต้องได้ session_expired เหมือนกันหมด
   * หน้าเว็บดูรหัสนี้ตัวเดียวแล้วเด้งกลับหน้า login ไม่ต้องแยกว่าคุกกี้หาย ไฟล์หาย หรือหมดอายุ
   */
  async function access(req) {
    const id = idOf(req)
    if (!id) throw fail(401, 'session_expired')
    const s = await read(id)
    if (!s) throw fail(401, 'session_expired')
    if (s.deadline <= now()) { await drop(id); throw fail(401, 'session_expired') }
    if (authorize && !(await authorize(s))) { await drop(id); throw fail(401, 'session_expired') }
    if (s.expires > now() + RENEW_BEFORE) return s.access_token
    try { return (await refresh(id, s)).access_token }
    catch { throw fail(401, 'session_expired') }
  }

  function rateLimit(req, email) {
    for (const [k, v] of attempts) if (v.until <= now()) attempts.delete(k)
    // ★ หลัง Caddy ทุกคำขอมาจาก 127.0.0.1 หมด ถังราย IP จึงเป็นถังรวมของทั้งบริษัท ไม่ใช่ของรายคน
    //   ตัวที่กันเดารหัสผ่านจริง ๆ คือถังรายอีเมล ถัง IP เหลือไว้กันการยิงรัวเฉย ๆ จึงตั้งไว้สูง
    const keys = ['email:' + hash(email), 'ip:' + (req.socket?.remoteAddress || 'unknown')]
    for (const k of keys) {
      const a = attempts.get(k)
      if (a && a.count >= (k.startsWith('ip:') ? RATE_PER_IP : RATE_PER_EMAIL)) throw fail(429, 'too_many_attempts')
    }
    if (attempts.size > 10000) throw fail(503, 'service_unavailable')
    for (const k of keys) {
      const a = attempts.get(k) || { count: 0, until: now() + RATE_WINDOW }
      a.count++
      attempts.set(k, a)
    }
  }

  async function login(req, res, input) {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (!email || email.length > 254 || typeof input.password !== 'string' ||
        !input.password || input.password.length > 1024) throw fail(400, 'invalid_credentials')
    rateLimit(req, email)

    let s
    // รหัสผ่านผิดกับบัญชีที่ไม่มีอยู่ต้องแยกจากกันไม่ได้จากฝั่งผู้ใช้ ไม่งั้นกลายเป็นเครื่องมือเดาอีเมล
    try { s = await authCall('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: input.password } }) }
    catch (e) {
      log.warn('login_rejected', { reason: e.message, status: e.status ?? null })
      throw fail(401, 'invalid_credentials')
    }

    // ด่านที่สอง: มีตัวตนแล้วยังต้องมีโปรไฟล์ที่ใช้ระบบนี้ได้ด้วย
    // คนที่มีบัญชี Supabase แต่ไม่มีแถวใน core.profile จะตกตรงนี้ ไม่ใช่ตกตอนกดปุ่มแรกในหน้าจอ
    // ถ้าตกแล้วต้องคืน token ทิ้งด้วย ไม่งั้น gotrue จะค้างเซสชันของคนที่เราเพิ่งปฏิเสธไป
    let boot
    try {
      boot = await rpc(s.access_token, 'bootstrap')
      if (!boot?.user?.id) throw fail(403, 'not_allowed')
    } catch (e) { await revoke(s); throw e }

    // ล็อกอินซ้ำจากเบราว์เซอร์เดิม = ทิ้งใบเก่าก่อนเสมอ ไม่ปล่อยให้เหลือไฟล์ที่ไม่มีใครถืออยู่
    const old = idOf(req)
    if (old) { await revoke(await read(old)); await drop(old) }

    const id = randomBytes(32).toString('hex')
    await write(id, { user_id: s.user?.id ?? boot.user.id, issued_at: now(),
                      access_token: s.access_token, refresh_token: s.refresh_token,
                      expires: now() + s.expires_in * 1000, deadline: now() + TTL })
    setCookie(res, id, TTL / 1000)
    log.info('signed_in', { email })
    return { ok: true }
  }

  async function logout(req, res) {
    const id = idOf(req)
    const s = id ? await read(id) : null
    if (id) await drop(id)
    setCookie(res, '', 0)
    await revoke(s)
    return { ok: true }
  }

  // เซสชันที่หมดอายุแล้วไม่มีใครมาลบให้ เพราะเจ้าของไม่กลับมาอีก
  // ปล่อยไว้ = โฟลเดอร์โตขึ้นเรื่อย ๆ และเหลือ refresh token ที่ยังใช้ได้นอนอยู่ในดิสก์
  async function sweep() {
    await ready
    let deleted = 0
    for (const file of await readdir(sessionDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      const full = join(sessionDir, file)
      try {
        const s = JSON.parse(await readFile(full, 'utf8'))
        if (s.deadline < now()) { await unlink(full); deleted++ }
      } catch (e) {
        log.warn('session_sweep_skipped', { reason: e.message })
      }
    }
    return { deleted }
  }

  async function revokeUser(userId) {
    await ready
    let globalToken = null
    for (const file of await readdir(sessionDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
      const full = join(sessionDir, file)
      try {
        const s = JSON.parse(await readFile(full, 'utf8'))
        if (s.user_id !== userId) continue
        globalToken ||= s.access_token
        await unlink(full)
      } catch (e) { log.warn('user_session_revoke_skipped', { reason: e.message }) }
    }
    if (globalToken) {
      try { await authCall('/auth/v1/logout?scope=global', { method: 'POST', token: globalToken }) }
      catch (e) { log.warn('user_global_revoke_failed', { reason: e.message }) }
    }
  }

  return { access, login, logout, sweep, revokeUser }
}
