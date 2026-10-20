#!/usr/bin/env python3
"""Read-only storage evidence for a subsequent, host-specific migration.

Python 3.6+, standard library only. Never emit raw Kubernetes objects, container
configuration, subprocess errors, recovery snapshots or credential files.
There deliberately is no execution path from this plan to a storage cutover.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys

GIB = 1024 ** 3
FIXED_PATHS = ('/var/lib/etcd', '/var/lib/containerd', '/var/lib/kubelet',
               '/var/lib/mx-launcher', '/var/lib/mx-common', '/var/lib/mx-pay',
               '/var/lib/mx-rig', '/var/log/pods', '/etc/kubernetes', '/etc/cni/net.d',
               '/var/lib/cni', '/data/k8s/mx-runtime/mx-common/k8s',
               '/data/mx-runtime/mx-common/k8s', '/data/mx-rig',
               '/var/lib/mx-base/jenkins-home', '/var/lib/mx-auto', '/var/lib/mx-test-framework')
LOCAL_FS = ('xfs', 'ext4')


class InspectionError(RuntimeError):
    pass


def run(args, timeout=30):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, env=dict(os.environ, LC_ALL='C'))
    except (OSError, subprocess.TimeoutExpired):
        raise InspectionError('{} unavailable or timed out; raw output hidden'.format(args[0])) from None
    if result.returncode:
        raise InspectionError('{} failed (exit {}); raw output hidden'.format(args[0], result.returncode))
    return result.stdout.decode('utf-8')


def stage(label):
    print('[mx-move k8s] ' + label, file=sys.stderr, flush=True)


def pick(value, keys):
    return {k: value[k] for k in keys if k in value}


def within(path, parent):
    return path == parent or path.startswith(parent.rstrip('/') + '/')


def local_path(value):
    return (isinstance(value, str) and value.startswith('/') and
            os.path.normpath(value) == value and not value.startswith('//') and
            not re.search(r'[\x00-\x1f\x7f]', value))


def metadata(obj):
    return pick(obj.get('metadata', {}), ('name', 'namespace', 'uid', 'deletionTimestamp'))


def storage_identity(value):
    keys = ('version', 'root', 'node', 'identifier', 'clusterUID', 'namespace', 'localPath',
            'mountTarget', 'filesystemUUID', 'volumeMountRoot', 'data', 'pgSystemId',
            'phase', 'installationID', 'systemIdentifier', 'pvName', 'pvUID', 'pvcUID')
    result = {k: v for k, v in pick(value, keys).items() if type(v) in (str, int)}
    if 'allowed' in value:
        result['allowed'] = [pick(v, ('uuid', 'inode')) for v in value['allowed']
                             if isinstance(v, dict) and type(v.get('inode')) is int and isinstance(v.get('uuid'), str)]
    if 'mounts' in value:
        result['mounts'] = [{'path': m.get('path'), 'identity': {k: v for k, v in
                            pick(m.get('identity', {}), ('target', 'device', 'root', 'type')).items() if isinstance(v, str)}}
                            for m in value['mounts'] if isinstance(m, dict) and isinstance(m.get('path'), str)]
    return result


def runtime_flags(argv, names):
    result = {}
    for index, arg in enumerate(argv):
        name, equal, value = arg.partition('=')
        if name in names:
            if name in result:
                raise ValueError('duplicate runtime flag')
            if not equal and (index + 1 >= len(argv) or argv[index + 1].startswith('-')):
                raise ValueError('missing runtime flag value')
            result[name] = value if equal else argv[index + 1]
            if not result[name]:
                raise ValueError('empty runtime flag value')
    return result


def runtime_scope(runtime, docker, paths, mounts=None):
    """Never treat an unverified/shared containerd tree as Kubernetes-only data."""
    configured = runtime.get('containerd', {})
    root = configured.get('flags', {}).get('--root') or configured.get('top_level_paths', {}).get('root') or '/var/lib/containerd'
    runtime_roots = (root, '/var/lib/containerd')
    docker_roots = sorted(set(p for p in (docker.get('root'), runtime.get('docker', {}).get('flags', {}).get('--data-root'),
                                         '/var/lib/docker') if local_path(p)))

    def identities(roots):
        found = []
        for path in roots:
            mount = mount_for(path, mounts) if mounts is not None else next((p.get('mount') for p in paths if p['path'] == path), None)
            found.append(((mount or {}).get('uuid'), backing_path(path, mount)))
        return found

    runtime_ids, docker_ids = identities(runtime_roots), identities(docker_roots)
    excluded, selected, mixed_parents, docker_excluded = [], [], [], []
    for p in paths:
        mount = p.get('mount') or {}
        backing = backing_path(p['path'], mount)
        is_runtime = any(within(p['path'], r) for r in runtime_roots) or any(
            uuid and uuid == mount.get('uuid') and prefix and backing and within(backing, prefix)
            for uuid, prefix in runtime_ids)
        contains_runtime = not is_runtime and (any(within(r, p['path']) for r in runtime_roots) or any(
            uuid and uuid == mount.get('uuid') and prefix and backing and within(prefix, backing)
            for uuid, prefix in runtime_ids))
        overlaps_docker = any(within(p['path'], r) or within(r, p['path']) for r in docker_roots) or any(
            uuid and uuid == mount.get('uuid') and prefix and backing and (within(backing, prefix) or within(prefix, backing))
            for uuid, prefix in docker_ids)
        if contains_runtime:
            mixed_parents.append(p['path'])
        if is_runtime or contains_runtime:
            excluded.append(p['path'])
        if overlaps_docker:
            docker_excluded.append(p['path'])
        if not (is_runtime or contains_runtime or overlaps_docker):
            selected.append(p)
    docker_endpoint = runtime.get('docker', {}).get('flags', {}).get('--containerd')
    return {'docker_data_migration': False, 'existing_containerd_tree_migration': False,
            'containerd_root': root, 'docker_configured_containerd_endpoint': docker_endpoint,
            'docker_running_count': sum(bool(c.get('running')) for c in docker.get('containers', [])),
            'excluded_runtime_paths': excluded,
            'overlapping_runtime_parent_paths': mixed_parents,
            'protected_docker_roots': docker_roots, 'overlapping_docker_data_paths': docker_excluded,
            'runtime_isolation_required_before_k8s_runtime_move': True,
            'note': 'docker_overlap covers bind paths only; an empty list does not prove runtime isolation.'}, selected


def volume_summary(volume):
    result = {'name': volume.get('name')}
    if 'hostPath' in volume:
        result.update(kind='hostPath', **pick(volume['hostPath'], ('path', 'type')))
    elif 'persistentVolumeClaim' in volume:
        result.update(kind='pvc', **pick(volume['persistentVolumeClaim'], ('claimName', 'readOnly')))
    elif 'emptyDir' in volume:
        result.update(kind='emptyDir', **pick(volume['emptyDir'], ('medium', 'sizeLimit')))
    else:
        # Names of Secret/configMap volumes are harmless; never copy their contents.
        result['kind'] = next((k for k in volume if k != 'name'), 'unknown')
    return result


def pod_summary(obj, spec=None):
    spec = obj.get('spec', {}) if spec is None else spec
    result = metadata(obj)
    result.update(kind=obj.get('kind', 'Pod'), node=spec.get('nodeName'),
                  hostNetwork=bool(spec.get('hostNetwork')),
                  volumes=[volume_summary(v) for v in spec.get('volumes', [])])
    result['owners'] = [pick(o, ('kind', 'name', 'uid')) for o in obj.get('metadata', {}).get('ownerReferences', [])]
    result['phase'] = obj.get('status', {}).get('phase')
    result['ready'] = next((c.get('status') for c in obj.get('status', {}).get('conditions', []) if c.get('type') == 'Ready'), None)
    result['containers'] = []
    for key in ('containers', 'initContainers', 'ephemeralContainers'):
        for c in spec.get(key, []):
            result['containers'].append({'name': c.get('name'), 'type': key,
                'mounts': [pick(m, ('name', 'mountPath', 'subPath', 'subPathExpr', 'readOnly')) for m in c.get('volumeMounts', [])],
                'devices': [pick(m, ('name', 'devicePath')) for m in c.get('volumeDevices', [])],
                # The one allowlisted value is storage identity, never env in general.
                'payMountRoot': next((e.get('value') for e in c.get('env', []) if e.get('name') == 'MX_PAY_EXPECTED_MOUNT_ROOT'), None)})
    return result


def pv_summary(obj):
    result, spec = metadata(obj), obj.get('spec', {})
    result.update(pick(spec, ('capacity', 'storageClassName', 'persistentVolumeReclaimPolicy', 'volumeMode', 'accessModes')))
    result['claim'] = pick(spec.get('claimRef', {}), ('name', 'namespace', 'uid'))
    result['phase'] = obj.get('status', {}).get('phase')
    result['nodeAffinity'] = spec.get('nodeAffinity', {})
    for kind in ('hostPath', 'local'):
        if kind in spec:
            result.update(kind=kind, **pick(spec[kind], ('path', 'type')))
            break
    else:
        result['kind'] = 'nfs' if 'nfs' in spec else 'csi' if 'csi' in spec else 'other'
        if 'csi' in spec:
            result['driver'] = spec['csi'].get('driver')
    return result


def cluster_summary(raw):
    result = {'nodes': [], 'pvs': [], 'pvcs': [], 'pods': [], 'workloads': []}
    for obj in raw.get('nodes', []):
        n = metadata(obj)
        n.update(hostname=obj.get('metadata', {}).get('labels', {}).get('kubernetes.io/hostname'),
                 systemUUID=obj.get('status', {}).get('nodeInfo', {}).get('systemUUID'),
                 unschedulable=obj.get('spec', {}).get('unschedulable', False),
                 conditions=[pick(c, ('type', 'status')) for c in obj.get('status', {}).get('conditions', [])])
        result['nodes'].append(n)
    result['pvs'] = [pv_summary(obj) for obj in raw.get('pv', [])]
    for obj in raw.get('pvc', []):
        c = metadata(obj)
        c.update(pick(obj.get('spec', {}), ('volumeName', 'storageClassName', 'volumeMode')))
        c['phase'] = obj.get('status', {}).get('phase')
        result['pvcs'].append(c)
    result['pods'] = [pod_summary(obj) for obj in raw.get('pods', [])]
    for obj in raw.get('workloads', []):
        spec = obj.get('spec', {})
        template = spec.get('jobTemplate', {}).get('spec', {}).get('template') if obj.get('kind') == 'CronJob' else spec.get('template')
        w = pod_summary(obj, (template or {}).get('spec', {}))
        w.update(pick(spec, ('replicas', 'suspend')))
        w['status'] = pick(obj.get('status', {}), ('replicas', 'readyReplicas', 'availableReplicas', 'desiredNumberScheduled', 'numberReady', 'active'))
        result['workloads'].append(w)
    return result


def parse_fstab(raw):
    rows = []
    for line in raw.splitlines():
        fields = line.split('#', 1)[0].split()
        if len(fields) < 4:
            continue
        source, target, fstype, options = fields[:4]
        # Do not print NFS/CIFS credentials or arbitrary option values.
        rows.append({'source': source if (fstype in LOCAL_FS or (fstype == 'none' and 'bind' in options.split(','))) and source.startswith(('/', 'UUID=', 'LABEL=')) else '<remote>',
                     'target': target, 'fstype': fstype,
                     'options': [v for v in options.split(',') if v in ('bind', 'rbind', 'ro', 'rw', 'noauto', 'nofail', '_netdev')]})
    return rows


def mount_summary(rows):
    result = []
    for row in rows:
        m = pick(row, ('target', 'fstype', 'uuid', 'fsroot'))
        m['source'] = row.get('source') if row.get('fstype') in LOCAL_FS else '<non-local-or-virtual>'
        m['writable'] = 'rw' in (row.get('options') or '').split(',')
        result.append(m)
        result.extend(mount_summary(row.get('children', [])))
    return result


def mount_for(path, mounts):
    matches = [m for m in mounts if m.get('target') and within(path, m['target'])]
    return max(matches, key=lambda m: len(m['target'])) if matches else None


def backing_path(path, mount):
    if not mount or not mount.get('uuid') or not mount.get('fsroot'):
        return None
    return os.path.normpath(os.path.join(mount['fsroot'], os.path.relpath(path, mount['target'])))


def discover_paths(cluster, node):
    paths = {p: ['known-runtime-or-service-path'] for p in FIXED_PATHS}
    unresolved = []
    pvs = {p['name']: p for p in cluster['pvs']}
    claims = {(p.get('namespace'), p['name']): p for p in cluster['pvcs']}
    for claim in cluster['pvcs']:
        pv = pvs.get(claim.get('volumeName'))
        if not pv or claim.get('phase') != 'Bound' or pv.get('phase') != 'Bound' or pv.get('claim', {}).get('uid') != claim.get('uid'):
            unresolved.append('PVC binding incomplete/inconsistent: {}/{}'.format(claim.get('namespace'), claim['name']))

    def add(path, origin):
        if local_path(path):
            paths.setdefault(path, []).append(origin)
        else:
            unresolved.append('invalid/non-canonical local path: ' + origin)

    # An unattached or retained PV is important evidence but on a multi-node
    # cluster it is not proof that a same-named local directory is its data.
    single_local = len(cluster['nodes']) == 1 and node == cluster['nodes'][0].get('name')
    for p in cluster['pvs']:
        if p['kind'] in ('local', 'hostPath'):
            if single_local:
                add(p.get('path'), 'PV/' + p['name'])
            else:
                unresolved.append('PV node ownership requires review: ' + p['name'])
        elif p['kind'] != 'nfs':
            unresolved.append('CSI/other PV requires provider-specific inventory: ' + p['name'])
    for pod in cluster['pods']:
        if not node or pod.get('node') != node:
            continue
        ref = '{}/{}'.format(pod.get('namespace'), pod['name'])
        for volume in pod['volumes']:
            if volume['kind'] == 'hostPath':
                add(volume.get('path'), 'Pod/' + ref)
            elif volume['kind'] == 'pvc':
                claim = claims.get((pod.get('namespace'), volume.get('claimName')))
                pv = pvs.get((claim or {}).get('volumeName'))
                if not claim or not pv or claim.get('phase') != 'Bound' or pv.get('phase') != 'Bound' or pv.get('claim', {}).get('uid') != claim.get('uid'):
                    unresolved.append('PVC binding incomplete/inconsistent: ' + ref + '/' + str(volume.get('claimName')))
                elif pv['kind'] in ('local', 'hostPath'):
                    add(pv.get('path'), 'Pod/' + ref + ' via PV/' + pv['name'])
    for workload in cluster['workloads']:
        for v in workload['volumes']:
            if v['kind'] == 'hostPath':
                origin = '{}/{}/{}'.format(workload['kind'], workload.get('namespace'), workload['name'])
                if single_local:
                    add(v.get('path'), origin)
                else:
                    unresolved.append('template hostPath node ownership requires review: ' + origin)
    return paths, sorted(set(unresolved))


def select_node(nodes, hostname, system_uuid, requested=None):
    matches = []
    if system_uuid and any(hostname in (n.get('name'), n.get('hostname')) and
                           n.get('systemUUID') and str(n['systemUUID']).lower() != system_uuid.lower()
                           for n in nodes):
        return None
    for n in nodes:
        if system_uuid and n.get('systemUUID'):
            matched = str(n['systemUUID']).lower() == system_uuid.lower()
        else:
            matched = hostname in (n.get('name'), n.get('hostname'))
        if matched:
            matches.append(n['name'])
    if requested:
        return requested if requested in matches else None
    return matches[0] if len(matches) == 1 else None


def capacity_plan(paths, target, mounts, reserve_gib=100):
    """Conservative live estimate, never a cold-copy or integrity verdict."""
    target_mount = mount_for(target, mounts)
    groups, unknown = [], []
    for p in paths:
        m = p.get('mount') or {}
        if not p.get('exists'):
            if p.get('exists') is None or any(x.startswith(('PV/', 'Pod/')) for x in p['origins']):
                unknown.append(p['path'] + ': referenced path missing')
            continue
        if p.get('symlink'):
            unknown.append(p['path'] + ': symlink target requires separate scope review')
            continue
        if not m or not m.get('fstype'):
            unknown.append(p['path'] + ': mount identity unavailable')
            continue
        if m.get('fstype') not in LOCAL_FS:
            if m.get('fstype') not in ('nfs', 'nfs4', 'cifs', 'tmpfs', 'devtmpfs', 'proc', 'sysfs'):
                unknown.append(p['path'] + ': unsupported filesystem ' + str(m.get('fstype')))
            continue
        if not m.get('uuid') or not target_mount or not target_mount.get('uuid'):
            unknown.append(p['path'] + ': filesystem identity unknown')
            continue
        if m['uuid'] == target_mount['uuid']:
            continue
        if not p.get('directory') or p.get('symlink'):
            unknown.append(p['path'] + ': file/device/symlink requires separate review')
            continue
        root = backing_path(p['path'], m)
        if root is None or root == '/':
            unknown.append(p['path'] + ': whole filesystem consumer; do not copy blindly')
            continue
        groups.append({'path': p['path'], 'uuid': m['uuid'], 'fsroot': root,
                       'bytes': p.get('bytes'), 'aliases': [p['path']]})
    dedup = []
    for group in sorted(groups, key=lambda x: (len(x['fsroot']), len(x['path']), x['path'])):
        parent = next((g for g in dedup if g['uuid'] == group['uuid'] and within(group['fsroot'], g['fsroot'])), None)
        if parent:
            parent['aliases'].append(group['path'])
        else:
            dedup.append(group)
    for group in dedup:
        if group['bytes'] is None:
            unknown.append(group['path'] + ': size not measured or incomplete')
    size = sum(g['bytes'] or 0 for g in dedup)
    # A 25% growth margin and at least 100 GiB retained on /, independent of
    # the smaller etcd budget. Database snapshots/backups need a separate budget.
    reserve = reserve_gib * GIB
    required = (size * 5 + 3) // 4 + reserve
    return {'groups': dedup, 'unknown': sorted(set(unknown)), 'measured_bytes': size,
            'required_bytes_lower_bound': required, 'reserve_bytes': reserve,
            'growth_margin_percent': 25, 'backup_budget_included': False,
            'complete': not unknown}


class Inspector:
    def __init__(self, args):
        self.args, self.errors = args, []

    def attempt(self, label, function, default=None):
        try:
            return function()
        except (InspectionError, OSError, ValueError, KeyError, TypeError, IndexError):
            # No input, response, exception message, env or file content leaks.
            self.errors.append(label + ': unavailable/incomplete (raw output hidden)')
            return default

    def kube(self, *args):
        return json.loads(run(['kubectl', '--kubeconfig=' + self.args.kubeconfig,
            '--request-timeout=20s'] + list(args), 30))

    def read_cluster(self):
        raw = {}
        for key, resource, namespaced in (
                ('nodes', 'nodes', False), ('pv', 'pv', False), ('pvc', 'pvc', True),
                ('pods', 'pods', True),
                ('workloads', 'deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs', True)):
            stage('读取 Kubernetes ' + key)
            raw[key] = self.attempt('Kubernetes ' + key,
                lambda r=resource, ns=namespaced: self.kube('get', r, *(['-A'] if ns else []), '-o', 'json')['items'], [])
        return cluster_summary(raw)

    def read_path(self, path, origins, mounts):
        result = {'path': path, 'origins': sorted(set(origins)), 'exists': False, 'bytes': None}
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return result
        result.update(exists=True, directory=stat.S_ISDIR(st.st_mode),
                      symlink=os.path.realpath(path) != path, uid=st.st_uid, gid=st.st_gid,
                      mode=oct(stat.S_IMODE(st.st_mode)), device=st.st_dev, inode=st.st_ino,
                      mount=mount_for(path, mounts))
        if result['symlink']:
            result['resolved_path'] = os.path.realpath(path)
            result['resolved_mount'] = mount_for(result['resolved_path'], mounts)
        children = [m for m in mounts if m.get('target') != path and within(m.get('target', ''), path)]
        result['nested_mount_count'] = len(children)
        result['nested_mount_sample'] = children[:4]
        # Never traverse kubelet projected secrets, live overlay mounts, a whole
        # filesystem, NFS, symlinks or arbitrary mounted subtrees. Those sizes are
        # explicitly unknown. Measure smaller PV roots separately when possible.
        m = result['mount'] or {}
        if self.args.measure and result['directory'] and not result['symlink'] and not children and m.get('fstype') in LOCAL_FS and backing_path(path, m) != '/':
            stage('低优先级测量目录（最长 {} 秒）：{}'.format(self.args.du_timeout, path))
            command = ['du', '-sx', '--block-size=1', '--', path]
            if shutil.which('nice'):
                command = ['nice', '-n', '19'] + command
            if shutil.which('ionice'):
                command = ['ionice', '-c', '3'] + command
            raw = self.attempt('du ' + path, lambda: run(command, self.args.du_timeout))
            if raw is not None:
                def size():
                    value = int(raw.split()[0])
                    if value < 0:
                        raise ValueError('negative size')
                    return value
                result['bytes'] = self.attempt('du size ' + path, size)
        return result

    def docker(self):
        if not shutil.which('docker'):
            return {'status': 'client-absent', 'containers': []}
        # Only ask Docker for allowlisted fields; no environment/labels/commands.
        root = json.loads(run(['docker', 'info', '--format', '{{json .DockerRootDir}}']))
        ids = run(['docker', 'ps', '-aq']).split()
        containers = []
        template = '{"name":{{json .Name}},"running":{{json .State.Running}},"networkMode":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}}}'
        for offset in range(0, len(ids), 50):
            raw = run(['docker', 'inspect', '--format', template] + ids[offset:offset + 50])
            for line in raw.splitlines():
                c = json.loads(line)
                c['mounts'] = [pick(m, ('Type', 'Source', 'Destination', 'RW', 'Propagation')) for m in c['mounts']]
                containers.append(c)
        return {'status': 'inspected', 'root': root, 'containers': containers}

    def identities(self, namespaces):
        # Presence and storage fields only. Do not read Launcher latest.json,
        # identity/profile.json or config.env: they contain credentials.
        paths = ['/var/lib/mx-move/active-etcd.json', '/var/lib/mx-common/storage-identity.json']
        paths += ['/var/lib/mx-pay/{}/storage-identity.json'.format(ns) for ns in namespaces]
        output = []
        for path in paths:
            if Path(path).exists():
                value = self.attempt('storage receipt ' + path, lambda p=path: storage_identity(json.loads(Path(p).read_text())))
                output.append({'path': path, 'storage': value})
        host = Path('/var/lib/mx-launcher-recovery/host.json')
        if host.exists():
            value = self.attempt('Launcher host receipt', lambda: storage_identity(json.loads(host.read_text())))
            output.append({'path': str(host), 'storage': value})
        return output

    def runtime(self, services):
        output = {}
        for name, names in (
                ('kubelet', ('--root-dir', '--config', '--container-runtime-endpoint', '--hostname-override')),
                ('containerd', ('--root', '--state', '--config', '-c', '--address', '-a')),
                ('docker', ('--data-root', '--config-file', '--containerd'))):
            pid = services.get(name, {}).get('MainPID', '0')
            if not str(pid).isdigit() or int(pid) <= 0:
                output[name] = {'status': 'no-running-main-pid'}
                continue
            def read(n=name, p=pid, flags=names):
                argv = Path('/proc/{}/cmdline'.format(p)).read_bytes().decode().strip('\0').split('\0')
                result = {'flags': runtime_flags(argv, flags)}
                if n == 'containerd':
                    config = result['flags'].get('--config', result['flags'].get('-c', '/etc/containerd/config.toml'))
                    result['config_path'] = config
                    # Read only literal top-level root/state. Imports and complex
                    # TOML require review rather than inventing an effective root.
                    if Path(config).is_file():
                        text = Path(config).read_text()
                        header = re.split(r'(?m)^\s*\[', text, maxsplit=1)[0]
                        result['top_level_paths'] = {}
                        for key in ('root', 'state'):
                            match = re.search(r'''(?m)^\s*{}\s*=\s*["'](/[^"'\n]*)["']\s*(?:#.*)?$'''.format(key), header)
                            if match:
                                result['top_level_paths'][key] = match.group(1)
                        imports = re.search(r'(?m)^\s*imports\s*=\s*(.*)$', header)
                        result['has_imports'] = bool(imports and not re.fullmatch(r'\[\s*\]\s*(?:#.*)?', imports.group(1)))
                return result
            output[name] = self.attempt('runtime flags ' + name, read, {'status': 'unavailable'})
        return output

    def pay_identities(self, cluster):
        def read():
            items = self.kube('get', 'configmaps', '-A', '--field-selector=metadata.name=mx-pay-database', '-o', 'json')['items']
            return [{'namespace': obj['metadata']['namespace'],
                     'storage': storage_identity(json.loads(obj['data']['identity']))} for obj in items]
        output = self.attempt('Pay ConfigMaps', read, [])
        expected = set(w.get('namespace') for w in cluster['workloads'] if w.get('name') == 'mx-pay-postgres')
        if expected - set(p['namespace'] for p in output):
            self.errors.append('Pay workload exists without readable storage ConfigMap')
        return output

    def postgres_links(self, paths):
        output, seen = [], set()
        for path in paths:
            for suffix in ('', 'pgdata', 'postgres/pgdata', 'postgres/data/pgdata', 'k8s/postgres/pgdata'):
                data = Path(path) / suffix
                if str(data) in seen or not (data / 'PG_VERSION').is_file():
                    continue
                seen.add(str(data))
                def read(p=data):
                    with (p / 'PG_VERSION').open('rb') as handle:
                        version = handle.read(16).decode().strip()
                    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', version):
                        raise ValueError('invalid PG version')
                    result = {'path': str(p), 'version': version, 'external_links': []}
                    with (p / 'global/pg_control').open('rb') as handle:
                        header = handle.read(12)
                    if len(header) != 12:
                        raise ValueError('incomplete PG control')
                    result['control_first8_hex'] = header[:8].hex()
                    result['system_identifier'] = str(int.from_bytes(header[:8], sys.byteorder))
                    links = [p / 'pg_wal', p / 'pg_xlog', p / 'pg_tblspc']
                    if (p / 'pg_tblspc').is_dir() and not (p / 'pg_tblspc').is_symlink():
                        links += list((p / 'pg_tblspc').iterdir())
                    for link in links:
                        if link.is_symlink():
                            result['external_links'].append({'path': str(link), 'target': os.path.realpath(str(link))})
                    return result
                value = self.attempt('PostgreSQL identity/links ' + str(data), read)
                if value:
                    output.append(value)
        return output

    def collect(self):
        stage('读取文件系统、持久挂载与块设备')
        mounts = self.attempt('findmnt', lambda: mount_summary(json.loads(run(['findmnt', '--json', '--list', '--output', 'TARGET,SOURCE,FSTYPE,FSROOT,UUID,OPTIONS']))['filesystems']), [])
        disks = self.attempt('lsblk', lambda: json.loads(run(['lsblk', '--json', '--bytes', '--output', 'NAME,KNAME,TYPE,SIZE,FSTYPE,UUID,MOUNTPOINT,PKNAME'])), {})
        fstab = self.attempt('fstab', lambda: parse_fstab(Path('/etc/fstab').read_text()), [])
        cluster = self.read_cluster()
        cluster_uid = self.attempt('cluster UID', lambda: self.kube('get', 'namespace', 'kube-system', '-o', 'json')['metadata']['uid'])
        system_uuid = self.attempt('DMI UUID', lambda: Path('/sys/class/dmi/id/product_uuid').read_text().strip(), '')
        node = select_node(cluster['nodes'], socket.gethostname(), system_uuid, self.args.node)
        paths, unresolved = discover_paths(cluster, node)
        if not node:
            unresolved.append('cannot verify this host against a Kubernetes node; --node cannot bypass identity verification')
        stage('读取服务状态及 Docker 挂载消费者')
        services = {}
        for name in ('kubelet', 'containerd', 'docker'):
            services[name] = self.attempt('systemd ' + name, lambda n=name: dict(line.split('=', 1) for line in run(
                ['systemctl', 'show', n + '.service', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'RequiresMountsFor']).splitlines() if '=' in line), {})
        runtime = self.runtime(services)
        for name, flag in (('kubelet', '--root-dir'), ('containerd', '--root')):
            config = runtime.get(name, {})
            path = config.get('flags', {}).get(flag) or config.get('top_level_paths', {}).get('root')
            if local_path(path):
                paths.setdefault(path, []).append('actual-runtime-root/' + name)
        docker = self.attempt('Docker inventory', self.docker, {'status': 'unavailable', 'containers': []})
        # Record bind sources as consumers; don't include Docker-only data in the
        # Kubernetes copy budget. Overlap with proposed groups is checked below.
        receipts = self.identities(sorted(set(p.get('namespace') for p in cluster['pvcs'] if p.get('namespace'))))
        pay = self.pay_identities(cluster)
        for receipt in receipts:
            storage = receipt.get('storage') or {}
            for key in ('root', 'localPath'):
                if local_path(storage.get(key)):
                    paths.setdefault(storage[key], []).append('storage-receipt')
        postgres = self.postgres_links(paths)
        for database in postgres:
            for link in database['external_links']:
                if local_path(link['target']):
                    paths.setdefault(link['target'], []).append('PostgreSQL external WAL/tablespace')
                unresolved.append('PostgreSQL external link requires copy/restore design: ' + link['path'])
        evidence = [self.attempt('path ' + p, lambda p=p, o=o: self.read_path(p, o, mounts),
                    {'path': p, 'origins': o, 'exists': None, 'bytes': None}) for p, o in sorted(paths.items())]
        target = self.args.target_root
        ancestor = Path(target)
        while not ancestor.exists() and ancestor != ancestor.parent:
            ancestor = ancestor.parent
        target_mount = mount_for(str(ancestor), mounts)
        root_mount = mount_for('/', mounts)
        space = self.attempt('target free space', lambda: os.statvfs(str(ancestor)))
        capacity = capacity_plan(evidence, target, mounts, self.args.reserve_gib)
        scope, data_evidence = runtime_scope(runtime, docker, evidence, mounts)
        data_capacity = capacity_plan(data_evidence, target, mounts, self.args.reserve_gib)
        data_capacity['unknown'] += [p + ': contains excluded shared runtime; split scope before copying'
                                     for p in scope['overlapping_runtime_parent_paths']]
        data_capacity['unknown'] += [p + ': overlaps Docker data; resolve shared consumer without migrating Docker data'
                                     for p in scope['overlapping_docker_data_paths']]
        capacity['target_available_bytes'] = space.f_bavail * space.f_frsize if space else None
        capacity['target_total_bytes'] = space.f_blocks * space.f_frsize if space else None
        capacity['lower_bound_fits'] = (capacity['target_available_bytes'] >= capacity['required_bytes_lower_bound']) if space else None
        capacity['complete'] = capacity['complete'] and not unresolved and not self.errors
        data_capacity['complete'] = not data_capacity['unknown'] and not unresolved and not self.errors
        # Keep the original all-path measurements for comparison with old reports.
        # Only the second estimate obeys the user's Kubernetes-only copy scope;
        # a future dedicated runtime's image/storage budget is not known yet.
        data_capacity['dedicated_runtime_budget_included'] = False
        data_capacity['target_available_bytes'] = capacity['target_available_bytes']
        blockers = list(unresolved) + self.errors + capacity['unknown'] + data_capacity['unknown']
        if not target_mount or not root_mount or not root_mount.get('uuid') or target_mount.get('uuid') != root_mount.get('uuid') or target_mount.get('fstype') not in LOCAL_FS or not target_mount.get('writable'):
            blockers.append('target must be on the writable, UUID-identified local root filesystem')
        if os.path.realpath(str(ancestor)) != str(ancestor):
            blockers.append('target contains a symlink')
        if any(within(target, p) or within(p, target) for p in paths):
            blockers.append('target overlaps a runtime/service source path')
        if capacity['lower_bound_fits'] is False:
            blockers.append('insufficient target space even before backup budget')
        overlap = []
        for container in docker['containers']:
            for m in container['mounts']:
                source = m.get('Source', '')
                backing = backing_path(source, mount_for(source, mounts)) if local_path(source) else None
                source_mount = mount_for(source, mounts) if backing else None
                for g in capacity['groups']:
                    if backing and source_mount.get('uuid') == g['uuid'] and (within(backing, g['fsroot']) or within(g['fsroot'], backing)):
                        overlap.append({'container': container['name'], 'source': source, 'group': g['path'], 'running': container['running']})
        if overlap:
            blockers.append('Docker also consumes migration data; coordinate its writers separately')
        blockers += ['maintenance window and application-specific shutdown/backup/acceptance steps required',
                     'existing containerd tree is excluded: preserve Docker; isolate Kubernetes runtime before moving its images/state',
                     'Launcher/mx-common/Pay storage guards must be reconciled without changing credentials',
                     'runtime flags, nested mounts, external writers and physical backing disks require review',
                     'backup destination/budget and latest-data rollback are not yet established']
        relevant_mounts = set(m['target'] for m in (mount_for(p, mounts) for p in list(paths) + ['/', '/home', '/data', '/mnt/nas', target]) if m)
        return {'schema_version': 1, 'collected_at_utc': datetime.datetime.utcnow().isoformat() + 'Z',
                'mode': self.args.action, 'read_only': True, 'execution_supported': False,
                'host': socket.gethostname(), 'node': node, 'cluster_uid': cluster_uid, 'cluster': cluster,
                'mounts': [m for m in mounts if m['target'] in relevant_mounts],
                'total_mount_count': len(mounts), 'fstab': fstab, 'block_devices': disks, 'services': services,
                'runtime': runtime, 'pay_storage_configmaps': pay, 'postgres_data': postgres,
                'docker': docker, 'docker_overlap': overlap, 'storage_receipts': receipts,
                'migration_scope': scope, 'kubernetes_data_capacity': data_capacity,
                'paths': evidence, 'target_root': target, 'capacity': capacity,
                'blockers': sorted(set(blockers)), 'collection_errors': self.errors,
                'notes': ['Live sizes are estimates, not a consistent database backup.',
                          'etcd already on root is excluded by filesystem UUID; its existing guard is retained.',
                          'NAS/CSI and Docker-only storage are not automatically selected for copying.',
                          'No Secrets, env dumps, pod commands or recovery snapshots are included.']}


def main(argv=None):
    parser = argparse.ArgumentParser(description='mx-move k8s: 只读盘点/容量草案，不停服务、不复制、不改挂载')
    parser.add_argument('action', choices=('inventory', 'plan'))
    parser.add_argument('--measure', action='store_true', help='低优先级 du；存在嵌套挂载的目录不扫描，大小标记未知')
    parser.add_argument('--du-timeout', type=int, default=30, help='每个目录 du 的最长秒数，默认 30')
    parser.add_argument('--node', help='指定本机节点名，仍核对 hostname/systemUUID')
    parser.add_argument('--kubeconfig', default='/etc/kubernetes/admin.conf')
    parser.add_argument('--target-root', default='/var/lib/mx-move/k8s-data')
    parser.add_argument('--reserve-gib', type=int, default=100, help='根分区预留 GiB，最少 100，不含另行核定的备份预算')
    args = parser.parse_args(argv)
    if not local_path(args.target_root) or args.target_root == '/' or args.reserve_gib < 100 or not 1 <= args.du_timeout <= 600:
        parser.error('目标须为规范绝对目录，预留至少 100 GiB，du 超时为 1..600 秒')
    if not sys.platform.startswith('linux') or os.geteuid() != 0:
        parser.error('请在 Internal 控制平面 Linux 主机以 root 执行')
    report = Inspector(args).collect()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    # A complete collection is still not approval/executable migration readiness.
    return 2 if report['collection_errors'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError, KeyError, InspectionError):
        print('盘点失败；请检查工具和本机访问权限（原始输出已隐藏）。', file=sys.stderr)
        sys.exit(1)
