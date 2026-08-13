import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../renderer.js', import.meta.url)), 'utf8');

assert.match(source, /mode: 'system-subscriptions'/, 'system account uses a dedicated drawer mode');
assert.match(source, /login disabled/, 'the system row advertises its non-login boundary');
assert.match(source, /renderSystemSubscriptionsRow\(\)[\s\S]*?systemRow[\s\S]*?filteredUsers\.map/, 'system row renders before ordinary users');
assert.match(source, /mixed-port \$\{escapeHtml\(String\(client\.mixedPort \|\| 7788\)\)\} · manual URL import/, 'drawer exposes the YAML port without claiming a managed local instance');
assert.match(source, /MX only reveals and copies the URL; the consuming application owns its local listener/, 'drawer leaves local listener ownership with the consuming application');
assert.match(source, /provider\/override option if its existing 7890 listener must remain unchanged/, 'drawer warns that a full-profile import can change a consumer-owned listener');
assert.match(source, /Unlimited traffic · 50 Mbps hints/, 'traffic quota and bandwidth hint stay distinct');
assert.match(source, /state\.userCenter\.systemSubscriptionSecrets = \{\};[\s\S]*?state\.userCenter\.drawer = null/, 'closing clears revealed credentials');
assert.match(source, /item\.status === 'ready' && delivery\.auth\?\.passwordAvailable/, 'blocked or pending channels cannot reveal credentials');
assert.doesNotMatch(source, /data-system-subscription-copy-cli|secret\?\.installCommand/, 'UI never offers or copies a local install command');
assert.doesNotMatch(
  source.slice(source.indexOf('function renderSystemSubscriptionsDrawer'), source.indexOf('function renderUserEditorDrawer')),
  /data-user-editor-password|data-user-editor-delete|Save User/,
  'system drawer cannot mutate a user identity'
);
assert.match(source, /overseaShowArchived: false/, 'retired Oversea evidence is hidden from the active registry by default');
assert.match(source, /data-oversea-toggle-archived/, 'operators can explicitly inspect preserved archived evidence');
assert.match(
  source,
  /allSites\.filter\(\(site\) => !site\.archived && site\.status !== 'archived'\)/,
  'active Oversea operations exclude archived nodes'
);
assert.match(source, /archived \|\| status === 'archived'/, 'an archived Oversea detail disables Install\/Sync');
assert.match(source, /Unarchive First/, 'the disabled action points to the only supported restore path');

console.log('OK system subscriptions stay pinned, read-only, isolated, and session-secret only');
