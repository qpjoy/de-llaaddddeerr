import { createHash, randomUUID } from 'node:crypto';

import {
  builtinAppCenterApps,
  builtinDnsPolicies,
  builtinDnsReverseProxyRoutes,
  createConfigSnapshot,
  createSdkGatewayManifest,
  evaluateDnsPolicy,
  introspectShadowToken,
  normalizeTestStatus,
  normalizeUpdatePolicy,
  releasePolicyByKind,
  resolvePrincipalContext,
  required
} from './domain.js';
import type { PlatformStore } from './platform-store.js';
import type {
  AnonymousEnrollment,
  AnonymousEnrollmentRequest,
  AppCenterApp,
  AuditEvent,
  AuditEventInput,
  ConfigSnapshot,
  DnsPolicy,
  DnsQueryInput,
  DnsResolutionDecision,
  DnsReverseProxyRoute,
  IdentityLinkRequest,
  LauncherNetworkSnapshot,
  LauncherNetworkSnapshotInput,
  LogEntryInput,
  PermissionGrant,
  PermissionRequestInput,
  PrincipalContext,
  PrincipalContextInput,
  PlatformKernelSmokeResult,
  ReleasePolicyDecision,
  ReleasePolicyInput,
  ReleaseReportInput,
  ReleaseTask,
  RuntimeConfig,
  SdkGatewayManifest,
  SiteRole,
  SiteHeartbeat,
  TestGateInput,
  TestGateVerdict,
  TokenIntrospectionInput,
  TokenIntrospectionResult,
  TestRun,
  TestRunInput,
  TestStep,
  TestStepInput
} from '../types.js';

export class MemoryStore implements PlatformStore {
  private readonly sites = new Map<string, SiteHeartbeat>();
  private readonly enrollments = new Map<string, AnonymousEnrollment>();
  private readonly snapshots = new Map<string, ConfigSnapshot>();
  private readonly tasks = new Map<string, ReleaseTask[]>();
  private readonly appCatalog = new Map<string, AppCenterApp>();
  private readonly dnsPolicies = new Map<string, DnsPolicy>();
  private readonly dnsReverseProxyRoutes = new Map<string, DnsReverseProxyRoute>();
  private readonly permissionGrants = new Map<string, PermissionGrant>();
  private readonly testRuns = new Map<string, TestRun>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly logs: LogEntryInput[] = [];
  private nextOverlayHost = 20;
  private nextGuestHost = 20;
  private nextUserHost = 20;

  constructor(private readonly config: RuntimeConfig) {
    this.registerBuiltinApps();
    this.registerBuiltinDns();
  }

  overview() {
    return {
      environment: this.config.environment,
      siteId: this.config.siteId,
      siteRole: this.config.siteRole,
      enabledModules: this.config.enabledModules,
      storeDriver: this.config.storeDriver,
      sites: this.sites.size,
      enrollments: this.enrollments.size,
      snapshots: this.snapshots.size,
      appCenterApps: this.appCatalog.size,
      dnsPolicies: this.dnsPolicies.size,
      dnsReverseProxyRoutes: this.dnsReverseProxyRoutes.size,
      permissionGrants: this.permissionGrants.size,
      testRuns: this.testRuns.size,
      auditEvents: this.auditEvents.length,
      logs: this.logs.length
    };
  }

  upsertSiteHeartbeat(
    heartbeat: Omit<SiteHeartbeat, 'environment' | 'lastSeenAt' | 'siteRole'> & { siteRole?: SiteRole }
  ): SiteHeartbeat {
    const row: SiteHeartbeat = {
      ...heartbeat,
      environment: this.config.environment,
      siteRole: heartbeat.siteRole ?? this.config.siteRole,
      lastSeenAt: new Date().toISOString()
    };
    this.sites.set(row.siteId, row);
    return row;
  }

  listSites(): SiteHeartbeat[] {
    return [...this.sites.values()].sort((a, b) => a.siteId.localeCompare(b.siteId));
  }

  enrollAnonymous(input: AnonymousEnrollmentRequest): {
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
  } {
    const now = new Date().toISOString();
    const installId = input.installId?.trim() || `inst_${randomUUID()}`;
    const deviceId = input.deviceId?.trim() || `dev_${randomUUID()}`;
    const productId = input.productId?.trim() || 'hdo';
    const siteId = input.siteId?.trim() || 'domestic-main';
    const enrollment: AnonymousEnrollment = {
      anonymousPrincipalId: `anon_${randomUUID()}`,
      installId,
      deviceId,
      productId,
      siteId,
      environment: this.config.environment,
      overlayIp: this.allocateOverlayIp(),
      relayMode: input.relayMode?.trim() || 'h2i',
      createdAt: now,
      userId: null
    };
    this.enrollments.set(installId, enrollment);
    const snapshot = this.createSnapshot(enrollment, 1, 'visitor');
    this.snapshots.set(installId, snapshot);
    this.recordAudit({
      eventType: 'enrollment.anonymous.created',
      actorKind: 'anonymous_install',
      anonymousPrincipalId: enrollment.anonymousPrincipalId,
      installId,
      deviceId,
      productId,
      siteId,
      requestId: input.requestId ?? null,
      overlayIp: enrollment.overlayIp,
      configSnapshotId: snapshot.snapshotId,
      metadata: {
        platform: input.platform ?? null,
        deviceLabel: input.deviceLabel ?? null,
        hasPublicKey: Boolean(input.publicKey)
      }
    });
    return { enrollment, snapshot };
  }

  linkIdentity(input: IdentityLinkRequest): {
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
    auditEvent: AuditEvent;
  } {
    const enrollment = this.enrollments.get(input.installId);
    if (!enrollment) {
      throw new Error(`Unknown installId: ${input.installId}`);
    }
    enrollment.userId = input.userId;
    const previous = this.snapshots.get(input.installId);
    const nextVersion = (previous?.version ?? 1) + 1;
    const snapshot = this.createSnapshot(enrollment, nextVersion, 'employee');
    this.snapshots.set(input.installId, snapshot);
    const auditEvent = this.recordAudit({
      eventType: 'identity.linked',
      actorKind: 'user',
      userId: input.userId,
      anonymousPrincipalId: enrollment.anonymousPrincipalId,
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      productId: enrollment.productId,
      siteId: enrollment.siteId,
      requestId: input.requestId ?? null,
      overlayIp: enrollment.overlayIp,
      configSnapshotId: snapshot.snapshotId,
      metadata: {
        authProvider: input.authProvider ?? 'local'
      }
    });
    return { enrollment, snapshot, auditEvent };
  }

  introspectToken(input: TokenIntrospectionInput): TokenIntrospectionResult {
    const result = introspectShadowToken(this.config, input);
    this.recordAudit({
      eventType: 'auth.token.introspected',
      actorKind: result.principal?.kind ?? 'unknown',
      userId: result.principal?.userId ?? null,
      anonymousPrincipalId: result.principal?.anonymousPrincipalId ?? null,
      requestId: input.requestId ?? null,
      metadata: {
        active: result.active,
        audience: result.audience,
        subject: result.subject,
        tokenKind: result.tokenKind,
        reason: result.reason
      }
    });
    return result;
  }

  resolvePrincipalContext(input: PrincipalContextInput): PrincipalContext {
    const enrollment = input.installId ? this.enrollments.get(input.installId) ?? null : null;
    const context = resolvePrincipalContext(this.config, input, enrollment);
    this.recordAudit({
      eventType: 'identity.context.resolved',
      actorKind: context.principal.kind,
      userId: context.principal.userId,
      anonymousPrincipalId: context.principal.anonymousPrincipalId,
      installId: context.bindings.installId,
      deviceId: context.bindings.deviceId,
      requestId: input.requestId ?? null,
      metadata: {
        source: context.source,
        active: context.auth.active,
        canUseSdkGateway: context.gateway.canUseSdkGateway,
        allowedRoutes: context.gateway.allowedRoutes
      }
    });
    return context;
  }

  sdkGatewayManifest(): SdkGatewayManifest {
    return createSdkGatewayManifest(this.config);
  }

  getSnapshot(installId: string): ConfigSnapshot | null {
    return this.snapshots.get(installId) ?? null;
  }

  listTasks(installId: string): ReleaseTask[] {
    return this.tasks.get(installId) ?? [];
  }

  recordReleaseReport(input: ReleaseReportInput): AuditEvent {
    return this.recordAudit({
      eventType: 'release.report.received',
      actorKind: 'install',
      installId: input.installId ?? null,
      requestId: input.taskId ?? null,
      metadata: {
        status: input.status ?? 'unknown',
        error: input.error ?? null,
        ...input.metadata
      }
    });
  }

  recordAudit(input: AuditEventInput): AuditEvent {
    const row: AuditEvent = {
      eventId: `aud_${randomUUID()}`,
      eventType: input.eventType ?? 'unknown',
      actorKind: input.actorKind ?? 'system',
      userId: input.userId ?? null,
      anonymousPrincipalId: input.anonymousPrincipalId ?? null,
      installId: input.installId ?? null,
      deviceId: input.deviceId ?? null,
      productId: input.productId ?? null,
      siteId: input.siteId ?? this.config.siteId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      overlayIp: input.overlayIp ?? null,
      configSnapshotId: input.configSnapshotId ?? null,
      environment: this.config.environment,
      metadata: input.metadata ?? null,
      createdAt: new Date().toISOString()
    };
    this.auditEvents.push(row);
    return row;
  }

  recordLogs(entries: LogEntryInput[]): { accepted: number; sinks: RuntimeConfig['observabilitySinks'] } {
    this.logs.push(...entries);
    return {
      accepted: entries.length,
      sinks: this.config.observabilitySinks
    };
  }

  observabilitySinks(): RuntimeConfig['observabilitySinks'] {
    return this.config.observabilitySinks;
  }

  listAppCenterApps(): AppCenterApp[] {
    return [...this.appCatalog.values()].sort((a, b) => a.appId.localeCompare(b.appId));
  }

  getAppCenterApp(appId: string): AppCenterApp | null {
    return this.appCatalog.get(appId) ?? null;
  }

  listDnsPolicies(): DnsPolicy[] {
    return [...this.dnsPolicies.values()].sort((a, b) => b.priority - a.priority);
  }

  getEffectiveDnsPolicy(appId?: string | null): DnsPolicy {
    const policies = this.listDnsPolicies()
      .filter((policy) => policy.enabled)
      .filter((policy) => !appId || policy.owners.includes(appId) || policy.owners.includes('sdk-gateway'));
    return required(policies[0] ?? null, 'effective DNS policy is registered');
  }

  evaluateDnsQuery(input: DnsQueryInput): DnsResolutionDecision {
    const policy = this.getEffectiveDnsPolicy(input.appId);
    const decision = evaluateDnsPolicy(policy, this.listDnsReverseProxyRoutes(), input);
    this.recordAudit({
      eventType: 'dns.query.evaluated',
      actorKind: input.appId ? 'app' : 'sdk-gateway',
      userId: input.userId ?? null,
      installId: input.installId ?? null,
      productId: input.appId ?? null,
      requestId: input.requestId ?? null,
      metadata: {
        domain: decision.normalizedDomain,
        route: decision.route,
        resolver: decision.resolver,
        matched: decision.matched,
        reverseProxyRouteId: decision.reverseProxyRoute?.routeId ?? null
      }
    });
    return decision;
  }

  listDnsReverseProxyRoutes(): DnsReverseProxyRoute[] {
    return [...this.dnsReverseProxyRoutes.values()].sort((a, b) => a.host.localeCompare(b.host));
  }

  requestPermission(input: PermissionRequestInput): PermissionGrant {
    const app = this.appCatalog.get(input.appId);
    const requestedScopes = input.scopes.length > 0 ? input.scopes : [];
    const allowedScopes = app
      ? requestedScopes.filter((scope) => app.permissions.includes(scope))
      : [];
    const deniedScopes = requestedScopes.filter((scope) => !allowedScopes.includes(scope));
    const decision: PermissionGrant['decision'] =
      allowedScopes.length === 0 ? 'denied' : deniedScopes.length === 0 ? 'granted' : 'partial';
    const grant: PermissionGrant = {
      grantId: `grant_${randomUUID()}`,
      appId: input.appId,
      scopes: requestedScopes,
      allowedScopes,
      deniedScopes,
      decision,
      requestedBy: input.requestedBy,
      installId: input.installId ?? null,
      userId: input.userId ?? null,
      createdAt: new Date().toISOString()
    };
    this.permissionGrants.set(grant.grantId, grant);
    this.recordAudit({
      eventType: 'permission.request.evaluated',
      actorKind: 'app-center',
      userId: input.userId ?? null,
      installId: input.installId ?? null,
      productId: input.appId,
      requestId: input.requestId ?? null,
      metadata: {
        decision,
        scopes: requestedScopes,
        allowedScopes,
        deniedScopes,
        requestedBy: input.requestedBy
      }
    });
    return grant;
  }

  createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): LauncherNetworkSnapshot {
    const mode = input.userId ? 'user' : 'guest';
    const leaseIp = mode === 'user' ? this.allocateUserLeaseIp() : this.allocateGuestLeaseIp();
    const issuedAt = new Date().toISOString();
    const unsigned = {
      environment: this.config.environment,
      appId: input.appId ?? 'h2o',
      installId: input.installId ?? `inst_${randomUUID()}`,
      deviceId: input.deviceId ?? `dev_${randomUUID()}`,
      userId: input.userId ?? null,
      mode,
      leaseIp,
      issuedAt
    };
    const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    const snapshot: LauncherNetworkSnapshot = {
      snapshotId: `lnsnap_${randomUUID()}`,
      environment: unsigned.environment,
      appId: unsigned.appId,
      installId: unsigned.installId,
      deviceId: unsigned.deviceId,
      userId: unsigned.userId,
      mode,
      overlayPolicy: {
        cidr: mode === 'user' ? '100.89.0.0/16' : '100.91.0.0/16',
        leaseIp,
        relayMode: 'h2i'
      },
      capabilities: {
        wireGuard: true,
        splitDns: true,
        pac: true,
        tun: true,
        systemProxy: true
      },
      dns: {
        authority: 'internal-coredns',
        matchDomains: ['internal.mx', 'corp.mx', 'h2i.mx'],
        fallback: 'system'
      },
      pac: {
        priority: ['launcher-network', 'app-center-policy', 'system-proxy', 'h2o', 'direct']
      },
      signatures: {
        algorithm: 'sha256-dev-digest',
        digest,
        issuer: 'mx-launcher-network-shadow'
      },
      issuedAt
    };
    this.recordAudit({
      eventType: 'launcher-network.snapshot.issued',
      actorKind: 'install',
      userId: snapshot.userId,
      installId: snapshot.installId,
      deviceId: snapshot.deviceId,
      productId: snapshot.appId,
      requestId: input.requestId ?? null,
      overlayIp: snapshot.overlayPolicy.leaseIp,
      metadata: {
        mode: snapshot.mode,
        cidr: snapshot.overlayPolicy.cidr,
        capabilities: snapshot.capabilities
      }
    });
    return snapshot;
  }

  evaluateReleaseUpdate(input: ReleasePolicyInput): ReleasePolicyDecision {
    const componentKind = normalizeUpdatePolicy(input.componentKind);
    const updateAvailable = input.currentVersion !== input.targetVersion;
    if (!updateAvailable) {
      return {
        componentKind,
        componentId: input.componentId,
        currentVersion: input.currentVersion,
        targetVersion: input.targetVersion,
        updateAvailable: false,
        updateMode: 'none',
        canSkip: true,
        canDefer: true,
        requiresGate: false,
        rollbackRequired: false,
        reason: 'component is already at target version'
      };
    }

    const policy = releasePolicyByKind(componentKind);
    return {
      componentKind,
      componentId: input.componentId,
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion,
      updateAvailable: true,
      ...policy
    };
  }

  createTestRun(input: TestRunInput): TestRun {
    const now = new Date().toISOString();
    const run: TestRun = {
      testRunId: `trun_${randomUUID()}`,
      suiteId: input.suiteId,
      productId: input.productId,
      environment: this.config.environment,
      topology: input.topology,
      sites: input.sites.length > 0 ? input.sites : ['domestic-main', 'internal-main'],
      releaseId: input.releaseId ?? null,
      configSnapshotId: input.configSnapshotId ?? null,
      installId: input.installId ?? null,
      deviceId: input.deviceId ?? null,
      traceId: `trace_${randomUUID()}`,
      state: 'running',
      steps: [],
      startedAt: now,
      finishedAt: null
    };
    this.testRuns.set(run.testRunId, run);
    this.recordAudit({
      eventType: 'test.run.created',
      actorKind: 'test-center',
      installId: run.installId,
      deviceId: run.deviceId,
      productId: run.productId,
      traceId: run.traceId,
      metadata: {
        suiteId: run.suiteId,
        topology: run.topology,
        releaseId: run.releaseId
      }
    });
    return run;
  }

  getTestRun(runId: string): TestRun | null {
    return this.testRuns.get(runId) ?? null;
  }

  recordTestStep(runId: string, input: TestStepInput): TestRun {
    const run = this.testRuns.get(runId);
    if (!run) throw new Error(`Unknown testRunId: ${runId}`);
    const status = normalizeTestStatus(input.status);
    const step: TestStep = {
      stepId: `tstep_${randomUUID()}`,
      caseId: input.caseId,
      status,
      message: input.message ?? null,
      evidence: input.evidence ?? {},
      createdAt: new Date().toISOString()
    };
    run.steps.push(step);
    if (status === 'failed') {
      run.state = 'failed';
      run.finishedAt = step.createdAt;
    } else if (status === 'blocked') {
      run.state = 'blocked';
      run.finishedAt = step.createdAt;
    } else if (run.steps.length > 0 && run.steps.every((item) => item.status === 'passed')) {
      run.state = 'passed';
      run.finishedAt = step.createdAt;
    }
    this.recordAudit({
      eventType: 'test.step.recorded',
      actorKind: 'test-center',
      installId: run.installId,
      deviceId: run.deviceId,
      productId: run.productId,
      traceId: run.traceId,
      metadata: {
        testRunId: run.testRunId,
        caseId: step.caseId,
        status: step.status
      }
    });
    return run;
  }

  evaluateTestGate(input: TestGateInput): TestGateVerdict {
    const runs = input.runIds.map((runId) => this.testRuns.get(runId)).filter((run): run is TestRun => Boolean(run));
    const missingRuns = input.runIds.length - runs.length;
    const evaluatedAt = new Date().toISOString();
    let verdict: TestGateVerdict['verdict'] = 'passed';
    let reason = 'all required runs passed';
    if (input.runIds.length === 0 || missingRuns > 0) {
      verdict = 'blocked';
      reason = 'required test runs are missing';
    } else if (runs.some((run) => run.state === 'failed')) {
      verdict = 'failed';
      reason = 'at least one required run failed';
    } else if (runs.some((run) => run.state === 'blocked' || run.state === 'running')) {
      verdict = 'blocked';
      reason = 'at least one required run is not complete';
    }
    const gate: TestGateVerdict = {
      gateId: input.gateId,
      releaseId: input.releaseId,
      verdict,
      requiredRuns: input.runIds,
      evaluatedAt,
      reason
    };
    this.recordAudit({
      eventType: 'test.gate.evaluated',
      actorKind: 'test-center',
      requestId: input.gateId,
      metadata: {
        gateId: gate.gateId,
        releaseId: gate.releaseId,
        verdict: gate.verdict,
        requiredRuns: gate.requiredRuns,
        evaluatedAt: gate.evaluatedAt,
        reason: gate.reason
      }
    });
    return gate;
  }

  runPlatformKernelSmoke(): PlatformKernelSmokeResult {
    const checks: string[] = [];
    const app = required(this.getAppCenterApp('h2o'), 'h2o app is registered');
    checks.push('OK app h2o registered');
    const { enrollment } = this.enrollAnonymous({
      productId: 'h2o',
      platform: 'darwin',
      requestId: 'smoke-enroll'
    });
    checks.push('OK anonymous install enrolled');
    const principalContext = this.resolvePrincipalContext({
      installId: enrollment.installId,
      requestId: 'smoke-principal-context'
    });
    if (principalContext.principal.kind !== 'anonymous' || !principalContext.gateway.canUseSdkGateway) {
      throw new Error('anonymous install principal context was not resolved');
    }
    checks.push('OK User Center principal context resolved');
    const sdkIntrospection = this.introspectToken({
      token: 'mx-shadow-service:sdk-gateway',
      audience: 'mx-sdk',
      requestId: 'smoke-sdk-introspection'
    });
    if (!sdkIntrospection.active || sdkIntrospection.principal?.kind !== 'service-account') {
      throw new Error('SDK Gateway service token was not accepted');
    }
    checks.push('OK SDK Gateway service token introspected');
    const sdkGateway = this.sdkGatewayManifest();
    if (!sdkGateway.routes.some((route) => route.routeId === 'sdk.identity.introspect')) {
      throw new Error('SDK Gateway manifest did not expose identity introspection');
    }
    checks.push('OK SDK Gateway manifest published');
    const networkSnapshot = this.createLauncherNetworkSnapshot({
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      appId: 'h2o',
      requestId: 'smoke-network'
    });
    if (networkSnapshot.overlayPolicy.cidr !== '100.91.0.0/16') {
      throw new Error('guest network snapshot did not use 100.91.0.0/16');
    }
    checks.push('OK guest network snapshot issued');
    const permissionGrant = this.requestPermission({
      appId: 'h2o',
      installId: enrollment.installId,
      scopes: ['network.proxy.app'],
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-permission'
    });
    if (permissionGrant.decision !== 'granted') {
      throw new Error('h2o permission was not granted');
    }
    checks.push('OK h2o permission granted');
    const testRun = this.createTestRun({
      suiteId: 'hdo-shadow-e2e',
      productId: 'h2o',
      topology: 'h-d-i-shadow',
      sites: ['domestic-main', 'internal-main'],
      releaseId: 'rel_smoke',
      installId: enrollment.installId,
      deviceId: enrollment.deviceId
    });
    const completedRun = this.recordTestStep(testRun.testRunId, {
      caseId: 'platform-kernel',
      status: 'passed',
      evidence: { source: 'memory-smoke' }
    });
    checks.push('OK e2e test run passed');
    const gate = this.evaluateTestGate({
      gateId: 'gate_platform_kernel',
      releaseId: 'rel_smoke',
      runIds: [completedRun.testRunId]
    });
    if (gate.verdict !== 'passed') {
      throw new Error('release gate did not pass');
    }
    checks.push('OK release gate passed');
    const launcherUpdate = this.evaluateReleaseUpdate({
      componentKind: 'platform-critical',
      componentId: 'launcher-network',
      currentVersion: '0.1.0',
      targetVersion: '0.1.1',
      channel: 'shadow',
      installId: enrollment.installId
    });
    if (launcherUpdate.updateMode !== 'mandatory') {
      throw new Error('launcher-network update was not mandatory');
    }
    checks.push('OK launcher update mandatory');
    const h2oUpdate = this.evaluateReleaseUpdate({
      componentKind: 'app-managed',
      componentId: 'h2o',
      currentVersion: '0.1.0',
      targetVersion: '0.1.1',
      channel: 'shadow',
      installId: enrollment.installId
    });
    if (!h2oUpdate.canSkip) {
      throw new Error('h2o update was not skippable');
    }
    checks.push('OK h2o update skippable');
    const dnsPolicy = this.getEffectiveDnsPolicy('h2o');
    checks.push('OK split DNS policy registered');
    const dnsDecision = this.evaluateDnsQuery({
      domain: 'gateway.internal.mx',
      appId: 'h2o',
      installId: enrollment.installId,
      requestId: 'smoke-dns'
    });
    if (dnsDecision.route !== 'internal-dns' || !dnsDecision.reverseProxyRoute) {
      throw new Error('split DNS did not route gateway.internal.mx to Internal reverse proxy');
    }
    checks.push('OK split DNS internal reverse proxy decision');
    return {
      ok: true,
      checks,
      app,
      enrollment,
      principalContext,
      sdkIntrospection,
      sdkGateway,
      networkSnapshot,
      permissionGrant,
      testRun: completedRun,
      gate,
      launcherUpdate,
      h2oUpdate,
      dnsPolicy,
      dnsDecision
    };
  }

  private allocateOverlayIp(): string {
    const host = this.nextOverlayHost;
    this.nextOverlayHost += 1;
    return `10.70.0.${host}`;
  }

  private allocateGuestLeaseIp(): string {
    const host = this.nextGuestHost;
    this.nextGuestHost += 1;
    return `100.91.0.${host}`;
  }

  private allocateUserLeaseIp(): string {
    const host = this.nextUserHost;
    this.nextUserHost += 1;
    return `100.89.0.${host}`;
  }

  private registerBuiltinApps(): void {
    for (const app of builtinAppCenterApps()) {
      this.appCatalog.set(app.appId, app);
    }
  }

  private registerBuiltinDns(): void {
    for (const policy of builtinDnsPolicies(this.config)) {
      this.dnsPolicies.set(policy.policyId, policy);
    }
    for (const route of builtinDnsReverseProxyRoutes(this.config)) {
      this.dnsReverseProxyRoutes.set(route.routeId, route);
    }
  }

  private createSnapshot(
    enrollment: AnonymousEnrollment,
    version: number,
    defaultMode: 'visitor' | 'employee'
  ): ConfigSnapshot {
    return createConfigSnapshot(this.config, enrollment, `cfgsnap_${randomUUID()}`, version, defaultMode);
  }
}
