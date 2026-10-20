"""Private Kubernetes checkpoint and reversible workload quiescence.

This module never logs API objects: checkpoints contain Secrets.  It does not
move storage, stop runtimes, restore Secrets, deploy manifests or initialize DBs.
Host.run must return bytes and hide subprocess output on failure.
"""
import copy
import datetime
import hashlib
import json
import re
import time

import rig_init_repair


class ClusterError(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise ClusterError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


PV_PATHS = {
    'mx-common-elasticsearch-data': ('mx-common', 'data-mx-common-elasticsearch-0', '/data/k8s/mx-runtime/mx-common/k8s/elasticsearch/data', 'hostPath'),
    'mx-common-elasticsearch-snapshots': ('mx-common', 'mx-common-elasticsearch-snapshots', '/data/k8s/mx-runtime/mx-common/k8s/elasticsearch/snapshots', 'hostPath'),
    'mx-common-hanlp-models': ('mx-common', 'mx-common-hanlp-models', '/data/k8s/mx-runtime/mx-common/k8s/hanlp/models', 'hostPath'),
    'mx-common-postgres-data': ('mx-common', 'data-mx-common-postgres-0', '/data/k8s/mx-runtime/mx-common/k8s/postgres/data', 'hostPath'),
    'mx-internal-postgres-local-pv': ('mx-internal-shadow', 'postgres-data-mx-internal-postgres-0', '/var/lib/mx-launcher/k8s/postgres', 'hostPath'),
    'mx-launcher-internal-ssh-local-pv': ('mx-internal-shadow', 'mx-launcher-internal-ssh', '/var/lib/mx-launcher/k8s/internal-ssh', 'hostPath'),
    'mx-launcher-release-artifacts-local-pv': ('mx-internal-shadow', 'mx-launcher-release-artifacts', '/var/lib/mx-launcher/k8s/release-artifacts', 'hostPath'),
    'mx-launcher-site-slots-local-pv': ('mx-internal-shadow', 'mx-launcher-site-slots', '/var/lib/mx-launcher/k8s/site-slots', 'hostPath'),
    'mx-pay-postgres-data': ('mx-pay', 'mx-pay-postgres-data', '/data/mx-pay/mx-pay/postgres', 'local'),
    'mx-rig-artifacts-pv': ('mx-rig', 'mx-rig-artifacts', '/data/mx-rig/artifacts', 'hostPath'),
    'mx-rig-postgres-pv': ('mx-rig', 'mx-rig-postgres-data', '/data/mx-rig/postgres', 'hostPath'),
}
KINDS = ('nodes', 'namespaces', 'pv', 'pvc', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs', 'pods', 'secrets', 'configmaps', 'hpa')
CLUSTER_KINDS = ('nodes', 'namespaces', 'pv')
SYSTEM_NAMESPACES = ('kube-system', 'kube-flannel')
DAEMONSETS = {('kube-flannel', 'kube-flannel-ds'), ('kube-system', 'kube-proxy'), ('mx-internal-shadow', 'mx-internal-gateway')}
PAY_FIELDS = {'mountTarget', 'filesystemUUID', 'volumeMountRoot'}
HOST_PATHS = {'/run/flannel', '/opt/cni/bin', '/etc/cni/net.d', '/run/xtables.lock', '/lib/modules',
              '/shared_dir', '/var/lib/etcd', '/etc/kubernetes/pki/etcd', '/etc/kubernetes/pki',
              '/etc/ssl/certs', '/etc/pki/ca-trust', '/etc/pki/tls/certs',
              '/etc/kubernetes/controller-manager.conf', '/etc/kubernetes/scheduler.conf'}
VOLUME_KINDS = {'hostPath', 'persistentVolumeClaim', 'secret', 'configMap', 'projected', 'emptyDir', 'downwardAPI'}
WORKLOAD_REPORT_KINDS = ('deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'hpa')


def _workload_time_epoch(value):
    if value is None:
        return None
    require(isinstance(value, str), 'invalid workload report timestamp; raw values hidden')
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))', value)
    require(match is not None, 'invalid workload report timestamp; raw values hidden')
    try:
        parsed = datetime.datetime.strptime(match.group(1), '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        raise ClusterError('invalid workload report timestamp; raw values hidden') from None
    require(match.group(3) is None or int(match.group(4)) <= 23 and int(match.group(5)) <= 59,
            'invalid workload report timestamp; raw values hidden')
    offset = (int(match.group(4)) * 3600 + int(match.group(5)) * 60) if match.group(3) else 0
    if match.group(3) == '-':
        offset = -offset
    return parsed.replace(tzinfo=datetime.timezone.utc).timestamp() - offset + float('0.' + (match.group(2) or '0'))


def _workload_report_time(value):
    _workload_time_epoch(value)
    return value


def _workload_report_summary(kind, obj):
    """Project only validated object identities and bounded Job lifecycle fields."""
    require(isinstance(obj, dict) and isinstance(obj.get('metadata'), dict),
            'invalid workload report metadata; raw values hidden')
    metadata = obj['metadata']
    namespace, name, uid = (metadata.get(field) for field in ('namespace', 'name', 'uid'))
    label = r'[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?'
    require(isinstance(namespace, str) and re.fullmatch(label, namespace) is not None and
            isinstance(name, str) and len(name) <= 253 and
            all(re.fullmatch(label, part) is not None for part in name.split('.')) and
            isinstance(uid, str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', uid) is not None,
            'invalid workload report identity; raw values hidden')
    result = {'namespace': namespace, 'name': name, 'uid': uid}
    if kind == 'jobs':
        spec, status = obj.get('spec', {}), obj.get('status', {})
        require(isinstance(spec, dict) and isinstance(status, dict),
                'invalid workload report Job fields; raw values hidden')
        conditions = status.get('conditions', [])
        require(isinstance(conditions, list) and all(isinstance(c, dict) for c in conditions),
                'invalid workload report Job fields; raw values hidden')
        terminal = {c.get('type') for c in conditions
                    if c.get('type') in ('Complete', 'Failed') and c.get('status') == 'True'}
        active, ttl = status.get('active', 0), spec.get('ttlSecondsAfterFinished')
        require(len(terminal) <= 1 and type(active) is int and active >= 0 and
                (ttl is None or type(ttl) is int and ttl >= 0),
                'invalid workload report Job fields; raw values hidden')
        result.update({'terminal': next(iter(terminal)) if terminal else None,
                       'active': active > 0, 'ttl_seconds_after_finished': ttl,
                       'completion_time': _workload_report_time(status.get('completionTime')),
                       'deleting': bool(metadata.get('deletionTimestamp'))})
    return result


def _workload_report_index(kind, items):
    require(isinstance(items, list), 'invalid workload report inventory; raw values hidden')
    result = {}
    for obj in items:
        summary = _workload_report_summary(kind, obj)
        identity = (summary['namespace'], summary['name'])
        require(identity not in result, 'duplicate workload report identity; raw values hidden')
        result[identity] = summary
    return result


def key(obj):
    return (obj['metadata'].get('namespace', ''), obj['metadata']['name'])


def index(items):
    result = {key(obj): obj for obj in items}
    require(len(result) == len(items), 'duplicate Kubernetes object identity')
    return result


def verify_volumes(objects):
    pvs = index(objects['pv'])
    pvcs = index(objects['pvc'])
    require({name for _, name in pvs} == set(PV_PATHS), 'PV inventory differs from the reviewed eleven-volume scope')
    require(set(pvcs) == {(v[0], v[1]) for v in PV_PATHS.values()}, 'PVC inventory differs from reviewed scope')
    for name, (namespace, claim, path, kind) in PV_PATHS.items():
        pv, pvc = pvs[('', name)], pvcs[(namespace, claim)]
        spec = pv['spec']
        require(pv['metadata'].get('uid') and pvc['metadata'].get('uid') and
                not pv['metadata'].get('deletionTimestamp') and not pvc['metadata'].get('deletionTimestamp') and
                pv.get('status', {}).get('phase') == pvc.get('status', {}).get('phase') == 'Bound' and
                spec.get(kind, {}).get('path') == path and spec.get('persistentVolumeReclaimPolicy') == 'Retain' and
                spec.get('claimRef', {}).get('namespace') == namespace and spec['claimRef'].get('name') == claim and
                spec['claimRef'].get('uid') == pvc['metadata']['uid'] and pvc['spec'].get('volumeName') == name,
                'retained PV/PVC binding or path is invalid')
        require(spec.get('volumeMode', 'Filesystem') == 'Filesystem' and
                (kind != 'hostPath' or spec[kind].get('type') in ('Directory', 'DirectoryOrCreate')),
                'unsupported volume mode or hostPath type')


def object_payload(obj):
    return {k: obj.get(k) for k in ('data', 'binaryData', 'type', 'immutable')}


def workload_spec(obj, pay_mount_root=None):
    spec = copy.deepcopy(obj['spec'])
    spec.pop('replicas', None)
    if key(obj) == ('mx-pay', 'mx-pay-postgres') and pay_mount_root is not None:
        entries = [e for c in spec['template']['spec']['containers'] if c['name'] == 'postgres'
                   for e in c.get('env', []) if e['name'] == 'MX_PAY_EXPECTED_MOUNT_ROOT']
        require(len(entries) == 1 and entries[0].get('value') == pay_mount_root,
                'Pay PostgreSQL mount guard differs from approved storage')
        entries[0]['value'] = '<approved-mount-root>'
    return spec


class Cluster:
    def __init__(self, host, kubeconfig='/etc/kubernetes/admin.conf'):
        require(kubeconfig == '/etc/kubernetes/admin.conf', 'only the local admin kubeconfig is supported')
        self.host = host
        self.kubeconfig = kubeconfig

    def run(self, args, timeout=60, input_data=None):
        return self.host.run(['kubectl', '--kubeconfig', self.kubeconfig, '--request-timeout=30s'] + args,
                             timeout=timeout, input_data=input_data)

    def document(self, args):
        try:
            value = json.loads(self.run(args))
        except (ValueError, TypeError, UnicodeError):
            raise ClusterError('Kubernetes response was not valid JSON; raw output hidden') from None
        require(isinstance(value, dict), 'Kubernetes response has an unexpected shape')
        return value

    def listing(self, kind, namespace=None):
        args = ['get', kind]
        if namespace:
            args += ['-n', namespace]
        elif kind not in CLUSTER_KINDS:
            args += ['-A']
        value = self.document(args + ['-o', 'json'])
        require(isinstance(value.get('items'), list), 'Kubernetes list response is incomplete')
        return value['items']

    def get(self, kind, namespace, name):
        return self.document(['get', kind, '-n', namespace, name, '-o', 'json'])

    def snapshot(self):
        objects = {kind: self.listing(kind) for kind in KINDS}
        verify_volumes(objects)
        require(len(objects['nodes']) == 1, 'migration requires the original single-node cluster')
        node = objects['nodes'][0]
        require(not node['metadata'].get('deletionTimestamp') and
                any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in node.get('status', {}).get('conditions', [])),
                'local node is not Ready')
        require(not objects['hpa'], 'autoscalers must be explicitly suspended before migration')
        require(all(j.get('spec', {}).get('suspend') is True and not j.get('status', {}).get('active') for j in objects['cronjobs']),
                'active CronJobs are not supported by this migration')
        require(all(not j.get('status', {}).get('active') and
                    any(c.get('type') in ('Complete', 'Failed') and c.get('status') == 'True' for c in j.get('status', {}).get('conditions', []))
                    for j in objects['jobs']), 'unfinished Jobs must finish before migration')
        require(set(index(objects['daemonsets'])) == DAEMONSETS, 'DaemonSet inventory differs from reviewed scope')
        namespace = index(objects['namespaces']).get(('', 'kube-system'))
        require(namespace and namespace['metadata'].get('uid'), 'cluster identity is unavailable')
        allowed_owners = {o['metadata']['uid'] for kind in ('replicasets', 'statefulsets', 'daemonsets', 'jobs') for o in objects[kind]}
        for pod in objects['pods']:
            require(pod.get('spec', {}).get('nodeName') in (None, '', node['metadata']['name']), 'Pod is assigned to another node')
            owners = pod['metadata'].get('ownerReferences', [])
            static = pod['metadata'].get('annotations', {}).get('kubernetes.io/config.mirror')
            if static:
                require(pod['metadata']['namespace'] == 'kube-system' and
                        pod['metadata']['name'] in {name + '-' + node['metadata']['name'] for name in
                                                   ('etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler')},
                        'unknown static Pod requires explicit shutdown/recovery handling')
            require(static or any(o.get('uid') in allowed_owners and o.get('controller') for o in owners),
                    'unmanaged Pod requires explicit shutdown/recovery handling')
        # Guard all templates as well as current Pods: a currently scaled-down
        # controller must not introduce an unreviewed disk on later recovery.
        pod_specs = [p.get('spec', {}) for p in objects['pods']]
        for kind in ('deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs'):
            pod_specs += [o.get('spec', {}).get('template', {}).get('spec', {}) for o in objects[kind]]
        for spec in pod_specs:
            for volume in spec.get('volumes', []):
                types = set(volume) - {'name'}
                require(len(types) == 1 and types <= VOLUME_KINDS, 'unsupported volume type requires explicit migration handling')
                if 'hostPath' in volume:
                    require(volume['hostPath'].get('path') in HOST_PATHS, 'unreviewed hostPath lies outside the migration scope')
        # StatefulSet-generated PVC mounts are covered by the eleven-PVC guard;
        # CSI, ephemeral volume claims and volume devices are deliberately unsupported.
        require(all(not c.get('volumeDevices') for spec in pod_specs for field in
                    ('containers', 'initContainers', 'ephemeralContainers') for c in spec.get(field, [])),
                'raw block volume devices are unsupported')
        replicas = []
        for kind in ('deployments', 'statefulsets'):
            for obj in objects[kind]:
                if obj['metadata']['namespace'] in SYSTEM_NAMESPACES:
                    continue
                count = obj['spec'].get('replicas', 1)
                require(type(count) is int and count >= 0 and obj['metadata'].get('uid') and
                        not obj['metadata'].get('deletionTimestamp'), 'invalid workload identity or replica count')
                replicas.append({'kind': kind, 'namespace': obj['metadata']['namespace'], 'name': obj['metadata']['name'],
                                 'uid': obj['metadata']['uid'], 'replicas': count})
        return {'schema_version': 1, 'node': node['metadata']['name'], 'node_uid': node['metadata']['uid'],
                'cluster_uid': namespace['metadata']['uid'], 'objects': objects, 'replicas': replicas,
                'state': {'workloads': {}, 'es_snapshot': None}}

    def validate_cluster_baseline(self, plan, pay_identity=None):
        """Compare identities and private values, never restore them from backup.

        pay_identity may contain exactly the three approved storage fields. All
        other Pay metadata/credential/installation values must remain exact.
        """
        require(pay_identity is None or set(pay_identity) == PAY_FIELDS, 'invalid approved Pay storage update')
        current = {kind: self.listing(kind) for kind in ('nodes', 'namespaces', 'pv', 'pvc', 'secrets', 'configmaps')}
        verify_volumes(current)
        require(len(current['nodes']) == 1 and current['nodes'][0]['metadata']['uid'] == plan['node_uid'] and
                current['nodes'][0]['metadata']['name'] == plan['node'] and
                index(current['namespaces']).get(('', 'kube-system'), {}).get('metadata', {}).get('uid') == plan['cluster_uid'],
                'cluster or node identity changed')
        for kind in ('pv', 'pvc', 'secrets', 'configmaps'):
            before, after = index(plan['objects'][kind]), index(current[kind])
            require(set(before) == set(after), 'retained object set changed during migration')
            for identity, old in before.items():
                new = after[identity]
                require(old['metadata']['uid'] == new['metadata']['uid'] and not new['metadata'].get('deletionTimestamp'),
                        'retained object UID changed during migration')
                if kind in ('pv', 'pvc'):
                    require(old['spec'] == new['spec'], 'retained volume specification changed')
                    continue
                expected = copy.deepcopy(object_payload(old))
                if kind == 'configmaps' and identity == ('mx-pay', 'mx-pay-database') and pay_identity:
                    try:
                        pay = json.loads(expected['data']['identity'])
                        pay.update(pay_identity)
                        actual = copy.deepcopy(object_payload(new))
                        require(json.loads(actual['data'].pop('identity')) == pay, 'Pay database identity changed outside approved mount fields')
                        expected['data'].pop('identity')
                    except (KeyError, TypeError, ValueError):
                        raise ClusterError('Pay identity response is invalid; raw values hidden') from None
                else:
                    actual = object_payload(new)
                require(expected == actual, 'retained credentials or configuration changed during migration')
        return current

    def _original(self, plan, item):
        return index(plan['objects'][item['kind']])[(item['namespace'], item['name'])]

    def _check_workload(self, plan, item, obj, pay_mount_root=None):
        require(obj['metadata'].get('uid') == item['uid'] and not obj['metadata'].get('deletionTimestamp'), 'workload identity changed')
        original = self._original(plan, item)
        if key(obj) == ('mx-pay', 'mx-pay-postgres') and pay_mount_root is not None:
            old_env = [e['value'] for c in original['spec']['template']['spec']['containers'] if c['name'] == 'postgres'
                       for e in c.get('env', []) if e['name'] == 'MX_PAY_EXPECTED_MOUNT_ROOT']
            require(len(old_env) == 1 and workload_spec(original, old_env[0]) == workload_spec(obj, pay_mount_root),
                    'Pay workload changed outside the approved mount guard')
        else:
            repaired = rig_init_repair.verify_workload(plan, original, obj)
            require(repaired or workload_spec(original) == workload_spec(obj), 'workload specification changed concurrently')
        require(obj['spec'].get('replicas', 1) in (0, item['replicas']), 'workload replica count changed concurrently')

    def _scale(self, plan, item, count, persist, pay_mount_root=None):
        current = self.get(item['kind'], item['namespace'], item['name'])
        self._check_workload(plan, item, current, pay_mount_root)
        state_key = '/'.join((item['kind'], item['namespace'], item['name']))
        plan['state']['workloads'][state_key] = {'phase': 'scale-intent', 'target': count}
        persist(plan)
        if current['spec'].get('replicas', 1) != count:
            patch = [
                {'op': 'test', 'path': '/metadata/uid', 'value': item['uid']},
                {'op': 'test', 'path': '/metadata/resourceVersion', 'value': current['metadata']['resourceVersion']},
                {'op': 'test', 'path': '/spec/replicas', 'value': current['spec']['replicas']},
                {'op': 'replace', 'path': '/spec/replicas', 'value': count},
            ]
            self.run(['patch', item['kind'], '-n', item['namespace'], item['name'], '--type=json',
                      '--patch-file=/dev/stdin'], input_data=json.dumps(patch).encode())
        observed = self.get(item['kind'], item['namespace'], item['name'])
        self._check_workload(plan, item, observed, pay_mount_root)
        require(observed['spec'].get('replicas') == count, 'workload scale was not confirmed')
        plan['state']['workloads'][state_key] = {'phase': 'scaled', 'target': count}
        persist(plan)

    def _pods_for(self, item):
        owners = {item['uid']}
        if item['kind'] == 'deployments':
            owners.update(o['metadata']['uid'] for o in self.listing('replicasets', item['namespace'])
                          if any(r.get('uid') == item['uid'] and r.get('controller') for r in o['metadata'].get('ownerReferences', [])))
        return [p for p in self.listing('pods', item['namespace'])
                if any(r.get('uid') in owners and r.get('controller') for r in p['metadata'].get('ownerReferences', []))]

    def wait_stopped(self, plan, items, timeout=600):
        deadline = time.monotonic() + timeout
        while True:
            done = True
            for item in items:
                obj = self.get(item['kind'], item['namespace'], item['name'])
                self._check_workload(plan, item, obj)
                require(obj['spec'].get('replicas') == 0, 'workload restarted during shutdown')
                done = done and not self._pods_for(item) and obj.get('status', {}).get('replicas', 0) == 0
            if done:
                return
            require(time.monotonic() < deadline, 'workload graceful shutdown timed out; no force deletion attempted')
            time.sleep(2)

    def es_api(self, method, path, body=None):
        require(method in ('GET', 'PUT') and re.fullmatch(r'/[a-z0-9_/?=&.-]+', path), 'unsupported Elasticsearch request')
        args = ['-n', 'mx-common', 'exec'] + (['-i'] if body is not None else [])
        args += ['statefulset/mx-common-elasticsearch', '-c', 'elasticsearch', '--', 'curl', '-fsS', '--max-time', '30', '-X', method]
        if body is not None:
            args += ['-H', 'content-type: application/json', '--data-binary', '@-']
        args += ['http://127.0.0.1:9200' + path]
        try:
            value = json.loads(self.run(args, input_data=json.dumps(body).encode() if body is not None else None))
        except (TypeError, ValueError, UnicodeError):
            raise ClusterError('Elasticsearch returned invalid JSON; raw output hidden') from None
        require(isinstance(value, dict) and 'error' not in value, 'Elasticsearch request did not succeed')
        return value

    def es_snapshot(self, plan, persist, timeout=7200):
        state = plan['state'].get('es_snapshot')
        if state and state.get('phase') == 'verified':
            # A durable verified checkpoint remains usable after ES is stopped.
            return state
        if state is None:
            repository = self.es_api('GET', '/_snapshot/mx-common-snapshots').get('mx-common-snapshots')
            require(repository and repository.get('type') in ('fs', 's3') and not repository.get('settings', {}).get('readonly') in (True, 'true'),
                    'Elasticsearch backup repository is unavailable or read-only')
            if repository['type'] == 'fs':
                require(repository.get('settings', {}).get('location') == '/usr/share/elasticsearch/snapshots',
                        'Elasticsearch snapshot repository location differs from reviewed volume')
            import uuid
            state = {'name': 'mx-move-' + uuid.uuid4().hex, 'phase': 'intent', 'repository_hash': digest(repository)}
            plan['state']['es_snapshot'] = state
            persist(plan)
        require(re.fullmatch(r'mx-move-[a-f0-9]{32}', state['name']), 'invalid retained snapshot identity')
        # List is used to resolve an unknown PUT outcome without issuing a second
        # backup under a different name. The intent is durable before the PUT.
        listing = self.es_api('GET', '/_snapshot/mx-common-snapshots/_all?verbose=true')
        matches = [s for s in listing.get('snapshots', []) if s.get('snapshot') == state['name']]
        if not matches:
            require(state['phase'] == 'intent', 'retained Elasticsearch snapshot disappeared')
            response = self.es_api('PUT', '/_snapshot/mx-common-snapshots/' + state['name'] + '?wait_for_completion=false',
                                   {'ignore_unavailable': False, 'partial': False, 'include_global_state': True})
            require(response.get('accepted') is True, 'Elasticsearch snapshot was not accepted')
            state['phase'] = 'started'
            persist(plan)
        deadline = time.monotonic() + timeout
        while True:
            result = self.es_api('GET', '/_snapshot/mx-common-snapshots/' + state['name'])
            values = result.get('snapshots', [])
            require(len(values) == 1 and values[0].get('snapshot') == state['name'], 'Elasticsearch snapshot identity is ambiguous')
            snapshot = values[0]
            status = snapshot.get('state')
            require(status in ('IN_PROGRESS', 'SUCCESS'), 'Elasticsearch snapshot failed or is partial')
            if status == 'SUCCESS':
                shards = snapshot.get('shards', {})
                require(shards.get('failed') == 0 and shards.get('successful') == shards.get('total') and
                        isinstance(shards.get('total'), int) and shards['total'] > 0 and not snapshot.get('failures'),
                        'Elasticsearch snapshot has missing or failed shards')
                require(isinstance(snapshot.get('uuid'), str) and snapshot['uuid'], 'Elasticsearch snapshot UUID is missing')
                state.update({'phase': 'verified', 'uuid': snapshot.get('uuid'), 'shards': shards,
                              'snapshot_hash': digest(snapshot)})
                persist(plan)
                return state
            require(time.monotonic() < deadline, 'Elasticsearch snapshot is still running; databases were not stopped')
            time.sleep(5)

    def workload_changes(self, plan):
        """Read-only set/UID diagnostics; this does not replace migration guards."""
        require(isinstance(plan, dict) and isinstance(plan.get('objects'), dict),
                'invalid workload report baseline; raw values hidden')
        differences, same_set = [], True
        for kind in WORKLOAD_REPORT_KINDS:
            before = _workload_report_index(kind, plan['objects'].get(kind))
            after = _workload_report_index(kind, self.listing(kind))
            missing = [before[k] for k in sorted(set(before) - set(after))]
            added = [after[k] for k in sorted(set(after) - set(before))]
            replaced = [{'before': before[k], 'after': after[k]}
                        for k in sorted(set(before) & set(after)) if before[k]['uid'] != after[k]['uid']]
            if missing or added:
                same_set = False
            if missing or added or replaced:
                differences.append({'kind': kind, 'missing': missing, 'added': added, 'replaced': replaced})
        return {'schema_version': 1, 'workload_set_equal': same_set,
                'equivalent': not differences, 'differences': differences}

    def assert_workloads(self, plan, pay_mount_root=None):
        """Refuse concurrent controllers or templates outside this transaction."""
        items = {(i['kind'], i['namespace'], i['name']): i for i in plan['replicas']}
        for kind in ('deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'hpa'):
            before, after = index(plan['objects'][kind]), index(self.listing(kind))
            missing = set(before) - set(after)
            require(not (set(after) - set(before)) and (not missing or kind == 'jobs'),
                    'workload set changed during migration')
            if missing:
                self._assert_expired_jobs([before[k] for k in sorted(missing)], plan['objects']['pods'])
            for identity, original in before.items():
                if identity in missing:
                    continue
                current = after[identity]
                require(current['metadata'].get('uid') == original['metadata']['uid'] and
                        not current['metadata'].get('deletionTimestamp'), 'workload UID changed during migration')
                item = items.get((kind,) + identity)
                if item:
                    self._check_workload(plan, item, current, pay_mount_root)
                else:
                    require(current.get('spec') == original.get('spec'), 'controller configuration changed during migration')
                if kind == 'jobs':
                    require(not current.get('status', {}).get('active') and
                            any(c.get('type') in ('Complete', 'Failed') and c.get('status') == 'True'
                                for c in current.get('status', {}).get('conditions', [])),
                            'a Job became active during migration')

    def _assert_expired_jobs(self, jobs, retained_pods):
        """Allow completed TTL cleanup without changing or recreating the baseline."""
        now = time.time()
        for job in jobs:
            summary = _workload_report_summary('jobs', job)
            status = job['status']
            complete = [c for c in status.get('conditions', [])
                        if c.get('type') == 'Complete' and c.get('status') == 'True']
            terminating = status.get('terminating', 0)
            require(summary['terminal'] == 'Complete' and len(complete) == 1 and
                    not summary['active'] and not summary['deleting'] and
                    type(terminating) is int and terminating == 0 and
                    summary['ttl_seconds_after_finished'] is not None,
                    'missing Job is not a completed TTL cleanup candidate')
            completed = _workload_time_epoch(summary['completion_time'])
            transitioned = _workload_time_epoch(complete[0].get('lastTransitionTime'))
            # Kubernetes TTL starts at the terminal condition transition. Also
            # require completionTime to have expired, conservatively taking both.
            require(completed is not None and transitioned is not None and
                    max(completed, transitioned) + summary['ttl_seconds_after_finished'] <= now,
                    'missing Job completion or TTL expiry could not be verified')
        pods = retained_pods + self.listing('pods')
        for job in jobs:
            uid = job['metadata']['uid']
            for pod in pods:
                metadata = pod['metadata']
                owners, labels = metadata.get('ownerReferences', []), metadata.get('labels', {})
                if not (any(r.get('uid') == uid for r in owners) or
                        any(labels.get(k) == uid for k in ('batch.kubernetes.io/controller-uid', 'controller-uid'))):
                    continue
                status = pod.get('status', {})
                require(metadata.get('namespace') == job['metadata']['namespace'] and
                        status.get('phase') in ('Succeeded', 'Failed') and
                        not any('running' in c.get('state', {}) or 'waiting' in c.get('state', {})
                                for field in ('initContainerStatuses', 'containerStatuses', 'ephemeralContainerStatuses')
                                for c in status.get(field, [])),
                        'missing TTL Job still has a nonterminal or ambiguous Pod')

    def quiesce(self, plan, persist):
        self.assert_workloads(plan)
        deployments = [i for i in plan['replicas'] if i['kind'] == 'deployments']
        databases = [i for i in plan['replicas'] if i['kind'] == 'statefulsets']
        for item in deployments:
            self._scale(plan, item, 0, persist)
        self.wait_stopped(plan, deployments)
        self.es_snapshot(plan, persist)
        for item in databases:
            self._scale(plan, item, 0, persist)
        self.wait_stopped(plan, databases)
        self.assert_workloads(plan)
        plan['state']['quiesced'] = True
        persist(plan)

    def assert_quiesced(self, plan):
        require(plan['state'].get('quiesced') and plan['state']['es_snapshot']['phase'] == 'verified', 'cluster quiescence was not confirmed')
        self.assert_workloads(plan)
        self.wait_stopped(plan, plan['replicas'], timeout=0)

    def resume(self, plan, persist, pay_mount_root=None):
        repair = plan.get('state', {}).get('rig_init_repair')
        require(repair is None or isinstance(repair, dict) and repair.get('phase') == 'applied',
                'Rig 初始化修复尚未完成，请重试 resume --repair-rig-init')
        self.assert_workloads(plan, pay_mount_root)
        for kind in ('statefulsets', 'deployments'):
            items = [i for i in plan['replicas'] if i['kind'] == kind]
            for item in items:
                self._scale(plan, item, item['replicas'], persist, pay_mount_root)
            self.wait_ready(plan, items, pay_mount_root=pay_mount_root)
        plan['state']['resumed'] = True
        persist(plan)

    def wait_ready(self, plan, items=None, timeout=1200, pay_mount_root=None):
        items = plan['replicas'] if items is None else items
        deadline = time.monotonic() + timeout
        while True:
            ready = True
            for item in items:
                obj = self.get(item['kind'], item['namespace'], item['name'])
                self._check_workload(plan, item, obj, pay_mount_root)
                count, status = item['replicas'], obj.get('status', {})
                require(obj['spec'].get('replicas') == count, 'restored replica count changed')
                ready = ready and status.get('observedGeneration', 0) >= obj['metadata'].get('generation', 1) and status.get('readyReplicas', 0) == count
            if ready:
                return
            require(time.monotonic() < deadline, 'restored workloads are not Ready; latest data retained')
            time.sleep(3)

    def wait_network_ready(self, plan, timeout=300):
        """Observe original gateway/CNI/proxy and system deployments, never scale.

        These controllers remain scheduled during the business quiescence but
        their Pods still have to be recreated on the new runtime. Node Ready and
        application HTTP readiness alone do not prove the H2I gateway or DNS is
        available.
        """
        expected = {'daemonsets': index(plan['objects']['daemonsets']),
                    'deployments': index([o for o in plan['objects']['deployments']
                                          if o['metadata']['namespace'] in SYSTEM_NAMESPACES])}
        require(set(expected['daemonsets']) == DAEMONSETS and ('kube-system', 'coredns') in expected['deployments'],
                'network controller baseline is incomplete')
        deadline = time.monotonic() + timeout
        while True:
            ready = True
            for kind, before in expected.items():
                objects = self.listing(kind)
                if kind == 'deployments':
                    objects = [o for o in objects if o['metadata']['namespace'] in SYSTEM_NAMESPACES]
                current = index(objects)
                require(set(before) == set(current), 'network controller set changed during migration')
                for identity, old in before.items():
                    obj = current[identity]
                    require(obj['metadata'].get('uid') == old['metadata']['uid'] and
                            not obj['metadata'].get('deletionTimestamp') and obj.get('spec') == old.get('spec'),
                            'network controller identity or specification changed during migration')
                    status = obj.get('status', {})
                    ready = ready and status.get('observedGeneration', 0) >= obj['metadata'].get('generation', 1)
                    if kind == 'daemonsets':
                        ready = ready and all(status.get(field, 0) == 1 for field in
                                              ('desiredNumberScheduled', 'currentNumberScheduled', 'numberReady', 'numberAvailable'))
                        ready = ready and status.get('numberUnavailable', 0) == 0
                    else:
                        count = old['spec'].get('replicas', 1)
                        ready = ready and status.get('readyReplicas', 0) == count and status.get('availableReplicas', 0) == count
            if ready:
                return
            require(time.monotonic() < deadline, 'gateway, CNI, proxy or system DNS is not Ready; latest data retained')
            time.sleep(3)
