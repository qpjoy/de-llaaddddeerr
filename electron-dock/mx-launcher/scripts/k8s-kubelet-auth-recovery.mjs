#!/usr/bin/env node
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './k8s-recovery-state.mjs';

export function inspectClient(config, caPem, node, now = Date.now()) {
  if (config.users?.length !== 1 || config.clusters?.length !== 1 || config.contexts?.length !== 1) throw new Error('unsupported kubelet kubeconfig; inspect manually');
  const user = config.users[0].user;
  if (!user?.['client-certificate-data'] || !user['client-key-data']) throw new Error('kubelet client certificate/key unavailable; restore the original kubeconfig first');
  const cert = new X509Certificate(Buffer.from(user['client-certificate-data'], 'base64'));
  const ca = new X509Certificate(caPem);
  if (now < Date.parse(cert.validFrom) || now < Date.parse(ca.validFrom)) throw new Error('certificate is not yet valid; correct the host clock before recovery');
  if (now > Date.parse(ca.validTo)) throw new Error('cluster CA has expired; do not generate a replacement CA during deploy');
  if (!cert.subject.split('\n').includes(`CN=system:node:${node}`) || !cert.subject.split('\n').includes('O=system:nodes')) throw new Error('kubelet certificate belongs to another node/identity; automatic repair refused');
  return cert.verify(ca.publicKey) && now < Date.parse(cert.validTo)
    && cert.checkPrivateKey(createPrivateKey(Buffer.from(user['client-key-data'], 'base64')));
}
export function recoverKubelet(node, api, execute = run, log = console.log, paths = {}) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(node) || !/^https:\/\/[0-9.]+:6443$/.test(api)) throw new Error('expected local node name and IPv4 API endpoint');
  const kubernetes = paths.kubernetes || '/etc/kubernetes';
  const kubelet = paths.kubelet || '/var/lib/kubelet';
  const file = join(kubernetes, 'kubelet.conf');
  const pki = join(kubelet, 'pki');
  const current = join(pki, 'kubelet-client-current.pem');
  const ca = readFileSync(join(kubernetes, 'pki/ca.crt'));
  // Local kubeconfig is flattened in memory. No certificate or private key is logged.
  const config = JSON.parse(execute('kubectl', ['--kubeconfig', file, 'config', 'view', '--raw', '--minify', '--flatten', '-o', 'json']));
  const trusted = inspectClient(config, ca, node);
  const nodeGet = path => execute('kubectl', ['--kubeconfig', path, '--server', api, '--insecure-skip-tls-verify=false', '--request-timeout=10s', 'get', 'node', node, '-o', 'name']);
  if (trusted) {
    nodeGet(file); // Auth/RBAC/network failures are not a reason to mint another certificate.
    if (readFileSync(file, 'utf8').includes('client-certificate-data') && existsSync(current)) {
      const rotated = structuredClone(config);
      rotated.users[0].user['client-certificate-data'] = readFileSync(current).toString('base64');
      rotated.users[0].user['client-key-data'] = readFileSync(current).toString('base64');
      if (!inspectClient(rotated, ca, node)) throw new Error('existing rotation file invalid; keeping verified embedded credentials');
      const backup = mkdtempSync(join(kubernetes, 'mx-kubelet-rotation-resume-'));
      copyFileSync(file, join(backup, 'kubelet.conf.before'));
      delete rotated.users[0].user['client-certificate-data']; delete rotated.users[0].user['client-key-data'];
      rotated.users[0].user['client-certificate'] = current; rotated.users[0].user['client-key'] = current;
      const candidate = join(backup, 'kubelet.conf.rotating');
      writeFileSync(candidate, JSON.stringify(rotated), { mode: 0o600 });
      nodeGet(candidate);
      execute('install', ['-m', '600', candidate, file]);
      execute('systemctl', ['restart', 'kubelet']);
    }
    log('kubelet client identity and API authentication verified');
    return;
  }
  if (!existsSync(join(kubernetes, 'pki/ca.key')) || !/^\s*rotateCertificates:\s*true\s*$/m.test(readFileSync(join(kubelet, 'config.yaml'), 'utf8'))) throw new Error('kubelet repair requires the existing CA key and rotateCertificates=true');
  // Verify admin access and the EXISTING node before creating any credentials.
  nodeGet(join(kubernetes, 'admin.conf'));
  const backup = mkdtempSync(join(kubernetes, 'mx-kubelet-auth-recovery-'));
  copyFileSync(file, join(backup, 'kubelet.conf.before'));
  cpSync(pki, join(backup, 'pki.before'), { recursive: true, dereference: false });
  log(`kubelet client certificate invalid; private backup: ${backup}`);
  const version = execute('kubeadm', ['version', '-o', 'short']).trim();
  if (!/^v1\.\d+\.\d+(?:[-+].*)?$/.test(version)) throw new Error('cannot determine installed kubeadm version');
  const minor = Number(version.split('.')[1]);
  const configFile = join(backup, 'kubeadm.yaml');
  writeFileSync(configFile, `apiVersion: kubeadm.k8s.io/v1beta${minor >= 31 ? '4' : '3'}\nkind: ClusterConfiguration\nkubernetesVersion: ${version}\ncontrolPlaneEndpoint: ${api.slice('https://'.length)}\ncertificatesDir: ${join(kubernetes, 'pki')}\n`, { mode: 0o600 });
  const newFile = join(backup, 'kubelet.conf.new');
  writeFileSync(newFile, execute('kubeadm', ['kubeconfig', 'user', '--org', 'system:nodes', '--client-name', `system:node:${node}`, '--config', configFile]), { mode: 0o600 });
  const fresh = JSON.parse(execute('kubectl', ['--kubeconfig', newFile, 'config', 'view', '--raw', '--minify', '--flatten', '-o', 'json']));
  fresh.clusters[0].cluster.server = api;
  if (!inspectClient(fresh, ca, node)) throw new Error('replacement kubelet certificate did not validate');
  writeFileSync(newFile, JSON.stringify(fresh), { mode: 0o600 });
  nodeGet(newFile);
  mkdirSync(join(backup, 'old-clients'), { mode: 0o700 });
  let installed = false;
  try {
    execute('systemctl', ['stop', 'kubelet']);
    for (const name of readdirSync(pki).filter(name => name.startsWith('kubelet-client'))) renameSync(join(pki, name), join(backup, 'old-clients', name));
    execute('install', ['-m', '600', newFile, file]);
    execute('systemctl', ['start', 'kubelet']);
    installed = true;
  } finally {
    if (!installed) {
      try {
        execute('cp', ['-a', join(backup, 'kubelet.conf.before'), file]);
        cpSync(join(backup, 'pki.before'), pki, { recursive: true, dereference: false });
      } finally { execute('systemctl', ['start', 'kubelet']); }
    }
  }
  // Retain the validated new config if rotation is slow; never roll back to an
  // untrusted certificate after a successful install. The next run can retry.
  for (let attempt = 0; attempt < 30 && !existsSync(current); attempt++) execute('sleep', ['2']);
  if (!existsSync(current)) throw new Error(`kubelet rotation not ready; validated new credentials retained; inspect CSR approval and ${backup}`);
  const rotated = new X509Certificate(readFileSync(current));
  const check = structuredClone(fresh);
  check.users[0].user['client-certificate-data'] = Buffer.from(rotated.toString()).toString('base64');
  check.users[0].user['client-key-data'] = readFileSync(current).toString('base64');
  if (!inspectClient(check, ca, node)) throw new Error('rotated kubelet certificate invalid');
  const user = fresh.users[0].user;
  delete user['client-certificate-data']; delete user['client-key-data'];
  user['client-certificate'] = current; user['client-key'] = current;
  const rotatingFile = join(backup, 'kubelet.conf.rotating');
  writeFileSync(rotatingFile, JSON.stringify(fresh), { mode: 0o600 });
  nodeGet(rotatingFile);
  execute('install', ['-m', '600', rotatingFile, file]);
  execute('systemctl', ['restart', 'kubelet']);
  log('kubelet client authentication repaired; certificate rotation preserved');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { recoverKubelet(process.argv[2], process.argv[3]); }
  catch (error) {
    console.error(`kubelet auth recovery stopped: ${error instanceof SyntaxError || error.code ? 'cannot validate local kubelet credentials; inspect configuration privately' : error.message}`);
    process.exitCode = 1;
  }
}
