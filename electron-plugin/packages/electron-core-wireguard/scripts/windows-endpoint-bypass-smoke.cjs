const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  buildWireGuardTunnelCommand,
  renderWireGuardInterface
} = require('../dist/index.js');

const root = mkdtempSync(join(tmpdir(), "mx endpoint owners' bypass-"));
const runtime = {
  platform: 'win32',
  windowsWireGuard: { command: 'wireguard.exe' }
};

function createTunnel(appName, tunnelName, address) {
  const appDir = join(root, appName);
  const configPath = join(appDir, `${tunnelName}.conf`);
  const scriptDir = join(appDir, 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  return { configPath, scriptDir, address };
}

function writeProfile(tunnel, endpoint) {
  writeFileSync(tunnel.configPath, renderWireGuardInterface({
    privateKey: 'private-key',
    addresses: [tunnel.address],
    hdoDnsServers: ['10.88.0.1'],
    hdoDnsDomains: ['mxinfo-inc.cn'],
    suppressInterfaceDns: true,
    peers: [{
      publicKey: 'public-key',
      allowedIps: ['10.89.0.0/16', '10.88.0.1/32', '10.88.88.88/32'],
      endpoint
    }]
  }));
}

function buildAndRead(tunnel, action) {
  const before = new Set(readdirSync(tunnel.scriptDir));
  buildWireGuardTunnelCommand({
    runtime,
    configPath: tunnel.configPath,
    action
  });
  const name = readdirSync(tunnel.scriptDir)
    .find((candidate) => (
      !before.has(candidate)
      && candidate.includes(`.${action}.`)
      && candidate.endsWith('.elevated.ps1')
    ));
  assert.ok(name, `${action} must generate an elevated script`);
  const scriptPath = join(tunnel.scriptDir, name);
  if (process.platform === 'win32') {
    const powershell = process.env.SystemRoot
      ? join(
          process.env.SystemRoot,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        )
      : 'powershell.exe';
    const parsed = spawnSync(
      powershell,
      [
        '-NoProfile',
        '-Command',
        '[void][scriptblock]::Create([IO.File]::ReadAllText($env:QPJOY_WG_SMOKE_SCRIPT_PATH))'
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          QPJOY_WG_SMOKE_SCRIPT_PATH: scriptPath
        }
      }
    );
    assert.equal(
      parsed.status,
      0,
      `generated ${action} PowerShell must parse: ${parsed.error?.message || parsed.stderr}`
    );
  }
  return readFileSync(scriptPath, 'utf8');
}

function powerShellVariable(script, name) {
  const match = script.match(new RegExp(`^\\$${name} = '((?:[^']|'')*)'$`, 'm'));
  assert.ok(match, `${name} must be a literal PowerShell value`);
  return match[1].replace(/''/g, "'");
}

try {
  const mx = createTunnel('MX-H2I', 'mx-h2i', '10.89.100.13/32');
  const luopan = createTunnel('Luopan', 'luopan-h2i', '10.89.100.14/32');
  writeProfile(mx, '203.0.113.10:51280');
  writeProfile(luopan, '203.0.113.10:51280');
  const mxRestart = buildAndRead(mx, 'restart');
  const luopanRestart = buildAndRead(luopan, 'restart');
  const mxOwner = powerShellVariable(mxRestart, 'hdoEndpointBypassOwner');
  const luopanOwner = powerShellVariable(luopanRestart, 'hdoEndpointBypassOwner');

  for (const script of [mxRestart, luopanRestart]) {
    assert.ok(
      script.includes("$hdoEndpointBypassHosts = @('203.0.113.10')"),
      'both tunnels must plan the same configured public endpoint'
    );
    assert.ok(
      script.includes("$hdoEndpointBypassMutexName = 'Global\\QPJoy.WireGuard.EndpointBypass.v1'"),
      'all launcher processes must serialize endpoint ownership through one machine-wide mutex'
    );
    assert.ok(
      script.includes('$hdoEndpointBypassRegistryPath = Join-Path $hdoEndpointBypassStateDir "endpoint-bypass-registry.json"'),
      'all launcher processes must use one ProgramData ownership registry'
    );
    assert.match(
      script,
      /Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0\.0\.0\.0\/0"/,
      'the bypass must select a physical IPv4 default route'
    );
    assert.match(
      script,
      /\$nextParts\[0\] -eq 198[\s\S]*\$nextParts\[1\] -eq 18[\s\S]*\$nextParts\[1\] -eq 19/,
      'Clash fake-IP gateways must not be selected as the endpoint bypass path'
    );
    assert.match(
      script,
      /clash\|mihomo\|sing-box\|wintun\|proxy\[ -\]\?tun/,
      'known proxy TUN interfaces must not be selected as the physical route'
    );
    assert.match(
      script,
      /New-NetRoute -AddressFamily IPv4 -DestinationPrefix \$DestinationPrefix[\s\S]*-NextHop \$nextHop[\s\S]*-PolicyStore ActiveStore/,
      'the endpoint must receive an active-store /32 through the selected physical gateway'
    );
    assert.match(
      script,
      /\$_.NextHop -eq \[string\]\$Entry\.NextHop -and \[int\]\$_.RouteMetric -eq \[int\]\$Entry\.RouteMetric/,
      'cleanup must identify the exact recorded gateway and route metric'
    );
    assert.match(
      script,
      /if \(-not \[bool\]\$Entry\.Managed\) \{ return \}/,
      'cleanup must leave pre-existing routes that are not globally managed'
    );
    assert.match(
      script,
      /if \(\$KeepKeys -notcontains \$key\) \{ \$owners = @\(\$owners \| Where-Object \{ \$_ -ne \$hdoEndpointBypassOwner \}\) \}[\s\S]*if \(\$owners\.Count -eq 0\) \{\s*Remove-HdoEndpointBypassRoute \$entry/,
      'releasing one process must delete a managed route only after the final owner is gone'
    );
    const registerNew = script.lastIndexOf(
      '$desiredKeys += Ensure-HdoEndpointBypassRouteUnlocked'
    );
    const releaseOld = script.lastIndexOf(
      'Release-HdoEndpointBypassOwnerUnlocked $registry $desiredKeys'
    );
    assert.ok(
      registerNew >= 0 && registerNew < releaseOld,
      'endpoint or gateway migration must register the new route before releasing stale ownership'
    );
    assert.ok(
      script.lastIndexOf('\nAdd-HdoEndpointBypass\n')
        < script.indexOf('/installtunnelservice'),
      'the physical endpoint route must exist before WireGuard starts or replaces the service'
    );
  }

  assert.notEqual(
    mxOwner,
    luopanOwner,
    'MX-H2I and Luopan must have distinct owner identities in the shared registry'
  );

  const sharedOwners = new Set([mxOwner, luopanOwner]);
  sharedOwners.delete(mxOwner);
  assert.equal(
    sharedOwners.size === 0,
    false,
    'releasing MX-H2I first must retain the shared endpoint route for Luopan'
  );
  sharedOwners.delete(luopanOwner);
  assert.equal(
    sharedOwners.size === 0,
    true,
    'releasing the final Luopan owner must make the shared endpoint route removable'
  );

  writeProfile(mx, '203.0.113.11:51280');
  const changedRestart = buildAndRead(mx, 'restart');
  assert.ok(
    changedRestart.includes("$hdoEndpointBypassHosts = @('203.0.113.11')"),
    'a changed endpoint must enter the replacement plan'
  );
  assert.equal(
    powerShellVariable(changedRestart, 'hdoEndpointBypassOwner'),
    mxOwner,
    'endpoint changes must preserve the owner identity used to release the old route'
  );
  assert.doesNotMatch(
    changedRestart,
    /\$hdoEndpointBypassHosts = @\('203\.0\.113\.10'\)/,
    'the replacement plan must not re-add the old endpoint'
  );

  rmSync(mx.configPath);
  const down = buildAndRead(mx, 'down');
  const cleanupCall = down.indexOf('\nRemove-HdoEndpointBypass\n');
  const serviceAbsentExit = down.indexOf('if ($null -eq $svc) { exit 0 }');
  const uninstall = down.indexOf('/uninstalltunnelservice');
  assert.ok(cleanupCall >= 0, 'down must release endpoint ownership');
  assert.ok(
    cleanupCall < serviceAbsentExit && cleanupCall < uninstall,
    'down must release ownership even when the config or tunnel service is already missing'
  );
  assert.equal(
    powerShellVariable(down, 'hdoEndpointBypassOwner'),
    mxOwner,
    'missing-profile cleanup must still identify the same shared-registry owner'
  );

  console.log('windows WireGuard shared endpoint bypass smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
