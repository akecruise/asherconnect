// render template {{variable}} ของคลังคำตอบ (Answer Knowledge Hub — Phase 5)
// ตัวเดียวที่แปลง values → ข้อความ · zero-dep · ไม่แตะ DB (ดู ARCHITECTURE.md)
//
// หลักการ: ตัวแปร required ที่ยังไม่มีค่า = คืน missing list พร้อมคง {{var}} เดิมไว้ —
// ข้อความที่ยังมี {{}} ค้างต้องไม่ถูกส่งออกไปหาลูกค้า (คนขายเห็นแล้วแก้เอง /
// บอทส่งมนุษย์) ส่วนตัวแปรที่ไม่ได้ประกาศ required ขาด → แทนด้วยค่าว่าง
//
// ค่าที่แทนไม่ถูกสแกนซ้ำ (replace รอบเดียวบนต้นฉบับ) — ค่าที่มี {{ตัวแปร}} ข้างใน
// จะเป็นข้อความตรง ๆ ไม่เกิด recursion

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * @param {string} body  template จาก answer_item.body_template
 * @param {Record<string, string>} values  ค่า resolve แล้ว (จาก ah_resolve .values)
 * @param {{required?: string[]}} opts  ชื่อตัวแปรที่ขาดไม่ได้ (จาก ah_resolve .missing)
 * @returns {{text: string, missing: string[], ok: boolean}}
 */
export function renderTemplate(body, values = {}, opts = {}) {
  const required = Array.isArray(opts.required) ? opts.required : []
  const miss = new Set()

  const text = String(body ?? '').replace(VAR_RE, (raw, name) => {
    const v = values[name]
    if (v === undefined || v === null || String(v).trim() === '') {
      if (required.includes(name)) {
        miss.add(name)
        return raw
      }
      return ''
    }
    return String(v)
  })

  return { text, missing: [...miss], ok: miss.size === 0 }
}

/**
 * จุดประกอบร่างตรง ๆ: เอาผลของ inbox.ah_resolve ({values, missing}) มา render
 * missing ของ ah_resolve (required ที่ resolve ไม่ได้) กลายเป็น required ของการ render
 */
export function renderFromResolve(body, resolveResult) {
  return renderTemplate(body, resolveResult?.values ?? {}, {
    required: Array.isArray(resolveResult?.missing) ? resolveResult.missing : [],
  })
}
