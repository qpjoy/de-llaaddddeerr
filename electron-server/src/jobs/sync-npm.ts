/**
 * Scans the npm registry for QPJoy marketplace plugins and games, extracts
 * each latest version's marketplace manifest, and writes:
 *
 *   data/version.json
 *   data/marketplace-index.json
 *   data/plugins/<id>.json
 *
 * Runs as either a one-shot CLI (`pnpm sync:npm`) or a cron job inside the
 * server. Network access is required: we hit
 *
 *   https://registry.npmjs.org/-/v1/search?text=scope:@qpjoy
 *   https://registry.npmjs.org/<pkg>
 *   https://registry.npmjs.org/<pkg>/-/<file>.tgz
 *
 * No auth needed for public packages.
 *
 * ## Inclusion rule (post-rename, see docs/PUBLISH.md)
 *
 * A plugin package shows up in the marketplace iff **all** of:
 *
 *   1. (cheap pre-filter) name matches `<NPM_SCOPE>/<NPM_PREFIX>*`. Default
 *      `@qpjoy/electron-*`. Plus any names in `MARKETPLACE_ALLOWLIST` are
 *      force-included even if they don't match the prefix (so packages with
 *      bootstrap packages like `@qpjoy/electron-plugin-tunnel` still surface
 *      even before npm search has indexed them.
 *   2. (authoritative) latest version's `package.json` carries a
 *      `qpjoyPlugin: { specVersion, manifest, ... }` field pointing at a
 *      real plugin manifest.
 *   3. `qpjoyPlugin.self !== true` — the host package itself (`@qpjoy/
 *      electron-market`) carries the field for plugin-spec compatibility,
 *      but it's not an installable plugin in *its own* marketplace.
 *
 * Game packages use the parallel `qpjoyGame: { specVersion, manifest, ... }`
 * field. During this phase they must also carry `qpjoyPlugin`, so the current
 * desktop market can install and activate them through the existing plugin
 * runtime while rendering them in the game board via `metadata.kind = "game"`.
 *
 * Packages that match the name filter but lack both fields are quietly
 * dropped (recorded in `rejected[]` for diagnostics). No more "soft" entries
 * cluttering the UI with non-installable cards.
 */
import { createWriteStream } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { storage, etagOf } from '../data/storage.js';
import type {
  MarketplaceEntryDTO,
  MarketplaceIndexDTO,
  PluginDetailDTO,
  PluginVersionDTO,
  VersionManifestDTO
} from '../data/types.js';

const exec = promisify(execFile);

const NPM_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org';
const NPM_SCOPE = process.env.NPM_SCOPE ?? '@qpjoy';
const NPM_PREFIX = process.env.NPM_PREFIX ?? 'electron-';

/**
 * Comma-separated allowlist of npm packages that should be force-included
 * in marketplace discovery even when they fail the prefix pre-filter.
 *
 * Two reasons this exists:
 *   1. Bootstrap packages: `@qpjoy/electron-plugin-tunnel` should remain
 *      visible even if discovery rules or registry indexing lag behind.
 *   2. npm search index lag: a freshly-published package may not appear in
 *      `/-/v1/search` results for hours. Force-fetching by name bypasses that.
 *
 * Either way, the package still has to satisfy the authoritative check
 * (`qpjoyPlugin` field present, `self !== true`); allowlisting only
 * controls *discovery*, not *legitimacy*.
 */
const DEFAULT_MARKETPLACE_ALLOWLIST = [
  '@qpjoy/electron-plugin-tunnel',
  '@qpjoy/electron-plugin-notyet',
  '@qpjoy/electron-game-suduku'
];
const MARKETPLACE_ALLOWLIST = (process.env.MARKETPLACE_ALLOWLIST ?? DEFAULT_MARKETPLACE_ALLOWLIST.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface NpmSearchResult {
  objects: Array<{ package: { name: string; version: string; description?: string } }>;
}

interface NpmPackageMetadata {
  name: string;
  'dist-tags': { latest: string } & Record<string, string>;
  versions: Record<
    string,
    {
      name: string;
      version: string;
      description?: string;
      author?: string | { name?: string };
      homepage?: string;
      dist: { tarball: string; shasum: string };
      qpjoyPlugin?: { specVersion: number; manifest: string; entry?: string; self?: boolean };
      qpjoyGame?: { specVersion: number; manifest: string; entry?: string };
    }
  >;
  time?: Record<string, string>;
}

export interface SyncReport {
  release: string;
  scannedPackages: number;
  acceptedPlugins: number;
  rejected: Array<{ name: string; reason: string }>;
  durationMs: number;
}

export async function runSync(opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
  const started = Date.now();
  const rejected: SyncReport['rejected'] = [];
  const accepted: PluginDetailDTO[] = [];

  // 1. Find packages. Besides npm search, refresh anything already present
  // in the server catalogue so existing games/plugins continue to update
  // even when npm search indexing lags behind a fresh publish.
  const candidates = await discoverCandidates();

  // 2. For each, fetch metadata + extract manifest.
  for (const name of candidates) {
    try {
      const outcome = await syncOne(name);
      if (outcome.kind === 'accepted') accepted.push(outcome.detail);
      else rejected.push({ name, reason: outcome.reason });
    } catch (err) {
      rejected.push({
        name,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // 3. Build the index + version manifest.
  const generatedAt = new Date().toISOString();
  const release = generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const indexEntries: MarketplaceEntryDTO[] = accepted.map(stripDetailToEntry);

  const index: MarketplaceIndexDTO = {
    generatedAt,
    release,
    entries: indexEntries.sort((a, b) => a.id.localeCompare(b.id))
  };

  const version: VersionManifestDTO = {
    release,
    minClientRelease: null,
    marketSpecVersion: 1,
    supportedSpecRange: '>=1 <=1',
    migrationsHead: storage.listMigrations().reduce((n, m) => Math.max(n, m.version), 0),
    manifestEtag: etagOf(index),
    publishedAt: generatedAt
  };

  if (!opts.dryRun) {
    for (const plugin of accepted) storage.setPlugin(plugin);
    storage.setIndex(index);
    storage.setVersion(version);
  }

  return {
    release,
    scannedPackages: candidates.length,
    acceptedPlugins: accepted.length,
    rejected,
    durationMs: Date.now() - started
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Internals                                                              */
/* ────────────────────────────────────────────────────────────────────── */

async function discoverCandidates(): Promise<string[]> {
  const candidates = new Set<string>();
  try {
    for (const name of await searchScope()) {
      candidates.add(name);
    }
  } catch (err) {
    // npm search is aggressively rate-limited. Treat it as discovery-only:
    // sync can still refresh allowlisted packages and anything already in
    // the server catalogue.
    console.warn(
      `[sync-npm] npm search unavailable, falling back to allowlist + existing catalogue: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  for (const name of existingMarketplacePackages()) {
    candidates.add(name);
  }
  for (const name of await discoverAllowlistedPackages(candidates)) {
    candidates.add(name);
  }
  return Array.from(candidates).sort();
}

function existingMarketplacePackages(): string[] {
  const names = new Set<string>();
  const index = storage.getIndex();
  for (const entry of index?.entries ?? []) {
    if (entry.npm) names.add(entry.npm);
  }
  for (const detail of storage.listPlugins()) {
    if (detail.npm) names.add(detail.npm);
  }
  return Array.from(names);
}

async function searchScope(): Promise<string[]> {
  // npm's `scope:` search filter is unreliable for some scopes (returns 0
  // results), so we do a plain text search for `<scope>/<prefix>` and then
  // filter the response client-side. This costs a few extra unrelated hits
  // per page but is robust.
  const seen = new Set<string>();
  let from = 0;
  const size = 100;
  const needle = `${NPM_SCOPE}/${NPM_PREFIX}`;
  const queryText = encodeURIComponent(needle);

  for (let i = 0; i < 10; i++) {
    const url = `${NPM_REGISTRY}/-/v1/search?text=${queryText}&from=${from}&size=${size}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`npm search failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as NpmSearchResult;
    for (const o of body.objects) {
      if (o.package.name.startsWith(needle)) {
        seen.add(o.package.name);
      }
    }
    if (body.objects.length < size) break;
    from += size;
  }

  return Array.from(seen).sort();
}

async function discoverAllowlistedPackages(existing: Set<string>): Promise<string[]> {
  const seen = new Set<string>();

  // Allowlist fallback. Force-includes packages that either (a) don't match
  // the prefix at all (legacy names) or (b) match but haven't propagated
  // into npm's search index yet. We just probe the registry for the name —
  // if it 200s, the package exists and `syncOne` will decide whether it's
  // a legitimate plugin via its `qpjoyPlugin` field.
  for (const allowed of MARKETPLACE_ALLOWLIST) {
    if (existing.has(allowed)) continue;
    try {
      const probeUrl = `${NPM_REGISTRY}/${encodeURIComponent(allowed).replace('%40', '@')}`;
      const res = await fetch(probeUrl, { method: 'HEAD' });
      if (res.ok) seen.add(allowed);
    } catch {
      /* ignore — package will just be absent from this sync round */
    }
  }

  return Array.from(seen).sort();
}

type SyncOutcome =
  | { kind: 'accepted'; detail: PluginDetailDTO }
  | { kind: 'rejected'; reason: string };

async function syncOne(name: string): Promise<SyncOutcome> {
  const meta = (await fetchJson(
    `${NPM_REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`
  )) as NpmPackageMetadata;

  const latestVer = meta['dist-tags']?.latest;
  if (!latestVer) return { kind: 'rejected', reason: 'no latest dist-tag' };
  const v = meta.versions[latestVer];
  if (!v) return { kind: 'rejected', reason: `no version data for ${latestVer}` };

  // Authoritative inclusion check: a real qpjoyPlugin or qpjoyGame field must
  // point at a manifest inside the tarball. Game packages also need qpjoyPlugin
  // during this phase because the desktop installer still uses PluginStore.
  if (!v.qpjoyPlugin && !v.qpjoyGame) {
    return {
      kind: 'rejected',
      reason: 'missing qpjoyPlugin/qpjoyGame field in package.json (not a marketplace package)'
    };
  }

  if (v.qpjoyGame && !v.qpjoyPlugin) {
    return {
      kind: 'rejected',
      reason: 'qpjoyGame package is missing qpjoyPlugin compatibility field'
    };
  }

  // The host package itself (`@qpjoy/electron-market`) carries `qpjoyPlugin`
  // for spec-compatibility (it ships a manifest, it has the same shape) but
  // its `self: true` marks it as the runtime — not an installable plugin in
  // its own marketplace. Skip silently.
  if (v.qpjoyPlugin?.self === true) {
    return { kind: 'rejected', reason: 'qpjoyPlugin.self=true (host package, not a plugin)' };
  }

  const packageKind = v.qpjoyGame ? 'game' : 'plugin';
  const marketplaceSpec = v.qpjoyGame ?? v.qpjoyPlugin;
  if (!marketplaceSpec) {
    return { kind: 'rejected', reason: 'missing marketplace spec' };
  }

  // Pull the manifest out of the published tarball.
  const tarball = v.dist.tarball;
  const tmp = mkdtempSync(join(tmpdir(), 'qpjoy-sync-'));
  let manifest: Record<string, unknown>;
  let manifestChecksum: string;
  try {
    const tgz = join(tmp, 'pkg.tgz');
    await downloadTo(tarball, tgz);
    await exec('tar', ['-xzf', tgz, '-C', tmp]);
    // npm publishes inside a "package/" prefix.
    const manifestRel = marketplaceSpec.manifest;
    const raw = await readFile(join(tmp, 'package', manifestRel), 'utf8');
    manifest = JSON.parse(raw) as Record<string, unknown>;
    manifestChecksum = 'sha256:' + createHash('sha256').update(raw).digest('hex');
  } catch (err) {
    throw new Error(
      `failed to read ${name}@${latestVer} manifest: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (!manifest || typeof manifest !== 'object') {
    return { kind: 'rejected', reason: 'manifest payload is not an object' };
  }

  const id = String(manifest.id ?? '');
  if (!id) {
    return { kind: 'rejected', reason: 'manifest is missing required `id` field' };
  }

  const versions: PluginVersionDTO[] = Object.entries(meta.versions)
    .map(([versionStr, ver]) => ({
      version: versionStr,
      changelog: null,
      releasedAt: meta.time?.[versionStr] ?? null,
      minHostVersion: null,
      maxHostVersion: null,
      deprecated: false,
      yanked: false,
      manifestChecksum: versionStr === latestVer ? manifestChecksum : null,
      tarballChecksum: 'sha1:' + ver.dist.shasum,
      tarballUrl: ver.dist.tarball
    }))
    .sort((a, b) => (a.releasedAt && b.releasedAt ? b.releasedAt.localeCompare(a.releasedAt) : 0));

  const detail: PluginDetailDTO = {
    id,
    npm: name,
    name: String(manifest.name ?? name),
    description: typeof manifest.description === 'string' ? manifest.description : (v?.description ?? null),
    latestVersion: latestVer,
    manifestUrl: `${NPM_REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}/-/${name.split('/').pop()}-${latestVer}.tgz`,
    tarballUrl: v.dist.tarball,
    homepage: v?.homepage ?? null,
    author: typeof v?.author === 'string' ? v.author : v?.author?.name ?? null,
    category: packageKind === 'game'
      ? `game:${typeof manifest.category === 'string' ? manifest.category : 'uncategorized'}`
      : null,
    // `@qpjoy/*` is the first-party scope. Anything outside it is verified=false.
    verified: name.startsWith('@qpjoy/'),
    bootstrap: id === 'qpjoy.electron-tunnel',
    visibility: 'public',
    specVersion: Number(marketplaceSpec.specVersion ?? 1),
    metadata: packageKind === 'game'
      ? {
          kind: 'game',
          gameId: String(manifest.gameId ?? id),
          modes: Array.isArray(manifest.modes)
            ? manifest.modes
                .map((mode) => (
                  mode && typeof mode === 'object' && 'id' in mode
                    ? String((mode as { id: unknown }).id)
                    : null
                ))
                .filter(Boolean)
            : [],
          installRuntime: 'qpjoyPlugin',
          launchRpc: 'launch'
        }
      : null,
    versions,
    latestManifest: manifest,
    extra: null
  };

  return { kind: 'accepted', detail };
}

function stripDetailToEntry(detail: PluginDetailDTO): MarketplaceEntryDTO {
  const {
    versions: _versions,
    latestManifest: _latestManifest,
    extra: _extra,
    ...rest
  } = detail;
  return rest;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText} ${url}`);
  }
  // Node 18+ fetch body is a Web ReadableStream; Readable.fromWeb adapts it
  // to a Node stream usable by pipeline().
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(dest));
}

/* CLI entry */
if (import.meta.url === `file://${process.argv[1]}`) {
  runSync({ dryRun: process.argv.includes('--dry-run') })
    .then((report) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
