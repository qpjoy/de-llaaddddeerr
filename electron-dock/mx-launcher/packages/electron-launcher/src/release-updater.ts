import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FetchLike } from '@qpjoy/mx-launcher-core';

export type ElectronLauncherReleaseUpdateMode = 'none' | 'automatic' | 'manual' | 'mandatory';
export type ElectronLauncherReleaseActivationMode = 'hot-auto' | 'hot-manual' | 'restart-auto' | 'restart-manual' | 'installer-manual';
export type ElectronLauncherReleaseDeliveryMode =
  | 'prompt-download-restart'
  | 'manual-download'
  | 'silent-download-next-start';

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
  deliveryMode?: ElectronLauncherReleaseDeliveryMode;
  releaseNotes?: string | null;
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
  /** Stable AppCenter product identity. Kept for existing clients and explicit legacy fallback. */
  productId?: string | null;
  /** Omit when packageName-based product resolution should select it from componentKind. */
  componentId?: string | null;
  componentKind?: string;
  currentVersion: string;
  /** Omit when the updater options or resolved AppCenter identity supplies it. */
  channel?: string | null;
  installId?: string | null;
  userId?: string | null;
  platform?: string | null;
  arch?: string | null;
  /** Cancels product resolution and Release Center check requests for this caller. */
  signal?: AbortSignal;
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
  /** Missing on legacy servers means prompt-download-restart. */
  deliveryMode?: ElectronLauncherReleaseDeliveryMode;
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
  /** Existing explicit product identity. The package resolver takes precedence when configured. */
  productId?: string | null;
  /** Stable name from the application's package.json, used to resolve its Release Center identity. */
  packageName?: string | null;
  /** Preferred Release Center channel; the server verifies that AppCenter enables it. */
  channel?: string | null;
  /**
   * Permit productId to be used only when an older server lacks the package
   * resolver. Opt in per legacy application; new integrations should fail
   * closed when package registration is missing.
   */
  allowLegacyProductFallback?: boolean;
}

export interface ElectronLauncherReleaseProductIdentity {
  appId: string;
  productId: string;
  packageName: string;
  launcherMode: 'standalone' | 'embed' | null;
  networkProductId: string | null;
  componentId: string;
  rendererComponentId: string;
  channel: string;
  channels: string[];
}

export interface ElectronLauncherReleaseProductResolveInput {
  packageName?: string | null;
  channel?: string | null;
  /** Cancels this caller without aborting a resolution still shared by another caller. */
  signal?: AbortSignal;
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
  /** Required only when a caller supplies a relative artifact URL directly. */
  baseUrl?: string;
  /** Cancels the active request/stream. An existing verified target is left untouched. */
  signal?: AbortSignal;
  /** Total wall-clock timeout across redirects and body download. Omit to disable. */
  timeoutMs?: number;
  /** Byte progress and the transition into digest/size verification. */
  onProgress?: (progress: ElectronLauncherArtifactDownloadProgress) => void;
}

export interface ElectronLauncherArtifactDownloadProgress {
  artifactId: string;
  phase: 'downloading' | 'verifying';
  bytesReceived: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface ElectronLauncherArtifactDownloadResult {
  ok: boolean;
  targetPath: string;
  digest: string | null;
  expectedDigest: string | null;
  bytes: number;
}

export interface ElectronLauncherReleaseUpdater {
  resolveProduct(input?: ElectronLauncherReleaseProductResolveInput): Promise<ElectronLauncherReleaseProductIdentity>;
  check(input: ElectronLauncherUpdateCheckInput): Promise<ElectronLauncherUpdateCheckResult>;
  report(input: ElectronLauncherReleaseReportInput): Promise<Record<string, unknown>>;
}

export function createElectronLauncherReleaseUpdater(options: ElectronLauncherReleaseUpdaterOptions): ElectronLauncherReleaseUpdater {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalFetch();
  type ResolvedProductEntry = {
    expiresAt: number;
    controller: AbortController;
    pending: Promise<ElectronLauncherReleaseProductIdentity>;
    waiters: number;
    settled: boolean;
  };
  const resolvedProducts = new Map<string, ResolvedProductEntry>();
  const resolveProduct = async (
    input: ElectronLauncherReleaseProductResolveInput = {}
  ): Promise<ElectronLauncherReleaseProductIdentity> => {
    throwIfRequestAborted(input.signal);
    const packageName = input.packageName?.trim() || options.packageName?.trim() || '';
    if (!packageName) throw new Error('Release Center packageName is required to resolve product identity');
    const channel = input.channel?.trim() || options.channel?.trim() || 'stable';
    const key = `${packageName.toLowerCase()}\u0000${channel.toLowerCase()}`;
    let entry = resolvedProducts.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      resolvedProducts.delete(key);
      if (!entry.settled && entry.waiters === 0) entry.controller.abort('product resolution cache expired');
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      const pending = (async () => {
        try {
          const params = new URLSearchParams({ packageName, channel });
          const payload = await requestJson<{ identity?: ElectronLauncherReleaseProductIdentity }>(
            fetchImpl,
            joinUrl(baseUrl, `/internal/v1/releases/products/resolve?${params.toString()}`),
            'GET',
            undefined,
            controller.signal
          );
          return normalizeReleaseProductIdentity(payload.identity, packageName, channel);
        } catch (error) {
          const legacyProductId = options.productId?.trim() || '';
          if (
            options.allowLegacyProductFallback === true
            && legacyProductId
            && error instanceof ReleaseCenterRequestError
            && (error.status === 404 || error.status === 405)
          ) {
            return legacyReleaseProductIdentity(legacyProductId, packageName, channel);
          }
          throw error;
        }
      })();
      entry = {
        expiresAt: Date.now() + 5 * 60 * 1000,
        controller,
        pending,
        waiters: 0,
        settled: false
      };
      const createdEntry = entry;
      resolvedProducts.set(key, createdEntry);
      void pending.then(
        () => {
          createdEntry.settled = true;
        },
        () => {
          createdEntry.settled = true;
          if (resolvedProducts.get(key) === createdEntry) resolvedProducts.delete(key);
        }
      );
    }
    const selectedEntry = entry;
    selectedEntry.waiters += 1;
    try {
      return await waitForRequestWithSignal(selectedEntry.pending, input.signal);
    } finally {
      selectedEntry.waiters -= 1;
      if (input.signal?.aborted && !selectedEntry.settled && selectedEntry.waiters === 0) {
        if (resolvedProducts.get(key) === selectedEntry) resolvedProducts.delete(key);
        selectedEntry.controller.abort(input.signal.reason);
      }
    }
  };
  return {
    resolveProduct,
    async check(input) {
      const checkedAt = new Date().toISOString();
      const identity = options.packageName?.trim()
        ? await resolveProduct({ channel: input.channel, signal: input.signal })
        : null;
      const productId = identity?.productId || input.productId?.trim() || options.productId?.trim() || null;
      const componentId = input.componentId?.trim()
        || (input.componentKind === 'renderer-ui' ? identity?.rendererComponentId : identity?.componentId)
        || '';
      if (!componentId) {
        throw new Error('Release Center componentId is required when package identity resolution is not configured');
      }
      const channel = input.channel?.trim() || identity?.channel || options.channel?.trim() || '';
      if (!channel) {
        throw new Error('Release Center channel is required when package identity resolution is not configured');
      }
      const effectiveInput: ResolvedElectronLauncherUpdateCheckInput = {
        ...input,
        productId,
        componentId,
        channel
      };
      // Preferred path: server-side single-install decision (docs/19 §6). The
      // server owns target lists and rollout bucketing; the full plans list is
      // being withdrawn to admin-only. Fall back to the legacy flow against
      // older servers that do not expose /release/check yet.
      const installId = effectiveInput.installId ?? options.reportInstallId ?? null;
      if (installId) {
        try {
          const payload = await requestJson<ReleaseCheckPayload>(
            fetchImpl,
            joinUrl(baseUrl, '/internal/v1/release/check'),
            'POST',
            {
              installId,
              userId: effectiveInput.userId ?? null,
              productId: effectiveInput.productId,
              channel: effectiveInput.channel,
              platform: effectiveInput.platform ?? null,
              arch: effectiveInput.arch ?? null,
              artifactKinds: effectiveInput.componentKind ? [effectiveInput.componentKind] : undefined,
              components: { [effectiveInput.componentId]: effectiveInput.currentVersion }
            },
            effectiveInput.signal
          );
          if (
            payload
            && (payload.status === 'up-to-date'
              || payload.status === 'update-available'
              || payload.status === 'blocked')
          ) {
            return mapReleaseCheckPayload(payload, effectiveInput, baseUrl, checkedAt);
          }
          throw new Error('Release Center returned an invalid release/check payload');
        } catch (error) {
          // Only an endpoint that is genuinely absent identifies an older
          // server. Authentication, transport, 5xx and malformed-payload
          // failures must not bypass server-side rollout/target decisions.
          if (
            !(error instanceof ReleaseCenterRequestError)
            || (error.status !== 404 && error.status !== 405)
          ) {
            throw error;
          }
        }
      }
      const plansPayload = await requestJson<{ plans?: ElectronLauncherReleasePlan[] }>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/release-management/plans'),
        'GET',
        undefined,
        effectiveInput.signal
      );
      const plans = (Array.isArray(plansPayload.plans) ? plansPayload.plans : [])
        .map((plan) => normalizeReleasePlanArtifactUrls(plan, baseUrl));
      const plan = selectReleasePlan(plans, effectiveInput);
      const planDecision = plan ? selectPlanDecision(plan, effectiveInput) : null;
      const fallbackTargetVersion = planDecision?.targetVersion || effectiveInput.currentVersion;
      const decisionPayload = await requestJson<{ decision: ElectronLauncherReleasePolicyDecision }>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/releases/policy/evaluate'),
        'POST',
        {
          componentKind: planDecision?.componentKind || effectiveInput.componentKind || 'app-managed',
          componentId: effectiveInput.componentId,
          currentVersion: effectiveInput.currentVersion,
          targetVersion: fallbackTargetVersion,
          channel: effectiveInput.channel,
          installId: effectiveInput.installId ?? null,
          userId: effectiveInput.userId ?? null
        },
        effectiveInput.signal
      );
      const decision = decisionPayload.decision;
      const artifacts = plan
        ? matchingArtifacts(
            plan,
            effectiveInput.componentId,
            effectiveInput.platform,
            effectiveInput.arch,
            effectiveInput.componentKind
          )
        : [];
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
        releaseNotes: plan?.releaseNotes ?? null,
        deliveryMode: normalizeReleaseDeliveryMode(plan?.deliveryMode),
        featureFlags: plan?.rollout?.featureKeys ?? [],
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
  throwIfDownloadAborted(input.signal);
  const url = input.artifact.url?.trim();
  if (!url) throw new Error(`Release artifact ${input.artifact.artifactId} has no URL`);
  const downloadUrl = resolveReleaseArtifactUrl(url, input.baseUrl);
  const timeoutMs = normalizeDownloadTimeout(input.timeoutMs);
  await mkdir(dirname(input.targetPath), { recursive: true });
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) controller.abort(input.signal.reason);
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  let timedOut = false;
  const timeout = timeoutMs === null
    ? null
    : setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Release artifact download timed out after ${timeoutMs}ms`));
      }, timeoutMs);
  const tempPath = `${input.targetPath}.download-${process.pid}-${randomUUID()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  let digest: string | null = null;
  const expectedDigest = normalizeDigest(input.artifact.digest);
  try {
    throwIfDownloadAborted(controller.signal);
    const response = await openDownloadStream(
      downloadUrl,
      normalizeMaxRedirects(input.maxRedirects),
      controller.signal
    );
    const expectedBytes = finiteNonNegativeNumber(input.artifact.sizeBytes);
    const responseBytes = contentLength(response.contentLength);
    if (expectedBytes !== null && responseBytes !== null && expectedBytes !== responseBytes) {
      response.stream.destroy();
      throw new Error(
        `Release artifact Content-Length mismatch: expected ${expectedBytes}, got ${responseBytes}`
      );
    }
    const totalBytes = expectedBytes ?? responseBytes;
    emitDownloadProgress(input, 'downloading', bytes, totalBytes);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        emitDownloadProgress(input, 'downloading', bytes, totalBytes);
        callback(null, chunk);
      }
    });
    await pipeline(
      response.stream,
      meter,
      createWriteStream(tempPath, { flags: 'wx' }),
      { signal: controller.signal }
    );
    throwIfDownloadAborted(controller.signal);
    emitDownloadProgress(input, 'verifying', bytes, totalBytes);
    digest = `sha256:${hash.digest('hex')}`;
    if (expectedBytes !== null && bytes !== expectedBytes) {
      throw new Error(`Release artifact size mismatch: expected ${expectedBytes}, got ${bytes}`);
    }
    if (responseBytes !== null && bytes !== responseBytes) {
      throw new Error(`Release artifact Content-Length mismatch: expected ${responseBytes}, got ${bytes}`);
    }
    if (expectedDigest && digest !== expectedDigest) {
      throw new Error(`Release artifact digest mismatch: expected ${expectedDigest}, got ${digest}`);
    }
    throwIfDownloadAborted(controller.signal);
    await replaceDownloadedFile(tempPath, input.targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    if (timedOut) {
      throw new Error(`Release artifact download timed out after ${timeoutMs}ms`);
    }
    if (input.signal?.aborted || controller.signal.aborted) {
      throw downloadAbortError(input.signal?.reason ?? controller.signal.reason);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
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
  deliveryMode?: ElectronLauncherReleaseDeliveryMode;
  featureFlags: string[];
  rollout: { matchedBy: string | null; bucket: number | null; percentage: number | null };
  signedAt: string;
  signature: { algorithm: string; keyId: string; value: string };
}

type ResolvedElectronLauncherUpdateCheckInput = Omit<
  ElectronLauncherUpdateCheckInput,
  'componentId' | 'channel'
> & {
  componentId: string;
  channel: string;
};

function mapReleaseCheckPayload(
  payload: ReleaseCheckPayload,
  input: ResolvedElectronLauncherUpdateCheckInput,
  baseUrl: string,
  checkedAt: string
): ElectronLauncherUpdateCheckResult {
  const artifacts = normalizeReleaseArtifactUrls(payload.artifacts, baseUrl);
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
        artifacts,
        rollout: {
          percentage: payload.rollout?.percentage ?? undefined,
          featureKeys: payload.featureFlags ?? []
        },
        activation: payload.activation ?? undefined,
        deliveryMode: normalizeReleaseDeliveryMode(payload.deliveryMode),
        createdAt: payload.signedAt
      }
    : null;
  return {
    checkedAt,
    baseUrl,
    status: payload.status,
    plan,
    decision,
    artifacts,
    reason: payload.reason,
    releaseNotes: payload.releaseNotes ?? null,
    deliveryMode: normalizeReleaseDeliveryMode(payload.deliveryMode),
    featureFlags: payload.featureFlags ?? [],
    rollout: payload.rollout ?? null,
    checkSource: 'release-check'
  };
}

function normalizeReleaseDeliveryMode(value: unknown): ElectronLauncherReleaseDeliveryMode {
  if (value === 'manual-download') return 'manual-download';
  if (value === 'silent-download-next-start') return 'silent-download-next-start';
  return 'prompt-download-restart';
}

function selectReleasePlan(
  plans: ElectronLauncherReleasePlan[],
  input: ResolvedElectronLauncherUpdateCheckInput
): ElectronLauncherReleasePlan | null {
  return plans.find((plan) => {
    if (plan.channel !== input.channel) return false;
    if (plan.installId && plan.installId !== input.installId) return false;
    if (plan.userId && plan.userId !== input.userId) return false;
    const decision = selectPlanDecision(plan, input);
    if (!decision) return false;
    const artifacts = matchingArtifacts(
      plan,
      input.componentId,
      input.platform,
      input.arch,
      input.componentKind
    );
    return !decisionRequiresDownload(decision) || artifacts.some((artifact) => Boolean(artifact.url));
  }) ?? null;
}

function selectPlanDecision(
  plan: ElectronLauncherReleasePlan,
  input: ResolvedElectronLauncherUpdateCheckInput
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
  arch?: string | null,
  kind?: string | null
): ElectronLauncherReleaseArtifactRef[] {
  const normalizedPlatform = platform?.trim() || null;
  const normalizedArch = arch?.trim() || null;
  const normalizedKind = kind?.trim() || null;
  return (Array.isArray(plan.artifacts) ? plan.artifacts : [])
    .filter((artifact) => artifact.componentId === componentId || !artifact.componentId)
    .filter((artifact) => !normalizedKind || releasePolicyKindsMatch(artifact.kind, normalizedKind))
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

function normalizeReleaseProductIdentity(
  value: ElectronLauncherReleaseProductIdentity | undefined,
  requestedPackageName: string,
  requestedChannel: string
): ElectronLauncherReleaseProductIdentity {
  if (!value || typeof value !== 'object') {
    throw new Error('Release Center product resolver returned no identity');
  }
  const productId = requiredResolvedIdentityString(value.productId, 'productId');
  const appId = requiredResolvedIdentityString(value.appId, 'appId');
  const packageName = requiredResolvedIdentityString(value.packageName, 'packageName');
  const componentId = requiredResolvedIdentityString(value.componentId, 'componentId');
  const rendererComponentId = requiredResolvedIdentityString(value.rendererComponentId, 'rendererComponentId');
  const channel = requiredResolvedIdentityString(value.channel, 'channel');
  const channels = Array.isArray(value.channels)
    ? [...new Set(value.channels.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
    : [];
  if (packageName.toLowerCase() !== requestedPackageName.toLowerCase()) {
    throw new Error(`Release Center resolved a different package identity: ${packageName}`);
  }
  if (
    appId !== productId
    || componentId !== productId
    || rendererComponentId !== `${productId}-renderer`
  ) {
    throw new Error('Release Center returned an inconsistent product component namespace');
  }
  if (channel.toLowerCase() !== requestedChannel.toLowerCase() || !channels.includes(channel.toLowerCase())) {
    throw new Error(`Release Center did not confirm requested channel: ${requestedChannel}`);
  }
  return {
    appId,
    productId,
    packageName,
    launcherMode: value.launcherMode === 'standalone' || value.launcherMode === 'embed'
      ? value.launcherMode
      : null,
    networkProductId: typeof value.networkProductId === 'string' && value.networkProductId.trim()
      ? value.networkProductId.trim()
      : null,
    componentId,
    rendererComponentId,
    channel: channel.toLowerCase(),
    channels
  };
}

function legacyReleaseProductIdentity(
  productIdValue: string,
  packageName: string,
  channelValue: string
): ElectronLauncherReleaseProductIdentity {
  const productId = productIdValue.trim().toLowerCase();
  const channel = channelValue.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(productId)) {
    throw new Error('Legacy Release Center productId is invalid');
  }
  return {
    appId: productId,
    productId,
    packageName,
    launcherMode: null,
    networkProductId: null,
    componentId: productId,
    rendererComponentId: `${productId}-renderer`,
    channel,
    channels: [channel]
  };
}

function requiredResolvedIdentityString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`Release Center product resolver returned no ${field}`);
  return normalized;
}

function normalizeReleasePlanArtifactUrls(
  plan: ElectronLauncherReleasePlan,
  baseUrl: string
): ElectronLauncherReleasePlan {
  return {
    ...plan,
    artifacts: normalizeReleaseArtifactUrls(plan.artifacts, baseUrl)
  };
}

function normalizeReleaseArtifactUrls(
  artifacts: ElectronLauncherReleaseArtifactRef[] | null | undefined,
  baseUrl: string
): ElectronLauncherReleaseArtifactRef[] {
  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => ({
    ...artifact,
    url: artifact.url ? resolveReleaseArtifactUrl(artifact.url, baseUrl) : null
  }));
}

function resolveReleaseArtifactUrl(value: string, baseUrl?: string): string {
  const url = value.trim();
  try {
    const absolute = new URL(url);
    if (baseUrl?.trim() && isPlatformReleaseArtifactPath(absolute.pathname)) {
      return rebindReleaseArtifactToBase(absolute, baseUrl);
    }
    return absolute.toString();
  } catch {
    if (!baseUrl?.trim()) {
      throw new Error(`Relative release artifact URL requires baseUrl: ${url}`);
    }
    if (url.startsWith('//')) {
      throw new Error(`Protocol-relative release artifact URL is not allowed: ${url}`);
    }
    const resolved = new URL(url, `${normalizeBaseUrl(baseUrl)}/`);
    if (isPlatformReleaseArtifactPath(resolved.pathname)) {
      return rebindReleaseArtifactToBase(resolved, baseUrl);
    }
    return resolved.toString();
  }
}

class ReleaseCenterRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ReleaseCenterRequestError';
  }
}

function throwIfRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw releaseRequestAbortError(signal.reason);
}

function releaseRequestAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : 'Release Center request cancelled'
  );
  error.name = 'AbortError';
  return error;
}

function waitForRequestWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(releaseRequestAbortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(releaseRequestAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    pending.then(
      (value) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      }
    );
  });
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  type ReleaseFetchInit = NonNullable<Parameters<FetchLike>[1]> & { signal?: AbortSignal };
  const init: ReleaseFetchInit = {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {})
  };
  const response = await (fetchImpl as (
    input: string,
    init?: ReleaseFetchInit
  ) => ReturnType<FetchLike>)(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new ReleaseCenterRequestError(
      response.status,
      `Release Center request failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    );
  }
  const payload = text.trim() ? JSON.parse(text) : null;
  return payload as T;
}

async function openDownloadStream(
  url: string,
  redirectsLeft: number,
  signal: AbortSignal
): Promise<{ stream: import('node:http').IncomingMessage; contentLength: string | string[] | undefined }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported release artifact URL protocol: ${parsed.protocol}`);
  }
  return new Promise((resolve, reject) => {
    const handleResponse = (response: import('node:http').IncomingMessage) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading release artifact: ${url}`));
          return;
        }
        const redirected = new URL(location, parsed).toString();
        openDownloadStream(redirected, redirectsLeft - 1, signal).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Release artifact download failed: HTTP ${status}`));
        return;
      }
      resolve({ stream: response, contentLength: response.headers['content-length'] });
    };
    const req = parsed.protocol === 'https:'
      ? httpsGet(parsed, { signal }, handleResponse)
      : httpGet(parsed, { signal }, handleResponse);
    req.on('error', reject);
  });
}

function isPlatformReleaseArtifactPath(pathname: string): boolean {
  return /^\/internal\/v1\/release-artifacts\/[^/]+\/download(?:\/[^/]+)?\/?$/.test(pathname);
}

function rebindReleaseArtifactToBase(url: URL, baseUrl: string): string {
  const base = new URL(`${normalizeBaseUrl(baseUrl)}/`);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`Unsupported Release Center baseUrl protocol: ${base.protocol}`);
  }
  return new URL(`${url.pathname}${url.search}${url.hash}`, base.origin).toString();
}

function normalizeMaxRedirects(value: number | undefined): number {
  if (value === undefined) return 3;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Release artifact maxRedirects must be a non-negative integer: ${value}`);
  }
  return value;
}

function normalizeDownloadTimeout(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Release artifact timeoutMs must be a positive number: ${value}`);
  }
  return value;
}

function finiteNonNegativeNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function contentLength(value: string | string[] | undefined): number | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text || !/^\d+$/.test(text.trim())) return null;
  return finiteNonNegativeNumber(Number(text));
}

function emitDownloadProgress(
  input: ElectronLauncherArtifactDownloadInput,
  phase: ElectronLauncherArtifactDownloadProgress['phase'],
  bytesReceived: number,
  totalBytes: number | null
): void {
  if (!input.onProgress) return;
  try {
    input.onProgress({
      artifactId: input.artifact.artifactId,
      phase,
      bytesReceived,
      totalBytes,
      percent: totalBytes === null
        ? null
        : totalBytes === 0
          ? 100
          : Math.min(100, (bytesReceived / totalBytes) * 100)
    });
  } catch {
    // Progress is observational and must not corrupt or abort an update.
  }
}

function throwIfDownloadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw downloadAbortError(signal.reason);
}

function downloadAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : 'Release artifact download cancelled'
  );
  error.name = 'AbortError';
  return error;
}

async function replaceDownloadedFile(tempPath: string, targetPath: string): Promise<void> {
  if (!existsSync(targetPath)) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      if (!isDestinationExistsRenameError(error)) throw error;
    }
  }

  // Windows cannot rename over an existing destination. Move the previous
  // verified file aside first, and restore it if committing the new file fails.
  const backupPath = `${targetPath}.previous-${process.pid}-${randomUUID()}`;
  let previousMoved = false;
  try {
    try {
      await rename(targetPath, backupPath);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await rename(tempPath, targetPath);
    await rm(backupPath, { force: true }).catch(() => undefined);
    return;
  } catch (error) {
    if (previousMoved) {
      try {
        await rename(backupPath, targetPath);
      } catch {
        // If another successful writer already installed targetPath, keep it.
        // Otherwise the original commit error remains the most useful failure.
        if (existsSync(targetPath)) {
          await rm(backupPath, { force: true }).catch(() => undefined);
        }
      }
    }
    throw error;
  }
}

function isDestinationExistsRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
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
