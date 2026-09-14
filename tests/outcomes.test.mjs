/**
 * Phase 9 ข้อ 0 — ชั้น label ผลลัพธ์ของแต่ละรอบสนทนา
 *
 *   node --test tests/outcomes.test.mjs
 *
 * ★ ทุกข้อป้อน p_now เอง ไม่ใช้นาฬิกาจริง
 *   กฎ "ลูกค้าเงียบเกิน 24 ชม." จะทดสอบไม่ได้เลยถ้าต้องรอของจริง
 *   และผลต้องเหมือนเดิมทุกครั้งที่รัน ไม่ว่ารันตอนกี่โมง
 *
 * ★ ทุกฉากสร้างจากข้อความจริงในตาราง แล้วให้ label_conversation_outcomes อ่านเอง
 *   ไม่มีข้อไหนยัดแถวลง conversation_outcomes ตรง ๆ เพราะนั่นจะไม่ได้ทดสอบอะไรเลย
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TAG = '__outcometest__'
const DAY = '2026-04-08'
const TZ = '+07'

async function sql(text) {
  const { stdout } = await run('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', text], { maxBuffer: 16 << 20 })
  return stdout.trim().split('\n').filter(Boolean).map(l => l.split('|'))
}
const one = async t => (await sql(t))[0]?.[0] ?? null
const at = (h, m = 0, day = DAY) => `${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${TZ}`

// ── ฉาก: หนึ่งบทสนทนาต่อหนึ่งผลลัพธ์ที่อยากพิสูจน์ ─────────────────────────
const CASES = {
  botOnly:   'บอทตอบ แล้วลูกค้าคุยต่อ',
  humanOnly: 'คนตอบ แล้วลูกค้าคุยต่อ',
  silent:    'ตอบแล้วลูกค้าเงียบ',
  none:      'ไม่มีใครตอบ',
  lead:      'ลูกค้าให้เบอร์',
  booked:    'นัดเข้าชม',
  fresh:     'เพิ่งตอบไปเมื่อกี้',
}

async function setup() {
  await teardown()
  const project = await one(`select id from core.project where code='asher-naii'`)
  const agent = await one(`select id from auth.users where email='sales.a.test@asher.local'`)
  const inbox = await one(`insert into inbox.inbox(channel,project_id,name,credentials_ref,is_active)
    values('line','${project}','LINE ${TAG}','TEST_ONLY',true) returning id`)

  const ids = {}
  for (const [key, label] of Object.entries(CASES)) {
    const contact = await one(`select core.resolve_identity('line','U-${TAG}-${key}','${inbox}','${label} ${TAG}','${project}')`)
    ids[key] = await one(`insert into inbox.conversation(inbox_id,contact_id,status)
      values('${inbox}','${contact}','open') returning id`)
  }
  const say = (c, who, text, when, sender = null) =>
    sql(`insert into inbox.message(conversation_id,sender_type,sender_id,content,created_at)
         values('${c}','${who}',${sender ? `'${sender}'` : 'null'},'${text.replace(/'/g, "''")}','${when}')`)

  // บอทตอบ แล้วลูกค้าคุยต่อภายใน 24 ชม.
  await say(ids.botOnly, 'contact', 'ราคาเท่าไหร่คะ', at(9, 0))
  await say(ids.botOnly, 'bot', 'เริ่ม 2.39 ลบ. ค่ะ', at(9, 2))
  await say(ids.botOnly, 'contact', 'ขอบคุณค่ะ', at(9, 30))

  // คนตอบ แล้วลูกค้าคุยต่อ
  await say(ids.humanOnly, 'contact', 'ห้องว่างไหมคะ', at(10, 0))
  await say(ids.humanOnly, 'agent', 'ยังมีค่ะ', at(10, 5), agent)
  await say(ids.humanOnly, 'contact', 'ขอดูห้องได้ไหม', at(10, 20))

  // ตอบแล้วลูกค้าไม่ตอบต่อเลย
  await say(ids.silent, 'contact', 'สนใจค่ะ', at(11, 0))
  await say(ids.silent, 'bot', 'ยินดีให้ข้อมูลค่ะ', at(11, 1))

  // ไม่มีใครตอบ
  await say(ids.none, 'contact', 'ขอผังห้องหน่อยค่ะ', at(12, 0))

  // ให้เบอร์ในรอบเดียวกัน
  await say(ids.lead, 'contact', 'ติดต่อกลับที่ 0812345678 นะคะ', at(13, 0))
  await say(ids.lead, 'agent', 'รับทราบค่ะ', at(13, 10), agent)

  // นัดเข้าชม — บันทึกผ่าน crm.activity แบบเดียวกับที่ Sales Workspace ทำ
  await say(ids.booked, 'contact', 'ขอนัดดูห้องวันเสาร์ค่ะ', at(14, 0))
  await say(ids.booked, 'agent', 'จองให้แล้วค่ะ', at(14, 15), agent)
  // lead เกิดจาก ensure_lead() ตอน receive ของจริง — ที่นี่ยัดข้อความตรง ๆ จึงต้องเรียกเอง
  const lead = await one(`select connect_private.ensure_lead('${ids.booked}')`)
  await sql(`insert into crm.activity(lead_id,type,due_at,conversation_id,body,created_at)
             values('${lead}','site_visit','${at(10, 0, '2026-04-12')}','${ids.booked}','นัดเข้าชม ${TAG}','${at(14, 16)}')`)

  // เพิ่งตอบไป ยังไม่ครบ 24 ชม.
  await say(ids.fresh, 'contact', 'สอบถามค่ะ', at(20, 0))
  await say(ids.fresh, 'bot', 'ยินดีค่ะ', at(20, 1))

  return { inbox, ids, agent }
}

async function teardown() {
  await sql(`
    begin;
    create temp table _c on commit drop as
      select c.id from inbox.conversation c join inbox.inbox i on i.id=c.inbox_id where i.name like '%${TAG}%';
    create temp table _ct on commit drop as
      select distinct contact_id as id from core.contact_identity where external_id like '%${TAG}%';
    delete from inbox.conversation_outcomes where conversation_id in (select id from _c);
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
    delete from inbox.inbox where name like '%${TAG}%';
    commit;`)
}

// เรียก labeler ด้วยเวลาที่เรากำหนดเอง แล้วอ่านผลกลับมาเป็น map
async function label(now) {
  await sql(`select inbox.label_conversation_outcomes(
    '${at(0, 0)}'::timestamptz - interval '1 day', '${now}'::timestamptz, '${now}'::timestamptz)`)
  const rows = await sql(`select ct.display_name, o.asked_at::text, o.outcome, o.first_reply_by,
                                 o.customer_replied_after::text, o.turns, coalesce(o.responder_name,'-')
                            from inbox.conversation_outcomes o
                            join inbox.conversation c on c.id=o.conversation_id
                            join core.contact ct on ct.id=c.contact_id
                            join inbox.inbox i on i.id=c.inbox_id
                           where i.name like '%${TAG}%'`)
  // ★ ลูกค้าที่ตอบกลับจะทำให้เกิด "รอบที่สอง" ขึ้นมาเสมอ (ข้อความลูกค้าที่ก่อนหน้าไม่ใช่ลูกค้า)
  //   ถ้าเก็บเป็น map ธรรมดา รอบหลังจะทับรอบแรกแล้วเทสต์จะดูเหมือนพังทั้งที่ระบบถูก
  //   เก็บเป็นลำดับตามเวลาที่ถาม แล้วให้แต่ละข้อระบุเองว่าดูรอบไหน
  const out = {}
  for (const [name, asked, outcome, by, replied, turns, responder] of rows) {
    const key = Object.keys(CASES).find(k => name.startsWith(CASES[k]))
    ;(out[key] ??= []).push({ asked, outcome, by, replied: replied === 'true',
                              turns: Number(turns), responder })
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.asked.localeCompare(b.asked))
  return out
}

let scene, afterDay, sameDay

test('เตรียมฉาก แล้วติด label สองจังหวะเวลา', async () => {
  scene = await setup()
  // 20:30 ของวันเดียวกัน — รอบ fresh เพิ่งตอบไป 29 นาที ยังตัดสินไม่ได้
  sameDay = await label(at(20, 30))
  // สองวันถัดมา — ทุกรอบผ่าน 24 ชม. หมดแล้ว
  afterDay = await label(at(9, 0, '2026-04-10'))
  assert.equal(Object.keys(afterDay).length, Object.keys(CASES).length)
  // สองบทสนทนาที่ลูกค้าคุยต่อ ต้องมีสองรอบ ไม่ใช่รอบเดียว
  assert.equal(afterDay.botOnly.length, 2)
  assert.equal(afterDay.humanOnly.length, 2)
})

test('บอทตอบแล้วลูกค้าคุยต่อ = bot_only', () => {
  assert.deepEqual(
    { outcome: afterDay.botOnly[0].outcome, by: afterDay.botOnly[0].by, replied: afterDay.botOnly[0].replied },
    { outcome: 'bot_only', by: 'bot', replied: true })
  assert.equal(afterDay.botOnly[0].responder, '-')   // บอทไม่ใช่ "คน" จึงไม่มีชื่อผู้ตอบ
})

test('คนตอบก่อน = human_took_over และจำได้ว่าใครตอบ', () => {
  assert.equal(afterDay.humanOnly[0].outcome, 'human_took_over')
  assert.equal(afterDay.humanOnly[0].by, 'human')
  assert.equal(afterDay.humanOnly[0].responder.includes('@'), true)   // อีเมลของคนที่ตอบ
})

test('ตอบแล้วลูกค้าเงียบเกิน 24 ชม. = customer_silent', () => {
  assert.equal(afterDay.silent[0].outcome, 'customer_silent')
  assert.equal(afterDay.silent[0].replied, false)
})

test('เราไม่ได้ตอบเลย = unanswered ไม่ใช่ customer_silent', () => {
  // ความต่างสำคัญ: customer_silent คือลูกค้าเงียบ · unanswered คือเราเงียบ
  // ถ้ารวมกันเป็นค่าเดียว รายงานจะโทษลูกค้าในเรื่องที่เป็นความผิดของเรา
  assert.equal(afterDay.none[0].outcome, 'unanswered')
  assert.equal(afterDay.none[0].by, 'none')
})

test('ลูกค้าให้เบอร์ในรอบนั้น = lead ชนะทุกอย่างยกเว้นนัดชม', () => {
  // รอบนี้คนตอบ และลูกค้าไม่คุยต่อ ถ้าไม่มีกฎ lead จะกลายเป็น customer_silent
  assert.equal(afterDay.lead[0].outcome, 'lead')
  assert.equal(afterDay.lead[0].replied, false)
})

test('มีนัดเข้าชมในรอบนั้น = booked ชนะทุกอย่าง', () => {
  assert.equal(afterDay.booked[0].outcome, 'booked')
})

test('รอบที่เพิ่งตอบไป ยังไม่ถูกตราหน้าว่าลูกค้าเงียบ', () => {
  // ผ่านไป 29 นาที ยังไม่ครบ 24 ชม. — ตัดสินไม่ได้ ต้องรอ
  assert.equal(sameDay.fresh[0].outcome, 'bot_only')
  assert.equal(sameDay.fresh[0].replied, false)
  // พอเวลาผ่านไปจริง รอบเดิมถูกอัปเกรดเอง ไม่ต้องมีใครไปแก้
  assert.equal(afterDay.fresh[0].outcome, 'customer_silent')
})

test('turns นับข้อความทั้งรอบ ทั้งของลูกค้าและของเรา', () => {
  // รอบแรกของ botOnly = ถาม + บอทตอบ + ขอบคุณ (ขอบคุณเป็นข้อความสุดท้ายก่อนรอบใหม่เริ่ม)
  assert.equal(afterDay.botOnly[0].turns, 2)     // ถาม + บอทตอบ (รอบจบตอนลูกค้าเปิดรอบใหม่)
  assert.equal(afterDay.botOnly[1].turns, 1)     // รอบที่สอง: "ขอบคุณค่ะ" ที่ไม่มีใครตอบ
  assert.equal(afterDay.none[0].turns, 1)        // ถามอย่างเดียว
})

test('ลูกค้าที่ตอบกลับ เปิดรอบใหม่ที่ยังไม่มีใครตอบ', () => {
  // เป็นพฤติกรรมที่ถูกต้องของนิยาม "หนึ่งรอบ" ไม่ใช่ข้อผิดพลาด
  // และเป็นเหตุผลว่าทำไมรายงานถึงมีรอบค้างมากกว่าที่คนรู้สึก
  assert.equal(afterDay.botOnly[1].outcome, 'unanswered')
  assert.equal(afterDay.humanOnly[1].outcome, 'unanswered')
})

test('รันซ้ำแล้วผลไม่เปลี่ยน และไม่เกิดแถวซ้ำ', async () => {
  const before = Number(await one(`select count(*) from inbox.conversation_outcomes o
    join inbox.conversation c on c.id=o.conversation_id join inbox.inbox i on i.id=c.inbox_id
    where i.name like '%${TAG}%'`))
  const again = await label(at(9, 0, '2026-04-10'))
  const after = Number(await one(`select count(*) from inbox.conversation_outcomes o
    join inbox.conversation c on c.id=o.conversation_id join inbox.inbox i on i.id=c.inbox_id
    where i.name like '%${TAG}%'`))
  assert.equal(after, before)
  assert.deepEqual(again, afterDay)
})

test('label ที่คนแก้เอง ไม่ถูก cron ทับ', async () => {
  const conv = scene.ids.botOnly
  await sql(`update inbox.conversation_outcomes set outcome='booked', label_source='manual'
              where conversation_id='${conv}'`)
  await label(at(9, 0, '2026-04-10'))
  const row = await sql(`select outcome, label_source from inbox.conversation_outcomes
                          where conversation_id='${conv}'`)
  assert.deepEqual(row[0], ['booked', 'manual'])

  // ปลด manual แล้วต้องกลับไปเป็นของ auto ตามเดิม
  await sql(`update inbox.conversation_outcomes set label_source='auto' where conversation_id='${conv}'`)
  await label(at(9, 0, '2026-04-10'))
  assert.equal(await one(`select outcome from inbox.conversation_outcomes where conversation_id='${conv}'`),
    'bot_only')
})

test('ไม่มีตรรกะ episode ซ้ำในไฟล์ SQL ของ Phase 9', async () => {
  // ข้อนี้คุมกติกาที่สั่งไว้: ห้ามเขียนนิยาม "หนึ่งรอบ" ซ้ำ ต้องอ่านจาก reply_episodes
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../sql/013_conversation_outcomes.sql', import.meta.url), 'utf8')
  assert.equal(src.includes('inbox.reply_episodes('), true, 'ต้องเรียก reply_episodes')
  assert.equal(/lag\s*\(\s*.*sender_type/.test(src), false, 'ห้ามคำนวณรอบถามเองด้วย lag(sender_type)')
  assert.equal(src.includes("sender_type = 'contact' and"), false, 'ห้ามนิยามรอบถามซ้ำในไฟล์นี้')
})

test('เก็บกวาดฉากทดสอบ', async () => {
  await teardown()
  assert.equal(Number(await one(`select count(*) from inbox.inbox where name like '%${TAG}%'`)), 0)
})
