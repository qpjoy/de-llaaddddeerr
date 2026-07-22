import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FetchLike } from '@qpjoy/mx-launcher-core';

export type ElectronLauncherReleaseUpdateMode = 'none' | 'automatic' | 'manual' | 'mandatory';
export type ElectronLauncherReleaseActivationMode = 'hot-auto' | 'hot-manual' | 'restart-auto' | 'restart-manual' | 'installer-manual';

export interface ElectronLauncherReleasePolicyDecision {
  componentKind: string;
  componentId: string;
  currentVersion: string;
  targetVersion: string;
  updateAvailable: boolean;
  updateMode: ElectronLauncherReleaseUpdateMode;
  canSkip: boolean;
  canDefer: boolean;
  requiresGate: boolean;
  rollbackRequired: boolean;
  reason: string;
}

export interface ElectronLauncherReleaseArtifactRef {
  artifactId: string;
  kind: string;
  componentId: string;
  version: string;
  source: string;
  url: string | null;
  digest: string | null;
  signature: string | null;
  sizeBytes: number | null;
  platform?: string | null;
  arch?: string | null;
  fileName?: string | null;
  activation: ElectronLauncherReleaseActivationMode;
  autoApply: boolean;
  restartRequired: boolean;
  requiredAppRestart: boolean;
  notes: string[];
}

export interface ElectronLauncherReleasePlan {
  planId: string;
  releaseId: string;
  productId?: string;
  environment: string;
  channel: string;
  installId: string | null;
  userId: string | null;
  createdBy: string;
  components: {
    launcher?: ElectronLauncherReleasePolicyDecision;
    app?: ElectronLauncherReleasePolicyDecision;
  };
  artifacts: ElectronLauncherReleaseArtifactRef[];
  rollout?: {
    strategy?: string;
    percentage?: number;
    segmentId?: string;
    rings?: string[];
    featureKeys?: string[];
    channels?: string[];
    allowAutoPromote?: boolean;
    canaryMetricGate?: string;
  };
  activation?: {
    checkSource?: string;
    hotUpdateAuto?: boolean;
    hotUpdateToast?: boolean;
    majorUpdateRequiresInstaller?: boolean;
    restartAfterApply?: boolean;
    manualConfirmRequired?: boolean;
    connectionSafeMode?: boolean;
  };
  test?: {
    suiteId?: string;
    gate?: {
      verdict?: string;
      reason?: string;
    };
  };
  decisions?: {
    readyToPromote?: boolean;
    requiresApproval?: boolean;
    canaryAllowed?: boolean;
    rollbackRequired?: boolean;
    nextActions?: string[];
  };
  createdAt: string;
}

export interface ElectronLauncherUpdateCheckInput {
  componentId: string;
  componentKind?: string;
  currentVersion: string;
  channel: string;
  installId?: string | null;
  userId?: string | null;
  platform?: string | null;
  arch?: string | null;
}

export interface ElectronLauncherUpdateCheckResult {
  checkedAt: string;
  baseUrl: string;
  status: 'up-to-date' | 'update-available' | 'blocked' | 'failed';
  plan: ElectronLauncherReleasePlan | null;
  decision: ElectronLauncherReleasePolicyDecision;
  artifacts: ElectronLauncherReleaseArtifactRef[];
  reason: string;
  /** Markdown release notes from the server-side decision, when provided. */
  releaseNotes?: string | null;
  /** Feature keys granted to this install by the matched plan. */
  featureFlags?: string[];
  /** Why this install did (not) receive the release; shown in the update panel. */
  rollout?: {
    matchedBy?: string | null;
    bucket?: number | null;
    percentage?: number | null;
  } | null;
  /** Which check path produced this result. */
  checkSource?: 'release-check' | 'plans-legacy';
}

export interface ElectronLauncherReleaseUpdaterOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  reportInstallId?: string | null;
}

export interface ElectronLauncherReleaseReportInput {
  taskId?: string | null;
  installId?: string | null;
  status: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ElectronLauncherArtifactDownloadInput {
  artifact: ElectronLauncherReleaseArtifactRef;
  targetPath: string;
  maxRedirects?: number;
}

export interface ElectronLauncherArtifactDownloadResult {
  ok: boolean;
  targetPath: string;
  digest: string | null;
  expectedDigest: string | null;
  bytes: number;
}

export interface ElectronLauncherReleaseUpdater {
  check(input: ElectronLauncherUpdateCheckInput): Promise<ElectronLauncherUpdateCheckResult>;
  report(input: ElectronLauncherReleaseReportInput): Promise<Record<string, unknown>>;
}

export function createElectronLauncherReleaseUpdater(options: ElectronLauncherReleaseUpdaterOptions): ElectronLauncherReleaseUpdater {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalFetch();
  return {
    async check(input) {
      const checkedAt = new Date().toISOString();
      // Preferred path: server-side single-install decision (docs/19 §6). The
      // server owns target lists and rollout bucketing; the full plans list is
      // being withdrawn to admin-only. Fall back to the legacy flow against
      // older servers that do not expose /release/check yet.
      const installId = input.installId ?? options.reportInstallId ?? null;
      if (installId) {
        try {
          const payload = await requestJson<ReleaseCheckPayload>(
            fetchImpl,
            joinUrl(baseUrl, '/internal/v1/release/check'),
            'POST',
            {
              installId,
              userId: input.userId ?? null,
              channel: input.channel,
              platform: input.platform ?? null,
              arch: input.arch ?? null,
              components: { [input.componentId]: input.currentVersion }
            }
          );
          if (payload && typeof payload.status === 'string') {
            return mapReleaseCheckPayload(payload, input, baseUrl, checkedAt);
          }
        } catch {
          // Older server without /release/check; use the legacy plans flow.
        }
      }
      const plansPayload = await requestJson<{ plans?: ElectronLauncherReleasePlan[] }>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/release-management/plans'),
        'GET'
      );
      const plans = Array.isArray(plansPayload.plans) ? plansPayload.plans : [];
      const plan = selectReleasePlan(plans, input);
      const planDecision = plan ? selectPlanDecision(plan, input) : null;
      const fallbackTargetVersion = planDecision?.targetVersion || input.currentVersion;
      const decisionPayload = await requestJson<{ decision: ElectronLauncherReleasePolicyDecision }>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/releases/policy/evaluate'),
        'POST',
        {
          componentKind: planDecision?.componentKind || input.componentKind || 'app-managed',
          componentId: input.componentId,
          currentVersion: input.currentVersion,
          targetVersion: fallbackTargetVersion,
          channel: input.channel,
          installId: input.installId ?? null,
          userId: input.userId ?? null
        }
      );
      const decision = decisionPayload.decision;
      const artifacts = plan ? matchingArtifacts(plan, input.componentId, input.platform, input.arch) : [];
      const gateVerdict = plan?.test?.gate?.verdict;
      const status = !decision.updateAvailable
        ? 'up-to-date'
        : gateVerdict && gateVerdict !== 'passed'
          ? 'blocked'
          : 'update-available';
      return {
        checkedAt,
        baseUrl,
        status,
        plan,
        decision,
        artifacts,
        reason: status === 'blocked'
          ? plan?.test?.gate?.reason || `release gate is ${gateVerdict}`
          : decision.reason,
        checkSource: 'plans-legacy'
      };
    },
    async report(input) {
      const installId = input.installId ?? options.reportInstallId ?? null;
      return requestJson<Record<string, unknown>>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/release/reports'),
        'POST',
        {
          taskId: input.taskId ?? undefined,
          installId: installId ?? undefined,
          status: input.status,
          error: input.error ?? null,
          metadata: input.metadata ?? {}
        }
      );
    }
  };
}

export async function downloadElectronLauncherReleaseArtifactToFile(
  input: ElectronLauncherArtifactDownloadInput
): Promise<ElectronLauncherArtifactDownloadResult> {
  const url = input.artifact.url?.trim();
  if (!url) throw new Error(`Release artifact ${input.artifact.artifactId} has no URL`);
  await mkdir(dirname(input.targetPath), { recursive: true });
  const tempPath = `${input.targetPath}.download`;
  await rm(tempPath, { force: true });
  const hash = createHash('sha256');
  let bytes = 0;
  let digest: string | null = null;
  const expectedDigest = normalizeDigest(input.artifact.digest);
  try {
    const response = await openDownloadStream(url, input.maxRedirects ?? 3);
    response.stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    await pipeline(response.stream, createWriteStream(tempPath, { flags: 'wx' }));
    digest = `sha256:${hash.digest('hex')}`;
    if (Number.isFinite(input.artifact.sizeBytes) && bytes !== input.artifact.sizeBytes) {
      throw new Error(`Release artifact size mismatch: expected ${input.artifact.sizeBytes}, got ${bytes}`);
    }
    if (expectedDigest && digest !== expectedDigest) {
      throw new Error(`Release artifact digest mismatch: expected ${expectedDigest}, got ${digest}`);
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  await rename(tempPath, input.targetPath);
  return {
    ok: true,
    targetPath: input.targetPath,
    digest,
    expectedDigest,
    bytes
  };
}

interface ReleaseCheckPayload {
  status: 'up-to-date' | 'update-available' | 'blocked';
  reason: string;
  planId: string | null;
  releaseId: string | null;
  channel: string;
  decision: ElectronLauncherReleasePolicyDecision | null;
  artifacts: ElectronLauncherReleaseArtifactRef[];
  activation: ElectronLauncherReleasePlan['activation'] | null;
  releaseNotes: string | null;
  featureFlags: string[];
  rollout: { matchedBy: string | null; bucket: number | null; percentage: number | null };
  signedAt: string;
  signature: { algorithm: string; keyId: string; value: string };
}

function mapReleaseCheckPayload(
  payload: ReleaseCheckPayload,
  input: ElectronLauncherUpdateCheckInput,
  baseUrl: string,
  checkedAt: string
): ElectronLauncherUpdateCheckResult {
  const decision: ElectronLauncherReleasePolicyDecision = payload.decision ?? {
    componentKind: input.componentKind || 'app-managed',
    componentId: input.componentId,
    currentVersion: input.currentVersion,
    targetVersion: input.currentVersion,
    updateAvailable: false,
    updateMode: 'none',
    canSkip: true,
    canDefer: true,
    requiresGate: false,
    rollbackRequired: false,
    reason: payload.reason
  };
  const plan: ElectronLauncherReleasePlan | null = payload.planId && payload.releaseId
    ? {
        planId: payload.planId,
        releaseId: payload.releaseId,
        environment: 'internal',
        channel: payload.channel,
        installId: input.installId ?? null,
        userId: input.userId ?? null,
        createdBy: 'release-check',
        components: decision.componentKind === 'app-managed' ? { app: decision } : { launcher: decision },
        artifacts: payload.artifacts ?? [],
        rollout: {
          percentage: payload.rollout?.percentage ?? undefined,
          featureKeys: payload.featureFlags ?? []
        },
        activation: payload.activation ?? undefined,
        createdAt: payload.signedAt
      }
    : null;
  return {
    checkedAt,
    baseUrl,
    status: payload.status,
    plan,
    decision,
    artifacts: payload.artifacts ?? [],
    reason: payload.reason,
    releaseNotes: payload.releaseNotes ?? null,
    featureFlags: payload.featureFlags ?? [],
    rollout: payload.rollout ?? null,
    checkSource: 'release-check'
  };
}

function selectReleasePlan(
  plans: ElectronLauncherReleasePlan[],
  input: ElectronLauncherUpdateCheckInput
): ElectronLauncherReleasePlan | null {
  return plans.find((plan) => {
    if (plan.channel !== input.channel) return false;
    if (plan.installId && plan.installId !== input.installId) return false;
    if (plan.userId && plan.userId !== input.userId) return false;
    const decision = selectPlanDecision(plan, input);
    if (!decision) return false;
    const artifacts = matchingArtifacts(plan, input.componentId, input.platform, input.arch);
    return !decisionRequiresDownload(decision) || artifacts.some((artifact) => Boolean(artifact.url));
  }) ?? null;
}

function selectPlanDecision(
  plan: ElectronLauncherReleasePlan,
  input: ElectronLauncherUpdateCheckInput
): ElectronLauncherReleasePolicyDecision | null {
  const decisions = [plan.components?.launcher, plan.components?.app].filter(Boolean);
  return decisions.find((decision) => {
    if (!decision) return false;
    if (decision.componentId !== input.componentId) return false;
    if (input.componentKind && !releasePolicyKindsMatch(decision.componentKind, input.componentKind)) return false;
    if (decision.currentVersion && decision.currentVersion !== input.currentVersion) return true;
    return decision.targetVersion !== input.currentVersion;
  }) ?? null;
}

function matchingArtifacts(
  plan: ElectronLauncherReleasePlan,
  componentId: string,
  platform?: string | null,
  arch?: string | null
): ElectronLauncherReleaseArtifactRef[] {
  const normalizedPlatform = platform?.trim() || null;
  const normalizedArch = arch?.trim() || null;
  return (Array.isArray(plan.artifacts) ? plan.artifacts : [])
    .filter((artifact) => artifact.componentId === componentId || !artifact.componentId)
    .filter((artifact) => !artifact.platform || !normalizedPlatform || artifact.platform === normalizedPlatform)
    .filter((artifact) => !artifact.arch || artifact.arch === 'universal' || !normalizedArch || artifact.arch === normalizedArch);
}

function releasePolicyKindsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const installerKinds = new Set(['app-installer', 'mx-h2i-installer']);
  return installerKinds.has(left) && installerKinds.has(right);
}

function decisionRequiresDownload(decision: ElectronLauncherReleasePolicyDecision): boolean {
  return [
    'app-installer',
    'mx-h2i-installer',
    'renderer-ui',
    'launcher-npm',
    'launcher-asar',
    'app-asar',
    'appcenter-app',
    'native-helper'
  ].includes(decision.componentKind);
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Release Center request failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }
  return payload as T;
}

async function openDownloadStream(url: string, redirectsLeft: number): Promise<{ stream: NodeJS.ReadableStream }> {
  const parsed = new URL(url);
  const getter = parsed.protocol === 'https:' ? httpsGet : parsed.protocol === 'http:' ? httpGet : null;
  if (!getter) throw new Error(`Unsupported release artifact URL protocol: ${parsed.protocol}`);
  return new Promise((resolve, reject) => {
    const req = getter(parsed, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading release artifact: ${url}`));
          return;
        }
        const redirected = new URL(location, parsed).toString();
        openDownloadStream(redirected, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Release artifact download failed: HTTP ${status}`));
        return;
      }
      resolve({ stream: response });
    });
    req.on('error', reject);
  });
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Release Center baseUrl is required');
  return trimmed;
}

function joinUrl(baseUrl: string, pathName: string): string {
  return `${baseUrl}${pathName.startsWith('/') ? pathName : `/${pathName}`}`;
}

function normalizeDigest(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized.startsWith('sha256:') ? normalized : `sha256:${normalized}`;
}

function globalFetch(): FetchLike {
  const maybeFetch = (globalThis as typeof globalThis & { fetch?: FetchLike }).fetch;
  if (!maybeFetch) throw new Error('No fetch implementation available for Electron Launcher updater');
  return maybeFetch.bind(globalThis);
}
