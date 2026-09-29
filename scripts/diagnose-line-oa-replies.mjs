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
  select jsonb_build_object(
           'external_id',ci.external_id,
           'display_name',coalesce(ct.display_name,''),
           'created_ms',floor(extract(epoch from m.created_at)*1000)::bigint,
           'sender_type',m.sender_type,
           'event_type',m.event_type,
           'content_type',m.content_type,
           'content',coalesce(m.content,'')
         )::text
    from core.contact_identity ci
    join core.contact ct on ct.id=ci.contact_id
    join inbox.conversation c on c.contact_id=ci.contact_id and c.inbox_id=${q(INBOX_ID)}::uuid
    left join inbox.message m on m.conversation_id=c.id
      and (m.sender_type='contact' or (m.sender_type='system' and m.event_type='follow'))
   where ci.channel='line' and ci.account_key=${q(INBOX_ID)}
   order by ci.external_id,m.created_at desc`)
const identityEvents = identityRows ? identityRows.split('\n').map(row => JSON.parse(row)) : []
const identities = new Map()
for (const row of identityEvents) {
  if (!identities.has(row.external_id)) identities.set(row.external_id, { displayName: row.display_name, inbound: [], followMs: [] })
  if (row.sender_type === 'contact' && row.created_ms != null) identities.get(row.external_id).inbound.push(row)
  if (row.event_type === 'follow' && row.created_ms != null) identities.get(row.external_id).followMs.push(Number(row.created_ms))
}

// OA Manager may add/remove spaces around emoji while Messaging API keeps the
// original profile spelling.  Whitespace is not trusted as identity evidence;
// the inbound timestamp/type/content fingerprint below remains mandatory.
const normalizedName = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('th')
const names = new Map()
for (const [externalId, identity] of identities) {
  const name = normalizedName(identity.displayName)
  if (!name) continue
  if (!names.has(name)) names.set(name, [])
  names.get(name).push(externalId)
}

const ownersBody = await getJson(`https://chat.line.biz/api/v1/bots/${BOT_ID}/owners`)
const owners = new Map((ownersBody.list || []).map(owner => [owner.bizId, owner.name || '']))

let next = null
let chatPages = 0
let oaChats = 0
const directMatches = new Map()
const nameCandidates = new Map()
const followCandidates = new Map()
do {
  const query = new URLSearchParams({
    folderType: 'ALL', tagIds: '', autoTagIds: '', limit: '25', prioritizePinnedChat: 'true',
  })
  if (next) query.set('next', next)
  const body = await getJson(`https://chat.line.biz/api/v2/bots/${BOT_ID}/chats?${query}`)
  chatPages += 1
  oaChats += (body.list || []).length
  if (args.includes('--diagnose') && chatPages % 20 === 0) {
    console.error(`diagnostic chat pages: ${chatPages}, chats: ${oaChats}`)
  }
  for (const chat of body.list || []) {
    const directId = identities.has(chat.chatId) ? chat.chatId
      : identities.has(chat.profile?.userId) ? chat.profile.userId : null
    if (directId) {
      directMatches.set(directId, chat)
      continue
    }
    for (const [externalId, identity] of identities) {
      if (!identity.followMs.length) continue
      const activity = [chat.updatedAt, chat.lastReceivedAt, chat.lastSentAt].map(Number)
      if (!identity.followMs.some(followMs => activity.some(at =>
        Number.isFinite(at) && at >= followMs - 1500 && at <= followMs + 10 * 60_000))) continue
      if (!followCandidates.has(externalId)) followCandidates.set(externalId, [])
      followCandidates.get(externalId).push(chat)
    }
    const name = normalizedName(chat.profile?.name || chat.profile?.displayName)
    const candidateIds = names.get(name) || []
    if (candidateIds.length !== 1) continue
    const externalId = candidateIds[0]
    if (!nameCandidates.has(externalId)) nameCandidates.set(externalId, [])
    nameCandidates.get(externalId).push(chat)
  }
  next = body.next || null
  if (next && chatPages >= MAX_CHAT_PAGES) throw new Error(`เกินเพดาน chat pagination ${MAX_CHAT_PAGES} หน้า`)
  if (next) await sleep(DELAY_MS)
} while (next)

const replies = []
const matches = new Map(directMatches)
let matchedByFingerprint = 0
let rejectedByFingerprint = 0
const candidateEntries = [
  ...[...directMatches].map(([externalId, chat]) => ({ externalId, chat, direct: true })),
  ...[...nameCandidates].filter(([externalId, chats]) => chats.length === 1 && !directMatches.has(externalId))
    .map(([externalId, chats]) => ({ externalId, chat: chats[0], direct: false })),
  ...[...followCandidates].filter(([externalId, chats]) => chats.length === 1
    && !directMatches.has(externalId) && (nameCandidates.get(externalId)?.length || 0) !== 1)
    .map(([externalId, chats]) => ({ externalId, chat: chats[0], direct: false })),
]
for (const { externalId, chat, direct } of candidateEntries) {
  let backward = null
  let messagePages = 0
  const events = []
  do {
    const suffix = backward ? `?backward=${encodeURIComponent(backward)}` : ''
    const body = await getJson(`https://chat.line.biz/api/v3/bots/${BOT_ID}/chats/${chat.chatId}/messages${suffix}`)
    messagePages += 1
    events.push(...(body.list || []))
    backward = body.backward || null
    if (backward && messagePages >= MAX_MESSAGE_PAGES) {
      throw new Error(`เกินเพดาน message pagination ${MAX_MESSAGE_PAGES} หน้า`)
    }
    if (backward) await sleep(DELAY_MS)
  } while (backward)

  if (!direct) {
    const inbound = identities.get(externalId)?.inbound || []
    const inboundMatched = events.some(event => {
      if (event.type !== 'message' || !event.message?.type || !Number.isFinite(Number(event.timestamp))) return false
      return inbound.some(saved => {
        if (Math.abs(Number(event.timestamp) - Number(saved.created_ms)) > 1500) return false
        if (event.message.type !== saved.content_type) return false
        if (saved.content_type !== 'text') return true
        return String(event.message.text || '').trim() === String(saved.content || '').trim()
      })
    })
    const followMatched = events.some(event => event.type === 'follow'
      && (identities.get(externalId)?.followMs || []).some(saved =>
        Math.abs(Number(event.timestamp) - saved) <= 1))
    const fingerprintMatched = inboundMatched || followMatched
    if (!fingerprintMatched) {
      if (args.includes('--diagnose')) {
        console.error(JSON.stringify({ rejectedName: identities.get(externalId)?.displayName,
          eventTypes: events.slice(0, 8).map(event => ({ type: event.type,
            messageType: event.message?.type,
            ownerKnown: owners.has(event.bizId),
            timestamp: new Date(event.timestamp).toISOString(),
            text: String(event.message?.text || '').slice(0, 45) })) }))
      }
      rejectedByFingerprint += 1
      continue
    }
    matches.set(externalId, chat)
    matchedByFingerprint += 1
  }

  for (const event of events) {
      if (event.type !== 'messageSent' || !event.message?.id || !owners.has(event.bizId)) continue
      const contentType = event.message.type || 'other'
      const text = contentType === 'text' ? event.message.text : `[LINE OA ${contentType}]`
      replies.push({
        externalId,
        displayName: identities.get(externalId)?.displayName || '',
        eventId: String(event.message.id),
        repliedAt: new Date(event.timestamp).toISOString(),
        staffExternalId: event.bizId,
        staffName: owners.get(event.bizId),
        text,
        contentType,
      })
  }
}

replies.sort((a, b) => a.repliedAt.localeCompare(b.repliedAt) || a.eventId.localeCompare(b.eventId))
console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'preview',
  oa_chats_scanned: oaChats,
  crm_line_identities: identities.size,
  matched_chats: matches.size,
  matched_by_id: directMatches.size,
  matched_by_fingerprint: matchedByFingerprint,
  rejected_by_fingerprint: rejectedByFingerprint,
  manual_replies_found: replies.length,
  unmatched_crm_identities: identities.size - matches.size,
}, null, 2))

if (!APPLY) {
  if (args.includes('--diagnose')) {
    console.log(JSON.stringify({ unmatched: [...identities]
      .filter(([externalId]) => !matches.has(externalId))
      .map(([externalId, identity]) => ({
        externalId,
        displayName: identity.displayName,
        inboundCount: identity.inbound.length,
        nameCandidates: nameCandidates.get(externalId)?.length || 0,
        followCandidates: followCandidates.get(externalId)?.length || 0,
      })) }, null, 2))
  }
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

// A historical insert fires the regular message trigger, which otherwise makes
// last_message_at/preview point to the most recently *inserted* old reply.
// Reconcile the inbox from actual message chronology after every run.
const correctedConversations = psql(`
  with latest as (
    select distinct on (m.conversation_id)
           m.conversation_id, m.created_at, left(m.content,240) as preview
      from inbox.message m
      join inbox.conversation c on c.id=m.conversation_id
     where c.inbox_id=${q(INBOX_ID)}::uuid
     order by m.conversation_id, m.created_at desc, m.id desc
  ), repaired as (
    update inbox.conversation c
       set last_message_at=l.created_at,
           last_message_preview=l.preview
      from latest l
     where c.id=l.conversation_id
       and (c.last_message_at is distinct from l.created_at
         or c.last_message_preview is distinct from l.preview)
    returning c.id
  ) select count(*) from repaired`)
console.log(JSON.stringify({ corrected_conversations: Number(correctedConversations) }))
