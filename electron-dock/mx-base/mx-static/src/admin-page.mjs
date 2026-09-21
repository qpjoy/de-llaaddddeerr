// Self-contained settings console. No external requests, no bundler, and every
// value is written through DOM text nodes rather than markup, so a stored
// string can never become script. The nonce keeps CSP strict.
export const adminPage = (nonce) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mx-static settings</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1b1b19;--muted:#6b6b66;--line:#e3e2de;--card:#fff;--accent:#2c6e49;--warn:#8a5a00;--warnbg:#fff6e0}
@media(prefers-color-scheme:dark){:root{--bg:#17171a;--fg:#ececea;--muted:#9a9a95;--line:#2e2e33;--card:#1f1f23;--accent:#6fbf8f;--warn:#e8b45a;--warnbg:#2a2212}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0;font-weight:600}
.sub{color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 16px;overflow:hidden}
.card>header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
.row{display:grid;grid-template-columns:1fr 200px;gap:14px;padding:12px 16px;border-bottom:1px solid var(--line);align-items:center}
.row:last-child{border-bottom:0}
.row .name{font-weight:500}.row .help,.row .env{color:var(--muted);font-size:12px}
.row .env{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
input,select{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
input:disabled,select:disabled{opacity:.55}
.pill{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.changed{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;padding:8px 16px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
.bar{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 20px;display:flex;gap:10px;align-items:center;justify-content:flex-end}
.warn{background:var(--warnbg);color:var(--warn);border:1px solid var(--warn);border-radius:8px;padding:10px 14px;margin:0 0 14px;font-size:13px}
.meters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:14px 16px}
.meter .label{color:var(--muted);font-size:12px}.meter .value{font-size:18px;font-variant-numeric:tabular-nums}
.track{height:5px;border-radius:3px;background:var(--line);margin-top:5px;overflow:hidden}
.track>i{display:block;height:100%;background:var(--accent)}
details>summary{cursor:pointer;padding:12px 16px;font-weight:600}
#gate{max-width:380px;margin:80px auto;text-align:center}
.msg{font-size:13px;margin-right:auto;color:var(--muted)}.msg.bad{color:#b3261e}
</style></head><body>
<main>
  <div id="gate" hidden>
    <h1>mx-static settings</h1>
    <p class="sub">Paste the admin token to continue.</p>
    <input id="token" type="password" placeholder="admin token" autocomplete="off">
    <p><button class="primary" id="unlock">Unlock</button></p>
    <p class="msg bad" id="gateMsg"></p>
  </div>
  <div id="app" hidden>
    <h1>mx-static settings</h1>
    <p class="sub" id="subtitle">Loading…</p>
    <div id="warnings"></div>
    <div class="card"><header><h2>Live</h2><span class="pill" id="refreshed"></span></header><div class="meters" id="meters"></div></div>
    <div id="groups"></div>
  </div>
</main>
<div class="bar" id="bar" hidden>
  <span class="msg" id="msg"></span>
  <button id="revert">Revert changes</button>
  <button class="primary" id="save" disabled>Save</button>
</div>
<script nonce="${nonce}">
const $ = id => document.getElementById(id)
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node }
let token = sessionStorage.getItem('mx-static-admin') || ''
let schema = [], values = {}, overrides = {}, dirty = new Map()

const api = (path, init) => fetch(path, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init || {}).headers } })

async function load() {
  const response = await api('/static/v1/admin/settings')
  if (response.status === 401) throw new Error('unauthorized')
  if (!response.ok) throw new Error('settings unavailable (' + response.status + ')')
  const body = await response.json()
  schema = body.schema; values = body.values; overrides = body.overrides
  $('subtitle').textContent = body.readOnly ? 'Read-only replica — settings are managed on the writer.' : 'Changes apply immediately unless a setting is marked restart-required.'
  renderWarnings(body.warnings || [])
  renderGroups(body.readOnly)
  renderMeters(body.live, body.budget)
  $('refreshed').textContent = 'updated ' + new Date().toLocaleTimeString()
}

function renderWarnings(list) {
  const host = $('warnings'); host.replaceChildren()
  for (const text of list) host.append(el('p', 'warn', text))
}

function renderMeters(live, budget) {
  const host = $('meters'); host.replaceChildren()
  const gauge = (label, used, limit, suffix) => {
    const box = el('div', 'meter')
    box.append(el('div', 'label', label), el('div', 'value', limit === undefined ? used + (suffix || '') : used + ' / ' + limit))
    if (limit) { const track = el('div', 'track'); const fill = el('i'); fill.style.width = Math.min(100, (used / limit) * 100) + '%'; track.append(fill); box.append(track) }
    host.append(box)
  }
  gauge('Image transfers', live.assetStreams.inUse, live.assetStreams.limit)
  gauge('Video transfers', live.videoStreams.inUse, live.videoStreams.limit)
  gauge('Disk reads', live.reads.inUse, live.reads.limit)
  gauge('Image downloads', live.downloads.image.inUse, live.downloads.image.limit)
  gauge('Video downloads', live.downloads.video.inUse, live.downloads.video.limit)
  gauge('Event-loop lag', live.eventLoopLagMs, undefined, ' ms')
  gauge('Planned bandwidth', budget.totalMbps, undefined, ' Mbps')
  gauge('Link utilisation', Math.round(budget.linkUtilisation * 100), undefined, '%')
}

function renderGroups(readOnly) {
  const host = $('groups'); host.replaceChildren()
  const groups = new Map()
  for (const spec of schema) {
    if (!groups.has(spec.group)) groups.set(spec.group, { label: spec.groupLabel, items: [] })
    groups.get(spec.group).items.push(spec)
  }
  for (const [name, group] of groups) {
    const advanced = name === 'advanced'
    const card = el(advanced ? 'details' : 'div', 'card')
    if (advanced) card.append(Object.assign(el('summary', null, 'Advanced'), {}))
    else { const head = el('header'); head.append(el('h2', null, group.label)); card.append(head) }
    for (const spec of group.items) card.append(renderRow(spec, readOnly))
    host.append(card)
  }
}

function renderRow(spec, readOnly) {
  const row = el('div', 'row')
  const left = el('div')
  const title = el('div', 'name', spec.label || spec.name)
  if (!spec.live) title.append(' ', Object.assign(el('span', 'pill', 'restart required'), {}))
  else if (spec.name in overrides) title.append(' ', el('span', 'pill', 'overridden'))
  left.append(title)
  if (spec.help) left.append(el('div', 'help', spec.help))
  left.append(el('div', 'env', spec.env + (spec.kind === 'int' ? '  (' + spec.min + '–' + spec.max + ')' : '') + '  default ' + spec.default))
  let field
  if (spec.kind === 'bool' || spec.values) {
    field = el('select')
    for (const option of spec.kind === 'bool' ? ['true', 'false'] : spec.values) field.append(new Option(option, option))
    field.value = String(values[spec.name])
  } else {
    field = el('input')
    field.type = spec.kind === 'int' ? 'number' : 'text'
    if (spec.kind === 'int') { field.min = spec.min; field.max = spec.max }
    field.value = values[spec.name]
  }
  field.disabled = !spec.live || readOnly
  field.addEventListener('input', () => {
    const raw = spec.kind === 'int' ? Number(field.value) : field.value
    const same = String(raw) === String(values[spec.name])
    if (same) dirty.delete(spec.name); else dirty.set(spec.name, spec.kind === 'bool' ? field.value === 'true' : raw)
    field.classList.toggle('changed', !same)
    $('save').disabled = dirty.size === 0
    $('msg').textContent = dirty.size ? dirty.size + ' unsaved change(s)' : ''
    $('msg').classList.remove('bad')
  })
  row.append(left, field)
  return row
}

async function save() {
  $('save').disabled = true
  const response = await api('/static/v1/admin/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(dirty)) })
  const body = await response.json().catch(() => ({}))
  const rejected = Object.entries(body.rejected || {})
  $('msg').classList.toggle('bad', rejected.length > 0)
  $('msg').textContent = rejected.length
    ? rejected.map(([name, why]) => name + ': ' + why).join('; ')
    : 'Saved. ' + (body.restartRequired ? 'Some values need a redeploy.' : 'Applied without a restart.')
  dirty.clear()
  await load()
}

$('revert').addEventListener('click', () => { dirty.clear(); load(); $('msg').textContent = ''; $('save').disabled = true })
$('save').addEventListener('click', () => save().catch(error => { $('msg').classList.add('bad'); $('msg').textContent = String(error.message || error) }))
$('unlock').addEventListener('click', async () => {
  token = $('token').value.trim()
  try { await load(); sessionStorage.setItem('mx-static-admin', token); show(true) }
  catch (error) { $('gateMsg').textContent = String(error.message || error) }
})
$('token').addEventListener('keydown', event => { if (event.key === 'Enter') $('unlock').click() })

function show(ready) { $('gate').hidden = ready; $('app').hidden = !ready; $('bar').hidden = !ready }
show(false)
if (token) load().then(() => show(true)).catch(() => show(false))
else $('gate').hidden = false
setInterval(() => { if (!$('app').hidden && dirty.size === 0) load().catch(() => {}) }, 5000)
</script></body></html>`
