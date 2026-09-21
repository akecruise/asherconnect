export const CRM_PUBLISH_BACKOFF_MS = [5000, 30000, 120000, 600000, 1800000, 7200000]

export function isRetryableCrmResponse(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export function classifyCrmFailure({ status = 0, network = false } = {}) {
  if (network || status === 0 || isRetryableCrmResponse(status)) return 'retry'
  return 'dead_letter'
}

export function crmBackoffMs(attempts) {
  const index = Math.max(0, Math.min(CRM_PUBLISH_BACKOFF_MS.length - 1, attempts - 1))
  return CRM_PUBLISH_BACKOFF_MS[index]
}
