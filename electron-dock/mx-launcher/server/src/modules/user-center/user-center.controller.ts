import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { promisify } from 'node:util';

import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Header, Headers, Inject, NotFoundException, Param, Post, UnauthorizedException } from '@nestjs/common';

import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import {
  assertInternalOpsToken,
  internalOpsTokenMatches,
  INTERNAL_OPS_TOKEN_HEADER
} from '../../lib/internal-ops-auth.js';
import { USER_OVERSEA_SUBSCRIPTION_SCOPE } from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import { remoteExecutionEnvEnabledByDefault } from '../site-slots/remote-ssh-gate.js';
import type {
  CreateServiceAccountInput,
  CreateUserInput,
  ImportUserCenterUsersInput,
  IssueTokenInput,
  PrincipalContextInput,
  SiteSlotAccessAccount,
  SiteSlotSshProfile,
  TokenIntrospectionInput,
  UserH2oRuntimeProfileInput,
  UserCenterUserDeleteInput,
  UserPasswordUpdateInput,
  UserOverseaAccountSyncReport,
  UserOverseaEntitlement,
  UserOverseaEntitlementInput
} from '../../types.js';

const execFileAsync = promisify(execFile);
const USER_OVERSEA_ADMIN_SCOPES = ['site-slot.manage', 'site-slot.execute'];

@Controller()
export class UserCenterController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/user-center/capabilities')
  async capabilities() {
    return {
      authority: 'user-center',
      capabilities: [
        'oauth.authority',
        'local-password.login',
        'local-password.update',
        'user.import',
        'user.delete',
        'user.profile.attributes',
        'jwt.introspection',
        'principal.context',
        'rbac.policy',
        'service-account',
        'oversea.provisioning',
        'h2o.runtime-profile'
      ],
      sdkGateway: await this.store.sdkGatewayManifest()
    };
  }

  @Post('internal/v1/user-center/bootstrap')
  async bootstrap(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { userCenter: await this.store.bootstrapUserCenter() };
  }

  @Get('internal/v1/user-center/roles')
  async roles(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { roles: await this.store.listUserCenterRoles() };
  }

  @Get('internal/v1/user-center/users')
  async users(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { users: await this.store.listUserCenterUsers() };
  }

  @Post('internal/v1/user-center/users')
  async createUser(
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    return { user: await this.store.createUserCenterUser(toCreateUserInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/user-center/users/import')
  async importUsers(
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    return { import: await this.store.importUserCenterUsers(toImportUsersInput(rawBody)) };
  }

  @Post('internal/v1/user-center/users/:userId/password')
  async updateUserPassword(
    @Param('userId') userId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    try {
      return {
        password: await this.store.updateUserCenterPassword(toUserPasswordUpdateInput(userId, asRecord(rawBody)))
      };
    } catch (error) {
      throw userCenterMutationException(error);
    }
  }

  @Delete('internal/v1/user-center/users/:userId')
  async deleteUser(
    @Param('userId') userId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    try {
      return {
        deletion: await this.store.deleteUserCenterUser(toUserDeleteInput(userId, asRecord(rawBody)))
      };
    } catch (error) {
      throw userCenterMutationException(error);
    }
  }

  @Get('internal/v1/user-center/oversea-entitlements')
  async overseaEntitlements(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { entitlements: await this.store.listUserOverseaEntitlements() };
  }

  @Get('internal/v1/user-center/users/:userId/oversea')
  async userOverseaEntitlement(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined
  ) {
    await this.assertUserOrOpsAuthorization(
      userId,
      authorization,
      opsToken,
      USER_OVERSEA_SUBSCRIPTION_SCOPE
    );
    const entitlement = await this.store.getUserOverseaEntitlement(userId);
    return { entitlement };
  }

  @Post('internal/v1/user-center/users/:userId/oversea')
  async upsertUserOverseaEntitlement(
    @Param('userId') userId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    return {
      entitlement: await this.store.upsertUserOverseaEntitlement({
        ...toUserOverseaEntitlementInput(asRecord(rawBody)),
        userId
      })
    };
  }

  @Get('internal/v1/user-center/users/:userId/h2o/runtime-profile')
  async userH2oRuntimeProfile(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined
  ) {
    await this.assertUserOrOpsAuthorization(userId, authorization, opsToken, 'auth.read');
    return { profile: await this.store.getUserH2oRuntimeProfile(userId, 'h2o') };
  }

  @Post('internal/v1/user-center/users/:userId/h2o/runtime-profile')
  async upsertUserH2oRuntimeProfile(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    await this.assertUserOrOpsAuthorization(userId, authorization, opsToken, 'auth.read');
    return {
      profile: await this.store.upsertUserH2oRuntimeProfile({
        ...toUserH2oRuntimeProfileInput(asRecord(rawBody)),
        userId,
        appId: 'h2o'
      })
    };
  }

  @Post('internal/v1/user-center/users/:userId/oversea/ensure-subscription')
  async ensureUserOverseaSubscription(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() rawBody: unknown
  ) {
    await this.assertUserOverseaAuthorization(userId, authorization);
    const body = asRecord(rawBody);
    const requestedBy = nullableString(body.requestedBy) ?? 'user-oversea-ensure';
    const requestId = nullableString(body.requestId) ?? `user-oversea-ensure-${Date.now()}`;
    const entitlement = await this.store.upsertUserOverseaEntitlement({
      ...toUserOverseaEntitlementInput(body),
      userId,
      requestedBy,
      requestId
    });
    const shouldSyncRuntime = booleanValue(body.syncRuntime ?? body.ensureRuntime ?? body.remoteSync) !== false;
    const syncPayload = shouldSyncRuntime
      ? await this.syncUserOverseaRuntimePayload(userId, {
          ...body,
          requestedBy,
          requestId: `${requestId}-sync`
        }, entitlement)
      : {
          sync: {
            status: 'skipped',
            reports: [],
            generatedAt: new Date().toISOString(),
            reason: 'syncRuntime=false'
          },
          entitlement
        };
    const refreshed = syncPayload.entitlement ?? await this.store.getUserOverseaEntitlement(userId);
    const subscription = await this.store.renderUserOverseaMihomoSubscription(userId);
    const activeAccounts = (refreshed?.accounts ?? []).filter((account) => account.status === 'active');
    const unsyncedAccounts = activeAccounts.filter((account) => account.runtimeSync.status !== 'synced');
    const ready = Boolean(subscription)
      && activeAccounts.length > 0
      && unsyncedAccounts.length === 0;
    return {
      ensure: {
        ready,
        status: ready ? 'ready' : subscription ? 'pending-runtime-sync' : 'blocked',
        reason: ready
          ? 'User Oversea subscription is ready.'
          : subscription
            ? `Subscription YAML is renderable, but ${unsyncedAccounts.length} account(s) still require runtime sync.`
            : 'User Oversea subscription could not be rendered.',
        generatedAt: new Date().toISOString()
      },
      entitlement: refreshed,
      sync: syncPayload.sync,
      subscription: subscription ? {
        path: refreshed?.subscriptionPath ?? `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/subscription.yaml`,
        contentType: subscription.contentType,
        generatedAt: subscription.generatedAt,
        yamlBytes: Buffer.byteLength(subscription.yaml, 'utf8'),
        yaml: booleanValue(body.includeYaml) === true ? subscription.yaml : undefined
      } : null
    };
  }

  @Post('internal/v1/user-center/users/:userId/oversea/sync-runtime')
  async syncUserOverseaRuntime(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    await this.assertUserOrOpsAuthorization(
      userId,
      authorization,
      opsToken,
      USER_OVERSEA_SUBSCRIPTION_SCOPE
    );
    return this.syncUserOverseaRuntimePayload(userId, asRecord(rawBody));
  }

  private async syncUserOverseaRuntimePayload(
    userId: string,
    body: Record<string, unknown>,
    seedEntitlement?: UserOverseaEntitlement | null
  ) {
    const requestedBy = nullableString(body.requestedBy) ?? 'desktop-admin';
    const requestId = nullableString(body.requestId) ?? `user-oversea-sync-${Date.now()}`;
    const timeoutSeconds = remoteSyncTimeoutSeconds(body.timeoutSeconds);
    const confirmed = booleanValue(body.confirmRemoteExecution) === true;
    const entitlement = seedEntitlement ?? await this.store.getUserOverseaEntitlement(userId);
    if (!entitlement || entitlement.status !== 'active') {
      throw new NotFoundException('Active user Oversea entitlement not found');
    }
    const siteFilter = new Set(stringArray(body.siteIds));
    const accounts = entitlement.accounts.filter((account) => (
      account.status === 'active'
      && (siteFilter.size === 0 || siteFilter.has(account.siteId))
    ));
    if (accounts.length === 0) {
      const refreshed = await this.store.getUserOverseaEntitlement(userId);
      return {
        sync: {
          status: 'blocked',
          reports: [],
          generatedAt: new Date().toISOString(),
          reason: siteFilter.size
            ? `No active Oversea access account matched requested siteIds: ${[...siteFilter].join(', ')}.`
            : 'No active Oversea access account is available for this user entitlement.'
        },
        entitlement: refreshed
      };
    }
    const profiles = await this.store.listSiteSlotSshProfiles();
    const reports: UserOverseaAccountSyncReport[] = [];
    for (const accountRef of accounts) {
      const account = await this.store.getSiteSlotAccessAccount(accountRef.siteId, accountRef.username);
      const report = await this.syncOneUserOverseaAccount({
        entitlement,
        accountRef,
        account,
        profile: latestByUpdatedAt(profiles.filter((item) => item.kind === 'oversea' && item.siteId === accountRef.siteId && item.status === 'active')),
        confirmed,
        requestedBy,
        requestId,
        timeoutSeconds
      });
      reports.push(report);
    }
    const refreshed = await this.store.getUserOverseaEntitlement(userId);
    return {
      sync: {
        status: reports.some((report) => report.status === 'failed')
          ? 'failed'
          : reports.some((report) => report.status === 'blocked') ? 'blocked' : 'passed',
        reports,
        generatedAt: new Date().toISOString()
      },
      entitlement: refreshed
    };
  }

  /**
   * Public, token-only subscription for third-party clients such as Clash.
   *
   * Kept on its own path rather than adding `?token=` to the Bearer-guarded
   * user-center route: one path, one auth mode is far easier to allowlist safely
   * at the edge, and this URL carries no userId, so it leaks no user directory.
   */
  @Get('internal/v1/oversea-subscriptions/:token.yaml')
  @Header('content-type', 'text/yaml; charset=utf-8')
  @Header('cache-control', 'no-store')
  @Header('referrer-policy', 'no-referrer')
  async publicOverseaSubscription(@Param('token') token: string) {
    const userId = await this.store.resolveUserOverseaSubscriptionLink(String(token ?? ''));
    // A bad, revoked or expired link is indistinguishable from a wrong one on
    // purpose: probing must not reveal whether a token ever existed.
    if (!userId) throw new NotFoundException('Oversea subscription not found');
    const subscription = await this.store.renderUserOverseaMihomoSubscription(userId);
    if (!subscription) throw new NotFoundException('Oversea subscription not found');
    return subscription.yaml;
  }

  /** Issue or rotate the public link. The plaintext token is returned only here. */
  @Post('internal/v1/user-center/users/:userId/oversea/subscription-link')
  async issueOverseaSubscriptionLink(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() rawBody: unknown
  ) {
    await this.assertUserOverseaAuthorization(userId, authorization);
    const body = asRecord(rawBody);
    const issued = await this.store.issueUserOverseaSubscriptionLink(userId, {
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
    return {
      link: {
        path: issued.path,
        token: issued.token,
        tokenId: issued.record.tokenId,
        issuedAt: issued.record.issuedAt,
        expiresAt: issued.record.expiresAt,
        note: 'Copy this URL now; only its metadata is retrievable afterwards.'
      }
    };
  }

  @Delete('internal/v1/user-center/users/:userId/oversea/subscription-link')
  async revokeOverseaSubscriptionLink(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    await this.assertUserOverseaAuthorization(userId, authorization);
    return { revoked: await this.store.revokeUserOverseaSubscriptionLink(userId) };
  }

  @Get('internal/v1/user-center/users/:userId/oversea/subscription-link')
  async describeOverseaSubscriptionLink(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    await this.assertUserOverseaAuthorization(userId, authorization);
    return { link: await this.store.describeUserOverseaSubscriptionLink(userId) };
  }

  @Get('internal/v1/user-center/users/:userId/oversea/subscription.yaml')
  @Header('content-type', 'text/yaml; charset=utf-8')
  async userOverseaSubscription(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    await this.assertUserOverseaAuthorization(userId, authorization);
    const subscription = await this.store.renderUserOverseaMihomoSubscription(userId);
    if (!subscription) throw new NotFoundException('User Oversea subscription not found');
    return subscription.yaml;
  }

  private async assertUserOverseaAuthorization(userId: string, authorization?: string): Promise<void> {
    return this.assertUserAuthorization(userId, authorization, USER_OVERSEA_SUBSCRIPTION_SCOPE);
  }

  private async assertUserOrOpsAuthorization(
    userId: string,
    authorization: string | undefined,
    opsToken: string | undefined,
    requiredScope: string
  ): Promise<void> {
    if (internalOpsTokenMatches(opsToken)) return;
    await this.assertUserAuthorization(userId, authorization, requiredScope);
  }

  private async assertUserAuthorization(
    userId: string,
    authorization: string | undefined,
    requiredScope: string
  ): Promise<void> {
    const token = bearerToken(authorization);
    if (!token) throw new UnauthorizedException('Bearer access token is required');
    if (token.startsWith('mx-shadow-')) throw new UnauthorizedException('Shadow tokens cannot access user Oversea subscriptions');
    const auth = await this.store.introspectToken({
      token,
      audience: 'mx-sdk',
      requestId: `user-oversea-authorize-${userId}`
    });
    if (!auth.active || !auth.principal || (auth.tokenKind !== 'jwt' && auth.tokenKind !== 'service-token')) {
      throw new UnauthorizedException('Bearer access token is not active');
    }
    const scopes = new Set(auth.scopes);
    const adminAllowed = USER_OVERSEA_ADMIN_SCOPES.every((scope) => scopes.has(scope));
    if (adminAllowed) return;
    if (auth.principal.kind !== 'user' || auth.principal.userId !== userId) {
      throw new ForbiddenException('Bearer subject cannot access the requested Oversea user');
    }
    if (!scopes.has(requiredScope)) {
      throw new ForbiddenException(`missing scope: ${requiredScope}`);
    }
  }

  @Get('internal/v1/user-center/service-accounts')
  async serviceAccounts(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return {
      serviceAccounts: await this.store.listUserCenterServiceAccounts(),
      credentials: await this.store.listUserCenterServiceAccountCredentialStatuses()
    };
  }

  @Post('internal/v1/user-center/service-accounts')
  @Header('Cache-Control', 'no-store')
  async createServiceAccount(
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    const input = toCreateServiceAccountInput(asRecord(rawBody));
    const serviceAccount = await this.store.createUserCenterServiceAccount(input);
    const status = await this.store.getUserCenterServiceAccountCredential(serviceAccount.serviceAccountId);
    let credential = null;
    if (!status) {
      try {
        credential = await this.store.issueUserCenterServiceAccountCredential({
          serviceAccountId: serviceAccount.serviceAccountId,
          requestedBy: 'user-center',
          requestId: input.requestId
        });
      } catch (error) {
        if (!serviceAccountCredentialAlreadyExists(error)) throw error;
      }
    }
    return {
      serviceAccount,
      credential
    };
  }

  @Post('internal/v1/user-center/tokens/issue')
  @Header('Cache-Control', 'no-store')
  async issueToken(
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    return { issued: await this.store.issueUserCenterToken(toIssueTokenInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/user-center/token/introspect')
  async introspect(@Body() rawBody: unknown) {
    return { introspection: await this.store.introspectToken(toTokenInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/user-center/principal/resolve')
  async resolvePrincipal(@Body() rawBody: unknown) {
    return { context: await this.store.resolvePrincipalContext(toPrincipalInput(asRecord(rawBody))) };
  }

  private async syncOneUserOverseaAccount(input: {
    entitlement: UserOverseaEntitlement;
    accountRef: UserOverseaEntitlement['accounts'][number];
    account: SiteSlotAccessAccount | null;
    profile: SiteSlotSshProfile | null;
    confirmed: boolean;
    requestedBy: string;
    requestId: string;
    timeoutSeconds: number;
  }): Promise<UserOverseaAccountSyncReport> {
    const account = input.account;
    const accountId = account?.accountId ?? input.accountRef.accountId;
    const username = account?.username ?? input.accountRef.username;
    const gateFailures = [
      ...(!account ? ['Internal access account is missing'] : []),
      ...(account?.status === 'active' ? [] : ['Internal access account is not active']),
      ...(!input.profile ? ['active Oversea SSH profile is required'] : []),
      ...(remoteExecutionEnvEnabledByDefault('SITE_SLOT_WORKER_REMOTE_SSH') ? [] : ['SITE_SLOT_WORKER_REMOTE_SSH=1 is required before remote account sync']),
      ...(input.confirmed ? [] : ['confirmRemoteExecution=true is required']),
      ...(input.profile?.host ? [] : ['SSH host is required']),
      ...(input.profile?.identityFile && !existsSync(input.profile.identityFile) ? [`SSH identity file does not exist: ${input.profile.identityFile}`] : []),
      ...(input.profile?.knownHostsFile && !existsSync(input.profile.knownHostsFile) ? [`SSH known_hosts file does not exist: ${input.profile.knownHostsFile}`] : []),
      ...(input.profile?.sshConfigFile && !existsSync(input.profile.sshConfigFile) ? [`SSH config file does not exist: ${input.profile.sshConfigFile}`] : [])
    ];
    const baseReport = {
      userId: input.entitlement.userId,
      siteId: input.accountRef.siteId,
      accountId,
      username,
      requestedBy: input.requestedBy,
      requestId: input.requestId
    };
    if (gateFailures.length > 0 || !input.profile || !account) {
      return this.store.recordUserOverseaAccountSyncReport({
        ...baseReport,
        status: 'blocked',
        exitCode: null,
        command: null,
        stdout: '',
        stderr: gateFailures.join('\n'),
        diagnosis: { category: 'gate', summary: gateFailures[0] ?? 'Remote sync gate blocked', gateFailures }
      });
    }

    const command = userOverseaAccountSyncCommand(account, '30 Mbps', '30 Mbps');
    const redactedCommand = userOverseaAccountSyncCommand({ ...account, authToken: '<redacted>' }, '30 Mbps', '30 Mbps');
    const startedAt = new Date().toISOString();
    try {
      const { stdout, stderr } = await execFileAsync('ssh', userCenterOverseaSshArgv(input.profile, command), {
        timeout: input.timeoutSeconds * 1000,
        maxBuffer: 4 * 1024 * 1024
      });
      return this.store.recordUserOverseaAccountSyncReport({
        ...baseReport,
        status: 'passed',
        exitCode: 0,
        command: redactedCommand,
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    } catch (error) {
      const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      const diagnosis = sshFailureDiagnosis(execError.stderr ?? execError.message, execError.code) as Record<string, unknown>;
      diagnosis.tcpProbe = await tcpConnectProbe(
        input.profile.host,
        input.profile.sshPort,
        effectiveSshConnectTimeoutSeconds(input.profile.connectTimeoutSeconds)
      );
      return this.store.recordUserOverseaAccountSyncReport({
        ...baseReport,
        status: 'failed',
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        command: redactedCommand,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        diagnosis,
        startedAt,
        finishedAt: new Date().toISOString()
      });
    }
  }
}

export function toTokenInput(body: Record<string, unknown>): TokenIntrospectionInput {
  return {
    token: nullableString(body.token),
    audience: nullableString(body.audience),
    requestId: nullableString(body.requestId)
  };
}

function toCreateUserInput(body: Record<string, unknown>): CreateUserInput {
  return {
    userId: nullableString(body.userId),
    account: nullableString(body.account),
    username: nullableString(body.username) ?? nullableString(body.user_name),
    email: nullableString(body.email),
    displayName: nullableString(body.displayName),
    password: nullableString(body.password),
    roleIds: stringList(body.roleIds),
    orgIds: stringList(body.orgIds),
    status: nullableString(body.status),
    profile: recordOrNull(body.profile),
    attributes: recordOrNull(body.attributes),
    externalIds: stringRecordOrNull(body.externalIds),
    appAccess: recordOrNull(body.appAccess),
    homeAppId: nullableString(body.homeAppId),
    registeredByAppId: nullableString(body.registeredByAppId) ?? nullableString(body.sourceAppId),
    allowedAppIds: stringList(body.allowedAppIds),
    deniedAppIds: stringList(body.deniedAppIds),
    defaultOverseaSiteIds: stringList(body.defaultOverseaSiteIds ?? body.overseaSiteIds ?? body.siteIds),
    provisionOversea: booleanValue(body.provisionOversea ?? body.defaultOverseaAccess),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toImportUsersInput(rawBody: unknown): ImportUserCenterUsersInput {
  const body = asRecord(rawBody);
  const rawUsers = Array.isArray(rawBody) ? rawBody : Array.isArray(body.users) ? body.users : null;
  if (!rawUsers) throw new BadRequestException('users array is required');
  return {
    users: rawUsers.map((item) => asRecord(item)),
    defaultRoleIds: stringList(body.defaultRoleIds ?? body.roleIds),
    defaultOrgIds: stringList(body.defaultOrgIds ?? body.orgIds),
    defaultHomeAppId: nullableString(body.defaultHomeAppId),
    defaultRegisteredByAppId: nullableString(body.defaultRegisteredByAppId) ?? nullableString(body.sourceAppId),
    defaultAllowedAppIds: stringList(body.defaultAllowedAppIds ?? body.allowedAppIds),
    defaultOverseaSiteIds: stringList(body.defaultOverseaSiteIds ?? body.overseaSiteIds ?? body.siteIds),
    provisionOversea: booleanValue(body.provisionOversea ?? body.defaultOverseaAccess),
    requestedBy: nullableString(body.requestedBy) ?? 'user-import',
    requestId: nullableString(body.requestId)
  };
}

function toUserPasswordUpdateInput(userId: string, body: Record<string, unknown>): UserPasswordUpdateInput {
  return {
    userId,
    password: nullableString(body.password),
    requestedBy: nullableString(body.requestedBy) ?? 'user-center-password-update',
    requestId: nullableString(body.requestId)
  };
}

function toUserDeleteInput(userId: string, body: Record<string, unknown>): UserCenterUserDeleteInput {
  return {
    userId,
    requestedBy: nullableString(body.requestedBy) ?? 'user-center-delete',
    requestId: nullableString(body.requestId)
  };
}

function userCenterMutationException(error: unknown): BadRequestException | NotFoundException {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('User not found:')
    ? new NotFoundException(message)
    : new BadRequestException(message);
}

function toUserOverseaEntitlementInput(body: Record<string, unknown>): UserOverseaEntitlementInput {
  return {
    userId: nullableString(body.userId),
    siteIds: body.siteIds === undefined || body.siteIds === null ? null : stringList(body.siteIds),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toUserH2oRuntimeProfileInput(body: Record<string, unknown>): UserH2oRuntimeProfileInput {
  return {
    userId: nullableString(body.userId),
    appId: nullableString(body.appId),
    mode: nullableString(body.mode),
    activeSubscriptionId: nullableString(body.activeSubscriptionId),
    activeSubscription: recordOrNull(body.activeSubscription),
    subscriptions: Array.isArray(body.subscriptions) ? body.subscriptions.map((item) => asRecord(item)) : null,
    ports: numberRecordOrNull(body.ports),
    rules: Array.isArray(body.rules) ? body.rules.map((item) => asRecord(item)) : null,
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toCreateServiceAccountInput(body: Record<string, unknown>): CreateServiceAccountInput {
  return {
    serviceAccountId: nullableString(body.serviceAccountId),
    displayName: nullableString(body.displayName),
    roleIds: stringArray(body.roleIds),
    scopes: stringArray(body.scopes),
    allowedProductIds: stringArray(body.allowedProductIds),
    requestId: nullableString(body.requestId)
  };
}

function toIssueTokenInput(body: Record<string, unknown>): IssueTokenInput {
  const subjectKind = nullableString(body.subjectKind);
  return {
    subjectKind: subjectKind === 'user' ? 'user' : 'service-account',
    subjectId: nullableString(body.subjectId) ?? 'svc_sdk_gateway',
    audience: nullableString(body.audience),
    scopes: stringArray(body.scopes),
    ttlSeconds: numberValue(body.ttlSeconds),
    requestId: nullableString(body.requestId)
  };
}

function serviceAccountCredentialAlreadyExists(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes('credential already exists');
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  }
  return null;
}

function stringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/)
      : [];
  return [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))];
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringRecordOrNull(value: unknown): Record<string, string> | null {
  const record = recordOrNull(value);
  if (!record) return null;
  const entries = Object.entries(record)
    .map(([key, raw]) => [key, typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw)])
    .filter(([, text]) => text);
  return Object.fromEntries(entries) as Record<string, string>;
}

function numberRecordOrNull(value: unknown): Record<string, number> | null {
  const record = recordOrNull(value);
  if (!record) return null;
  const entries = Object.entries(record)
    .map(([key, raw]) => [key, typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN] as const)
    .filter(([key, number]) => key && Number.isFinite(number));
  return Object.fromEntries(entries) as Record<string, number>;
}

function remoteSyncTimeoutSeconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : 180;
  return Number.isFinite(raw) ? Math.max(10, Math.min(Math.floor(raw), 600)) : 180;
}

function userOverseaAccountSyncCommand(account: SiteSlotAccessAccount, upRate: string, downRate: string): string {
  return [
    'set -eu',
    'echo "mx-user-oversea-account-sync"',
    `echo ${shellQuote(`site=${account.siteId}`)}`,
    `echo ${shellQuote(`account=${account.username}`)}`,
    'cd /opt/mx/current/hysteria2-access-stack 2>/dev/null || cd /opt/mx/releases/oversea-access-stack 2>/dev/null || { echo "access stack missing; run full Sync Remote once before per-user sync"; exit 2; }',
    'grep -q -- "--auth|--auth-token" ./manage.sh || { echo "legacy access stack artifact; run full Sync Remote once before per-user sync"; exit 3; }',
    `./manage.sh add-user --names ${shellQuote(account.username)} --auth-token ${shellQuote(account.authToken)} --up-ceil ${shellQuote(upRate)} --down-ceil ${shellQuote(downRate)}`,
    `runtime_auth="$(awk -F, -v name=${shellQuote(account.username)} '$1 == name { print $2 }' data/hysteria/users.csv)"`,
    'if [ -z "$runtime_auth" ]; then echo "runtime-user auth material missing"; exit 4; fi',
    'if ! docker inspect -f "{{.State.Running}}" mx-oversea-hysteria2 >/dev/null 2>&1; then ./manage.sh start hysteria; fi',
    `runtime_user="$(docker exec mx-oversea-hysteria2 /etc/hysteria/auth.sh 1.2.3.4:1234 "$runtime_auth" 1000 2>/dev/null || true)"`,
    `if [ "$runtime_user" != ${shellQuote(account.username)} ]; then echo "runtime-user account material drift; recreating hysteria"; ./manage.sh start hysteria; runtime_user="$(docker exec mx-oversea-hysteria2 /etc/hysteria/auth.sh 1.2.3.4:1234 "$runtime_auth" 1000 2>/dev/null || true)"; fi`,
    `if [ "$runtime_user" != ${shellQuote(account.username)} ]; then echo "runtime-user auth failed after recreate"; exit 5; fi`,
    `./manage.sh list-users | awk -v name=${shellQuote(account.username)} '$1 == name { print "runtime-user " $1 " " $2 " " $3; found = 1 } END { exit(found ? 0 : 4) }'`
  ].join('; ');
}

function userCenterOverseaSshArgv(profile: SiteSlotSshProfile, command: string): string[] {
  const connectTimeoutSeconds = effectiveSshConnectTimeoutSeconds(profile.connectTimeoutSeconds);
  const args = [
    '-F', internalSshConfigFile(profile),
    '-o', `BatchMode=${profile.batchMode ?? 'yes'}`,
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o', 'ConnectionAttempts=2',
    '-o', 'AddressFamily=inet',
    '-o', 'IPQoS=none',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', `StrictHostKeyChecking=${profile.strictHostKeyChecking ?? 'yes'}`
  ];
  if (internalSshUsesDefaultIsolatedConfig(profile)) {
    args.push('-o', 'ProxyCommand=none', '-o', 'ProxyJump=none');
  }
  if (profile.identityFile) args.push('-i', profile.identityFile);
  if (profile.knownHostsFile) args.push('-o', `UserKnownHostsFile=${profile.knownHostsFile}`);
  if (profile.hostKeyAlias) {
    args.push('-o', `HostKeyAlias=${profile.hostKeyAlias}`);
    args.push('-o', 'CheckHostIP=no');
  }
  args.push('-p', String(profile.sshPort ?? 22), `${profile.sshUser ?? 'root'}@${profile.host ?? '<host>'}`, command);
  return args;
}

function bearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function internalSshConfigFile(profile?: SiteSlotSshProfile | null): string {
  return profile?.sshConfigFile?.trim()
    || process.env.MX_SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || process.env.SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || '/dev/null';
}

function internalSshUsesDefaultIsolatedConfig(profile?: SiteSlotSshProfile | null): boolean {
  return !profile?.sshConfigFile && !process.env.MX_SITE_SLOT_SSH_CONFIG_FILE && !process.env.SITE_SLOT_SSH_CONFIG_FILE;
}

function latestByUpdatedAt<T extends { updatedAt?: string | null }>(items: T[]): T | null {
  return [...items].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0] ?? null;
}

function effectiveSshConnectTimeoutSeconds(value: number | null | undefined): number {
  return Math.max(5, Math.min(Number(value ?? 10), 30));
}

function sshFailureDiagnosis(stderr: unknown, exitCode: unknown) {
  const text = String(stderr ?? '');
  const lower = text.toLowerCase();
  let category = 'unknown';
  let summary = 'SSH command failed';
  const nextActions = ['check-user-oversea-sync-report', 'check-ssh-profile-and-host-firewall'];
  if (lower.includes('connection timed out during banner exchange')) {
    category = 'ssh-banner-timeout';
    summary = 'TCP may be reachable, but SSH did not complete banner exchange before timeout';
    nextActions.push('verify-server-sshd-and-proxy-tun-path');
  } else if (lower.includes('connection timed out') || lower.includes('operation timed out')) {
    category = 'tcp-timeout';
    summary = 'TCP connection to SSH port timed out';
    nextActions.push('verify-port-22-firewall-security-group-or-local-tun-route');
  } else if (lower.includes('no route to host') || lower.includes('network is unreachable')) {
    category = 'network-unreachable';
    summary = 'Internal runner cannot route to the SSH host';
    nextActions.push('check-clash-tun-routing-or-k8s-node-egress');
  } else if (lower.includes('host key verification failed') || lower.includes('no ed25519 host key is known')) {
    category = 'host-key';
    summary = 'Host key verification failed';
    nextActions.push('rerun-bootstrap-key-or-refresh-known-hosts');
  } else if (lower.includes('permission denied')) {
    category = 'auth';
    summary = 'SSH authentication failed';
    nextActions.push('rotate-or-bootstrap-internal-managed-key');
  } else if (typeof exitCode === 'number' && exitCode !== 255) {
    category = 'remote-command';
    summary = 'SSH connected, but the remote command failed';
    nextActions.push('inspect-step-command-output');
  }
  return {
    category,
    summary,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    stderr: text.trim().slice(0, 1000),
    nextActions: Array.from(new Set(nextActions))
  };
}

function tcpConnectProbe(host: string | null | undefined, port: number | null | undefined, timeoutSeconds: number | null | undefined) {
  return new Promise((resolveProbe) => {
    if (!host) {
      resolveProbe({
        status: 'blocked',
        host: null,
        port: port ?? null,
        durationMs: 0,
        message: 'SSH host is not configured'
      });
      return;
    }
    const started = Date.now();
    const socket = netConnect({ host, port: Number(port || 22) });
    let settled = false;
    const finish = (status: string, message: string | null = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({
        status,
        host,
        port: Number(port || 22),
        durationMs: Date.now() - started,
        message
      });
    };
    socket.setTimeout(Math.max(1000, Math.min(Number(timeoutSeconds || 10) * 1000, 30000)));
    socket.once('connect', () => finish('passed'));
    socket.once('timeout', () => finish('timeout', 'TCP connect timed out'));
    socket.once('error', (error) => finish('failed', error.message));
  });
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function toPrincipalInput(body: Record<string, unknown>): PrincipalContextInput {
  return {
    token: nullableString(body.token),
    audience: nullableString(body.audience),
    userId: nullableString(body.userId),
    anonymousPrincipalId: nullableString(body.anonymousPrincipalId),
    serviceAccountId: nullableString(body.serviceAccountId),
    installId: nullableString(body.installId),
    requestId: nullableString(body.requestId)
  };
}
