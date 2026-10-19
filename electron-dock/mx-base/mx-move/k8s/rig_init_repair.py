"""One retained Rig init-container repair during a stopped migration recovery.

The caller owns the migration lock and verifies the original data mounts.  This
module changes one capability list and never rewrites the original checkpoint.
RollingUpdate is first scaled to zero and fully drained; OnDelete can delete
only the retained failed Pod whose PostgreSQL container has never started.
All API objects and error output stay private.
"""
import copy
import json


class Error(RuntimeError):
    pass


NAMESPACE = 'mx-rig'
NAME = 'mx-rig-postgres'
POD = NAME + '-0'
INIT = 'fix-permissions'
OLD = ['CHOWN']
NEW = ['CHOWN', 'DAC_OVERRIDE']
COMMAND = ['sh', '-c', 'chown -R 999:999 /var/lib/postgresql/data']
SECURITY = {'runAsUser': 0, 'runAsNonRoot': False,
            'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
            'capabilities': {'drop': ['ALL'], 'add': OLD}}
RECORD_FIELDS = {'schema_version', 'statefulset_uid', 'init_index', 'phase',
                 'old_pod_uid', 'pod_phase'}


def require(value, message):
    if not value:
        raise Error(message)


def target(obj):
    metadata = obj.get('metadata', {})
    return metadata.get('namespace') == NAMESPACE and metadata.get('name') == NAME


def spec(obj):
    value = copy.deepcopy(obj['spec'])
    value.pop('replicas', None)
    return value


def shape(pod_spec):
    """Recognize only the reviewed init operation and original data consumer."""
    inits = pod_spec.get('initContainers', [])
    containers = pod_spec.get('containers', [])
    require(len(inits) == 1 and inits[0].get('name') == INIT and
            len(containers) == 1 and containers[0].get('name') == 'postgres',
            'Rig repair requires the original single init and PostgreSQL container')
    init, postgres = inits[0], containers[0]
    capabilities = init.get('securityContext', {}).get('capabilities', {}).get('add')
    require(capabilities in (OLD, NEW), 'Rig init capabilities are outside the reviewed repair')
    security = copy.deepcopy(init.get('securityContext'))
    security['capabilities']['add'] = OLD
    require(security == SECURITY and init.get('command') == COMMAND and
            not init.get('args') and init.get('image') == postgres.get('image') == 'postgres:17-alpine',
            'Rig init command, image or security context differs from the reviewed repair')
    require(not pod_spec.get('ephemeralContainers') and pod_spec.get('automountServiceAccountToken') is False,
            'Rig repair requires the original isolated PostgreSQL Pod')
    pgdata = [e for e in postgres.get('env', []) if e.get('name') == 'PGDATA']
    require(pgdata == [{'name': 'PGDATA', 'value': '/var/lib/postgresql/data/pgdata'}],
            'Rig PostgreSQL data path differs from the reviewed installation')
    volumes = [v for v in pod_spec.get('volumes', []) if v.get('name') == 'data']
    require(volumes == [{'name': 'data', 'persistentVolumeClaim': {'claimName': 'mx-rig-postgres-data'}}],
            'Rig PostgreSQL volume differs from the reviewed installation')
    for container in (init, postgres):
        mounts = [m for m in container.get('volumeMounts', []) if m.get('name') == 'data']
        require(mounts == [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}],
                'Rig PostgreSQL data mount differs from the reviewed installation')
    return capabilities


def expected(original):
    require(target(original) and original.get('metadata', {}).get('uid') and
            not original['metadata'].get('deletionTimestamp') and original['spec'].get('replicas') == 1,
            'Rig repair checkpoint is not the original single-replica StatefulSet')
    shape(original['spec']['template']['spec'])
    require(original['spec'].get('updateStrategy') in
            ({'type': 'OnDelete'}, {'type': 'RollingUpdate', 'rollingUpdate': {'partition': 0}}),
            'Rig StatefulSet update strategy is unsupported')
    require(not original['spec'].get('volumeClaimTemplates'),
            'Rig repair requires the existing static PVC without generated claims')
    value = spec(original)
    value['template']['spec']['initContainers'][0]['securityContext']['capabilities']['add'] = NEW[:]
    return value


def record(plan, original):
    value = plan.get('state', {}).get('rig_init_repair')
    require(isinstance(value, dict) and set(value) == RECORD_FIELDS and
            type(value.get('schema_version')) is int and value['schema_version'] == 1 and
            value.get('statefulset_uid') == original['metadata']['uid'] and
            type(value.get('init_index')) is int and value['init_index'] == 0 and
            value.get('phase') in ('intent', 'applied') and
            value.get('pod_phase') in ('pending', 'delete-intent', 'replacement-observed', 'not-needed',
                                       'draining', 'drained') and
            (value.get('old_pod_uid') is None or isinstance(value['old_pod_uid'], str) and value['old_pod_uid']),
            'Rig init repair record is invalid or belongs to another StatefulSet')
    require((value['old_pod_uid'] is None) == (value['pod_phase'] == 'not-needed'),
            'Rig init repair Pod intent is inconsistent')
    if original['spec']['updateStrategy']['type'] == 'RollingUpdate':
        require(value['old_pod_uid'] and value['pod_phase'] in ('draining', 'drained') and
                (value['phase'] != 'applied' or value['pod_phase'] == 'drained'),
                'Rig rolling repair has no retained drain intent')
    else:
        require(value['pod_phase'] not in ('draining', 'drained'), 'Rig repair strategy differs from its intent')
    return value


def verify_workload(plan, original, current):
    """Return False when the caller must use its unchanged strict comparison."""
    if not target(original) or plan.get('state', {}).get('rig_init_repair') is None:
        return False
    repaired = expected(original)
    state = record(plan, original)
    require(target(current) and current.get('metadata', {}).get('uid') == state['statefulset_uid'] and
            not current['metadata'].get('deletionTimestamp'), 'Rig StatefulSet identity changed during repair')
    permitted = [repaired]
    if state['phase'] == 'intent':
        permitted.append(spec(original))
    require(spec(current) in permitted, 'Rig workload changed outside the retained init capability repair')
    require(current['spec'].get('replicas') in (0, 1), 'Rig replica count changed during repair')
    return True


def _live(cluster, original, state=None):
    current = cluster.get('statefulsets', NAMESPACE, NAME)
    counts = (0, 1) if state and original['spec']['updateStrategy']['type'] == 'RollingUpdate' else (1,)
    require(target(current) and current.get('metadata', {}).get('uid') == original['metadata']['uid'] and
            current['metadata'].get('resourceVersion') and not current['metadata'].get('deletionTimestamp') and
            current['spec'].get('replicas') in counts, 'Rig StatefulSet is not the original recovering replica')
    permitted = [expected(original)]
    if state is None or state['phase'] == 'intent':
        permitted.append(spec(original))
    require(spec(current) in permitted, 'Rig StatefulSet changed outside the single init capability repair')
    return current


def _pod(cluster):
    matches = [p for p in cluster.listing('pods', NAMESPACE) if p.get('metadata', {}).get('name') == POD]
    require(len(matches) <= 1, 'Rig PostgreSQL Pod identity is ambiguous')
    return matches[0] if matches else None


def _pod_shape(plan, original, pod):
    metadata = pod.get('metadata', {})
    owners = metadata.get('ownerReferences', [])
    require(metadata.get('name') == POD and metadata.get('namespace') == NAMESPACE and
            metadata.get('uid') and metadata.get('resourceVersion') and
            len([o for o in owners if o.get('controller')]) == 1 and
            any(o.get('kind') == 'StatefulSet' and o.get('name') == NAME and
                o.get('uid') == original['metadata']['uid'] and o.get('controller') is True for o in owners) and
            pod.get('spec', {}).get('nodeName') in (None, '', plan['node']),
            'Rig PostgreSQL Pod does not belong to the original local StatefulSet')
    actual, baseline = pod['spec'], original['spec']['template']['spec']
    capabilities = shape(actual)
    init = copy.deepcopy(actual['initContainers'])
    before = copy.deepcopy(baseline['initContainers'])
    init[0]['securityContext']['capabilities']['add'] = OLD
    before[0]['securityContext']['capabilities']['add'] = OLD
    require(init == before and actual['containers'] == baseline['containers'],
            'Rig Pod containers differ outside the reviewed init capability')
    for field in ('volumes', 'securityContext', 'affinity', 'nodeSelector', 'runtimeClassName',
                  'imagePullSecrets', 'readinessGates', 'dnsConfig'):
        require(actual.get(field) == baseline.get(field), 'Rig Pod storage or execution configuration changed')
    for field in ('hostNetwork', 'hostPID', 'hostIPC'):
        require(bool(actual.get(field)) == bool(baseline.get(field)), 'Rig Pod host namespace configuration changed')
    require(actual.get('serviceAccountName', 'default') == baseline.get('serviceAccountName', 'default'),
            'Rig Pod service account changed')
    return capabilities


def _failed_before_postgres(plan, original, pod):
    require(_pod_shape(plan, original, pod) == OLD and not pod['metadata'].get('deletionTimestamp') and
            pod['spec'].get('nodeName') == plan['node'] and pod.get('status', {}).get('phase') == 'Pending',
            'Only the local failed legacy Rig init Pod may be recreated')
    status = pod.get('status', {})
    main = status.get('containerStatuses', [])
    require(len(main) == 1 and main[0].get('name') == 'postgres' and
            main[0].get('restartCount') == 0 and not main[0].get('ready') and
            not main[0].get('started') and not main[0].get('containerID') and not main[0].get('lastState') and
            set(main[0].get('state', {})) == {'waiting'} and
            main[0]['state']['waiting'].get('reason') == 'PodInitializing',
            'Rig PostgreSQL may have started; refusing automatic Pod deletion')
    inits = status.get('initContainerStatuses', [])
    require(len(inits) == 1 and inits[0].get('name') == INIT and
            type(inits[0].get('restartCount')) is int and inits[0]['restartCount'] > 0 and
            inits[0].get('state', {}).get('waiting', {}).get('reason') == 'CrashLoopBackOff' and
            type(inits[0].get('lastState', {}).get('terminated', {}).get('exitCode')) is int and
            inits[0]['lastState']['terminated']['exitCode'] != 0 and
            any(c.get('type') == 'Initialized' and c.get('status') == 'False' for c in status.get('conditions', [])),
            'Rig init failure is not the reviewed pre-start crash loop')


def _save(plan, persist):
    persist(plan)


def _patch_capability(cluster, plan, original, state, current, persist, replicas):
    repaired = expected(original)
    require(current['spec'].get('replicas') == replicas, 'Rig replica count changed before the capability patch')
    if spec(current) != repaired:
        path = '/spec/template/spec/initContainers/0/securityContext/capabilities/add'
        patch = [{'op': 'test', 'path': '/metadata/uid', 'value': state['statefulset_uid']},
                 {'op': 'test', 'path': '/metadata/resourceVersion', 'value': current['metadata']['resourceVersion']},
                 {'op': 'test', 'path': '/spec/replicas', 'value': replicas},
                 {'op': 'test', 'path': '/spec/template/spec/initContainers/0/name', 'value': INIT},
                 {'op': 'test', 'path': path, 'value': OLD},
                 {'op': 'replace', 'path': path, 'value': NEW}]
        # An uncertain response is resolved by reading this same object.  The
        # retained intent permits only the exact original or repaired spec.
        try:
            cluster.run(['patch', 'statefulset', '-n', NAMESPACE, NAME, '--type=json',
                         '--patch-file=/dev/stdin'], input_data=json.dumps(patch).encode())
        except Exception:
            current = _live(cluster, original, state)
            require(spec(current) == repaired and current['spec'].get('replicas') == replicas,
                    'Rig capability patch was not confirmed; retained intent can be retried')
        current = _live(cluster, original, state)
        require(spec(current) == repaired and current['spec'].get('replicas') == replicas,
                'Rig capability patch was not observed; retained intent can be retried')
    state['phase'] = 'applied'
    _save(plan, persist)


def _rolling_repair(cluster, plan, original, state, current, persist):
    # Once the template is durably repaired, recovery may already have started
    # PostgreSQL.  Never scale that restored replica down a second time.
    if state['phase'] == 'applied':
        return state
    items = [i for i in plan['replicas'] if i.get('kind') == 'statefulsets' and
             i.get('namespace') == NAMESPACE and i.get('name') == NAME]
    require(len(items) == 1 and items[0].get('uid') == original['metadata']['uid'] and
            items[0].get('replicas') == 1, 'Rig replica checkpoint differs from the retained StatefulSet')
    item = items[0]
    if current['spec']['replicas'] == 1:
        pod = _pod(cluster)
        require(pod and pod['metadata'].get('uid') == state['old_pod_uid'],
                'Rig failed Pod changed before its retained drain intent was applied')
        _failed_before_postgres(plan, original, pod)
        # The existing cluster helper uses UID/RV CAS and normal Kubernetes
        # termination.  If init recovers meanwhile, PostgreSQL still receives
        # its normal grace period; no force deletion is used.
        try:
            cluster._scale(plan, item, 0, persist)
        except Exception:
            current = _live(cluster, original, state)
            require(current['spec'].get('replicas') == 0,
                    'Rig zero-replica intent was not confirmed; retry the retained repair')
    cluster.wait_stopped(plan, [item])
    current = _live(cluster, original, state)
    remaining = [p for p in cluster.listing('pods', NAMESPACE)
                 if p.get('metadata', {}).get('name') == POD or
                 any(o.get('uid') == original['metadata']['uid'] and o.get('controller')
                     for o in p.get('metadata', {}).get('ownerReferences', []))]
    require(current['spec'].get('replicas') == 0 and current.get('status', {}).get('replicas', 0) == 0 and
            current.get('status', {}).get('observedGeneration', 0) >= current['metadata'].get('generation', 1) and
            not remaining, 'Rig must be fully drained and observed before changing its rolling template')
    state['pod_phase'] = 'drained'
    _save(plan, persist)
    _patch_capability(cluster, plan, original, state, current, persist, replicas=0)
    return state


def repair(cluster, plan, persist):
    originals = [o for o in plan['objects']['statefulsets'] if target(o)]
    require(len(originals) == 1, 'Rig StatefulSet checkpoint is missing or ambiguous')
    original = originals[0]
    repaired = expected(original)
    state = plan.get('state', {}).get('rig_init_repair')
    if state is not None:
        state = record(plan, original)
    current = _live(cluster, original, state)
    rolling = original['spec']['updateStrategy']['type'] == 'RollingUpdate'
    if state is not None and rolling and state['phase'] == 'applied':
        return state
    pod = _pod(cluster)
    if state is None:
        require(pod is not None, 'Inspect the missing Rig Pod before preparing an init repair')
        capabilities = _pod_shape(plan, original, pod)
        old_uid = None
        if capabilities == OLD:
            _failed_before_postgres(plan, original, pod)
            old_uid = pod['metadata']['uid']
        else:
            require(not rolling, 'A rolling Rig repair requires the reviewed failed legacy init Pod')
            require(spec(current) == repaired, 'Rig Pod and StatefulSet capability repair do not agree')
        state = {'schema_version': 1, 'statefulset_uid': original['metadata']['uid'], 'init_index': 0,
                 'phase': 'intent', 'old_pod_uid': old_uid,
                 'pod_phase': 'draining' if rolling else ('pending' if old_uid else 'not-needed')}
        plan['state']['rig_init_repair'] = state
        _save(plan, persist)
    if rolling:
        return _rolling_repair(cluster, plan, original, state, current, persist)
    _patch_capability(cluster, plan, original, state, current, persist, replicas=1)
    pod = _pod(cluster)
    if pod is None:
        return state
    capabilities = _pod_shape(plan, original, pod)
    if pod['metadata']['uid'] != state['old_pod_uid']:
        require(capabilities == NEW, 'Rig replacement Pod still has the legacy init capability')
        if state['old_pod_uid']:
            state['pod_phase'] = 'replacement-observed'
            _save(plan, persist)
        return state
    if pod['metadata'].get('deletionTimestamp'):
        return state
    _failed_before_postgres(plan, original, pod)
    # Recheck the template immediately before requesting graceful deletion.
    _live(cluster, original, state)
    state['pod_phase'] = 'delete-intent'
    _save(plan, persist)
    options = {'apiVersion': 'v1', 'kind': 'DeleteOptions',
               'preconditions': {'uid': pod['metadata']['uid'], 'resourceVersion': pod['metadata']['resourceVersion']}}
    try:
        cluster.run(['delete', '--raw', '/api/v1/namespaces/mx-rig/pods/mx-rig-postgres-0',
                     '-f', '/dev/stdin'], input_data=json.dumps(options).encode())
    except Exception:
        observed = _pod(cluster)
        require(observed is None or observed['metadata'].get('uid') != state['old_pod_uid'] or
                observed['metadata'].get('deletionTimestamp'),
                'Rig Pod deletion was not confirmed; retained UID can be rechecked safely')
        if observed is not None and observed['metadata'].get('uid') != state['old_pod_uid']:
            require(_pod_shape(plan, original, observed) == NEW, 'Rig replacement Pod lacks the repaired init capability')
    return state
