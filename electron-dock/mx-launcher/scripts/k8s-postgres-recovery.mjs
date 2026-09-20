#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifestObjects } from './k8s-local-pv-ensure.mjs';
import { run } from './k8s-recovery-state.mjs';

export function guardPostgres(objects, node) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(node)) throw new Error('invalid PostgreSQL recovery node');
  const resources = structuredClone(objects);
  const sets = resources.filter(item => item.kind === 'StatefulSet' && item.metadata?.name === 'mx-internal-postgres');
  if (sets.length !== 1) throw new Error('expected a single PostgreSQL StatefulSet');
  const pod = sets[0].spec.template.spec;
  const postgres = pod.containers.find(item => item.name === 'postgres');
  if (!postgres || postgres.image !== 'postgres:16-alpine') throw new Error('unexpected PostgreSQL recovery image');
  // Pin storage to the Kubernetes node identity without bypassing scheduling
  // or assuming the hostname label has the same value as the node name.
  if (pod.affinity || pod.nodeName) throw new Error('unexpected PostgreSQL scheduling override');
  pod.affinity = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {
    nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [node] }] }]
  } } };
  postgres.command = ['sh', '-ec',
    'test "$(cat "$PGDATA/PG_VERSION")" = 16 && test -s "$PGDATA/global/pg_control" && test -d "$PGDATA/base" || { echo "Existing PostgreSQL 16 data missing; initialization refused" >&2; exit 1; }; exec docker-entrypoint.sh postgres'];
  return { apiVersion: 'v1', kind: 'List', items: resources };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [manifest, node] = process.argv.slice(2);
    const raw = run('kubectl', ['create', '--dry-run=client', '--validate=false', '-f', manifest, '-o', 'json']);
    const resource = guardPostgres(parseManifestObjects(raw), node);
    run('kubectl', ['--request-timeout=30s', 'apply', '--validate=false', '-f', '-'], JSON.stringify(resource));
    console.log('PostgreSQL applied with existing-data startup guard');
  } catch (error) {
    console.error(`PostgreSQL recovery apply failed: ${error instanceof SyntaxError ? 'invalid manifest JSON' : error.message}`);
    process.exitCode = 1;
  }
}
