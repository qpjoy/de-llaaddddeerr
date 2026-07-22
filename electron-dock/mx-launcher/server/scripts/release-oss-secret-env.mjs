#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

export function prepareReleaseOssSecretEnv(inputPath, outputPath, processEnvironment = process.env) {
  const fileValues = inputPath && existsSync(inputPath)
    ? parseEnvFile(readFileSync(inputPath, 'utf8'))
    : {};
  const value = (key) => processEnvironment[key] ?? fileValues[key];
  const source = String(value('MX_RELEASE_OSS_SECRET_SOURCE') || 'auto').trim().toLowerCase();
  if (!['auto', 'env', 'external', 'disabled'].includes(source)) {
    throw new Error('MX_RELEASE_OSS_SECRET_SOURCE must be auto, env, external, or disabled');
  }
  if (source === 'disabled') return { status: 'disabled', digest: null, keys: [] };
  if (source === 'external') return { status: 'external', digest: null, keys: [] };

  const values = Object.fromEntries(ALL_KEYS.map((key) => [key, normalizeValue(value(key))]));
  const presentRequired = REQUIRED_KEYS.filter((key) => values[key]);
  const configuredStorage = String(value('MX_RELEASE_ARTIFACT_STORAGE') || 'auto').trim().toLowerCase();
  if (presentRequired.length === 0) {
    if (source === 'env') {
      throw new Error(`Release OSS configuration is required; missing ${REQUIRED_KEYS.join(', ')}`);
    }
    return { status: configuredStorage === 'oss' ? 'required' : 'absent', digest: null, keys: [] };
  }

  const missing = REQUIRED_KEYS.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new Error(`Release OSS configuration is incomplete; missing ${missing.join(', ')}`);
  }
  validateEndpoint(values.MX_RELEASE_OSS_ENDPOINT);
  validateBucket(values.MX_RELEASE_OSS_BUCKET);

  values.MX_RELEASE_OSS_PREFIX ||= 'mx-launcher/releases';
  values.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS ||= '3600';
  validateTtl(values.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS);
  for (const [key, rawValue] of Object.entries(values)) {
    if (/\r|\n/.test(rawValue)) throw new Error(`${key} must be a single-line value`);
  }

  const content = `${ALL_KEYS.map((key) => `${key}=${values[key]}`).join('\n')}\n`;
  writeFileSync(resolve(outputPath), content, { encoding: 'utf8', mode: 0o600 });
  const digest = createHash('sha256').update(content).digest('hex');
  return { status: 'ready', digest, keys: [...ALL_KEYS] };
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
  const [, , command, inputPath, outputPath] = process.argv;
  if (command !== 'prepare' || !inputPath || !outputPath) {
    throw new Error('Usage: node release-oss-secret-env.mjs prepare <server-env-file> <output-env-file>');
  }
  const result = prepareReleaseOssSecretEnv(resolve(inputPath), resolve(outputPath));
  process.stdout.write(`${result.status}${result.digest ? ` ${result.digest}` : ''}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release OSS secret preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
