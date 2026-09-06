"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runH2iCli = runH2iCli;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const electron_core_wireguard_1 = require("@qpjoy/electron-core-wireguard");
const defaultInterfaceName = 'mx-h2i';
const defaultProductId = 'mx-h2i';
const requestedBy = '@qpjoy/tunnel-cli/h2i';
const launcherRequestTimeoutMs = 30_000;
const domesticPeerSyncTimeoutMs = 185_000;
const h2iSystemdUnitMarker = '# Managed by qp-tunnel-cli h2i';
const oauthScope = [
    'auth.read',
    'appcenter.read',
    'network.hdi.status',
    'network.proxy.app',
    'network.dns.policy',
    'oversea.subscription.ensure',
].join(' ');
async function runH2iCli(args, ctx) {
    const command = args[0] ?? 'help';
    const rest = args.slice(1);
    if (command === 'help' || command === '--help' || command === '-h') {
        h2iHelp();
        return;
    }
    if (command === 'enroll') {
        const options = parseEnrollOptions(rest);
        if (process.platform !== 'linux' && options.start) {
            throw new Error('qp-tunnel-cli h2i can start the system tunnel only on Linux; use --no-start for config staging.');
        }
        if (!ctx.isRoot() && enrollNeedsRoot(options)) {
            ctx.sudoSelf(['h2i', ...args]);
        }
        await enrollCommand(options);
        return;
    }
    if (command !== 'status' && command !== 'down') {
        process.stderr.write(`Unknown h2i command: ${command}\n\n`);
        h2iHelp();
        process.exitCode = 1;
        return;
    }
    if (process.platform !== 'linux') {
        throw new Error('qp-tunnel-cli h2i status/down currently support Linux hosts only.');
    }
    const options = parseCommandOptions(rest);
    if (!ctx.isRoot())
        ctx.sudoSelf(['h2i', ...args]);
    if (command === 'status') {
        await statusCommand(options);
        return;
    }
    if (command === 'down') {
        await downCommand(options);
        return;
    }
}
function h2iHelp() {
    process.stdout.write(`QPJoy MX H2I CLI (V2)

Usage:
  qp-tunnel-cli h2i enroll --bootstrap-url URL --username USER [options]
  qp-tunnel-cli h2i enroll --bootstrap-url URL --anonymous [options]
  qp-tunnel-cli h2i status
  qp-tunnel-cli h2i down

Enroll options:
  --bootstrap-url URL    Domestic HTTPS bootstrap facade
  --username USER        Internal local-password account
  --password-file PATH   Read the account password from a root-readable file
  --access-token-file PATH
                         Read an mx-sdk bearer token from a mode-0600 file
  --user-id ID           User id for H2I_ACCESS_TOKEN/token file
  --lease-profile NAME   Token profile: employee (default) or feishu
  --anonymous            Request an anonymous V2 launcher-network lease
  --product-id ID        Product network id. Default: mx-h2i
  --site-id ID           Optional Domestic site id
  --install-id ID        Stable installation id; generated and persisted by default
  --device-id ID         Stable device id; generated and persisted by default
  --label LABEL          Device label. Default: linux <hostname>
  --interface NAME       WireGuard interface name. Default: mx-h2i
  --state-file PATH      Client state path. Default: /etc/qpjoy/h2i/client.json
  --config-path PATH     WireGuard config. Default: /etc/wireguard/mx-h2i.conf
  --install-dir PATH     Bundled WireGuard cache directory
  --dns                  Apply the Internal DNS server globally via resolvconf
  --no-dns               Keep the host resolver unchanged (default)
  --no-start             Enroll, peer-sync, and write config without starting WireGuard

Environment:
  H2I_BOOTSTRAP_URL / MX_H2I_BOOTSTRAP_BASE_URL
  H2I_USERNAME
  H2I_PASSWORD
  H2I_ACCESS_TOKEN
  H2I_USER_ID

Examples:
  read -rsp 'H2I password: ' H2I_PASSWORD; export H2I_PASSWORD
  qp-tunnel-cli h2i enroll \\
    --bootstrap-url https://h2i.example.com \\
    --username user@example.com
  unset H2I_PASSWORD

  qp-tunnel-cli h2i enroll \\
    --bootstrap-url https://h2i.example.com \\
    --anonymous

Notes:
  This first Linux V2 implementation is Domestic-relay-only. It performs
  OAuth (for accounts), launcher-network enroll, snapshot, Domestic peer sync,
  and then enables qpjoy-h2i@mx-h2i.service. Passwords and access tokens are not saved.
  The WireGuard private key and lease capability are stored root-only.
  Direct password/token argv flags are rejected; use an environment variable
  or a root-owned mode-0600 secret file so secrets do not enter process lists.
`);
}
async function enrollCommand(options) {
    const stateFile = resolveStateFile(options.stateFile);
    const releaseStateLock = acquireH2iLock(`${stateFile}.enroll.lock`, 'H2I state');
    try {
        const previous = readState(stateFile);
        const interfaceName = sanitizeInterfaceName(options.interfaceName ?? previous.interfaceName ?? defaultInterfaceName);
        const configPath = resolveConfigPath(options.configPath ?? previous.configPath, interfaceName);
        assertConfigPathMatchesInterface(configPath, interfaceName);
        const releaseInterfaceLock = acquireH2iLock(h2iInterfaceLockPath(interfaceName), `WireGuard interface ${interfaceName}`);
        try {
            const releaseConfigLock = acquireH2iLock(`${configPath}.enroll.lock`, 'WireGuard config');
            try {
                const installDir = resolveInstallDir(options.installDir ?? previous.installDir);
                const dnsEnabled = options.dnsEnabled ?? previous.dnsEnabled ?? false;
                assertStableLocalPaths(previous, options, interfaceName, configPath);
                const configGuard = captureConfigGuard(configPath);
                if (configGuard.existed &&
                    !wireGuardConfigBelongsToState(configPath, previous.privateKey, previous.lease?.leaseIp)) {
                    throw new Error(`Refusing to overwrite an existing WireGuard config not owned by this H2I state: ${configPath}. Move it aside after verifying its owner, or use a separate --state-file, --config-path, and --interface.`);
                }
                if (options.start &&
                    commandAvailable('systemctl') &&
                    configPath === defaultConfigPath(interfaceName)) {
                    assertH2iSystemdUnitAvailable(interfaceName);
                }
                if (options.start)
                    assertDnsRuntimeReady(dnsEnabled);
                if (!options.start &&
                    (0, node_fs_1.existsSync)(configPath) &&
                    captureLocalTunnelSnapshot(interfaceName, configPath, installDir).tunnelActive) {
                    throw new Error('--no-start refuses to replace the config of an active tunnel. Stage with a separate --state-file, --config-path, and --interface.');
                }
                const enrollmentBound = stateEnrollmentBound(previous);
                const bootstrapUrl = secureBootstrapUrl(enrollmentBound
                    ? options.bootstrapUrl ?? previous.bootstrapUrl
                    : options.bootstrapUrl ??
                        process.env.H2I_BOOTSTRAP_URL ??
                        process.env.MX_H2I_BOOTSTRAP_BASE_URL ??
                        previous.bootstrapUrl);
                if (enrollmentBound) {
                    const persistedBootstrapUrl = secureBootstrapUrl(previous.bootstrapUrl);
                    if (new URL(bootstrapUrl).origin !== new URL(persistedBootstrapUrl).origin) {
                        throw new Error('Changing the H2I bootstrap origin requires a separate --state-file and --interface.');
                    }
                }
                const requestedUsername = cleanString(options.username ?? process.env.H2I_USERNAME);
                const username = requestedUsername ?? (enrollmentBound ? previous.username : undefined);
                const rawAccessToken = secretOption(undefined, options.accessTokenFile, process.env.H2I_ACCESS_TOKEN);
                const accessToken = rawAccessToken
                    ? requireSafeString(rawAccessToken, 'H2I access token')
                    : undefined;
                const password = secretOption(undefined, options.passwordFile, process.env.H2I_PASSWORD);
                const rawExplicitUserId = cleanString(options.userId ?? process.env.H2I_USER_ID);
                const explicitUserId = rawExplicitUserId
                    ? requireSafeString(rawExplicitUserId, 'H2I userId')
                    : undefined;
                const expectedUserId = explicitUserId ?? (previous.userId
                    ? requireSafeString(previous.userId, 'persisted H2I userId')
                    : undefined);
                const anonymous = options.anonymous;
                if (anonymous && (username || accessToken || password || explicitUserId || options.leaseProfile)) {
                    throw new Error('--anonymous cannot be combined with account credentials.');
                }
                if (requestedUsername && accessToken) {
                    throw new Error('Password login and access-token login are mutually exclusive. Clear stale H2I_ACCESS_TOKEN when using --username.');
                }
                if (accessToken && password) {
                    throw new Error('H2I_ACCESS_TOKEN and H2I_PASSWORD cannot be used together.');
                }
                if (!anonymous && !username && !accessToken) {
                    throw new Error('Choose --anonymous, provide --username with H2I_PASSWORD, or provide H2I_ACCESS_TOKEN.');
                }
                if (username && !accessToken && !password) {
                    throw new Error('Password login requires H2I_PASSWORD or --password-file.');
                }
                if (accessToken && !expectedUserId) {
                    throw new Error('Access-token login requires --user-id/H2I_USER_ID (or an existing bound state).');
                }
                if (stateEnrollmentBound(previous) &&
                    previous.userId &&
                    explicitUserId &&
                    previous.userId !== explicitUserId) {
                    throw new Error('Changing the authenticated H2I user requires a separate --state-file and --interface.');
                }
                const identityKind = anonymous ? 'anonymous' : 'user';
                const previousLeaseProfile = previous.leaseProfile ?? previous.lease?.leaseProfile;
                const leaseProfile = anonymous
                    ? 'anonymous'
                    : accessToken
                        ? options.leaseProfile ?? (previousLeaseProfile === 'employee' || previousLeaseProfile === 'feishu'
                            ? previousLeaseProfile
                            : 'employee')
                        : previousLeaseProfile === 'feishu' ? 'feishu' : 'employee';
                if (username && !accessToken && leaseProfile !== 'employee') {
                    throw new Error('Local-password login supports only the employee lease profile; renew a Feishu state with H2I_ACCESS_TOKEN.');
                }
                if (stateEnrollmentBound(previous) &&
                    previousLeaseProfile &&
                    previousLeaseProfile !== leaseProfile) {
                    throw new Error('Changing the H2I lease profile requires a separate state or the full MX-H2I handover flow.');
                }
                const productId = sanitizeId(options.productId ?? previous.productId ?? defaultProductId);
                assertStableIdentity(previous, identityKind, productId, username);
                const installId = sanitizeId(options.installId ?? previous.installId ?? `inst_mxh2i_${(0, node_crypto_1.randomUUID)().replaceAll('-', '')}`);
                const deviceId = sanitizeId(options.deviceId ??
                    previous.deviceId ??
                    `dev_mxh2i_${sanitizeId((0, node_os_1.hostname)())}_${installId.slice(-12)}`);
                if (stateEnrollmentBound(previous) &&
                    previous.installId &&
                    options.installId &&
                    previous.installId !== installId) {
                    throw new Error('The persisted H2I installId cannot be changed in place. Use a separate --state-file.');
                }
                if (stateEnrollmentBound(previous) &&
                    previous.deviceId &&
                    options.deviceId &&
                    previous.deviceId !== deviceId) {
                    throw new Error('The persisted H2I deviceId cannot be changed in place. Use a separate --state-file.');
                }
                const deviceLabel = cleanString(options.deviceLabel ?? previous.deviceLabel) ?? `linux ${(0, node_os_1.hostname)()}`;
                const siteId = cleanString(options.siteId ?? previous.siteId);
                const keys = resolveKeyPair(previous, installDir);
                const pendingLeaseCapability = previous.pendingLeaseCapability ?? mintLeaseCapability();
                const now = new Date().toISOString();
                const pendingState = {
                    ...previous,
                    schemaVersion: 1,
                    bootstrapUrl,
                    productId,
                    identityKind,
                    leaseProfile,
                    username: identityKind === 'user' ? username : undefined,
                    userId: identityKind === 'user' ? previous.userId ?? explicitUserId : undefined,
                    installId,
                    deviceId,
                    deviceLabel,
                    siteId,
                    interfaceName,
                    configPath,
                    installDir,
                    privateKey: keys.privateKey,
                    publicKey: keys.publicKey,
                    pendingLeaseCapability,
                    dnsEnabled,
                    updatedAt: now,
                };
                writeState(stateFile, pendingState);
                await requestJson(bootstrapUrl, '/bootstrap-healthz', {
                    method: 'GET',
                    timeoutMs: 5_000,
                });
                const auth = identityKind === 'user'
                    ? accessToken
                        ? { accessToken, userId: requireString(expectedUserId, 'userId') }
                        : await authenticatePassword(bootstrapUrl, requireString(username, 'username'), requireString(password, 'password/H2I_PASSWORD'))
                    : null;
                if (auth &&
                    stateEnrollmentBound(previous) &&
                    previous.userId &&
                    previous.userId !== auth.userId) {
                    throw new Error('The authenticated account does not match the user bound to this H2I state.');
                }
                if (auth && explicitUserId && explicitUserId !== auth.userId) {
                    throw new Error('The authenticated account does not match --user-id/H2I_USER_ID.');
                }
                const existingCapabilities = uniqueStrings([
                    previous.lease?.capability,
                    pendingLeaseCapability,
                ]).join(',');
                const standalone = await import('@qpjoy/mx-launcher-standalone');
                const launcher = standalone.createStandaloneLauncher({
                    baseUrl: bootstrapUrl,
                    fetchImpl: scopedLauncherFetch(bootstrapUrl, launcherRequestTimeoutMs),
                    productId,
                    installId,
                    deviceId,
                    siteId,
                    keyPair: keys,
                    deviceLabel,
                });
                const attemptedState = {
                    ...pendingState,
                    userId: auth?.userId,
                    enrollmentAttemptedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                writeState(stateFile, attemptedState);
                const session = await launcher.connectNetwork({
                    identityKind,
                    leaseProfile,
                    accessToken: auth?.accessToken,
                    userId: auth?.userId,
                    leaseCapability: existingCapabilities,
                    newLeaseCapability: pendingLeaseCapability,
                    installId,
                    deviceId,
                    siteId,
                    keyPair: keys,
                    privateKey: keys.privateKey,
                    publicKey: keys.publicKey,
                    deviceLabel,
                    platform: `linux-${process.arch}`,
                    deviceModel: (0, node_os_1.hostname)(),
                    osVersion: (0, node_os_1.release)(),
                    requestedBy,
                    requestId: requestId('enroll'),
                    snapshotRequestId: requestId('snapshot'),
                });
                if (Array.isArray(session.lease.handoverLeases) && session.lease.handoverLeases.length > 0) {
                    throw new Error('The server requested a lease handover, which qp-tunnel-cli h2i 0.3 does not apply automatically. The pending capability was retained; use the full MX-H2I client or rerun after the server migration is resolved.');
                }
                const sessionPrivateKey = requireWireGuardKey(cleanString(session.wireGuard.privateKey) ?? keys.privateKey, 'session.wireGuard.privateKey');
                const sessionPublicKey = requireWireGuardKey(cleanString(session.wireGuard.publicKey), 'session.wireGuard.publicKey');
                if (sessionPublicKey !== keys.publicKey) {
                    throw new Error('Launcher session returned a WireGuard public key that does not match this installation.');
                }
                const lease = parseLease(session.lease);
                const routePlan = parseRelayRoutePlan(session.routePlan);
                assertNetworkSessionContract({
                    lease,
                    routePlan,
                    snapshot: session.snapshot,
                    productId,
                    identityKind,
                    leaseProfile,
                    installId,
                    deviceId,
                    userId: auth?.userId,
                    publicKey: keys.publicKey,
                    requestedSiteId: siteId,
                });
                if (previous.lease &&
                    (previous.lease.leaseId !== lease.leaseId ||
                        previous.lease.leaseIp !== lease.leaseIp ||
                        previous.lease.leaseProfile !== lease.leaseProfile ||
                        previous.lease.siteId !== lease.siteId)) {
                    throw new Error('The server changed the bound H2I lease identity/IP/profile/site. qp-tunnel-cli 0.3 refuses this handover; use the full MX-H2I migration flow.');
                }
                const previousConfigCompatible = Boolean((0, node_fs_1.existsSync)(configPath) &&
                    previous.routePlan &&
                    previous.lease?.leaseIp === lease.leaseIp &&
                    previous.publicKey === sessionPublicKey);
                const persistedAfterLease = {
                    ...previous,
                    schemaVersion: 1,
                    bootstrapUrl,
                    productId,
                    identityKind,
                    leaseProfile,
                    username: identityKind === 'user' ? username : undefined,
                    userId: auth?.userId,
                    installId,
                    deviceId,
                    deviceLabel,
                    siteId: lease.siteId,
                    interfaceName,
                    configPath,
                    installDir,
                    privateKey: sessionPrivateKey,
                    publicKey: sessionPublicKey,
                    pendingLeaseCapability: undefined,
                    enrollmentAttemptedAt: undefined,
                    lease,
                    routePlan,
                    peerSync: undefined,
                    dnsEnabled,
                    enrolledAt: previous.enrolledAt ?? now,
                    updatedAt: new Date().toISOString(),
                };
                writeState(stateFile, persistedAfterLease);
                let peerSync;
                try {
                    peerSync = await syncDomesticPeer(bootstrapUrl, lease, auth?.accessToken);
                    assertPeerSyncReady(peerSync);
                }
                catch (error) {
                    writeState(stateFile, {
                        ...persistedAfterLease,
                        routePlan: previousConfigCompatible ? previous.routePlan : routePlan,
                        dnsEnabled: previousConfigCompatible ? previous.dnsEnabled : dnsEnabled,
                        peerSync,
                        updatedAt: new Date().toISOString(),
                    });
                    throw error;
                }
                const stateAfterPeerSync = {
                    ...persistedAfterLease,
                    peerSync,
                    updatedAt: new Date().toISOString(),
                };
                writeState(stateFile, stateAfterPeerSync);
                let config;
                try {
                    config = renderRelayConfig(requireWireGuardKey(stateAfterPeerSync.privateKey, 'WireGuard privateKey'), routePlan, dnsEnabled, interfaceName);
                }
                catch (error) {
                    if (previousConfigCompatible) {
                        writeState(stateFile, {
                            ...stateAfterPeerSync,
                            routePlan: previous.routePlan,
                            dnsEnabled: previous.dnsEnabled,
                            updatedAt: new Date().toISOString(),
                        });
                    }
                    throw error;
                }
                const localSnapshot = options.start
                    ? captureLocalTunnelSnapshot(interfaceName, configPath, installDir)
                    : null;
                try {
                    assertConfigGuardUnchanged(configGuard);
                    writeWireGuardConfig(configPath, config);
                }
                catch (error) {
                    if (previousConfigCompatible) {
                        writeState(stateFile, {
                            ...stateAfterPeerSync,
                            routePlan: previous.routePlan,
                            dnsEnabled: previous.dnsEnabled,
                            updatedAt: new Date().toISOString(),
                        });
                    }
                    throw error;
                }
                let startMessage = 'System tunnel not started (--no-start).';
                let verificationMessage = 'Connection verification skipped (--no-start).';
                let completedState = stateAfterPeerSync;
                if (options.start) {
                    let started;
                    let verification;
                    try {
                        started = await startSystemTunnel(interfaceName, configPath, installDir);
                        verification = await verifyInternalConnection(started.runtime, configPath, routePlan);
                        if (!verification.ok)
                            throw new Error(verification.message);
                        startMessage = completeSystemTunnelStart(interfaceName, started);
                    }
                    catch (error) {
                        const canRestorePrevious = Boolean(localSnapshot?.configContent !== undefined && previousConfigCompatible);
                        const rollback = await rollbackSystemTunnelStart(interfaceName, configPath, started, localSnapshot, canRestorePrevious);
                        if (rollback.restoredPrevious && previous.routePlan) {
                            writeState(stateFile, {
                                ...stateAfterPeerSync,
                                routePlan: previous.routePlan,
                                dnsEnabled: previous.dnsEnabled,
                                lastConnectedAt: previous.lastConnectedAt,
                                lastHealthUrl: previous.lastHealthUrl,
                                updatedAt: new Date().toISOString(),
                            });
                        }
                        throw new Error(`${errorMessage(error)} ${rollback.message}`);
                    }
                    verificationMessage = verification.message;
                    completedState = {
                        ...stateAfterPeerSync,
                        lastConnectedAt: new Date().toISOString(),
                        lastHealthUrl: verification.healthUrl,
                        updatedAt: new Date().toISOString(),
                    };
                    writeState(stateFile, completedState);
                }
                process.stdout.write([
                    'MX H2I V2 enrollment complete.',
                    `Identity: ${identityKind}${auth?.userId ? ` (${auth.userId})` : ''}`,
                    `Device: ${deviceId}`,
                    `Lease: ${lease.leaseIp} (${lease.leaseId})`,
                    `Path: Domestic relay ${routePlan.domesticRelayEndpoint}`,
                    `WireGuard config: ${configPath}`,
                    `State file: ${stateFile}`,
                    startMessage,
                    verificationMessage,
                    '',
                ].join('\n'));
            }
            finally {
                releaseConfigLock();
            }
        }
        finally {
            releaseInterfaceLock();
        }
    }
    finally {
        releaseStateLock();
    }
}
function boundCommandPaths(state, options) {
    const interfaceName = sanitizeInterfaceName(state.interfaceName ?? defaultInterfaceName);
    const configPath = resolveConfigPath(state.configPath, interfaceName);
    assertConfigPathMatchesInterface(configPath, interfaceName);
    const installDir = resolveInstallDir(state.installDir);
    if (options.interfaceName &&
        sanitizeInterfaceName(options.interfaceName) !== interfaceName) {
        throw new Error('The requested interface does not match the interface bound to this H2I state.');
    }
    if (options.configPath && (0, node_path_1.resolve)(options.configPath) !== configPath) {
        throw new Error('The requested config path does not match the config bound to this H2I state.');
    }
    if (options.installDir && (0, node_path_1.resolve)(options.installDir) !== installDir) {
        throw new Error('The requested install directory does not match this H2I state.');
    }
    return { interfaceName, configPath, installDir };
}
async function statusCommand(options) {
    const stateFile = resolveStateFile(options.stateFile);
    const releaseStateLock = acquireH2iLock(`${stateFile}.enroll.lock`, 'H2I state');
    try {
        const state = requireEnrolledState(readState(stateFile), stateFile);
        const { interfaceName, configPath, installDir } = boundCommandPaths(state, options);
        const runtime = trustedRootConnectionRuntime((0, electron_core_wireguard_1.resolveWireGuardConnectionRuntime)({
            installDir,
            allowSystemFallback: true,
        }));
        process.stdout.write(`State file: ${stateFile}\n`);
        process.stdout.write(`Bootstrap URL: ${state.bootstrapUrl}\n`);
        process.stdout.write(`Identity: ${state.identityKind}${state.userId ? ` (${state.userId})` : ''}\n`);
        process.stdout.write(`Device: ${state.deviceId}\n`);
        process.stdout.write(`Lease: ${state.lease?.leaseIp} (${state.lease?.leaseId})\n`);
        process.stdout.write(`Peer sync: ${state.peerSync?.status ?? 'unknown'}\n`);
        process.stdout.write(`WireGuard config: ${configPath}\n`);
        process.stdout.write(`Runtime: ${runtime.method}\n`);
        if (!(0, node_fs_1.existsSync)(configPath)) {
            process.stdout.write('WireGuard active: false (config missing)\n');
            process.exitCode = 1;
            return;
        }
        const status = (0, electron_core_wireguard_1.getWireGuardTunnelStatus)({ runtime, configPath });
        process.stdout.write(`WireGuard active: ${status.active}\n`);
        if (status.realInterfaceName)
            process.stdout.write(`Interface: ${status.realInterfaceName}\n`);
        process.stdout.write(`Addresses: ${status.addresses.join(', ') || 'none'}\n`);
        process.stdout.write(`Missing routes: ${status.missingRoutes.join(', ') || 'none'}\n`);
        const latestHandshake = status.peers
            .map((peer) => peer.latestHandshakeAt)
            .filter((value) => Boolean(value))
            .sort()
            .at(-1);
        process.stdout.write(`Latest handshake: ${latestHandshake ?? 'none'}\n`);
        if (status.error)
            process.stdout.write(`Status detail: ${status.error}\n`);
        if (!status.active || status.missingRoutes.length > 0 || !latestHandshake || status.error) {
            process.exitCode = 1;
        }
        if (status.active && state.routePlan) {
            const healthUrl = internalHealthUrl(state.routePlan);
            const health = await probeHealth(healthUrl, 3_000);
            process.stdout.write(`Internal health: ${health.ok ? 'ready' : 'unreachable'} (${healthUrl})\n`);
            if (health.error)
                process.stdout.write(`Health detail: ${health.error}\n`);
            if (!health.ok)
                process.exitCode = 1;
        }
        else if (!state.routePlan) {
            process.stdout.write('Internal health: unavailable (route plan missing)\n');
            process.exitCode = 1;
        }
    }
    finally {
        releaseStateLock();
    }
}
async function downCommand(options) {
    const stateFile = resolveStateFile(options.stateFile);
    const releaseStateLock = acquireH2iLock(`${stateFile}.enroll.lock`, 'H2I state');
    try {
        const state = requireEnrolledState(readState(stateFile), stateFile);
        const { interfaceName, configPath, installDir } = boundCommandPaths(state, options);
        const releaseInterfaceLock = acquireH2iLock(h2iInterfaceLockPath(interfaceName), `WireGuard interface ${interfaceName}`);
        try {
            const releaseConfigLock = acquireH2iLock(`${configPath}.enroll.lock`, 'WireGuard config');
            try {
                const runtime = trustedRootConnectionRuntime((0, electron_core_wireguard_1.resolveWireGuardConnectionRuntime)({
                    installDir,
                    allowSystemFallback: true,
                }));
                const service = h2iSystemdService(interfaceName);
                const unitPath = h2iSystemdUnitPath(interfaceName);
                const managedSystemd = commandAvailable('systemctl')
                    && configPath === defaultConfigPath(interfaceName)
                    && (0, node_fs_1.existsSync)(unitPath);
                const messages = [];
                if (managedSystemd) {
                    readManagedH2iSystemdUnit(interfaceName);
                    const result = (0, node_child_process_1.spawnSync)('systemctl', ['stop', service], {
                        encoding: 'utf8',
                    });
                    if (result.status === 0)
                        messages.push(`Stopped ${service}.`);
                    else
                        messages.push(`${service} did not stop cleanly through systemd; applying direct cleanup.`);
                }
                if (!managedSystemd || wireGuardTunnelActive(runtime, configPath, interfaceName)) {
                    const stopped = await (0, electron_core_wireguard_1.setWireGuardTunnelState)({ runtime, configPath, action: 'down' });
                    if (!stopped.ok)
                        throw new Error(stopped.message);
                    messages.push(stopped.message);
                }
                if (managedSystemd) {
                    if (systemdUnitActive(service))
                        runRequired('systemctl', ['stop', service]);
                    if (systemdUnitActive(service)) {
                        throw new Error(`${service} is still active after h2i down.`);
                    }
                    disableSystemdUnit(service);
                    if (systemdUnitEnabled(service)) {
                        throw new Error(`${service} is still enabled after h2i down.`);
                    }
                }
                if (wireGuardTunnelActive(runtime, configPath, interfaceName)) {
                    throw new Error(`WireGuard interface ${interfaceName} is still active after h2i down.`);
                }
                process.stdout.write(`${messages.join(' ')}\nLease retained for reconnect.\n`);
            }
            finally {
                releaseConfigLock();
            }
        }
        finally {
            releaseInterfaceLock();
        }
    }
    finally {
        releaseStateLock();
    }
}
function parseEnrollOptions(args) {
    const options = {
        anonymous: false,
        start: true,
    };
    let dnsOptionSeen = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = () => {
            const value = args[index + 1];
            if (!value || value.startsWith('--'))
                throw new Error(`Missing value for ${arg}.`);
            index += 1;
            return value;
        };
        switch (arg) {
            case '--bootstrap-url':
            case '--base-url':
                options.bootstrapUrl = next();
                break;
            case '--username':
                options.username = next();
                break;
            case '--password':
                throw new Error('Do not pass passwords in argv; use H2I_PASSWORD or --password-file.');
            case '--password-file':
                options.passwordFile = next();
                break;
            case '--access-token':
            case '--token':
                throw new Error('Do not pass access tokens in argv; use H2I_ACCESS_TOKEN or --access-token-file.');
            case '--access-token-file':
            case '--token-file':
                options.accessTokenFile = next();
                break;
            case '--user-id':
                options.userId = next();
                break;
            case '--lease-profile': {
                const profile = next();
                if (profile !== 'employee' && profile !== 'feishu') {
                    throw new Error('--lease-profile must be employee or feishu.');
                }
                options.leaseProfile = profile;
                break;
            }
            case '--anonymous':
                options.anonymous = true;
                break;
            case '--product-id':
                options.productId = next();
                break;
            case '--site-id':
                options.siteId = next();
                break;
            case '--install-id':
                options.installId = next();
                break;
            case '--device-id':
                options.deviceId = next();
                break;
            case '--label':
                options.deviceLabel = next();
                break;
            case '--interface':
                options.interfaceName = next();
                break;
            case '--state-file':
                options.stateFile = next();
                break;
            case '--config-path':
                options.configPath = next();
                break;
            case '--install-dir':
                options.installDir = next();
                break;
            case '--no-start':
                options.start = false;
                break;
            case '--no-dns':
                if (dnsOptionSeen)
                    throw new Error('Use only one of --dns or --no-dns.');
                options.dnsEnabled = false;
                dnsOptionSeen = true;
                break;
            case '--dns':
                if (dnsOptionSeen)
                    throw new Error('Use only one of --dns or --no-dns.');
                options.dnsEnabled = true;
                dnsOptionSeen = true;
                break;
            case '--help':
            case '-h':
                h2iHelp();
                process.exit(0);
            default:
                throw new Error(`Unknown h2i enroll option: ${arg}`);
        }
    }
    return options;
}
function parseCommandOptions(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const next = () => {
            const value = args[index + 1];
            if (!value || value.startsWith('--'))
                throw new Error(`Missing value for ${arg}.`);
            index += 1;
            return value;
        };
        switch (arg) {
            case '--state-file':
                options.stateFile = next();
                break;
            case '--interface':
                options.interfaceName = next();
                break;
            case '--config-path':
                options.configPath = next();
                break;
            case '--install-dir':
                options.installDir = next();
                break;
            default:
                throw new Error(`Unknown h2i command option: ${arg}`);
        }
    }
    return options;
}
function enrollNeedsRoot(options) {
    if (options.start)
        return true;
    const stateFile = resolveStateFile(options.stateFile);
    if (stateFile.startsWith('/etc/') || stateFile.startsWith('/usr/'))
        return true;
    const previous = readState(stateFile);
    const interfaceName = sanitizeInterfaceName(options.interfaceName ?? previous.interfaceName ?? defaultInterfaceName);
    return [
        stateFile,
        resolveConfigPath(options.configPath ?? previous.configPath, interfaceName),
        resolveInstallDir(options.installDir ?? previous.installDir),
    ].some((path) => path.startsWith('/etc/') || path.startsWith('/usr/'));
}
async function authenticatePassword(bootstrapUrl, username, password) {
    const payload = await requestJson(bootstrapUrl, '/internal/v1/sdk/oauth/token', {
        method: 'POST',
        body: {
            grant_type: 'password',
            username,
            password,
            audience: 'mx-sdk',
            scope: oauthScope,
            requestId: requestId('oauth'),
        },
        timeoutMs: 10_000,
    });
    const root = record(payload);
    const token = record(root.token ?? root);
    const principal = record(token.principal);
    const rawAccessToken = cleanString(token.access_token);
    const rawUserId = cleanString(principal.userId) ?? userIdFromSubject(cleanString(token.subject));
    if (!rawAccessToken || !rawUserId) {
        throw new Error('Internal OAuth response is missing access_token or user principal.');
    }
    const accessToken = requireSafeString(rawAccessToken, 'OAuth access_token');
    const userId = requireSafeString(rawUserId, 'OAuth userId');
    return { accessToken, userId };
}
async function syncDomesticPeer(bootstrapUrl, lease, accessToken) {
    const headers = {
        'x-mx-lease-capability': lease.capability,
    };
    if (accessToken)
        headers.authorization = `Bearer ${accessToken}`;
    let payload;
    try {
        payload = await requestJson(bootstrapUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(lease.leaseId)}/domestic-peer/sync`, {
            method: 'POST',
            headers,
            body: {
                requestedBy,
                requestId: requestId('domestic-peer-sync'),
            },
            timeoutMs: domesticPeerSyncTimeoutMs,
        });
    }
    catch (error) {
        if (/timed out/i.test(errorMessage(error))) {
            throw new Error(`Domestic peer sync timed out after ${Math.round(domesticPeerSyncTimeoutMs / 1000)}s, so the server outcome is unknown. The lease and capability were preserved; rerun the same h2i enroll command to reconcile safely.`);
        }
        throw error;
    }
    const sync = record(record(payload).domesticPeerSync);
    return {
        status: cleanString(sync.status) ?? 'missing',
        execution: cleanString(sync.execution) ?? undefined,
        checkedAt: cleanString(sync.checkedAt) ?? undefined,
        failures: stringArray(sync.failures).map((failure) => safeDisplayText(failure)).filter(Boolean),
    };
}
function assertPeerSyncReady(sync) {
    if (sync.status === 'passed' && sync.execution === 'executed')
        return;
    const detail = sync.failures?.length ? `: ${sync.failures.join('; ')}` : '';
    throw new Error(`Domestic peer sync did not pass (status=${sync.status}, execution=${sync.execution ?? 'unknown'})${detail}`);
}
function parseLease(input) {
    const lease = record(input);
    const identityKind = cleanString(lease.identityKind);
    const leaseProfile = cleanString(lease.leaseProfile);
    if (identityKind !== 'user' && identityKind !== 'anonymous') {
        throw new Error('Launcher lease has an invalid identityKind.');
    }
    if (leaseProfile !== 'employee' && leaseProfile !== 'feishu' && leaseProfile !== 'anonymous') {
        throw new Error(`Unsupported Linux H2I leaseProfile: ${leaseProfile ?? 'missing'}`);
    }
    const capability = requireString(cleanString(lease.capability), 'lease.capability');
    if (!/^mxlc1\.[A-Za-z0-9_-]{43}$/.test(capability)) {
        throw new Error('Launcher lease returned an invalid capability.');
    }
    const leaseIp = requireIpv4(cleanString(lease.leaseIp), 'lease.leaseIp');
    const cidr = requireIpv4Cidr(cleanString(lease.cidr), 'lease.cidr');
    if (!cidrContainsIpv4(cidr, leaseIp)) {
        throw new Error('Launcher lease IP is outside lease.cidr.');
    }
    const status = requireSafeString(cleanString(lease.status), 'lease.status');
    if (status !== 'active')
        throw new Error(`Launcher lease is not active (status=${status}).`);
    const launcherMode = requireSafeString(cleanString(lease.launcherMode), 'lease.launcherMode');
    if (launcherMode !== 'standalone') {
        throw new Error(`Launcher lease has unsupported launcherMode=${launcherMode}.`);
    }
    return {
        leaseId: requireSafeString(cleanString(lease.leaseId), 'lease.leaseId'),
        capability,
        productId: requireSafeString(cleanString(lease.productId), 'lease.productId'),
        identityKind,
        leaseProfile,
        installId: requireSafeString(cleanString(lease.installId), 'lease.installId'),
        deviceId: requireSafeString(cleanString(lease.deviceId), 'lease.deviceId'),
        siteId: requireSafeString(cleanString(lease.siteId), 'lease.siteId'),
        userId: lease.userId == null
            ? undefined
            : requireSafeString(cleanString(lease.userId), 'lease.userId'),
        cidr,
        leaseIp,
        publicKey: requireWireGuardKey(cleanString(lease.publicKey), 'lease.publicKey'),
        launcherMode,
        status,
        expiresAt: cleanString(lease.expiresAt) ?? undefined,
    };
}
function parseRelayRoutePlan(input) {
    const plan = record(input);
    const identityKind = cleanString(plan.identityKind);
    if (identityKind !== 'user' && identityKind !== 'anonymous') {
        throw new Error('V2 routePlan has an invalid identityKind.');
    }
    const routeCidrs = uniqueStrings(stringArray(plan.routeCidrs).map((cidr) => requireIpv4Cidr(cidr, 'routePlan.routeCidrs[]')));
    if (!routeCidrs.length)
        throw new Error('V2 routePlan.routeCidrs is empty.');
    if (routeCidrs.some((cidr) => cidr === '0.0.0.0/0')) {
        throw new Error('V2 H2I refuses a default-route AllowedIPs plan.');
    }
    const leaseIp = requireIpv4(cleanString(plan.leaseIp), 'routePlan.leaseIp');
    const leaseCidr = requireIpv4Cidr(cleanString(plan.leaseCidr), 'routePlan.leaseCidr');
    const internalControlIp = requireIpv4(cleanString(plan.internalControlIp), 'routePlan.internalControlIp');
    if (!routeCidrs.some((cidr) => cidrContainsIpv4(cidr, leaseIp))) {
        throw new Error('V2 routePlan.routeCidrs does not contain the lease IP.');
    }
    if (!routeCidrs.some((cidr) => cidrContainsIpv4(cidr, internalControlIp))) {
        throw new Error('V2 routePlan.routeCidrs does not contain the Internal control IP.');
    }
    return {
        productId: requireSafeString(cleanString(plan.productId), 'routePlan.productId'),
        identityKind,
        leaseIp,
        leaseCidr,
        internalControlIp,
        internalBaseUrl: requireInternalBaseUrl(cleanString(plan.internalBaseUrl), routeCidrs),
        domesticRelayEndpoint: requireWireGuardEndpoint(cleanString(plan.domesticRelayEndpoint), 'routePlan.domesticRelayEndpoint'),
        domesticRelayPublicKey: requireWireGuardKey(cleanString(plan.domesticRelayPublicKey), 'routePlan.domesticRelayPublicKey'),
        dnsServer: plan.dnsServer == null
            ? undefined
            : requireDnsServer(cleanString(plan.dnsServer), 'routePlan.dnsServer'),
        routeCidrs,
        snapshotId: requireSafeString(cleanString(plan.snapshotId), 'routePlan.snapshotId'),
        snapshotDigest: requireSafeString(cleanString(plan.snapshotDigest), 'routePlan.snapshotDigest'),
    };
}
function assertNetworkSessionContract(input) {
    const expectedUserId = input.identityKind === 'user'
        ? requireSafeString(input.userId, 'authenticated userId')
        : undefined;
    const mismatch = (label, actual, expected) => {
        if (actual !== expected) {
            throw new Error(`V2 session contract mismatch for ${label}.`);
        }
    };
    mismatch('lease.productId', input.lease.productId, input.productId);
    mismatch('lease.identityKind', input.lease.identityKind, input.identityKind);
    mismatch('lease.leaseProfile', input.lease.leaseProfile, input.leaseProfile);
    mismatch('lease.installId', input.lease.installId, input.installId);
    mismatch('lease.deviceId', input.lease.deviceId, input.deviceId);
    mismatch('lease.userId', input.lease.userId, expectedUserId);
    mismatch('lease.publicKey', input.lease.publicKey, input.publicKey);
    if (input.requestedSiteId)
        mismatch('lease.siteId', input.lease.siteId, input.requestedSiteId);
    mismatch('routePlan.productId', input.routePlan.productId, input.productId);
    mismatch('routePlan.identityKind', input.routePlan.identityKind, input.identityKind);
    mismatch('routePlan.leaseIp', input.routePlan.leaseIp, input.lease.leaseIp);
    mismatch('routePlan.leaseCidr', input.routePlan.leaseCidr, input.lease.cidr);
    const snapshot = record(input.snapshot);
    const overlay = record(snapshot.overlayPolicy);
    mismatch('snapshot.appId', cleanString(snapshot.appId), input.productId);
    mismatch('snapshot.installId', cleanString(snapshot.installId), input.installId);
    mismatch('snapshot.deviceId', cleanString(snapshot.deviceId), input.deviceId);
    mismatch('snapshot.userId', cleanString(snapshot.userId), expectedUserId);
    mismatch('snapshot.overlayPolicy.productId', cleanString(overlay.productId), input.productId);
    mismatch('snapshot.overlayPolicy.launcherMode', cleanString(overlay.launcherMode), 'standalone');
    mismatch('snapshot.overlayPolicy.identityKind', cleanString(overlay.identityKind), input.identityKind);
    mismatch('snapshot.overlayPolicy.leaseProfile', cleanString(overlay.leaseProfile), input.leaseProfile);
    mismatch('snapshot.overlayPolicy.cidr', requireIpv4Cidr(cleanString(overlay.cidr), 'snapshot.overlayPolicy.cidr'), input.lease.cidr);
    mismatch('snapshot.overlayPolicy.leaseIp', requireIpv4(cleanString(overlay.leaseIp), 'snapshot.overlayPolicy.leaseIp'), input.lease.leaseIp);
    mismatch('routePlan.snapshotId', input.routePlan.snapshotId, cleanString(snapshot.snapshotId));
}
function renderRelayConfig(privateKey, plan, dnsEnabled, interfaceName) {
    const routeProbe = (0, electron_core_wireguard_1.buildHdoRouteProbe)({ hdoCidrs: plan.routeCidrs });
    const filteredProbe = withoutCurrentTunnelRoutes(routeProbe, interfaceName);
    const exclusions = (0, electron_core_wireguard_1.localCidrsForAllowedIpExclusion)(filteredProbe, plan.routeCidrs);
    const allowedIps = (0, electron_core_wireguard_1.excludeLocalRoutesFromAllowedIps)(plan.routeCidrs, exclusions);
    if (!allowedIps.length) {
        throw new Error('V2 routePlan overlaps the host network completely; refusing to install an unusable WireGuard profile.');
    }
    const dnsServer = dnsEnabled ? dnsHost(plan.dnsServer) : null;
    return (0, electron_core_wireguard_1.renderWireGuardInterface)({
        privateKey,
        addresses: [`${plan.leaseIp}/32`],
        dns: dnsServer ? [dnsServer] : undefined,
        peers: [{
                name: 'MX H2I Domestic Relay',
                publicKey: plan.domesticRelayPublicKey,
                endpoint: plan.domesticRelayEndpoint,
                allowedIps,
                persistentKeepalive: 25,
            }],
    });
}
function withoutCurrentTunnelRoutes(probe, interfaceName) {
    const ownInterface = interfaceName.toLowerCase();
    const ownCidrs = new Set(probe.routes
        .filter((route) => route.interfaceName?.toLowerCase() === ownInterface)
        .map((route) => canonicalIpv4Cidr(route.cidr))
        .filter((cidr) => Boolean(cidr)));
    if (!ownCidrs.size)
        return probe;
    const otherCidrs = new Set(probe.routes
        .filter((route) => route.interfaceName?.toLowerCase() !== ownInterface)
        .map((route) => canonicalIpv4Cidr(route.cidr))
        .filter((cidr) => Boolean(cidr)));
    return {
        ...probe,
        localCidrs: probe.localCidrs.filter((cidr) => {
            const normalized = canonicalIpv4Cidr(cidr);
            return !normalized || !ownCidrs.has(normalized) || otherCidrs.has(normalized);
        }),
    };
}
function resolveKeyPair(previous, installDir) {
    if (previous.privateKey && previous.publicKey) {
        return {
            privateKey: requireWireGuardKey(previous.privateKey, 'persisted WireGuard privateKey'),
            publicKey: requireWireGuardKey(previous.publicKey, 'persisted WireGuard publicKey'),
        };
    }
    const runtime = (0, electron_core_wireguard_1.resolveWireGuardRuntime)({
        installDir,
        allowSystemFallback: true,
    });
    if (!runtime.command) {
        throw new Error(`${runtime.error ?? 'WireGuard wg command is unavailable'}. Install wireguard-tools before H2I enrollment.`);
    }
    const wgCommand = trustedRootExecutablePath(runtime.command, 'WireGuard wg');
    const generated = (0, electron_core_wireguard_1.generateWireGuardKeyPairWithCli)(wgCommand);
    return {
        privateKey: requireWireGuardKey(generated.privateKey, 'generated WireGuard privateKey'),
        publicKey: requireWireGuardKey(generated.publicKey, 'generated WireGuard publicKey'),
    };
}
function captureLocalTunnelSnapshot(interfaceName, configPath, installDir) {
    const runtime = trustedRootConnectionRuntime((0, electron_core_wireguard_1.resolveWireGuardConnectionRuntime)({
        installDir,
        allowSystemFallback: true,
    }));
    const unitPath = h2iSystemdUnitPath(interfaceName);
    const unit = (0, node_fs_1.existsSync)(unitPath)
        ? readManagedH2iSystemdUnit(interfaceName)
        : undefined;
    const systemdAvailable = commandAvailable('systemctl')
        && configPath === defaultConfigPath(interfaceName)
        && Boolean(unit);
    const service = h2iSystemdService(interfaceName);
    const serviceActive = systemdAvailable
        && systemdUnitActive(service);
    const systemdEnablement = systemdAvailable
        ? systemdUnitEnablement(service)
        : 'disabled';
    let tunnelActive = serviceActive;
    if (!tunnelActive && (0, node_fs_1.existsSync)(configPath) && runtime.available) {
        tunnelActive = wireGuardTunnelActive(runtime, configPath, interfaceName);
    }
    return {
        configContent: (0, node_fs_1.existsSync)(configPath) ? (0, node_fs_1.readFileSync)(configPath, 'utf8') : undefined,
        runtime,
        systemd: Boolean(serviceActive || systemdEnablement !== 'disabled'),
        tunnelActive,
        systemdActive: serviceActive,
        systemdEnablement,
        systemdUnitExisted: Boolean(unit),
        systemdUnitContent: unit?.content,
        systemdUnitMode: unit?.mode,
    };
}
async function startSystemTunnel(interfaceName, configPath, installDir) {
    const runtime = trustedRootConnectionRuntime((0, electron_core_wireguard_1.resolveWireGuardConnectionRuntime)({
        installDir,
        allowSystemFallback: true,
    }));
    if (!runtime.available) {
        throw new Error(`${runtime.error ?? 'WireGuard runtime is unavailable'}. On Ubuntu run: apt-get install wireguard-tools`);
    }
    if (commandAvailable('systemctl') &&
        configPath === defaultConfigPath(interfaceName)) {
        const service = h2iSystemdService(interfaceName);
        ensureH2iSystemdUnit(runtime, interfaceName);
        runRequired('systemctl', ['daemon-reload']);
        try {
            runRequired('systemctl', ['restart', service]);
        }
        catch (error) {
            (0, node_child_process_1.spawnSync)('systemctl', ['disable', '--now', service], {
                stdio: 'ignore',
            });
            throw error;
        }
        return {
            message: `Started ${service}; boot enablement is pending verification.`,
            runtime,
            systemd: true,
        };
    }
    const result = await (0, electron_core_wireguard_1.setWireGuardTunnelState)({ runtime, configPath, action: 'restart' });
    if (!result.ok) {
        try {
            await (0, electron_core_wireguard_1.setWireGuardTunnelState)({ runtime, configPath, action: 'down' });
        }
        catch {
            // The primary restart error remains the actionable failure.
        }
        throw new Error(result.message);
    }
    return {
        message: `${result.message} Boot persistence was not enabled because systemd wg-quick is unavailable.`,
        runtime,
        systemd: false,
    };
}
function completeSystemTunnelStart(interfaceName, started) {
    if (!started.systemd)
        return started.message;
    const service = h2iSystemdService(interfaceName);
    runRequired('systemctl', ['enable', service]);
    if (!systemdUnitEnabled(service)) {
        throw new Error(`${service} did not become enabled.`);
    }
    return `Started and enabled ${service}.`;
}
async function rollbackSystemTunnelStart(interfaceName, configPath, started, snapshot, restorePrevious) {
    const runtime = started?.runtime ?? snapshot?.runtime;
    let configRestored = false;
    try {
        if (!runtime)
            throw new Error('WireGuard runtime snapshot is unavailable.');
        await stopCurrentTunnelForRollback(interfaceName, configPath, runtime);
        restoreH2iSystemdUnitSnapshot(interfaceName, snapshot);
        if (restorePrevious && snapshot?.configContent !== undefined) {
            writeWireGuardConfig(configPath, snapshot.configContent);
            configRestored = true;
            await restoreLocalTunnelState(interfaceName, configPath, snapshot);
            return {
                message: 'The previous WireGuard config, systemd unit, and service state were restored.',
                restoredPrevious: true,
            };
        }
        return {
            message: 'The new local WireGuard tunnel was stopped and disabled.',
            restoredPrevious: false,
        };
    }
    catch (error) {
        return {
            message: `Automatic tunnel rollback also failed: ${errorMessage(error)}`,
            restoredPrevious: configRestored,
        };
    }
}
async function stopCurrentTunnelForRollback(interfaceName, configPath, runtime) {
    const service = h2iSystemdService(interfaceName);
    const unitPath = h2iSystemdUnitPath(interfaceName);
    const managedSystemd = commandAvailable('systemctl') && (0, node_fs_1.existsSync)(unitPath);
    if (managedSystemd) {
        readManagedH2iSystemdUnit(interfaceName);
        if (systemdUnitActive(service))
            runRequired('systemctl', ['stop', service]);
        if (systemdUnitActive(service)) {
            throw new Error(`${service} remained active during rollback.`);
        }
    }
    if (wireGuardTunnelActive(runtime, configPath, interfaceName)) {
        const stopped = await (0, electron_core_wireguard_1.setWireGuardTunnelState)({ runtime, configPath, action: 'down' });
        if (!stopped.ok)
            throw new Error(stopped.message);
    }
    if (wireGuardTunnelActive(runtime, configPath, interfaceName)) {
        throw new Error(`WireGuard interface ${interfaceName} remained active during rollback.`);
    }
    if (managedSystemd) {
        disableSystemdUnit(service);
        if (systemdUnitEnabled(service)) {
            throw new Error(`${service} remained enabled during rollback.`);
        }
    }
}
function restoreH2iSystemdUnitSnapshot(interfaceName, snapshot) {
    const unitPath = h2iSystemdUnitPath(interfaceName);
    if (snapshot?.systemdUnitExisted && snapshot.systemdUnitContent) {
        atomicWriteFile(unitPath, snapshot.systemdUnitContent, snapshot.systemdUnitMode ?? 0o644, 0o755);
    }
    else if ((0, node_fs_1.existsSync)(unitPath)) {
        readManagedH2iSystemdUnit(interfaceName);
        (0, node_fs_1.rmSync)(unitPath, { force: true });
        fsyncDirectory((0, node_path_1.dirname)(unitPath));
    }
    if (commandAvailable('systemctl'))
        runRequired('systemctl', ['daemon-reload']);
}
async function restoreLocalTunnelState(interfaceName, configPath, snapshot) {
    const service = h2iSystemdService(interfaceName);
    if (snapshot.systemdUnitExisted && commandAvailable('systemctl')) {
        runRequired('systemctl', [snapshot.systemdActive ? 'restart' : 'stop', service]);
        const enableArgs = snapshot.systemdEnablement === 'enabled-runtime'
            ? ['enable', '--runtime', service]
            : [snapshot.systemdEnablement === 'enabled' ? 'enable' : 'disable', service];
        runRequired('systemctl', enableArgs);
    }
    let tunnelActive = wireGuardTunnelActive(snapshot.runtime, configPath, interfaceName);
    if (tunnelActive !== snapshot.tunnelActive) {
        const restored = await (0, electron_core_wireguard_1.setWireGuardTunnelState)({
            runtime: snapshot.runtime,
            configPath,
            action: snapshot.tunnelActive ? 'restart' : 'down',
        });
        if (!restored.ok)
            throw new Error(restored.message);
        tunnelActive = wireGuardTunnelActive(snapshot.runtime, configPath, interfaceName);
    }
    if (tunnelActive !== snapshot.tunnelActive) {
        throw new Error(`Restored WireGuard active state mismatch (expected ${snapshot.tunnelActive}, got ${tunnelActive}).`);
    }
    if (snapshot.systemdUnitExisted && commandAvailable('systemctl')) {
        const serviceActive = systemdUnitActive(service);
        if (serviceActive !== snapshot.systemdActive) {
            throw new Error(`Restored systemd active state mismatch (expected ${snapshot.systemdActive}, got ${serviceActive}).`);
        }
        const enablement = systemdUnitEnablement(service);
        if (enablement !== snapshot.systemdEnablement) {
            throw new Error(`Restored systemd enablement mismatch (expected ${snapshot.systemdEnablement}, got ${enablement}).`);
        }
    }
}
function assertDnsRuntimeReady(dnsEnabled) {
    if (!dnsEnabled || commandAvailable('resolvconf'))
        return;
    throw new Error('H2I DNS was explicitly enabled but resolvconf is unavailable. Install resolvconf/openresolv, or rerun without --dns to keep the host resolver unchanged.');
}
async function verifyInternalConnection(runtime, configPath, plan) {
    const healthUrl = internalHealthUrl(plan);
    const deadline = Date.now() + 15_000;
    let lastDetail = 'WireGuard has not completed a handshake.';
    while (Date.now() < deadline) {
        const status = (0, electron_core_wireguard_1.getWireGuardTunnelStatus)({ runtime, configPath });
        const handshakeReady = status.peers.some((peer) => peer.latestHandshakeSeconds !== null);
        if (status.active && handshakeReady) {
            const health = await probeHealth(healthUrl, 2_000);
            if (health.ok) {
                return {
                    ok: true,
                    healthUrl,
                    message: `WireGuard handshake and Internal health check passed (${healthUrl}).`,
                };
            }
            lastDetail = health.error ?? `Internal health returned HTTP ${health.status ?? 'unknown'}.`;
        }
        else if (status.error) {
            lastDetail = status.error;
        }
        await delay(750);
    }
    return {
        ok: false,
        healthUrl,
        message: `MX H2I tunnel started but did not prove Internal connectivity within 15s: ${lastDetail}`,
    };
}
async function probeHealth(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            redirect: 'error',
        });
        return { ok: response.ok, status: response.status };
    }
    catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
    finally {
        clearTimeout(timeout);
    }
}
async function requestJson(baseUrl, path, input) {
    const headers = { ...(input.headers ?? {}) };
    if (input.body !== undefined)
        headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
    try {
        const response = await fetch(`${baseUrl}${path}`, {
            method: input.method,
            headers,
            body: input.body === undefined ? undefined : JSON.stringify(input.body),
            signal: controller.signal,
            redirect: 'error',
        });
        const text = await response.text();
        const payload = parsePayload(text);
        if (!response.ok) {
            throw new Error(`H2I API ${input.method} ${path} failed: HTTP ${response.status}${apiErrorDetail(payload)}`);
        }
        return payload;
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`H2I API ${input.method} ${path} timed out.`);
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
    }
}
function scopedLauncherFetch(baseUrl, timeoutMs) {
    const allowedOrigin = new URL(baseUrl).origin;
    return async (input, init) => {
        const target = new URL(input);
        if (target.origin !== allowedOrigin) {
            throw new Error(`MX Launcher request escaped the bootstrap origin: ${target.origin}`);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(target, {
                method: init?.method,
                headers: init?.headers,
                body: init?.body,
                signal: controller.signal,
                redirect: 'error',
            });
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`MX Launcher ${init?.method ?? 'GET'} ${target.pathname} timed out after ${Math.round(timeoutMs / 1000)}s; the server outcome may be unknown. Rerun the same h2i enroll command to reconcile safely.`);
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    };
}
function readState(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return {};
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`H2I state must be a regular file: ${path}`);
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0 && stat.uid !== 0) {
        throw new Error(`H2I state must be owned by root: ${path}`);
    }
    if ((stat.mode & 0o077) !== 0) {
        throw new Error(`H2I state must use root-only permissions: ${path}`);
    }
    if (stat.size > 1024 * 1024)
        throw new Error(`H2I state is unexpectedly large: ${path}`);
    const parsed = JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8'));
    return record(parsed);
}
function requireEnrolledState(state, path) {
    if (!state.lease?.leaseId || !state.privateKey || !state.publicKey) {
        throw new Error(`H2I enrollment state is missing: ${path}`);
    }
    return state;
}
function writeState(path, state) {
    atomicWritePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`);
}
function writeWireGuardConfig(path, content) {
    atomicWritePrivateFile(path, content);
}
function atomicWritePrivateFile(path, content) {
    atomicWriteFile(path, content, 0o600, 0o700);
}
function atomicWriteFile(path, content, mode, directoryMode) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true, mode: directoryMode });
    assertSecureParentDirectory(path);
    const temporaryPath = `${path}.tmp-${process.pid}-${(0, node_crypto_1.randomBytes)(6).toString('hex')}`;
    let fileDescriptor = null;
    try {
        fileDescriptor = (0, node_fs_1.openSync)(temporaryPath, 'wx', mode);
        (0, node_fs_1.fchmodSync)(fileDescriptor, mode);
        (0, node_fs_1.writeFileSync)(fileDescriptor, content, 'utf8');
        (0, node_fs_1.fsyncSync)(fileDescriptor);
        (0, node_fs_1.closeSync)(fileDescriptor);
        fileDescriptor = null;
        (0, node_fs_1.renameSync)(temporaryPath, path);
        fsyncDirectory((0, node_path_1.dirname)(path));
    }
    catch (error) {
        if (fileDescriptor !== null) {
            try {
                (0, node_fs_1.closeSync)(fileDescriptor);
            }
            catch {
                // Best effort cleanup after a failed durable write.
            }
        }
        (0, node_fs_1.rmSync)(temporaryPath, { force: true });
        throw error;
    }
}
function assertSecureParentDirectory(path) {
    const parent = (0, node_path_1.dirname)(path);
    const stat = (0, node_fs_1.lstatSync)(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`H2I parent path must be a real directory: ${parent}`);
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0 && stat.uid !== 0) {
        throw new Error(`H2I parent directory must be owned by root: ${parent}`);
    }
    if ((stat.mode & 0o022) !== 0) {
        throw new Error(`H2I parent directory must not be group/world-writable: ${parent}`);
    }
}
function acquireH2iLock(path, label) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true, mode: 0o700 });
    assertSecureParentDirectory(path);
    const token = `${process.pid}-${(0, node_crypto_1.randomBytes)(16).toString('hex')}`;
    const owner = {
        pid: process.pid,
        hostname: (0, node_os_1.hostname)(),
        token,
        createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let descriptor = null;
        try {
            descriptor = (0, node_fs_1.openSync)(path, 'wx', 0o600);
            (0, node_fs_1.fchmodSync)(descriptor, 0o600);
            (0, node_fs_1.writeFileSync)(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
            (0, node_fs_1.fsyncSync)(descriptor);
            (0, node_fs_1.closeSync)(descriptor);
            descriptor = null;
            fsyncDirectory((0, node_path_1.dirname)(path));
            return () => {
                try {
                    const current = record(JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8')));
                    if (cleanString(current.token) !== token)
                        return;
                    (0, node_fs_1.rmSync)(path, { force: true });
                    fsyncDirectory((0, node_path_1.dirname)(path));
                }
                catch (error) {
                    if (errorCode(error) !== 'ENOENT')
                        throw error;
                }
            };
        }
        catch (error) {
            if (descriptor !== null)
                (0, node_fs_1.closeSync)(descriptor);
            if (errorCode(error) !== 'EEXIST')
                throw error;
            let existing;
            try {
                existing = record(JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8')));
            }
            catch {
                throw new Error(`${label} lock exists but cannot be validated: ${path}`);
            }
            const lockPid = Number(existing.pid);
            const lockHost = cleanString(existing.hostname);
            if (!Number.isInteger(lockPid) || lockPid <= 0 || !lockHost) {
                throw new Error(`${label} lock has invalid owner metadata: ${path}`);
            }
            if (lockHost !== (0, node_os_1.hostname)() || processIsAlive(lockPid)) {
                throw new Error(`${label} is already locked by pid ${lockPid} on ${lockHost}: ${path}`);
            }
            const stalePath = `${path}.stale-${token}`;
            try {
                (0, node_fs_1.renameSync)(path, stalePath);
                (0, node_fs_1.rmSync)(stalePath, { force: true });
                fsyncDirectory((0, node_path_1.dirname)(path));
            }
            catch (renameError) {
                if (errorCode(renameError) !== 'ENOENT')
                    throw renameError;
            }
        }
    }
    throw new Error(`Could not acquire ${label} lock: ${path}`);
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return errorCode(error) !== 'ESRCH';
    }
}
function captureConfigGuard(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return { path, existed: false };
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`WireGuard config must be a regular file: ${path}`);
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0 && stat.uid !== 0) {
        throw new Error(`WireGuard config must be owned by root: ${path}`);
    }
    if ((stat.mode & 0o077) !== 0) {
        throw new Error(`WireGuard config must use root-only permissions: ${path}`);
    }
    return { path, existed: true, content: (0, node_fs_1.readFileSync)(path, 'utf8') };
}
function assertConfigGuardUnchanged(guard) {
    const exists = (0, node_fs_1.existsSync)(guard.path);
    if (exists !== guard.existed) {
        throw new Error(`WireGuard config changed during H2I enrollment: ${guard.path}`);
    }
    if (!exists)
        return;
    const current = captureConfigGuard(guard.path);
    if (current.content !== guard.content) {
        throw new Error(`WireGuard config changed during H2I enrollment: ${guard.path}`);
    }
}
function wireGuardTunnelActive(runtime, configPath, interfaceName) {
    if ((0, node_fs_1.existsSync)(configPath)) {
        try {
            if ((0, electron_core_wireguard_1.getWireGuardTunnelStatus)({ runtime, configPath }).active)
                return true;
        }
        catch {
            // Fall through to a direct kernel interface query.
        }
    }
    const wg = runtime.wg.command;
    if (!wg) {
        throw new Error(runtime.error ?? 'WireGuard wg command is unavailable for state verification.');
    }
    const result = (0, node_child_process_1.spawnSync)(wg, ['show', interfaceName], { stdio: 'ignore' });
    if (result.error)
        throw result.error;
    if (result.signal) {
        throw new Error(`wg show ${interfaceName} was terminated by ${result.signal}.`);
    }
    if (result.status === 0)
        return true;
    if (result.status === 1)
        return false;
    throw new Error(`Could not prove WireGuard interface ${interfaceName} state (exit=${result.status ?? 'unknown'}).`);
}
function fsyncDirectory(path) {
    let directoryDescriptor = null;
    try {
        directoryDescriptor = (0, node_fs_1.openSync)(path, 'r');
        (0, node_fs_1.fsyncSync)(directoryDescriptor);
    }
    catch (error) {
        const code = errorCode(error);
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes(code))
            throw error;
    }
    finally {
        if (directoryDescriptor !== null)
            (0, node_fs_1.closeSync)(directoryDescriptor);
    }
}
function errorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code ?? '')
        : '';
}
function resolveStateFile(input) {
    return (0, node_path_1.resolve)(input || '/etc/qpjoy/h2i/client.json');
}
function resolveConfigPath(input, interfaceName) {
    return (0, node_path_1.resolve)(input || defaultConfigPath(interfaceName));
}
function defaultConfigPath(interfaceName) {
    return `/etc/wireguard/${interfaceName}.conf`;
}
function assertConfigPathMatchesInterface(configPath, interfaceName) {
    if ((0, node_path_1.basename)(configPath) !== `${interfaceName}.conf`) {
        throw new Error(`WireGuard config basename must be ${interfaceName}.conf so wg-quick and H2I agree on the interface name.`);
    }
}
function h2iInterfaceLockPath(interfaceName) {
    if (process.platform === 'linux' &&
        typeof process.getuid === 'function' &&
        process.getuid() === 0) {
        return `/run/lock/qpjoy-h2i/${interfaceName}.lock`;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return (0, node_path_1.resolve)(process.env.TMPDIR || '/tmp', `qpjoy-h2i-locks-${uid}`, `${interfaceName}.lock`);
}
function wireGuardConfigBelongsToState(path, privateKey, leaseIp) {
    const expectedPrivateKey = cleanString(privateKey);
    if (!expectedPrivateKey)
        return false;
    const content = (0, node_fs_1.readFileSync)(path, 'utf8');
    const configuredPrivateKey = /^\s*PrivateKey\s*=\s*(\S+)\s*$/m.exec(content)?.[1];
    if (configuredPrivateKey !== expectedPrivateKey)
        return false;
    if (!leaseIp)
        return false;
    const addresses = /^\s*Address\s*=\s*(.+)$/gmi;
    for (const match of content.matchAll(addresses)) {
        if (match[1].split(',').map((value) => value.trim()).includes(`${leaseIp}/32`))
            return true;
    }
    return false;
}
function resolveInstallDir(input) {
    return (0, node_path_1.resolve)(input || '/usr/local/lib/qpjoy/h2i/bin');
}
function secureBootstrapUrl(value) {
    const clean = cleanString(value);
    if (!clean)
        throw new Error('Missing --bootstrap-url/H2I_BOOTSTRAP_URL.');
    let parsed;
    try {
        parsed = new URL(clean);
    }
    catch {
        throw new Error(`Invalid H2I bootstrap URL: ${clean}`);
    }
    const hostnameValue = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostnameValue);
    if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
        throw new Error('H2I bootstrap must use HTTPS (HTTP is allowed only for loopback tests).');
    }
    if (parsed.username || parsed.password) {
        throw new Error('H2I bootstrap URL must not contain username/password userinfo.');
    }
    if (parsed.search || parsed.hash) {
        throw new Error('H2I bootstrap URL must not contain query or fragment components.');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
}
function secretOption(direct, file, environment) {
    if (direct)
        throw new Error('Secrets must not be supplied in argv.');
    if (file) {
        const path = (0, node_path_1.resolve)(file);
        const descriptor = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
        try {
            const stat = (0, node_fs_1.fstatSync)(descriptor);
            if (!stat.isFile())
                throw new Error(`H2I secret file must be a regular file: ${path}`);
            if ((stat.mode & 0o077) !== 0) {
                throw new Error(`H2I secret file must not be accessible by group/others (use chmod 600): ${path}`);
            }
            const allowedOwners = new Set();
            if (typeof process.getuid === 'function')
                allowedOwners.add(process.getuid());
            const sudoUid = Number(process.env.SUDO_UID);
            if (Number.isInteger(sudoUid) && sudoUid >= 0)
                allowedOwners.add(sudoUid);
            if (allowedOwners.size && !allowedOwners.has(stat.uid)) {
                throw new Error(`H2I secret file has an unexpected owner: ${path}`);
            }
            if (stat.size > 1024 * 1024)
                throw new Error(`H2I secret file is unexpectedly large: ${path}`);
            return cleanString((0, node_fs_1.readFileSync)(descriptor, 'utf8'));
        }
        finally {
            (0, node_fs_1.closeSync)(descriptor);
        }
    }
    return cleanString(environment) ?? undefined;
}
function assertStableIdentity(previous, identityKind, productId, username) {
    if (!stateEnrollmentBound(previous))
        return;
    if (previous.identityKind && previous.identityKind !== identityKind) {
        throw new Error('Changing between anonymous and account identity requires a separate --state-file and --interface.');
    }
    if (previous.productId && previous.productId !== productId) {
        throw new Error('Changing productId requires a separate --state-file and --interface.');
    }
    if (previous.username && username && previous.username !== username) {
        throw new Error('Changing the H2I account requires a separate --state-file and --interface.');
    }
}
function assertStableLocalPaths(previous, options, interfaceName, configPath) {
    if (!stateEnrollmentBound(previous))
        return;
    if (previous.interfaceName && options.interfaceName && previous.interfaceName !== interfaceName) {
        throw new Error('Changing the H2I interface requires a separate --state-file.');
    }
    if (previous.configPath &&
        options.configPath &&
        (0, node_path_1.resolve)(previous.configPath) !== configPath) {
        throw new Error('Changing the H2I WireGuard config path requires a separate --state-file.');
    }
}
function stateEnrollmentBound(state) {
    return Boolean(state.lease?.leaseId || state.enrollmentAttemptedAt);
}
function mintLeaseCapability() {
    return `mxlc1.${(0, node_crypto_1.randomBytes)(32).toString('base64url')}`;
}
function internalHealthUrl(plan) {
    const internalIp = requireIpv4(plan.internalControlIp, 'routePlan.internalControlIp');
    const configured = cleanString(plan.internalBaseUrl);
    let port = '18090';
    if (configured) {
        const parsed = new URL(configured);
        port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    }
    return `http://${internalIp}:${port}/healthz`;
}
function dnsHost(value) {
    const clean = cleanString(value);
    if (!clean)
        return null;
    const ipv4WithPort = /^(.+):(\d{1,5})$/.exec(clean);
    return requireIpv4(ipv4WithPort?.[1] ?? clean, 'routePlan.dnsServer');
}
function sanitizeInterfaceName(value) {
    const clean = value.trim();
    if (!/^[A-Za-z0-9_.-]{1,15}$/.test(clean)) {
        throw new Error(`Invalid WireGuard interface name: ${value}`);
    }
    return clean;
}
function sanitizeId(value) {
    const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean)
        throw new Error(`Invalid identifier: ${value}`);
    return clean.slice(0, 160);
}
function userIdFromSubject(value) {
    const match = value?.match(/^user:(.+)$/);
    return cleanString(match?.[1]) ?? undefined;
}
function requireIpv4(value, label) {
    const clean = requireSafeString(value, label);
    const octets = parseIpv4Octets(clean);
    if (!octets)
        throw new Error(`${label} must be a canonical IPv4 address.`);
    return octets.join('.');
}
function requireIpv4Cidr(value, label) {
    const clean = requireSafeString(value, label);
    const match = /^(.+)\/(\d{1,2})$/.exec(clean);
    if (!match)
        throw new Error(`${label} must be an IPv4 CIDR.`);
    const ip = requireIpv4(match[1], label);
    const prefix = Number(match[2]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`${label} must use an IPv4 prefix between 0 and 32.`);
    }
    const network = (ipv4Number(ip) & ipv4Mask(prefix)) >>> 0;
    const canonical = `${ipv4FromNumber(network)}/${prefix}`;
    if (`${ip}/${prefix}` !== canonical) {
        throw new Error(`${label} must use a canonical network address.`);
    }
    return canonical;
}
function canonicalIpv4Cidr(value) {
    try {
        return requireIpv4Cidr(cleanString(value), 'CIDR');
    }
    catch {
        return null;
    }
}
function cidrContainsIpv4(cidr, ip) {
    const [network, prefixText] = cidr.split('/');
    const prefix = Number(prefixText);
    if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > 32)
        return false;
    const mask = ipv4Mask(prefix);
    return ((ipv4Number(network) & mask) >>> 0) === ((ipv4Number(ip) & mask) >>> 0);
}
function parseIpv4Octets(value) {
    const parts = value.split('.');
    if (parts.length !== 4 ||
        parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
        return null;
    }
    return parts.map(Number);
}
function ipv4Number(value) {
    const octets = parseIpv4Octets(value);
    if (!octets)
        throw new Error(`Invalid IPv4 address: ${value}`);
    return octets.reduce((out, octet) => ((out << 8) | octet) >>> 0, 0);
}
function ipv4Mask(prefix) {
    return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
function ipv4FromNumber(value) {
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}
function requireDnsServer(value, label) {
    const clean = requireSafeString(value, label);
    const withPort = /^(.+):(\d{1,5})$/.exec(clean);
    if (!withPort)
        return requireIpv4(clean, label);
    const host = requireIpv4(withPort[1], label);
    const port = requirePort(withPort[2], label);
    return `${host}:${port}`;
}
function requireWireGuardEndpoint(value, label) {
    const clean = requireSafeString(value, label);
    const ipv6 = /^\[([0-9A-Fa-f:.]+)]:(\d{1,5})$/.exec(clean);
    if (ipv6) {
        let parsed;
        try {
            parsed = new URL(`http://${clean}`);
        }
        catch {
            throw new Error(`${label} has an invalid bracketed IPv6 address.`);
        }
        if (!parsed.hostname.includes(':'))
            throw new Error(`${label} has an invalid IPv6 address.`);
        return `[${ipv6[1]}]:${requirePort(ipv6[2], label)}`;
    }
    const match = /^([^:]+):(\d{1,5})$/.exec(clean);
    if (!match)
        throw new Error(`${label} must be host:port or [IPv6]:port.`);
    const ipv4Like = /^\d+(?:\.\d+){3}$/.test(match[1]);
    const host = parseIpv4Octets(match[1]) || ipv4Like
        ? requireIpv4(match[1], label)
        : requireDnsName(match[1], label);
    return `${host}:${requirePort(match[2], label)}`;
}
function requireDnsName(value, label) {
    if (value.length > 253 || value.endsWith('.') || value.includes('..')) {
        throw new Error(`${label} has an invalid DNS host.`);
    }
    const labels = value.split('.');
    if (labels.some((part) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) {
        throw new Error(`${label} has an invalid DNS host.`);
    }
    return value.toLowerCase();
}
function requirePort(value, label) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${label} has an invalid port.`);
    }
    return port;
}
function requireWireGuardKey(value, label) {
    const clean = requireSafeString(value, label);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(clean)) {
        throw new Error(`${label} must be a standard padded WireGuard base64 key.`);
    }
    const decoded = Buffer.from(clean, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== clean) {
        throw new Error(`${label} must decode to exactly 32 bytes.`);
    }
    return clean;
}
function requireInternalBaseUrl(value, routeCidrs) {
    const clean = requireSafeString(value, 'routePlan.internalBaseUrl');
    let parsed;
    try {
        parsed = new URL(clean);
    }
    catch {
        throw new Error('routePlan.internalBaseUrl must be a valid URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error('routePlan.internalBaseUrl must use HTTP(S) without userinfo.');
    }
    if (parsed.search || parsed.hash) {
        throw new Error('routePlan.internalBaseUrl must not contain a query or fragment.');
    }
    const host = requireIpv4(parsed.hostname, 'routePlan.internalBaseUrl host');
    if (!routeCidrs.some((cidr) => cidrContainsIpv4(cidr, host))) {
        throw new Error('routePlan.internalBaseUrl is outside routePlan.routeCidrs.');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
}
function requireSafeString(value, label) {
    const clean = requireString(value, label);
    if (/[\u0000-\u001f\u007f]/.test(clean)) {
        throw new Error(`${label} contains control characters.`);
    }
    if (clean.length > 4096)
        throw new Error(`${label} is unexpectedly long.`);
    return clean;
}
function requireString(value, label) {
    if (!value)
        throw new Error(`${label} is required.`);
    return value;
}
function cleanString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.map(cleanString).filter((item) => Boolean(item))
        : [];
}
function uniqueStrings(values) {
    return [...new Set(values.map(cleanString).filter((item) => Boolean(item)))];
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function parsePayload(text) {
    if (!text.trim())
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function apiErrorDetail(payload) {
    const message = safeDisplayText(cleanString(record(payload).message));
    if (message)
        return `: ${message.slice(0, 500)}`;
    if (typeof payload === 'string' && payload.trim()) {
        return `: ${safeDisplayText(payload.trim()).slice(0, 500)}`;
    }
    return '';
}
function safeDisplayText(value) {
    return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}
function trustedRootConnectionRuntime(runtime) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0)
        return runtime;
    const trust = (tool, label) => {
        if (!tool?.command)
            return tool;
        return { ...tool, command: trustedRootExecutablePath(tool.command, label) };
    };
    return {
        ...runtime,
        wg: trust(runtime.wg, 'WireGuard wg') ?? runtime.wg,
        wgQuick: trust(runtime.wgQuick, 'WireGuard wg-quick'),
        wireGuardGo: trust(runtime.wireGuardGo, 'WireGuard wireguard-go'),
        bash: trust(runtime.bash, 'WireGuard bash'),
        windowsWireGuard: trust(runtime.windowsWireGuard, 'WireGuard service executable'),
    };
}
function trustedRootExecutablePath(command, label) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0)
        return command;
    if (!(0, node_path_1.isAbsolute)(command))
        throw new Error(`${label} path must be absolute for root execution.`);
    const realPath = (0, node_fs_1.realpathSync)(command);
    const executable = (0, node_fs_1.lstatSync)(realPath);
    if (!executable.isFile() || executable.isSymbolicLink()) {
        throw new Error(`${label} must resolve to a regular file: ${realPath}`);
    }
    if (executable.uid !== 0 || (executable.mode & 0o022) !== 0 || (executable.mode & 0o111) === 0) {
        throw new Error(`${label} must be root-owned, non-writable by group/others, and executable: ${realPath}`);
    }
    trustedRootDirectoryPath((0, node_path_1.dirname)(realPath), `${label} ancestor`);
    return realPath;
}
function trustedRootDirectoryPath(path, label) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0)
        return path;
    if (!(0, node_path_1.isAbsolute)(path))
        throw new Error(`${label} path must be absolute for root execution.`);
    const realPath = (0, node_fs_1.realpathSync)(path);
    let ancestor = realPath;
    while (true) {
        const stat = (0, node_fs_1.lstatSync)(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
            throw new Error(`${label} has an untrusted ancestor directory: ${ancestor}`);
        }
        if (ancestor === '/')
            break;
        ancestor = (0, node_path_1.dirname)(ancestor);
    }
    return realPath;
}
function h2iSystemdService(interfaceName) {
    return `qpjoy-h2i@${interfaceName}.service`;
}
function h2iSystemdUnitPath(interfaceName) {
    return `/etc/systemd/system/${h2iSystemdService(interfaceName)}`;
}
function readManagedH2iSystemdUnit(interfaceName) {
    const path = h2iSystemdUnitPath(interfaceName);
    const stat = (0, node_fs_1.lstatSync)(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing non-regular H2I systemd unit: ${path}`);
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0 && stat.uid !== 0) {
        throw new Error(`H2I systemd unit is not owned by root: ${path}`);
    }
    if ((stat.mode & 0o022) !== 0) {
        throw new Error(`H2I systemd unit is group/world-writable: ${path}`);
    }
    const content = (0, node_fs_1.readFileSync)(path, 'utf8');
    if (!content.includes(h2iSystemdUnitMarker)) {
        throw new Error(`Refusing unmanaged H2I systemd unit: ${path}`);
    }
    return { path, content, mode: stat.mode & 0o777 };
}
function assertH2iSystemdUnitAvailable(interfaceName) {
    const path = h2iSystemdUnitPath(interfaceName);
    if ((0, node_fs_1.existsSync)(path))
        readManagedH2iSystemdUnit(interfaceName);
}
function ensureH2iSystemdUnit(runtime, interfaceName) {
    const wgQuick = runtime.wgQuick?.command;
    if (!wgQuick) {
        throw new Error(runtime.error ?? 'wg-quick unavailable; cannot install systemd boot service.');
    }
    const unitPath = h2iSystemdUnitPath(interfaceName);
    const desired = renderH2iSystemdUnit(runtime, wgQuick, interfaceName);
    if ((0, node_fs_1.existsSync)(unitPath)) {
        const current = readManagedH2iSystemdUnit(interfaceName);
        if (current.content === desired && current.mode === 0o644)
            return;
    }
    atomicWriteFile(unitPath, desired, 0o644, 0o755);
    process.stdout.write(`Installed ${unitPath} for the H2I tunnel.\n`);
}
function renderH2iSystemdUnit(runtime, wgQuick, interfaceName) {
    const pathDirs = uniqueStrings([
        runtime.wg.command ? (0, node_path_1.dirname)(runtime.wg.command) : undefined,
        runtime.wgQuick?.command ? (0, node_path_1.dirname)(runtime.wgQuick.command) : undefined,
        runtime.wireGuardGo?.command ? (0, node_path_1.dirname)(runtime.wireGuardGo.command) : undefined,
        '/usr/local/sbin',
        '/usr/local/bin',
        '/usr/sbin',
        '/usr/bin',
        '/sbin',
        '/bin',
    ])
        .filter((path) => (0, node_fs_1.existsSync)(path))
        .map((path) => trustedRootDirectoryPath(path, 'H2I systemd PATH directory'));
    return `${h2iSystemdUnitMarker}
[Unit]
Description=QPJoy MX H2I WireGuard tunnel for ${interfaceName}
Documentation=man:wg-quick(8) man:wg(8)
Wants=network-online.target
After=network-online.target nss-lookup.target
ConditionPathExists=${defaultConfigPath(interfaceName)}

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=${systemdQuote(`PATH=${pathDirs.join(':')}`)}
Environment=WG_ENDPOINT_RESOLUTION_RETRIES=infinity
ExecStart=${systemdQuote(wgQuick)} up ${interfaceName}
ExecStop=${systemdQuote(wgQuick)} down ${interfaceName}

[Install]
WantedBy=multi-user.target
`;
}
function systemdQuote(value) {
    return `"${String(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function commandAvailable(command) {
    if (!/^[A-Za-z0-9._+-]+$/.test(command))
        return false;
    return (0, node_child_process_1.spawnSync)('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
        stdio: 'ignore',
    }).status === 0;
}
function runRequired(command, args) {
    const result = (0, node_child_process_1.spawnSync)(command, args, { stdio: 'inherit' });
    if (result.error)
        throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
    }
}
function systemdUnitActive(service) {
    const result = (0, node_child_process_1.spawnSync)('systemctl', ['is-active', service], { encoding: 'utf8' });
    if (result.error)
        throw result.error;
    if (result.signal)
        throw new Error(`systemctl is-active ${service} was terminated by ${result.signal}.`);
    const state = result.stdout.trim();
    if (result.status === 0 && state === 'active')
        return true;
    if (result.status === 3 && (state === 'inactive' || state === 'failed'))
        return false;
    throw new Error(`Could not prove systemd active state for ${service} (state=${state || 'unknown'}, exit=${result.status ?? 'unknown'}).`);
}
function systemdUnitEnabled(service) {
    return systemdUnitEnablement(service) !== 'disabled';
}
function disableSystemdUnit(service) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const enablement = systemdUnitEnablement(service);
        if (enablement === 'disabled')
            return;
        runRequired('systemctl', [
            'disable',
            ...(enablement === 'enabled-runtime' ? ['--runtime'] : []),
            service,
        ]);
    }
    throw new Error(`${service} remained enabled after disabling persistent and runtime scopes.`);
}
function systemdUnitEnablement(service) {
    const result = (0, node_child_process_1.spawnSync)('systemctl', ['is-enabled', service], { encoding: 'utf8' });
    if (result.error)
        throw result.error;
    if (result.signal)
        throw new Error(`systemctl is-enabled ${service} was terminated by ${result.signal}.`);
    const state = result.stdout.trim();
    if (result.status === 0 && (state === 'enabled' || state === 'enabled-runtime'))
        return state;
    if (result.status === 1 && state === 'disabled')
        return 'disabled';
    throw new Error(`Could not prove systemd enablement for ${service} (state=${state || 'unknown'}, exit=${result.status ?? 'unknown'}).`);
}
function requestId(prefix) {
    return `qp-tunnel-cli-h2i-${prefix}-${(0, node_crypto_1.randomUUID)()}`;
}
function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
