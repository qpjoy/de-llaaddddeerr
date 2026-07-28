#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SECRET_NAMES = Object.freeze([
  'mx-launcher-db',
  'mx-internal-ops',
  'mx-feishu-oauth',
  'mx-sdk-service-account-secrets'
]);
const POSTGRES_PVC_NAME = 'postgres-data-mx-internal-postgres-0';
const POSTGRES_PV_NAME = 'mx-internal-postgres-local-pv';
const POSTGRES_HOST_DATA_MARKERS = Object.freeze([
  '/var/lib/mx-launcher/k8s/postgres/PG_VERSION',
  '/var/lib/mx-launcher/k8s/postgres/pgdata/PG_VERSION',
  '/var/lib/mx-launcher/k8s/postgres/pgdata/base'
]);

const KNOWN_ENV_KEYS = Object.freeze([
  'PG_USER',
  'PG_PASSWORD',
  'PG_DB',
  'DATABASE_HOST',
  'MX_INTERNAL_OPS_TOKEN',
  'MX_FEISHU_APP_ID',
  'MX_FEISHU_APP_SECRET',
  'MX_FEISHU_ALLOWED_TENANT_KEYS',
  'MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON'
]);

const FEISHU_ENV_TO_SECRET_KEY = Object.freeze({
  MX_FEISHU_APP_ID: 'app-id',
  MX_FEISHU_APP_SECRET: 'app-secret',
  MX_FEISHU_ALLOWED_TENANT_KEYS: 'tenant-keys'
});

const MANAGED_LABELS = Object.freeze({
  'app.kubernetes.io/part-of': 'mx-3ks',
  'app.kubernetes.io/managed-by': 'mx-launcher-secret-ensure'
});

const DATA_DIGEST_ANNOTATION = 'mx.qpjoy.com/material-digest';
const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';
const DEFAULT_PG_USER = 'mx_internal';
const DEFAULT_PG_DB = 'mx_internal_shadow';
const MIN_SECRET_LENGTH = 32;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function parseEnvFile(content) {
  const values = Object.create(null);
  for (const line of String(content).split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) values[parsed[0]] = parsed[1];
  }
  return values;
}

export function resolveKnownEnvironment(fileValues = {}, processEnvironment = process.env) {
  const resolvedEnvironment = {};
  const configuredKeys = new Set();
  for (const key of KNOWN_ENV_KEYS) {
    if (hasOwn(processEnvironment, key)) {
      resolvedEnvironment[key] = String(processEnvironment[key] ?? '');
      configuredKeys.add(key);
    } else if (hasOwn(fileValues, key)) {
      resolvedEnvironment[key] = String(fileValues[key] ?? '');
      configuredKeys.add(key);
    }
  }
  return { values: resolvedEnvironment, configuredKeys };
}

export function validateConfiguredEnvironment(environment) {
  const { values, configuredKeys } = normalizeResolvedEnvironment(environment);

  for (const key of ['PG_USER', 'PG_PASSWORD', 'PG_DB']) {
    if (configuredKeys.has(key)) validateNonemptySingleLine(key, values[key]);
  }
  if (configuredKeys.has('DATABASE_HOST')) validateDatabaseHost(values.DATABASE_HOST);

  if (configuredKeys.has('MX_INTERNAL_OPS_TOKEN')) {
    validateLongSecret('MX_INTERNAL_OPS_TOKEN', values.MX_INTERNAL_OPS_TOKEN);
  }

  for (const key of Object.keys(FEISHU_ENV_TO_SECRET_KEY)) {
    if (configuredKeys.has(key)) validateNonemptySingleLine(key, values[key]);
  }
  if (configuredKeys.has('MX_FEISHU_ALLOWED_TENANT_KEYS')) {
    canonicalizeTenantKeys(values.MX_FEISHU_ALLOWED_TENANT_KEYS);
  }

  if (configuredKeys.has('MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON')) {
    canonicalizeSdkServiceAccountSecrets(values.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON);
  }

  return digestValue({
    configuredKeys: [...configuredKeys]
      .filter((key) => KNOWN_ENV_KEYS.includes(key))
      .sort()
  });
}

export function canonicalizeSdkServiceAccountSecrets(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue));
  } catch {
    throw new Error('MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON must be valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON must be a JSON object');
  }

  const normalized = Object.create(null);
  for (const [rawId, rawSecret] of Object.entries(parsed)) {
    const serviceAccountId = rawId.trim();
    if (!serviceAccountId) {
      throw new Error('MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON contains an empty service account id');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(serviceAccountId)) {
      throw new Error(
        `MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON contains invalid service account id ${safeIdentifier(serviceAccountId)}`
      );
    }
    if (hasOwn(normalized, serviceAccountId)) {
      throw new Error('MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON contains duplicate normalized service account ids');
    }
    if (typeof rawSecret !== 'string') {
      throw new Error(`MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON secret for ${safeIdentifier(serviceAccountId)} must be a string`);
    }
    const serviceAccountSecret = rawSecret.trim();
    if (serviceAccountSecret.length < MIN_SECRET_LENGTH) {
      throw new Error(`MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON secret for ${safeIdentifier(serviceAccountId)} must contain at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (/[\r\n\0]/.test(serviceAccountSecret)) {
      throw new Error(`MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON secret for ${safeIdentifier(serviceAccountId)} must be a single-line value`);
    }
    normalized[serviceAccountId] = serviceAccountSecret;
  }

  return JSON.stringify(sortObject(normalized));
}

export function planInternalK8sSecrets({
  namespace,
  environment,
  existingSecrets = {},
  randomSecret = generateRandomSecret
}) {
  validateNamespace(namespace);
  validateConfiguredEnvironment(environment);
  if (typeof randomSecret !== 'function') throw new Error('randomSecret must be a function');

  const existingByName = normalizeExistingSecrets(existingSecrets);
  const desiredSecrets = [];
  desiredSecrets.push(planDatabaseSecret(namespace, environment, existingByName['mx-launcher-db'], randomSecret));
  desiredSecrets.push(planInternalOpsSecret(namespace, environment, existingByName['mx-internal-ops'], randomSecret));

  const feishuSecret = planFeishuSecret(namespace, environment, existingByName['mx-feishu-oauth']);
  if (feishuSecret) desiredSecrets.push(feishuSecret);

  const sdkSecret = planSdkSecret(
    namespace,
    environment,
    existingByName['mx-sdk-service-account-secrets']
  );
  if (sdkSecret) desiredSecrets.push(sdkSecret);

  const resources = desiredSecrets
    .map(({ resource }) => resource)
    .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
  const changedItems = desiredSecrets
    .filter(({ changed }) => changed)
    .map(({ resource }) => resource)
    .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
  const bundleDigest = digestValue({
    namespace,
    secrets: resources.map((resource) => ({
      name: resource.metadata.name,
      data: sortObject(resource.data)
    }))
  });

  return {
    namespace,
    resources,
    changedItems,
    changedCount: changedItems.length,
    bundleDigest
  };
}

export function formatReadySummary(versionDigest, changedCount = 0) {
  const digest = String(versionDigest).replace(/^sha256-/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('version digest must be a SHA-256 hex digest');
  if (!Number.isInteger(changedCount) || changedCount < 0) {
    throw new Error('changed count must be a non-negative integer');
  }
  return `ready sha256-${digest} ${changedCount}`;
}

export function observedSecretBundleDigest(namespace, existingSecrets = {}) {
  validateNamespace(namespace);
  const existingByName = normalizeExistingSecrets(existingSecrets);
  return digestValue({
    namespace,
    secrets: SECRET_NAMES.map((name) => {
      const secret = existingByName[name];
      if (!secret) return { name, resourceVersion: null };
      const resourceVersion = secret.metadata?.resourceVersion;
      if (typeof resourceVersion !== 'string' || !resourceVersion.trim()) {
        throw new Error(`Secret ${name} is missing metadata.resourceVersion`);
      }
      return { name, resourceVersion };
    })
  });
}

export function hasRetainedPostgresHostData(markerPaths = POSTGRES_HOST_DATA_MARKERS) {
  if (!Array.isArray(markerPaths)) throw new Error('PostgreSQL marker paths must be an array');
  return markerPaths.some((markerPath) => existsSync(markerPath));
}

function planDatabaseSecret(namespace, environment, existingSecret, randomSecret) {
  assertOpaqueSecret(existingSecret, 'mx-launcher-db');
  const existingData = existingSecretData(existingSecret);
  const existing = existingSecret ? {
    PG_USER: decodeRequiredData(existingData, 'PG_USER', 'mx-launcher-db'),
    PG_PASSWORD: decodeRequiredData(existingData, 'PG_PASSWORD', 'mx-launcher-db'),
    PG_DB: decodeRequiredData(existingData, 'PG_DB', 'mx-launcher-db')
  } : null;
  const { values, configuredKeys } = normalizeResolvedEnvironment(environment);

  let pgUser;
  let pgPassword;
  let pgDb;
  if (existing) {
    for (const key of ['PG_USER', 'PG_PASSWORD', 'PG_DB']) {
      validateNonemptySingleLine(`mx-launcher-db/${key}`, existing[key]);
      if (configuredKeys.has(key) && values[key] !== existing[key]) {
        throw new Error(
          `${key} does not match the existing mx-launcher-db Secret; live database identity or credential changes require a separate rotation/migration procedure`
        );
      }
    }
    pgUser = existing.PG_USER;
    pgPassword = existing.PG_PASSWORD;
    pgDb = existing.PG_DB;
  } else {
    pgUser = configuredKeys.has('PG_USER') ? values.PG_USER : DEFAULT_PG_USER;
    pgPassword = configuredKeys.has('PG_PASSWORD') ? values.PG_PASSWORD : randomSecret();
    pgDb = configuredKeys.has('PG_DB') ? values.PG_DB : DEFAULT_PG_DB;
    validateNonemptySingleLine('PG_USER', pgUser);
    validateNonemptySingleLine('PG_PASSWORD', pgPassword);
    validateNonemptySingleLine('PG_DB', pgDb);
  }

  const databaseHost = configuredKeys.has('DATABASE_HOST')
    ? values.DATABASE_HOST.trim()
    : existingData.DATABASE_HOST
      ? decodeData(existingData.DATABASE_HOST, 'mx-launcher-db/DATABASE_HOST')
      : defaultDatabaseHost(namespace);
  validateDatabaseHost(databaseHost);

  const desiredData = {
    ...existingData,
    PG_USER: encodeData(pgUser),
    PG_PASSWORD: encodeData(pgPassword),
    PG_DB: encodeData(pgDb),
    DATABASE_HOST: encodeData(databaseHost),
    DATABASE_URL: encodeData(buildDatabaseUrl({
      pgUser,
      pgPassword,
      pgDb,
      databaseHost
    }))
  };
  return finalizeSecret(namespace, 'mx-launcher-db', desiredData, existingSecret);
}

function planInternalOpsSecret(namespace, environment, existingSecret, randomSecret) {
  assertOpaqueSecret(existingSecret, 'mx-internal-ops');
  const existingData = existingSecretData(existingSecret);
  const { values, configuredKeys } = normalizeResolvedEnvironment(environment);
  let token;
  if (configuredKeys.has('MX_INTERNAL_OPS_TOKEN')) {
    token = values.MX_INTERNAL_OPS_TOKEN;
  } else if (existingData.token) {
    token = decodeData(existingData.token, 'mx-internal-ops/token');
  } else {
    token = randomSecret();
  }
  validateLongSecret('MX_INTERNAL_OPS_TOKEN', token);
  return finalizeSecret(
    namespace,
    'mx-internal-ops',
    { ...existingData, token: encodeData(token) },
    existingSecret
  );
}

function planFeishuSecret(namespace, environment, existingSecret) {
  assertOpaqueSecret(existingSecret, 'mx-feishu-oauth');
  const existingData = existingSecretData(existingSecret);
  const { values, configuredKeys } = normalizeResolvedEnvironment(environment);
  const configuredFeishuKeys = Object.keys(FEISHU_ENV_TO_SECRET_KEY)
    .filter((key) => configuredKeys.has(key));

  if (configuredFeishuKeys.length === 0) {
    if (!existingSecret) return null;
    const existingValues = {};
    for (const [envKey, secretKey] of Object.entries(FEISHU_ENV_TO_SECRET_KEY)) {
      if (!existingData[secretKey]) {
        throw new Error(`mx-feishu-oauth is incomplete; missing ${secretKey} for ${envKey}`);
      }
      existingValues[secretKey] = decodeData(
        existingData[secretKey],
        `mx-feishu-oauth/${secretKey}`
      );
    }
    validateNonemptySingleLine('mx-feishu-oauth/app-id', existingValues['app-id']);
    validateNonemptySingleLine('mx-feishu-oauth/app-secret', existingValues['app-secret']);
    if (existingValues['app-secret'] !== existingValues['app-secret'].trim()) {
      throw new Error('mx-feishu-oauth/app-secret must not contain leading or trailing whitespace');
    }
    canonicalizeTenantKeys(existingValues['tenant-keys']);
    return preserveSecret(namespace, 'mx-feishu-oauth', existingData, existingSecret);
  }

  const resolved = {};
  for (const [envKey, secretKey] of Object.entries(FEISHU_ENV_TO_SECRET_KEY)) {
    if (configuredKeys.has(envKey)) {
      validateNonemptySingleLine(envKey, values[envKey]);
      resolved[secretKey] = values[envKey];
    } else if (existingData[secretKey]) {
      resolved[secretKey] = decodeData(existingData[secretKey], `mx-feishu-oauth/${secretKey}`);
    } else {
      throw new Error(`Feishu OAuth configuration is incomplete; missing ${envKey}`);
    }
  }

  validateNonemptySingleLine('MX_FEISHU_APP_ID', resolved['app-id']);
  validateNonemptySingleLine('MX_FEISHU_APP_SECRET', resolved['app-secret']);
  if (resolved['app-secret'] !== resolved['app-secret'].trim()) {
    throw new Error('MX_FEISHU_APP_SECRET must not contain leading or trailing whitespace');
  }
  resolved['tenant-keys'] = canonicalizeTenantKeys(resolved['tenant-keys']);

  return finalizeSecret(
    namespace,
    'mx-feishu-oauth',
    {
      ...existingData,
      'app-id': encodeData(resolved['app-id'].trim()),
      'app-secret': encodeData(resolved['app-secret']),
      'tenant-keys': encodeData(resolved['tenant-keys'])
    },
    existingSecret
  );
}

function planSdkSecret(namespace, environment, existingSecret) {
  assertOpaqueSecret(existingSecret, 'mx-sdk-service-account-secrets');
  const existingData = existingSecretData(existingSecret);
  const { values, configuredKeys } = normalizeResolvedEnvironment(environment);

  if (!configuredKeys.has('MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON')) {
    if (!existingSecret) return null;
    if (!existingData['secrets.json']) {
      throw new Error('mx-sdk-service-account-secrets is incomplete; missing secrets.json');
    }
    const existingJson = decodeData(
      existingData['secrets.json'],
      'mx-sdk-service-account-secrets/secrets.json'
    );
    canonicalizeSdkServiceAccountSecrets(existingJson);
    return preserveSecret(
      namespace,
      'mx-sdk-service-account-secrets',
      existingData,
      existingSecret
    );
  }

  const canonicalJson = canonicalizeSdkServiceAccountSecrets(
    values.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON
  );
  return finalizeSecret(
    namespace,
    'mx-sdk-service-account-secrets',
    { ...existingData, 'secrets.json': encodeData(canonicalJson) },
    existingSecret
  );
}

function preserveSecret(namespace, name, data, existingSecret) {
  const existingAnnotations = retainedSecretAnnotations(existingSecret);
  return {
    resource: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        namespace,
        ...retainedSecretOwnership(existingSecret),
        ...(isPlainObject(existingSecret.metadata?.labels)
          ? { labels: existingSecret.metadata.labels }
          : {}),
        ...(Object.keys(existingAnnotations).length > 0
          ? { annotations: existingAnnotations }
          : {})
      },
      type: existingSecret.type || 'Opaque',
      ...(existingSecret.immutable === true ? { immutable: true } : {}),
      data: sortObject(data)
    },
    changed: false
  };
}

function finalizeSecret(namespace, name, data, existingSecret) {
  const sortedData = sortObject(data);
  const dataDigest = digestValue(sortedData);
  const existingLabels = isPlainObject(existingSecret?.metadata?.labels)
    ? existingSecret.metadata.labels
    : {};
  const existingAnnotations = retainedSecretAnnotations(existingSecret);
  const resource = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      ...(existingSecret?.metadata?.resourceVersion
        ? { resourceVersion: String(existingSecret.metadata.resourceVersion) }
        : {}),
      ...retainedSecretOwnership(existingSecret),
      labels: { ...existingLabels, ...MANAGED_LABELS },
      annotations: {
        ...existingAnnotations,
        [DATA_DIGEST_ANNOTATION]: `sha256-${dataDigest}`
      }
    },
    type: existingSecret?.type || 'Opaque',
    data: sortedData
  };
  if (existingSecret?.immutable === true) resource.immutable = true;

  const dataChanged = !sameStringMap(existingSecretData(existingSecret), sortedData);
  if (existingSecret?.immutable === true && dataChanged) {
    throw new Error(`${name} is immutable and cannot be updated`);
  }
  const metadataChanged = !managedMetadataMatches(existingSecret, resource);
  return { resource, changed: !existingSecret || dataChanged || metadataChanged };
}

function managedMetadataMatches(existingSecret, desiredSecret) {
  if (!existingSecret) return false;
  if (hasOwn(existingSecret.metadata?.annotations || {}, LAST_APPLIED_ANNOTATION)) return false;
  for (const [key, value] of Object.entries(MANAGED_LABELS)) {
    if (existingSecret.metadata?.labels?.[key] !== value) return false;
  }
  return existingSecret.metadata?.annotations?.[DATA_DIGEST_ANNOTATION]
    === desiredSecret.metadata.annotations[DATA_DIGEST_ANNOTATION];
}

function retainedSecretAnnotations(existingSecret) {
  const annotations = isPlainObject(existingSecret?.metadata?.annotations)
    ? { ...existingSecret.metadata.annotations }
    : {};
  delete annotations[LAST_APPLIED_ANNOTATION];
  return annotations;
}

function retainedSecretOwnership(existingSecret) {
  return {
    ...(Array.isArray(existingSecret?.metadata?.ownerReferences)
      ? { ownerReferences: structuredClone(existingSecret.metadata.ownerReferences) }
      : {}),
    ...(Array.isArray(existingSecret?.metadata?.finalizers)
      ? { finalizers: [...existingSecret.metadata.finalizers] }
      : {})
  };
}

function buildDatabaseUrl({ pgUser, pgPassword, pgDb, databaseHost }) {
  const urlHost = databaseHost.includes(':') && !databaseHost.startsWith('[')
    ? `[${databaseHost}]`
    : databaseHost;
  return `postgres://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@${urlHost}:5432/${encodeURIComponent(pgDb)}`;
}

function canonicalizeTenantKeys(rawValue) {
  const entries = String(rawValue)
    .split(/[,;\r\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error('MX_FEISHU_ALLOWED_TENANT_KEYS must contain at least one tenant key');
  }
  if (entries.some((entry) => entry.includes('*'))) {
    throw new Error('MX_FEISHU_ALLOWED_TENANT_KEYS must not contain wildcards');
  }
  if (entries.some((entry) => !/^[A-Za-z0-9_-]{1,160}$/.test(entry))) {
    throw new Error(
      'MX_FEISHU_ALLOWED_TENANT_KEYS entries must use 1-160 letters, numbers, underscores, or hyphens'
    );
  }
  return [...new Set(entries)].join(',');
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const equalsAt = normalized.indexOf('=');
  if (equalsAt <= 0) return null;
  const key = normalized.slice(0, equalsAt).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return [key, parseEnvValue(normalized.slice(equalsAt + 1).trim())];
}

function parseEnvValue(rawValue) {
  if (rawValue.length < 2) return rawValue;
  const quote = rawValue[0];
  if ((quote !== '"' && quote !== "'") || rawValue[rawValue.length - 1] !== quote) {
    return rawValue;
  }
  const inner = rawValue.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function normalizeResolvedEnvironment(environment) {
  if (!environment || !isPlainObject(environment.values)) {
    throw new Error('environment must contain resolved values');
  }
  const configuredKeys = environment.configuredKeys instanceof Set
    ? environment.configuredKeys
    : new Set(environment.configuredKeys || []);
  return { values: environment.values, configuredKeys };
}

function normalizeExistingSecrets(existingSecrets) {
  const byName = {};
  if (Array.isArray(existingSecrets)) {
    for (const secret of existingSecrets) {
      if (secret?.metadata?.name) byName[secret.metadata.name] = secret;
    }
  } else if (isPlainObject(existingSecrets)) {
    for (const [name, secret] of Object.entries(existingSecrets)) {
      if (secret) byName[name] = secret;
    }
  } else {
    throw new Error('existingSecrets must be an object or array');
  }
  return byName;
}

function existingSecretData(secret) {
  if (!secret) return {};
  if (secret.data === undefined) return {};
  if (!isPlainObject(secret.data)) {
    throw new Error(`${secret.metadata?.name || 'existing Secret'} data must be an object`);
  }
  const data = {};
  for (const [key, value] of Object.entries(secret.data)) {
    if (typeof value !== 'string') {
      throw new Error(`${secret.metadata?.name || 'existing Secret'} data key ${safeIdentifier(key)} must be base64 text`);
    }
    data[key] = value;
  }
  return data;
}

function assertOpaqueSecret(secret, expectedName) {
  if (!secret) return;
  if (secret.metadata?.name && secret.metadata.name !== expectedName) {
    throw new Error(`expected Secret ${expectedName}`);
  }
  if (secret.type && secret.type !== 'Opaque') {
    throw new Error(`${expectedName} must use Secret type Opaque`);
  }
}

function decodeRequiredData(data, key, secretName) {
  if (!data[key]) throw new Error(`${secretName} is incomplete; missing ${key}`);
  return decodeData(data[key], `${secretName}/${key}`);
}

function decodeData(encodedValue, label) {
  const normalized = String(encodedValue);
  if (!isCanonicalBase64(normalized)) {
    throw new Error(`${label} is not valid base64 data`);
  }
  try {
    return textDecoder.decode(Buffer.from(normalized, 'base64'));
  } catch {
    throw new Error(`${label} is not valid UTF-8 text`);
  }
}

function encodeData(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function isCanonicalBase64(value) {
  if (value === '') return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function validateNamespace(namespace) {
  if (
    typeof namespace !== 'string'
    || namespace.length === 0
    || namespace.length > 63
    || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace)
  ) {
    throw new Error('namespace must be a valid Kubernetes DNS label');
  }
}

function validateNonemptySingleLine(key, value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new Error(`${key} must not be empty`);
  }
  if (/[\r\n\0]/.test(value)) throw new Error(`${key} must be a single-line value`);
}

function validateLongSecret(key, value) {
  validateNonemptySingleLine(key, value);
  if (value !== value.trim()) {
    throw new Error(`${key} must not contain leading or trailing whitespace`);
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${key} must contain at least ${MIN_SECRET_LENGTH} characters`);
  }
}

function validateDatabaseHost(value) {
  validateNonemptySingleLine('DATABASE_HOST', value);
  if (value !== value.trim() || /[/@?#]/.test(value) || /\s/.test(value)) {
    throw new Error('DATABASE_HOST must be a host name or IP address without scheme, path, or whitespace');
  }
}

function defaultDatabaseHost(namespace) {
  return `mx-internal-postgres.${namespace}.svc.cluster.local`;
}

function digestValue(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sameStringMap(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => (
    key === rightKeys[index] && left[key] === right[key]
  ));
}

function generateRandomSecret() {
  return randomBytes(32).toString('base64url');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function safeIdentifier(value) {
  return /^[A-Za-z0-9_.:@/-]{1,128}$/.test(value) ? value : '<invalid-id>';
}

function readEnvironmentFile(envFile, processEnvironment) {
  const resolvedEnvFile = resolve(envFile);
  if (!existsSync(resolvedEnvFile)) {
    return resolveKnownEnvironment({}, processEnvironment);
  }
  assertPrivateRegularFile(resolvedEnvFile);
  let content;
  try {
    content = readFileSync(resolvedEnvFile, 'utf8');
  } catch {
    throw new Error('could not read the configured server env file');
  }
  return resolveKnownEnvironment(parseEnvFile(content), processEnvironment);
}

function assertPrivateRegularFile(filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error('could not inspect the configured server env file');
  }
  if (!stat.isFile()) {
    throw new Error('the configured server env path must be a regular file');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('the configured server env file must not be readable or writable by group or other users; run chmod 600');
  }
}

function runKubectl(args, input) {
  const result = spawnSync('kubectl', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !isSensitiveKubectlEnvironmentKey(key))
    )
  });
  return result;
}

function isSensitiveKubectlEnvironmentKey(key) {
  return KNOWN_ENV_KEYS.includes(key)
    || key === 'DATABASE_URL'
    || key.startsWith('MX_RELEASE_OSS_')
    || key.startsWith('OSS_ACCESS_KEY_')
    || key === 'OSS_SECURITY_TOKEN';
}

function fetchExistingSecret(namespace, secretName) {
  const result = runKubectl(
    ['-n', namespace, 'get', 'secret', secretName, '-o', 'json'],
    undefined
  );
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`kubectl returned invalid JSON for Secret ${secretName}`);
    }
  }
  if (isNotFoundResult(result)) return null;
  throw new Error(`kubectl could not read Secret ${secretName}`);
}

function fetchExistingSecrets(namespace) {
  const existingSecrets = {};
  for (const secretName of SECRET_NAMES) {
    const secret = fetchExistingSecret(namespace, secretName);
    if (secret) existingSecrets[secretName] = secret;
  }
  return existingSecrets;
}

function assertDatabaseSecretStorageConsistency(namespace, existingSecrets, environment) {
  if (existingSecrets['mx-launcher-db']) return;
  const explicitDatabaseRestore = hasCompleteExplicitDatabaseCredentials(environment);
  if (hasRetainedPostgresHostData() && !explicitDatabaseRestore) {
    throw new Error(
      'mx-launcher-db is missing while retained PostgreSQL host data exists; restore the Secret or provide the original PG_USER, PG_PASSWORD, and PG_DB together in the private server env file'
    );
  }
  const pvcResult = runKubectl(
    ['-n', namespace, 'get', 'persistentvolumeclaim', POSTGRES_PVC_NAME, '-o', 'name'],
    undefined
  );
  if (pvcResult.status === 0 && pvcResult.stdout.trim()) {
    if (explicitDatabaseRestore) return;
    throw new Error(
      `mx-launcher-db is missing while PostgreSQL PVC ${POSTGRES_PVC_NAME} exists; restore the Secret or provide the original PG_USER, PG_PASSWORD, and PG_DB together`
    );
  }
  if (pvcResult.status !== 0 && !isNotFoundResult(pvcResult)) {
    throw new Error(`kubectl could not inspect PostgreSQL PVC ${POSTGRES_PVC_NAME}`);
  }

  const pvResult = runKubectl(
    ['get', 'persistentvolume', POSTGRES_PV_NAME, '-o', 'name'],
    undefined
  );
  if (pvResult.status === 0 && pvResult.stdout.trim()) {
    if (explicitDatabaseRestore) return;
    throw new Error(
      `mx-launcher-db is missing while PostgreSQL PV ${POSTGRES_PV_NAME} exists; restore the Secret or provide the original PG_USER, PG_PASSWORD, and PG_DB together`
    );
  }
  if (pvResult.status !== 0 && !isNotFoundResult(pvResult)) {
    throw new Error(`kubectl could not inspect PostgreSQL PV ${POSTGRES_PV_NAME}`);
  }
}

function hasCompleteExplicitDatabaseCredentials(environment) {
  const { values, configuredKeys } = normalizeResolvedEnvironment(environment);
  return ['PG_USER', 'PG_PASSWORD', 'PG_DB'].every((key) => (
    configuredKeys.has(key) && typeof values[key] === 'string' && values[key].length > 0
  ));
}

function isNotFoundResult(result) {
  const diagnostic = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /\bNotFound\b|not found/i.test(diagnostic);
}

function applySecretPlan(plan) {
  for (const resource of plan.changedItems) {
    const exists = Boolean(resource.metadata.resourceVersion);
    const result = runKubectl(
      [
        '-n',
        plan.namespace,
        exists ? 'replace' : 'create',
        '--validate=false',
        '-f',
        '-'
      ],
      `${JSON.stringify(resource)}\n`
    );
    if (result.status !== 0) {
      throw new Error(
        `Secret ${resource.metadata.name} changed concurrently or could not be ${exists ? 'replaced' : 'created'}; inspect it and rerun deploy`
      );
    }
  }
}

function assertAppliedSecretPlan(plan, observedSecrets) {
  for (const desired of plan.resources) {
    const observed = observedSecrets[desired.metadata.name];
    if (!observed || !sameStringMap(existingSecretData(observed), desired.data)) {
      throw new Error(`Secret ${desired.metadata.name} was not observed with the validated data after apply`);
    }
  }
}

function usageError() {
  return new Error(
    'Usage: node internal-k8s-secret-ensure.mjs <validate-env|validate-db-recovery-env|preflight|ensure> <namespace> <server-env-file>'
  );
}

function main() {
  const [, , command, namespace, envFile, ...rest] = process.argv;
  if (
    !['validate-env', 'validate-db-recovery-env', 'preflight', 'ensure'].includes(command)
    || !namespace
    || !envFile
    || rest.length > 0
  ) {
    throw usageError();
  }
  validateNamespace(namespace);
  const environment = readEnvironmentFile(envFile, process.env);
  const environmentShapeDigest = validateConfiguredEnvironment(environment);

  if (command === 'validate-env') {
    process.stdout.write(`${formatReadySummary(environmentShapeDigest, 0)}\n`);
    return;
  }
  if (command === 'validate-db-recovery-env') {
    if (!hasCompleteExplicitDatabaseCredentials(environment)) {
      throw new Error(
        'kubeadm reinit with retained PostgreSQL data requires the original PG_USER, PG_PASSWORD, and PG_DB together in the private server env file'
      );
    }
    process.stdout.write(`${formatReadySummary(environmentShapeDigest, 0)}\n`);
    return;
  }

  const existingSecrets = fetchExistingSecrets(namespace);
  assertDatabaseSecretStorageConsistency(namespace, existingSecrets, environment);
  const plan = planInternalK8sSecrets({ namespace, environment, existingSecrets });
  if (command === 'ensure') {
    applySecretPlan(plan);
    const appliedSecrets = fetchExistingSecrets(namespace);
    assertAppliedSecretPlan(plan, appliedSecrets);
    process.stdout.write(
      `${formatReadySummary(observedSecretBundleDigest(namespace, appliedSecrets), plan.changedCount)}\n`
    );
    return;
  }
  process.stdout.write(
    `${formatReadySummary(observedSecretBundleDigest(namespace, existingSecrets), plan.changedCount)}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown failure';
    process.stderr.write(`internal Kubernetes Secret ensure failed: ${message}\n`);
    process.exitCode = 1;
  }
}
