// Deterministic extraction for normalized inbound customer messages only.
// Consume the whole numeric candidate so a long ID cannot match a phone suffix.
const PHONE = /(?<![\p{L}\p{N}_])\+?\d(?:[ ().-]*\d)*(?![\p{L}\p{N}_])/gu
const NAME_LABEL = /(?:^|[\n,;|])\s*(?:ชื่อ|name)\s*[:：-]\s*([\p{L}][\p{L}\p{M} .'-]{1,79}?)(?=\s*(?:เบอร์|โทร|phone|tel|\+?66|0[689])|$)/iu

export function normalizeThaiPhone(value) {
  const raw = String(value ?? '').trim()
  if (!/^\+?\d[\d ().-]*$/.test(raw)) return null
  const digits = raw.replace(/\D/g, '')
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
  // Without a persisted "asked for name" state, only accept an explicit label.
  // Removing a phone from ordinary prose must not turn that prose into a name.
  const name = cleanName(source.match(NAME_LABEL)?.[1])
  return { name, phone, sourceText: source }
}
