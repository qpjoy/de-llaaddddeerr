// A run's recordings and screenshots inside the desktop workbench (docs/21 M4).
//
// The workbench page is a local file and holds no credential, so it cannot
// load `/api/v1/runs/<id>/artifacts/...` from the service itself. It names the
// file as `rig-media://run/<runId>/<path>` instead (artifactSrc in
// apps/web/run-model.js); the main process maps that
// to the service's artifact URL and sends it with the member's token, passing
// the Range header through so a video can seek to a step. Only recordings and
// images of a run can be named this way, and the recording of a tour shown in
// 新手引导 as `rig-media://tour/<id>.webm` (docs/24 M8c) — nothing else on the
// service, and nothing anywhere else. Kept free of Electron so it can be
// tested on its own.

import { TOURS } from '../web/tours.js'

export const MEDIA_SCHEME = 'rig-media'

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/
const MEDIA_FILE = /\.(webm|mp4|png|jpe?g)$/i
const TOUR_VIDEO = /^\/([a-z0-9][a-z0-9-]{0,40})\.webm$/
const TOUR_IDS = new Set(TOURS.map((tour) => tour.id))

/** The service URL a `rig-media:` address stands for, or null when it names anything else. */
export function mediaTarget(raw, origin) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${MEDIA_SCHEME}:` || !['run', 'tour'].includes(url.hostname)) return null
  if (url.username || url.password || url.port || url.search) return null
  if (url.hostname === 'tour') {
    const tour = TOUR_VIDEO.exec(url.pathname)
    return tour && TOUR_IDS.has(tour[1]) ? `${origin}/api/rig/v1/tour-videos/${tour[1]}.webm` : null
  }
  const [, runId, ...parts] = url.pathname.split('/')
  if (!RUN_ID.test(runId ?? '') || parts.length === 0) return null
  for (const part of parts) {
    let plain
    try {
      plain = decodeURIComponent(part)
    } catch {
      return null
    }
    // An encoded separator or a parent step would name a file outside this run.
    if (!plain || plain === '.' || plain === '..' || /[\\/\0]/.test(plain)) return null
  }
  const path = parts.join('/')
  if (!MEDIA_FILE.test(path)) return null
  return `${origin}/api/v1/runs/${runId}/artifacts/${path}`
}

/**
 * Answer one `rig-media:` request. `fetch` is Electron's `net.fetch` in the
 * app; `session` is the signed-in client, or null when nobody is.
 */
export async function mediaResponse(request, { session, fetch }) {
  const target = session && request.method === 'GET' ? mediaTarget(request.url, new URL(session.url).origin) : null
  if (!target) return new Response(null, { status: 404 })
  const headers = { authorization: `Bearer ${session.token}` }
  const range = request.headers.get('range')
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range
  try {
    const answer = await fetch(target, { headers, redirect: 'error' })
    // The service's own error page is no use to a <video>; the status is enough.
    if (!answer.ok) return new Response(null, { status: answer.status })
    return answer
  } catch {
    return new Response(null, { status: 502 })
  }
}
