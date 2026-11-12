export function runtimeFixture(patch = {}) {
  const baseline = {
    config: {
      productId: 'mx-h2i',
      releaseChannel: 'stable',
      bootstrapApiBaseUrl: 'https://bootstrap.example.test',
      internalApiBaseUrl: 'http://10.88.88.88:18090',
    },
    installation: {
      deviceLabel: 'QA Mac',
      deviceId: 'qa-device',
      installId: 'qa-install',
      siteId: 'domestic',
    },
    identity: {
      kind: 'user',
      provider: 'feishu',
      displayName: '测试员工',
      account: 'employee@example.test',
      scopes: ['appcenter.read'],
    },
    auth: { subject: 'user:qa-employee', provider: 'feishu', expiresAt: '2099-01-01T00:00:00Z' },
    connection: {
      state: 'connected',
      mode: 'employee',
      localIp: '10.88.1.21',
      connectedAt: '2026-11-09T00:00:00Z',
      wireGuard: { active: true },
      health: { wireGuard: 'ready', internalApi: 'ready', splitDns: 'ready' },
      diagnostics: { route: { ok: true }, internalApi: { ok: true } },
    },
    apps: {
      appcenter: { installed: true, enabled: true, status: 'ready' },
      h2o: {
        installed: true,
        enabled: true,
        runtimeState: 'ready',
        runtime: {
          metrics: { uploadBytes: 1024, downloadBytes: 2048, connections: 0 },
          clashLink: {
            userId: 'qa-employee',
            status: 'verified',
            url: 'https://subscriptions.example.test/oversea.yaml',
            expiresAt: '2099-01-01T00:00:00Z',
          },
        },
      },
      reserved: {
        appId: 'reserved',
        displayName: '未实现应用',
        launcherMode: 'embed',
        standaloneChannelProductId: 'mx-h2i',
        category: 'custom',
      },
    },
    mincaveAccess: {
      status: 'allowed',
      allowed: true,
      canManage: true,
      role: 'admin',
      userId: 'qa-employee',
    },
    update: {
      currentVersion: '2.1.20',
      latestVersion: '2.1.20',
      status: 'up-to-date',
      channel: 'stable',
      availableReleases: [],
      rollbackSlots: [],
    },
    launcherProductPresentation: {
      productId: 'mx-h2i',
      anonymousUiVisibility: 'advanced',
      anonymousEnrollmentPolicy: 'enabled',
    },
    activity: [],
    feedback: null,
  };
  return { ...baseline, ...patch };
}

export const idleFixture = () =>
  runtimeFixture({
    identity: { kind: 'anonymous', displayName: 'Visitor', account: null, provider: null },
    auth: null,
    connection: { state: 'idle', mode: 'guest', localIp: null, health: {}, diagnostics: {} },
  });

export function adminFixture() {
  return {
    administratorId: 'qa-employee',
    memberPermissions: true,
    workspace: { revision: 0, policies: [], applications: [
      { id: 'web-delta', name: 'Delta', category: '中台应用', url: 'https://delta.example.test/', published: true, icon: 'triangle', color: 'purple' },
      { id: 'web-hub', name: 'Hub', category: '中台应用', url: 'https://hub.example.test/', published: true, icon: 'layers', color: 'blue' },
      { id: 'web-compass', name: 'Compass', category: '产品应用', url: 'https://compass.example.test/', published: false, icon: 'compass', color: 'mint' },
    ] },
    members: [
      {
        id: 'usr-1',
        name: '测试成员',
        department: '技术部',
        devices: [{ name: 'QA Mac', platform: 'darwin' }, { name: 'QA Windows', platform: 'win32' }],
        appIds: ['web-delta', 'web-hub'],
        effectiveAppIds: ['web-delta', 'web-hub'],
        role: 'employee',
        enabled: true,
        accountActive: true,
        firstSeenAt: '2026-11-09T00:00:00Z',
        lastSeenAt: '2026-11-10T00:00:00Z',
      },
    ],
  };
}

export function devicesFixture(userId = 'qa-employee') {
  return {
    userId,
    devices: [
      { deviceId: 'old-windows', deviceLabel: 'QA Windows', platform: 'win32', deviceModel: null, osVersion: null,
        firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-11-01T00:00:00Z', lastVirtualIp: '10.88.1.22' },
      { deviceId: 'qa-device', deviceLabel: 'QA Mac', platform: 'darwin', deviceModel: null, osVersion: null,
        firstSeenAt: '2026-11-09T00:00:00Z', lastSeenAt: '2026-11-10T00:00:00Z', lastVirtualIp: '10.88.1.21' },
    ],
  };
}
