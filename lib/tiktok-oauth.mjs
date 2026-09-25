// TikTok OAuth callback is intentionally inert until token lifecycle and CRM
// wiring are complete.
export const TIKTOK_OAUTH_CALLBACK_PATH = '/api/integrations/tiktok/oauth/callback'

export function parseTikTokOAuthCallback(url) {
  const error = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (error) return { status: 'denied', error, error_description: errorDescription || null, state_present: Boolean(state) }
  if (!code) return { status: 'missing_code', state_present: Boolean(state) }
  return { status: 'received', state_present: Boolean(state) }
}

