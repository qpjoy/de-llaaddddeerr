import assert from 'node:assert/strict';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectClient, recoverKubelet } from './k8s-kubelet-auth-recovery.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mx-kubelet-auth-test-'));
  const kubernetes = join(directory, 'kubernetes'), kubelet = join(directory, 'kubelet');
  mkdirSync(join(kubernetes, 'pki'), { recursive: true }); mkdirSync(join(kubelet, 'pki'), { recursive: true });
  function openssl(args) {
    const result = spawnSync('openssl', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, 'test certificate generation failed');
  }
  for (const ca of ['ca', 'old']) openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${ca}.key`, '-out', `${ca}.crt`, '-days', '10', '-subj', `/CN=${ca}`]);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'node.key', '-out', 'node.csr', '-subj', '/O=system:nodes/CN=system:node:node-a']);
  for (const ca of ['ca', 'old']) openssl(['x509', '-req', '-in', 'node.csr', '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-out', `node-${ca}.crt`, '-days', '2']);
  copyFileSync(join(directory, 'ca.crt'), join(kubernetes, 'pki/ca.crt'));
  copyFileSync(join(directory, 'ca.key'), join(kubernetes, 'pki/ca.key'));
  writeFileSync(join(kubelet, 'config.yaml'), 'rotateCertificates: true\n');
  writeFileSync(join(kubernetes, 'admin.conf'), 'private-admin-config');
  const config = ca => ({ clusters: [{ name: 'kubernetes', cluster: { server: 'https://192.168.1.2:6443' } }],
    contexts: [{ name: 'node', context: { user: 'node', cluster: 'kubernetes' } }], 'current-context': 'node',
    users: [{ name: 'node', user: { 'client-certificate-data': readFileSync(join(directory, `node-${ca}.crt`)).toString('base64'), 'client-key-data': readFileSync(join(directory, 'node.key')).toString('base64') } }] });
  writeFileSync(join(kubernetes, 'kubelet.conf'), JSON.stringify(config('old')));
  const pem = ca => readFileSync(join(directory, `node-${ca}.crt`)) + '\n' + readFileSync(join(directory, 'node.key'));
  writeFileSync(join(kubelet, 'pki/kubelet-client-current.pem'), pem('old'));
  const calls = [];
  let deny = false, startFail = false, slowRotation = false;
  function execute(cmd, args) {
    calls.push([cmd, ...args]);
    if (cmd === 'kubectl') {
      const file = args[args.indexOf('--kubeconfig') + 1];
      if (args.includes('view')) return readFileSync(file, 'utf8');
      if (deny) throw new Error('API unavailable');
      return 'node/node-a';
    }
    if (cmd === 'kubeadm') {
      if (args.includes('version')) return 'v1.36.2';
      return JSON.stringify(config('ca'));
    }
    if (cmd === 'install') { copyFileSync(args[2], args[3]); return ''; }
    if (cmd === 'cp') { copyFileSync(args[1], args[2]); return ''; }
    if (cmd === 'systemctl') {
      if (args[0] === 'start') {
        if (startFail) { startFail = false; throw new Error('start failed once'); }
        if (!slowRotation) writeFileSync(join(kubelet, 'pki/kubelet-client-current.pem'), pem('ca'));
      }
      return '';
    }
    assert.equal(cmd, 'sleep'); return '';
  }
  return { directory, kubernetes, kubelet, config, calls, pem,
    recover: () => recoverKubelet('node-a', 'https://192.168.1.2:6443', execute, () => {}, { kubernetes, kubelet }),
    deny: () => { deny = true; }, startFail: () => { startFail = true; }, slow: () => { slowRotation = true; },
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('certificate inspection distinguishes old CA, expiration, future clock and another node', () => {
  const f = fixture();
  try {
    const ca = readFileSync(join(f.kubernetes, 'pki/ca.crt'));
    assert.equal(inspectClient(f.config('ca'), ca, 'node-a'), true);
    assert.equal(inspectClient(f.config('old'), ca, 'node-a'), false);
    const cert = new X509Certificate(Buffer.from(f.config('ca').users[0].user['client-certificate-data'], 'base64'));
    assert.equal(inspectClient(f.config('ca'), ca, 'node-a', Date.parse(cert.validTo) + 1000), false);
    assert.throws(() => inspectClient(f.config('ca'), ca, 'node-a', Date.parse(cert.validFrom) - 1000), /host clock/);
    assert.throws(() => inspectClient(f.config('ca'), ca, 'different-node'), /another node/);
  } finally { f.cleanup(); }
});

test('invalid original CA is backed up, replacement authenticated before stop, then rotation restored', () => {
  const f = fixture();
  try {
    f.recover();
    const config = JSON.parse(readFileSync(join(f.kubernetes, 'kubelet.conf')));
    assert.equal(config.users[0].user['client-certificate'], join(f.kubelet, 'pki/kubelet-client-current.pem'));
    assert.equal(config.users[0].user['client-certificate-data'], undefined);
    const stop = f.calls.findIndex(c => c[0] === 'systemctl' && c[1] === 'stop');
    assert.ok(f.calls.slice(0, stop).some(c => c[0] === 'kubectl' && c.includes('get') && c.some(arg => arg.endsWith('kubelet.conf.new'))));
    assert.ok(readdirSync(f.kubernetes).some(name => name.startsWith('mx-kubelet-auth-recovery-')));
    assert.equal(f.calls.some(c => c.includes('reset') || c.includes('init')), false);
  } finally { f.cleanup(); }
});

test('API/auth errors with valid credentials do not trigger certificate issuance or restart', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.kubernetes, 'kubelet.conf'), JSON.stringify(f.config('ca')));
    f.deny();
    assert.throws(() => f.recover(), /API unavailable/);
    assert.equal(f.calls.some(c => c[0] === 'kubeadm' || c[0] === 'systemctl'), false);
  } finally { f.cleanup(); }
});

test('failed initial restart restores original configuration and starts kubelet again', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.kubernetes, 'kubelet.conf'));
    f.startFail(); assert.throws(() => f.recover(), /start failed/);
    assert.deepEqual(readFileSync(join(f.kubernetes, 'kubelet.conf')), before);
    assert.equal(f.calls.filter(c => c[0] === 'systemctl' && c[1] === 'start').length, 2);
  } finally { f.cleanup(); }
});

test('slow rotation retains authenticated new credentials and resumes file-based rotation next deploy', () => {
  const f = fixture();
  try {
    f.slow(); assert.throws(() => f.recover(), /validated new credentials retained/);
    const config = JSON.parse(readFileSync(join(f.kubernetes, 'kubelet.conf')));
    assert.equal(inspectClient(config, readFileSync(join(f.kubernetes, 'pki/ca.crt')), 'node-a'), true);
    const issued = f.calls.filter(c => c[0] === 'kubeadm').length;
    writeFileSync(join(f.kubelet, 'pki/kubelet-client-current.pem'), f.pem('ca'));
    f.recover();
    assert.equal(f.calls.filter(c => c[0] === 'kubeadm').length, issued);
    assert.equal(JSON.parse(readFileSync(join(f.kubernetes, 'kubelet.conf'))).users[0].user['client-certificate-data'], undefined);
  } finally { f.cleanup(); }
});
