import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  MarketplaceIndexDTO,
  MigrationDTO,
  PluginDetailDTO,
  VersionManifestDTO
} from './types.js';

/**
 * File-backed storage for the dev/MVP server. JSON sits flat under
 * `electron-server/data/`. Postgres comes later behind the same interface.
 *
 * Layout:
 *   data/
 *   ├─ version.json
 *   ├─ marketplace-index.json
 *   ├─ plugins/<id>.json
 *   └─ migrations/<NNNN>.json     (each carries up/down SQL + checksum)
 */

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_ROOT = resolve(here, '..', '..', 'data');

mkdirSync(DATA_ROOT, { recursive: true });
mkdirSync(join(DATA_ROOT, 'plugins'), { recursive: true });
mkdirSync(join(DATA_ROOT, 'migrations'), { recursive: true });

function readJsonOr<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[storage] bad JSON at ${path}:`, err);
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export const storage = {
  /* ─── version manifest ────────────────────────────────────────────── */
  getVersion(): VersionManifestDTO | null {
    return readJsonOr<VersionManifestDTO | null>(join(DATA_ROOT, 'version.json'), null);
  },
  setVersion(v: VersionManifestDTO): void {
    writeJson(join(DATA_ROOT, 'version.json'), v);
  },

  /* ─── marketplace index ───────────────────────────────────────────── */
  getIndex(): MarketplaceIndexDTO | null {
    return readJsonOr<MarketplaceIndexDTO | null>(
      join(DATA_ROOT, 'marketplace-index.json'),
      null
    );
  },
  setIndex(index: MarketplaceIndexDTO): { etag: string } {
    writeJson(join(DATA_ROOT, 'marketplace-index.json'), index);
    const etag = etagOf(index);
    return { etag };
  },
  indexEtag(): string | null {
    const idx = this.getIndex();
    return idx ? etagOf(idx) : null;
  },

  /* ─── per-plugin details ──────────────────────────────────────────── */
  getPlugin(id: string): PluginDetailDTO | null {
    return readJsonOr<PluginDetailDTO | null>(
      join(DATA_ROOT, 'plugins', `${safeId(id)}.json`),
      null
    );
  },
  setPlugin(plugin: PluginDetailDTO): void {
    writeJson(join(DATA_ROOT, 'plugins', `${safeId(plugin.id)}.json`), plugin);
  },
  listPlugins(): PluginDetailDTO[] {
    const dir = join(DATA_ROOT, 'plugins');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJsonOr<PluginDetailDTO | null>(join(dir, f), null))
      .filter((p): p is PluginDetailDTO => Boolean(p));
  },

  /* ─── migrations ──────────────────────────────────────────────────── */
  getMigration(version: number): MigrationDTO | null {
    return readJsonOr<MigrationDTO | null>(
      join(DATA_ROOT, 'migrations', `${pad(version)}.json`),
      null
    );
  },
  listMigrations(): MigrationDTO[] {
    const dir = join(DATA_ROOT, 'migrations');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJsonOr<MigrationDTO | null>(join(dir, f), null))
      .filter((m): m is MigrationDTO => Boolean(m))
      .sort((a, b) => a.version - b.version);
  },
  setMigration(m: MigrationDTO): void {
    writeJson(join(DATA_ROOT, 'migrations', `${pad(m.version)}.json`), m);
  }
};

export function etagOf(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/** Disallow path traversal in plugin id → file mapping. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}
