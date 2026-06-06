import { createHash, randomUUID } from 'node:crypto';

import type { DataSource, Repository } from 'typeorm';

import { createPlatformDataSource } from '../db/data-source.js';
import { PlatformRecordEntity, type PlatformRecordRow } from '../db/entities.js';
import type {
  AnonymousEnrollment,
  AnonymousEnrollmentRequest,
  AppCenterApp,
  AuditEvent,
  AuditEventInput,
  ConfigSnapshot,
  IdentityLinkRequest,
  LauncherNetworkSnapshot,
  LauncherNetworkSnapshotInput,
  LogEntryInput,
  PermissionGrant,
  PermissionRequestInput,
  PlatformKernelSmokeResult,
  ReleasePolicyDecision,
  ReleasePolicyInput,
  ReleaseReportInput,
  ReleaseTask,
  RuntimeConfig,
  SiteHeartbeat,
  SiteRole,
  TestGateInput,
  TestGateVerdict,
  TestRun,
  TestRunInput,
  TestStep,
  TestStepInput
} from '../types.js';
import {
  builtinAppCenterApps,
  createConfigSnapshot,
  normalizeTestStatus,
  normalizeUpdatePolicy,
  releasePolicyByKind,
  required
} from './domain.js';
import type { PlatformOverview, PlatformStore } from './platform-store.js';

type RecordKind =
  | 'site-heartbeat'
  | 'anonymous-enrollment'
  | 'config-snapshot'
  | 'release-task'
  | 'release-policy-decision'
  | 'app-center-app'
  | 'permission-grant'
  | 'launcher-network-snapshot'
  | 'test-run'
  | 'test-gate-verdict'
  | 'audit-event'
  | 'log-entry';

type SequenceName = 'mx_overlay_ip_seq' | 'mx_guest_ip_seq' | 'mx_user_ip_seq';

export class PostgresStore implements PlatformStore {
  private constructor(
    private readonly config: RuntimeConfig,
    private readonly dataSource: DataSource,
    private readonly records: Repository<PlatformRecordRow>
  ) {}

  static async create(config: RuntimeConfig): Promise<PostgresStore> {
    const dataSource = createPlatformDataSource(config);
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const store = new PostgresStore(config, dataSource, dataSource.getRepository(PlatformRecordEntity));
    await store.registerBuiltinApps();
    return store;
  }

  async overview(): Promise<PlatformOverview> {
    const [
      sites,
      enrollments,
      snapshots,
      appCenterApps,
      permissionGrants,
      testRuns,
      auditEvents,
      logs
    ] = await Promise.all([
      this.countRecords('site-heartbeat'),
      this.countRecords('anonymous-enrollment'),
      this.countRecords('config-snapshot'),
      this.countRecords('app-center-app'),
      this.countRecords('permission-grant'),
      this.countRecords('test-run'),
      this.countRecords('audit-event'),
      this.countRecords('log-entry')
    ]);
    return {
      environment: this.config.environment,
      siteId: this.config.siteId,
      siteRole: this.config.siteRole,
      enabledModules: this.config.enabledModules,
      storeDriver: this.config.storeDriver,
      sites,
      enrollments,
      snapshots,
      appCenterApps,
      permissionGrants,
      testRuns,
      auditEvents,
      logs
    };
  }

  async upsertSiteHeartbeat(
    heartbeat: Omit<SiteHeartbeat, 'environment' | 'lastSeenAt' | 'siteRole'> & { siteRole?: SiteRole }
  ): Promise<SiteHeartbeat> {
    const row: SiteHeartbeat = {
      ...heartbeat,
      environment: this.config.environment,
      siteRole: heartbeat.siteRole ?? this.config.siteRole,
      lastSeenAt: new Date().toISOString()
    };
    await this.saveRecord('site-heartbeat', row.siteId, row, row.siteId);
    return row;
  }

  async listSites(): Promise<SiteHeartbeat[]> {
    return (await this.listRecords<SiteHeartbeat>('site-heartbeat')).sort((a, b) => a.siteId.localeCompare(b.siteId));
  }

  async enrollAnonymous(input: AnonymousEnrollmentRequest): Promise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
  }> {
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
      overlayIp: await this.allocateOverlayIp(),
      relayMode: input.relayMode?.trim() || 'h2i',
      createdAt: now,
      userId: null
    };
    const snapshot = this.createSnapshot(enrollment, 1, 'visitor');
    await this.saveRecord('anonymous-enrollment', installId, enrollment, siteId);
    await this.saveRecord('config-snapshot', installId, snapshot, siteId);
    await this.recordAudit({
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

  async linkIdentity(input: IdentityLinkRequest): Promise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
    auditEvent: AuditEvent;
  }> {
    const enrollment = await this.getRecord<AnonymousEnrollment>('anonymous-enrollment', input.installId);
    if (!enrollment) {
      throw new Error(`Unknown installId: ${input.installId}`);
    }
    enrollment.userId = input.userId;
    const previous = await this.getRecord<ConfigSnapshot>('config-snapshot', input.installId);
    const nextVersion = (previous?.version ?? 1) + 1;
    const snapshot = this.createSnapshot(enrollment, nextVersion, 'employee');
    await this.saveRecord('anonymous-enrollment', input.installId, enrollment, enrollment.siteId);
    await this.saveRecord('config-snapshot', input.installId, snapshot, enrollment.siteId);
    const auditEvent = await this.recordAudit({
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

  async getSnapshot(installId: string): Promise<ConfigSnapshot | null> {
    return this.getRecord<ConfigSnapshot>('config-snapshot', installId);
  }

  async listTasks(installId: string): Promise<ReleaseTask[]> {
    const tasks = await this.listRecords<ReleaseTask>('release-task');
    return tasks.filter((task) => task.installId === installId);
  }

  async recordReleaseReport(input: ReleaseReportInput): Promise<AuditEvent> {
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

  async recordAudit(input: AuditEventInput): Promise<AuditEvent> {
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
    await this.saveRecord('audit-event', row.eventId, row, row.siteId);
    return row;
  }

  async recordLogs(entries: LogEntryInput[]): Promise<{ accepted: number; sinks: RuntimeConfig['observabilitySinks'] }> {
    await Promise.all(
      entries.map((entry) => this.saveRecord('log-entry', `log_${randomUUID()}`, entry, entry.siteId ?? this.config.siteId))
    );
    return {
      accepted: entries.length,
      sinks: this.config.observabilitySinks
    };
  }

  observabilitySinks(): RuntimeConfig['observabilitySinks'] {
    return this.config.observabilitySinks;
  }

  async listAppCenterApps(): Promise<AppCenterApp[]> {
    return (await this.listRecords<AppCenterApp>('app-center-app')).sort((a, b) => a.appId.localeCompare(b.appId));
  }

  async getAppCenterApp(appId: string): Promise<AppCenterApp | null> {
    return this.getRecord<AppCenterApp>('app-center-app', appId);
  }

  async requestPermission(input: PermissionRequestInput): Promise<PermissionGrant> {
    const app = await this.getAppCenterApp(input.appId);
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
    await this.saveRecord('permission-grant', grant.grantId, grant, this.config.siteId);
    await this.recordAudit({
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

  async createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): Promise<LauncherNetworkSnapshot> {
    const mode = input.userId ? 'user' : 'guest';
    const leaseIp = mode === 'user' ? await this.allocateUserLeaseIp() : await this.allocateGuestLeaseIp();
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
    await this.saveRecord('launcher-network-snapshot', snapshot.snapshotId, snapshot, this.config.siteId);
    await this.recordAudit({
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

  async evaluateReleaseUpdate(input: ReleasePolicyInput): Promise<ReleasePolicyDecision> {
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

    const decision: ReleasePolicyDecision = {
      componentKind,
      componentId: input.componentId,
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion,
      updateAvailable: true,
      ...releasePolicyByKind(componentKind)
    };
    await this.saveRecord('release-policy-decision', `relpol_${randomUUID()}`, {
      ...decision,
      channel: input.channel,
      installId: input.installId ?? null,
      userId: input.userId ?? null,
      evaluatedAt: new Date().toISOString()
    }, this.config.siteId);
    return decision;
  }

  async createTestRun(input: TestRunInput): Promise<TestRun> {
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
    await this.saveRecord('test-run', run.testRunId, run, this.config.siteId);
    await this.recordAudit({
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

  async getTestRun(runId: string): Promise<TestRun | null> {
    return this.getRecord<TestRun>('test-run', runId);
  }

  async recordTestStep(runId: string, input: TestStepInput): Promise<TestRun> {
    const run = await this.getTestRun(runId);
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
    await this.saveRecord('test-run', run.testRunId, run, this.config.siteId);
    await this.recordAudit({
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

  async evaluateTestGate(input: TestGateInput): Promise<TestGateVerdict> {
    const runs = (await Promise.all(input.runIds.map((runId) => this.getTestRun(runId))))
      .filter((run): run is TestRun => Boolean(run));
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
    await this.saveRecord('test-gate-verdict', `${gate.gateId}:${gate.releaseId}:${randomUUID()}`, gate, this.config.siteId);
    await this.recordAudit({
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

  async runPlatformKernelSmoke(): Promise<PlatformKernelSmokeResult> {
    const checks: string[] = [];
    const app = required(await this.getAppCenterApp('h2o'), 'h2o app is registered');
    checks.push('OK app h2o registered');
    const { enrollment } = await this.enrollAnonymous({
      productId: 'h2o',
      platform: 'darwin',
      requestId: 'smoke-enroll'
    });
    checks.push('OK anonymous install enrolled');
    const networkSnapshot = await this.createLauncherNetworkSnapshot({
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      appId: 'h2o',
      requestId: 'smoke-network'
    });
    if (networkSnapshot.overlayPolicy.cidr !== '100.91.0.0/16') {
      throw new Error('guest network snapshot did not use 100.91.0.0/16');
    }
    checks.push('OK guest network snapshot issued');
    const permissionGrant = await this.requestPermission({
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
    const testRun = await this.createTestRun({
      suiteId: 'hdo-shadow-e2e',
      productId: 'h2o',
      topology: 'h-d-i-shadow',
      sites: ['domestic-main', 'internal-main'],
      releaseId: 'rel_smoke',
      installId: enrollment.installId,
      deviceId: enrollment.deviceId
    });
    const completedRun = await this.recordTestStep(testRun.testRunId, {
      caseId: 'platform-kernel',
      status: 'passed',
      evidence: { source: 'postgres-smoke' }
    });
    checks.push('OK e2e test run passed');
    const gate = await this.evaluateTestGate({
      gateId: 'gate_platform_kernel',
      releaseId: 'rel_smoke',
      runIds: [completedRun.testRunId]
    });
    if (gate.verdict !== 'passed') {
      throw new Error('release gate did not pass');
    }
    checks.push('OK release gate passed');
    const launcherUpdate = await this.evaluateReleaseUpdate({
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
    const h2oUpdate = await this.evaluateReleaseUpdate({
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
    return {
      ok: true,
      checks,
      app,
      enrollment,
      networkSnapshot,
      permissionGrant,
      testRun: completedRun,
      gate,
      launcherUpdate,
      h2oUpdate
    };
  }

  private async registerBuiltinApps(): Promise<void> {
    await Promise.all(
      builtinAppCenterApps().map((app) => this.saveRecord('app-center-app', app.appId, app, this.config.siteId))
    );
  }

  private createSnapshot(
    enrollment: AnonymousEnrollment,
    version: number,
    defaultMode: 'visitor' | 'employee'
  ): ConfigSnapshot {
    return createConfigSnapshot(this.config, enrollment, `cfgsnap_${randomUUID()}`, version, defaultMode);
  }

  private async allocateOverlayIp(): Promise<string> {
    return `10.70.0.${await this.nextSequenceValue('mx_overlay_ip_seq')}`;
  }

  private async allocateGuestLeaseIp(): Promise<string> {
    return `100.91.0.${await this.nextSequenceValue('mx_guest_ip_seq')}`;
  }

  private async allocateUserLeaseIp(): Promise<string> {
    return `100.89.0.${await this.nextSequenceValue('mx_user_ip_seq')}`;
  }

  private async nextSequenceValue(sequenceName: SequenceName): Promise<number> {
    const rows = await this.dataSource.query(`SELECT nextval('${sequenceName}') AS value`) as Array<{ value: string | number }>;
    return Number(rows[0]?.value ?? 20);
  }

  private async countRecords(kind: RecordKind): Promise<number> {
    return this.records.count({
      where: {
        kind,
        environment: this.config.environment
      }
    });
  }

  private async listRecords<T extends object>(kind: RecordKind): Promise<T[]> {
    const rows = await this.records.find({
      where: {
        kind,
        environment: this.config.environment
      },
      order: {
        id: 'ASC'
      }
    });
    return rows.map((row) => row.data as T);
  }

  private async getRecord<T extends object>(kind: RecordKind, id: string): Promise<T | null> {
    const row = await this.records.findOne({
      where: {
        kind,
        id,
        environment: this.config.environment
      }
    });
    return row ? row.data as T : null;
  }

  private async saveRecord<T extends object>(
    kind: RecordKind,
    id: string,
    data: T,
    siteId: string | null
  ): Promise<void> {
    await this.records.save({
      kind,
      id,
      environment: this.config.environment,
      siteId,
      data: data as Record<string, unknown>
    });
  }
}
