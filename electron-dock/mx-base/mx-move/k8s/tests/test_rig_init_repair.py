"""Bound the recovery repair to one init capability and one never-started Pod."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import rig_init_repair as repair


def statefulset():
    return {
        'apiVersion': 'apps/v1', 'kind': 'StatefulSet',
        'metadata': {'namespace': 'mx-rig', 'name': 'mx-rig-postgres', 'uid': 'rig-sts-uid',
                     'resourceVersion': '20', 'generation': 3},
        'spec': {
            'replicas': 1, 'serviceName': 'mx-rig-postgres', 'updateStrategy': {'type': 'OnDelete'},
            'selector': {'matchLabels': {'app.kubernetes.io/name': 'mx-rig-postgres'}},
            'template': {
                'metadata': {'labels': {'app.kubernetes.io/name': 'mx-rig-postgres'}},
                'spec': {
                    'automountServiceAccountToken': False,
                    'securityContext': {'runAsNonRoot': True, 'runAsUser': 999, 'runAsGroup': 999,
                                        'fsGroup': 999, 'seccompProfile': {'type': 'RuntimeDefault'}},
                    'initContainers': [{
                        'name': 'fix-permissions', 'image': 'postgres:17-alpine',
                        'command': ['sh', '-c', 'chown -R 999:999 /var/lib/postgresql/data'],
                        'securityContext': {'runAsUser': 0, 'runAsNonRoot': False,
                            'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                            'capabilities': {'drop': ['ALL'], 'add': ['CHOWN']}},
                        'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}],
                    }],
                    'containers': [{
                        'name': 'postgres', 'image': 'postgres:17-alpine',
                        'env': [{'name': 'PGDATA', 'value': '/var/lib/postgresql/data/pgdata'},
                                {'name': 'POSTGRES_PASSWORD', 'valueFrom': {'secretKeyRef': {
                                    'name': 'mx-rig-secrets', 'key': 'MX_RIG_POSTGRES_PASSWORD'}}}],
                        'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}],
                        'securityContext': {'allowPrivilegeEscalation': False,
                            'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
                    }],
                    'volumes': [{'name': 'data', 'persistentVolumeClaim': {
                        'claimName': 'mx-rig-postgres-data'}}],
                },
            },
        },
    }


def capabilities(value):
    return value['spec']['template']['spec']['initContainers'][0]['securityContext']['capabilities']


def failed_pod(workload):
    spec = copy.deepcopy(workload['spec']['template']['spec'])
    spec['nodeName'] = 'mx-internal-server'
    return {
        'apiVersion': 'v1', 'kind': 'Pod',
        'metadata': {'namespace': 'mx-rig', 'name': 'mx-rig-postgres-0', 'uid': 'rig-pod-old',
                     'resourceVersion': '31', 'ownerReferences': [{
                         'apiVersion': 'apps/v1', 'kind': 'StatefulSet', 'name': 'mx-rig-postgres',
                         'uid': workload['metadata']['uid'], 'controller': True}]},
        'spec': spec,
        'status': {'phase': 'Pending', 'conditions': [{'type': 'Initialized', 'status': 'False'}],
                   'initContainerStatuses': [{
            'name': 'fix-permissions', 'ready': False, 'restartCount': 4,
            'state': {'waiting': {'reason': 'CrashLoopBackOff'}},
            'lastState': {'terminated': {'exitCode': 1, 'reason': 'Error'}},
        }], 'containerStatuses': [{
            'name': 'postgres', 'ready': False, 'started': False, 'restartCount': 0,
            'state': {'waiting': {'reason': 'PodInitializing'}}, 'lastState': {},
        }]},
    }


def pointer(document, path):
    pieces = path.lstrip('/').split('/')
    parent = document
    for piece in pieces[:-1]:
        parent = parent[int(piece)] if isinstance(parent, list) else parent[piece]
    last = int(pieces[-1]) if isinstance(parent, list) else pieces[-1]
    return parent, last


class FakeCluster:
    def __init__(self, original):
        self.current = copy.deepcopy(original)
        self.pods = [failed_pod(original)]
        self.events = []
        self.fail_patch = None
        self.fail_delete = None
        self.patch_race = False
        self.fail_scale = None
        self.keep_pods = False
        self.stale_scale_status = False
        self.persisted = []

    def get(self, kind, namespace, name):
        assert (kind, namespace, name) == ('statefulsets', 'mx-rig', 'mx-rig-postgres')
        return copy.deepcopy(self.current)

    def listing(self, kind, namespace):
        assert (kind, namespace) == ('pods', 'mx-rig')
        return copy.deepcopy(self.pods)

    def persist(self, plan):
        self.persisted.append(copy.deepcopy(plan))
        self.events.append(('persist', copy.deepcopy(plan)))

    def _scale(self, plan, item, count, persist):
        assert (item['kind'], item['namespace'], item['name'], item['uid'], count) == (
            'statefulsets', 'mx-rig', 'mx-rig-postgres', self.current['metadata']['uid'], 0)
        self.events.append(('scale', count))
        failure, self.fail_scale = self.fail_scale, None
        plan['state'].setdefault('workloads', {})['statefulsets/mx-rig/mx-rig-postgres'] = {
            'phase': 'scale-intent', 'target': count}
        persist(plan)
        if failure == 'before':
            raise repair.Error('scale response unavailable')
        if self.current['spec']['replicas'] != count:
            self.events.append(('scale-api', count))
            self.current['spec']['replicas'] = count
            self.current['metadata']['resourceVersion'] = str(int(self.current['metadata']['resourceVersion']) + 1)
            self.current['metadata']['generation'] += 1
        self.current['status'] = {'observedGeneration': self.current['metadata']['generation'],
                                  'replicas': 1 if self.stale_scale_status else count,
                                  'readyReplicas': 0, 'currentReplicas': 0, 'updatedReplicas': 0}
        if failure == 'after':
            raise repair.Error('scale response unavailable')
        plan['state']['workloads']['statefulsets/mx-rig/mx-rig-postgres']['phase'] = 'scaled'
        persist(plan)

    def wait_stopped(self, plan, items):
        assert len(items) == 1 and items[0]['name'] == 'mx-rig-postgres'
        self.events.append(('wait-stopped', self.current['spec']['replicas']))
        if self.current['spec']['replicas'] != 0 or self.keep_pods:
            raise repair.Error('Pod has not stopped')
        self.pods = []

    def run(self, args, input_data=None):
        body = json.loads(input_data)
        self.events.append((args[0], copy.deepcopy(args), copy.deepcopy(body)))
        if args[0] == 'patch':
            failure, self.fail_patch = self.fail_patch, None
            if failure == 'before':
                raise repair.Error('patch response unavailable')
            if self.patch_race:
                self.current['metadata']['resourceVersion'] = str(int(self.current['metadata']['resourceVersion']) + 1)
                self.patch_race = False
            changed = copy.deepcopy(self.current)
            for item in body:
                parent, key = pointer(changed, item['path'])
                if item['op'] == 'test':
                    if parent[key] != item['value']:
                        raise repair.Error('API test precondition failed')
                else:
                    assert item['op'] == 'replace'
                    parent[key] = copy.deepcopy(item['value'])
            changed['metadata']['resourceVersion'] = str(int(changed['metadata']['resourceVersion']) + 1)
            self.current = changed
            if failure == 'after':
                raise repair.Error('patch response unavailable')
            return json.dumps(changed).encode()
        if args[0] == 'delete':
            failure, self.fail_delete = self.fail_delete, None
            if failure == 'before':
                raise repair.Error('delete response unavailable')
            conditions = body['preconditions']
            assert conditions == {key: self.pods[0]['metadata'][key] for key in ('uid', 'resourceVersion')}
            self.pods = []
            if failure == 'after':
                raise repair.Error('delete response unavailable')
            return b'{}'
        raise AssertionError(args)


class RigInitRepairTests(unittest.TestCase):
    def setUp(self):
        self.original = statefulset()
        self.plan = {'node': 'mx-internal-server', 'objects': {'statefulsets': [copy.deepcopy(self.original)]},
                     'state': {}, 'replicas': [{'kind': 'statefulsets', 'namespace': 'mx-rig',
                         'name': 'mx-rig-postgres', 'uid': 'rig-sts-uid', 'replicas': 1}]}
        self.baseline = copy.deepcopy(self.plan['objects'])
        self.cluster = FakeCluster(self.original)

    def run_repair(self):
        return repair.repair(self.cluster, self.plan, self.cluster.persist)

    def assert_baseline_retained(self):
        self.assertEqual(self.plan['objects'], self.baseline)

    def test_missing_record_and_other_workload_do_not_relax_baseline(self):
        changed = copy.deepcopy(self.original)
        capabilities(changed)['add'].append('DAC_OVERRIDE')
        self.assertFalse(repair.verify_workload(self.plan, self.original, changed))
        self.run_repair()
        other = copy.deepcopy(self.original)
        other['metadata']['name'] = 'some-other-postgres'
        self.assertFalse(repair.verify_workload(self.plan, other, other))
        self.assert_baseline_retained()

    def test_old_template_patch_is_durable_cas_and_only_changes_capability(self):
        self.run_repair()
        patches = [event for event in self.cluster.events if event[0] == 'patch']
        self.assertEqual(len(patches), 1)
        operations = patches[0][2]
        tests = {op['path']: op['value'] for op in operations if op['op'] == 'test'}
        self.assertEqual(tests['/metadata/uid'], self.original['metadata']['uid'])
        self.assertEqual(tests['/metadata/resourceVersion'], self.original['metadata']['resourceVersion'])
        cap_path = '/spec/template/spec/initContainers/0/securityContext/capabilities/add'
        self.assertEqual(tests[cap_path], ['CHOWN'])
        self.assertEqual([op for op in operations if op['op'] != 'test'], [
            {'op': 'replace', 'path': cap_path, 'value': ['CHOWN', 'DAC_OVERRIDE']}])
        patch_position = next(i for i, event in enumerate(self.cluster.events) if event[0] == 'patch')
        persisted_before = [event[1] for event in self.cluster.events[:patch_position] if event[0] == 'persist']
        self.assertEqual(persisted_before[-1]['state']['rig_init_repair']['phase'], 'intent')
        self.assertEqual(persisted_before[-1]['state']['rig_init_repair']['old_pod_uid'], 'rig-pod-old')
        expected = copy.deepcopy(self.original['spec'])
        expected['template']['spec']['initContainers'][0]['securityContext']['capabilities']['add'].append('DAC_OVERRIDE')
        self.assertEqual(self.cluster.current['spec'], expected)
        self.assertTrue(repair.verify_workload(self.plan, self.original, self.cluster.current))
        self.assert_baseline_retained()

    def test_failed_pod_delete_is_uid_and_resource_version_guarded(self):
        self.run_repair()
        deletions = [event for event in self.cluster.events if event[0] == 'delete']
        self.assertEqual(len(deletions), 1)
        args, body = deletions[0][1:]
        self.assertTrue(any(arg == '--raw' or arg.startswith('--raw=') for arg in args))
        self.assertEqual(body['preconditions'], {'uid': 'rig-pod-old', 'resourceVersion': '31'})
        self.assertFalse(any(arg in ('--force', '--all') for arg in args))
        deletion_position = next(i for i, event in enumerate(self.cluster.events) if event[0] == 'delete')
        persisted_before = [event[1] for event in self.cluster.events[:deletion_position] if event[0] == 'persist']
        retained = persisted_before[-1]['state']['rig_init_repair']
        self.assertEqual(retained['phase'], 'applied')
        self.assertEqual(retained['pod_phase'], 'delete-intent')
        self.assertEqual(retained['old_pod_uid'], 'rig-pod-old')
        self.assert_baseline_retained()

    def test_already_patched_template_with_old_failed_pod_does_not_patch_twice(self):
        capabilities(self.cluster.current)['add'].append('DAC_OVERRIDE')
        self.run_repair()
        self.assertFalse(any(event[0] == 'patch' for event in self.cluster.events))
        self.assertEqual(sum(event[0] == 'delete' for event in self.cluster.events), 1)
        self.assertTrue(repair.verify_workload(self.plan, self.original, self.cluster.current))
        self.assert_baseline_retained()

    def test_patch_unknown_result_can_be_reentered_without_losing_intent(self):
        for when in ('before', 'after'):
            with self.subTest(when=when):
                self.setUp()
                self.cluster.fail_patch = when
                if when == 'before':
                    with self.assertRaises(repair.Error):
                        self.run_repair()
                else:
                    self.run_repair()
                self.assertTrue(self.cluster.persisted)
                if when == 'before':
                    self.assertFalse(any(event[0] == 'delete' for event in self.cluster.events))
                self.run_repair()
                applied = capabilities(self.cluster.current)['add']
                self.assertEqual(applied, ['CHOWN', 'DAC_OVERRIDE'])
                self.assertEqual(sum(event[0] == 'patch' for event in self.cluster.events), 2 if when == 'before' else 1)
                self.assert_baseline_retained()

    def test_delete_unknown_result_can_be_reentered_without_deleting_replacement(self):
        for when in ('before', 'after'):
            with self.subTest(when=when):
                self.setUp()
                self.cluster.fail_delete = when
                if when == 'before':
                    with self.assertRaises(repair.Error):
                        self.run_repair()
                else:
                    self.run_repair()
                if when == 'after':
                    replacement = failed_pod(self.cluster.current)
                    replacement['metadata']['uid'] = 'replacement-pod'
                    self.cluster.pods = [replacement]
                self.run_repair()
                self.assertEqual(sum(event[0] == 'delete' for event in self.cluster.events), 2 if when == 'before' else 1)
                if when == 'after':
                    self.assertEqual(self.cluster.pods[0]['metadata']['uid'], 'replacement-pod')
                self.assert_baseline_retained()

    def test_already_repaired_baseline_is_preserved_while_old_pod_is_replaced(self):
        capabilities(self.original)['add'].append('DAC_OVERRIDE')
        self.plan['objects']['statefulsets'] = [copy.deepcopy(self.original)]
        self.baseline = copy.deepcopy(self.plan['objects'])
        self.cluster.current = copy.deepcopy(self.original)
        self.run_repair()
        self.assertFalse(any(event[0] == 'patch' for event in self.cluster.events))
        self.assertEqual(sum(event[0] == 'delete' for event in self.cluster.events), 1)
        self.assert_baseline_retained()

    def test_template_storage_credentials_and_identity_drift_refuse_before_mutation(self):
        for drift in ('init-command', 'init-image', 'capability', 'database-image', 'pgdata',
                      'secret', 'volume', 'uid', 'replicas', 'update-strategy', 'pod-security'):
            with self.subTest(drift=drift):
                self.setUp()
                current = self.cluster.current
                spec = current['spec']['template']['spec']
                if drift == 'init-command': spec['initContainers'][0]['command'] = ['sh', '-c', 'echo changed']
                elif drift == 'init-image': spec['initContainers'][0]['image'] = 'postgres:18-alpine'
                elif drift == 'capability': capabilities(current)['add'].append('SYS_ADMIN')
                elif drift == 'database-image': spec['containers'][0]['image'] = 'postgres:18-alpine'
                elif drift == 'pgdata': spec['containers'][0]['env'][0]['value'] = '/other-data'
                elif drift == 'secret': spec['containers'][0]['env'][1]['valueFrom']['secretKeyRef']['name'] = 'other-secret'
                elif drift == 'volume': spec['volumes'][0]['persistentVolumeClaim']['claimName'] = 'other-data'
                elif drift == 'uid': current['metadata']['uid'] = 'replacement-sts'
                elif drift == 'replicas': current['spec']['replicas'] = 2
                elif drift == 'update-strategy': current['spec']['updateStrategy']['type'] = 'RollingUpdate'
                elif drift == 'pod-security': spec['securityContext']['runAsUser'] = 0
                with self.assertRaises(repair.Error):
                    self.run_repair()
                self.assertFalse(any(event[0] in ('patch', 'delete') for event in self.cluster.events))
                self.assert_baseline_retained()

    def test_record_never_authorizes_other_workload_changes(self):
        self.run_repair()
        for drift in ('env', 'volume', 'capabilities', 'uid', 'replicas'):
            with self.subTest(drift=drift):
                changed = copy.deepcopy(self.cluster.current)
                spec = changed['spec']['template']['spec']
                if drift == 'env': spec['containers'][0]['env'][0]['value'] = '/other'
                elif drift == 'volume': spec['volumes'][0]['persistentVolumeClaim']['claimName'] = 'other'
                elif drift == 'capabilities': capabilities(changed)['add'].append('SYS_ADMIN')
                elif drift == 'uid': changed['metadata']['uid'] = 'other'
                elif drift == 'replicas': changed['spec']['replicas'] = 2
                with self.assertRaises(repair.Error):
                    repair.verify_workload(self.plan, self.original, changed)
        self.assert_baseline_retained()

    def test_running_or_previously_started_postgres_is_never_deleted(self):
        for proof in ('running', 'restart', 'container-id', 'last-state', 'started', 'ready'):
            with self.subTest(proof=proof):
                self.setUp()
                pod = self.cluster.pods[0]
                postgres = pod['status']['containerStatuses'][0]
                if proof == 'running':
                    pod['status']['phase'] = 'Running'
                    postgres['state'] = {'running': {'startedAt': '2026-10-20T00:00:00Z'}}
                elif proof == 'restart': postgres['restartCount'] = 1
                elif proof == 'container-id': postgres['containerID'] = 'containerd://db-was-started'
                elif proof == 'last-state': postgres['lastState'] = {'terminated': {'exitCode': 0}}
                elif proof == 'started': postgres['started'] = True
                elif proof == 'ready': postgres['ready'] = True
                with self.assertRaises(repair.Error):
                    self.run_repair()
                self.assertFalse(any(event[0] == 'delete' for event in self.cluster.events))
                self.assert_baseline_retained()

    def test_wrong_pod_owner_node_or_configuration_is_never_deleted(self):
        for drift in ('owner-uid', 'owner-kind', 'owner-name', 'controller', 'namespace',
                      'node', 'volume', 'env', 'init-command', 'deleting', 'ambiguous'):
            with self.subTest(drift=drift):
                self.setUp()
                pod = self.cluster.pods[0]
                owner = pod['metadata']['ownerReferences'][0]
                if drift == 'owner-uid': owner['uid'] = 'other-sts'
                elif drift == 'owner-kind': owner['kind'] = 'Deployment'
                elif drift == 'owner-name': owner['name'] = 'other-postgres'
                elif drift == 'controller': owner['controller'] = False
                elif drift == 'namespace': pod['metadata']['namespace'] = 'mx-pay'
                elif drift == 'node': pod['spec']['nodeName'] = 'other-node'
                elif drift == 'volume': pod['spec']['volumes'][0]['persistentVolumeClaim']['claimName'] = 'other'
                elif drift == 'env': pod['spec']['containers'][0]['env'][1]['valueFrom']['secretKeyRef']['name'] = 'other'
                elif drift == 'init-command': pod['spec']['initContainers'][0]['command'].append('unexpected')
                elif drift == 'deleting': pod['metadata']['deletionTimestamp'] = '2026-10-20T00:00:00Z'
                elif drift == 'ambiguous': self.cluster.pods.append(copy.deepcopy(pod))
                with self.assertRaises(repair.Error):
                    self.run_repair()
                self.assertFalse(any(event[0] == 'delete' for event in self.cluster.events))
                self.assert_baseline_retained()

    def test_repaired_running_pod_requires_no_patch_or_delete(self):
        capabilities(self.cluster.current)['add'].append('DAC_OVERRIDE')
        pod = failed_pod(self.cluster.current)
        pod['status']['phase'] = 'Running'
        pod['status']['containerStatuses'][0].update(ready=True, started=True,
            containerID='containerd://current-db', state={'running': {}})
        self.cluster.pods = [pod]
        self.run_repair()
        self.assertFalse(any(event[0] in ('patch', 'delete') for event in self.cluster.events))
        self.assertTrue(repair.verify_workload(self.plan, self.original, self.cluster.current))
        self.assert_baseline_retained()

    def test_failed_intent_persistence_prevents_any_api_mutation(self):
        def cannot_persist(plan):
            raise OSError('journal write failed')
        with self.assertRaises(OSError):
            repair.repair(self.cluster, self.plan, cannot_persist)
        self.assertFalse(any(event[0] in ('patch', 'delete') for event in self.cluster.events))
        self.assertEqual(self.cluster.current, self.original)
        self.assert_baseline_retained()

    def test_resource_version_race_preserves_legacy_template_and_pod(self):
        self.cluster.patch_race = True
        with self.assertRaises(repair.Error):
            self.run_repair()
        self.assertEqual(capabilities(self.cluster.current)['add'], ['CHOWN'])
        self.assertEqual(self.cluster.pods[0]['metadata']['uid'], 'rig-pod-old')
        self.assertFalse(any(event[0] == 'delete' for event in self.cluster.events))
        self.assertEqual(self.plan['state']['rig_init_repair']['phase'], 'intent')
        self.assertTrue(repair.verify_workload(self.plan, self.original, self.cluster.current))
        self.run_repair()
        self.assertEqual(capabilities(self.cluster.current)['add'], ['CHOWN', 'DAC_OVERRIDE'])
        self.assert_baseline_retained()

    def test_malformed_or_other_statefulset_record_cannot_relax_baseline(self):
        self.run_repair()
        for field, value in (('statefulset_uid', 'other-sts'), ('init_index', 1), ('phase', 'anything'),
                             ('old_pod_uid', None), ('schema_version', True), ('extra', 'untrusted')):
            with self.subTest(field=field):
                plan = copy.deepcopy(self.plan)
                plan['state']['rig_init_repair'][field] = value
                with self.assertRaises(repair.Error):
                    repair.verify_workload(plan, self.original, self.cluster.current)
        self.assert_baseline_retained()


class RigRollingUpdateRepairTests(unittest.TestCase):
    run_repair = RigInitRepairTests.run_repair
    assert_baseline_retained = RigInitRepairTests.assert_baseline_retained

    def setUp(self):
        RigInitRepairTests.setUp(self)
        self.original['spec']['updateStrategy'] = {'type': 'RollingUpdate', 'rollingUpdate': {'partition': 0}}
        self.plan['objects']['statefulsets'] = [copy.deepcopy(self.original)]
        self.baseline = copy.deepcopy(self.plan['objects'])
        self.cluster = FakeCluster(self.original)

    def test_drain_is_confirmed_before_replica_zero_cas_capability_patch(self):
        self.run_repair()
        actions = [event[0] for event in self.cluster.events if event[0] != 'persist']
        self.assertLess(actions.index('scale'), actions.index('wait-stopped'))
        self.assertLess(actions.index('wait-stopped'), actions.index('patch'))
        self.assertNotIn('delete', actions)
        self.assertEqual(self.cluster.current['spec']['replicas'], 0)
        self.assertEqual(self.cluster.pods, [])
        patch = next(event[2] for event in self.cluster.events if event[0] == 'patch')
        tests = {op['path']: op['value'] for op in patch if op['op'] == 'test'}
        self.assertEqual(tests['/spec/replicas'], 0)
        self.assertEqual(tests['/metadata/uid'], self.original['metadata']['uid'])
        self.assertEqual(tests['/metadata/resourceVersion'], '21')
        changes = [op for op in patch if op['op'] != 'test']
        self.assertEqual(changes, [{'op': 'replace',
            'path': '/spec/template/spec/initContainers/0/securityContext/capabilities/add',
            'value': ['CHOWN', 'DAC_OVERRIDE']}])
        expected = copy.deepcopy(self.original['spec'])
        expected['replicas'] = 0
        expected['template']['spec']['initContainers'][0]['securityContext']['capabilities']['add'].append('DAC_OVERRIDE')
        self.assertEqual(self.cluster.current['spec'], expected)
        scale_position = next(i for i, event in enumerate(self.cluster.events) if event[0] == 'scale')
        before = [event[1] for event in self.cluster.events[:scale_position] if event[0] == 'persist'][-1]
        self.assertEqual(before['state']['rig_init_repair']['phase'], 'intent')
        self.assertEqual(before['state']['rig_init_repair']['old_pod_uid'], 'rig-pod-old')
        self.assertEqual(self.plan['state']['rig_init_repair']['phase'], 'applied')
        self.assertTrue(repair.verify_workload(self.plan, self.original, self.cluster.current))
        self.assert_baseline_retained()

    def test_retained_pod_or_stale_controller_status_prevents_template_patch(self):
        for blocker in ('pod', 'status'):
            with self.subTest(blocker=blocker):
                self.setUp()
                self.cluster.keep_pods = blocker == 'pod'
                self.cluster.stale_scale_status = blocker == 'status'
                with self.assertRaises(repair.Error):
                    self.run_repair()
                self.assertEqual(capabilities(self.cluster.current)['add'], ['CHOWN'])
                self.assertFalse(any(event[0] in ('patch', 'delete') for event in self.cluster.events))
                self.assertEqual(self.plan['state']['rig_init_repair']['phase'], 'intent')
                self.assert_baseline_retained()

    def test_unknown_scale_outcome_reenters_from_retained_intent(self):
        for when in ('before', 'after'):
            with self.subTest(when=when):
                self.setUp()
                self.cluster.fail_scale = when
                if when == 'before':
                    with self.assertRaises(repair.Error):
                        self.run_repair()
                    self.assertFalse(any(event[0] in ('patch', 'delete') for event in self.cluster.events))
                else:
                    self.run_repair()
                self.plan = copy.deepcopy(self.cluster.persisted[-1])
                self.assertEqual(self.plan['state']['rig_init_repair']['phase'], 'intent' if when == 'before' else 'applied')
                self.run_repair()
                self.assertEqual(self.cluster.current['spec']['replicas'], 0)
                self.assertEqual(capabilities(self.cluster.current)['add'], ['CHOWN', 'DAC_OVERRIDE'])
                self.assertEqual(sum(event[0] == 'scale-api' for event in self.cluster.events), 1)
                self.assertFalse(any(event[0] == 'delete' for event in self.cluster.events))
                self.assert_baseline_retained()

    def test_unknown_patch_outcome_reenters_while_database_remains_stopped(self):
        for when in ('before', 'after'):
            with self.subTest(when=when):
                self.setUp()
                self.cluster.fail_patch = when
                if when == 'before':
                    with self.assertRaises(repair.Error):
                        self.run_repair()
                else:
                    self.run_repair()
                self.assertEqual(self.cluster.current['spec']['replicas'], 0)
                self.assertEqual(self.cluster.pods, [])
                self.plan = copy.deepcopy(self.cluster.persisted[-1])
                self.run_repair()
                self.assertEqual(sum(event[0] == 'patch' for event in self.cluster.events), 2 if when == 'before' else 1)
                self.assertEqual(sum(event[0] == 'scale-api' for event in self.cluster.events), 1)
                self.assertEqual(self.plan['state']['rig_init_repair']['phase'], 'applied')
                self.assert_baseline_retained()

    def test_applied_reentry_never_stops_recovered_postgres(self):
        self.run_repair()
        self.cluster.current['spec']['replicas'] = 1
        self.cluster.current['status'] = {'observedGeneration': self.cluster.current['metadata']['generation'],
                                          'replicas': 1, 'readyReplicas': 1}
        pod = failed_pod(self.cluster.current)
        pod['metadata']['uid'] = 'recovered-pod'
        pod['status']['phase'] = 'Running'
        pod['status']['containerStatuses'][0].update(ready=True, started=True,
            containerID='containerd://recovered-db', state={'running': {}}, restartCount=1)
        self.cluster.pods = [pod]
        self.cluster.events.clear()
        self.run_repair()
        self.assertEqual(self.cluster.current['spec']['replicas'], 1)
        self.assertEqual(self.cluster.pods, [pod])
        self.assertFalse(any(event[0] in ('scale', 'scale-api', 'patch', 'delete', 'wait-stopped')
                             for event in self.cluster.events))
        self.assert_baseline_retained()

    def test_started_postgres_without_repair_record_cannot_be_scaled_down(self):
        self.cluster.pods[0]['status']['containerStatuses'][0]['containerID'] = 'containerd://old-db'
        with self.assertRaises(repair.Error):
            self.run_repair()
        self.assertFalse(any(event[0] in ('scale', 'scale-api', 'patch', 'delete') for event in self.cluster.events))
        self.assertEqual(self.cluster.current['spec']['replicas'], 1)
        self.assert_baseline_retained()

    def test_mutated_replica_checkpoint_is_not_authority_to_drain(self):
        self.plan['replicas'][0]['uid'] = 'other-sts'
        with self.assertRaises(repair.Error):
            self.run_repair()
        self.assertFalse(any(event[0] in ('scale', 'scale-api', 'patch', 'delete') for event in self.cluster.events))
        self.assertEqual(self.cluster.current['spec']['replicas'], 1)
        self.assert_baseline_retained()

    def test_generated_claims_and_other_rolling_partitions_refuse_before_drain(self):
        cases = [('volumeClaimTemplates', [{'metadata': {'name': 'data'}}]),
                 ('updateStrategy', {'type': 'RollingUpdate', 'rollingUpdate': {'partition': 1}})]
        for field, value in cases:
            with self.subTest(field=field):
                self.setUp()
                self.original['spec'][field] = value
                self.plan['objects']['statefulsets'] = [copy.deepcopy(self.original)]
                self.baseline = copy.deepcopy(self.plan['objects'])
                self.cluster = FakeCluster(self.original)
                with self.assertRaises(repair.Error):
                    self.run_repair()
                self.assertFalse(self.cluster.events)
                self.assertEqual(self.cluster.current['spec']['replicas'], 1)
                self.assert_baseline_retained()

    def test_restart_after_applied_record_write_failure_reconciles_stopped_template(self):
        def fail_applied_write(plan):
            if plan['state']['rig_init_repair']['phase'] == 'applied':
                raise OSError('applied record not durable')
            self.cluster.persist(plan)
        with self.assertRaises(OSError):
            repair.repair(self.cluster, self.plan, fail_applied_write)
        self.assertEqual(self.cluster.current['spec']['replicas'], 0)
        self.assertEqual(capabilities(self.cluster.current)['add'], ['CHOWN', 'DAC_OVERRIDE'])
        self.plan = copy.deepcopy(self.cluster.persisted[-1])
        self.assertEqual(self.plan['state']['rig_init_repair']['phase'], 'intent')
        self.run_repair()
        self.assertEqual(self.plan['state']['rig_init_repair']['phase'], 'applied')
        self.assertEqual(self.cluster.current['spec']['replicas'], 0)
        self.assertEqual(sum(event[0] == 'patch' for event in self.cluster.events), 1)
        self.assertEqual(sum(event[0] == 'scale-api' for event in self.cluster.events), 1)
        self.assert_baseline_retained()


if __name__ == '__main__':
    unittest.main()
