import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('production admin bundle carries exactly the shared UI assets used by the desktop', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-neon-assets-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  for (const path of ['desktop/node_modules/three/build','ui-design/src']) mkdirSync(join(root,path),{recursive:true});
  const desktop = new URL('../', import.meta.url), ui = new URL('../../ui-design/src/', import.meta.url);
  for (const file of ['index.html','renderer.js','styles.css','neon-void.css','service-operations.js','service-operations-catalog.js']) copyFileSync(new URL(file,desktop),join(root,'desktop',file));
  for (const file of ['styles.css','tokens.css','select.js','select.css']) copyFileSync(new URL(file,ui),join(root,'ui-design/src',file));
  writeFileSync(join(root,'desktop/node_modules/three/build/three.module.js'),'// fixture only');
  const source = readFileSync(new URL('../../scripts/manage.sh',import.meta.url),'utf8');
  const fn = source.match(/^shadow_image_admin_assets\(\) \{\n[\s\S]*?^\}/m)?.[0]; assert.ok(fn);
  const result = spawnSync('bash',['-c',`set -Eeuo pipefail\nsay() { :; }\ndie() { echo "$*" >&2; exit 1; }\n${fn}\nshadow_image_admin_assets`],{env:{...process.env,ROOT:root},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const html=readFileSync(join(root,'server/artifacts/admin/index.html'),'utf8');
  for(const file of ['styles.css','tokens.css','select.js','select.css']) assert.deepEqual(readFileSync(join(root,'server/artifacts/admin/ui-design',file)),readFileSync(new URL(file,ui)));
  assert.match(html,/ui-design\/styles\.css/);assert.match(html,/ui-design\/select\.css/);assert.match(html,/neon-void\.css/);
  assert.deepEqual(readFileSync(join(root,'server/artifacts/admin/neon-void.css')),readFileSync(new URL('neon-void.css',desktop)));
});
