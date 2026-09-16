/**
 * หน้าสถิติการตอบ — ASHER Connect
 *
 * ★ หน้านี้ไม่ได้ป้องกันอะไรเลย การซ่อนปุ่มกับการเด้งออกเป็นเรื่องความสะอาดตา
 *   ด่านจริงอยู่ที่ inbox.stats_scope() ในฐาน (manager ขึ้นไป) ถ้าใครยิง
 *   /api/command ตรง ๆ ด้วย action stats_agents ก็จะได้ 403 not_allowed กลับไป
 *
 * ★ ตัวเลขทุกตัวคำนวณในฐาน ที่นี่มีแต่การจัดหน้ากับการเรียงคำ — เหตุผลเดียวกับ
 *   reports/reply-digest.mjs คือถ้าวันไหนต้องแก้สูตร ต้องมีที่แก้ที่เดียว
 */

const $ = (id) => document.getElementById(id)

// ── คุยกับเซิร์ฟเวอร์ ────────────────────────────────────────────────
// ทางเดียวกับ app.js — POST /api/command แล้วแปล error เป็นข้อความไทย
const ERRORS = {
  not_allowed: 'หน้านี้เปิดให้เฉพาะผู้จัดการและผู้ดูแลระบบ',
  session_expired: 'เชื่อมต่อระบบหลังบ้านไม่ได้ กรุณารีเฟรชหน้า',
  request_rejected: 'ระบบสถิติยังไม่พร้อมใช้งานบนเครื่องนี้ (ยังไม่ได้ลง sql/016–019)',
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
    const err = new Error(ERRORS[body.error] || 'ดึงข้อมูลไม่สำเร็จ')
    err.code = body.error
    throw err
  }
  return body
}

// ── เวลาไทย ──────────────────────────────────────────────────────────
// ★ กรุงเทพไม่มี DST จึงบวก +07:00 ตรง ๆ ได้ ไม่ต้องพึ่ง Intl ตอนประกอบช่วงเวลา
//   แต่ตอน "วันนี้คือวันไหน" ต้องถามจากเวลาไทย ไม่ใช่เวลาเครื่อง เพราะเครื่องที่
//   ตั้งโซนผิดจะได้ช่วงเวลาเลื่อนไปทั้งหน้าโดยไม่มีอะไรบอก
const bkkToday = (shiftDays = 0) =>
  new Date(Date.now() + 7 * 3600000 + shiftDays * 86400000).toISOString().slice(0, 10)
const startOf = (ymd) => ymd + 'T00:00:00+07:00'
const endOf = (ymd) => ymd + 'T23:59:59.999+07:00'

const THAI_DATE = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number)
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  return d + ' ' + months[m - 1] + ' ' + (y + 543).toString().slice(2)
}

// ── สถานะหน้าจอ ──────────────────────────────────────────────────────
const state = { range: 'today', from: null, to: null, channel: '', project: '' }

function resolveRange() {
  const today = bkkToday()
  if (state.range === 'today') return { from: startOf(today), to: endOf(today), label: 'วันนี้ · ' + THAI_DATE(today) }
  if (state.range === '7d') {
    const start = bkkToday(-6)
    return { from: startOf(start), to: endOf(today), label: THAI_DATE(start) + ' – ' + THAI_DATE(today) }
  }
  if (state.range === 'month') {
    const start = today.slice(0, 8) + '01'
    return { from: startOf(start), to: endOf(today), label: 'เดือนนี้ · ' + THAI_DATE(start) + ' – ' + THAI_DATE(today) }
  }
  const a = $('date-from').value || today
  const b = $('date-to').value || today
  // เลือกกลับหัวมาก็ให้ใช้ได้ ไม่ต้องขึ้น error ให้เสียจังหวะ
  const [from, to] = a <= b ? [a, b] : [b, a]
  return { from: startOf(from), to: endOf(to), label: THAI_DATE(from) + ' – ' + THAI_DATE(to) }
}

const params = () => {
  const r = resolveRange()
  const p = { from: r.from, to: r.to }
  if (state.channel) p.channel = state.channel
  if (state.project) p.project = state.project
  return p
}

// ── ตัวช่วยแสดงผล ────────────────────────────────────────────────────
const el = (tag, text, cls) => {
  const e = document.createElement(tag)
  if (text !== undefined && text !== null) e.textContent = text
  if (cls) e.className = cls
  return e
}
const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('th-TH'))
const pct = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1) + '%')

// วินาที -> "4 น. 12 วิ" / "38 วิ" — นาทีอ่านง่ายกว่าวินาทีดิบเมื่อเกินหนึ่งนาที
function dur(sec) {
  if (sec === null || sec === undefined) return '—'
  const s = Math.round(Number(sec))
  if (s < 60) return s + ' วิ'
  const m = Math.floor(s / 60)
  if (m < 60) return m + ' น.' + (s % 60 ? ' ' + (s % 60) + ' วิ' : '')
  return Math.floor(m / 60) + ' ชม.' + (m % 60 ? ' ' + (m % 60) + ' น.' : '')
}

function notice(msg, isError = true) {
  const box = $('notice')
  box.hidden = !msg
  box.textContent = msg || ''
  box.className = 'notice' + (isError ? ' error' : '')
}

// ── ตัวเลขรวม ────────────────────────────────────────────────────────
function renderTiles(o) {
  const answered = Number(o.windows_answered || 0)
  // ★ สองค่านี้คำนวณที่ฐาน (within_target_pct / over_breach_pct ใน sql/027)
  //   เพราะรายงาน Telegram ต้องใช้เลขชุดเดียวกันกับหน้าจอ ถ้าคิดที่เบราว์เซอร์จะมีสองสูตร
  //   ที่ต้องแก้ให้ตรงกันตลอดไป — คิดเองไว้เป็นทางสำรองเฉพาะตอนฐานยังไม่ได้ส่งมา
  const denom = Number(o.sla_met || 0) + Number(o.sla_warn || 0) + Number(o.sla_breach || 0)
  const within = o.within_target_pct ?? (denom ? (100 * Number(o.sla_met || 0)) / denom : null)
  const over = o.over_breach_pct ?? (denom ? (100 * Number(o.sla_breach || 0)) / denom : null)

  // ป้ายบอกจำนวนนาทีตามค่าจริงใน inbox.settings ไม่ใช่เลขที่พิมพ์ค้างไว้
  // — วันที่ทีมเปลี่ยนเกณฑ์ หัวการ์ดต้องเปลี่ยนตาม ไม่งั้นจะโกหกคนอ่าน
  const warnMin = o.thresholds?.warn_minutes ?? 5
  const breachMin = o.thresholds?.breach_minutes ?? 10

  const tiles = [
    ['เคสเข้า', n(o.windows_total)],
    ['ตอบแล้ว', n(answered)],
    ['ค้างตอบ', n(o.unanswered), Number(o.unanswered) > 0 ? 'bad' : ''],
    ['เกิน SLA ตอนนี้', n(o.overdue_now), Number(o.overdue_now) > 0 ? 'bad' : ''],
    ['เวลาตอบ median', dur(o.frt_p50_sec)],
    ['เวลาตอบ p90', dur(o.frt_p90_sec)],
    ['ตอบใน ' + warnMin + ' นาที', pct(within), within !== null && within >= 80 ? 'good' : ''],
    ['เกิน ' + breachMin + ' นาที', pct(over), over !== null && over > 20 ? 'bad' : ''],
  ]

  $('tiles').replaceChildren(...tiles.map(([label, value, tone]) => {
    const box = el('div', null, 'tile' + (tone ? ' ' + tone : ''))
    box.append(el('span', label, 'tile-label'), el('strong', value, 'tile-value'))
    return box
  }))
}

// ── กราฟเคสตามชั่วโมง ────────────────────────────────────────────────
// ★ ขอ bucket 'dow_hour' แล้วยุบ dow ทิ้งเอง แทนที่จะขอ bucket ใหม่จากฐาน
//   เพราะ dow_hour มีอยู่แล้วใน sql/018 — หน้านี้จึงใช้งานได้ทันทีที่ 016–019 ลง
//   โดยไม่ต้องรอ migration ของงานนี้
function renderHours(rows) {
  const byHour = new Array(24).fill(0)
  for (const r of rows || []) byHour[Number(r.hour)] += Number(r.windows || 0)
  const max = Math.max(...byHour, 1)
  const total = byHour.reduce((a, b) => a + b, 0)

  if (!total) {
    $('hours').replaceChildren(el('p', 'ไม่มีเคสในช่วงเวลาที่เลือก', 'muted'))
    return
  }

  const W = 960, H = 200, PAD_L = 34, PAD_B = 24, PAD_T = 10
  const plotW = W - PAD_L, plotH = H - PAD_B - PAD_T
  const bw = plotW / 24
  const busiest = byHour.indexOf(max)

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'hours-svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label',
    `เคสเข้าตามชั่วโมง รวม ${total} เคส ชั่วโมงที่มากที่สุดคือ ${busiest} นาฬิกา ${max} เคส`)

  const mk = (tag, attrs, text) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
    if (text !== undefined) e.textContent = text
    return e
  }

  // เส้นอ้างอิงแนวนอน 3 เส้น พอให้กะปริมาณได้ ไม่ถึงกับต้องมีตาราง
  for (const f of [0, 0.5, 1]) {
    const y = PAD_T + plotH * (1 - f)
    svg.append(mk('line', { x1: PAD_L, y1: y, x2: W, y2: y, class: 'grid' }))
    svg.append(mk('text', { x: PAD_L - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' },
      String(Math.round(max * f))))
  }

  byHour.forEach((v, h) => {
    const bh = (v / max) * plotH
    const x = PAD_L + h * bw
    const bar = mk('rect', {
      x: x + bw * 0.15, y: PAD_T + plotH - bh,
      width: bw * 0.7, height: Math.max(bh, v ? 1.5 : 0), rx: 2,
      class: 'bar' + (h === busiest ? ' peak' : ''),
    })
    bar.append(mk('title', {}, `${String(h).padStart(2, '0')}:00 — ${v} เคส`))
    svg.append(bar)
    // ★ ติดป้ายทุก 3 ชั่วโมง ถ้าติดครบ 24 ตัวเลขจะทับกันจนอ่านไม่ออกบนจอแคบ
    if (h % 3 === 0) {
      svg.append(mk('text', { x: x + bw / 2, y: H - 8, class: 'axis', 'text-anchor': 'middle' },
        String(h).padStart(2, '0')))
    }
  })

  $('hours').replaceChildren(svg)
}

// ── อันดับคนตอบ ──────────────────────────────────────────────────────
// ★ สามกลุ่มนี้ต่างกันโดยเจตนา ไม่ใช่ข้อมูลสกปรก:
//     workspace  = ตอบผ่าน Connect มี sender_id จึงรู้ว่าใคร -> ขึ้นอันดับได้
//     page       = ตอบจาก Facebook Page โดยตรง รู้ว่ามาจากเพจ แต่ไม่รู้ว่าใคร
//     unassigned = ข้อมูลเก่าที่ยังจับไม่ได้ว่าใครตอบ
//   สองกลุ่มหลังไม่ใช่ "คน" จึงให้คะแนนหรือจัดอันดับไม่ได้ แต่ต้องแสดง ไม่ใช่ซ่อน
//   เพราะมันคือปริมาณงานที่หลุดออกนอกระบบ ซึ่งเป็นตัวเลขที่ต้องเห็น
const NO_NAME_ROW = {
  page: 'ตอบจาก Page',
  unassigned: 'ไม่ระบุชื่อ (ข้อมูลเก่า)',
  signature: 'รู้จากลายเซ็น',
}

function renderAgents(rows, weights) {
  const list = Array.isArray(rows) ? rows : []
  // ★ score มาจากฐาน (sql/027 คิดจาก inbox.score_rule) — คิดที่เดียวกับรายงาน Telegram
  //   สูตรสำรองข้างล่างไว้เผื่อกรณีฐานยังเป็นรุ่น 018 อยู่ (ยังไม่ได้ลง 027)
  const w = weights || { met: 3, warn: 2, breach: 1 }
  const scoreOf = (a) => a.score ?? (Number(a.sla_met || 0) * w.met
    + Number(a.sla_warn || 0) * w.warn + Number(a.sla_breach || 0) * w.breach)

  const people = list.filter((a) => a.responder_id).map((a) => ({ ...a, _score: scoreOf(a) }))
  const others = list.filter((a) => !a.responder_id)
  people.sort((a, b) => b._score - a._score || Number(a.frt_p50_sec ?? 1e9) - Number(b.frt_p50_sec ?? 1e9))

  const body = $('agents').querySelector('tbody')
  body.replaceChildren()

  if (!people.length && !others.length) {
    const tr = el('tr')
    const td = el('td', 'ไม่มีข้อมูลในช่วงเวลาที่เลือก', 'muted')
    td.colSpan = 5
    tr.append(td)
    body.append(tr)
    return
  }

  people.forEach((a, i) => {
    const tr = el('tr', null, i === 0 ? 'top' : '')
    tr.append(el('td', i === 0 ? '🥇 1' : String(i + 1), 'col-rank'))
    tr.append(el('td', a.name || '—'))
    tr.append(el('td', n(a.windows), 'num'))
    tr.append(el('td', dur(a.frt_p50_sec), 'num'))
    tr.append(el('td', n(a._score), 'num score'))
    body.append(tr)
  })

  for (const a of others) {
    const tr = el('tr', null, 'no-rank')
    tr.append(el('td', '—', 'col-rank'))
    tr.append(el('td', NO_NAME_ROW[a.responder_src] || a.name || 'ไม่ระบุชื่อ'))
    tr.append(el('td', n(a.windows), 'num'))
    tr.append(el('td', dur(a.frt_p50_sec), 'num'))
    tr.append(el('td', '—', 'num'))
    body.append(tr)
  }

  $('score-rule').textContent =
    `คะแนน: ตอบใน 5 นาที = ${w.met} · 5–10 นาที = ${w.warn} · เกิน 10 นาที = ${w.breach}` +
    ' — ตอบช้ายังได้คะแนน แต่ได้น้อยลง · แถวที่ไม่มีชื่อไม่เข้าการจัดอันดับ'
}

// ── โหลดทั้งหน้า ─────────────────────────────────────────────────────
let seq = 0
async function load() {
  const mine = ++seq
  const p = params()
  $('range-label').textContent = resolveRange().label
  notice('')

  try {
    const [overview, agents, hours] = await Promise.all([
      api('stats_overview', p),
      api('stats_agents', p),
      api('stats_timeline', { ...p, bucket: 'dow_hour' }),
    ])
    if (mine !== seq) return   // ผู้ใช้กดเปลี่ยนตัวกรองระหว่างรอ คำตอบเก่าต้องไม่ทับของใหม่

    renderTiles(overview || {})
    renderHours(hours)
    renderAgents(agents, overview?.score_weights)

    const gap = overview?.attribution_gap_pct
    const box = $('attribution')
    box.hidden = gap === null || gap === undefined
    if (!box.hidden) {
      // ★ ตัวเลขนี้ไม่ใช่ error — คือสัดส่วนงานที่ยังตอบนอก Connect
      //   ทีมย้ายมาตอบในระบบมากขึ้นเมื่อไหร่ ตัวเลขนี้จะลดลงเอง
      box.textContent = `ยังตอบนอกระบบ ${Number(gap).toFixed(1)}% ` +
        '— ส่วนนี้ระบุตัวคนไม่ได้ จึงไม่เข้าการจัดอันดับ'
    }
  } catch (err) {
    if (mine !== seq || err.message === 'session') return
    notice(err.message)
    $('tiles').replaceChildren()
    $('hours').replaceChildren()
    $('agents').querySelector('tbody').replaceChildren()
    $('score-rule').textContent = ''
  }
}

// ── ตัวกรอง ──────────────────────────────────────────────────────────
function selectRange(name) {
  state.range = name
  for (const b of $('range-buttons').querySelectorAll('.chip')) {
    b.classList.toggle('selected', b.dataset.range === name)
  }
  $('custom-range').hidden = name !== 'custom'
  load()
}

$('range-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('.chip')
  if (b) selectRange(b.dataset.range)
})
for (const id of ['date-from', 'date-to']) $(id).addEventListener('change', load)
$('channel').addEventListener('change', (e) => { state.channel = e.target.value; load() })
$('project').addEventListener('change', (e) => { state.project = e.target.value; load() })

// ── เริ่มทำงาน ───────────────────────────────────────────────────────
async function start() {
  let boot
  try {
    boot = await api('bootstrap')
  } catch (err) {
    notice(err.message)
    return
  }

  $('who').textContent = boot.user?.email || ''

  // ★ เด้งกลับถ้าไม่ใช่ manager/admin — เป็นแค่มารยาท ไม่ใช่การป้องกัน
  //   ถึงไม่เด้ง ทุก RPC ข้างล่างก็จะถูกฐานปฏิเสธด้วย not_allowed อยู่ดี
  if (!['manager', 'admin'].includes(boot.user?.role)) {
    notice(ERRORS.not_allowed)
    $('filters').hidden = true
    return
  }

  // ตัวเลือกโปรเจกต์มาจาก bootstrap ตัวเดียวกับหน้าแชท ไม่ได้ hardcode ชื่อไว้ที่นี่
  for (const pr of boot.projects || []) {
    const o = el('option', pr.name)
    o.value = pr.code || pr.id
    $('project').append(o)
  }

  const today = bkkToday()
  $('date-from').value = today
  $('date-to').value = today
  $('date-from').max = today
  $('date-to').max = today

  selectRange('today')
}

start()
