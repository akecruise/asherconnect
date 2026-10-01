import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { safeMediaPath } from './media.mjs'

// Authorization is checked against the message before using the storage service key.
export function createMediaHandler({ sessions, rpcDirect, fetchObject, fail }) {
  return async function handleMedia(req, res, url) {
    if (req.method !== 'GET') throw fail(405, 'method_not_allowed')
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')
    const token = bearer ? bearer[1] : await sessions.access(req)
    const path = safeMediaPath(url.pathname.slice('/media/'.length))
    if (!path) throw fail(404, 'not_found')
    if (!await rpcDirect(token, 'media_access', { p_path: path })) throw fail(403, 'not_allowed')
    const response = await fetchObject(path)
    if (!response.ok || !response.body) throw fail(404, 'not_found')
    const type = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase()
    const inline = /^(image\/(jpeg|png|gif|webp)|video\/mp4|audio\/(mp4|mpeg|ogg))$/.test(type)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': inline ? 'inline' : 'attachment',
    })
    await pipeline(Readable.fromWeb(response.body), res)
  }
}
