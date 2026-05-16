import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import type { MarketplaceEntry, MarketplaceIndex } from '../types';

export interface MarketplaceClientOptions {
  /** Remote index URL. Optional — if absent, only the bundled seed is used. */
  indexUrl?: string;
  /**
   * Path to a bundled JSON seed used when the remote can't be reached. If
   * omitted we look for `dist/seed-index.json` colocated with this file
   * (the host package's build step copies it there).
   */
  seedPath?: string;
  /** Optional fetch impl override — handy for tests / offline mirrors. */
  fetch?: typeof fetch;
  /** Cache TTL for the remote fetch in ms (default 5 min). */
  ttlMs?: number;
}

export type MarketplaceSource = 'remote' | 'cache' | 'seed';

export interface MarketplaceFetchResult {
  index: MarketplaceIndex;
  /** Where the data came from on this call. */
  source: MarketplaceSource;
  /** ISO timestamp of the last successful remote fetch, if any. */
  remoteFetchedAt: string | null;
  /** Whatever error stopped us from going to the remote, if any. */
  remoteError: string | null;
}

/**
 * Read-only client for the public marketplace index, with a graceful
 * offline path:
 *
 *   1. Try the remote `indexUrl` (HTTPS JSON).
 *   2. On failure, return the in-memory cache from the last successful call.
 *   3. If there's no cache yet, return the bundled seed JSON.
 *   4. If even the seed is missing, return an empty index.
 *
 * The caller (AdminServer / IPC) never sees an exception from `index()`.
 * The `MarketplaceFetchResult.source` field tells the UI which lane was
 * used so it can render an "offline" badge.
 */
export class MarketplaceClient {
  private cache: { fetchedAt: number; index: MarketplaceIndex } | null = null;
  private lastRemoteError: string | null = null;
  private readonly seedPath: string;

  constructor(private readonly opts: MarketplaceClientOptions = {}) {
    this.seedPath = opts.seedPath ?? resolve(__dirname, '..', 'seed-index.json');
  }

  async fetch(force = false): Promise<MarketplaceFetchResult> {
    const ttl = this.opts.ttlMs ?? 5 * 60 * 1000;

    // Cache window
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < ttl) {
      return {
        index: this.cache.index,
        source: 'cache',
        remoteFetchedAt: new Date(this.cache.fetchedAt).toISOString(),
        remoteError: this.lastRemoteError
      };
    }

    // Try remote
    if (this.opts.indexUrl) {
      try {
        const fetchFn = this.opts.fetch ?? fetch;
        const res = await fetchFn(this.opts.indexUrl, { headers: { accept: 'application/json' } });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const index = (await res.json()) as MarketplaceIndex;
        this.cache = { fetchedAt: Date.now(), index };
        this.lastRemoteError = null;
        return {
          index,
          source: 'remote',
          remoteFetchedAt: new Date(this.cache.fetchedAt).toISOString(),
          remoteError: null
        };
      } catch (err) {
        this.lastRemoteError = err instanceof Error ? err.message : String(err);
        // Fall through to cache / seed.
      }
    } else {
      this.lastRemoteError = 'no indexUrl configured';
    }

    // Cached previous remote response
    if (this.cache) {
      return {
        index: this.cache.index,
        source: 'cache',
        remoteFetchedAt: new Date(this.cache.fetchedAt).toISOString(),
        remoteError: this.lastRemoteError
      };
    }

    // Bundled seed
    const seed = this.loadSeed();
    return {
      index: seed,
      source: 'seed',
      remoteFetchedAt: null,
      remoteError: this.lastRemoteError
    };
  }

  /**
   * Back-compat: returns just the index. Use `fetch()` to get source info.
   */
  async index(force = false): Promise<MarketplaceIndex> {
    return (await this.fetch(force)).index;
  }

  async search(query: string): Promise<MarketplaceEntry[]> {
    const { entries } = await this.index();
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.npm.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
    );
  }

  async resolve(id: string): Promise<MarketplaceEntry | null> {
    const { entries } = await this.index();
    return entries.find((e) => e.id === id) ?? null;
  }

  private loadSeed(): MarketplaceIndex {
    try {
      if (existsSync(this.seedPath)) {
        const raw = readFileSync(this.seedPath, 'utf8');
        return JSON.parse(raw) as MarketplaceIndex;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[MarketplaceClient] failed to load seed index:', err);
    }
    return { generatedAt: '', entries: [] };
  }
}
