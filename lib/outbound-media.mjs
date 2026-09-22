export const OUTBOUND_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const OUTBOUND_IMAGE_LIMIT = 2
export const OUTBOUND_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
export const OUTBOUND_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp'])

const mimeFromBytes = bytes => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function validateOutboundImages(files) {
  if (!Array.isArray(files) || files.length === 0) return []
  if (files.length > OUTBOUND_IMAGE_LIMIT) throw new Error('แนบรูปได้สูงสุด 2 รูปต่อครั้ง')
  return files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.data !== 'string') throw new Error('รูปแบบไฟล์ไม่ถูกต้อง')
    const name = String(file.name || '')
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
    if (!OUTBOUND_IMAGE_EXTENSIONS.has(extension)) throw new Error('รองรับเฉพาะไฟล์ JPG, JPEG, PNG และ WEBP เท่านั้น')
    let bytes
    try { bytes = Buffer.from(file.data, 'base64') } catch { throw new Error('ไฟล์รูปไม่ถูกต้อง') }
    if (!bytes.length || bytes.length > OUTBOUND_IMAGE_MAX_BYTES) throw new Error('รูปแต่ละไฟล์ต้องมีขนาดไม่เกิน 10 MB')
    const mime = mimeFromBytes(bytes)
    if (!mime || !OUTBOUND_IMAGE_MIMES.has(mime)) throw new Error('ไฟล์ไม่ใช่รูป JPG, PNG หรือ WEBP ที่ถูกต้อง')
    if ((extension === 'jpg' || extension === 'jpeg') && mime !== 'image/jpeg') throw new Error('นามสกุลไฟล์ไม่ตรงกับชนิดรูปจริง')
    if (extension === 'png' && mime !== 'image/png') throw new Error('นามสกุลไฟล์ไม่ตรงกับชนิดรูปจริง')
    if (extension === 'webp' && mime !== 'image/webp') throw new Error('นามสกุลไฟล์ไม่ตรงกับชนิดรูปจริง')
    return { bytes, mime, name }
  })
}
