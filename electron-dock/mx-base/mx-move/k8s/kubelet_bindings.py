"""Recognize two reviewed local kubelet binds during online planning only.

Recognition never authorizes manual unmounting. The caller must wait for
kubelet to release these binds after graceful Pod shutdown, before stopping it.
No file contents are read, and no commands or mount mutations are performed.
"""
import json
import os
import re
import stat

import storage_guard as guard

KUBELET = '/var/lib/kubelet'
PAY_PATH = guard.ROOTS['pay-postgres']
PAY_PV = 'mx-pay-postgres-data'
ES_CONFIG = 'mx-common-elasticsearch-config'
UID = r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
GENERATION = r'\.\.[0-9]{4}_(?:[0-9]{2}_){4}[0-9]{2}\.[0-9]+'


class _Mismatch(Exception):
    pass


def require(value, reason):
    if not value:
        raise _Mismatch(reason)


def one(items, predicate, reason):
    require(isinstance(items, list), reason)
    values = [item for item in items if isinstance(item, dict) and predicate(item)]
    require(len(values) == 1, reason)
    return values[0]


def named(objects, kind, namespace, name):
    obj = one(objects.get(kind), lambda value: value.get('metadata', {}).get('name') == name and
              value['metadata'].get('namespace', '') == namespace, 'object-identity-mismatch')
    require(obj['metadata'].get('uid') and not obj['metadata'].get('deletionTimestamp'),
            'object-identity-mismatch')
    return obj


def pod_for(objects, uid, namespace, workload):
    pod = named(objects, 'pods', namespace, workload + '-0')
    owner = named(objects, 'statefulsets', namespace, workload)
    require(pod['metadata']['uid'] == uid and pod['spec'].get('nodeName') == 'mx-internal-server',
            'pod-identity-mismatch')
    one(pod['metadata'].get('ownerReferences'), lambda value: value.get('kind') == 'StatefulSet' and
        value.get('name') == workload and value.get('uid') == owner['metadata']['uid'] and
        value.get('controller') is True, 'pod-controller-mismatch')
    return pod


def volume(pod, name, kind):
    value = one(pod['spec'].get('volumes'), lambda item: item.get('name') == name, 'pod-volume-mismatch')
    require(set(value) == {'name', kind} and isinstance(value[kind], dict), 'pod-volume-mismatch')
    return value[kind]


def container(pod, name):
    return one(pod['spec'].get('containers'), lambda item: item.get('name') == name, 'pod-container-mismatch')


def path_info(path):
    # The general guard deliberately rejects '~' in migration roots. Only the
    # two exact Kubernetes plugin directory components need this local adapter.
    if '/kubernetes.io~' not in path:
        return guard.path_info(path, protected=False)
    parent, suffix = path.split('/kubernetes.io~', 1)
    components = ('kubernetes.io~' + suffix).split('/')
    require(components[0] in ('kubernetes.io~local-volume', 'kubernetes.io~configmap') and
            all(re.fullmatch(r'[A-Za-z0-9_.-]+', part) and part not in ('.', '..')
                for part in components[1:]), 'local-plugin-path-mismatch')
    info = guard.path_info(parent, protected=False)
    require(stat.S_ISDIR(info.st_mode), 'local-plugin-path-mismatch')
    for index, part in enumerate(components):
        parent += '/' + part
        info = os.lstat(parent)
        require(not stat.S_ISLNK(info.st_mode) and
                (stat.S_ISDIR(info.st_mode) or
                 (index == len(components) - 1 and stat.S_ISREG(info.st_mode))),
                'local-plugin-path-mismatch')
    return info


def same_identity(paths, directory=False):
    values = [path_info(path) for path in paths]
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    require(all(expected_type(value.st_mode) for value in values), 'bind-file-type-mismatch')
    require(all(guard.identity(value) == guard.identity(values[0]) for value in values),
            'bind-inode-mismatch')


def pay_binding(mount, objects, uid):
    pod = pod_for(objects, uid, 'mx-pay', 'mx-pay-postgres')
    claim = volume(pod, 'data', 'persistentVolumeClaim')
    require(claim.get('claimName') == PAY_PV and claim.get('readOnly', False) is False,
            'pay-pod-claim-mismatch')
    mounted = one(container(pod, 'postgres').get('volumeMounts'), lambda value: value.get('name') == 'data',
                  'pay-container-mount-mismatch')
    require(mounted.get('mountPath') == '/var/lib/postgresql/data' and
            mounted.get('readOnly', False) is False and not mounted.get('subPath') and
            not mounted.get('subPathExpr'), 'pay-container-mount-mismatch')
    pv, pvc = named(objects, 'pv', '', PAY_PV), named(objects, 'pvc', 'mx-pay', PAY_PV)
    spec = pv['spec']
    require(isinstance(spec.get('local'), dict) and spec['local'].get('path') == PAY_PATH and
            not any(kind in spec for kind in ('hostPath', 'nfs', 'csi')) and
            spec.get('persistentVolumeReclaimPolicy') == 'Retain' and
            spec.get('volumeMode', 'Filesystem') == pvc['spec'].get('volumeMode', 'Filesystem') == 'Filesystem' and
            pv.get('status', {}).get('phase') == pvc.get('status', {}).get('phase') == 'Bound',
            'pay-local-pv-mismatch')
    reference = spec.get('claimRef', {})
    require(reference.get('namespace') == 'mx-pay' and reference.get('name') == PAY_PV and
            reference.get('uid') == pvc['metadata']['uid'] and pvc['spec'].get('volumeName') == PAY_PV,
            'pay-pv-pvc-binding-mismatch')
    require(mount.get('fsroot') == PAY_PATH[len('/data'):], 'pay-bind-fsroot-mismatch')
    same_identity((PAY_PATH, mount['target']), directory=True)


def es_binding(mount, objects, uid, kubelet_mount):
    pod = pod_for(objects, uid, 'mx-common', 'mx-common-elasticsearch')
    config = volume(pod, 'config', 'configMap')
    require(config.get('name') == ES_CONFIG and not config.get('items') and not config.get('optional'),
            'es-configmap-volume-mismatch')
    named(objects, 'configmaps', 'mx-common', ES_CONFIG)
    mounts = container(pod, 'elasticsearch').get('volumeMounts', [])
    require(isinstance(mounts, list) and len(mounts) > 2 and isinstance(mounts[2], dict),
            'es-config-subpath-mismatch')
    selected = mounts[2]
    require(selected.get('name') == 'config' and selected.get('subPath') == 'elasticsearch.yml' and
            not selected.get('subPathExpr') and selected.get('readOnly') is True and
            selected.get('mountPath') == '/usr/share/elasticsearch/config/elasticsearch.yml',
            'es-config-subpath-mismatch')
    relative = '/pods/' + uid + '/volumes/kubernetes.io~configmap/config'
    logical = KUBELET + relative
    prefix = kubelet_mount['fsroot'] + relative + '/'
    fsroot = mount.get('fsroot')
    require(isinstance(fsroot, str) and fsroot.startswith(prefix), 'es-bind-fsroot-mismatch')
    suffix = fsroot[len(prefix):]
    require(re.fullmatch(GENERATION + r'/elasticsearch\.yml', suffix), 'es-bind-fsroot-mismatch')
    generation = suffix.split('/')[0]
    # Check every directory without following symlinks before inspecting the
    # two exact AtomicWriter links. Never resolve an arbitrary symlink target.
    path_info(logical)
    require(os.readlink(logical + '/elasticsearch.yml') == '..data/elasticsearch.yml' and
            os.readlink(logical + '/..data') == generation, 'es-config-symlink-mismatch')
    atomic_file = logical + '/' + suffix
    same_identity((atomic_file, '/data' + fsroot, mount['target']))
    require(os.path.realpath(logical + '/elasticsearch.yml') == atomic_file,
            'es-config-realpath-mismatch')


def verify(mount, objects, source_uuid, kubelet_mount):
    """Return None for an attested reviewed bind, otherwise StorageError.

    objects is Cluster.snapshot()['objects']; kubelet_mount is the verified
    current /var/lib/kubelet bind. Inputs and private API values are never logged.
    """
    stage = 'invalid-inspection-data'
    try:
        require(isinstance(mount, dict) and isinstance(objects, dict) and isinstance(kubelet_mount, dict), stage)
        require(isinstance(source_uuid, str) and re.fullmatch(UID, source_uuid), stage)
        stage = 'local-source-filesystem-mismatch'
        require(mount.get('fstype') == 'xfs' and mount.get('uuid') == source_uuid and
                kubelet_mount.get('target') == KUBELET and kubelet_mount.get('fstype') == 'xfs' and
                kubelet_mount.get('uuid') == source_uuid and kubelet_mount.get('fsroot') == '/mx-runtime/kubelet', stage)
        target = mount.get('target')
        require(isinstance(target, str), 'unsupported-kubelet-bind-target')
        pay = re.fullmatch(KUBELET + r'/pods/(' + UID + r')/volumes/kubernetes\.io~local-volume/' + PAY_PV, target)
        es = re.fullmatch(KUBELET + r'/pods/(' + UID + r')/volume-subpaths/config/elasticsearch/2', target)
        require(pay or es, 'unsupported-kubelet-bind-target')
        stage = 'local-path-identity-unavailable'
        if pay:
            pay_binding(mount, objects, pay.group(1))
        else:
            es_binding(mount, objects, es.group(1), kubelet_mount)
    except (_Mismatch, guard.StorageError, OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        reason = str(error) if isinstance(error, _Mismatch) else stage
        fields = mount if isinstance(mount, dict) else {}
        diagnostic = {key: fields.get(key) if isinstance(fields.get(key), str) else None for key in ('target', 'fstype')}
        diagnostic['reason'] = reason
        raise guard.StorageError('unsupported kubelet local bind; kubelet_binding=' +
                                 json.dumps(diagnostic, ensure_ascii=True, separators=(',', ':'))) from None
