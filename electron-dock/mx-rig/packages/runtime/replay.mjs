// 回放文件: a mission's browser steps as one HTML file that plays itself —
// to attach to a bug, send to a colleague, or open from the terminal.
//
// The frames and the player are the workbench's own (apps/web/replay.js),
// inlined with the screenshots, so the file needs nothing else to play.

import { readFile } from 'node:fs/promises'
import { replayFrames } from '../../apps/web/replay.js'

export { replayFrames }

const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

/**
 * @param {object} row  a mission record (public shape: goal, status, events)
 * @param {object} options
 * @param {(path: string) => Promise<Buffer|null>} options.readImage  a screenshot by its recorded path
 * @returns {Promise<{ html: string, frames: number }>}
 */
export async function replayDocument(row, { readImage }) {
  const frames = replayFrames(row.events)
  const images = new Map()
  for (const frame of frames)
    for (const path of [frame.image, frame.intent])
      if (path && !images.has(path)) {
        const bytes = await readImage(path).catch(() => null)
        images.set(path, bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null)
      }
  const embedded = frames.map((frame) => ({
    ...frame,
    image: images.get(frame.image) ?? null,
    intent: frame.intent ? (images.get(frame.intent) ?? null) : null
  }))
  const [player, css] = await Promise.all([
    readFile(new URL('../../apps/web/replay.js', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/replay.css', import.meta.url), 'utf8')
  ])
  // JSON inside a script element: nothing in it may close the element.
  const data = JSON.stringify(embedded).replace(/</g, '\\u003c')
  const when = row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN') : ''
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>回放 · ${escapeHtml(String(row.goal ?? '').split('\n')[0].slice(0, 60))}</title>
<style>
body { margin: 0; background: #0b1018; color: #e6edf3; font: 14px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 20px 40px; }
header h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
header p { margin: 0 0 18px; color: #8b98a8; font-size: 12px; }
${css}
</style>
</head>
<body>
<main>
<header>
<h1>${escapeHtml(row.goal)}</h1>
<p>MX Rig 回放 · ${escapeHtml(when)} · ${frames.length} 步 · 任务 ${escapeHtml(row.id ?? '')} · ${escapeHtml(row.status ?? '')}。截图可能包含被测系统的业务数据。</p>
</header>
<div id="replay"></div>
</main>
<script type="application/json" id="frames">${data}</script>
<script>
${player.replace(/^export /gm, '')}
mountReplay(document.getElementById('replay'), JSON.parse(document.getElementById('frames').textContent), { autoplay: true })
</script>
</body>
</html>
`
  return { html, frames: frames.length }
}
