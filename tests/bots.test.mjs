/**
 * Phase 4 — ชุดทดสอบของบอท
 *
 *   node --test tests/bots.test.mjs
 *
 * ★ ไม่มีข้อไหนยิง Claude หรือ Meta จริง — fetch ถูกส่งเข้าไปทาง argument ทุกครั้ง
 *   ถ้ามีข้อไหนเผลอใช้ fetch จริง มันจะพังตรงที่ไม่มี ANTHROPIC_API_KEY ให้เห็นทันที
 *   (ไม่ใช่ค้างรอ network จนหมดเวลา)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadProjectData, projectDataFor, buildSystem, buildSystemBlocks, styleLines, cleanReply,
  parseIntent, normalizeMessages, generateReply, detectTopicCode, maskPII,
} from '../bots/reply.mjs'
import { classifyOnly, intentRow } from '../bots/classify.mjs'
import { formatNotify, notifyTargets } from '../bots/notify.mjs'

await loadProjectData()

// ตัวปลอมของ Claude — คืนข้อความที่กำหนด และจดว่าถูกเรียกด้วยอะไร
const claude = (text, status = 200) => {
  const seen = {}
  const fetcher = async (url, init) => {
    seen.url = url
    seen.body = JSON.parse(init.body)
    seen.headers = init.headers
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status })
  }
  return { seen, fetcher }
}

// system เป็น array ของก้อน (เพื่อ prompt caching) — รวมข้อความทุกก้อนก่อนตรวจ
// ตรวจแบบนี้ทำให้เทสต์ไม่ผูกกับจำนวนก้อน จะแบ่งกี่ก้อนก็ยังตรวจเนื้อความได้เหมือนเดิม
const systemText = body => (Array.isArray(body.system) ? body.system.map(b => b.text).join('\n') : body.system)

// ── ข้อมูลโครงการ ──────────────────────────────────────────────────────────

test('ข้อมูลโครงการอ่านจากไฟล์ ไม่ได้ฝังในโค้ด', () => {
  const naii = projectDataFor('naii')
  assert.equal(naii.includes('2.39'), true)
  assert.equal(naii.includes('Intamara 41'), true)
  assert.equal(projectDataFor('asher-naii'), naii)   // รับได้ทั้งรหัสเต็มและชื่อสั้น
})

test('โครงการที่ยังไม่มีข้อมูล ต้องสั่งให้บอทไม่ตอบ ไม่ใช่ไปหยิบของโครงการอื่นมา', () => {
  // อันตรายที่สุดของบอทขายคอนโดคือตอบราคาของอีกโครงการหนึ่ง
  const vibe = projectDataFor('vibe')
  assert.equal(vibe.includes('NO PROJECT DATA'), true)
  assert.equal(vibe.includes('2.39'), false)

  const unknown = projectDataFor('ยังไม่มีโครงการนี้')
  assert.equal(unknown.includes('NO PROJECT DATA'), true)
  assert.equal(unknown.includes('2.39'), false)
})

// ── system prompt ─────────────────────────────────────────────────────────

test('system prompt พาข้อมูลโครงการกับสไตล์ไปด้วยเสมอ', () => {
  const s = buildSystem({ project: 'naii', ctx: { is_new_chat: true } })
  assert.equal(s.includes('PROJECT DATA:'), true)
  assert.equal(s.includes('2.39'), true)
  assert.equal(s.includes('STYLE RULES'), true)
  assert.equal(s.includes('OUTPUT FORMAT'), true)
  assert.equal(s.includes('[OFFTOPIC]'), true)
})

test('แยกก้อนเพื่อ caching แล้ว โมเดลต้องยังเห็นข้อความเดิมเป๊ะ', () => {
  // ข้อกังวลเดียวของการแยกก้อนคือเนื้อความเปลี่ยนโดยไม่ตั้งใจ — ผูกไว้ตรงนี้
  for (const args of [
    { project: 'naii', ctx: { is_new_chat: true } },
    { project: 'naii', ctx: { is_new_chat: false }, known: 'มีเบอร์แล้ว', context: 'บริบทเพิ่ม' },
    { project: 'vibe', ctx: { is_new_chat: true }, known: 'มีเบอร์แล้ว' },
  ]) {
    const blocks = buildSystemBlocks(args)
    assert.equal(blocks.map(b => b.text).join('\n'), buildSystem(args),
      'ข้อความรวมของทุกก้อนต้องเท่ากับ buildSystem เดิม')
  }
})

test('ก้อนแรกต้องติด cache_control และต้องเป็นก้อนที่คงที่', () => {
  const a = buildSystemBlocks({ project: 'naii', ctx: { is_new_chat: true }, known: 'เบอร์ ก' })
  const b = buildSystemBlocks({ project: 'naii', ctx: { is_new_chat: true }, known: 'เบอร์ ข' })

  assert.deepEqual(a[0].cache_control, { type: 'ephemeral' })
  assert.equal(a[0].text, b[0].text, 'ก้อนที่แคชต้องไม่ขยับตาม known — ไม่งั้นแคชตายทุกครั้ง')
  assert.equal(a[0].text.includes('PROJECT DATA:'), true)
  assert.notEqual(a[1].text, b[1].text, 'ของที่เปลี่ยนต้องอยู่ก้อนหลัง')
  assert.equal(a[1].cache_control, undefined, 'ก้อนที่เปลี่ยนต้องไม่ติด cache_control')

  // ไม่มี ADDITIONAL DATA ก็ต้องไม่สร้างก้อนเปล่า
  assert.equal(buildSystemBlocks({ project: 'naii', ctx: {} }).length, 1)
})

test('ลูกค้าเก่าต้องไม่โดนทักซ้ำและไม่โดนยิงโบรชัวร์ซ้ำ', () => {
  const fresh = styleLines({}, { is_new_chat: true }).join('\n')
  const back = styleLines({}, { is_new_chat: false }).join('\n')
  assert.equal(fresh.includes("first message"), true)
  assert.equal(back.includes('do NOT greet'), true)
  assert.equal(back.includes('Do NOT resend'), true)
})

test('สไตล์เปลี่ยนตามค่าที่ส่งมาจากฐาน ไม่ใช่ค่าคงที่ในโค้ด', () => {
  const s = styleLines({ tone: 'concise', max_sentences: 2, use_emoji: 'none',
                         cta: 'never', ask_contact: 'never', polite_particle: 'ครับ' }, {}).join('\n')
  assert.equal(s.includes('concise and direct'), true)
  assert.equal(s.includes('at most 2 sentences'), true)
  assert.equal(s.includes('Do not use emoji'), true)
  assert.equal(s.includes("End sentences with 'ครับ'"), true)
})

// ── แปลคำตอบ ──────────────────────────────────────────────────────────────

test('cleanReply ตัด markdown และคำลงท้ายแบบโรมันที่โมเดลชอบแถม', () => {
  assert.equal(cleanReply('**ราคา** เริ่ม 2.39 ลบ. ค่ะ kha'), 'ราคา เริ่ม 2.39 ลบ. ค่ะ')
  assert.equal(cleanReply('- ห้องว่างค่ะ krub'), 'ห้องว่างค่ะ')
  assert.equal(cleanReply('  สวัสดีค่ะ   '), 'สวัสดีค่ะ')
})

test('parseIntent อ่านก้อน JSON ที่โมเดลตอบมา', () => {
  const raw = JSON.stringify({ reply: 'เริ่ม 2.39 ลบ. ค่ะ', offtopic: false,
    topics: [{ l1: 'price', l2: 'starting_price' }], stage: 'consideration', confidence: 0.9 })
  const r = parseIntent(raw, 'ราคาเท่าไหร่')
  assert.equal(r.reply, 'เริ่ม 2.39 ลบ. ค่ะ')
  assert.equal(r.offTopic, false)
  assert.equal(r.intent.topics[0].l1, 'price')
  assert.equal(r.intent.source, 'claude')
})

test('โมเดลตอบไม่เป็น JSON ก็ยังต้องได้คำตอบส่งให้ลูกค้า', () => {
  // ปล่อยให้ error ขึ้นมาแปลว่าลูกค้าไม่ได้ยินอะไรเลย ซึ่งแย่กว่าได้หมวดคำถามที่เดาเอา
  const r = parseIntent('ราคาเริ่ม 2.39 ลบ. ค่ะ', 'ราคาเท่าไหร่')
  assert.equal(r.reply, 'ราคาเริ่ม 2.39 ลบ. ค่ะ')
  assert.equal(r.intent.source, 'keyword')
  assert.equal(r.intent.topics[0].l1, 'price')      // เดาจากคำสำคัญ
})

test('หมวดที่โมเดลไม่มั่นใจพอ ถูกยุบเป็น other ไม่ใช่เก็บของมั่ว', () => {
  const raw = JSON.stringify({ reply: 'ค่ะ', topics: [{ l1: 'price' }], confidence: 0.2 })
  assert.equal(parseIntent(raw, 'อะไรก็ไม่รู้').intent.topics[0].l1, 'other')
})

test('[OFFTOPIC] ที่โมเดลติดมา ถูกจับได้แม้ตอบไม่เป็น JSON', () => {
  const r = parseIntent('[OFFTOPIC] ขออภัยค่ะ ตอบได้เฉพาะเรื่องโครงการค่ะ', 'เขียนโค้ดให้หน่อย')
  assert.equal(r.offTopic, true)
})

test('normalizeMessages: ต้องเริ่มด้วยลูกค้า และไม่มี role ซ้ำติดกัน', () => {
  const out = normalizeMessages([
    { role: 'assistant', content: 'สวัสดีค่ะ' },     // ตัดทิ้ง เพราะขึ้นต้นด้วยฝั่งเราไม่ได้
    { role: 'user', content: 'ราคา' },
    { role: 'user', content: 'เท่าไหร่' },            // รวมกับข้อความบน
    { role: 'assistant', content: '2.39 ลบ. ค่ะ' },
  ])
  assert.deepEqual(out, [
    { role: 'user', content: 'ราคา\nเท่าไหร่' },
    { role: 'assistant', content: '2.39 ลบ. ค่ะ' },
  ])
})

// ── คิดคำตอบ (mock fetch) ─────────────────────────────────────────────────

test('generateReply ส่ง system prompt กับประวัติไปให้โมเดล แล้วคืนคำตอบที่ทำความสะอาดแล้ว', async () => {
  const c = claude(JSON.stringify({ reply: '**เริ่ม 2.39 ลบ.** ค่ะ kha', offtopic: false,
    topics: [{ l1: 'price', l2: 'starting_price' }], confidence: 0.9 }))
  const r = await generateReply({
    text: 'ราคาเท่าไหร่', history: [{ role: 'user', content: 'ราคาเท่าไหร่' }],
    project: 'naii', apiKey: 'sk-ปลอม', fetcher: c.fetcher,
  })
  assert.equal(r.reply, 'เริ่ม 2.39 ลบ. ค่ะ')       // markdown กับ kha หายไปแล้ว
  assert.equal(r.intent.topics[0].l1, 'price')
  assert.equal(c.seen.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(c.seen.headers['x-api-key'], 'sk-ปลอม')
  assert.equal(systemText(c.seen.body).includes('2.39'), true)
  assert.deepEqual(c.seen.body.messages, [{ role: 'user', content: 'ราคาเท่าไหร่' }])
})

test('ไม่มี key ต้องไม่ลองใหม่ · โดน 429 ต้องลองใหม่', async () => {
  const boom = async () => { throw new Error('ต้องไม่ถูกเรียก') }
  await assert.rejects(() => generateReply({ text: 'x', apiKey: '', fetcher: boom }),
    e => e.message === 'anthropic_key_missing' && e.retryable === false)

  const rate = async () => new Response('{}', { status: 429 })
  await assert.rejects(() => generateReply({ text: 'x', apiKey: 'k', fetcher: rate }),
    e => e.message === 'anthropic_http_429' && e.retryable === true)

  const empty = async () => new Response(JSON.stringify({ content: [] }), { status: 200 })
  await assert.rejects(() => generateReply({ text: 'x', apiKey: 'k', fetcher: empty }),
    e => e.message === 'anthropic_empty_reply' && e.retryable === true)
})

test('ลูกค้าที่ให้เบอร์มาแล้ว ต้องไม่ถูกถามเบอร์ซ้ำ', async () => {
  const c = claude('{"reply":"ทีมจะติดต่อกลับค่ะ","confidence":0.9}')
  await generateReply({ text: 'ติดต่อกลับได้เลย', known: 'Customer ALREADY gave phone number: 0812345678. Do NOT ask for phone again.',
    apiKey: 'k', fetcher: c.fetcher })
  assert.equal(systemText(c.seen.body).includes('ALREADY gave phone number: 0812345678'), true)
  assert.equal(systemText(c.seen.body).includes('ADDITIONAL DATA'), true)
})

// ── ถอดหมวดคำถาม (mock fetch) ─────────────────────────────────────────────

test('classifyOnly อ่านก้อนหมวดที่โมเดลตอบมา', async () => {
  const c = claude('{"topics":[{"l1":"finance","l2":"monthly_payment"}],"stage":"intent","confidence":0.8}')
  const intent = await classifyOnly('ผ่อนเดือนละเท่าไหร่', null, { apiKey: 'k', fetcher: c.fetcher })
  assert.equal(intent.topics[0].l1, 'finance')
  assert.equal(intent.stage, 'intent')
  assert.equal(systemText(c.seen.body).includes('TAXONOMY'), true)
  assert.equal(c.seen.body.temperature, 0)
})

test('งานถอดหมวดล้มแล้วต้องไม่โยน error ออกมา — เป็นของแถม ไม่ควรทำให้คิวค้าง', async () => {
  const errors = []
  const intent = await classifyOnly('ผ่อนเดือนละเท่าไหร่', null,
    { apiKey: 'k', fetcher: async () => new Response('{}', { status: 500 }), onError: e => errors.push(e.message) })
  assert.equal(intent.source, 'keyword')
  assert.equal(intent.topics[0].l1, 'finance')   // ยังได้หมวดจากคำสำคัญ
  assert.equal(errors.length, 1)                 // แต่ความล้มเหลวไม่เงียบ
})

test('ไม่มี key ก็ยังได้หมวดจากคำสำคัญ ไม่ใช่พังทั้งงาน', async () => {
  const intent = await classifyOnly('ราคาเท่าไหร่', null,
    { apiKey: '', fetcher: async () => { throw new Error('ต้องไม่ถูกเรียก') } })
  assert.equal(intent.topics[0].l1, 'price')
  assert.equal(intent.source, 'keyword')
})

test('intentRow แปลงเป็นของที่ store_intent รับได้ และ mask ข้อมูลลูกค้า', () => {
  const row = intentRow(
    { topics: [{ l1: 'contact', l2: 'give_phone' }, { l1: 'price', l2: null }], stage: 'ready',
      confidence: 0.9, source: 'claude' },
    { conversation_id: 'c1', raw_question: maskPII('โทร 0812345678 นะคะ line: somchai') })
  assert.equal(row.primary_topic, 'contact')
  assert.deepEqual(row.secondary_topics, ['price'])
  assert.equal(row.raw_question.includes('0812345678'), false)
  assert.equal(row.raw_question.includes('[PHONE]'), true)
  assert.equal(row.raw_question.includes('[LINE]'), true)
})

test('detectTopicCode เดาหมวดจากคำสำคัญได้ตามของเดิม', () => {
  assert.equal(detectTopicCode('ผ่อนเดือนละเท่าไหร่'), 'finance')
  assert.equal(detectTopicCode('เลี้ยงแมวได้ไหม'), 'rules')
  assert.equal(detectTopicCode('0812345678'), 'contact')
  assert.equal(detectTopicCode('ฮัลโหล'), 'other')
})

// ── ข้อความแจ้งทีม ────────────────────────────────────────────────────────

test('ข้อความแจ้งทีมบอกความเร่งด่วนตั้งแต่บรรทัดแรก', () => {
  const lead = formatNotify({ phone: '0812345678', text: 'สนใจค่ะ', reply_go: false, reply_reason: 'outside_schedule_silent' })
  assert.equal(lead.startsWith('🔴'), true)          // ได้เบอร์มา = ด่วนที่สุด
  assert.equal(lead.includes('เบอร์: 0812345678'), true)
  assert.equal(lead.includes('ไม่ตอบ (outside_schedule_silent) → คนต้องตอบ'), true)

  const waiting = formatNotify({ text: 'ราคา', reply_go: true, wait_min: 30 })
  assert.equal(waiting.startsWith('🟡'), true)
  assert.equal(waiting.includes('รอคนตอบ 30 นาที'), true)

  const stuck = formatNotify({ kind: 'watchdog', min_since_msg: 130, text: 'ราคา' })
  assert.equal(stuck.startsWith('🟠 ค้างตอบ 130 นาที'), true)
})

test('ปลายทางของการแจ้งมาจาก env · Telegram กับอีเมลใช้เฉพาะตอนได้ lead', () => {
  const env = { LINE_NOTIFY_GROUP_ID: 'C123', LINE_NOTIFY_TOKEN: 't',
                TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '-100',
                RESEND_API_KEY: 're', LEAD_EMAIL_TO: 'sales@asher.local' }
  assert.deepEqual(notifyTargets({}, env).map(t => t.channel), ['line_group'])
  assert.deepEqual(notifyTargets({ phone: '0812345678' }, env).map(t => t.channel),
    ['line_group', 'telegram', 'email'])
  assert.deepEqual(notifyTargets({ phone: '0812345678' }, {}), [])   // ไม่ตั้ง env = ไม่มีปลายทาง
})

test('TELEGRAM_NOTIFY_ALL=true ให้ Telegram แจ้งทุกข้อความ · อีเมลยังเฉพาะ lead', () => {
  // ใช้ตอนที่ยังไม่มี LINE group id — ทีมต้องไม่ตาบอดระหว่างรอ
  const tgOnly = { TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '-100', TELEGRAM_NOTIFY_ALL: 'true',
                   RESEND_API_KEY: 're', LEAD_EMAIL_TO: 'sales@asher.local' }
  assert.deepEqual(notifyTargets({}, tgOnly).map(t => t.channel), ['telegram'])
  assert.deepEqual(notifyTargets({ phone: '0812345678' }, tgOnly).map(t => t.channel), ['telegram', 'email'])

  // ค่าอื่นที่ไม่ใช่ 'true' ต้องไม่เปิด — กันพิมพ์ผิดแล้วสแปมทีมโดยไม่ตั้งใจ
  for (const v of ['false', '1', 'yes', '', undefined]) {
    assert.deepEqual(notifyTargets({}, { ...tgOnly, TELEGRAM_NOTIFY_ALL: v }).map(t => t.channel), [],
      `TELEGRAM_NOTIFY_ALL=${v} ไม่ควรเปิด`)
  }

  // มี LINE ครบแล้วยังใช้ร่วมกันได้ ไม่ตัดทางใดทางหนึ่งทิ้ง
  const both = { ...tgOnly, LINE_NOTIFY_GROUP_ID: 'C123', LINE_NOTIFY_TOKEN: 't' }
  assert.deepEqual(notifyTargets({}, both).map(t => t.channel), ['line_group', 'telegram'])
})

// ── กันพลาดซ้ำ ─────────────────────────────────────────────────────────────
test('ทุกโฟลเดอร์ที่โค้ดฝั่งเซิร์ฟเวอร์ import ต้องถูก COPY เข้า image', async () => {
  // เจอมาสองรอบแล้วว่าลืม COPY แล้ว container ขึ้นไม่ได้เลย (bots/ ตอน Phase 4, reports/ ตอน Phase 7)
  // เป็นความพลาดที่เห็นตอน build จริงเท่านั้น เทสต์ปกติไม่เจอเพราะรันจากซอร์ส
  const { readFile } = await import('node:fs/promises')
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  const dirs = new Set()
  for (const file of ['server.mjs', 'providers.mjs']) {
    const src = await readFile(new URL('../' + file, import.meta.url), 'utf8')
    for (const m of src.matchAll(/from\s+'\.\/([a-z-]+)\//g)) dirs.add(m[1])
  }
  assert.equal(dirs.size > 0, true, 'อ่าน import ไม่เจอเลย แปลว่า regex พัง ไม่ใช่ว่าไม่มีโฟลเดอร์')
  for (const dir of dirs) {
    assert.equal(dockerfile.includes(`COPY --chown=node:node ${dir} ./${dir}`), true,
      `Dockerfile ไม่ได้ COPY ${dir}/ ทั้งที่โค้ด import จากตรงนั้น — container จะขึ้นไม่ได้`)
  }
})
