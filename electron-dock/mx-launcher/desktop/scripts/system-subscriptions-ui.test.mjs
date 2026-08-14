import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../renderer.js', import.meta.url)), 'utf8');

assert.match(source, /mode: 'system-subscriptions'/, 'system account uses a dedicated drawer mode');
assert.match(source, /login disabled/, 'the system row advertises its non-login boundary');
assert.match(source, /renderSystemSubscriptionsRow\(\)[\s\S]*?systemRow[\s\S]*?filteredUsers\.map/, 'system row renders before ordinary users');
assert.match(source, /mixed-port \$\{escapeHtml\(String\(client\.mixedPort \|\| 7788\)\)\} · manual URL import/, 'drawer exposes the YAML port without claiming a managed local instance');
assert.match(source, /one long-lived system Basic account for both the direct-IP URL and the HTTPS domain URL/, 'IP and domain delivery reuse the same stable system credential');
assert.match(source, /MX only reveals and copies them; the consuming application owns its local listener/, 'drawer leaves local listener ownership with the consuming application');
assert.match(source, /provider\/override option if its existing 7890 listener must remain unchanged/, 'drawer warns that a full-profile import can change a consumer-owned listener');
assert.match(source, /Unlimited traffic · 50 Mbps hints/, 'traffic quota and bandwidth hint stay distinct');
const openDrawer = source.slice(source.indexOf('function openSystemSubscriptionsDrawer'), source.indexOf('function closeUserEditorDrawer'));
const closeDrawer = source.slice(source.indexOf('function closeUserEditorDrawer'), source.indexOf('function userEditorValue'));
assert.doesNotMatch(openDrawer, /systemSubscriptionSecrets = \{\}/, 'reopening the drawer preserves URLs in the current Admin memory session');
assert.doesNotMatch(closeDrawer, /systemSubscriptionSecrets = \{\}/, 'closing the drawer preserves URLs in the current Admin memory session');
assert.match(source, /function clearOpsToken\([\s\S]*?clearSystemSubscriptionSecrets\(\)/, 'clearing the bound ops credential clears revealed system URLs');
assert.match(source, /function clearSystemSubscriptionSecrets\([\s\S]*?systemSubscriptionSecretGeneration \+= 1[\s\S]*?renderUserEditorDrawer\(\)/, 'secret invalidation rejects stale responses and removes plaintext from an open drawer');
assert.match(source, /function bindOpsTokenToCurrentServer\([\s\S]*?opsTokenBinding\.token !== nextBinding\.token[\s\S]*?clearSystemSubscriptionSecrets\(\)/, 'changing the Admin credential clears URLs before rebinding');
assert.match(source, /async function revealSystemSubscription\([\s\S]*?const secretGeneration[\s\S]*?await fetchJson[\s\S]*?secretGeneration !== state\.userCenter\.systemSubscriptionSecretGeneration/, 'an in-flight reveal from an old server or ops binding cannot restore its plaintext');
assert.match(source, /item\.status === 'ready' && delivery\.auth\?\.passwordAvailable/, 'blocked or pending channels cannot reveal credentials');
assert.match(source, /secret\?\.urls\?\.directIp \|\| secret\?\.url/, 'the direct-IP copy uses the authoritative reveal response with legacy fallback');
assert.match(source, /secret\?\.urls\?\.domain/, 'the HTTPS domain copy uses the authoritative reveal response');
assert.match(source, /data-system-subscription-copy-ip/, 'a revealed system subscription exposes a dedicated IP copy action');
assert.match(source, /data-system-subscription-copy-domain/, 'a revealed system subscription exposes a dedicated domain copy action');
assert.match(source, /\$\{canReveal && directUrl \? '' : 'disabled'\}>Copy IP/, 'a retained IP secret is not copyable after the channel stops being ready');
assert.match(source, /\$\{canReveal && domainUrl \? '' : 'disabled'\}>Copy Domain/, 'domain copy stays disabled when the URL is absent or the channel stops being ready');
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
