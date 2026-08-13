import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../renderer.js', import.meta.url)), 'utf8');

assert.match(source, /mode: 'system-subscriptions'/, 'system account uses a dedicated drawer mode');
assert.match(source, /login disabled/, 'the system row advertises its non-login boundary');
assert.match(source, /renderSystemSubscriptionsRow\(\)[\s\S]*?systemRow[\s\S]*?filteredUsers\.map/, 'system row renders before ordinary users');
assert.match(source, /mixed-port \$\{escapeHtml\(String\(client\.mixedPort \|\| 7890\)\)\}/, 'drawer exposes 7890');
assert.match(source, /Unlimited traffic · 50 Mbps hints/, 'traffic quota and bandwidth hint stay distinct');
assert.match(source, /state\.userCenter\.systemSubscriptionSecrets = \{\};[\s\S]*?state\.userCenter\.drawer = null/, 'closing clears revealed credentials');
assert.match(source, /item\.status === 'ready' && delivery\.auth\?\.passwordAvailable/, 'blocked or pending channels cannot reveal credentials');
assert.match(source, /secret\?\.installCommand/, 'UI copies only the server-provided isolated install command');
assert.doesNotMatch(
  source.slice(source.indexOf('function renderSystemSubscriptionsDrawer'), source.indexOf('function renderUserEditorDrawer')),
  /data-user-editor-password|data-user-editor-delete|Save User/,
  'system drawer cannot mutate a user identity'
);

console.log('OK system subscriptions stay pinned, read-only, isolated, and session-secret only');
