#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_KEYS = [
  'MX_RELEASE_OSS_ENDPOINT',
  'MX_RELEASE_OSS_BUCKET',
  'MX_RELEASE_OSS_ACCESS_KEY_ID',
  'MX_RELEASE_OSS_ACCESS_KEY_SECRET'
];

const OPTIONAL_KEYS = [
  'MX_RELEASE_OSS_SECURITY_TOKEN',
  'MX_RELEASE_OSS_PREFIX',
  'MX_RELEASE_OSS_PUBLIC_BASE_URL',
  'MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS'
];

const ALL_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
const EXPLICITLY_CLEARABLE_KEYS = [
  'MX_RELEASE_OSS_SECURITY_TOKEN',
  'MX_RELEASE_OSS_PUBLIC_BASE_URL'
];
const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration';
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function prepareReleaseOssSecretEnv(
  inputPath,
  outputPath,
  processEnvironment = process.env,
  existingSecret = null
) {
  const plan = planReleaseOssSecret({
    inputPath,
    processEnvironment,
    existingSecret,
    allowIncomplete: false
  });
  if (plan.content !== null) {
    writeFileSync(resolve(outputPath), plan.content, { encoding: 'utf8', mode: 0o600 });
  }
  return publicPlan(plan);
}

export function prepareReleaseOssK8sSecretResource(
  inputPath,
  outputPath,
  namespace,
  processEnvironment = process.env,
  existingSecret = null
) {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)) {
    throw new Error('namespace must be a valid Kubernetes DNS label');
  }
  const plan = planReleaseOssSecret({
    inputPath,
    processEnvironment,
    existingSecret,
    allowIncomplete: false
  });
  if (plan.status !== 'ready') return publicPlan(plan);

  const existingData = existingSecret?.data && typeof existingSecret.data === 'object'
    ? existingSecret.data
    : {};
  const existingLabels = existingSecret?.metadata?.labels && typeof existingSecret.metadata.labels === 'object'
    ? existingSecret.metadata.labels
    : {};
  const existingAnnotations = existingSecret?.metadata?.annotations
    && typeof existingSecret.metadata.annotations === 'object'
    ? { ...existingSecret.metadata.annotations }
    : {};
  delete existingAnnotations[LAST_APPLIED_ANNOTATION];
  const resource = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: 'mx-release-oss',
      namespace,
      ...(existingSecret?.metadata?.resourceVersion
        ? { resourceVersion: String(existingSecret.metadata.resourceVersion) }
        : {}),
      ...(Array.isArray(existingSecret?.metadata?.ownerReferences)
        ? { ownerReferences: structuredClone(existingSecret.metadata.ownerReferences) }
        : {}),
      ...(Array.isArray(existingSecret?.metadata?.finalizers)
        ? { finalizers: [...existingSecret.metadata.finalizers] }
        : {}),
      labels: {
        ...existingLabels,
        'app.kubernetes.io/name': 'mx-release-oss',
        'app.kubernetes.io/part-of': 'mx-3ks',
        'mx.qpjoy.com/managed-by': 'mx-launcher'
      },
      annotations: {
        ...existingAnnotations,
        'mx.qpjoy.com/source': 'server-env',
        'mx.qpjoy.com/material-digest': `sha256-${plan.digest}`
      }
    },
    type: 'Opaque',
    ...(existingSecret?.immutable === true ? { immutable: true } : {}),
    data: {
      ...existingData,
      ...Object.fromEntries(
        ALL_KEYS.map((key) => [
          key,
          Buffer.from(plan.values[key], 'utf8').toString('base64')
        ])
      )
    }
  };
  if (
    existingSecret?.immutable === true
    && ALL_KEYS.some((key) => existingSecret.data?.[key] !== resource.data[key])
  ) {
    throw new Error('mx-release-oss is immutable and cannot be updated');
  }
  if (existingSecret && releaseOssResourceMatches(existingSecret, resource)) {
    return publicPlan({ ...plan, status: 'unchanged' });
  }
  writeFileSync(resolve(outputPath), `${JSON.stringify(resource)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return publicPlan(plan);
}

function releaseOssResourceMatches(existingSecret, desiredSecret) {
  if (existingSecret.type && existingSecret.type !== 'Opaque') return false;
  if (hasOwn(existingSecret.metadata?.annotations || {}, LAST_APPLIED_ANNOTATION)) return false;
  for (const key of ALL_KEYS) {
    if (existingSecret.data?.[key] !== desiredSecret.data[key]) return false;
  }
  for (const [key, value] of Object.entries(desiredSecret.metadata.labels)) {
    if (existingSecret.metadata?.labels?.[key] !== value) return false;
  }
  for (const [key, value] of Object.entries(desiredSecret.metadata.annotations)) {
    if (existingSecret.metadata?.annotations?.[key] !== value) return false;
  }
  return true;
}

export function validateReleaseOssLocalEnvironment(
  inputPath,
  processEnvironment = process.env
) {
  return publicPlan(planReleaseOssSecret({
    inputPath,
    processEnvironment,
    existingSecret: null,
    allowIncomplete: true
  }));
}

export function validateReleaseOssK8sSecret(secret) {
  const values = decodeExistingSecret(secret);
  const missingKeys = ALL_KEYS.filter((key) => !hasOwn(values, key));
  if (missingKeys.length > 0) {
    throw new Error(`mx-release-oss is incomplete; missing ${missingKeys.join(', ')}`);
  }
  validateCompleteValues(values);
  return {
    resourceVersion: String(secret.metadata?.resourceVersion || '')
  };
}

function planReleaseOssSecret({
  inputPath,
  processEnvironment,
  existingSecret,
  allowIncomplete
}) {
  const fileValues = readEnvFile(inputPath);
  const hasConfiguredValue = (key) => (
    hasOwn(processEnvironment, key) || hasOwn(fileValues, key)
  );
  const value = (key) => (
    hasOwn(processEnvironment, key) ? processEnvironment[key] : fileValues[key]
  );
  const source = String(value('MX_RELEASE_OSS_SECRET_SOURCE') || 'auto').trim().toLowerCase();
  if (!['auto', 'env', 'external', 'disabled'].includes(source)) {
    throw new Error('MX_RELEASE_OSS_SECRET_SOURCE must be auto, env, external, or disabled');
  }
  if (source === 'disabled') return emptyPlan('disabled');
  if (source === 'external') return emptyPlan('external');

  const existingValues = existingSecret ? decodeExistingSecret(existingSecret) : {};
  const configuredKeys = ALL_KEYS.filter((key) => (
    hasConfiguredValue(key)
    && (
      normalizeValue(value(key)) !== ''
      || (source === 'env' && EXPLICITLY_CLEARABLE_KEYS.includes(key))
    )
  ));
  const configuredRequiredKeys = REQUIRED_KEYS.filter((key) => configuredKeys.includes(key));
  const configuredStorage = String(value('MX_RELEASE_ARTIFACT_STORAGE') || 'auto').trim().toLowerCase();
  if (configuredRequiredKeys.length === 0 && !existingSecret) {
    if (source === 'env') {
      throw new Error(`Release OSS configuration is required; missing ${REQUIRED_KEYS.join(', ')}`);
    }
    return emptyPlan(configuredStorage === 'oss' ? 'required' : 'absent');
  }

  const values = Object.fromEntries(ALL_KEYS.map((key) => [
    key,
    configuredKeys.includes(key)
      ? normalizeValue(value(key))
      : (hasOwn(existingValues, key) ? existingValues[key] : '')
  ]));
  const missing = REQUIRED_KEYS.filter((key) => !values[key]);
  if (missing.length > 0) {
    if (allowIncomplete && configuredKeys.length > 0) {
      validateConfiguredSubset(values, configuredKeys);
      return emptyPlan('partial');
    }
    throw new Error(`Release OSS configuration is incomplete; missing ${missing.join(', ')}`);
  }

  values.MX_RELEASE_OSS_PREFIX ||= 'mx-launcher/releases';
  values.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS ||= '3600';
  validateCompleteValues(values);

  const content = `${ALL_KEYS.map((key) => `${key}=${values[key]}`).join('\n')}\n`;
  const digest = createHash('sha256').update(content).digest('hex');
  return { status: 'ready', digest, keys: [...ALL_KEYS], content, values };
}

function publicPlan(plan) {
  return {
    status: plan.status,
    digest: plan.digest,
    keys: plan.keys
  };
}

function emptyPlan(status) {
  return { status, digest: null, keys: [], content: null, values: null };
}

function readEnvFile(inputPath) {
  if (!inputPath || !existsSync(inputPath)) return {};
  assertPrivateRegularFile(inputPath, 'configured server env file');
  return parseEnvFile(readFileSync(inputPath, 'utf8'));
}

function readExistingSecretFile(existingPath) {
  if (!existingPath || !existsSync(existingPath)) return null;
  assertPrivateRegularFile(existingPath, 'temporary existing Secret file');
  try {
    return JSON.parse(readFileSync(existingPath, 'utf8'));
  } catch {
    throw new Error('temporary existing mx-release-oss file must contain valid JSON');
  }
}

function assertPrivateRegularFile(filePath, label) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`could not inspect the ${label}`);
  }
  if (!stat.isFile()) throw new Error(`the ${label} must be a regular file`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`the ${label} must not be readable or writable by group or other users; run chmod 600`);
  }
}

function decodeExistingSecret(secret) {
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error('mx-release-oss must be a Kubernetes Secret object');
  }
  if (secret.kind !== 'Secret' || secret.metadata?.name !== 'mx-release-oss') {
    throw new Error('expected Kubernetes Secret mx-release-oss');
  }
  if (secret.type && secret.type !== 'Opaque') {
    throw new Error('mx-release-oss must use type Opaque');
  }
  if (!secret.data || typeof secret.data !== 'object' || Array.isArray(secret.data)) {
    throw new Error('mx-release-oss data must be an object');
  }
  const decoded = {};
  for (const key of ALL_KEYS) {
    if (!hasOwn(secret.data, key)) continue;
    decoded[key] = decodeBase64(secret.data[key], key);
  }
  return decoded;
}

function decodeBase64(value, key) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`mx-release-oss/${key} must contain valid base64 data`);
  }
  try {
    return textDecoder.decode(Buffer.from(value, 'base64'));
  } catch {
    throw new Error(`mx-release-oss/${key} must contain valid UTF-8 data`);
  }
}

function validateConfiguredSubset(values, configuredKeys) {
  for (const key of configuredKeys) validateSingleLineValue(key, values[key]);
  if (configuredKeys.includes('MX_RELEASE_OSS_ENDPOINT') && values.MX_RELEASE_OSS_ENDPOINT) {
    validateEndpoint(values.MX_RELEASE_OSS_ENDPOINT);
  }
  if (configuredKeys.includes('MX_RELEASE_OSS_BUCKET') && values.MX_RELEASE_OSS_BUCKET) {
    validateBucket(values.MX_RELEASE_OSS_BUCKET);
  }
  if (
    configuredKeys.includes('MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS')
    && values.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS
  ) {
    validateTtl(values.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS);
  }
}

function validateCompleteValues(values) {
  const missing = REQUIRED_KEYS.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new Error(`Release OSS configuration is incomplete; missing ${missing.join(', ')}`);
  }
  validateEndpoint(values.MX_RELEASE_OSS_ENDPOINT);
  validateBucket(values.MX_RELEASE_OSS_BUCKET);
  validateTtl(values.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS);
  for (const key of ALL_KEYS) validateSingleLineValue(key, values[key]);
}

function validateSingleLineValue(key, value) {
  if (typeof value !== 'string') throw new Error(`${key} must be a string value`);
  if (value !== value.trim()) throw new Error(`${key} must not contain leading or trailing whitespace`);
  if (/[\r\n\0]/.test(value)) throw new Error(`${key} must be a single-line value`);
}

function parseEnvFile(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) values[parsed[0]] = parsed[1];
  }
  return values;
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

function parseEnvValue(raw) {
  if (raw.length < 2) return raw;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) return raw;
  const inner = raw.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function normalizeValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('MX_RELEASE_OSS_ENDPOINT must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('MX_RELEASE_OSS_ENDPOINT must use http or https');
  }
}

function validateBucket(value) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) {
    throw new Error('MX_RELEASE_OSS_BUCKET must be a 3-63 character lowercase OSS bucket name');
  }
}

function validateTtl(value) {
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new Error('MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS must be an integer between 60 and 86400');
  }
}

function main() {
  const [, , command, ...args] = process.argv;
  if (command === 'prepare' && args.length >= 2 && args.length <= 3) {
    const [inputPath, outputPath, existingPath] = args;
    const existingSecret = readExistingSecretFile(existingPath);
    const result = prepareReleaseOssSecretEnv(
      resolve(inputPath),
      resolve(outputPath),
      process.env,
      existingSecret
    );
    process.stdout.write(`${result.status}${result.digest ? ` ${result.digest}` : ''}\n`);
    return;
  }
  if (command === 'prepare-k8s' && args.length >= 3 && args.length <= 4) {
    const [inputPath, outputPath, namespace, existingPath] = args;
    const existingSecret = readExistingSecretFile(existingPath);
    const result = prepareReleaseOssK8sSecretResource(
      resolve(inputPath),
      resolve(outputPath),
      namespace,
      process.env,
      existingSecret
    );
    process.stdout.write(`${result.status}${result.digest ? ` ${result.digest}` : ''}\n`);
    return;
  }
  if (command === 'validate-local' && args.length === 1) {
    const result = validateReleaseOssLocalEnvironment(resolve(args[0]), process.env);
    process.stdout.write(`${result.status}\n`);
    return;
  }
  if (command === 'validate-k8s-secret' && args.length === 0) {
    let secret;
    try {
      secret = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      throw new Error('stdin must contain a Kubernetes Secret JSON object');
    }
    validateReleaseOssK8sSecret(secret);
    process.stdout.write('ready\n');
    return;
  }
  throw new Error(
    'Usage: node release-oss-secret-env.mjs '
    + '<prepare <server-env-file> <output-env-file> [existing-secret-json-file]'
    + '|prepare-k8s <server-env-file> <output-json-file> <namespace> [existing-secret-json-file]'
    + '|validate-local <server-env-file>|validate-k8s-secret>'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release OSS secret preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
