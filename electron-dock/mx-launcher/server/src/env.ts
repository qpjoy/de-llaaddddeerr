import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let loaded = false;

export function loadServerEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const envPath of serverEnvCandidates()) {
    if (!existsSync(envPath)) continue;
    loadEnvFile(envPath);
    return;
  }
}

function serverEnvCandidates(): string[] {
  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  return uniqueStrings([
    process.env.MX_SERVER_ENV_FILE?.trim(),
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'server/.env'),
    resolve(process.cwd(), 'electron-dock/mx-launcher/server/.env'),
    resolve(runtimeDir, '../.env'),
    resolve(runtimeDir, '../../.env')
  ].filter((item): item is string => Boolean(item)));
}

function loadEnvFile(envPath: string): void {
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const equalsAt = normalized.indexOf('=');
  if (equalsAt <= 0) return null;
  const key = normalized.slice(0, equalsAt).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return [key, parseEnvValue(normalized.slice(equalsAt + 1).trim())];
}

function parseEnvValue(raw: string): string {
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

loadServerEnv();
