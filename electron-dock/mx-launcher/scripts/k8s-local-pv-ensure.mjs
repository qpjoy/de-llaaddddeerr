#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(name, reason) {
  throw new Error(`PV ${name}: ${reason}; storage was not changed; inspect PV/PVC before retrying`);
}

// Existing PVs belong to the storage/binding controllers. In particular, never
// apply a template's DirectoryOrCreate over a recovered Directory volume.
export function checkVolume(desired, existing, pvc) {
  const name = desired.metadata?.name;
  const spec = desired.spec;
  const claim = spec?.claimRef;
  if (desired.kind !== 'PersistentVolume' || !name || !spec?.hostPath?.path ||
      !['Directory', 'DirectoryOrCreate'].includes(spec.hostPath.type) ||
      spec.persistentVolumeReclaimPolicy !== 'Retain' || !claim?.namespace || !claim.name) {
    fail(name ?? 'unknown', 'unsupported local PV manifest');
  }
  if (pvc) {
    if (pvc.kind !== 'PersistentVolumeClaim' || pvc.metadata?.name !== claim.name ||
        pvc.metadata?.namespace !== claim.namespace || pvc.metadata.deletionTimestamp) {
      fail(name, 'expected PVC is invalid or being deleted');
    }
    if (pvc.spec?.volumeName && pvc.spec.volumeName !== name) {
      fail(name, `PVC ${claim.namespace}/${claim.name} points to a different PV`);
    }
    if (pvc.status?.phase === 'Lost') fail(name, 'PVC is Lost');
  }
  if (!existing) {
    if (pvc?.status?.phase === 'Bound') fail(name, 'PV is missing but its PVC is still Bound');
    return 'create';
  }
  if (existing.kind !== 'PersistentVolume' || existing.metadata?.name !== name ||
      existing.metadata.deletionTimestamp) fail(name, 'existing PV is invalid or being deleted');
  const current = existing.spec;
  if (current?.hostPath?.path !== spec.hostPath.path) fail(name, 'hostPath/source differs from the manifest');
  if (!['Directory', 'DirectoryOrCreate'].includes(current.hostPath.type)) fail(name, 'hostPath is not a checked directory type');
  if (current.persistentVolumeReclaimPolicy !== 'Retain') fail(name, 'reclaim policy must remain Retain');
  if ((current.storageClassName ?? '') !== (spec.storageClassName ?? '') ||
      (current.volumeMode ?? 'Filesystem') !== (spec.volumeMode ?? 'Filesystem') ||
      !spec.accessModes?.every(mode => current.accessModes?.includes(mode))) {
    fail(name, 'storage class, volume mode or access modes differ');
  }
  if (current.claimRef?.namespace !== claim.namespace || current.claimRef?.name !== claim.name) {
    fail(name, 'claim reservation differs from the manifest');
  }
  if (!['Pending', 'Available', 'Bound'].includes(existing.status?.phase)) {
    fail(name, `phase is ${existing.status?.phase ?? 'unknown'}; automatic delete/recreate is disabled`);
  }
  if (current.claimRef.uid && current.claimRef.uid !== pvc?.metadata?.uid) {
    fail(name, 'claim UID does not match the current PVC');
  }
  if (existing.status.phase === 'Bound' && (!pvc || !current.claimRef.uid || pvc.spec?.volumeName !== name)) {
    fail(name, 'Bound PV/PVC identity is inconsistent');
  }
  return 'preserve';
}

export function runKubectl(args, input) {
  const result = spawnSync('kubectl', ['--request-timeout=15s', ...args], {
    input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`kubectl ${args[0]} failed (exit ${result.status ?? result.error?.code ?? 'none'}): ${(result.stderr ?? '').trim().slice(0, 1000)}`);
  }
  return result.stdout;
}

export function parseManifestObjects(output) {
  // kubectl create prints one JSON object per YAML document. Frame complete
  // objects without mistaking braces or escaped quotes inside strings for JSON
  // boundaries, then let JSON.parse validate every complete document.
  const documents = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (start === -1) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error(`invalid local PV manifest JSON at offset ${i}`);
      start = i;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      documents.push(JSON.parse(output.slice(start, i + 1)));
      start = -1;
    }
  }
  if (start !== -1) throw new Error('incomplete local PV manifest JSON');
  return documents.flatMap(document => {
    if (document.kind !== 'List') return [document];
    if (!Array.isArray(document.items)) throw new Error('invalid local PV manifest List.items');
    return document.items;
  });
}

export function ensureLocalPvs(action, manifest, run = runKubectl, log = console.log) {
  if (!['preflight', 'ensure'].includes(action) || !manifest) {
    throw new Error('usage: k8s-local-pv-ensure.mjs preflight|ensure <PV manifest>');
  }
  const items = parseManifestObjects(run(['create', '--dry-run=client', '--validate=false', '-f', manifest, '-o', 'json']));
  if (!Array.isArray(items) || !items.length) throw new Error('local PV manifest is empty');
  const seen = new Set();
  const plan = items.map(desired => {
    checkVolume(desired, null, null);
    const name = desired.metadata.name;
    if (seen.has(name)) fail(name, 'duplicate manifest entry');
    seen.add(name);
    const raw = run(['get', 'pv', name, '--ignore-not-found', '-o', 'json']);
    const existing = raw.trim() ? JSON.parse(raw) : null;
    const { namespace, name: claimName } = desired.spec.claimRef;
    const claimRaw = run(['get', 'pvc', claimName, '-n', namespace, '--ignore-not-found', '-o', 'json']);
    const pvc = claimRaw.trim() ? JSON.parse(claimRaw) : null;
    return { desired, operation: checkVolume(desired, existing, pvc), existing };
  });
  // Validate the entire set before creating anything. Errors reading existing
  // resources are fatal, never treated as NotFound. Create cannot replace a PV
  // that another deploy created concurrently; rerun to validate it instead.
  for (const { desired, operation, existing } of plan) {
    const name = desired.metadata.name;
    if (operation === 'preserve') {
      log(`preserve PV ${name}: ${existing.status.phase}, hostPath.type=${existing.spec.hostPath.type}; source and binding unchanged`);
    } else if (action === 'ensure') {
      run(['create', '--validate=false', '-f', '-'], JSON.stringify(desired));
      log(`created local PV ${name}`);
    } else {
      log(`local PV preflight: ${name} is absent; will create`);
    }
  }
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureLocalPvs(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(`local PV ensure failed: ${error.message}`);
    process.exitCode = 1;
  }
}
