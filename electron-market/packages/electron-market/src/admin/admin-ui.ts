/**
 * Placeholder admin SPA. In production this is replaced by a Quasar build
 * (mirroring how the tunnel admin panel was built). The skeleton page already
 * exercises every backend route so it's useful for smoke tests.
 */
export function adminHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>QPJoy Plugin Market</title>
<style>
  body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; background:#0e0f12; color:#eaecef; }
  h1 { margin-top:0; font-size: 20px; }
  .row { display:flex; gap:12px; margin-bottom:24px; }
  .card { background:#1a1c22; border-radius:12px; padding:16px; flex:1; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; background:#2b2f3a; }
  button { background:#3457d5; border:0; color:#fff; padding:6px 12px; border-radius:6px; cursor:pointer; }
  button.secondary { background:#2b2f3a; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size:12px; }
</style>
</head>
<body>
  <h1>QPJoy Plugin Market</h1>
  <div class="row">
    <div class="card">
      <h3>Installed</h3>
      <div id="installed">loading…</div>
    </div>
    <div class="card">
      <h3>Marketplace</h3>
      <div id="market">loading…</div>
    </div>
  </div>
<script>
async function refresh() {
  const [installed, market] = await Promise.all([
    fetch('/api/plugins').then(r => r.json()),
    fetch('/api/marketplace').then(r => r.json()).catch(() => ({ entries: [] }))
  ]);
  document.getElementById('installed').innerHTML = installed.map(p => \`
    <div style="margin-bottom:12px">
      <div><strong>\${p.manifest.name}</strong> <span class="pill">\${p.state}</span></div>
      <div><code>\${p.id}@\${p.version}</code></div>
      <div style="margin-top:6px; display:flex; gap:6px;">
        <button onclick="grantAll('\${p.id}', \${JSON.stringify(JSON.stringify(p.manifest.permissions))})">grant all</button>
        <button onclick="post('/api/plugins/\${p.id}/activate')">activate</button>
        <button class="secondary" onclick="post('/api/plugins/\${p.id}/deactivate')">deactivate</button>
        <button class="secondary" onclick="post('/api/plugins/\${p.id}/uninstall')">uninstall</button>
      </div>
    </div>\`).join('') || '<em>none</em>';
  document.getElementById('market').innerHTML = (market.entries || []).map(e => \`
    <div style="margin-bottom:12px">
      <div><strong>\${e.name}</strong> \${e.verified ? '<span class="pill">verified</span>' : ''}</div>
      <div><code>\${e.npm}@\${e.latest}</code></div>
      <button onclick='install("\${e.id}","\${e.latest}")'>install</button>
    </div>\`).join('') || '<em>empty index</em>';
}
async function post(url, body) {
  await fetch(url, { method: 'POST', headers: {'content-type':'application/json'}, body: body ? JSON.stringify(body) : '{}' });
  refresh();
}
function install(id, version) { post('/api/plugins/install', { id, version }); }
function grantAll(id, permsJson) {
  const permissions = JSON.parse(JSON.parse(permsJson));
  post('/api/plugins/' + id + '/grant', { permissions });
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
