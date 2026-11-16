import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'k8s-ssh-repair.sh');
const site = 'mx-oversea-us01';
const host = '34.218.136.162';
const keygen = spawnSync('which', ['ssh-keygen'], { encoding: 'utf8' }).stdout.trim();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mx-ssh-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const keys = join(root, 'keys');
  const remoteHome = join(root, 'remote-home');
  mkdirSync(bin); mkdirSync(keys); mkdirSync(remoteHome);
  const identity = join(keys, `${site}_rsa`);
  const known = join(keys, `known_hosts.${site}`);
  const commandLog = join(root, 'commands.log');
  const serverKey = join(root, 'host-key');
  for (const file of [identity, serverKey]) {
    const generated = spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', file]);
    assert.equal(generated.status, 0, String(generated.stderr));
  }
  const publicKey = readFileSync(`${identity}.pub`, 'utf8').trim();
  const hostKey = readFileSync(`${serverKey}.pub`, 'utf8').trim();
  const fingerprint = spawnSync(keygen, ['-lf', `${serverKey}.pub`, '-E', 'sha256'], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[1];
  const original = `${site} ${publicKey}\n${host} ${publicKey}\n`;
  writeFileSync(known, original);
  const scan = join(root, 'scan');
  writeFileSync(scan, `${host} ${publicKey}\n${host} ${hostKey}\n`);
  const executable = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  };
  executable('kubectl', `
    [[ "$1" == -n && "$3" == exec && "$4" == -i && "$5" == deployment/mx-launcher-internal && "$6" == -c && "$7" == internal-api && "$8" == -- ]] || exit 98
    printf 'kubectl ' >> "$SSH_TEST_LOG"
    printf '%q ' "$@" >> "$SSH_TEST_LOG"
    printf '\\n' >> "$SSH_TEST_LOG"
    while [[ "$1" != -- ]]; do shift; done
    shift
    exec "$@"
  `);
  executable('ssh-keyscan', `
    [[ "\${SSH_TEST_SCAN_FAIL:-0}" == 0 ]] || exit 1
    cat "$SSH_TEST_SCAN"
  `);
  executable('sshpass', `
    [[ "$1" == -d && "$2" == 0 ]] || exit 99
    IFS= read -r password
    [[ "$password" == test-password ]] || exit 5
    unset password
    shift 2
    exec "$@"
  `);
  executable('ssh', `
    printf 'ssh ' >> "$SSH_TEST_LOG"
    printf '%q ' "$@" >> "$SSH_TEST_LOG"
    printf '\\n' >> "$SSH_TEST_LOG"
    for arg in "$@"; do
      if [[ "$arg" == PreferredAuthentications=password,keyboard-interactive ]]; then
        HOME="$SSH_TEST_REMOTE_HOME" bash -c "\${!#}"
        touch "$SSH_TEST_REMOTE_HOME/installed"
        exit 0
      fi
    done
    if [[ "\${SSH_TEST_VERIFY_MODE:-ok}" == timeout ]]; then
      printf 'ssh: connect to host: Connection timed out\\n' >&2
      exit 255
    fi
    if [[ "\${SSH_TEST_VERIFY_MODE:-ok}" == denied && ! -e "$SSH_TEST_REMOTE_HOME/installed" ]]; then
      printf 'root@34.218.136.162: Permission denied (publickey).\\n' >&2
      exit 255
    fi
    printf 'mx-ssh-repair-verified\\nroot\\nreplacement-server\\n'
  `);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MX_SSH_KEY_DIR: keys,
    SSH_TEST_LOG: commandLog, SSH_TEST_SCAN: scan, SSH_TEST_REMOTE_HOME: remoteHome };
  return { root, keys, identity, known, original, fingerprint, publicKey, hostKey, remoteHome,
    run: (args, overrides = {}, input) => spawnSync('bash', [script, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', input }),
    log: () => readFileSync(commandLog, 'utf8') };
}

test('repair pins only the externally matched key, backs up the old pin and uses strict read-only SSH', t => {
  const f = fixture(t);
  const privateKey = readFileSync(f.identity, 'utf8');
  const result = f.run(['repair', f.fingerprint]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mx-ssh-repair-verified/);
  assert.equal(readFileSync(f.known, 'utf8'), `${host} ${f.hostKey}\n${site} ${f.hostKey}\n`);
  const backups = readdirSync(f.keys).filter(name => name.includes('.bak.'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(f.keys, backups[0]), 'utf8'), f.original);
  assert.equal(readFileSync(f.identity, 'utf8'), privateKey);
  assert.match(f.log(), /StrictHostKeyChecking=yes/);
  assert.match(f.log(), /GlobalKnownHostsFile=\/dev\/null/);
  assert.doesNotMatch(f.log(), /kubectl (?:set|apply|delete|rollout)/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/);
});

test('wrong fingerprint and scan failure preserve the old pin without backup or SSH', t => {
  const f = fixture(t);
  for (const [fingerprint, env] of [[`SHA256:${'A'.repeat(43)}`, {}], [f.fingerprint, { SSH_TEST_SCAN_FAIL: '1' }]]) {
    const result = f.run(['refresh', fingerprint], env);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.known, 'utf8'), f.original);
    assert.equal(readdirSync(f.keys).filter(name => name.includes('.bak.') || name.startsWith('.')).length, 0);
  }
  assert.doesNotMatch(f.log(), /^ssh /m);
});

test('shared known_hosts is rejected rather than deleting other sites', t => {
  const f = fixture(t);
  const shared = `${f.original}other-site ${f.hostKey}\n`;
  writeFileSync(f.known, shared);
  const result = f.run(['refresh', f.fingerprint]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite shared/);
  assert.equal(readFileSync(f.known, 'utf8'), shared);
});

test('missing private key is never silently rotated; public-key derives from the existing private key', t => {
  const f = fixture(t);
  writeFileSync(`${f.identity}.pub`, 'stale-public-key\n');
  const exported = f.run(['public-key']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(exported.stdout.trim(), f.publicKey);
  rmSync(f.identity);
  const missing = f.run(['refresh', f.fingerprint]);
  assert.notEqual(missing.status, 0);
  assert.equal(existsSync(f.identity), false);
  assert.equal(readFileSync(f.known, 'utf8'), f.original);
});

test('alternate port pins both host and alias forms used by OpenSSH', t => {
  const f = fixture(t);
  const result = f.run(['refresh', f.fingerprint], { MX_SSH_PORT: '2222' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.known, 'utf8'), `[${host}]:2222 ${f.hostKey}\n${site} ${f.hostKey}\n[${site}]:2222 ${f.hostKey}\n`);
});

test('password repair appends the existing public key idempotently, preserves other keys and keeps the password out of arguments', t => {
  const f = fixture(t);
  mkdirSync(join(f.remoteHome, '.ssh'));
  const authorized = join(f.remoteHome, '.ssh', 'authorized_keys');
  writeFileSync(authorized, `another-existing-key\n`);
  assert.equal(f.run(['refresh', f.fingerprint]).status, 0);
  for (let index = 0; index < 2; index++) {
    const result = f.run(['install-password'], { SSH_TEST_VERIFY_MODE: 'denied' }, 'test-password\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mx-ssh-repair-verified/);
    assert.doesNotMatch(result.stdout + result.stderr + f.log(), /test-password/);
  }
  assert.equal(readFileSync(authorized, 'utf8'), `another-existing-key\n${f.publicKey}\n`);
});

test('rejected password does not alter remote authorized_keys or expose the supplied password', t => {
  const f = fixture(t);
  mkdirSync(join(f.remoteHome, '.ssh'));
  const authorized = join(f.remoteHome, '.ssh', 'authorized_keys');
  writeFileSync(authorized, 'another-existing-key\n');
  assert.equal(f.run(['refresh', f.fingerprint]).status, 0);
  const result = f.run(['install-password'], {}, 'wrong-secret-password\n');
  assert.equal(result.status, 5);
  assert.equal(readFileSync(authorized, 'utf8'), 'another-existing-key\n');
  assert.doesNotMatch(result.stdout + result.stderr + f.log(), /wrong-secret-password/);
});

test('password installation strips imported private-key comments before constructing the remote command', t => {
  const f = fixture(t);
  const marker = join(f.root, 'comment-must-not-execute');
  const comment = `operator'; touch '${marker}'; #`;
  const changed = spawnSync(keygen, ['-c', '-C', comment, '-f', f.identity, '-P', ''], { encoding: 'utf8' });
  assert.equal(changed.status, 0, changed.stderr);
  const derived = spawnSync(keygen, ['-y', '-P', '', '-f', f.identity], { encoding: 'utf8' });
  assert.ok(derived.stdout.includes(comment), 'the test must exercise ssh-keygen output containing the private-key comment');
  assert.equal(f.run(['refresh', f.fingerprint]).status, 0);
  const result = f.run(['install-password'], {}, 'test-password\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.remoteHome, '.ssh', 'authorized_keys'), 'utf8'), `${f.publicKey}\n`);
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(f.log(), /operator/);
});

test('noninteractive repair only offers public-key installation for auth failures; timeouts do not trigger installation', t => {
  const f = fixture(t);
  const denied = f.run(['repair', f.fingerprint], { SSH_TEST_VERIFY_MODE: 'denied' });
  assert.equal(denied.status, 3);
  assert.match(denied.stderr, /Run install-password interactively/);
  assert.ok(denied.stdout.includes(f.publicKey));
  const timeout = f.run(['repair', f.fingerprint], { SSH_TEST_VERIFY_MODE: 'timeout' });
  assert.equal(timeout.status, 1);
  assert.doesNotMatch(timeout.stdout, new RegExp(f.publicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(existsSync(join(f.remoteHome, 'installed')), false);
});
