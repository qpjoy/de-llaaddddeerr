import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mxLauncherApiDocument,
  renderApiDocsHtml,
  renderApiDocsMarkdown
} from './api-docs.contract.js';

const paths = mxLauncherApiDocument.paths;
const httpMethods = ['get', 'post', 'put', 'patch', 'delete'] as const;

function operations() {
  return Object.entries(paths).flatMap(([path, byMethod]) =>
    httpMethods
      .filter((method) => byMethod[method])
      .map((method) => ({ path, method, operation: byMethod[method] })));
}

test('every documented operation carries the fields the renderers read', () => {
  for (const { path, method, operation } of operations()) {
    const where = `${method.toUpperCase()} ${path}`;
    assert.ok(operation.summary, `${where} needs a summary`);
    assert.ok(operation.description, `${where} needs a description`);
    assert.ok(operation.operationId, `${where} needs an operationId`);
    assert.ok(operation['x-mx-auth'], `${where} needs an auth note`);
    assert.ok(operation.responses['200'], `${where} needs a 200 example`);
    assert.ok(operation.tags.length === 1, `${where} needs exactly one tag`);
  }
});

test('operationIds are unique so generated clients do not collide', () => {
  const seen = new Map<string, string>();
  for (const { path, method, operation } of operations()) {
    const previous = seen.get(operation.operationId);
    assert.equal(previous, undefined, `operationId ${operation.operationId} is reused by ${previous} and ${method} ${path}`);
    seen.set(operation.operationId, `${method} ${path}`);
  }
});

test('every tag used by an operation is declared, and every declared tag is used', () => {
  const declared = new Set(mxLauncherApiDocument.tags.map((tag) => tag.name));
  const used = new Set(operations().map(({ operation }) => operation.tags[0]));
  for (const tag of used) assert.ok(declared.has(tag), `tag ${tag} is used but not declared`);
  for (const tag of declared) assert.ok(used.has(tag), `tag ${tag} is declared but unused`);
});

test('path template parameters are all declared', () => {
  for (const { path, method, operation } of operations()) {
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const declared = new Set((operation.parameters ?? [])
      .filter((parameter) => (parameter as { in?: string }).in === 'path')
      .map((parameter) => (parameter as { name: string }).name));
    for (const name of templated) {
      assert.ok(declared.has(name), `${method.toUpperCase()} ${path} does not declare path param ${name}`);
    }
  }
});

/**
 * The aggregated user-center subscription needs a Bearer, so it can never be
 * allowlisted at the public edge. Documenting it as public would invite exactly
 * the mistake the Domestic Caddyfile and Compass nginx both warn about.
 */
test('the Bearer-guarded user subscription is never documented as public', () => {
  const subscription = paths['/internal/v1/user-center/users/{userId}/oversea/subscription.yaml']?.get;
  assert.ok(subscription, 'the user-center subscription stays documented');
  assert.match(subscription['x-mx-auth'], /Bearer/);

  const publicLink = paths['/internal/v1/oversea-subscriptions/{token}.yaml']?.get;
  assert.ok(publicLink, 'the token-in-path subscription is the public one');
  assert.deepEqual(publicLink.security, [], 'a public link carries no Bearer requirement');
});

test('the integration entry points third-party apps need are all present', () => {
  for (const path of [
    '/healthz',
    '/internal/v1/sdk/gateway/manifest',
    '/internal/v1/sdk/oauth/token',
    '/internal/v1/launcher-network/products/{productId}',
    '/internal/v1/user-center/users',
    '/internal/v1/user-center/oversea-entitlements/rollout',
    '/internal/v1/user-center/system-subscriptions',
    '/internal/v1/user-center/system-subscriptions/ensure',
    '/internal/v1/user-center/system-subscriptions/sites/{siteId}/reveal',
    '/internal/v1/user-center/users/{userId}/oversea/ensure-subscription',
    '/internal/v1/user-center/users/{userId}/oversea/sync-runtime',
    '/internal/v1/user-center/users/{userId}/oversea/subscription-link',
    '/internal/v1/oversea-subscriptions/{token}.yaml'
  ]) {
    assert.ok(paths[path], `${path} is missing from the docs contract`);
  }
});

test('product user access is ops-only and never claims database release removed WireGuard peers', () => {
  const list = paths['/internal/v1/launcher-network/products/{productId}/user-access']?.get;
  const accessPath = paths['/internal/v1/launcher-network/products/{productId}/users/{userId}/access'];
  assert.match(list?.['x-mx-auth'] ?? '', /x-mx-ops-token/);
  assert.match(accessPath?.get?.['x-mx-auth'] ?? '', /x-mx-ops-token/);
  assert.match(accessPath?.post?.['x-mx-auth'] ?? '', /x-mx-ops-token/);
  const inventory = JSON.stringify(list?.responses['200']);
  assert.match(inventory, /"admission":"blocked"/);
  assert.match(inventory, /"status":"not-performed"/);
  const mutation = JSON.stringify(accessPath?.post?.responses['200']);
  assert.match(mutation, /"userStatusChanged":false/);
  assert.match(mutation, /"tokensRevoked":0/);
  assert.match(mutation, /"status":"not-performed"/);
  assert.match(mutation, /WireGuard peer removal was not performed or confirmed/);
});

test('lease activity is ops-only, exact-linked audit data with a redacted response', () => {
  const activity = paths['/internal/v1/launcher-network/leases/{leaseId}/activity']?.get;
  assert.match(activity?.['x-mx-auth'] ?? '', /x-mx-ops-token/);
  assert.match(activity?.description ?? '', /metadata\.leaseId 精确匹配/);
  assert.match(activity?.description ?? '', /最多 50 条/);
  assert.match(activity?.description ?? '', /server provenance/);
  assert.match(activity?.description ?? '', /client provenance/);
  assert.match(activity?.description ?? '', /旧记录缺省 provenance/);
  assert.match(activity?.description ?? '', /不是 WireGuard 在线状态或 runtime logs/);
  const response = JSON.stringify(activity?.responses['200']);
  assert.match(response, /"source":"audit-events"/);
  assert.match(response, /"eventType":"launcher_network\.domestic_peer\.synced"/);
  assert.match(response, /"summary":"Domestic WireGuard peer synchronized"/);
  assert.match(response, /"status":"passed"/);
  assert.match(response, /"plane":"domestic"/);
  assert.doesNotMatch(response, /"(?:provenance|metadata|publicKey|token|capability|sourceIp|stdout|stderr)"/);
});

test('the system subscription contract exposes both operator URLs without provisioning a local 7890 instance', () => {
  const catalog = JSON.stringify(paths['/internal/v1/user-center/system-subscriptions']?.get?.responses['200']);
  assert.match(catalog, /"mixedPort":7788/);
  assert.doesNotMatch(catalog, /"instance":"subscriptions"|7890/);

  const reveal = JSON.stringify(paths['/internal/v1/user-center/system-subscriptions/sites/{siteId}/reveal']?.post?.responses['200']);
  assert.match(reveal, /"url":/);
  assert.match(reveal, /"directIp":/);
  assert.match(reveal, /"domain":/);
  assert.doesNotMatch(reveal, /installCommand|qp-tunnel-cli|--instance|7890/);

  const exactSystemYaml = paths['/internal/v1/site-slots/{siteId}/subscriptions/hysteria2/{username}.yaml']?.get;
  assert.match(exactSystemYaml?.description ?? '', /Basic subscriptions:<active authToken>/);
  assert.match(exactSystemYaml?.description ?? '', /一律 404/);
  assert.match(exactSystemYaml?.description ?? '', /no-store\/no-referrer/);
});

test('both renderers produce output without throwing', () => {
  const html = renderApiDocsHtml(mxLauncherApiDocument);
  assert.match(html, /<html/i);
  assert.ok(html.includes(mxLauncherApiDocument.info.title));

  const markdown = renderApiDocsMarkdown(mxLauncherApiDocument);
  assert.match(markdown, /## API 索引/);
  for (const { path } of operations()) {
    assert.ok(markdown.includes(path), `${path} is missing from the markdown export`);
  }
});
