#!/usr/bin/env node
/** Idempotently archive LINE OA Manager history without guessing CRM identities. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = name => {
  const index = argv.indexOf(name)
  return index < 0 ? null : argv[index + 1]
}
const cookieFile = flag('--cookies')
const bot = flag('--bot')
const apply = argv.includes('--apply')
const force = argv.includes('--force')
const newestFirst = argv.includes('--newest-first')
const maxChats = Number(flag('--max-chats') || 0)
if (!cookieFile || !/^U[0-9a-f]{32}$/i.test(bot || '')) {
  throw new Error('Usage: --cookies FILE --bot U... [--apply] [--max-chats N] [--force]')
}
const cookiePayload = JSON.parse(readFileSync(cookieFile, 'utf8').replace(/^\uFEFF/, ''))
const cookies = cookiePayload?.data?.cookies || cookiePayload?.cookies || cookiePayload
if (!Array.isArray(cookies)) throw new Error('Invalid cookie export')
const cookie = cookies.filter(item => String(item.domain || '').endsWith('line.biz'))
  .map(item => `${item.name}=${item.value}`).join('; ')
if (!cookie) throw new Error('No LINE Business cookies')
const headers = { cookie, referer: `https://chat.line.biz/${bot}`,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`
const psql = sql => {
  const result = spawnSync('docker', ['exec', '-i', 'supabase-db', 'psql', '-U', 'postgres',
    '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '\t'],
  { input: sql, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || 'Database error')
  return result.stdout.trim()
}
const getJson = async url => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
      if (response.status === 401 || response.status === 403) throw new Error(`LINE session rejected (HTTP ${response.status})`)
      if (response.ok) return response.json()
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Error(`LINE OA HTTP ${response.status}`)
      }
    } catch (error) {
      if (String(error.message).includes('session rejected') || attempt === 3) throw error
    }
    await sleep(1000 * 2 ** attempt)
  }
}

const knownRows = psql(`select chat_id,coalesce(floor(extract(epoch from source_updated_at)*1000)::bigint::text,'0'),
  scan_complete from connect_private.line_oa_chat_archive where bot_id=${quote(bot)};`)
const known = new Map(knownRows.split('\n').filter(Boolean).map(row => {
  const [id, updated, complete] = row.split('\t')
  return [id, { updated: updated ? Number(updated) : null, complete: complete === 't' }]
}))
const ownersBody = await getJson(`https://chat.line.biz/api/v1/bots/${bot}/owners`)
const owners = new Map((ownersBody.list || []).map(owner => [owner.bizId, owner.name || '']))

const chats = []
let next = null
let pages = 0
do {
  const query = new URLSearchParams({ folderType: 'ALL', tagIds: '', autoTagIds: '',
    limit: '25', prioritizePinnedChat: 'true' })
  if (next) query.set('next', next)
  const body = await getJson(`https://chat.line.biz/api/v2/bots/${bot}/chats?${query}`)
  chats.push(...(body.list || []))
  next = body.next || null
  pages += 1
  if (pages % 20 === 0) console.log(JSON.stringify({ roster_pages: pages, roster_chats: chats.length }))
  if (next && pages >= 500) throw new Error('LINE OA chat page limit reached')
  if (next) await sleep(75)
} while (next)

// Oldest first gives the requested historical backfill priority. The saved
// scan_complete/source_updated_at pair makes reruns resumable and incremental.
if (!newestFirst) chats.reverse()
let selected = 0
let skipped = 0
let complete = 0
let failed = 0
let eventsArchived = 0
for (const chat of chats) {
  const sourceUpdatedMs = Number(chat.updatedAt) || 0
  const previous = known.get(chat.chatId)
  if (!force && previous?.complete && previous.updated === sourceUpdatedMs) {
    skipped += 1
    continue
  }
  if (maxChats && selected >= maxChats) break
  selected += 1
  if (apply) {
    psql(`insert into connect_private.line_oa_chat_archive
      (bot_id,chat_id,profile_name,profile_user_id,source_updated_at,scan_complete)
      values (${quote(bot)},${quote(chat.chatId)},${quote(chat.profile?.name || '')},
        ${quote(chat.profile?.userId || null)},to_timestamp(${sourceUpdatedMs}/1000.0),false)
      on conflict (bot_id,chat_id) do update set
        profile_name=excluded.profile_name,profile_user_id=excluded.profile_user_id,
        source_updated_at=excluded.source_updated_at,scan_complete=false;`)
  }
  try {
    let backward = null
    let messagePages = 0
    let eventCount = 0
    do {
      const suffix = backward ? `?backward=${encodeURIComponent(backward)}` : ''
      const body = await getJson(`https://chat.line.biz/api/v3/bots/${bot}/chats/${chat.chatId}/messages${suffix}`)
      const events = (body.list || []).filter(event => event.type !== 'chatRead' && Number.isFinite(Number(event.timestamp)))
      eventCount += events.length
      if (apply && events.length) {
        for (let index = 0; index < events.length; index += 100) {
          const records = events.slice(index, index + 100).map(event => {
            const raw = JSON.stringify(event)
            return {
              event_key: event.message?.id ? `message:${event.message.id}`
                : `hash:${createHash('sha256').update(raw).digest('hex')}`,
              event_type: event.type,
              event_at: new Date(Number(event.timestamp)).toISOString(),
              message_type: event.message?.type || null,
              text_content: event.message?.type === 'text' ? event.message.text || '' : null,
              owner_biz_id: event.type === 'messageSent' ? event.bizId || null : null,
              owner_name: event.type === 'messageSent' ? owners.get(event.bizId) || null : null,
              raw: event,
            }
          })
          psql(`insert into connect_private.line_oa_event_archive
            (bot_id,chat_id,event_key,event_type,event_at,message_type,text_content,owner_biz_id,owner_name,raw)
            select ${quote(bot)},${quote(chat.chatId)},x.event_key,x.event_type,x.event_at,
              x.message_type,x.text_content,x.owner_biz_id,x.owner_name,x.raw
              from jsonb_to_recordset(${quote(JSON.stringify(records))}::jsonb)
                as x(event_key text,event_type text,event_at timestamptz,message_type text,
                     text_content text,owner_biz_id text,owner_name text,raw jsonb)
            on conflict (bot_id,chat_id,event_key) do nothing;`)
        }
      }
      backward = body.backward || null
      messagePages += 1
      if (backward && messagePages >= 500) throw new Error('message page limit reached')
      if (backward) await sleep(75)
    } while (backward)
    if (apply) {
      psql(`update connect_private.line_oa_chat_archive set scan_complete=true,
        last_scanned_at=now(),event_count=${eventCount}
        where bot_id=${quote(bot)} and chat_id=${quote(chat.chatId)};`)
    }
    complete += 1
    eventsArchived += eventCount
  } catch (error) {
    failed += 1
    console.error(`chat scan failed (${chat.chatId}): ${error.message}`)
    if (String(error.message).includes('session rejected')) throw error
  }
  if (selected % 25 === 0) console.log(JSON.stringify({ scanned: selected, complete, failed, skipped, events: eventsArchived }))
  await sleep(75)
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', source_chats: chats.length,
  selected, complete, failed, skipped, source_events: eventsArchived }))
if (failed) process.exitCode = 1
