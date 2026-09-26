// TikTok OAuth callback is intentionally inert until token lifecycle and CRM
// wiring are complete.  Keep parsing separate from the HTTP route so the
// security contract is easy to test without starting Connect.

export const TIKTOK_OAUTH_CALLBACK_PATH = '/api/integrations/tiktok/oauth/callback'

export function parseTikTokOAuthCallback(url) {
  const error = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (error) return {
    status: 'denied',
    error,
    error_description: errorDescription || null,
    state_present: Boolean(state),
  }
  if (!code) return { status: 'missing_code', state_present: Boolean(state) }

  // Never return the authorization code.  It must not reach logs, browser
  // output, or an error page while the exchange/storage flow is not enabled.
  return { status: 'received', state_present: Boolean(state) }
}

