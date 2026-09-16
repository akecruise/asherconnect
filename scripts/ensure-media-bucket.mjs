#!/usr/bin/env node
/**
 * สร้าง bucket inbox-media (private) ของท่อสื่อแนบ — idempotent รันซ้ำได้
 *
 * วิธีรัน:
 *   node --env-file=.env scripts/ensure-media-bucket.mjs
 *   (ต้องมี SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ใน env)
 *
 * ★ bucket เป็น private เสมอ — รูปลูกค้าอาจมีเอกสารส่วนตัว ห้าม public
 *   การอ่านไฟล์ผ่านทางเดียวคือ GET /media/<path> ของ server.mjs ซึ่งตรวจเซสชันก่อน
 *   เพดานขนาดไฟล์ 25 MB ต้องตรงกับ MEDIA_MAX_BYTES ใน lib/media.mjs
 */

const upstream = process.env.SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!upstream || !service) {
  console.error('ต้องมี SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY — รันผ่าน node --env-file=.env')
  process.exit(1)
}

const BUCKET = 'inbox-media'
const headers = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }

// เช็คก่อนสร้าง — ถ้ามีอยู่แล้วให้รายงานสถานะของเดิม ไม่จำเป็นต้องแก้อะไร
const existing = await fetch(`${upstream}/storage/v1/bucket/${BUCKET}`, { headers })
if (existing.ok) {
  const info = await existing.json()
  console.log(`bucket ${BUCKET} มีอยู่แล้ว · public=${info.public} · file_size_limit=${info.file_size_limit ?? 'ไม่จำกัด'}`)
  if (info.public) {
    console.error('★ bucket เป็น public — ขัดกับที่ออกแบบไว้ ตรวจว่าใครเปลี่ยนและเปลี่ยนคืน')
    process.exit(1)
  }
  process.exit(0)
}

const created = await fetch(`${upstream}/storage/v1/bucket`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    id: BUCKET,
    name: BUCKET,
    public: false,
    file_size_limit: 25 * 1024 * 1024,
    allowed_mime_types: ['image/*', 'video/*', 'audio/*', 'application/pdf'],
  }),
})
if (!created.ok) {
  console.error(`สร้าง bucket ไม่สำเร็จ HTTP ${created.status}:`, (await created.text()).slice(0, 300))
  process.exit(1)
}
console.log(`สร้าง bucket ${BUCKET} แล้ว · private · จำกัด 25 MB · เฉพาะ image/video/audio/pdf`)
