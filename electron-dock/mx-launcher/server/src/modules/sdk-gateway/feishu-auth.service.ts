import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';

import { authenticationRateLimitBucketKey } from '../../lib/auth-rate-limit.js';
import { userMatchesLogin } from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import type {
  RuntimeConfig,
  TokenIntrospectionResult,
  UserCenterIssuedToken,
  UserCenterUser
} from '../../types.js';

const FEISHU_APP_IDS = ['mx-h2i', 'appcenter', 'h2o'];
const FEISHU_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const FEISHU_REQUEST_TIMEOUT_MS = 10_000;
const FEISHU_RATE_LIMIT_WINDOW_SECONDS = 60;
const FEISHU_AUTHORIZE_LIMIT_PER_SOURCE = 60;
const FEISHU_EXCHANGE_LIMIT_PER_SOURCE = 30;
const FEISHU_AUTH_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const STATE_PATTERN = /^[A-Za-z0-9\-._~]{16,512}$/;
const FEISHU_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

export type FeishuFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FeishuAuthorizeInput {
  redirectUri?: string | null;
  state?: string | null;
  codeChallenge?: string | null;
  sourceKey?: string | null;
}

export interface FeishuTokenExchangeInput {
  code?: string | null;
  redirectUri?: string | null;
  codeVerifier?: string | null;
  exchangeHandle?: string | null;
  audience?: string | null;
  scopes?: string[];
  requestId?: string | null;
  sourceKey?: string | null;
}

export interface FeishuTokenExchangeResult {
  issued: UserCenterIssuedToken;
  introspection: TokenIntrospectionResult;
}

interface FeishuIdentity {
  subject: string;
  displayName: string;
}

export class FeishuAuthService {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: PlatformStore,
    private readonly fetchImpl: FeishuFetch = (input, init) => globalThis.fetch(input, init)
  ) {}

  publicConfig() {
    return {
      enabled: this.isConfigured(),
      appId: this.config.feishuAppId,
      authorizeUrl: this.config.feishuAuthorizeUrl,
      redirectUris: [...this.config.feishuRedirectUris],
      autoProvision: this.config.feishuAutoProvisionEnabled,
      pkce: {
        required: true,
        codeChallengeMethod: 'S256',
        localExchangeBinding: true,
        providerVerification: 'requires-real-tenant-validation'
      }
    };
  }

  async authorize(input: FeishuAuthorizeInput) {
    const appId = this.requireConfiguredValue(this.config.feishuAppId);
    this.assertConfigured();
    const redirectUri = this.requireAllowedRedirectUri(input.redirectUri);
    const state = requireMatchingString(input.state, 'state', STATE_PATTERN);
    const codeChallenge = requireMatchingString(
      input.codeChallenge,
      'codeChallenge',
      PKCE_CHALLENGE_PATTERN
    );
    let authorizationUrl: string;
    try {
      authorizationUrl = buildFeishuAuthorizationUrl(
        this.config.feishuAuthorizeUrl,
        appId,
        redirectUri,
        state,
        codeChallenge
      );
    } catch {
      throw new ServiceUnavailableException('Feishu OAuth authorization endpoint is invalid');
    }
    await this.assertSourceRateLimit('authorize', input.sourceKey, FEISHU_AUTHORIZE_LIMIT_PER_SOURCE);
    const exchangeHandle = `mxfx1.${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date();
    await this.store.createFeishuAuthorizationTransaction({
      transactionId: feishuTransactionKey(exchangeHandle),
      redirectUri,
      codeChallenge,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + FEISHU_AUTH_TRANSACTION_TTL_MS).toISOString()
    });
    return { authorizationUrl, exchangeHandle };
  }

  async exchange(input: FeishuTokenExchangeInput): Promise<FeishuTokenExchangeResult> {
    this.assertConfigured();
    const code = requireOpaqueString(input.code, 'code', 2_048);
    const redirectUri = this.requireAllowedRedirectUri(input.redirectUri);
    const codeVerifier = requireMatchingString(
      input.codeVerifier,
      'codeVerifier',
      PKCE_VERIFIER_PATTERN
    );
    await this.assertSourceRateLimit('exchange', input.sourceKey, FEISHU_EXCHANGE_LIMIT_PER_SOURCE);
    await this.consumeTransaction(input.exchangeHandle, redirectUri, codeVerifier);
    const accessToken = await this.exchangeAuthorizationCode(code, redirectUri, codeVerifier);
    const identity = await this.loadIdentity(accessToken);
    const user = await this.resolveUser(identity, input.requestId ?? null);
    const issued = await this.store.issueUserCenterToken({
      subjectKind: 'user',
      subjectId: user.userId,
      audience: input.audience?.trim() || 'mx-sdk',
      scopes: input.scopes ?? [],
      authProvider: 'feishu',
      ttlSeconds: FEISHU_TOKEN_TTL_SECONDS,
      requestId: input.requestId ?? null
    });
    const introspection = await this.store.introspectToken({
      token: issued.token,
      audience: issued.record.audience,
      requestId: input.requestId ?? null
    });
    if (
      !introspection.active
      || introspection.principal?.userId !== user.userId
      || introspection.authProvider !== 'feishu'
    ) {
      throw new ServiceUnavailableException('Unable to issue an active Feishu session');
    }
    return { issued, introspection };
  }

  private async assertSourceRateLimit(
    operation: 'authorize' | 'exchange',
    rawSourceKey: string | null | undefined,
    limit: number
  ): Promise<void> {
    const [decision] = await this.store.consumeAuthenticationRateLimits([{
      bucketKey: authenticationRateLimitBucketKey(
        `feishu-${operation}-source`,
        rawSourceKey?.trim().slice(0, 512) || 'unknown-source'
      ),
      limit,
      windowSeconds: FEISHU_RATE_LIMIT_WINDOW_SECONDS
    }]);
    if (!decision?.allowed) {
      throw new HttpException(
        `Feishu OAuth ${operation} rate limit exceeded`,
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  private async consumeTransaction(
    rawHandle: string | null | undefined,
    redirectUri: string,
    codeVerifier: string
  ): Promise<void> {
    const handle = requireMatchingString(
      rawHandle,
      'exchangeHandle',
      /^mxfx1\.[A-Za-z0-9_-]{43}$/
    );
    const key = feishuTransactionKey(handle);
    const transaction = await this.store.consumeFeishuAuthorizationTransaction(key);
    if (!transaction) {
      throw new UnauthorizedException('Feishu authorization transaction is missing, expired, or already consumed');
    }
    const actualChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (
      transaction.redirectUri !== redirectUri
      || !secureStringEqual(transaction.codeChallenge, actualChallenge)
    ) {
      throw new UnauthorizedException('Feishu authorization transaction does not match the callback');
    }
  }

  private isConfigured(): boolean {
    return Boolean(
      this.config.feishuAppId
      && this.config.feishuAppSecret
      && this.config.feishuAuthorizeUrl
      && this.config.feishuTokenUrl
      && this.config.feishuUserInfoUrl
      && this.config.feishuRedirectUris.length
      && this.config.feishuAllowedTenantKeys.length
    );
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('Feishu OAuth is not configured');
    }
  }

  private requireConfiguredValue(value: string | null): string {
    if (!value) throw new ServiceUnavailableException('Feishu OAuth is not configured');
    return value;
  }

  private requireAllowedRedirectUri(value: string | null | undefined): string {
    const redirectUri = requireOpaqueString(value, 'redirectUri', 2_048);
    if (!this.config.feishuRedirectUris.includes(redirectUri)) {
      throw new BadRequestException('redirectUri is not allowed');
    }
    return redirectUri;
  }

  private async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    codeVerifier: string
  ): Promise<string> {
    const payload = await this.requestJson(
      this.config.feishuTokenUrl,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: this.requireConfiguredValue(this.config.feishuAppId),
          client_secret: this.requireConfiguredValue(this.config.feishuAppSecret),
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier
        }),
        redirect: 'error'
      },
      'token'
    );
    const tokenPayload = nestedData(payload);
    const accessToken = stringValue(tokenPayload.access_token);
    if (!accessToken) {
      throw new BadGatewayException('Feishu OAuth token response is invalid');
    }
    return accessToken;
  }

  private async loadIdentity(accessToken: string): Promise<FeishuIdentity> {
    const payload = await this.requestJson(
      this.config.feishuUserInfoUrl,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`
        },
        redirect: 'error'
      },
      'user information'
    );
    const userInfo = nestedData(payload);
    const tenantKey = stringValue(userInfo.tenant_key);
    const openId = stringValue(userInfo.open_id) ?? stringValue(userInfo.sub);
    if (!tenantKey || !openId || !FEISHU_ID_PATTERN.test(tenantKey) || !FEISHU_ID_PATTERN.test(openId)) {
      throw new BadGatewayException('Feishu user information response is invalid');
    }
    if (!this.config.feishuAllowedTenantKeys.includes(tenantKey)) {
      throw new UnauthorizedException('Feishu tenant is not allowed');
    }
    const subject = `${tenantKey}:${openId}`;
    const displayName = (
      stringValue(userInfo.name)
      ?? stringValue(userInfo.en_name)
      ?? `Feishu user ${feishuSubjectHash(subject).slice(0, 8)}`
    ).slice(0, 255);
    return { subject, displayName };
  }

  private async resolveUser(identity: FeishuIdentity, requestId: string | null): Promise<UserCenterUser> {
    const users = await this.store.listUserCenterUsers();
    const linked = users.filter(
      (user) => user.profile.externalIds.feishuSubject === identity.subject
    );
    if (linked.length > 1) {
      throw new ConflictException('Feishu identity is linked to multiple users');
    }
    if (linked[0]) {
      if (linked[0].status !== 'active') {
        throw new UnauthorizedException('Feishu-linked account is not active');
      }
      return this.ensureFeishuAppAccess(linked[0], requestId);
    }
    if (!this.config.feishuAutoProvisionEnabled) {
      throw new UnauthorizedException('Feishu account is not provisioned');
    }

    const hash = feishuSubjectHash(identity.subject);
    const userId = `usr_feishu_${hash}`;
    const account = `feishu_${hash}`;
    const occupiedUser = users.find((user) => user.userId === userId);
    if (occupiedUser) {
      throw new ConflictException('Deterministic Feishu user ID is already occupied');
    }
    const occupiedLogin = users.find((user) => userMatchesLogin(user, account));
    if (occupiedLogin) {
      throw new ConflictException('Deterministic Feishu account is already occupied');
    }

    const created = await this.store.createUserCenterUser({
      userId,
      account,
      displayName: identity.displayName,
      roleIds: ['mx-user'],
      externalIds: {
        feishuSubject: identity.subject
      },
      homeAppId: 'mx-h2i',
      registeredByAppId: 'mx-h2i',
      allowedAppIds: FEISHU_APP_IDS,
      requestedBy: 'sdk-gateway:feishu',
      requestId
    });
    if (
      created.userId !== userId
      || created.profile.externalIds.feishuSubject !== identity.subject
      || created.status !== 'active'
    ) {
      throw new ConflictException('Unable to create an isolated Feishu user');
    }
    return created;
  }

  private async ensureFeishuAppAccess(user: UserCenterUser, requestId: string | null): Promise<UserCenterUser> {
    const missingAppIds = FEISHU_APP_IDS.filter(
      (appId) => !user.appAccess.allowedAppIds.includes(appId)
    );
    if (!missingAppIds.length) return user;
    return this.store.createUserCenterUser({
      userId: user.userId,
      account: user.account,
      roleIds: user.roleIds,
      orgIds: user.orgIds,
      allowedAppIds: missingAppIds,
      requestedBy: 'sdk-gateway:feishu',
      requestId
    });
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    operation: 'token' | 'user information'
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FEISHU_REQUEST_TIMEOUT_MS);
    timeout.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal
      });
    } catch {
      throw new BadGatewayException(`Feishu OAuth ${operation} request failed`);
    } finally {
      clearTimeout(timeout);
    }
    let payload: Record<string, unknown>;
    try {
      payload = recordValue(await response.json());
    } catch {
      throw new BadGatewayException(`Feishu OAuth ${operation} response is invalid`);
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw new UnauthorizedException(`Feishu OAuth ${operation} was rejected`);
      }
      throw new BadGatewayException(`Feishu OAuth ${operation} request failed`);
    }
    const errorCode = numberValue(payload.code);
    if ('code' in payload && errorCode !== 0) {
      throw new UnauthorizedException(`Feishu OAuth ${operation} was rejected`);
    }
    return payload;
  }
}

export function buildFeishuAuthorizationUrl(
  authorizeUrl: string,
  appId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string
): string {
  const url = new URL(authorizeUrl);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function feishuSubjectHash(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 24);
}

function feishuTransactionKey(handle: string): string {
  return createHash('sha256')
    .update('mx-feishu-exchange-handle-v1\0')
    .update(handle)
    .digest('hex');
}

function secureStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function requireMatchingString(
  value: string | null | undefined,
  field: string,
  pattern: RegExp
): string {
  const normalized = typeof value === 'string' ? value : '';
  if (!pattern.test(normalized)) {
    throw new BadRequestException(`${field} has an invalid format`);
  }
  return normalized;
}

function requireOpaqueString(
  value: string | null | undefined,
  field: string,
  maxLength: number
): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

function nestedData(payload: Record<string, unknown>): Record<string, unknown> {
  return recordValue(payload.data ?? payload);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
