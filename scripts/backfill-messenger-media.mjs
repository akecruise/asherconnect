#!/usr/bin/env node
/**
 * Backfill รูป/ไฟล์แนบ Messenger ที่หายไปก่อนมีท่อสื่อ (sql/037)
 *
 * หลัก: URL ใน webhook เดิมถูกทิ้งตั้งแต่ขั้นรับเข้า ทางเดียวที่เหลือคือ
 * ดึง attachments ใหม่ผ่าน Graph API ด้วย mid (external_message_id) ที่เก็บไว้ได้
 *   GET https://graph.facebook.com/v21.0/{mid}?fields=attachments{id,mime_type,size,url}&access_token=<page token>
 * Meta ให้ URL ชุดใหม่ถ้าข้อความยังอยู่ — ข้อความที่ถูกลบ/เพจเปลี่ยนแอปจะกู้ไม่ได้
 *
 * วิธีรัน (dry-run เป็นค่าตั้งต้น — แค่สำรวจว่ากู้คืนได้ก้อน ไม่เขียนอะไรทั้งสิ้น):
 *   node --env-file=.env scripts/backfill-messenger-media.mjs \
 *     --db "$DATABASE_URL"          # หรือ export DATABASE_URL เอง
 * เขียนจริง:
 *   ... เดิม + --apply
 *
 * ต้องมี: DATABASE_URL (psql), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (อัปโหลด Storage)
 * token เพจอ่านจาก channels.json ของ channel messenger เท่านั้น (กติกาเดียวกับ server)
 *
 * ★ ห้าม log URL ของไฟล์ — มีแต่ mid, สถานะ และจำนวนไบต์
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { storagePath, MEDIA_MAX_BYTES } from '../lib/media.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const dbAt = argv.indexOf('--db')
const DB = dbAt > -1 ? argv[dbAt + 1] : process.env.DATABASE_URL || ''
const upstream = process.env.SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY

const channelsPath = join(HERE, '..', 'channels.json')
const channels = JSON.parse(readFileSync(process.env.CONNECT_CHANNELS_FILE || channelsPath, 'utf8'))
const messenger = channels.find(c => c.channel === 'messenger' && c.enabled === true && c.access_token)
if (!messenger) { console.error('ไม่มี channel messenger ที่ enabled และมี access_token ใน channels.json'); process.exit(1) }
if (!DB) { console.error('ต้องมี --db หรือ DATABASE_URL'); process.exit(1) }
if (APPLY && (!upstream || !service)) { console.error('--apply ต้องมี SUPABASE_URL กับ SUPABASE_SERVICE_ROLE_KEY ด้วย'); process.exit(1) }

const psql = args => execFileSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const rows = psql(['-A', '-t', '-F', '\t', '-c', `
  select m.id::text, m.conversation_id::text, m.external_message_id
    from inbox.message m
    join inbox.conversation c on c.id = m.conversation_id
    join inbox.inbox i on i.id = c.inbox_id
   where i.channel = 'messenger'
     and m.content_type in ('attachment', 'image', 'video', 'audio', 'file')
     and m.media is null
     and m.external_message_id like 'm\\_%'
   order by m.created_at`]).trim()

const candidates = rows ? rows.split('\n').map(l => l.split('\t')) : []
console.log(`ข้อความ Messenger ที่มีสื่อแต่ไม่มีไฟล์: ${candidates.length} ข้อความ${APPLY ? '' : ' (โหมดสำรวจ — ไม่เขียนอะไร)'}`)

let recovered = 0, expired = 0, failed = 0
for (const [messageId, , mid] of candidates) {
  await sleep(300)   // กันโควตา Graph API
  let attachments
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${mid}?fields=attachments{id,mime_type,size,url}&access_token=${messenger.access_token}`)
    const body = await r.json()
    if (body.error) throw new Error(body.error.message?.slice(0, 60) || `graph_${r.status}`)
    attachments = (body.attachments?.data || []).filter(a => a.url && a.mime_type !== 'image/svg+xml')
  } catch (e) {
    expired += 1
    console.log(`  กู้ไม่ได้ ${mid} · ${e.message}`)
    continue
  }
  if (!attachments.length) { expired += 1; continue }

  const media = []
  for (let n = 0; n < attachments.length; n += 1) {
    const a = attachments[n]
    try {
      const res = await fetch(a.url)
      if (!res.ok) throw new Error(`http_${res.status}`)
      const mime = (res.headers.get('content-type') || a.mime_type || '').split(';')[0].trim().toLowerCase()
      const bytes = Buffer.from(await res.arrayBuffer())
      if (!bytes.length || bytes.length > MEDIA_MAX_BYTES) throw new Error(`size_${bytes.length}`)
      const path = storagePath(messenger.inbox_id, messageId, n + 1, mime)
      if (APPLY) {
        const up = await fetch(`${upstream}/storage/v1/object/inbox-media/${path}`, {
          method: 'POST',
          headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': mime, 'x-upsert': 'true' },
          body: bytes,
        })
        if (!up.ok) throw new Error(`storage_${up.status}`)
      }
      media.push({ path, mime, bytes: bytes.length })
    } catch (e) {
      failed += 1
      console.log(`  ดึง/ฝากไฟล์ไม่สำเร็จ ${mid} · ${e.message}`)
    }
  }
  if (media.length) {
    recovered += 1
    if (APPLY) {
      psql(['-c', `select connect_private.media_attach('${messageId}'::uuid, '${JSON.stringify(media).replace(/'/g, "''")}'::jsonb)`])
      console.log(`  เก็บแล้ว ${messageId} · ${media.length} ไฟล์`)
    } else {
      console.log(`  กู้ได้ ${messageId} · ${media.length} ไฟล์`)
    }
  }
}

console.log(`\nสรุป: รวม ${candidates.length} · กู้ได้ ${recovered} · หมดอายุ ${expired} · ไฟล์พลาด ${failed}`)
if (!APPLY && candidates.length) console.log('ถ้าตัวเลขน่าเชื่อถือแล้ว รันซ้ำด้วย --apply เพื่อเขียนจริง')
