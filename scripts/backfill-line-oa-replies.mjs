#!/usr/bin/env node
/**
 * Reconcile manual replies sent from LINE Official Account Manager.
 *
 * Default is preview-only. The script scans every OA chat but writes only for
 * LINE identities that already belong to the selected ASHER Connect inbox.
 * This deliberately avoids creating thousands of historical CRM leads.
 *
 *   node scripts/backfill-line-oa-replies.mjs \
 *     --cookies /path/to/agent-browser-cookies.json \
 *     --inbox <uuid> --bot <LINE-OA-chat-bot-id>
 *
 * Add --apply only after reviewing the preview.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = name => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null
}
const APPLY = args.includes('--apply')
const COOKIE_FILE = option('--cookies')
const INBOX_ID = option('--inbox')
const BOT_ID = option('--bot')
const DB_CONTAINER = option('--db-container') || 'supabase-db'
const DELAY_MS = Number(option('--delay-ms') || 75)
const MAX_CHAT_PAGES = Number(option('--max-chat-pages') || 500)
const MAX_MESSAGE_PAGES = Number(option('--max-message-pages') || 200)

if (!COOKIE_FILE || !INBOX_ID || !BOT_ID) {
  console.error('ต้องมี --cookies, --inbox และ --bot')
  process.exit(1)
}
if (!/^[0-9a-f-]{36}$/i.test(INBOX_ID) || !/^U[0-9a-f]{32}$/i.test(BOT_ID)) {
  console.error('รูปแบบ --inbox หรือ --bot ไม่ถูกต้อง')
  process.exit(1)
}

const q = value => `'${String(value ?? '').replaceAll("'", "''")}'`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const psql = statement => execFileSync('docker', [
  'exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X',
  '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '\t', '-c', statement,
], { encoding: 'utf8', maxBuffer: 32 << 20 }).trim()

const cookiePayload = JSON.parse(readFileSync(COOKIE_FILE, 'utf8').replace(/^\uFEFF/, ''))
const cookies = cookiePayload?.data?.cookies || cookiePayload?.cookies || cookiePayload
if (!Array.isArray(cookies)) throw new Error('ไฟล์ cookies ไม่มีรายการ cookies')
const cookie = cookies
  .filter(item => String(item.domain || '').endsWith('line.biz'))
  .map(item => `${item.name}=${item.value}`)
  .join('; ')
if (!cookie) throw new Error('ไม่พบ LINE cookies')

const headers = {
  cookie,
  referer: `https://chat.line.biz/${BOT_ID}`,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
}
const getJson = async url => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`LINE OA HTTP ${response.status}`)
  return response.json()
}

const identityRows = psql(`
  select ci.external_id, coalesce(ct.display_name,'')
    from core.contact_identity ci
    join core.contact ct on ct.id=ci.contact_id
    join inbox.conversation c on c.contact_id=ci.contact_id and c.inbox_id=${q(INBOX_ID)}::uuid
   where ci.channel='line' and ci.account_key=${q(INBOX_ID)}
   group by ci.external_id,ct.display_name
   order by ci.external_id`)
const identities = new Map(identityRows ? identityRows.split('\n').map(row => {
  const [externalId, displayName = ''] = row.split('\t')
  return [externalId, displayName]
}) : [])

const ownersBody = await getJson(`https://chat.line.biz/api/v1/bots/${BOT_ID}/owners`)
const owners = new Map((ownersBody.list || []).map(owner => [owner.bizId, owner.name || '']))

let next = null
let chatPages = 0
let oaChats = 0
const matches = new Map()
do {
  const query = new URLSearchParams({
    folderType: 'ALL', tagIds: '', autoTagIds: '', limit: '25', prioritizePinnedChat: 'true',
  })
  if (next) query.set('next', next)
  const body = await getJson(`https://chat.line.biz/api/v2/bots/${BOT_ID}/chats?${query}`)
  chatPages += 1
  oaChats += (body.list || []).length
  for (const chat of body.list || []) {
    if (identities.has(chat.chatId)) matches.set(chat.chatId, chat)
  }
  next = body.next || null
  if (next && chatPages >= MAX_CHAT_PAGES) throw new Error(`เกินเพดาน chat pagination ${MAX_CHAT_PAGES} หน้า`)
  if (next) await sleep(DELAY_MS)
} while (next)

const replies = []
for (const [externalId] of matches) {
  let backward = null
  let messagePages = 0
  do {
    const suffix = backward ? `?backward=${encodeURIComponent(backward)}` : ''
    const body = await getJson(`https://chat.line.biz/api/v3/bots/${BOT_ID}/chats/${externalId}/messages${suffix}`)
    messagePages += 1
    for (const event of body.list || []) {
      if (event.type !== 'messageSent' || !event.message?.id || !owners.has(event.bizId)) continue
      const contentType = event.message.type || 'other'
      const text = contentType === 'text' ? event.message.text : `[LINE OA ${contentType}]`
      replies.push({
        externalId,
        displayName: identities.get(externalId),
        eventId: String(event.message.id),
        repliedAt: new Date(event.timestamp).toISOString(),
        staffExternalId: event.bizId,
        staffName: owners.get(event.bizId),
        text,
        contentType,
      })
    }
    backward = body.backward || null
    if (backward && messagePages >= MAX_MESSAGE_PAGES) {
      throw new Error(`เกินเพดาน message pagination ${MAX_MESSAGE_PAGES} หน้า`)
    }
    if (backward) await sleep(DELAY_MS)
  } while (backward)
}

replies.sort((a, b) => a.repliedAt.localeCompare(b.repliedAt) || a.eventId.localeCompare(b.eventId))
console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'preview',
  oa_chats_scanned: oaChats,
  crm_line_identities: identities.size,
  matched_chats: matches.size,
  manual_replies_found: replies.length,
  unmatched_crm_identities: identities.size - matches.size,
}, null, 2))

if (!APPLY) {
  console.log('preview เท่านั้น: ยังไม่ได้เขียนฐาน (เพิ่ม --apply เมื่อพร้อม)')
  process.exit(0)
}

let inserted = 0
let duplicates = 0
for (const reply of replies) {
  const output = psql(`
    begin;
    set local request.jwt.claims='{"role":"service_role"}';
    select connect_private.backfill_line_oa_reply(
      ${q(INBOX_ID)}::uuid,${q(reply.externalId)},${q(reply.displayName)},${q(reply.eventId)},
      ${q(reply.repliedAt)}::timestamptz,${q(reply.staffExternalId)},${q(reply.staffName)},
      ${q(reply.text)},${q(reply.contentType)});
    commit;`)
  if (output.includes('"duplicate": true') || output.includes('"duplicate":true')) duplicates += 1
  else inserted += 1
}

console.log(JSON.stringify({ applied: replies.length, inserted, duplicates }, null, 2))
