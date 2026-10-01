#!/usr/bin/env node
/** Read-only: compare CRM LINE names with the current official Messaging API profile. */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const config = JSON.parse(readFileSync('/opt/asher-inbox/app/channels.json', 'utf8'))
const channels = Array.isArray(config) ? config : config.channels || []
const line = channels.find(channel => channel.channel === 'line' && channel.enabled)
if (!line?.access_token || !/^[0-9a-f-]{36}$/i.test(line.inbox_id)) throw new Error('LINE channel is unavailable')
const rows = execFileSync('docker', ['exec', 'supabase-db', 'psql', '-U', 'postgres', '-d', 'postgres',
  '-X', '-t', '-A', '-F', '\t', '-c', `
    select ci.external_id,coalesce(ct.display_name,'')
      from core.contact_identity ci
      join core.contact ct on ct.id=ci.contact_id
      join inbox.conversation c on c.contact_id=ct.id and c.inbox_id='${line.inbox_id}'::uuid
     where ci.channel='line' and ci.account_key='${line.inbox_id}'
       and ci.external_id ~ '^U[0-9a-f]{32}$'
       and not exists(select 1 from inbox.message m where m.conversation_id=c.id and m.sender_type='contact')
     order by ci.external_id`], { encoding: 'utf8' }).trim()
for (const row of rows.split('\n').filter(Boolean)) {
  const [id, oldName] = row.split('\t')
  const response = await fetch(`https://api.line.me/v2/bot/profile/${id}`, {
    headers: { authorization: `Bearer ${line.access_token}` },
    signal: AbortSignal.timeout(15_000),
  })
  const profile = response.ok ? await response.json() : null
  console.log(JSON.stringify({ id, oldName, status: response.status,
    currentName: profile?.displayName || null }))
}
