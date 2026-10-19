import copy
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).parents[1]))
import cluster_ops as ops


def obj(name, namespace='', **fields):
    return {'metadata': {'name': name, 'namespace': namespace, 'uid': namespace + '/' + name,
                         'resourceVersion': '1', 'generation': 1}, **fields}


def fixture():
    objects = {k: [] for k in ops.KINDS}
    objects['nodes'] = [obj('node', status={'conditions': [{'type': 'Ready', 'status': 'True'}]})]
    objects['namespaces'] = [obj('kube-system')]
    for name, (namespace, claim, path, kind) in ops.PV_PATHS.items():
        pvc = obj(claim, namespace, spec={'volumeName': name}, status={'phase': 'Bound'})
        spec = {kind: {'path': path}, 'persistentVolumeReclaimPolicy': 'Retain',
                'claimRef': {'namespace': namespace, 'name': claim, 'uid': pvc['metadata']['uid']}}
        if kind == 'hostPath': spec[kind]['type'] = 'Directory'
        objects['pv'].append(obj(name, spec=spec, status={'phase': 'Bound'}))
        objects['pvc'].append(pvc)
    objects['daemonsets'] = [obj(name, ns, spec={}, status={'observedGeneration': 1, 'desiredNumberScheduled': 1,
        'currentNumberScheduled': 1, 'numberReady': 1, 'numberAvailable': 1, 'numberUnavailable': 0}) for ns, name in ops.DAEMONSETS]
    objects['deployments'] = [obj('app', 'app', spec={'replicas': 2, 'template': {'spec': {'containers': []}}})]
    objects['deployments'].append(obj('coredns', 'kube-system', spec={'replicas': 2},
        status={'observedGeneration': 1, 'readyReplicas': 2, 'availableReplicas': 2}))
    pay = obj('mx-pay-postgres', 'mx-pay', spec={'replicas': 1, 'template': {'spec': {'containers': [
        {'name': 'postgres', 'env': [{'name': 'MX_PAY_EXPECTED_MOUNT_ROOT', 'value': '/old'}]}]}}})
    objects['statefulsets'] = [pay]
    objects['secrets'] = [obj('secret', 'app', data={'password': 'PRIVATE'}, type='Opaque')]
    identity = {'mountTarget': '/data', 'filesystemUUID': 'old', 'volumeMountRoot': '/old', 'installationID': 'retained'}
    objects['configmaps'] = [obj('mx-pay-database', 'mx-pay', data={'identity': json.dumps(identity)})]
    return objects


class FakeHost:
    def __init__(self):
        self.objects = fixture()
        self.calls = []
        self.snapshots = []
        self.es_fail = False
        self.patch_race = False

    def run(self, args, timeout=60, input_data=None):
        self.calls.append((args, input_data))
        args = args[4:]
        if 'exec' in args:
            path = args[-1].replace('http://127.0.0.1:9200', '')
            method = args[args.index('-X') + 1]
            if path == '/_snapshot/mx-common-snapshots':
                value = {'mx-common-snapshots': {'type': 'fs', 'settings': {'location': '/usr/share/elasticsearch/snapshots'}}}
            elif method == 'PUT':
                name = path.split('/')[-1].split('?')[0]
                self.snapshots = [{'snapshot': name, 'uuid': 'snapshot-id', 'state': 'SUCCESS',
                                   'shards': {'failed': 0, 'successful': 1, 'total': 1}}]
                value = {'accepted': True}
            else:
                value = {'snapshots': copy.deepcopy(self.snapshots)}
                if self.es_fail and value['snapshots']: value['snapshots'][0]['state'] = 'PARTIAL'
            return json.dumps(value).encode()
        kind = args[1]
        ns = args[args.index('-n') + 1] if '-n' in args else None
        if args[0] == 'get':
            items = [o for o in self.objects[kind] if ns is None or o['metadata']['namespace'] == ns]
            position = 4 if ns else 2
            name = args[position] if len(args) > position and not args[position].startswith('-') else None
            if name:
                value = next(o for o in items if o['metadata']['name'] == name)
            else:
                value = {'items': items}
            return json.dumps(value).encode()
        if args[0] == 'patch':
            name = args[4]
            current = next(o for o in self.objects[kind] if o['metadata']['namespace'] == ns and o['metadata']['name'] == name)
            patch = json.loads(input_data)
            if self.patch_race:
                raise ops.ClusterError('API CAS failed; raw output hidden')
            assert patch[0]['value'] == current['metadata']['uid']
            assert patch[1]['value'] == current['metadata']['resourceVersion']
            assert patch[2]['value'] == current['spec']['replicas']
            count = patch[3]['value']
            current['spec']['replicas'] = count
            current['status'] = {'replicas': count, 'readyReplicas': count, 'observedGeneration': 1}
            current['metadata']['resourceVersion'] = str(int(current['metadata']['resourceVersion']) + 1)
            return b'{}'
        raise AssertionError(args)


class ClusterTests(unittest.TestCase):
    def setUp(self):
        self.host = FakeHost()
        self.cluster = ops.Cluster(self.host)
        self.persisted = []
        self.persist = lambda p: self.persisted.append(copy.deepcopy(p))

    def test_snapshot_is_private_complete_and_does_not_mutate(self):
        plan = self.cluster.snapshot()
        self.assertEqual(plan['objects']['secrets'][0]['data']['password'], 'PRIVATE')
        self.assertEqual(len(plan['objects']['pv']), 11)
        self.assertTrue(all(a[0][4] == 'get' for a in self.host.calls))

    def test_changed_path_and_pvc_uid_refuse(self):
        for mutation in ('path', 'uid'):
            with self.subTest(mutation=mutation):
                h = FakeHost()
                if mutation == 'path': h.objects['pv'][0]['spec']['hostPath']['path'] = '/empty'
                else: h.objects['pvc'][0]['metadata']['uid'] = 'replacement'
                with self.assertRaises(ops.ClusterError): ops.Cluster(h).snapshot()

    def test_extra_volume_autoscaler_job_cronjob_and_bare_pod_refuse(self):
        examples = [('pv', obj('unknown', spec={})), ('hpa', obj('hpa')),
                    ('jobs', obj('job', 'app', status={'active': 1})), ('cronjobs', obj('job', 'app', spec={})),
                    ('pods', obj('bare', 'app', spec={'nodeName': 'node'}))]
        for kind, value in examples:
            with self.subTest(kind=kind):
                h = FakeHost(); h.objects[kind].append(value)
                with self.assertRaises(ops.ClusterError): ops.Cluster(h).snapshot()

    def test_unreviewed_host_path_and_csi_template_refuse(self):
        for volume in ({'name': 'outside', 'hostPath': {'path': '/data/other'}},
                       {'name': 'csi', 'csi': {'driver': 'unreviewed'}}):
            with self.subTest(volume=volume):
                h = FakeHost()
                h.objects['deployments'][0]['spec']['template']['spec']['volumes'] = [volume]
                with self.assertRaises(ops.ClusterError): ops.Cluster(h).snapshot()

    def test_unknown_static_pod_refuses(self):
        p = obj('arbitrary', 'kube-system', spec={'nodeName': 'node'})
        p['metadata']['annotations'] = {'kubernetes.io/config.mirror': 'hash'}
        self.host.objects['pods'] = [p]
        with self.assertRaises(ops.ClusterError): self.cluster.snapshot()

    def test_scale_has_durable_intent_uid_and_resource_version_cas(self):
        plan = self.cluster.snapshot()
        self.cluster.quiesce(plan, self.persist)
        self.assertTrue(plan['state']['quiesced'])
        self.assertEqual(plan['state']['es_snapshot']['phase'], 'verified')
        events = [(a[0][4], a[0][5] if len(a[0]) > 5 else '') for a in self.host.calls]
        self.assertEqual([v for v in events if v[0] == 'patch'], [('patch', 'deployments'), ('patch', 'statefulsets')])
        first = self.persisted[0]['state']['workloads']['deployments/app/app']
        self.assertEqual(first, {'phase': 'scale-intent', 'target': 0})
        for args, raw in self.host.calls:
            if args[4] == 'patch':
                patch = json.loads(raw)
                self.assertEqual([p['path'] for p in patch[:3]], ['/metadata/uid', '/metadata/resourceVersion', '/spec/replicas'])
                self.assertIn('--patch-file=/dev/stdin', args)

    def test_snapshot_failure_leaves_databases_running(self):
        plan = self.cluster.snapshot(); self.host.es_fail = True
        with self.assertRaises(ops.ClusterError): self.cluster.quiesce(plan, self.persist)
        self.assertEqual(self.host.objects['statefulsets'][0]['spec']['replicas'], 1)

    def test_quiesce_retry_reuses_verified_snapshot_after_database_stop(self):
        plan = self.cluster.snapshot(); self.cluster.quiesce(plan, self.persist)
        before = len([a for a, _ in self.host.calls if 'exec' in a])
        self.cluster.quiesce(plan, self.persist)
        self.assertEqual(before, len([a for a, _ in self.host.calls if 'exec' in a]))

    def test_resume_db_before_apps_and_allows_only_exact_pay_guard_change(self):
        plan = self.cluster.snapshot(); self.cluster.quiesce(plan, self.persist)
        self.host.objects['statefulsets'][0]['spec']['template']['spec']['containers'][0]['env'][0]['value'] = '/new'
        self.host.calls.clear()
        self.cluster.resume(plan, self.persist, pay_mount_root='/new')
        self.assertEqual([a[5] for a, _ in self.host.calls if a[4] == 'patch'], ['statefulsets', 'deployments'])
        self.assertTrue(plan['state']['resumed'])

    def test_resume_refuses_third_party_replica_template_uid_changes(self):
        for change in ('replicas', 'template', 'uid'):
            with self.subTest(change=change):
                self.setUp(); plan = self.cluster.snapshot(); self.cluster.quiesce(plan, self.persist)
                target = self.host.objects['statefulsets'][0]
                if change == 'replicas': target['spec']['replicas'] = 9
                elif change == 'uid': target['metadata']['uid'] = 'other'
                else: target['spec']['template']['spec']['containers'][0]['image'] = 'different'
                with self.assertRaises(ops.ClusterError): self.cluster.resume(plan, self.persist)

    def test_incomplete_rig_repair_cannot_restart_original_init_template(self):
        plan = self.cluster.snapshot()
        self.cluster.quiesce(plan, self.persist)
        self.host.calls.clear()
        for record in ({'phase': 'intent'}, {}, 'invalid'):
            with self.subTest(record=record):
                plan['state']['rig_init_repair'] = record
                with self.assertRaisesRegex(ops.ClusterError, 'resume --repair-rig-init'):
                    self.cluster.resume(plan, self.persist)
                self.assertFalse(self.host.calls)

    def test_api_cas_failure_retains_scale_intent(self):
        plan = self.cluster.snapshot(); self.host.patch_race = True
        with self.assertRaises(ops.ClusterError): self.cluster.quiesce(plan, self.persist)
        self.assertEqual(plan['state']['workloads']['deployments/app/app']['phase'], 'scale-intent')

    def test_baseline_preserves_credentials_and_pay_non_storage_fields(self):
        plan = self.cluster.snapshot()
        self.cluster.validate_cluster_baseline(plan)
        target = self.host.objects['configmaps'][0]
        new = {'mountTarget': '/data/mx-pay/mx-pay/postgres', 'filesystemUUID': 'root', 'volumeMountRoot': '/new'}
        value = json.loads(target['data']['identity']); value.update(new); target['data']['identity'] = json.dumps(value)
        self.cluster.validate_cluster_baseline(plan, new)
        with self.assertRaises(ops.ClusterError): self.cluster.validate_cluster_baseline(plan)
        value['installationID'] = 'wrong'; target['data']['identity'] = json.dumps(value)
        with self.assertRaises(ops.ClusterError): self.cluster.validate_cluster_baseline(plan, new)
        self.host.objects['configmaps'] = copy.deepcopy(plan['objects']['configmaps'])
        self.host.objects['secrets'][0]['data']['password'] = 'OTHER PRIVATE'
        with self.assertRaisesRegex(ops.ClusterError, '^retained credentials or configuration changed during migration$'):
            self.cluster.validate_cluster_baseline(plan)

    def test_extra_configmap_or_recreated_secret_refuse(self):
        plan = self.cluster.snapshot()
        self.host.objects['secrets'][0]['metadata']['uid'] = 'different'
        with self.assertRaises(ops.ClusterError): self.cluster.validate_cluster_baseline(plan)
        self.host.objects = copy.deepcopy(plan['objects']); self.host.objects['configmaps'].append(obj('new', 'app', data={}))
        with self.assertRaises(ops.ClusterError): self.cluster.validate_cluster_baseline(plan)

    def test_new_workload_or_controller_template_blocks_quiesce(self):
        plan = self.cluster.snapshot()
        self.host.objects['deployments'].append(obj('new', 'app', spec={'replicas': 1}))
        with self.assertRaisesRegex(ops.ClusterError, 'workload set changed'):
            self.cluster.quiesce(plan, self.persist)
        self.assertEqual(self.persisted, [])
        self.host.objects = copy.deepcopy(plan['objects'])
        self.host.objects['daemonsets'][0]['spec']['template'] = {'different': True}
        with self.assertRaisesRegex(ops.ClusterError, 'controller configuration changed'):
            self.cluster.quiesce(plan, self.persist)

    def test_wait_stopped_refuses_retained_pod(self):
        plan = self.cluster.snapshot(); item = plan['replicas'][1]
        self.cluster._scale(plan, item, 0, self.persist)
        p = obj('db-0', 'mx-pay', spec={}); p['metadata']['ownerReferences'] = [{'uid': item['uid'], 'controller': True}]
        self.host.objects['pods'] = [p]
        with self.assertRaisesRegex(ops.ClusterError, 'graceful shutdown timed out'):
            self.cluster.wait_stopped(plan, [item], timeout=0)

    def test_es_partial_and_failed_shards_are_not_accepted(self):
        plan = self.cluster.snapshot()
        name = 'mx-move-' + 'a' * 32
        plan['state']['es_snapshot'] = {'name': name, 'phase': 'started'}
        self.host.snapshots = [{'snapshot': name, 'uuid': 'id', 'state': 'SUCCESS', 'shards': {'failed': 1, 'successful': 0, 'total': 1}}]
        with self.assertRaisesRegex(ops.ClusterError, 'missing or failed shards'):
            self.cluster.es_snapshot(plan, self.persist)

    def test_network_ready_is_read_only_and_includes_original_gateway_and_dns(self):
        plan = self.cluster.snapshot(); self.host.calls.clear()
        self.cluster.wait_network_ready(plan, timeout=0)
        self.assertEqual([a[5] for a, _ in self.host.calls], ['daemonsets', 'deployments'])
        self.assertTrue(all(a[4] == 'get' and raw is None for a, raw in self.host.calls))
        self.assertEqual(self.persisted, [])
        self.assertFalse(any(i['namespace'] in ops.SYSTEM_NAMESPACES for i in plan['replicas']))

    def test_network_ready_waits_for_gateway_flannel_proxy_and_coredns_status(self):
        plan = self.cluster.snapshot()
        for position in range(3):
            for field, value in (('observedGeneration', 0), ('desiredNumberScheduled', 0), ('currentNumberScheduled', 0),
                                 ('numberReady', 0), ('numberAvailable', 0), ('numberUnavailable', 1)):
                self.host.objects = copy.deepcopy(plan['objects'])
                self.host.objects['daemonsets'][position]['status'][field] = value
                with self.subTest(position=position, field=field):
                    with self.assertRaisesRegex(ops.ClusterError, 'gateway, CNI, proxy or system DNS is not Ready'):
                        self.cluster.wait_network_ready(plan, timeout=0)
        for field in ('observedGeneration', 'readyReplicas', 'availableReplicas'):
            self.host.objects = copy.deepcopy(plan['objects'])
            self.host.objects['deployments'][1]['status'][field] = 0
            with self.subTest(field=field):
                with self.assertRaisesRegex(ops.ClusterError, 'system DNS is not Ready'):
                    self.cluster.wait_network_ready(plan, timeout=0)

    def test_network_ready_rejects_uid_spec_and_controller_set_drift(self):
        plan = self.cluster.snapshot()
        for kind, position in (('daemonsets', 0), ('deployments', 1)):
            for change in ('uid', 'spec', 'missing'):
                self.host.objects = copy.deepcopy(plan['objects'])
                if change == 'missing': self.host.objects[kind].pop(position)
                elif change == 'uid': self.host.objects[kind][position]['metadata']['uid'] = 'replacement'
                else: self.host.objects[kind][position]['spec']['unexpected'] = True
                with self.subTest(kind=kind, change=change):
                    with self.assertRaisesRegex(ops.ClusterError, 'network controller'):
                        self.cluster.wait_network_ready(plan, timeout=0)

    def test_network_ready_retries_without_mutating_or_scaling(self):
        plan = self.cluster.snapshot()
        self.host.objects['daemonsets'][0]['status']['numberReady'] = 0
        def become_ready(_):
            self.host.objects['daemonsets'][0]['status']['numberReady'] = 1
        self.host.calls.clear()
        with mock.patch.object(ops.time, 'sleep', side_effect=become_ready) as sleep:
            self.cluster.wait_network_ready(plan, timeout=30)
        sleep.assert_called_once_with(3)
        self.assertTrue(all(a[4] == 'get' for a, _ in self.host.calls))

    def test_network_ready_requires_dns_baseline(self):
        plan = self.cluster.snapshot()
        plan['objects']['deployments'] = [o for o in plan['objects']['deployments'] if o['metadata']['namespace'] != 'kube-system']
        with self.assertRaisesRegex(ops.ClusterError, 'network controller baseline is incomplete'):
            self.cluster.wait_network_ready(plan, timeout=0)


if __name__ == '__main__': unittest.main()
