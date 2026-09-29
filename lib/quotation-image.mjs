// รูปใบเสนอราคาเป็นของตายตัวต่อหนึ่งเลขใบ — ดึงจาก CRM ครั้งเดียวแล้วเก็บไว้ใน inbox-media
// หลังจากนั้น LINE/Messenger/หน้าแชทดึงรูปจากที่เก็บตรง ๆ ไม่ต้องให้ CRM สร้างรูปซ้ำทุกครั้ง

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export const quotationImagePath = id => {
  if (!UUID.test(String(id))) throw new Error('invalid_quotation_id')
  return `quotation/${String(id).toLowerCase()}.png`
}

export const isPng = bytes => Buffer.isBuffer(bytes) && bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE)

/**
 * readObject(path)  → Buffer | null (null = ยังไม่มีในที่เก็บ)
 * writeObject(path, bytes)
 * fetchFromCrm(id)  → Buffer (throw ถ้า CRM ไม่มีรูป)
 */
export function createQuotationImageStore({ readObject, writeObject, fetchFromCrm, log = { warn () {} } }) {
  const pending = new Map()

  async function readStored (path) {
    try {
      const bytes = await readObject(path)
      return isPng(bytes) ? bytes : null
    } catch (e) {
      // ที่เก็บล่มไม่ควรทำให้ลูกค้าไม่เห็นรูป — ถอยไปดึงจาก CRM แทน
      log.warn('quotation_image_read_failed', { reason: e.message })
      return null
    }
  }

  async function fetchAndStore (id, path) {
    const bytes = await fetchFromCrm(id)
    if (!isPng(bytes)) throw new Error('quotation_image_not_png')
    try { await writeObject(path, bytes) } catch (e) { log.warn('quotation_image_store_failed', { reason: e.message }) }
    return bytes
  }

  // LINE ดึง originalContentUrl กับ previewImageUrl (URL เดียวกัน) พร้อมกัน — รวมเป็นงานเดียว
  const once = (key, run) => {
    if (pending.has(key)) return pending.get(key)
    const job = run().finally(() => pending.delete(key))
    pending.set(key, job)
    return job
  }

  // ใช้ทั้งตอนออกใบ (ให้รูปอยู่ในที่เก็บก่อนส่งลิงก์เข้าแชท) และตอนมีคนเปิดรูป
  // ใบเก่าที่ออกก่อนมีที่เก็บจะถูกดึงจาก CRM ครั้งแรกครั้งเดียวแล้วเก็บไว้
  const get = id => {
    const path = quotationImagePath(id)
    return once(path, async () => (await readStored(path)) ?? fetchAndStore(id, path))
  }
  return { get }
}
