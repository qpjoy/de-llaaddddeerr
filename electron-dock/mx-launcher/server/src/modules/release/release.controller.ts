import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, extname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Inject, NotFoundException, Param, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';

import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { normalizeReleaseArtifactKind } from '../../store/domain.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { ReleaseArtifactKind, ReleaseManagementE2eResult, ReleaseManagementPlanInput, ReleaseReportInput } from '../../types.js';
import { evaluateReleaseCheck, signReleaseCheckResult } from './release-check.js';

@Controller()
export class ReleaseController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/release/tasks')
  async tasks(@Query('installId') installId?: string) {
    return { tasks: installId ? await this.store.listTasks(installId) : [] };
  }

  @Post('internal/v1/release/reports')
  async report(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const input: ReleaseReportInput = {
      taskId: nullableString(body.taskId) ?? undefined,
      installId: nullableString(body.installId) ?? undefined,
      status: nullableString(body.status) ?? undefined,
      error: nullableString(body.error),
      metadata: asRecord(body.metadata)
    };
    return { auditEvent: await this.store.recordReleaseReport(input) };
  }

  @Post('internal/v1/releases/policy/evaluate')
  async evaluatePolicy(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      decision: await this.store.evaluateReleaseUpdate({
        componentKind: nullableString(body.componentKind) ?? 'app-managed',
        componentId: nullableString(body.componentId) ?? 'h2o',
        currentVersion: nullableString(body.currentVersion) ?? '0.0.0',
        targetVersion: nullableString(body.targetVersion) ?? '0.0.0',
        channel: nullableString(body.channel) ?? 'shadow',
        installId: nullableString(body.installId),
        userId: nullableString(body.userId)
      })
    };
  }

  /**
   * Single-install release decision (docs/19 §6). The server owns targeting
   * and rollout evaluation; clients no longer read the full plans list.
   */
  @Post('internal/v1/release/check')
  async checkRelease(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const installId = nullableString(body.installId);
    if (!installId) throw new BadRequestException('release check requires installId');
    const components = releaseCheckComponents(body);
    if (Object.keys(components).length === 0) {
      throw new BadRequestException('release check requires components: { componentId: currentVersion }');
    }
    const plans = await this.store.listReleaseManagementPlans();
    const result = evaluateReleaseCheck(plans, {
      installId,
      userId: nullableString(body.userId),
      channel: nullableString(body.channel) ?? 'stable',
      platform: nullableString(body.platform),
      components
    });
    await this.store.recordReleaseReport({
      installId,
      status: 'release-check',
      metadata: {
        status: result.status,
        planId: result.planId,
        releaseId: result.releaseId,
        matchedBy: result.rollout.matchedBy,
        bucket: result.rollout.bucket
      }
    });
    return signReleaseCheckResult(result, releaseDecisionSecret());
  }

  @Get('internal/v1/release-management/plans')
  async listManagementPlans(@Req() req: IncomingMessage) {
    assertReleasePlansAccess(req);
    return { plans: await this.store.listReleaseManagementPlans() };
  }

  @Post('internal/v1/release-management/plans')
  async createManagementPlan(@Body() rawBody: unknown) {
    return { plan: await this.store.createReleaseManagementPlan(toReleaseManagementPlanInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/release-management/plans/:planId')
  async getManagementPlan(@Param('planId') planId: string) {
    const plan = await this.store.getReleaseManagementPlan(planId);
    if (!plan) throw new NotFoundException('Release management plan not found');
    return { plan };
  }

  @Post('internal/v1/release-management/plans/:planId/gate')
  async completeManagementGate(
    @Param('planId') planId: string,
    @Body() rawBody: unknown
  ) {
    const body = asRecord(rawBody);
    const status = releaseManagementE2eResult(body.status ?? body.e2eResult) ?? 'passed';
    return {
      plan: await this.store.completeReleaseManagementGate(planId, {
        status,
        message: nullableString(body.message),
        evidence: asRecord(body.evidence),
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }

  @Post('internal/v1/release-artifacts')
  async uploadArtifact(
    @Req() req: IncomingMessage,
    @Query() rawQuery: Record<string, unknown>
  ) {
    const query = asRecord(rawQuery);
    const kind = normalizeReleaseArtifactKind(nullableString(query.kind) ?? 'mx-h2i-installer');
    const version = nullableString(query.version) ?? '0.0.0';
    const componentId = nullableString(query.componentId) ?? 'mx-h2i';
    const releaseId = nullableString(query.releaseId) ?? 'manual-upload';
    const platform = normalizeReleasePlatform(nullableString(query.platform));
    const expectedDigest = normalizeSha256Digest(nullableString(query.digest));
    const fileName = safeArtifactFileName(nullableString(query.fileName) ?? `${kind}-${version}.bin`);
    const maxBytes = releaseArtifactMaxBytes();
    const storage = releaseArtifactStorageForRequest(nullableString(query.storage));
    const contentLength = nullableNumberHeader(req.headers['content-length']);
    if (contentLength !== null && contentLength > maxBytes) {
      throw new BadRequestException(`Release artifact is too large: ${contentLength} > ${maxBytes}`);
    }

    const storeDir = releaseArtifactStoreDir();
    const incomingDir = resolve(storeDir, '.incoming');
    await mkdir(incomingDir, { recursive: true });
    const tempPath = resolve(incomingDir, `${randomUUID()}.upload`);
    const uploaded = await writeRequestToFile(req, tempPath, maxBytes);
    if (expectedDigest && uploaded.digest !== expectedDigest) {
      await rm(tempPath, { force: true });
      throw new BadRequestException(`Release artifact digest mismatch: expected ${expectedDigest}, got ${uploaded.digest}`);
    }

    const artifactId = releaseArtifactId(releaseId, kind, version, uploaded.digest);
    const artifactDir = resolve(storeDir, artifactId);
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = resolve(artifactDir, fileName);
    let ossObjectKey: string | null = null;
    let publicUrl: string | null = null;
    if (storage === 'oss') {
      const oss = releaseOssConfig();
      if (!oss) {
        await rm(tempPath, { force: true });
        throw new BadRequestException('Release artifact storage=oss requires MX_RELEASE_OSS_* configuration');
      }
      ossObjectKey = releaseOssObjectKey(oss, releaseId, artifactId, fileName);
      await putReleaseArtifactToOss(oss, ossObjectKey, tempPath, metadataContentType(req), uploaded.bytes);
      await rm(tempPath, { force: true });
      publicUrl = releaseOssPublicUrl(oss, ossObjectKey);
    } else {
      await rm(artifactPath, { force: true });
      await rename(tempPath, artifactPath);
    }
    const downloadPath = `/internal/v1/release-artifacts/${encodeURIComponent(artifactId)}/download`;
    const artifactUrl = publicUrl || publicReleaseUrl(downloadPath) || downloadPath;
    const metadata: StoredReleaseArtifactMetadata = {
      artifactId,
      releaseId,
      kind,
      componentId,
      version,
      fileName,
      digest: uploaded.digest,
      sizeBytes: uploaded.bytes,
      platform,
      source: 'manual-upload',
      storage,
      contentType: metadataContentType(req),
      objectKey: ossObjectKey,
      publicUrl,
      url: artifactUrl,
      createdAt: new Date().toISOString()
    };
    await writeFile(resolve(artifactDir, 'artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    return {
      artifact: {
        ...metadata,
        url: metadata.url,
        downloadPath,
        signature: null,
        activation: kind === 'mx-h2i-installer' ? 'installer-manual' : 'hot-auto',
        autoApply: kind !== 'mx-h2i-installer',
        restartRequired: kind === 'mx-h2i-installer' || kind === 'launcher-asar' || kind === 'app-asar' || kind === 'native-helper',
        requiredAppRestart: kind === 'mx-h2i-installer' || kind === 'launcher-asar' || kind === 'app-asar' || kind === 'native-helper',
        notes: ['stored by Internal Release Center artifact store']
      }
    };
  }

  @Get('internal/v1/release-artifacts/:artifactId')
  async getArtifact(@Param('artifactId') artifactId: string) {
    return { artifact: await readStoredArtifactMetadata(artifactId) };
  }

  @Get('internal/v1/release-artifacts/:artifactId/download')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async downloadArtifact(
    @Param('artifactId') artifactId: string,
    @Res({ passthrough: true }) res: ServerResponse
  ) {
    const metadata = await readStoredArtifactMetadata(artifactId);
    if (metadata.storage === 'oss') {
      const oss = releaseOssConfig();
      const redirectUrl = metadata.publicUrl || (oss && metadata.objectKey ? releaseOssSignedUrl(oss, metadata.objectKey) : null);
      if (!redirectUrl) throw new NotFoundException('Release artifact OSS URL not available');
      res.statusCode = 302;
      res.setHeader('Location', redirectUrl);
      res.setHeader('X-MX-Artifact-Digest', metadata.digest);
      return null;
    }
    const artifactPath = resolve(releaseArtifactStoreDir(), metadata.artifactId, metadata.fileName);
    await assertFileExists(artifactPath);
    res.setHeader('Content-Type', metadata.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(metadata.sizeBytes));
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.fileName.replace(/"/g, '')}"`);
    res.setHeader('X-MX-Artifact-Digest', metadata.digest);
    return new StreamableFile(createReadStream(artifactPath));
  }
}

function toReleaseManagementPlanInput(body: Record<string, unknown>): ReleaseManagementPlanInput {
  return {
    releaseId: nullableString(body.releaseId),
    channel: nullableString(body.channel),
    installId: nullableString(body.installId),
    userId: nullableString(body.userId),
    productId: nullableString(body.productId),
    appId: nullableString(body.appId),
    launcherComponentId: nullableString(body.launcherComponentId),
    appComponentId: nullableString(body.appComponentId),
    launcherUpdatePolicy: nullableString(body.launcherUpdatePolicy),
    appUpdatePolicy: nullableString(body.appUpdatePolicy),
    launcherCurrentVersion: nullableString(body.launcherCurrentVersion),
    launcherTargetVersion: nullableString(body.launcherTargetVersion),
    appCurrentVersion: nullableString(body.appCurrentVersion),
    appTargetVersion: nullableString(body.appTargetVersion),
    artifactKind: nullableString(body.artifactKind),
    artifactVersion: nullableString(body.artifactVersion),
    artifactUrl: nullableString(body.artifactUrl),
    artifactDigest: nullableString(body.artifactDigest),
    artifactSignature: nullableString(body.artifactSignature),
    artifactSizeBytes: nullableNumber(body.artifactSizeBytes),
    artifactPlatform: normalizeReleasePlatform(nullableString(body.artifactPlatform)),
    activationMode: nullableString(body.activationMode),
    rolloutStrategy: nullableString(body.rolloutStrategy),
    rolloutPercentage: nullableNumber(body.rolloutPercentage),
    rolloutSegment: nullableString(body.rolloutSegment),
    rolloutRings: stringArray(body.rolloutRings),
    featureKeys: stringArray(body.featureKeys),
    targetUserIds: stringArray(body.targetUserIds),
    targetInstallIds: stringArray(body.targetInstallIds),
    releaseNotes: nullableString(body.releaseNotes),
    suiteId: nullableString(body.suiteId),
    topology: nullableString(body.topology),
    sites: stringArray(body.sites),
    e2eResult: releaseManagementE2eResult(body.e2eResult),
    createdBy: nullableString(body.createdBy),
    requestId: nullableString(body.requestId)
  };
}

function releaseCheckComponents(body: Record<string, unknown>): Record<string, string> {
  const components: Record<string, string> = {};
  const raw = asRecord(body.components);
  for (const [componentId, version] of Object.entries(raw)) {
    const normalizedVersion = nullableString(version);
    if (componentId.trim() && normalizedVersion) components[componentId.trim()] = normalizedVersion;
  }
  // Single-component fallback so curl-level checks stay simple.
  const componentId = nullableString(body.componentId);
  const currentVersion = nullableString(body.currentVersion);
  if (componentId && currentVersion && !components[componentId]) components[componentId] = currentVersion;
  return components;
}

function releaseDecisionSecret(): string {
  return nullableString(process.env.MX_RELEASE_DECISION_SECRET) ?? 'mx-release-decision-dev-secret';
}

// The full plans list leaks unreleased versions and rollout intent; once
// MX_RELEASE_PLANS_ADMIN_TOKEN is set, only Admin callers may read it and
// clients must use POST /internal/v1/release/check. Unset keeps the legacy
// open behavior for migration.
function assertReleasePlansAccess(req: IncomingMessage): void {
  const requiredToken = nullableString(process.env.MX_RELEASE_PLANS_ADMIN_TOKEN);
  if (!requiredToken) return;
  const provided = req.headers['x-mx-admin-token'];
  const token = Array.isArray(provided) ? provided[0] : provided;
  if (token !== requiredToken) {
    throw new ForbiddenException('release plans listing is admin-only; clients must use POST /internal/v1/release/check');
  }
}

function releaseManagementE2eResult(value: unknown): ReleaseManagementE2eResult | null {
  if (value === 'passed' || value === 'failed' || value === 'blocked' || value === 'running') return value;
  return null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

interface StoredReleaseArtifactMetadata {
  artifactId: string;
  releaseId: string;
  kind: ReleaseArtifactKind;
  componentId: string;
  version: string;
  fileName: string;
  digest: string;
  sizeBytes: number;
  platform: string | null;
  source: 'manual-upload';
  storage: 'server' | 'oss';
  contentType: string;
  objectKey: string | null;
  publicUrl: string | null;
  url: string;
  createdAt: string;
}

interface ReleaseOssConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string | null;
  prefix: string;
  publicBaseUrl: string | null;
  signedUrlTtlSeconds: number;
}

async function writeRequestToFile(
  req: IncomingMessage,
  targetPath: string,
  maxBytes: number
): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256');
  const output = createWriteStream(targetPath, { flags: 'wx' });
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new BadRequestException(`Release artifact is too large: ${bytes} > ${maxBytes}`);
      }
      hash.update(buffer);
      if (!output.write(buffer)) {
        await once(output, 'drain');
      }
    }
    await new Promise<void>((resolvePromise, reject) => {
      output.once('error', reject);
      output.end(resolvePromise);
    });
  } catch (error) {
    output.destroy();
    await rm(targetPath, { force: true });
    throw error;
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    bytes
  };
}

async function readStoredArtifactMetadata(artifactId: string): Promise<StoredReleaseArtifactMetadata> {
  const safeArtifactId = assertSafeArtifactId(artifactId);
  const metadataPath = resolve(releaseArtifactStoreDir(), safeArtifactId, 'artifact.json');
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
  } catch {
    throw new NotFoundException('Release artifact not found');
  }
  const row = asRecord(payload);
  const metadata: StoredReleaseArtifactMetadata = {
    artifactId: assertSafeArtifactId(nullableString(row.artifactId) ?? ''),
    releaseId: safePathPart(nullableString(row.releaseId) ?? 'release'),
    kind: normalizeReleaseArtifactKind(row.kind),
    componentId: nullableString(row.componentId) ?? 'mx-h2i',
    version: nullableString(row.version) ?? '0.0.0',
    fileName: safeArtifactFileName(nullableString(row.fileName) ?? 'artifact.bin'),
    digest: normalizeSha256Digest(nullableString(row.digest)) ?? '',
    sizeBytes: nullableNumber(row.sizeBytes) ?? 0,
    platform: normalizeReleasePlatform(nullableString(row.platform)),
    source: 'manual-upload',
    storage: row.storage === 'oss' ? 'oss' : 'server',
    contentType: nullableString(row.contentType) ?? 'application/octet-stream',
    objectKey: nullableString(row.objectKey),
    publicUrl: nullableString(row.publicUrl),
    url: nullableString(row.url) ?? `/internal/v1/release-artifacts/${encodeURIComponent(safeArtifactId)}/download`,
    createdAt: nullableString(row.createdAt) ?? new Date(0).toISOString()
  };
  if (metadata.artifactId !== safeArtifactId || !metadata.digest || metadata.sizeBytes < 0) {
    throw new NotFoundException('Release artifact metadata is invalid');
  }
  return metadata;
}

async function assertFileExists(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw new NotFoundException('Release artifact file not found');
  }
}

function releaseArtifactStoreDir(): string {
  return resolve(process.env.MX_RELEASE_ARTIFACT_STORE_DIR || 'artifacts/release-center');
}

function releaseArtifactStorageForRequest(value: string | null): 'server' | 'oss' {
  if (value === 'server') return 'server';
  if (value === 'oss') return 'oss';
  const configured = nullableString(process.env.MX_RELEASE_ARTIFACT_STORAGE);
  if (configured === 'server') return 'server';
  if (configured === 'oss') return 'oss';
  return releaseOssConfig() ? 'oss' : 'server';
}

function publicReleaseUrl(path: string): string | null {
  const baseUrl = nullableString(process.env.MX_PUBLIC_BASE_URL);
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function releaseArtifactMaxBytes(): number {
  const parsed = Number(process.env.MX_RELEASE_ARTIFACT_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 1024 * 1024 * 1024;
}

function releaseOssConfig(): ReleaseOssConfig | null {
  const endpoint = nullableString(process.env.MX_RELEASE_OSS_ENDPOINT ?? process.env.OSS_ENDPOINT);
  const bucket = nullableString(process.env.MX_RELEASE_OSS_BUCKET ?? process.env.OSS_BUCKET);
  const accessKeyId = nullableString(
    process.env.MX_RELEASE_OSS_ACCESS_KEY_ID
      ?? process.env.OSS_ACCESS_KEY_ID
      ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
  );
  const accessKeySecret = nullableString(
    process.env.MX_RELEASE_OSS_ACCESS_KEY_SECRET
      ?? process.env.OSS_ACCESS_KEY_SECRET
      ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  );
  const securityToken = nullableString(
    process.env.MX_RELEASE_OSS_SECURITY_TOKEN
      ?? process.env.OSS_SECURITY_TOKEN
      ?? process.env.ALIBABA_CLOUD_SECURITY_TOKEN
  );
  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) return null;
  return {
    endpoint: normalizeOssEndpoint(endpoint),
    bucket,
    accessKeyId,
    accessKeySecret,
    securityToken,
    prefix: safeOssPrefix(process.env.MX_RELEASE_OSS_PREFIX || 'mx-h2i/releases'),
    publicBaseUrl: nullableString(process.env.MX_RELEASE_OSS_PUBLIC_BASE_URL),
    signedUrlTtlSeconds: nullableNumber(process.env.MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS) ?? 3600
  };
}

async function putReleaseArtifactToOss(
  config: ReleaseOssConfig,
  objectKey: string,
  filePath: string,
  contentType: string,
  sizeBytes: number
): Promise<void> {
  const date = new Date().toUTCString();
  const url = releaseOssEndpointUrl(config, objectKey);
  const ossHeaders = releaseOssSecurityHeaders(config);
  const headers = {
    ...ossHeaders,
    authorization: releaseOssAuthorization(config, 'PUT', objectKey, date, contentType, ossHeaders),
    date,
    'content-type': contentType,
    'content-length': String(sizeBytes)
  };
  const status = await putFile(url, headers, filePath);
  if (status < 200 || status >= 300) {
    throw new BadRequestException(`OSS upload failed with HTTP ${status}`);
  }
}

async function putFile(url: string, headers: Record<string, string>, filePath: string): Promise<number> {
  const parsed = new URL(url);
  const requester = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolvePromise, reject) => {
    const request = requester(parsed, { method: 'PUT', headers }, (response) => {
      response.resume();
      response.on('end', () => resolvePromise(response.statusCode || 0));
    });
    request.on('error', reject);
    pipeline(createReadStream(filePath), request).catch(reject);
  });
}

function releaseOssAuthorization(
  config: ReleaseOssConfig,
  method: 'PUT' | 'GET',
  objectKey: string,
  dateOrExpires: string,
  contentType = '',
  ossHeaders: Record<string, string> = {}
): string {
  const canonicalResource = releaseOssCanonicalResource(config, objectKey);
  const stringToSign = `${method}\n\n${contentType}\n${dateOrExpires}\n${canonicalizedOssHeaders(ossHeaders)}${canonicalResource}`;
  const signature = createHmac('sha1', config.accessKeySecret).update(stringToSign).digest('base64');
  return `OSS ${config.accessKeyId}:${signature}`;
}

function releaseOssSignedUrl(config: ReleaseOssConfig, objectKey: string): string {
  const expires = String(Math.floor(Date.now() / 1000) + config.signedUrlTtlSeconds);
  const securityTokenParam = config.securityToken ? [['security-token', config.securityToken] as const] : [];
  const canonicalResource = releaseOssCanonicalResource(config, objectKey, securityTokenParam);
  const stringToSign = `GET\n\n\n${expires}\n${canonicalResource}`;
  const signature = createHmac('sha1', config.accessKeySecret).update(stringToSign).digest('base64');
  const url = new URL(releaseOssEndpointUrl(config, objectKey));
  url.searchParams.set('OSSAccessKeyId', config.accessKeyId);
  url.searchParams.set('Expires', expires);
  if (config.securityToken) url.searchParams.set('security-token', config.securityToken);
  url.searchParams.set('Signature', signature);
  return url.toString();
}

function releaseOssEndpointUrl(config: ReleaseOssConfig, objectKey: string): string {
  const endpoint = new URL(config.endpoint);
  const hostname = endpoint.hostname.toLowerCase();
  const bucketPrefix = `${config.bucket.toLowerCase()}.`;
  if (!hostname.startsWith(bucketPrefix)) {
    endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
  }
  endpoint.pathname = `/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  endpoint.search = '';
  return endpoint.toString();
}

function releaseOssSecurityHeaders(config: ReleaseOssConfig): Record<string, string> {
  return config.securityToken ? { 'x-oss-security-token': config.securityToken } : {};
}

function releaseOssCanonicalResource(
  config: ReleaseOssConfig,
  objectKey: string,
  subresources: ReadonlyArray<readonly [string, string]> = []
): string {
  const resource = `/${config.bucket}/${objectKey}`;
  if (subresources.length === 0) return resource;
  const query = [...subresources]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return `${resource}?${query}`;
}

function canonicalizedOssHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .filter(([key]) => key.startsWith('x-oss-'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
}

function releaseOssPublicUrl(config: ReleaseOssConfig, objectKey: string): string | null {
  if (!config.publicBaseUrl) return null;
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

function releaseOssObjectKey(
  config: ReleaseOssConfig,
  releaseId: string,
  artifactId: string,
  fileName: string
): string {
  return [
    config.prefix,
    safePathPart(releaseId),
    safePathPart(artifactId),
    safeArtifactFileName(fileName)
  ].filter(Boolean).join('/');
}

function releaseArtifactId(releaseId: string, kind: ReleaseArtifactKind, version: string, digest: string): string {
  const digestPart = digest.replace(/^sha256:/, '').slice(0, 12);
  return [
    'artifact',
    safePathPart(releaseId),
    safePathPart(kind),
    safePathPart(version),
    safePathPart(digestPart)
  ].join('_');
}

function assertSafeArtifactId(value: string): string {
  const safe = safePathPart(value);
  if (!safe || safe !== value) {
    throw new BadRequestException('Invalid release artifact id');
  }
  return safe;
}

function safeArtifactFileName(value: string): string {
  const base = basename(value).trim();
  const rawExt = extname(base).replace(/^\./, '');
  const ext = rawExt ? safePathPart(rawExt) : '';
  const stem = safePathPart(base.replace(/\.[^.]+$/, '') || 'artifact');
  return ext ? `${stem}.${ext}` : stem;
}

function metadataContentType(req: IncomingMessage): string {
  return nullableString(req.headers['content-type']) ?? 'application/octet-stream';
}

function normalizeOssEndpoint(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withScheme);
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function safeOssPrefix(value: string): string {
  return String(value || '')
    .split('/')
    .map((part) => safePathPart(part))
    .filter(Boolean)
    .join('/');
}

function safePathPart(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    || 'artifact';
}

function normalizeSha256Digest(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized.startsWith('sha256:') ? normalized : `sha256:${normalized}`;
}

function normalizeReleasePlatform(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  if (normalized === 'mac' || normalized === 'macos' || normalized === 'darwin') return 'darwin';
  if (normalized === 'win' || normalized === 'windows' || normalized === 'win32') return 'win32';
  if (normalized === 'linux') return 'linux';
  return safePathPart(normalized);
}

function nullableNumberHeader(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return nullableNumber(value[0]);
  return nullableNumber(value);
}
