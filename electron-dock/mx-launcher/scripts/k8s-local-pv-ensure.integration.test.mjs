import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { guardPostgres } from './k8s-postgres-recovery.mjs';
import { parseManifestObjects } from './k8s-local-pv-ensure.mjs';

const exec = promisify(execFile);
let kubectl;
try { kubectl = execFileSync('which', ['kubectl'], { encoding: 'utf8' }).trim(); } catch { /* Optional local dependency. */ }

test('real kubectl renders four YAML documents and the CLI preserves recovered storage without writes',
  { skip: !kubectl, timeout: 30000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), 'mx-pv-kubectl-'));
    const requests = [], pvs = new Map(), pvcs = new Map();
    const server = createServer((req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      requests.push({ method: req.method, path });
      let body;
      if (req.method === 'GET') {
        if (path === '/api') body = { apiVersion: 'v1', kind: 'APIVersions', versions: ['v1'] };
        else if (path === '/apis') body = { apiVersion: 'v1', kind: 'APIGroupList', groups: [{ name: 'apps', versions: [{ groupVersion: 'apps/v1', version: 'v1' }], preferredVersion: { groupVersion: 'apps/v1', version: 'v1' } }] };
        else if (path === '/api/v1') body = { apiVersion: 'v1', kind: 'APIResourceList', groupVersion: 'v1', resources: [
          { name: 'services', singularName: 'service', namespaced: true, kind: 'Service', verbs: ['get', 'create'] },
          { name: 'persistentvolumes', singularName: 'persistentvolume', namespaced: false, kind: 'PersistentVolume', verbs: ['get', 'create'], shortNames: ['pv'] },
          { name: 'persistentvolumeclaims', singularName: 'persistentvolumeclaim', namespaced: true, kind: 'PersistentVolumeClaim', verbs: ['get'], shortNames: ['pvc'] }
        ] };
        else if (path === '/apis/apps/v1') body = { apiVersion: 'v1', kind: 'APIResourceList', groupVersion: 'apps/v1', resources: [
          { name: 'statefulsets', singularName: 'statefulset', namespaced: true, kind: 'StatefulSet', verbs: ['get', 'create'] }
        ] };
        else body = pvs.get(path) ?? pvcs.get(path);
      }
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body ?? { apiVersion: 'v1', kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404, message: 'test resource not found' }));
    });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const config = join(work, 'kubeconfig');
      writeFileSync(config, JSON.stringify({ apiVersion: 'v1', kind: 'Config',
        clusters: [{ name: 'fixture', cluster: { server: `http://127.0.0.1:${server.address().port}` } }],
        contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
        users: [{ name: 'fixture', user: {} }], 'current-context': 'fixture' }), { mode: 0o600 });
      mkdirSync(join(work, 'bin'));
      const wrapper = join(work, 'bin/kubectl');
      writeFileSync(wrapper, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.env.MX_PV_TEST_KUBECTL, ['--cache-dir', process.env.MX_PV_TEST_CACHE, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
      chmodSync(wrapper, 0o755);
      const env = { ...process.env, KUBECONFIG: config,
        PATH: `${join(work, 'bin')}:${process.env.PATH}`, MX_PV_TEST_KUBECTL: kubectl, MX_PV_TEST_CACHE: join(work, 'cache'),
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
      const options = { env, timeout: 15000, maxBuffer: 1024 * 1024 };
      const manifest = fileURLToPath(new URL('../deploy/k8s/internal-shadow/18-local-pv.yaml', import.meta.url));
      const helper = fileURLToPath(new URL('./k8s-local-pv-ensure.mjs', import.meta.url));
      const { stdout } = await exec(wrapper, ['create', '--dry-run=client', '--validate=false', '-f', manifest, '-o', 'json'], options);
      assert.throws(() => JSON.parse(stdout), SyntaxError, 'reproduce the old single-JSON parser failure with real kubectl');
      const objects = parseManifestObjects(stdout);
      assert.deepEqual(objects.map(p => p.metadata.name), ['mx-internal-postgres-local-pv', 'mx-launcher-internal-ssh-local-pv',
        'mx-launcher-release-artifacts-local-pv', 'mx-launcher-site-slots-local-pv']);
      for (const pv of objects) {
        pv.metadata.uid = `uid-${pv.metadata.name}`;
        pv.status = { phase: 'Available' };
        pvs.set(`/api/v1/persistentvolumes/${pv.metadata.name}`, pv);
      }
      const pg = objects[0], claim = pg.spec.claimRef;
      pg.spec.hostPath.type = 'Directory';
      pg.status.phase = 'Bound';
      claim.uid = 'recovered-pvc';
      pvcs.set(`/api/v1/namespaces/${claim.namespace}/persistentvolumeclaims/${claim.name}`, {
        apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { ...claim },
        spec: { volumeName: pg.metadata.name }, status: { phase: 'Bound' }
      });
      const postgresManifest = fileURLToPath(new URL('../deploy/k8s/internal-shadow/20-postgres.yaml', import.meta.url));
      const rendered = await exec(wrapper, ['create', '--dry-run=client', '--validate=false', '-f', postgresManifest, '-o', 'json'], options);
      const postgresObjects = parseManifestObjects(rendered.stdout);
      const guarded = guardPostgres(postgresObjects, 'mx-internal-server');
      assert.equal(guarded.items.length, 2);
      const originalSet = postgresObjects.find(item => item.kind === 'StatefulSet');
      const guardedSet = guarded.items.find(item => item.kind === 'StatefulSet');
      assert.deepEqual(guardedSet.spec.volumeClaimTemplates, originalSet.spec.volumeClaimTemplates);
      assert.match(guardedSet.spec.template.spec.containers[0].command[2], /initialization refused/);
      const before = structuredClone([...pvs.values()]);
      for (const action of ['preflight', 'ensure']) {
        const result = await exec(process.execPath, [helper, action, manifest], options);
        assert.equal((result.stdout.match(/preserve PV /g) ?? []).length, 4);
        assert.match(result.stdout, /mx-internal-postgres-local-pv: Bound, hostPath.type=Directory/);
      }
      assert.deepEqual([...pvs.values()], before);
      assert.ok(requests.some(r => r.path.endsWith('/persistentvolumes/mx-internal-postgres-local-pv')));
      assert.ok(requests.every(r => r.method === 'GET'), 'preflight and reuse must never write to the API');
    } finally {
      await new Promise(resolve => server.close(resolve));
      rmSync(work, { recursive: true, force: true });
    }
  });
