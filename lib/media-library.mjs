import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { safeMediaPath } from './media.mjs'

// คลังรูปของ Sales Workspace (docs/quick-reply/PLAN.md)
// ด่านสิทธิ์ทั้งหมดอยู่ในฐาน (inbox.media_*) — ที่นี่แค่ย้ายไฟล์ใน storage
// และยิงด้วย token ของคนที่ล็อกอิน ไม่ใช่ service key

// โฟลเดอร์ใน bucket inbox-media สำหรับรูปคลังที่อัปโหลดผ่านหน้าเว็บ
// ต้องเป็น uuid เพราะ safeMediaPath รับเฉพาะ <uuid>/<uuid>[-n].ext
export const LIBRARY_FOLDER = '6f1c2a7e-3b1d-4d8e-9a55-5c0de1ba1b00'
export const LIBRARY_MAX_BYTES = 10 * 1024 * 1024
export const LIBRARY_PREVIEW_MAX_BYTES = 1024 * 1024
export const LIBRARY_CATEGORIES = ['room', 'plan', 'facility', 'exterior', 'location', 'promo', 'other']
export const LIBRARY_PROJECTS = ['naii', 'vibe', 'all']
export const SEND_IMAGE_LIMIT = 5

// ข้อความภาษาไทยของ error เหล่านี้ตั้งใจให้ถึงหน้าจอเซลส์ (status 400)
const bad = message => Object.assign(new Error(message), { status: 400 })

const mimeFromBytes = bytes => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  return null
}

// เบราว์เซอร์แปลง WEBP/HEIC เป็น JPEG และย่อ preview ให้แล้ว (image ไม่มี sharp — ตั้งใจ zero-dependency)
// ที่นี่ตรวจซ้ำจาก magic bytes เพราะเชื่อ type ที่เบราว์เซอร์บอกไม่ได้
export function decodeLibraryImage(file, maxBytes, label = 'รูป') {
  if (!file || typeof file.data !== 'string') throw bad(`${label}: รูปแบบไฟล์ไม่ถูกต้อง`)
  const bytes = Buffer.from(file.data, 'base64')
  if (!bytes.length) throw bad(`${label}: ไฟล์ว่าง`)
  if (bytes.length > maxBytes) throw bad(`${label}: ใหญ่เกิน ${Math.round(maxBytes / 1024 / 1024 * 10) / 10} MB`)
  const mime = mimeFromBytes(bytes)
  if (!mime) throw bad(`${label}: รับเฉพาะ JPG หรือ PNG`)
  const width = Number.isInteger(file.width) && file.width > 0 ? file.width : null
  const height = Number.isInteger(file.height) && file.height > 0 ? file.height : null
  return { bytes, mime, ext: mime === 'image/png' ? 'png' : 'jpg', width, height }
}

const text = (value, max) => String(value ?? '').trim().slice(0, max)

export function libraryMeta(data) {
  const title = text(data.title, 160)
  if (!title) throw bad('กรุณาตั้งชื่อรูป')
  const project = text(data.project, 10).toLowerCase() || 'all'
  if (!LIBRARY_PROJECTS.includes(project)) throw bad('โครงการไม่ถูกต้อง')
  const category = text(data.category, 20) || 'other'
  if (!LIBRARY_CATEGORIES.includes(category)) throw bad('หมวดไม่ถูกต้อง')
  let expires_at = null
  if (data.expires_at) {
    const at = new Date(data.expires_at)
    if (Number.isNaN(at.getTime())) throw bad('วันหมดอายุไม่ถูกต้อง')
    expires_at = at.toISOString()
  }
  return { title, project, category, expires_at, bot_enabled: data.bot_enabled === true }
}

// รายการรูปที่จะส่งในข้อความเดียว: ลำดับตามที่เซลส์เลือก ปนกันได้ระหว่างรูปคลังกับไฟล์ที่แนบเอง
// order: ['m:<asset id>', 'f:<index ของ files>', ...] — ไม่ส่งมา = รูปคลังก่อน ตามด้วยไฟล์
export function planSendItems({ mediaIds = [], fileCount = 0, order } = {}) {
  const ids = [...new Set((Array.isArray(mediaIds) ? mediaIds : []).map(String))]
  if (ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw bad('รูปคลังไม่ถูกต้อง')
  const defaults = [...ids.map(id => `m:${id}`), ...Array.from({ length: fileCount }, (_, i) => `f:${i}`)]
  const plan = Array.isArray(order) && order.length ? order.map(String) : defaults
  const sorted = [...plan].sort(), expected = [...defaults].sort()
  if (sorted.length !== expected.length || sorted.some((v, i) => v !== expected[i])) throw bad('ลำดับรูปไม่ตรงกับรูปที่แนบ')
  if (plan.length > SEND_IMAGE_LIMIT) throw bad(`แนบรูปได้สูงสุด ${SEND_IMAGE_LIMIT} รูปต่อครั้ง`)
  return plan.map(token => token.startsWith('m:') ? { kind: 'media', id: token.slice(2) } : { kind: 'file', index: Number(token.slice(2)) })
}

export function createMediaLibrary({ rpcDirect, uploadObject, copyObject, fetchObject, origin, fail, newId = randomUUID }) {
  async function upload(token, data) {
    const meta = libraryMeta(data)
    const image = decodeLibraryImage(data.file, LIBRARY_MAX_BYTES, 'รูป')
    const preview = data.preview ? decodeLibraryImage(data.preview, LIBRARY_PREVIEW_MAX_BYTES, 'ภาพย่อ') : null
    const id = newId()
    const storage_path = `${LIBRARY_FOLDER}/${id}.${image.ext}`
    const preview_path = preview ? `${LIBRARY_FOLDER}/${id}-2.${preview.ext}` : null
    await uploadObject(storage_path, { bytes: image.bytes, type: image.mime })
    if (preview) await uploadObject(preview_path, { bytes: preview.bytes, type: preview.mime })
    // public_url ต้องเป็น https ตาม CHECK ของตารางเดิม — ใช้เป็นที่อยู่ในหน้าเว็บเท่านั้น
    // ตัวที่ LINE/Meta ดึงจริงคือ URL ชั่วคราวที่ worker สร้างตอนส่ง (ท่อ media เดิม)
    const base = new URL(origin).origin.replace(/^http:/, 'https:')
    return rpcDirect(token, 'media_create', { p_data: {
      id, ...meta, storage_path, preview_path, mime: image.mime,
      width: image.width, height: image.height, bytes: image.bytes.length,
      public_url: `${base}/library-media/${storage_path}`,
      preview_url: preview_path ? `${base}/library-media/${preview_path}` : null,
    } })
  }

  async function command(token, action, data) {
    if (action === 'media_library_list') return rpcDirect(token, 'media_list', {
      p_project: text(data.project, 10) || null, p_category: text(data.category, 20) || null,
      p_query: text(data.q, 100) || null, p_sort: data.sort === 'recent' ? 'recent' : 'freq',
      p_conversation_id: /^[0-9a-f-]{36}$/i.test(data.conversation_id || '') ? data.conversation_id : null,
      p_scope: data.scope === 'manage' ? 'manage' : 'library',
    })
    if (action === 'media_library_upload') return upload(token, data)
    if (action === 'media_library_update') {
      const patch = {}
      if (data.title !== undefined) patch.title = text(data.title, 160)
      if (data.project !== undefined) patch.project = libraryMeta({ title: 'x', project: data.project }).project
      if (data.category !== undefined) patch.category = libraryMeta({ title: 'x', category: data.category }).category
      if (data.expires_at !== undefined) patch.expires_at = data.expires_at ? libraryMeta({ title: 'x', expires_at: data.expires_at }).expires_at : ''
      if (data.bot_enabled !== undefined) patch.bot_enabled = data.bot_enabled === true
      if (data.status !== undefined) patch.status = data.status === 'approved' ? 'approved' : 'pending'
      return rpcDirect(token, 'media_update', { p_id: data.id, p_data: patch })
    }
    if (action === 'media_library_archive') return rpcDirect(token, 'media_archive', { p_id: data.id })
    // ห้องว่าง/ราคาสดจาก Asher CRM (inbox.unit_availability)
    if (action === 'media_library_units') return rpcDirect(token, 'unit_availability', { p_project: text(data.project, 20) || null })
    return undefined
  }

  // เรียกก่อนสร้างข้อความ: ตรวจสิทธิ์รูปคลังทุกใบ (ฐานคืนเฉพาะที่ใช้ได้)
  async function resolve(token, mediaIds) {
    if (!mediaIds.length) return new Map()
    const rows = await rpcDirect(token, 'media_get', { p_ids: mediaIds })
    const byId = new Map((Array.isArray(rows) ? rows : []).map(row => [row.id, row]))
    const missing = mediaIds.filter(id => !byId.has(id))
    if (missing.length) throw fail(409, 'รูปบางรูปถูกนำออกจากคลังหรือหมดอายุแล้ว กรุณาเลือกใหม่')
    return byId
  }

  // หลังได้ message_id: คัดลอกรูปคลังภายใน storage ไปไว้ที่ path ของข้อความ
  // ท่อ media เดิม (media_attach → worker ลงชื่อ URL → provider) จึงทำงานเหมือนไฟล์แนบปกติ
  // และหน้าแชตแสดงรูปผ่าน /media/ ด้วยสิทธิ์ของบทสนทนาเดิม ไม่ต้องอัปโหลดซ้ำจากเบราว์เซอร์
  async function materialize({ plan, assets, files, inboxId, messageId, storagePath }) {
    const media = []
    for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index]
      if (item.kind === 'media') {
        const asset = assets.get(item.id)
        const path = storagePath(inboxId, messageId, index + 1, asset.mime)
        await copyObject(asset.storage_path, path)
        media.push({ path, mime: asset.mime, bytes: Number(asset.bytes) || undefined, library_id: asset.id })
      } else {
        const file = files[item.index]
        const path = storagePath(inboxId, messageId, index + 1, file.mime)
        await uploadObject(path, { bytes: file.bytes, type: file.mime })
        media.push({ path, mime: file.mime, bytes: file.bytes.length })
      }
    }
    return media
  }

  async function handleFile(req, res, url, token) {
    if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'method_not_allowed')
    const path = safeMediaPath(url.pathname.slice('/library-media/'.length))
    if (!path || !/\.(jpg|png)$/i.test(path)) throw fail(404, 'not_found')
    if (!await rpcDirect(token, 'media_path_allowed', { p_path: path })) throw fail(404, 'not_found')
    const response = await fetchObject(path)
    if (!response.ok || !response.body) throw fail(404, 'not_found')
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!/^image\/(jpeg|png)$/.test(mime)) throw fail(415, 'unsupported_media')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': 'inline' })
    if (req.method === 'HEAD') { await response.body.cancel(); return res.end() }
    await pipeline(Readable.fromWeb(response.body), res)
  }

  return { command, resolve, materialize, handleFile }
}
