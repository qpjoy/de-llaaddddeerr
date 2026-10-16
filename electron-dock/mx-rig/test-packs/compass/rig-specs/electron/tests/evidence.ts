import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface ElectronRuntimeMetadata {
  applicationVersion: string;
  isPackaged: boolean;
  os: string;
  platform: string;
  arch: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  playwrightVersion: string;
}

export interface EvidenceArtifact {
  role: string;
  path: string;
  sensitivity: 'internal' | 'shareable-candidate' | 'restricted';
}

interface SidecarArtifact extends EvidenceArtifact {
  bytes: number;
  sha256: string;
}

interface SidecarCase {
  caseId: string;
  coverageMode: 'automated-renderer' | 'automated-main' | 'platform-driver' | 'manual-witness' | 'unsupported';
  artifacts: SidecarArtifact[];
  diagnosticsPath?: string;
}

interface Sidecar {
  schemaVersion: number;
  runId?: string | null;
  startedAt?: string;
  suite: string;
  lane?: string;
  engine?: Record<string, unknown>;
  sources?: {
    application?: Record<string, unknown>;
    tests?: Record<string, unknown>;
    catalog?: Record<string, unknown>;
  };
  runtime?: ElectronRuntimeMetadata;
  coverage?: Record<string, unknown>;
  cases: SidecarCase[];
  warnings: string[];
}

export function artifactRoot(): string {
  return resolve(
    process.env.MX_AUTO_ARTIFACTS_DIR ||
      process.env.MXT_ARTIFACTS_DIR ||
      process.env.MX_AUTOTEST_ARTIFACTS_DIR ||
      'artifacts'
  );
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Artifact path must remain relative to the run root: ${path}`);
  }
  return normalized;
}

export function redactDiagnostic(value: string): string {
  let output = value;
  for (const secret of [
    process.env.COMPASS_E2E_ACCOUNT,
    process.env.COMPASS_E2E_PASSWORD,
    process.env.MX_AUTO_APP_PATH,
    process.env.MXT_APP_PATH
  ]) {
    if (secret) output = output.replaceAll(secret, '[REDACTED]');
  }
  return output
    .replace(/--user-data-dir=[^\s]+/giu, '--user-data-dir=[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(
      /(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+/giu,
      '$1[REDACTED]'
    )
    .replace(/(api[_-]?key|password|token|secret)=([^\s&]+)/giu, '$1=[REDACTED]')
    .replace(
      /(["']?(?:authorization|cookie|password|secret|set-cookie|token)["']?\s*:\s*["']?)([^"',\s}&]+)/giu,
      '$1[REDACTED]'
    )
    .slice(0, 2_000);
}

export async function writeJsonArtifact(relativePath: string, value: unknown): Promise<void> {
  const safePath = safeRelativePath(relativePath);
  const target = resolve(artifactRoot(), safePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function markBlocked(stage: string, reason: string): Promise<void> {
  const target = resolve(artifactRoot(), 'preflight.json');
  let previous: Record<string, unknown> | null = null;
  try {
    previous = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
  } catch {
    // The wrapper removes stale preflight state before every accepted run.
  }
  const issues = Array.isArray(previous?.issues) ? previous.issues : [];
  issues.push({ stage, reason: redactDiagnostic(reason), createdAt: new Date().toISOString() });
  await writeJsonArtifact('preflight.json', {
    schemaVersion: 1,
    status: 'blocked',
    suite: 'compass-electron-smoke',
    lane: process.env.MX_AUTO_ELECTRON_LANE || 'bootstrap',
    stage,
    reason: redactDiagnostic(reason),
    issues
  });
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('error', reject);
    input.on('end', resolvePromise);
  });
  return `sha256:${digest.digest('hex')}`;
}

async function artifactEvidence(candidate: EvidenceArtifact): Promise<SidecarArtifact | null> {
  const relativePath = safeRelativePath(candidate.path);
  const absolutePath = resolve(artifactRoot(), relativePath);
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return null;
    return {
      ...candidate,
      path: relativePath,
      bytes: info.size,
      sha256: await sha256File(absolutePath)
    };
  } catch {
    return null;
  }
}

function fallbackSidecar(): Sidecar {
  return {
    schemaVersion: 1,
    runId: process.env.MX_AUTO_RUN_ID || process.env.MXT_RUN_ID || null,
    suite: 'compass-electron-smoke',
    lane: process.env.MX_AUTO_ELECTRON_LANE || 'bootstrap',
    cases: [],
    warnings: ['The Playwright wrapper did not initialize toolchain/source provenance.']
  };
}

export async function recordCaseEvidence(input: {
  caseId: string;
  coverageMode: SidecarCase['coverageMode'];
  artifacts: EvidenceArtifact[];
  diagnosticsPath?: string;
  runtime?: ElectronRuntimeMetadata;
  warnings?: string[];
}): Promise<void> {
  const sidecarPath = resolve(artifactRoot(), 'mx-autotest.sidecar.json');
  let sidecar: Sidecar;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Sidecar;
  } catch {
    sidecar = fallbackSidecar();
  }

  const artifacts = (
    await Promise.all(input.artifacts.map((candidate) => artifactEvidence(candidate)))
  ).filter((candidate): candidate is SidecarArtifact => candidate !== null);
  const recordedCase: SidecarCase = {
    caseId: input.caseId,
    coverageMode: input.coverageMode,
    artifacts,
    ...(input.diagnosticsPath ? { diagnosticsPath: safeRelativePath(input.diagnosticsPath) } : {})
  };
  sidecar.cases = [...(sidecar.cases || []).filter((entry) => entry.caseId !== input.caseId), recordedCase];
  sidecar.warnings = [...new Set([...(sidecar.warnings || []), ...(input.warnings || [])])];
  if (input.runtime) {
    sidecar.runtime = input.runtime;
    sidecar.sources = sidecar.sources || {};
    sidecar.sources.application = {
      ...(sidecar.sources.application || {}),
      version: input.runtime.applicationVersion
    };
  }

  await mkdir(dirname(sidecarPath), { recursive: true });
  const temporary = `${sidecarPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, sidecarPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['EEXIST', 'EPERM'].includes(String(error.code)))) {
      throw error;
    }
    await rm(sidecarPath, { force: true });
    await rename(temporary, sidecarPath);
  }
}
