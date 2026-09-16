/**
 * หน้า log ระบบ — ASHER Connect
 *
 * ★ หน้านี้ไม่ได้ป้องกันอะไรเลย การซ่อนปุ่มเป็นเรื่องความสะอาดตา
 *   ด่านจริงอยู่ที่ inbox.stats_scope('admin') ในฐาน — log มีข้อความลูกค้าดิบ
 *   ใครยิง /api/command ตรง ๆ ด้วย logs_timeline ก็จะได้ 403 กลับไป
 *
 * ★ การรวมสี่แหล่ง (ของดิบ / การตัดสินใจ / งานขาออก / ข้อความ) ทำในฐาน
 *   ที่นี่มีแต่การจัดหน้า — ถ้าวันไหนต้องแก้นิยาม ต้องมีที่แก้ที่เดียว
 *
 * ★ ทุกอย่างวาดด้วย DOM API ไม่ใช่ innerHTML เพราะแถวมีข้อความลูกค้าดิบอยู่จริง
 */

const $ = (id) => document.getElementById(id)

const ERRORS = {
  not_allowed: 'หน้านี้เปิดให้เฉพาะผู้ดูแลระบบ',
  session_expired: 'เชื่อมต่อระบบหลังบ้านไม่ได้ กรุณารีเฟรชหน้า',
  request_rejected: 'ระบบ log ยังไม่พร้อมบนเครื่องนี้ (ยังไม่ได้ลง sql/029_logs_api.sql)',
  service_unavailable: 'เชื่อมต่อระบบไม่ได้ กรุณาลองใหม่',
}

async function api(action, data = {}) {
  const res = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) { location.replace('/'); throw new Error('session') }
    const err = new Error(ERRORS[body.error] || 'ดึง log ไม่สำเร็จ')
    err.code = body.error
    throw err
  }
  return body
}

// ── สถานะของหน้า ─────────────────────────────────────────────────────
const state = {
  range: '24h',
  sources: ['webhook', 'decision', 'job', 'message'],
  level: 'all',
  search: '',
  timer: null,
}

const HOURS = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }
const fromISO = () => new Date(Date.now() - HOURS[state.range] * 3600000).toISOString()

// ── คำแปล ────────────────────────────────────────────────────────────
const SOURCE_TH = {
  webhook: 'ของดิบเข้า',
  decision: 'ตัดสินใจ',
  job: 'งานขาออก',
  message: 'ข้อความ',
}

// เหตุผลที่ฐานคืนมาเป็นรหัส — แปลให้คนอ่านรู้เรื่อง ไม่ต้องจำรหัส
// ตัวที่ไม่รู้จักแสดงรหัสดิบไปตรง ๆ ดีกว่าซ่อนว่ามีเหตุผลที่เราไม่ได้แปล
const REASON_TH = {
  convo_mode_human: 'แชทนี้ตั้งให้คนตอบ',
  human_owns_convo: 'ทีมเพิ่งตอบแชทนี้',
  outside_schedule_silent: 'นอกตารางบอท (กลางวัน ทีมตอบเอง)',
  outside_schedule_ack: 'นอกตาราง ตอบรับสั้น ๆ',
  attachment_only: 'ส่งมาแต่ไฟล์แนบ',
  not_thread_owner: 'แอปอื่นถือแชทนี้อยู่ (standby)',
  reply_disabled: 'ปิดการตอบไว้',
  immediate: 'ตอบทันที',
  admin_bypass: 'แอดมิน ตอบทันที',
  no_notify_target: 'ยังไม่ได้ตั้งปลายทางแจ้ง',
  no_target: 'ไม่มีปลายทาง',
  recently_notified: 'เพิ่งแจ้งไปแล้ว',
  no_repeat: 'แจ้งครั้งเดียว ไม่เตือนซ้ำ',
  new_chat: 'แชทใหม่',
  bot_silent_new: 'แชทใหม่และบอทเงียบ',
  lead: 'ได้เบอร์/LINE',
  human_replied: 'คนตอบไปแล้ว',
  bot_already_replied: 'บอทตอบไปแล้ว',
  anthropic_key_missing: 'ยังไม่ได้ตั้งคีย์ Anthropic',
}
const reasonTH = (r) => REASON_TH[r] || r

// เวลาไทย — กรุงเทพไม่มี DST จึงบวก +07:00 ตรง ๆ ได้
const timeTH = (iso) => {
  const d = new Date(new Date(iso).getTime() + 7 * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}
const dateTH = (iso) => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(5, 10)

// ── วาดสรุปหัวจอ ─────────────────────────────────────────────────────
function card(label, value, tone) {
  const box = document.createElement('div')
  box.className = 'card' + (tone ? ' is-' + tone : '')
  const v = document.createElement('b')
  v.textContent = String(value)
  const l = document.createElement('small')
  l.textContent = label
  box.append(v, l)
  return box
}

function drawCards(s) {
  const el = $('cards')
  el.replaceChildren(
    card('ของดิบเข้ามา', s.webhook_total),
    card('รับไม่สำเร็จ', s.webhook_failed, s.webhook_failed > 0 ? 'bad' : null),
    card('ข้อความที่เก็บ', s.messages),
    card('บอทเงียบ', s.bot_silent, s.bot_silent > 0 ? 'warn' : null),
    card('งานส่งสำเร็จ', s.job_done),
    card('งานถูกข้าม', s.job_skipped, s.job_skipped > 0 ? 'warn' : null),
    card('งานล้มเหลว', s.job_failed, s.job_failed > 0 ? 'bad' : null),
    card('งานค้างคิว', s.job_pending, s.job_pending > 0 ? 'warn' : null),
  )
}

function drawReasons(s) {
  const el = $('reasons')
  const silent = s.top_silent_reasons || []
  const skip = s.top_skip_reasons || []
  if (!silent.length && !skip.length) { el.hidden = true; return }
  el.hidden = false
  el.replaceChildren()

  const group = (title, rows) => {
    if (!rows.length) return null
    const box = document.createElement('div')
    box.className = 'reason-group'
    const h = document.createElement('h3')
    h.textContent = title
    box.append(h)
    for (const r of rows) {
      const line = document.createElement('div')
      line.className = 'reason'
      const n = document.createElement('span')
      n.className = 'reason-n'
      n.textContent = r.n
      const t = document.createElement('span')
      t.textContent = reasonTH(r.reason)
      line.append(n, t)
      box.append(line)
    }
    return box
  }
  const a = group('ทำไมบอทเงียบ', silent)
  const b = group('ทำไมงานถูกข้าม', skip)
  el.replaceChildren(...[a, b].filter(Boolean))
}

// ── วาดเส้นเวลา ──────────────────────────────────────────────────────
function drawRows(rows) {
  const tbody = $('rows')
  tbody.replaceChildren()
  $('empty').hidden = rows.length > 0

  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.className = 'lv-' + r.level

    const time = document.createElement('td')
    time.className = 'c-time'
    const t = document.createElement('b')
    t.textContent = timeTH(r.at)
    const d = document.createElement('small')
    d.textContent = dateTH(r.at)
    time.append(t, d)

    const src = document.createElement('td')
    src.className = 'c-src'
    const tag = document.createElement('span')
    tag.className = 'tag tag-' + r.source
    tag.textContent = SOURCE_TH[r.source] || r.source
    src.append(tag)

    const ch = document.createElement('td')
    ch.className = 'c-ch'
    ch.textContent = r.channel || '—'

    const title = document.createElement('td')
    title.className = 'c-title'
    // หัวข้อของแถว decision มาในรูป "บอทเงียบ: <รหัส>" — แปลรหัสให้อ่านรู้เรื่อง
    title.textContent = String(r.title || '').replace(/^บอทเงียบ: (.+)$/, (_, c) => 'บอทเงียบ: ' + reasonTH(c))

    const detail = document.createElement('td')
    detail.className = 'c-detail'
    detail.textContent = r.detail || ''

    // กดแถวเพื่อดูของดิบ — ไม่ต้องไปคิวรีฐานเอง
    if (r.extra && Object.keys(r.extra).length) {
      tr.classList.add('has-more')
      tr.tabIndex = 0
      const open = () => {
        const next = tr.nextElementSibling
        if (next && next.classList.contains('extra')) { next.remove(); return }
        const er = document.createElement('tr')
        er.className = 'extra'
        const td = document.createElement('td')
        td.colSpan = 5
        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(r.extra, null, 2)
        td.append(pre)
        er.append(td)
        tr.after(er)
      }
      tr.addEventListener('click', open)
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } })
    }

    tr.append(time, src, ch, title, detail)
    tbody.append(tr)
  }
}

// ── โหลด ─────────────────────────────────────────────────────────────
let inflight = false
async function load() {
  if (inflight) return
  inflight = true
  const p = { from: fromISO(), sources: state.sources, level: state.level, search: state.search, limit: 300 }
  try {
    const [summary, timeline] = await Promise.all([
      api('logs_summary', p),
      api('logs_timeline', p),
    ])
    $('error').hidden = true
    drawCards(summary)
    drawReasons(summary)
    drawRows(timeline.rows || [])
    $('count').textContent = `${timeline.count} รายการ` +
      (timeline.problems ? ` · สะดุด ${timeline.problems}` : '')
  } catch (e) {
    if (e.message === 'session') return
    $('error').hidden = false
    $('error').textContent = e.message
    $('rows').replaceChildren()
    $('empty').hidden = true
  } finally {
    inflight = false
  }
}

// ── ต่อสายปุ่ม ───────────────────────────────────────────────────────
function wire() {
  for (const b of document.querySelectorAll('[data-range]')) {
    b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('[data-range]')) o.classList.toggle('is-on', o === b)
      state.range = b.dataset.range
      load()
    })
  }

  for (const c of document.querySelectorAll('.src')) {
    c.addEventListener('change', () => {
      state.sources = [...document.querySelectorAll('.src')].filter(x => x.checked).map(x => x.value)
      load()
    })
  }

  $('level-all').addEventListener('click', () => {
    state.level = 'all'
    $('level-all').classList.add('is-on'); $('level-problem').classList.remove('is-on')
    load()
  })
  $('level-problem').addEventListener('click', () => {
    state.level = 'problem'
    $('level-problem').classList.add('is-on'); $('level-all').classList.remove('is-on')
    load()
  })

  // หน่วงพิมพ์ ไม่ยิงฐานทุกตัวอักษร
  let typing
  $('search').addEventListener('input', (e) => {
    clearTimeout(typing)
    typing = setTimeout(() => { state.search = e.target.value.trim(); load() }, 350)
  })

  $('refresh').addEventListener('click', load)

  $('auto').addEventListener('change', (e) => {
    clearInterval(state.timer)
    state.timer = e.target.checked ? setInterval(load, 15000) : null
  })

  // ออกจากหน้าแล้วต้องไม่ยิงต่อ
  addEventListener('pagehide', () => clearInterval(state.timer))
}

api('bootstrap').then(b => { if (b?.user?.name) $('who').textContent = b.user.name }).catch(() => {})
wire()
load()
