import { readFileSync } from 'node:fs';

/**
 * Bootstrap resolution for standalone launcher products (docs/20 §4.5 首连语义).
 *
 * A product's registered base URL is its in-tunnel service VIP, which is only
 * reachable AFTER the WireGuard data plane is up. The very first enroll (and
 * anything else that runs before `network-ready`: login, update check, peer
 * sync) must therefore go through a bootstrap URL that is reachable on the
 * current network — a LAN admin entrance, a public bootstrap proxy, etc.
 *
 * Products pass an ordered candidate list (typically from env / .env);
 * `resolveElectronLauncherBootstrap` probes them and pins the first healthy
 * one. After the tunnel is up, product traffic switches back to the VIP.
 */

export interface ElectronLauncherBootstrapCandidate {
  url: string;
  source: string;
}

export interface ElectronLauncherBootstrapProbe {
  url: string;
  source: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
}

export interface ElectronLauncherBootstrapResolution {
  ok: boolean;
  /** First healthy candidate, or null when none answered. */
  baseUrl: string | null;
  source: string | null;
  probes: ElectronLauncherBootstrapProbe[];
  message: string;
}

export interface ResolveElectronLauncherBootstrapOptions {
  /** Ordered candidates; strings or { url, source } entries. */
  candidates: Array<string | ElectronLauncherBootstrapCandidate | null | undefined>;
  /** Health probe path, default `/healthz`. */
  healthPath?: string;
  /** Per-candidate timeout in ms, default 3000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function normalizeElectronLauncherBootstrapUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return withScheme;
  } catch {
    return null;
  }
}

/** Split an env value like "http://a:18090, http://b:18090" into candidates. */
export function parseElectronLauncherBootstrapUrls(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(
    value
      .split(/[\s,;]+/)
      .map((item) => normalizeElectronLauncherBootstrapUrl(item))
      .filter((item): item is string => Boolean(item))
  )];
}

export async function resolveElectronLauncherBootstrap(
  options: ResolveElectronLauncherBootstrapOptions
): Promise<ElectronLauncherBootstrapResolution> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthPath = options.healthPath?.trim() || '/healthz';
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 3000;
  const candidates = dedupeCandidates(options.candidates);
  const probes: ElectronLauncherBootstrapProbe[] = [];

  if (candidates.length === 0) {
    return {
      ok: false,
      baseUrl: null,
      source: null,
      probes,
      message: 'No bootstrap candidates were provided.'
    };
  }

  for (const candidate of candidates) {
    const startedAt = Date.now();
    const url = `${candidate.url}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const probe: ElectronLauncherBootstrapProbe = {
        url: candidate.url,
        source: candidate.source,
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - startedAt,
        error: response.ok ? null : `HTTP ${response.status}`
      };
      probes.push(probe);
      if (response.ok) {
        return {
          ok: true,
          baseUrl: candidate.url,
          source: candidate.source,
          probes,
          message: `Bootstrap resolved to ${candidate.url} (${candidate.source}, ${probe.durationMs}ms).`
        };
      }
    } catch (error) {
      probes.push({
        url: candidate.url,
        source: candidate.source,
        ok: false,
        status: null,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? (error.name === 'AbortError' ? `timeout ${timeoutMs}ms` : error.message) : String(error)
      });
    }
  }

  return {
    ok: false,
    baseUrl: null,
    source: null,
    probes,
    message: `No bootstrap candidate answered ${healthPath}: ${probes
      .map((probe) => `${probe.url} (${probe.source}: ${probe.error})`)
      .join('; ')}`
  };
}

function dedupeCandidates(
  input: Array<string | ElectronLauncherBootstrapCandidate | null | undefined>
): ElectronLauncherBootstrapCandidate[] {
  const seen = new Set<string>();
  const out: ElectronLauncherBootstrapCandidate[] = [];
  for (const item of input) {
    if (!item) continue;
    const raw = typeof item === 'string' ? { url: item, source: 'candidate' } : item;
    const url = normalizeElectronLauncherBootstrapUrl(raw.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, source: raw.source || 'candidate' });
  }
  return out;
}

/**
 * Minimal .env loader for packaged Electron apps (no shell env there).
 * Reads existing files from `paths` in precedence order, parses KEY=VALUE
 * lines (`#` comments, optional single/double quotes), and merges them into
 * `process.env` WITHOUT overriding keys that are already set. Real environment
 * variables win, then the first file that defines each key wins.
 */
export function loadElectronLauncherEnvFiles(paths: Array<string | null | undefined>): {
  loadedFrom: string | null;
  applied: string[];
} {
  let loadedFrom: string | null = null;
  const applied: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    loadedFrom ??= path;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      applied.push(key);
    }
  }
  return { loadedFrom, applied };
}
