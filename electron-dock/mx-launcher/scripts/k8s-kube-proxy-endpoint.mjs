#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENDPOINT_ANNOTATION = 'mx.qpjoy.com/kube-proxy-endpoint-sha256';

export function apiEndpoint(host) {
  if (!isIPv4(host) || /^(0|127|169\.254)\./.test(host)) {
    throw new Error('set MX_K8S_APISERVER_ADVERTISE_ADDRESS to a usable IPv4 address');
  }
  return `https://${host}:6443`;
}

// Deliberately limited to the single-cluster kubeadm kubeconfig. Keep its CA,
// tokenFile, other ConfigMap entries and all non-server bytes unchanged.
export function planEndpointRepair(cm, ds, config, host) {
  const endpoint = apiEndpoint(host);
  const original = cm.data?.['kubeconfig.conf'];
  if (cm.kind !== 'ConfigMap' || cm.metadata?.name !== 'kube-proxy' ||
      cm.metadata?.namespace !== 'kube-system' || !cm.metadata.resourceVersion ||
      typeof original !== 'string' || ds.kind !== 'DaemonSet' ||
      ds.metadata?.name !== 'kube-proxy' || ds.metadata?.namespace !== 'kube-system' ||
      !ds.metadata.resourceVersion || ds.spec?.template?.spec?.hostNetwork !== true ||
      ds.spec?.updateStrategy?.type !== 'RollingUpdate' ||
      !ds.spec.template.spec.volumes?.some(v => v.configMap?.name === 'kube-proxy')) {
    throw new Error('unsupported kube-proxy ConfigMap/DaemonSet; no changes applied');
  }
  const cluster = config.clusters?.[0];
  const context = config.contexts?.find(c => c.name === config['current-context']);
  if (config.clusters?.length !== 1 || !cluster?.name ||
      context?.context?.cluster !== cluster.name ||
      !/^https:\/\/[^\s]+$/.test(cluster.cluster?.server ?? '')) {
    throw new Error('expected a single-cluster kube-proxy kubeconfig with a current context');
  }
  const lines = [...original.matchAll(/^([ \t]*server:[ \t]*)(["']?)(https:\/\/[^\s"']+)\2([ \t]*(?:#[^\r\n]*)?)(\r?)$/gm)];
  if (lines.length !== 1 || lines[0][3] !== cluster.cluster.server) {
    throw new Error('unsupported kube-proxy server field; no changes applied');
  }
  const [line, prefix, quote, , suffix, cr] = lines[0];
  const updated = original.replace(line, () => `${prefix}${quote}${endpoint}${quote}${suffix}${cr}`);
  const digest = createHash('sha256').update(updated).digest('hex');
  const configPatch = updated === original ? null : [
    { op: 'test', path: '/metadata/resourceVersion', value: cm.metadata.resourceVersion },
    { op: 'test', path: '/data/kubeconfig.conf', value: original },
    { op: 'replace', path: '/data/kubeconfig.conf', value: updated }
  ];
  // The template hash makes interrupted runs resumable: a ConfigMap update
  // alone does not prove that the running kube-proxy loaded the new endpoint.
  const rolloutPatch = ds.spec.template.metadata?.annotations?.[ENDPOINT_ANNOTATION] === digest ? null : {
    metadata: { resourceVersion: ds.metadata.resourceVersion },
    spec: { template: { metadata: { annotations: { [ENDPOINT_ANNOTATION]: digest } } } }
  };
  return { endpoint, configPatch, rolloutPatch };
}

export function repairEndpoint(host, backupRoot, run) {
  const endpoint = apiEndpoint(host);
  // Use the repaired direct endpoint even while the Kubernetes Service is down.
  const base = [`--server=${endpoint}`, '--insecure-skip-tls-verify=false', '--request-timeout=15s'];
  run([...base, 'get', '--raw=/readyz']);
  const cm = JSON.parse(run([...base, '-n', 'kube-system', 'get', 'configmap', 'kube-proxy', '-o', 'json']));
  const ds = JSON.parse(run([...base, '-n', 'kube-system', 'get', 'daemonset', 'kube-proxy', '-o', 'json']));
  // Parsing is local and never authenticates as kube-proxy or prints its token.
  const config = JSON.parse(run(['--kubeconfig=/dev/stdin', 'config', 'view', '--raw', '-o', 'json'], cm.data?.['kubeconfig.conf']));
  const plan = planEndpointRepair(cm, ds, config, host);
  if (!plan.configPatch && !plan.rolloutPatch) {
    console.log(`kube-proxy already configured for ${endpoint}`);
    return;
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(backupRoot, 'mx-kube-proxy-endpoint-'));
  const save = (name, value) => {
    const path = join(work, name);
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return path;
  };
  save('configmap-before.json', cm);
  save('daemonset-before.json', ds);
  console.log(`kube-proxy configuration backup: ${work}`);
  if (plan.configPatch) {
    const path = save('configmap-patch.json', plan.configPatch);
    run([...base, '-n', 'kube-system', 'patch', 'configmap', 'kube-proxy', '--type=json', '--patch-file', path]);
  }
  if (plan.rolloutPatch) {
    const path = save('daemonset-patch.json', plan.rolloutPatch);
    run([...base, '-n', 'kube-system', 'patch', 'daemonset', 'kube-proxy', '--type=merge', '--patch-file', path]);
  }
  console.log(`kube-proxy endpoint synchronized: ${endpoint}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    repairEndpoint(process.argv[2] ?? '', process.argv[3] ?? '/etc/kubernetes', (args, input) => {
      const result = spawnSync('kubectl', args, { input, encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
      // kubectl errors can echo patches containing kubeconfig credentials.
      if (result.error || result.status !== 0) throw new Error('kubectl read/patch failed; check API access and concurrent changes, then retry');
      return result.stdout;
    });
  } catch (error) {
    // JSON parse errors can include raw credential material, so never print them.
    console.error(`kube-proxy endpoint repair failed: ${error instanceof SyntaxError ? 'invalid resource JSON' : error.message}`);
    process.exitCode = 1;
  }
}
