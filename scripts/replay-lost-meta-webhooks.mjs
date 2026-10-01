#!/usr/bin/env node
/**
 * Replay Meta webhook_log payloads whose events were dropped by receive_event
 * (IDENTITY_UNRESOLVED, missing page_id) between 2026-09-28 and 2026-09-30.
 *
 * Reads webhook_log rows as JSON on stdin, prints a psql script on stdout.
 * Nothing is written by this script itself; the generated SQL ends in
 * ROLLBACK unless --apply is given.
 *
 * Safety rules baked into the SQL:
 *   - only events that already have an orphan inbound_event row
 *     (message_id is null, inside --since/--until) are replayed; anything
 *     else is reported as skipped, so reruns are idempotent
 *   - is_admin=true and every job created for a replayed message is deleted,
 *     so the bot does not answer and the team is not notified days later
 *   - last_message_at/preview is recomputed afterwards because the
 *     sync_conversation trigger copies created_at of the inserted (old) row
 *
 * On the VPS host (from /opt/asher-inbox/app):
 *   docker exec supabase-db psql -U postgres -Atc "select coalesce(json_agg(json_build_object('id',id,'payload',payload) order by id),'[]') from connect_private.webhook_log where channel_key='asher-messenger' and received_at >= '2026-09-28 09:00' and received_at < '2026-09-30 16:59'" > /tmp/lost.json
 *   node scripts/replay-lost-meta-webhooks.mjs --channel-key=asher-messenger --since='2026-09-28 09:00+00' --until='2026-09-30 16:59+00' < /tmp/lost.json > /tmp/replay.sql
 *   docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 < /tmp/replay.sql
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeWebhook } from '../providers.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const value = name => argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null
const APPLY = argv.includes('--apply')
const KEY = value('channel-key')
const SINCE = value('since')
const UNTIL = value('until')
const CHANNELS = value('channels') || join(HERE, '..', 'channels.json')

if (!KEY || !SINCE || !UNTIL) {
  console.error('ต้องระบุ --channel-key --since --until')
  process.exit(1)
}

const lit = v => `'${String(v).replaceAll("'", "''")}'`

export function channelConfig(raw, key) {
  const list = Array.isArray(raw) ? raw : Object.entries(raw.channels ?? raw).map(([k, v]) => ({ key: k, ...v }))
  const hit = list.find(c => c.key === key) ??
    list.find(c => key === 'asher-messenger' && c.channel === 'messenger')
  if (!hit) throw new Error(`ไม่พบช่องทาง ${key} ใน channels.json`)
  // เอาเฉพาะที่ normalizer ใช้ — ไม่แตะ token
  return { key, channel: hit.channel, inbox_id: hit.inbox_id, account_id: String(hit.account_id) }
}

export function buildSql(rows, config, { since, until, apply }) {
  const events = []
  for (const row of rows) {
    for (const event of normalizeWebhook(config.channel, row.payload, config)) {
      if (!event.event_id) continue
      events.push({ ...event, is_admin: true, _log_id: row.id })
    }
  }
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id))

  const inbox = lit(config.inbox_id)
  const out = [
    '\\set ON_ERROR_STOP on',
    'begin;',
    'create temp table replay_result(log_id bigint, event_id text, event_type text, result jsonb) on commit drop;',
  ]
  for (const e of events) {
    const { _log_id, ...event } = e
    const eid = lit(event.event_id)
    out.push(`do $r$ declare v jsonb; begin
  if exists (select 1 from connect_private.inbound_event where inbox_id=${inbox} and event_id=${eid}
              and message_id is null and received_at >= ${lit(since)} and received_at < ${lit(until)}) then
    delete from connect_private.inbound_event where inbox_id=${inbox} and event_id=${eid} and message_id is null;
    v := connect_private.receive(${lit(JSON.stringify(event))}::jsonb);
    if v->>'message_id' is not null then
      delete from connect_private.job where message_id=(v->>'message_id')::uuid;
    end if;
  else
    v := '{"skipped":"not_orphan"}';
  end if;
  insert into replay_result values (${_log_id}, ${eid}, ${lit(event.event_type)}, v);
end $r$;`)
  }
  out.push(`update inbox.conversation c
   set last_message_at = m.created_at, last_message_preview = left(m.content, 240)
  from (select distinct on (conversation_id) conversation_id, created_at, content
          from inbox.message
         where conversation_id in (select (result->>'id')::uuid from replay_result where result ? 'id')
         order by conversation_id, created_at desc) m
 where c.id = m.conversation_id;`)
  out.push(`select event_type,
       case when result ? 'skipped' then 'skipped'
            when result ? 'error' then 'error:' || (result->>'error') || ':' || coalesce(result->>'reason','')
            when result->>'duplicate' = 'true' then 'duplicate'
            when result->>'message_id' is not null then 'stored'
            else 'no_message' end as outcome,
       count(*)
  from replay_result group by 1, 2 order by 1, 2;`)
  out.push(`select 'jobs_left_for_replayed_messages', count(*) from connect_private.job
 where message_id in (select (result->>'message_id')::uuid from replay_result where result->>'message_id' is not null);`)
  out.push(`select 'deliveries_queued', count(*) from connect_private.delivery
 where message_id in (select (result->>'message_id')::uuid from replay_result where result->>'message_id' is not null);`)
  out.push(apply ? 'commit;' : 'rollback;')
  return { sql: out.join('\n') + '\n', count: events.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = JSON.parse(readFileSync(0, 'utf8') || '[]')
  const config = channelConfig(JSON.parse(readFileSync(CHANNELS, 'utf8')), KEY)
  const { sql, count } = buildSql(rows, config, { since: SINCE, until: UNTIL, apply: APPLY })
  process.stdout.write(sql)
  console.error(`webhook_log ${rows.length} แถว → ${count} event · โหมด ${APPLY ? 'APPLY (commit)' : 'preview (rollback)'}`)
}
