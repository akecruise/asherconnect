import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { safeMediaPath } from './media.mjs'

export function createQuickReplyMediaHandler({ sessions, rpcDirect, fetchObject, origin, fail }) {
  return async function handleQuickReplyMedia(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'method_not_allowed')
    const path = safeMediaPath(url.pathname.slice('/quick-reply-media/'.length))
    if (!path || !/\.(jpg|png|webp)$/i.test(path)) throw fail(404, 'not_found')
    const token = await sessions.access(req)
    const rows = await rpcDirect(token, 'qr_list', { p_project: null, p_query: null, p_category: null })
    const expected = origin + '/quick-reply-media/' + path
    const allowed = (Array.isArray(rows) ? rows : []).some(q =>
      (q.attachments || []).some(a => a.public_url === expected))
    if (!allowed) throw fail(404, 'not_found')
    const response = await fetchObject(path)
    if (!response.ok || !response.body) throw fail(404, 'not_found')
    const mime = (response.headers.get('content-type') || '').split(';')[0]
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw fail(415, 'unsupported_media')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': 'inline' })
    if (req.method === 'HEAD') { await response.body.cancel(); return res.end() }
    await pipeline(Readable.fromWeb(response.body), res)
  }
}
