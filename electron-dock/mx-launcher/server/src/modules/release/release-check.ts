import { createHash, createHmac } from 'node:crypto';

import type { ReleaseManagementPlan, ReleasePolicyDecision } from '../../types.js';

/**
 * Server-side release decision (docs/19 §6). The client sends its identity and
 * component versions; the server owns plan selection, target-list matching,
 * sticky percentage bucketing, and the gate check, and returns only the
 * decision this one install is entitled to. Evaluation order:
 * explicit targets -> (scope) -> percentage bucket; percentage defaults to 100.
 */

export interface ReleaseCheckInput {
  installId: string;
  userId?: string | null;
  channel: string;
  platform?: string | null;
  /** componentId -> currently running version. */
  components: Record<string, string>;
}

export type ReleaseCheckMatchedBy = 'target-list' | 'percentage' | 'all';

export interface ReleaseCheckResult {
  status: 'up-to-date' | 'update-available' | 'blocked';
  reason: string;
  planId: string | null;
  releaseId: string | null;
  channel: string;
  decision: ReleasePolicyDecision | null;
  artifacts: ReleaseManagementPlan['artifacts'];
  activation: ReleaseManagementPlan['activation'] | null;
  releaseNotes: string | null;
  featureFlags: string[];
  rollout: {
    matchedBy: ReleaseCheckMatchedBy | null;
    bucket: number | null;
    percentage: number | null;
  };
}

export interface SignedReleaseCheckResult extends ReleaseCheckResult {
  signedAt: string;
  signature: {
    algorithm: 'hmac-sha256';
    keyId: string;
    value: string;
  };
}

export function evaluateReleaseCheck(
  plans: ReleaseManagementPlan[],
  input: ReleaseCheckInput
): ReleaseCheckResult {
  const empty: ReleaseCheckResult = {
    status: 'up-to-date',
    reason: 'no matching release plan for this install',
    planId: null,
    releaseId: null,
    channel: input.channel,
    decision: null,
    artifacts: [],
    activation: null,
    releaseNotes: null,
    featureFlags: [],
    rollout: { matchedBy: null, bucket: null, percentage: null }
  };
  const candidates = [...plans]
    .filter((plan) => plan.channel === input.channel)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  for (const plan of candidates) {
    const decision = matchComponentDecision(plan, input.components);
    if (!decision) continue;
    const match = matchRollout(plan, input, decision.componentId);
    if (!match) continue;

    const gateVerdict = plan.test?.gate?.verdict;
    const blocked = Boolean(gateVerdict && gateVerdict !== 'passed');
    return {
      status: blocked ? 'blocked' : 'update-available',
      reason: blocked
        ? `release gate is ${gateVerdict}`
        : decision.reason,
      planId: plan.planId,
      releaseId: plan.releaseId,
      channel: plan.channel,
      decision,
      artifacts: matchingArtifacts(plan, decision.componentId, input.platform),
      activation: plan.activation,
      releaseNotes: plan.releaseNotes ?? null,
      featureFlags: plan.rollout?.featureKeys ?? [],
      rollout: {
        matchedBy: match.matchedBy,
        bucket: match.bucket,
        percentage: plan.rollout?.percentage ?? null
      }
    };
  }
  return empty;
}

/**
 * Sticky bucket: sha256(releaseSeriesKey:installId) -> [0, 10000). The series
 * key is component + channel, not the plan id, so raising the percentage in a
 * follow-up plan keeps every already-included install included.
 */
export function releaseCheckBucket(componentId: string, channel: string, installId: string): number {
  const digest = createHash('sha256').update(`${componentId}:${channel}:${installId}`).digest();
  return digest.readUInt32BE(0) % 10000;
}

export function signReleaseCheckResult(
  result: ReleaseCheckResult,
  secret: string,
  keyId = 'release-decision-v1'
): SignedReleaseCheckResult {
  const signedAt = new Date().toISOString();
  const canonical = JSON.stringify({
    status: result.status,
    planId: result.planId,
    releaseId: result.releaseId,
    channel: result.channel,
    decision: result.decision,
    artifacts: result.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      url: artifact.url,
      digest: artifact.digest,
      version: artifact.version
    })),
    featureFlags: result.featureFlags,
    signedAt
  });
  return {
    ...result,
    signedAt,
    signature: {
      algorithm: 'hmac-sha256',
      keyId,
      value: createHmac('sha256', secret).update(canonical).digest('hex')
    }
  };
}

function matchComponentDecision(
  plan: ReleaseManagementPlan,
  components: Record<string, string>
): ReleasePolicyDecision | null {
  const decisions = [plan.components?.launcher, plan.components?.app]
    .filter((decision): decision is ReleasePolicyDecision => Boolean(decision));
  for (const decision of decisions) {
    const runningVersion = components[decision.componentId];
    if (runningVersion === undefined) continue;
    if (decision.targetVersion && decision.targetVersion !== runningVersion) {
      // Recompute against the caller's real running version instead of the
      // version recorded when the plan was created.
      return {
        ...decision,
        currentVersion: runningVersion,
        updateAvailable: true
      };
    }
  }
  return null;
}

function matchRollout(
  plan: ReleaseManagementPlan,
  input: ReleaseCheckInput,
  componentId: string
): { matchedBy: ReleaseCheckMatchedBy; bucket: number | null } | null {
  const audience = plan.rollout?.audience;
  const targetInstallIds = audience?.installIds ?? [];
  const targetUserIds = audience?.userIds ?? [];
  const hasTargets = targetInstallIds.length > 0 || targetUserIds.length > 0;
  if (hasTargets) {
    const matched = targetInstallIds.includes(input.installId)
      || (input.userId ? targetUserIds.includes(input.userId) : false);
    return matched ? { matchedBy: 'target-list', bucket: null } : null;
  }
  const percentage = typeof plan.rollout?.percentage === 'number' ? plan.rollout.percentage : 100;
  if (percentage >= 100) return { matchedBy: 'all', bucket: null };
  const bucket = releaseCheckBucket(componentId, plan.channel, input.installId);
  return bucket < percentage * 100 ? { matchedBy: 'percentage', bucket } : null;
}

function matchingArtifacts(
  plan: ReleaseManagementPlan,
  componentId: string,
  platform: string | null | undefined
): ReleaseManagementPlan['artifacts'] {
  const normalizedPlatform = platform?.trim() || null;
  return (plan.artifacts ?? [])
    .filter((artifact) => !artifact.componentId || artifact.componentId === componentId)
    .filter((artifact) => !artifact.platform || !normalizedPlatform || artifact.platform === normalizedPlatform);
}
