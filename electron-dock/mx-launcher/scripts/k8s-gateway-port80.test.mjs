import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const manifest = readFileSync(join(scripts, '../deploy/k8s/internal-shadow/45-internal-gateway.yaml'), 'utf8');
const baseline = manifest.split('  Caddyfile: |\n')[1].split('  mx-gateway-routes.json: |\n')[0].replace(/^    /gm, '');
const startup = manifest.match(/          args:\n            - \|\n([\s\S]*?)          ports:/)[1].replace(/^              /gm, '');
const withoutPort80 = content => content.replace(/^# mx-gateway-optional-port-80:start\n[\s\S]*?^# mx-gateway-optional-port-80:end\n/gm, '');
const procHeader = '  sl  local_address rem_address   st\n';
const procRow = (port, state = '0A') => `   0: 00000000:${port} 00000000:0000 ${state}\n`;

function runStartup({ owner, occupied = false, ipv6 = false, source = baseline } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-gateway-port80-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'source'), source);
    writeFileSync(join(dir, 'tcp'), procHeader + (occupied && !ipv6 ? procRow('0050') : procRow('0050', '01')) + procRow('46AA'));
    writeFileSync(join(dir, 'tcp6'), procHeader + (occupied && ipv6 ? procRow('0050') : ''));
    writeFileSync(join(bin, 'caddy'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), dir = process.env.MX_GATEWAY_STARTUP_TEST_DIR;
fs.writeFileSync(path.join(dir, 'caddy-args.json'), JSON.stringify(args));
fs.copyFileSync(args[args.indexOf('--config') + 1], path.join(dir, 'loaded'));
`);
    chmodSync(join(bin, 'caddy'), 0o755);
    // The external proc wrapper runs the real awk predicate against fixtures.
    // Keep it external: a shell function changes errexit behavior on macOS sh.
    writeFileSync(join(bin, 'awk'), `#!/bin/sh
if [ "$#" -eq 3 ] && [ "$2" = /proc/net/tcp ] && [ "$3" = /proc/net/tcp6 ]; then
  printf 'checked\\n' >> "$MX_GATEWAY_STARTUP_TEST_DIR/proc-checks"
  exec /usr/bin/awk "$1" "$MX_GATEWAY_STARTUP_TEST_DIR/tcp" "$MX_GATEWAY_STARTUP_TEST_DIR/tcp6"
else
  exec /usr/bin/awk "$@"
fi
`);
    chmodSync(join(bin, 'awk'), 0o755);
    // Execute the actual manifest shell, substituting only its two file paths.
    const program = startup.replace('source_config=/etc/caddy-source/Caddyfile', 'source_config="$MX_GATEWAY_STARTUP_TEST_DIR/source"')
      .replace('runtime_config=/tmp/mx-internal-gateway.Caddyfile', 'runtime_config="$MX_GATEWAY_STARTUP_TEST_DIR/runtime"');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MX_GATEWAY_STARTUP_TEST_DIR: dir };
    delete env.MX_INTERNAL_GATEWAY_PORT80_OWNER;
    if (owner !== undefined) env.MX_INTERNAL_GATEWAY_PORT80_OWNER = owner;
    const result = spawnSync('/bin/sh', ['-ec', program], { encoding: 'utf8', env, timeout: 5000 });
    return {
      result,
      loaded: existsSync(join(dir, 'loaded')) ? readFileSync(join(dir, 'loaded'), 'utf8') : null,
      caddyArgs: existsSync(join(dir, 'caddy-args.json')) ? JSON.parse(readFileSync(join(dir, 'caddy-args.json'), 'utf8')) : null,
      checkedSockets: existsSync(join(dir, 'proc-checks')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('host-nginx reserves port 80 even when Nginx has not started, without changing API or fallback routes', () => {
  for (const occupied of [false, true]) {
    const { result, loaded, caddyArgs, checkedSockets } = runStartup({ owner: 'host-nginx', occupied });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(loaded, withoutPort80(baseline));
    assert.equal(checkedSockets, false, 'ownership must not depend on which service wins the boot race');
    assert.deepEqual([caddyArgs[0], caddyArgs[1], ...caddyArgs.slice(3)], ['run', '--config', '--adapter', 'caddyfile']);
    assert.match(result.stdout, /reserved for Nginx/);
    assert.match(loaded, /:18090 \{/);
    assert.match(loaded, /:8008 \{/);
    assert.match(loaded, /header_up X-Forwarded-For \{http\.request\.header\.X-Forwarded-For\}/);
    assert.match(loaded, /header_up X-Forwarded-For \{remote_host\}/);
    assert.match(loaded, /header_up -X-MX-Forwarded-By/);
  }
});

test('default and explicit auto preserve standalone startup when port 80 is free', () => {
  for (const owner of [undefined, '', 'auto']) {
    const { result, loaded, checkedSockets } = runStartup({ owner });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(loaded, baseline);
    assert.equal(checkedSockets, true);
  }
});

test('auto retains occupied-port fallback for IPv4 and IPv6 listeners', () => {
  for (const owner of [undefined, 'auto']) {
    for (const ipv6 of [false, true]) {
      const { result, loaded, checkedSockets } = runStartup({ owner, occupied: true, ipv6 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(loaded, withoutPort80(baseline));
      assert.equal(checkedSockets, true);
      assert.match(result.stdout, /already in use/);
    }
  }
});

test('host-nginx also removes a legacy unmarked port-80 block and preserves nested proxy headers', () => {
  const source = baseline.replace(/^# mx-gateway-optional-port-80:(?:start|end)\n/gm, '')
    .replace('respond "MX Internal gateway route not found\\n" 404', 'reverse_proxy app:8080 {\n      header_up X-App keep\n    }');
  const { result, loaded } = runStartup({ owner: 'host-nginx', source });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loaded, withoutPort80(baseline));
});

test('invalid ownership fails before starting Caddy or checking transient sockets', () => {
  for (const owner of ['nginx', 'AUTO', 'host-nginx ', 'host-nginx\nauto']) {
    const { result, loaded, caddyArgs, checkedSockets } = runStartup({ owner });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid MX_INTERNAL_GATEWAY_PORT80_OWNER/);
    assert.equal(loaded, null);
    assert.equal(caddyArgs, null);
    assert.equal(checkedSockets, false);
  }
});

test('the baseline manifest leaves the opt-in env field unowned by normal kubectl apply', () => {
  assert.doesNotMatch(manifest, /- name: MX_INTERNAL_GATEWAY_PORT80_OWNER/);
});
