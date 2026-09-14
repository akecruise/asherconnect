/**
 * Phase 7 — รายงานการตอบแชท
 *
 *   node --test tests/report.test.mjs
 *
 * ★ วิธีพิสูจน์: สร้างข้อมูลหนึ่งวันที่รู้คำตอบอยู่แล้ว แล้วเทียบสองทาง
 *     ทางที่ 1  inbox.reply_report()  — คำนวณในฐาน (ของจริงที่จะใช้)
 *     ทางที่ 2  นับใหม่ใน JS จากแถวดิบ — เขียนขึ้นใหม่อิสระในไฟล์นี้
 *   ต้องตรงกันทุกตัวเลข ไม่ใช่แค่ "ดูสมเหตุสมผล"
 *
 * ★ ที่มาของนิยามที่ทางที่ 2 ใช้ — reply_stats() ใน cloud (01_schedule_and_report.sql)
 *     "รอบถาม" = ข้อความลูกค้าที่ข้อความก่อนหน้าไม่ใช่ลูกค้า
 *     "เวลาตอบ" = จากรอบถาม → ข้อความแรกจากฝั่งเราหลังจากนั้น
 *     มองย้อนหลัง 2 วัน เพราะคำถามเมื่อวานอาจเพิ่งถูกตอบวันนี้
 *   บวกข้อที่ sendReplyDigest() เพิ่ม: รอบที่ยังไม่มีใครตอบต้องนับด้วย
 *
 * ⚠️ reference/fbline_report_TG.ts (ที่ PLAN ให้เทียบกับ loadReportData) ยังหาไม่เจอ
 *   ทางที่ 2 จึงเขียนจากนิยามใน reply_stats ของ cloud ซึ่งเป็นตรรกะเดียวกันที่เป็นลายลักษณ์อักษร
 *   ถ้าได้ไฟล์นั้นมา ให้เอา loadReportData มาแทนทางที่ 2 แล้วเทสต์ต้องยังผ่าน
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildDailyDigest, fmtMin, chunkText, thDate } from '../reports/reply-digest.mjs'

const run = promisify(execFile)
const TAG = '__reporttest__'
const DAY = '2026-03-05'          // วันที่ตายตัวในอดีต ไม่ชนกับข้อมูลอื่น
const TZ = '+07'

async function sql(text) {
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', text], { maxBuffer: 16 << 20 })
  return stdout.trim().split('\n').filter(Boolean).map(l => l.split('|'))
}
const one = async t => (await sql(t))[0]?.[0] ?? null
const at = (h, m = 0, day = DAY) => `${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${TZ}`

// ── ฉากหนึ่งวัน: FB + LINE + รอบค้าง + LINE fallback + รอบข้ามวัน ────────────
async function setup() {
  await teardown()
  const project = await one(`select id from core.project where code='asher-naii'`)
  const agent = await one(`select id from auth.users where email='sales.a.test@asher.local'`)

  const mk = async (channel, name) => one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
    values('${channel}','${project}','${name} ${TAG}','TEST_ONLY',true) returning id`)
  const fb = await mk('messenger', 'FB')
  const line = await mk('line', 'LINE')

  const conv = async (inbox, key, display) => {
    const contact = await one(`select core.resolve_identity(
      (select channel from inbox.inbox where id='${inbox}'),'U-${TAG}-${key}','${inbox}','${display}','${project}')`)
    return one(`insert into inbox.conversation(inbox_id,contact_id,status) values('${inbox}','${contact}','open') returning id`)
  }
  const say = (c, who, text, when, sender = null) =>
    sql(`insert into inbox.message(conversation_id,sender_type,sender_id,content,created_at)
         values('${c}','${who}',${sender ? `'${sender}'` : 'null'},'${text.replace(/'/g, "''")}','${when}')`)

  // 1. FB — ลูกค้าพิมพ์ติดกันสามข้อความ (นับรอบเดียว) แล้วบอทตอบใน 2 นาที
  const a = await conv(fb, 'a', `ลูกค้า A ${TAG}`)
  await say(a, 'contact', 'สวัสดีค่ะ', at(9, 0))
  await say(a, 'contact', 'สนใจห้อง', at(9, 1))
  await say(a, 'contact', 'ราคาเท่าไหร่', at(9, 2))
  await say(a, 'bot', 'เริ่ม 2.39 ลบ. ค่ะ', at(9, 4))

  // 2. FB — คนตอบ แต่ช้ากว่า 30 นาที
  const b = await conv(fb, 'b', `ลูกค้า B ${TAG}`)
  await say(b, 'contact', 'ผ่อนเดือนละเท่าไหร่', at(10, 0))
  await say(b, 'agent', 'ประมาณ 6,900 ค่ะ', at(10, 45), agent)

  // 3. LINE — บอทตอบใน 1 นาที
  const c = await conv(line, 'c', `ลูกค้า C ${TAG}`)
  await say(c, 'contact', 'ห้องว่างไหม', at(11, 0))
  await say(c, 'bot', 'ยังมีค่ะ', at(11, 1))

  // 4. LINE — ไม่มีใครตอบเลย
  const d = await conv(line, 'd', `ลูกค้า D ${TAG}`)
  await say(d, 'contact', 'ขอผังห้องหน่อยค่ะ', at(21, 14))

  // 5. LINE fallback — ไม่มีข้อความตอบ แต่มีบันทึกว่าคนตอบแล้ว (ทีมตอบจาก chat.line.biz)
  const e = await conv(line, 'e', `ลูกค้า E ${TAG}`)
  await say(e, 'contact', 'นัดดูห้องได้ไหมคะ', at(13, 0))
  await sql(`update inbox.conversation set last_human_reply_at='${at(13, 20)}' where id='${e}'`)

  // 6. FB — ถามเมื่อวาน เพิ่งตอบวันนี้ (รอบนี้ต้องนับเข้าวันนี้ ไม่ใช่เมื่อวาน)
  const f = await conv(fb, 'f', `ลูกค้า F ${TAG}`)
  await say(f, 'contact', 'ถามไว้ตั้งแต่เมื่อวาน', at(22, 30, '2026-03-04'))
  await say(f, 'agent', 'ขอโทษที่ตอบช้าค่ะ', at(8, 0), agent)

  return { fb, line, agent }
}

async function teardown() {
  await sql(`
    begin;
    create temp table _c on commit drop as
      select c.id from inbox.conversation c join inbox.inbox i on i.id=c.inbox_id where i.name like '%${TAG}%';
    create temp table _ct on commit drop as
      select distinct contact_id as id from core.contact_identity where external_id like '%${TAG}%';
    delete from connect_private.job where conversation_id in (select id from _c)
       or inbox_id in (select id from inbox.inbox where name like '%${TAG}%');
    delete from inbox.human_reply_events where conversation_id in (select id from _c);
    delete from inbox.bot_decisions where conversation_id in (select id from _c);
    delete from inbox.message_intents where conversation_id in (select id from _c);
    delete from connect_private.delivery d using inbox.message m
      where d.message_id=m.id and m.conversation_id in (select id from _c);
    delete from connect_private.case_state where conversation_id in (select id from _c);
    delete from crm.activity where conversation_id in (select id from _c);
    delete from core.event_log where entity_id in (select id from _c);
    delete from inbox.message where conversation_id in (select id from _c);
    delete from inbox.conversation where id in (select id from _c);
    delete from crm.lead where contact_id in (select id from _ct);
    delete from core.contact_identity where external_id like '%${TAG}%';
    delete from core.contact where id in (select id from _ct);
    delete from inbox.bot_config where inbox_id in (select id from inbox.inbox where name like '%${TAG}%');
    delete from inbox.bot_schedule where inbox_id in (select id from inbox.inbox where name like '%${TAG}%');
    delete from inbox.sales_staff_kpi_daily where report_date='${DAY}';
    delete from inbox.inbox where name like '%${TAG}%';
    commit;`)
}

// ── ทางที่ 2: นับใหม่ใน JS จากแถวดิบ ───────────────────────────────────────
//    ห้ามเรียกฟังก์ชันฝั่งฐานเด็ดขาด ไม่งั้นเป็นการเทียบของกับตัวมันเอง
async function countInJs(day) {
  const from = new Date(`${day}T00:00:00+07:00`).getTime()
  const to = from + 86400000
  const lookback = from - 2 * 86400000

  const rows = await sql(`select m.conversation_id, extract(epoch from m.created_at)*1000, m.sender_type,
                                 coalesce(m.sender_id::text,''), replace(m.content, '|', ' '),
                                 i.channel, coalesce(ct.display_name,''),
                                 coalesce(extract(epoch from c.last_human_reply_at)*1000, 0)
                            from inbox.message m
                            join inbox.conversation c on c.id=m.conversation_id
                            join inbox.inbox i on i.id=c.inbox_id
                            join core.contact ct on ct.id=c.contact_id
                           where i.name like '%${TAG}%'
                             and m.sender_type in ('contact','agent','bot')
                           order by m.conversation_id, m.created_at, m.id`)

  const staff = Object.fromEntries((await sql(
    `select u.id::text, u.email from core."user" u`)).map(r => [r[0], r[1]]))

  const byConv = new Map()
  for (const [conv, ms, sender, senderId, content, channel, name, humanAt] of rows) {
    if (!byConv.has(conv)) byConv.set(conv, { channel, name, humanAt: Number(humanAt), msgs: [] })
    byConv.get(conv).msgs.push({ at: Number(ms), sender, senderId, content })
  }

  const episodes = []
  for (const [conv, c] of byConv) {
    const msgs = c.msgs.filter(m => m.at >= lookback && m.at < to)
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.sender !== 'contact') continue
      if (i > 0 && msgs[i - 1].sender === 'contact') continue      // พิมพ์ติดกัน = รอบเดียว
      const answer = msgs.slice(i + 1).find(x => x.sender === 'agent' || x.sender === 'bot')
      let answeredAt = answer?.at ?? null
      let responder = null
      let fallback = false
      if (answer) {
        responder = answer.sender === 'bot' ? 'bot' : (staff[answer.senderId] ?? 'unknown')
      } else if (c.humanAt > m.at) {
        answeredAt = c.humanAt; responder = 'unknown'; fallback = true
      }
      const inWindow = answeredAt !== null
        ? (answeredAt >= from && answeredAt < to)
        : (m.at >= from && m.at < to)
      if (!inWindow) continue
      episodes.push({ conv, channel: c.channel, name: c.name, askedAt: m.at, text: m.content,
                      answeredAt, responder, fallback,
                      minutes: answeredAt === null ? null : (answeredAt - m.at) / 60000 })
    }
  }

  const human = episodes.filter(e => e.responder && e.responder !== 'bot')
  const avg = xs => xs.length ? Math.round((xs.reduce((s, e) => s + e.minutes, 0) / xs.length) * 10) / 10 : null
  const median = xs => {
    if (!xs.length) return null
    const v = xs.map(e => e.minutes).sort((a, b) => a - b)
    const mid = v.length / 2
    return Math.round((v.length % 2 ? v[Math.floor(mid)] : (v[mid - 1] + v[mid]) / 2) * 10) / 10
  }
  const stat = list => ({
    asked: list.length,
    human_first: list.filter(e => e.responder && e.responder !== 'bot').length,
    bot_first: list.filter(e => e.responder === 'bot').length,
    unanswered: list.filter(e => e.answeredAt === null).length,
    human_avg_min: avg(list.filter(e => e.responder && e.responder !== 'bot')),
    human_median_min: median(list.filter(e => e.responder && e.responder !== 'bot')),
    bot_avg_min: avg(list.filter(e => e.responder === 'bot')),
    over30: list.filter(e => e.responder && e.responder !== 'bot' && e.minutes > 30).length,
  })

  const channels = [...new Set(episodes.map(e => e.channel))].sort()
  return {
    total: stat(episodes),
    platforms: channels.map(ch => ({ channel: ch, ...stat(episodes.filter(e => e.channel === ch)) })),
    line_fallback: episodes.filter(e => e.fallback).length,
    pending: episodes.filter(e => e.answeredAt === null).sort((a, b) => a.askedAt - b.askedAt).slice(0, 8),
    people: [...new Set(human.map(e => e.responder))].sort().map(r => ({
      responder: r, first_responses: human.filter(e => e.responder === r).length,
    })),
  }
}

// ── เทสต์ ──────────────────────────────────────────────────────────────────
let scene, fromDb, fromJs

test('เตรียมฉากหนึ่งวัน แล้วอ่านผลทั้งสองทาง', async () => {
  scene = await setup()
  fromDb = JSON.parse(await one(`select inbox.reply_report('${DAY}')`))
  fromJs = await countInJs(DAY)
  assert.equal(fromDb.date, DAY)
})

test('ยอดรวมตรงกันทุกตัว', () => {
  const keys = ['asked','human_first','bot_first','unanswered','human_avg_min','human_median_min','bot_avg_min','over30']
  for (const k of keys) {
    const db = fromDb.total[k] === null ? null : Number(fromDb.total[k])
    const js = fromJs.total[k] === null ? null : Number(fromJs.total[k])
    assert.equal(db, js, `${k}: ฐานได้ ${db} · นับใหม่ได้ ${js}`)
  }
})

test('ตัวเลขที่รู้คำตอบล่วงหน้าอยู่แล้ว', () => {
  // 6 รอบ: A(บอท) B(คน ช้า) C(บอท) D(ค้าง) E(fallback) F(ข้ามวัน คน)
  assert.equal(fromDb.total.asked, 6)
  assert.equal(fromDb.total.bot_first, 2)
  assert.equal(fromDb.total.human_first, 3)     // B + E(fallback) + F
  assert.equal(fromDb.total.unanswered, 1)      // D
  // B รอ 45 นาที และ F รอข้ามวัน 570 นาที — ทั้งคู่เกิน 30 นาที
  // (ตอนเขียนคาดไว้ว่าเป็น 1 เพราะลืมนับ F ทั้งฐานและตัวนับอิสระตรงกันว่าเป็น 2)
  assert.equal(fromDb.total.over30, 2)
  assert.equal(fromDb.line_fallback, 1)         // E
})

test('ลูกค้าพิมพ์ติดกันสามข้อความ นับเป็นรอบเดียว', () => {
  // ถ้านับเป็นสามรอบ ยอด asked จะเป็น 8 ไม่ใช่ 6 และเวลาเฉลี่ยจะเพี้ยนทันที
  assert.equal(fromDb.total.asked, 6)
  assert.equal(fromJs.total.asked, 6)
})

test('รอบที่ถามเมื่อวานแต่เพิ่งตอบวันนี้ นับเข้าวันนี้', () => {
  const yesterday = JSON.parse(null ?? 'null')   // กันเผลอ
  assert.equal(yesterday, null)
  // F ถาม 04 มี.ค. 22:30 ตอบ 05 มี.ค. 08:00 → ต้องอยู่ในรายงานวันที่ 5
  assert.equal(fromDb.total.human_first, fromJs.total.human_first)
  assert.equal(fromDb.total.human_first, 3)
})

test('แยกตามช่องทางตรงกันทุกช่อง', () => {
  assert.deepEqual(fromDb.platforms.map(p => p.channel), fromJs.platforms.map(p => p.channel))
  for (const p of fromDb.platforms) {
    const js = fromJs.platforms.find(x => x.channel === p.channel)
    for (const k of ['asked','human_first','bot_first','unanswered','over30']) {
      assert.equal(Number(p[k]), Number(js[k]), `${p.channel}.${k}`)
    }
  }
})

test('รายการค้างตรงกัน และเรียงตามเวลาที่ถาม', () => {
  assert.equal(fromDb.pending.length, fromJs.pending.length)
  assert.equal(fromDb.pending[0].at, '21:14')
  assert.equal(fromDb.pending[0].channel, 'line')
  assert.equal(fromDb.pending[0].name.includes(TAG), true)
})

test('LINE fallback ถูกนับแยก ไม่กลืนหายไปในตัวเลขรวม', () => {
  // ถ้าไม่แยก ทีมจะเข้าใจว่าเวลาตอบนี้วัดจากคำตอบจริง ทั้งที่วัดจากบันทึกว่า "ตอบแล้ว"
  assert.equal(fromDb.line_fallback, fromJs.line_fallback)
  assert.equal(fromDb.line_fallback, 1)
})

test('สถิติรายคนคำนวณสดได้เมื่อยังไม่มีของที่เก็บไว้', () => {
  const names = fromDb.people.map(p => p.responder).sort()
  assert.deepEqual(names, fromJs.people.map(p => p.responder).sort())
  assert.equal(names.includes('bot'), false)   // รายคนไม่รวมบอท
})

test('เก็บ KPI ลงตารางแล้ว รายงานต้องใช้ของที่เก็บไว้ และตัวเลขต้องไม่เปลี่ยน', async () => {
  await sql(`select inbox.refresh_sales_staff_kpi_daily('${DAY}')`)
  const stored = await sql(`select responder, replies, first_responses from inbox.sales_staff_kpi_daily
                             where report_date='${DAY}' order by responder`)
  assert.equal(stored.length > 0, true)

  const again = JSON.parse(await one(`select inbox.reply_report('${DAY}')`))
  assert.equal(again.total.asked, fromDb.total.asked)
  assert.equal(again.total.human_first, fromDb.total.human_first)
  // รายคนตอนนี้มาจากตารางที่เก็บไว้ จึงมีจำนวนข้อความรวม (replies) ติดมาด้วย
  assert.equal(again.people.every(p => p.replies !== undefined), true)
})

test('ข้อความไทยที่ทีมได้อ่าน มีตัวเลขสำคัญครบ', () => {
  const text = buildDailyDigest(fromDb)
  assert.equal(text.startsWith('📊 สรุปการตอบแชท'), true)
  assert.equal(text.includes('ลูกค้าทัก 6 รอบ'), true)
  assert.equal(text.includes('⚠ ค้าง 1'), true)
  assert.equal(text.includes('ทีมตอบช้ากว่า 30 นาที 2 รอบ'), true)
  assert.equal(text.includes('แยกตามช่องทาง'), true)
  assert.equal(text.includes('ยังไม่มีใครตอบ:'), true)
  assert.equal(text.includes('21:14'), true)
  assert.equal(text.includes('LINE 1 รอบนับเวลาจากบันทึก'), true)
})

test('ไม่มีข้อมูลก็ยังต้องได้รายงานที่อ่านออก ไม่ใช่ค่าว่างหรือ NaN', () => {
  const text = buildDailyDigest({ date: '2026-03-01', total: { asked: 0 }, platforms: [], people: [], pending: [] })
  assert.equal(text.includes('ลูกค้าทัก 0 รอบ'), true)
  assert.equal(text.includes('เฉลี่ยรอ: ทีม - นาที'), true)   // ขีด ไม่ใช่ 0 เพราะ 0 แปลว่าตอบทันที
  assert.equal(text.includes('NaN'), false)
  assert.equal(text.includes('undefined'), false)
})

test('fmtMin กับ thDate ตามรูปแบบเดิม', () => {
  assert.equal(fmtMin(18.4), '18')
  assert.equal(fmtMin(null), '-')
  assert.equal(fmtMin(0), '0')
  assert.equal(thDate('2026-03-05').includes('มี.ค.'), true)
})

test('ตัดท่อนที่ขึ้นบรรทัดใหม่ ไม่ตัดกลางประโยค', () => {
  const text = Array.from({ length: 400 }, (_, i) => `บรรทัดที่ ${i} ยาวพอสมควรเพื่อให้เกินสามพันห้า`).join('\n')
  const parts = chunkText(text, 3500)
  assert.equal(parts.length > 1, true)
  assert.equal(parts.every(p => p.length <= 3500), true)
  assert.equal(parts.join('\n'), text)                       // ต่อกลับได้เหมือนเดิมเป๊ะ
  assert.equal(parts.every(p => !p.startsWith('\n')), true)

  // บรรทัดเดียวที่ยาวเกินท่อน ยอมตัดดิบได้ แต่ต้องไม่หายไป
  const long = 'ก'.repeat(8000)
  const cut = chunkText(long, 3500)
  assert.equal(cut.join(''), long)
})

test('reply_stats ให้ตัวเลขเดียวกับที่นับใหม่ (ชื่อฟังก์ชันเดิมของ cloud)', async () => {
  // Phase 8 ย้ายชื่อนี้เข้ามาเพื่อให้คนที่คุ้นกับ cron ของ cloud หาเจอ
  // ข้างในเรียก reply_episodes ตัวเดียวกัน จะได้ไม่มีนิยาม "หนึ่งรอบ" สองชุดในระบบ
  const rows = await sql(`select responder, first_responses from inbox.reply_stats(
    '${DAY}T00:00:00+07'::timestamptz, '${DAY}T00:00:00+07'::timestamptz + interval '1 day')
    where responder <> 'bot' order by responder`)
  const got = Object.fromEntries(rows.map(r => [r[0], Number(r[1])]))
  const want = Object.fromEntries(fromJs.people.map(p => [p.responder, p.first_responses]))
  assert.deepEqual(got, want)
})

test('build_reply_report_daily เขียนลงตารางเดียวกับ refresh_sales_staff_kpi_daily', async () => {
  await sql(`delete from inbox.sales_staff_kpi_daily where report_date='${DAY}'`)
  await sql(`select inbox.build_reply_report_daily('${DAY}')`)
  const n = Number(await one(`select count(*) from inbox.sales_staff_kpi_daily where report_date='${DAY}'`))
  assert.equal(n > 0, true, 'ชื่อเดิมของ cloud ต้องเขียนลงตารางของเราได้จริง')
})

test('เก็บกวาดฉากทดสอบ', async () => {
  await teardown()
  assert.equal(Number(await one(`select count(*) from inbox.inbox where name like '%${TAG}%'`)), 0)
})
