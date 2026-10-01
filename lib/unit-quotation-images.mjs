// ใบเสนอราคาสำเร็จรูปต่อห้อง — ทำรอไว้ก่อนใน inbox-media แล้วตอนเซลส์กดก็ส่งได้ทันที ไม่ต้องรอ CRM วาดรูป
// CRM บอก "รุ่น" ของรูปแต่ละห้อง (hash ของทุกอย่างที่อยู่บนรูป) — ราคาหรือแบบห้องเปลี่ยน รุ่นเปลี่ยน ก็ทำรูปใหม่
// รูปรุ่นเก่าไม่ลบ: ลิงก์ที่ส่งหาลูกค้าไปแล้วยังต้องเปิดได้
import { isPng } from './quotation-image.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION = /^[a-f0-9]{16,64}$/
export const UNIT_QUOTE_PREFIX = 'unit-quote-'

// ต้องผ่าน safeOutboundPath (outbound/[a-z0-9-]+.png) เพื่อส่งผ่านลิงก์ /outbound-media/ ที่เซ็นไว้
export function unitQuotationPath (unitId, version) {
  if (!UUID.test(String(unitId))) throw Object.assign(new Error('invalid_unit_id'), { status: 400 })
  if (!VERSION.test(String(version))) throw new Error('invalid_quotation_version')
  return `outbound/${UNIT_QUOTE_PREFIX}${String(unitId).toLowerCase()}-${version}.png`
}

/**
 * listFromCrm()        → [{ id, quotation_version, ... }] ห้องว่างที่มีราคา
 * fetchFromCrm(unitId) → { bytes, version }
 * listStored()         → [path] ไฟล์ outbound/unit-quote-*.png ที่มีอยู่แล้ว
 * writeObject(path, bytes)
 */
export function createUnitQuotationImages ({ listFromCrm, fetchFromCrm, listStored, writeObject, log = { info () {}, warn () {} }, concurrency = 2, maxAgeMs = 2 * 60_000, now = () => Date.now() }) {
  const current = new Map()
  const stored = new Set()
  const pending = new Map()
  let storedLoaded = false
  let refreshedAt = 0
  let refreshing = null

  async function loadStored () {
    if (storedLoaded) return
    try { for (const path of await listStored()) stored.add(path); storedLoaded = true } catch (e) { log.warn('unit_quotation_list_stored_failed', { reason: e.message }) }
  }

  function refresh () {
    refreshing ??= (async () => {
      try {
        const units = await listFromCrm()
        current.clear()
        for (const unit of units) if (UUID.test(String(unit.id)) && VERSION.test(String(unit.quotation_version))) current.set(String(unit.id).toLowerCase(), unit)
        refreshedAt = now()
        return [...current.values()]
      } finally { refreshing = null }
    })()
    return refreshing
  }

  function ensure (unitId, version) {
    const path = unitQuotationPath(unitId, version)
    if (stored.has(path)) return Promise.resolve(path)
    if (pending.has(path)) return pending.get(path)
    const job = (async () => {
      const { bytes, version: rendered } = await fetchFromCrm(unitId)
      if (!isPng(bytes)) throw new Error('unit_quotation_not_png')
      // CRM อาจตอบรุ่นใหม่กว่าที่เรารู้ (ราคาเพิ่งเปลี่ยน) — เก็บตามรุ่นที่วาดจริง
      const actual = unitQuotationPath(unitId, rendered)
      await writeObject(actual, bytes)
      stored.add(actual)
      const unit = current.get(String(unitId).toLowerCase())
      if (unit) current.set(String(unitId).toLowerCase(), { ...unit, quotation_version: rendered })
      return actual
    })().finally(() => pending.delete(path))
    pending.set(path, job)
    return job
  }

  return {
    refresh,
    /** ทำรูปของทุกห้องที่ยังไม่มี — เรียกตอนเปิดเครื่อง ตามรอบ และตอนเซลส์เปิดหน้าต่างเลือกห้อง */
    async warmAll () {
      await loadStored()
      const units = await refresh()
      const missing = units.filter(u => !stored.has(unitQuotationPath(u.id, u.quotation_version)))
      let made = 0, failed = 0
      const queue = [...missing]
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let unit = queue.shift(); unit; unit = queue.shift()) {
          try { await ensure(unit.id, unit.quotation_version); made++ } catch (e) { failed++; log.warn('unit_quotation_prerender_failed', { unit_id: unit.id, reason: e.message }) }
        }
      }))
      if (made || failed) log.info('unit_quotation_prerendered', { total: units.length, made, failed })
      return { total: units.length, made, failed }
    },
    /** ตอนกดส่ง: คืน path ของรูปที่เก็บไว้ (ปกติไม่ต้องเรียก CRM เลย) */
    async pathFor (unitId) {
      const key = String(unitId).toLowerCase()
      unitQuotationPath(key, '0'.repeat(24))
      await loadStored()
      // รายการห้อง/ราคาเก่าเกิน 2 นาที → ขอรายการใหม่ (เร็ว ไม่ใช่การวาดรูป) กันส่งราคาที่เพิ่งเปลี่ยน
      if (!current.has(key) || now() - refreshedAt > maxAgeMs) await refresh()
      const unit = current.get(key)
      if (!unit) throw Object.assign(new Error('unit_unavailable'), { status: 409 })
      return ensure(key, unit.quotation_version)
    },
  }
}
