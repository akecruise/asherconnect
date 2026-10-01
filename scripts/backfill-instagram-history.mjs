#!/usr/bin/env node
/**
 * Backfill retrievable Meta DM history into ASHER Connect.
 *
 * Preview is the default. Add --apply to write through the existing
 * connect_private.receive_event() boundary. Historical imports are marked as
 * admin work so they do not generate bot replies, classifications, or team
 * notifications.
 *
 * Examples:
 *   node --env-file=.env scripts/backfill-instagram-history.mjs
 *   node --env-file=.env scripts/backfill-instagram-history.mjs --apply
 *   node --env-file=.env scripts/backfill-instagram-history.mjs --from=2026-06-01 --limit=50
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const has = flag => argv.includes(flag)
const value = (name, fallback = null) => {
  const prefix = `--${name}=`
  const hit = argv.find(x => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

if (has('--help')) {
  console.log(`Usage: node --env-file=.env scripts/backfill-instagram-history.mjs [options]

Options:
  --apply                 write messages (preview is the default)
  --from=YYYY-MM-DD       inclusive lower bound (default: 2026-06-01)
  --to=YYYY-MM-DD         exclusive upper bound (default: now)
  --limit=N               maximum conversations to inspect
  --conversation=ID       inspect one Meta conversation only
  --channel=CHANNEL       instagram (default) or messenger
  --db=URL                database URL (default: DATABASE_URL)
  --psql-container=NAME   run psql through docker exec (e.g. supabase-db)
`)
  process.exit(0)
}

const APPLY = has('--apply')
const FROM = value('from', '2026-06-01')
const TO = value('to', new Date().toISOString())
const LIMIT = value('limit') == null ? null : Number(value('limit'))
const ONLY_CONVERSATION = value('conversation')
const CHANNEL = value('channel', 'instagram')
const DB = value('db', process.env.DATABASE_URL || '')
const PSQL_CONTAINER = value('psql-container', process.env.PSQL_CONTAINER || '')
const configuredChannelsPath = process.env.CONNECT_CHANNELS_FILE || ''
const wslChannelsPath = configuredChannelsPath.match(/^([A-Za-z]):\\(.*)$/)
  ? `/mnt/${configuredChannelsPath[0].toLowerCase()}/${configuredChannelsPath.slice(3).replaceAll('\\', '/')}`
  : configuredChannelsPath
const channelsPath = existsSync(configuredChannelsPath)
  ? configuredChannelsPath
  : (existsSync(wslChannelsPath) ? wslChannelsPath : join(HERE, '..', 'channels.json'))
const channels = JSON.parse(readFileSync(channelsPath, 'utf8'))
const account = channels.find(c => c.channel === CHANNEL && c.enabled === true && c.access_token)

if (!['instagram', 'messenger'].includes(CHANNEL)) fail('--channel ต้องเป็น instagram หรือ messenger')
if (!account) fail(`ไม่พบ channel ${CHANNEL} ที่ enabled และมี access_token ใน channels.json`)
if (!DB && !PSQL_CONTAINER) fail('ต้องมี --db/DATABASE_URL หรือ --psql-container')
if (!Number.isFinite(Date.parse(FROM))) fail('--from ต้องเป็นวันที่ ISO ที่ถูกต้อง')
if (!Number.isFinite(Date.parse(TO))) fail('--to ต้องเป็นวันที่ ISO ที่ถูกต้อง')
if (LIMIT != null && (!Number.isInteger(LIMIT) || LIMIT < 1)) fail('--limit ต้องเป็นจำนวนเต็มบวก')

const API_VERSION = account.api_version || 'v23.0'
const GRAPH = `https://${CHANNEL === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com'}/${API_VERSION}`
const headers = { Authorization: `Bearer ${account.access_token}` }
const fromTime = Date.parse(FROM)
const toTime = Date.parse(TO)

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function psql(sql) {
  try {
    const args = PSQL_CONTAINER
      ? ['exec', '-i', PSQL_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres']
      : ['psql', DB]
    args.push('-X', '-v', 'ON_ERROR_STOP=1', '-At')
    const useStdin = sql.length > 100000
    args.push(useStdin ? '-f' : '-c', useStdin ? '-' : sql)
    return execFileSync(PSQL_CONTAINER ? 'docker' : 'psql', args, {
      encoding: 'utf8', input: useStdin ? sql : undefined, maxBuffer: 16 * 1024 * 1024,
    }).trim()
  } catch (error) {
    if (error.code === 'ENOENT') fail(PSQL_CONTAINER ? 'ไม่พบคำสั่ง docker' : 'ไม่พบคำสั่ง psql — ติดตั้ง PostgreSQL client หรือใช้ --psql-container=supabase-db')
    throw error
  }
}

function sqlLiteral(value) {
  const text = String(value)
  let tag = '$asher$'
  let n = 1
  while (text.includes(tag)) tag = `$asher${n++}$`
  return `${tag}${text}${tag}`
}

function jsonbLiteral(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`
}

async function getJson(url) {
  let body
  let status = 200
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    status = response.status
    body = await response.json().catch(() => ({}))
  } catch {
    // Some WSL setups expose the network through curl's proxy configuration,
    // while Node's built-in fetch does not inherit that proxy.
    try {
      const raw = execFileSync('curl', ['-sS', '--fail-with-body', '-H', `Authorization: Bearer ${account.access_token}`, url], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      })
      body = JSON.parse(raw)
    } catch (error) {
      const raw = String(error.stdout || '').trim()
      try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
      status = Number(error.status) || 0
      if (!Object.keys(body).length) throw new Error('เชื่อมต่อ Meta API ไม่สำเร็จ')
    }
  }
  if (status < 200 || status >= 300 || body.error) {
    const detail = body.error?.message || `http_${status}`
    throw new Error(`Meta API ${detail.slice(0, 160)}`)
  }
  return body
}

async function collectPages(url, key = 'data', maxRows = null, stopWhen = null) {
  const rows = []
  let next = url
  const visited = new Set()
  let pages = 0
  while (next) {
    if (visited.has(next) || pages++ >= 100) break
    visited.add(next)
    const body = await getJson(next)
    if (Array.isArray(body[key])) rows.push(...body[key])
    if (maxRows != null && rows.length >= maxRows) return rows.slice(0, maxRows)
    if (stopWhen?.(body[key] || [])) break
    next = body.paging?.next || null
  }
  return rows
}

function messageFromApi(row) {
  const created = row.created_time || row.created_at
  const createdMs = Date.parse(created)
  if (!Number.isFinite(createdMs)) return null
  if (createdMs < fromTime || createdMs >= toTime) return null
  const id = row.id || row.message_id
  if (!id) return null
  const sender = String(row.from?.id || '')
  const outbound = sender === String(account.account_id)
  const customer = outbound ? row.to?.data?.[0]?.id : sender
  if (!customer || String(customer) === String(account.account_id)) return null
  const attachments = Array.isArray(row.attachments?.data) ? row.attachments.data : []
  const text = String(row.message || '').trim() ||
    (attachments[0]?.type ? `[แนบ: ${attachments[0].type}]` : '[ข้อความจาก Instagram]')
  return {
    inbox_id: account.inbox_id,
    account_id: String(account.account_id),
    page_id: String(account.account_id),
    platform: CHANNEL,
    customer_psid: String(customer),
    external_id: String(customer),
    occurred_at: new Date(createdMs).toISOString(),
    event_id: String(id),
    event_type: outbound ? 'echo' : 'message',
    app_id: null,
    content_type: text.startsWith('[แนบ:') ? 'attachment' : 'text',
    text,
    is_admin: true,
    attribution: { provider_message_id: String(id), attachments, backfill_channel: CHANNEL },
  }
}

function existingIds(ids) {
  if (!ids.length) return new Set()
  const values = ids.map(sqlLiteral).join(',')
  const out = psql(`select external_message_id from inbox.message where external_message_id in (${values})`)
  return new Set(out ? out.split('\n').filter(Boolean) : [])
}

async function mapLimit(rows, concurrency, worker) {
  const out = []
  let cursor = 0
  async function run() {
    while (cursor < rows.length) {
      const index = cursor++
      out[index] = await worker(rows[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, run))
  return out
}

async function main() {
  const conversationUrl = ONLY_CONVERSATION
    ? `${GRAPH}/${encodeURIComponent(ONLY_CONVERSATION)}?fields=id`
    : `${GRAPH}/${encodeURIComponent(account.account_id)}/conversations` +
      `?${CHANNEL === 'instagram' ? 'platform=instagram&' : ''}limit=100`
  const conversations = ONLY_CONVERSATION
    ? [await getJson(conversationUrl)]
    : await collectPages(conversationUrl, 'data', LIMIT)
  const selected = LIMIT == null ? conversations : conversations.slice(0, LIMIT)
  const events = []
  let conversationErrors = 0

  // Meta's Conversations API is quota-sensitive; keep this sequential so a
  // large import does not turn a temporary limit into dozens of failures.
  const batches = await mapLimit(selected, 1, async conversation => {
    try {
      const url = `${GRAPH}/${encodeURIComponent(conversation.id)}/messages` +
        '?fields=id,created_time,from,to,message,attachments&limit=100'
      const messages = await collectPages(url, 'data', null, page =>
        page.length > 0 && page.every(row => Number.isFinite(Date.parse(row.created_time)) && Date.parse(row.created_time) < fromTime))
      return messages.map(messageFromApi).filter(Boolean)
    } catch (error) {
      conversationErrors += 1
      console.log(`อ่าน conversation ไม่สำเร็จ ${conversation.id}: ${error.message}`)
      return []
    }
  })
  for (const batch of batches) events.push(...batch)

  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id))
  const seen = existingIds(events.map(e => e.event_id))
  const pending = events.filter(e => !seen.has(e.event_id))
  const inbound = pending.filter(e => e.event_type === 'message').length
  const outbound = pending.length - inbound

  console.log(`${CHANNEL} conversations: ${selected.length}`)
  console.log(`เหตุการณ์ที่อ่านได้ในช่วง ${FROM} ถึง ${TO}: ${events.length}`)
  console.log(`มีอยู่แล้ว/ข้าม: ${events.length - pending.length}`)
  console.log(`รอ backfill: ${pending.length} (ลูกค้า ${inbound}, ฝั่งบัญชี ${outbound})`)
  if (conversationErrors) console.log(`conversation ที่อ่านไม่ได้: ${conversationErrors}`)
  if (!APPLY) {
    console.log('โหมด preview — ยังไม่เขียนฐานข้อมูล; ถ้าตรวจแล้วให้รันซ้ำด้วย --apply')
    return
  }

  try {
    // One transaction avoids starting a new docker/psql process per message.
    // The preflight existingIds() query still makes reruns idempotent.
    let imported = 0
    let duplicates = 0
    let failed = 0
    for (let offset = 0; offset < pending.length; offset += 25) {
      const chunk = pending.slice(offset, offset + 25)
      const statements = chunk.map(event =>
        `do $backfill$ declare v_result jsonb; begin
         v_result := connect_private.receive_event(${jsonbLiteral(event)}, ${sqlLiteral(event.occurred_at)}::timestamptz, 0);
         if (v_result->>'message_id' is not null) then
           delete from connect_private.job where message_id=(v_result->>'message_id')::uuid;
         end if;
         end $backfill$;`)
      try {
        const result = psql(`begin;\n${statements.join('\n')}\ncommit;`)
        const rows = result ? result.split('\n').filter(Boolean) : []
        const chunkDuplicates = rows.filter(row => row.includes('"duplicate": true')).length
        duplicates += chunkDuplicates
        imported += rows.length - chunkDuplicates
      } catch {
        // One malformed historical payload must not block the rest of the
        // batch. Retry this small chunk individually and report only its ID.
        for (const event of chunk) {
          try {
            psql(`begin;
              do $backfill$ declare v_result jsonb; begin
                v_result := connect_private.receive_event(${jsonbLiteral(event)}, ${sqlLiteral(event.occurred_at)}::timestamptz, 0);
                if (v_result->>'message_id' is not null) then
                  delete from connect_private.job where message_id=(v_result->>'message_id')::uuid;
                end if;
              end $backfill$;
              commit;`)
            imported += 1
          } catch (error) {
            failed += 1
            console.log(`เขียนไม่สำเร็จ ${event.event_id}: ${error.message.split('\n')[0]}`)
          }
        }
      }
    }
    console.log(`สรุป: เขียนแล้ว ${imported} · ซ้ำ ${duplicates} · ล้มเหลว ${failed}`)
    if (failed) process.exitCode = 2
  } catch (error) {
    console.log(`เขียน transaction ไม่สำเร็จ: ${error.message.split('\n')[0]}`)
    process.exitCode = 2
  }
}

main().catch(error => fail(error.message))

export { messageFromApi }
