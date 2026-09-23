// Deterministic extraction for normalized inbound customer messages only.
const PHONE = /(?:\+?66|0)[\s().-]*[689]\d(?:[\s().-]*\d){7,9}/g
const NAME_LABEL = /(?:ชื่อ|name)\s*[:：-]?\s*([\p{L}][\p{L} .'-]{1,79}?)(?=\s*(?:เบอร์|โทร|phone|tel|\+?66|0[689])|$)/iu

export function normalizeThaiPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.startsWith('66')) {
    const local = `0${digits.slice(2)}`
    return /^0[689]\d{8}$/.test(local) ? local : null
  }
  return /^0[689]\d{8}$/.test(digits) ? digits : null
}

function cleanName(value) {
  const name = String(value ?? '').replace(/[,:;|]+$/g, '').trim()
  if (!name || name.length > 80 || /^(?:เบอร์|โทร|phone|tel)$/iu.test(name)) return null
  return name
}

export function extractCustomerContact(text) {
  const source = String(text ?? '').trim()
  if (!source) return { name: null, phone: null, sourceText: source }
  const rawPhones = source.match(PHONE) ?? []
  const phone = rawPhones.map(normalizeThaiPhone).find(Boolean) ?? null
  let name = cleanName(source.match(NAME_LABEL)?.[1])
  if (!name && phone) {
    const withoutPhone = source.replace(rawPhones.find((p) => normalizeThaiPhone(p) === phone) ?? '', ' ')
    const candidate = withoutPhone.replace(/(?:ชื่อ|name|เบอร์|โทร|phone|tel)\s*[:：-]?/giu, ' ').trim()
    name = cleanName(candidate.split(/[\n,|/]+/u)[0])
  }
  return { name, phone, sourceText: source }
}
