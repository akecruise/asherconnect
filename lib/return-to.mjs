export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  return value
}

export function currentReturnTo(location = globalThis.location) {
  return safeReturnTo(`${location.pathname}${location.search}`)
}
