"""Offline safety regressions for the read-only Kubernetes storage report."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import types
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    'k8s_inventory', str(Path(__file__).parents[1] / 'inventory.py'))
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)

SECRET = 'credential-value-must-not-be-reported'


def args(**overrides):
    values = dict(action='plan', measure=True, du_timeout=30, node=None,
                  kubeconfig='/etc/kubernetes/admin.conf',
                  target_root='/var/lib/mx-move/k8s-data', reserve_gib=100)
    values.update(overrides)
    return types.SimpleNamespace(**values)


def mount(target='/', uuid='root-disk', fsroot='/', source='/dev/root',
          fstype='xfs', writable=True):
    return dict(target=target, uuid=uuid, fsroot=fsroot, source=source,
                fstype=fstype, writable=writable)


def path_evidence(path, size=1024, mounted=None, **overrides):
    value = dict(path=path, origins=['PV/database'], exists=True,
                 directory=True, symlink=False, bytes=size,
                 mount=mounted if mounted is not None else mount(
                     '/data', 'data-disk', '/', '/dev/data'))
    value.update(overrides)
    return value


def raw_cluster():
    return {
        'nodes': [{
            'metadata': {'name': 'internal',
                         'labels': {'kubernetes.io/hostname': 'internal'},
                         'annotations': {'credential': SECRET}},
            'status': {'nodeInfo': {'systemUUID': 'HOST-UUID'},
                       'conditions': [{'type': 'Ready', 'status': 'True',
                                       'message': SECRET}]}}],
        'pv': [
            {'metadata': {'name': 'database'},
             'spec': {'local': {'path': '/data/database'},
                      'claimRef': {'namespace': 'hub', 'name': 'database',
                                   'uid': 'claim-uid'}},
             'status': {'phase': 'Bound'}},
            {'metadata': {'name': 'nas'},
             'spec': {'nfs': {'server': SECRET, 'path': '/private'},
                      'claimRef': {'namespace': 'hub', 'name': 'nas',
                                   'uid': 'nas-uid'}},
             'status': {'phase': 'Bound'}},
            {'metadata': {'name': 'external-csi'},
             'spec': {'csi': {'driver': 'example.csi',
                              'volumeAttributes': {'password': SECRET},
                              'nodePublishSecretRef': {'name': SECRET}}}}],
        'pvc': [
            {'metadata': {'namespace': 'hub', 'name': 'database',
                          'uid': 'claim-uid'},
             'spec': {'volumeName': 'database'}, 'status': {'phase': 'Bound'}},
            {'metadata': {'namespace': 'hub', 'name': 'nas', 'uid': 'nas-uid'},
             'spec': {'volumeName': 'nas'}, 'status': {'phase': 'Bound'}},
            {'metadata': {'namespace': 'hub', 'name': 'pending',
                          'uid': 'pending-uid'},
             'spec': {}, 'status': {'phase': 'Pending'}}],
        'pods': [{
            'metadata': {'namespace': 'hub', 'name': 'api'},
            'spec': {'nodeName': 'internal',
                     'volumes': [
                         {'name': 'database', 'persistentVolumeClaim': {
                             'claimName': 'database'}},
                         {'name': 'nas', 'persistentVolumeClaim': {
                             'claimName': 'nas'}},
                         {'name': 'pending', 'persistentVolumeClaim': {
                             'claimName': 'pending'}},
                         {'name': 'missing', 'persistentVolumeClaim': {
                             'claimName': 'missing'}},
                         {'name': 'runtime', 'hostPath': {
                             'path': '/data/runtime', 'type': 'Directory'}},
                         {'name': 'secret', 'secret': {'secretName': SECRET}},
                         {'name': 'config', 'configMap': {'name': SECRET}}],
                     'containers': [{
                         'name': 'api', 'env': [{'name': 'PASSWORD', 'value': SECRET}],
                         'command': [SECRET], 'args': [SECRET],
                         'envFrom': [{'secretRef': {'name': SECRET}}],
                         'volumeMounts': [{'name': 'database', 'mountPath': '/db'}]}],
                     'initContainers': [{'name': 'init', 'env': [
                         {'name': 'PASSWORD', 'value': SECRET}]}],
                     'ephemeralContainers': [{'name': 'debug', 'args': [SECRET]}]},
            'status': {'phase': 'Running', 'message': SECRET}}],
        'workloads': [{
            'kind': 'Deployment', 'metadata': {'namespace': 'hub', 'name': 'api'},
            'spec': {'replicas': 1, 'template': {'spec': {
                'volumes': [{'name': 'state', 'hostPath': {'path': '/data/template'}}],
                'containers': [{'name': 'api', 'env': [
                    {'name': 'PASSWORD', 'value': SECRET}]}]}}}}],
        'secrets': [{'data': {'password': SECRET}}],
    }


class ClusterTests(unittest.TestCase):
    def test_report_allowlists_storage_without_credentials_or_container_commands(self):
        result = inventory.cluster_summary(raw_cluster())
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result['pods'][0]['containers'][0]['mounts'],
                         [{'name': 'database', 'mountPath': '/db'}])
        self.assertEqual(result['pvs'][1]['kind'], 'nfs')
        self.assertEqual(result['pvs'][2]['driver'], 'example.csi')

    def test_pod_claims_resolve_local_data_and_retain_unbound_unknowns(self):
        cluster = inventory.cluster_summary(raw_cluster())
        paths, unresolved = inventory.discover_paths(cluster, 'internal')
        self.assertIn('Pod/hub/api via PV/database', paths['/data/database'])
        self.assertIn('/data/runtime', paths)
        self.assertIn('/data/template', paths)
        self.assertNotIn('/private', paths)
        self.assertTrue(any('pending' in issue for issue in unresolved))
        self.assertTrue(any('missing' in issue for issue in unresolved))
        self.assertTrue(any('external-csi' in issue for issue in unresolved))

    def test_claim_uid_mismatch_is_unresolved_and_not_associated_with_pod(self):
        raw = raw_cluster()
        raw['pv'][0]['spec']['claimRef']['uid'] = 'replaced-claim'
        paths, unresolved = inventory.discover_paths(
            inventory.cluster_summary(raw), 'internal')
        self.assertNotIn('Pod/hub/api via PV/database', paths['/data/database'])
        self.assertTrue(any('hub/api/database' in issue for issue in unresolved))

    def test_multinode_retained_pv_and_template_need_ownership_review(self):
        raw = raw_cluster()
        raw['nodes'].append({'metadata': {'name': 'other'}})
        raw['pods'] = []
        paths, unresolved = inventory.discover_paths(
            inventory.cluster_summary(raw), 'internal')
        self.assertNotIn('/data/database', paths)
        self.assertNotIn('/data/template', paths)
        self.assertTrue(any('PV node ownership' in issue for issue in unresolved))
        self.assertTrue(any('template hostPath' in issue for issue in unresolved))

    def test_other_node_pod_does_not_select_local_hostpath(self):
        raw = raw_cluster()
        raw['pods'][0]['spec']['nodeName'] = 'other'
        paths, unused = inventory.discover_paths(
            inventory.cluster_summary(raw), 'internal')
        self.assertNotIn('/data/runtime', paths)

    def test_noncanonical_paths_are_not_selected(self):
        raw = raw_cluster()
        raw['pods'][0]['spec']['volumes'] = [
            {'name': 'bad', 'hostPath': {'path': '/data/../etc'}}]
        paths, unresolved = inventory.discover_paths(
            inventory.cluster_summary(raw), 'internal')
        self.assertNotIn('/data/../etc', paths)
        self.assertTrue(any('invalid/non-canonical' in issue for issue in unresolved))

    def test_requested_node_cannot_bypass_host_identity_and_ambiguity(self):
        nodes = [{'name': 'internal', 'hostname': 'internal',
                  'systemUUID': 'HOST-UUID'},
                 {'name': 'other', 'hostname': 'other', 'systemUUID': 'OTHER-UUID'}]
        self.assertEqual(inventory.select_node(nodes, 'renamed', 'host-uuid'), 'internal')
        self.assertIsNone(inventory.select_node(nodes, 'internal', '', 'other'))
        self.assertIsNone(inventory.select_node(nodes, 'internal', 'OTHER-UUID'))

    def test_hostname_match_does_not_override_conflicting_system_uuid(self):
        nodes = [{'name': 'internal', 'hostname': 'internal',
                  'systemUUID': 'REMOTE-UUID'}]
        self.assertIsNone(inventory.select_node(nodes, 'internal', 'LOCAL-UUID'))
        self.assertIsNone(inventory.select_node(nodes, 'internal', 'LOCAL-UUID', 'internal'))


class MountAndCapacityTests(unittest.TestCase):
    def setUp(self):
        self.root = mount()
        self.data = mount('/data', 'data-disk', '/', '/dev/data')
        self.alias = mount('/var/lib/containerd', 'data-disk',
                           '/mx-runtime/containerd', '/dev/data[/mx-runtime/containerd]')
        self.mounts = [self.root, self.data, self.alias]

    def plan(self, paths):
        return inventory.capacity_plan(paths, '/var/lib/mx-move/k8s-data', self.mounts)

    def test_bind_aliases_and_descendants_count_once(self):
        paths = [path_evidence('/data/mx-runtime/containerd', 4096, self.data),
                 path_evidence('/var/lib/containerd', 4096, self.alias),
                 path_evidence('/data/mx-runtime/containerd/content', 2048, self.data)]
        plan = self.plan(paths)
        self.assertEqual(plan['measured_bytes'], 4096)
        self.assertEqual(len(plan['groups']), 1)
        self.assertEqual(set(plan['groups'][0]['aliases']), set(p['path'] for p in paths))
        self.assertTrue(plan['complete'])

    def test_already_moved_etcd_and_remote_data_are_excluded(self):
        paths = [path_evidence('/var/lib/etcd', 8192, self.root),
                 path_evidence('/mnt/nas/db', 8192,
                               mount('/mnt/nas', None, '/', fstype='nfs')),
                 path_evidence('/data/database', 4096, self.data)]
        plan = self.plan(paths)
        self.assertEqual(plan['measured_bytes'], 4096)
        self.assertEqual([g['path'] for g in plan['groups']], ['/data/database'])

    def test_unmeasured_data_is_an_unknown_lower_bound_not_a_complete_zero(self):
        plan = self.plan([path_evidence('/data/database', None, self.data)])
        self.assertFalse(plan['complete'])
        self.assertIsNone(plan['groups'][0]['bytes'])
        self.assertTrue(plan['unknown'])
        self.assertFalse(plan['backup_budget_included'])

    def test_nested_parent_with_unknown_size_does_not_use_partial_child_as_total(self):
        plan = self.plan([path_evidence('/data/runtime', None, self.data),
                          path_evidence('/data/runtime/database', 4096, self.data)])
        self.assertFalse(plan['complete'])
        self.assertIsNone(plan['groups'][0]['bytes'])
        self.assertEqual(len(plan['groups']), 1)

    def test_existing_referenced_path_without_mount_evidence_is_unknown(self):
        evidence = path_evidence('/data/database', 4096, self.data)
        evidence['mount'] = None
        plan = self.plan([evidence])
        self.assertFalse(plan['complete'])
        self.assertTrue(plan['unknown'])

    def test_missing_claim_path_unknown_but_absent_optional_runtime_is_not(self):
        missing = path_evidence('/data/database', None, self.data, exists=False)
        self.assertFalse(self.plan([missing])['complete'])
        missing['origins'] = ['known-runtime-or-service-path']
        self.assertTrue(self.plan([missing])['complete'])

    def test_symlink_and_whole_filesystem_require_manual_review(self):
        for evidence in (path_evidence('/data/database', 4096, self.data, symlink=True),
                         path_evidence('/data', 4096, self.data)):
            with self.subTest(path=evidence['path']):
                plan = self.plan([evidence])
                self.assertFalse(plan['complete'])
                self.assertFalse(plan['groups'])

    def test_fstab_drops_remote_credentials_and_option_values(self):
        result = inventory.parse_fstab(
            '/data/runtime /var/lib/containerd none bind 0 0\n'
            'nas:/private /mnt/nas nfs rw,password=' + SECRET + ',_netdev 0 0\n'
            '# /old /ignored xfs defaults 0 0\n')
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result[0]['source'], '/data/runtime')
        self.assertEqual(result[1]['source'], '<remote>')
        self.assertEqual(result[1]['options'], ['rw', '_netdev'])

    def test_mount_tree_is_flattened_and_remote_source_hidden(self):
        result = inventory.mount_summary([{
            'target': '/', 'source': '/dev/root', 'fstype': 'xfs', 'uuid': 'root',
            'fsroot': '/', 'options': 'rw,password=' + SECRET, 'children': [{
                'target': '/mnt/nas', 'source': SECRET, 'fstype': 'nfs',
                'fsroot': '/', 'options': 'rw'}]}])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(len(result), 2)
        self.assertEqual(inventory.mount_for('/mnt/nas/db', result), result[1])


class ReadPathTests(unittest.TestCase):
    def setUp(self):
        self.inspector = inventory.Inspector(args())
        self.st = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700,
            st_uid=0, st_gid=0, st_dev=1, st_ino=100)
        self.mounts = [mount(), mount('/data', 'data-disk')]
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(mock.patch.object(inventory.os, 'lstat', return_value=self.st))
        self.stack.enter_context(mock.patch.object(inventory.os.path, 'realpath', side_effect=lambda p: p))
        self.stack.enter_context(mock.patch.object(inventory.shutil, 'which', return_value=None))
        self.stack.enter_context(mock.patch.object(inventory, 'stage'))
        self.process = self.stack.enter_context(mock.patch.object(inventory, 'run'))
        self.addCleanup(self.stack.close)

    def read(self, path='/data/database'):
        return self.inspector.read_path(path, ['PV/database'], self.mounts)

    def test_failed_du_preserves_unknown_size_and_hides_error(self):
        self.process.side_effect = inventory.InspectionError(SECRET)
        result = self.read()
        self.assertIsNone(result['bytes'])
        self.assertTrue(result['exists'])
        self.assertNotIn(SECRET, json.dumps(self.inspector.errors))
        self.assertTrue(self.inspector.errors)

    def test_malformed_du_output_becomes_unknown_without_exposing_output(self):
        for output in ('', SECRET, '-1\t/data/database\n'):
            self.process.return_value = output
            with self.subTest(output=output):
                result = self.inspector.attempt('path /data/database', self.read,
                    {'path': '/data/database', 'bytes': None, 'exists': None})
                self.assertIsNone(result['bytes'])
                self.assertNotIn(SECRET, json.dumps(self.inspector.errors))

    def test_same_filesystem_nested_mount_prevents_recursive_measurement(self):
        self.mounts.append(mount('/data/database/nested', 'data-disk', '/elsewhere'))
        result = self.read()
        self.assertEqual(result['nested_mount_count'], 1)
        self.assertIsNone(result['bytes'])
        self.process.assert_not_called()

    def test_measure_uses_filesystem_boundary_and_argument_separator(self):
        self.process.return_value = '4096\t/data/database\n'
        result = self.read()
        self.assertEqual(result['bytes'], 4096)
        self.process.assert_called_once_with(
            ['du', '-sx', '--block-size=1', '--', '/data/database'], 30)

    def test_inventory_without_measure_never_runs_du(self):
        self.inspector.args.measure = False
        self.assertIsNone(self.read()['bytes'])
        self.process.assert_not_called()

    def test_missing_path_does_not_look_like_zero_sized_directory(self):
        with mock.patch.object(inventory.os, 'lstat', side_effect=FileNotFoundError()):
            result = self.read()
        self.assertFalse(result['exists'])
        self.assertIsNone(result['bytes'])
        self.process.assert_not_called()

    def test_remote_mount_and_symlink_are_not_measured(self):
        self.mounts.append(mount('/mnt/nas', None, '/', fstype='nfs'))
        self.assertIsNone(self.read('/mnt/nas/data')['bytes'])
        with mock.patch.object(inventory.os.path, 'realpath', return_value='/elsewhere'):
            self.assertIsNone(self.read()['bytes'])
        self.process.assert_not_called()


class CommandSafetyTests(unittest.TestCase):
    def test_subprocess_failure_does_not_emit_stdout_stderr_or_exception(self):
        failures = [types.SimpleNamespace(returncode=1, stdout=SECRET.encode(),
                                         stderr=SECRET.encode()),
                    OSError(SECRET), subprocess.TimeoutExpired(
                        ['kubectl'], 30, output=SECRET, stderr=SECRET)]
        for failure in failures:
            with self.subTest(kind=type(failure).__name__):
                kwargs = {'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure}
                with mock.patch.object(inventory.subprocess, 'run', **kwargs), \
                        self.assertRaises(inventory.InspectionError) as caught:
                    inventory.run(['kubectl', 'get', 'pods'])
                self.assertNotIn(SECRET, str(caught.exception))

    def test_no_mutation_subcommands_or_execute_flags(self):
        for argv in (['migrate'], ['apply'], ['rollback'], ['cutover'],
                     ['plan', '--execute'], ['inventory', '--apply']):
            with self.subTest(argv=argv), mock.patch.object(inventory.Inspector, 'collect') as collect, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                inventory.main(argv)
            self.assertEqual(caught.exception.code, 2)
            collect.assert_not_called()

    def test_invalid_target_and_limits_rejected_before_inspection(self):
        invalid = [['--target-root', p] for p in
                   ('relative', '/', '//data/x', '/data/../x', '/data/x\n')]
        invalid += [['--reserve-gib', '99'], ['--du-timeout', '0'], ['--du-timeout', '601']]
        for options in invalid:
            with self.subTest(options=options), mock.patch.object(inventory.Inspector, 'collect') as collect, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                inventory.main(['plan'] + options)
            collect.assert_not_called()


class IdentityAndRuntimeTests(unittest.TestCase):
    def test_nested_storage_receipts_do_not_copy_credentials(self):
        result = inventory.storage_identity({
            'root': '/var/lib/mx-common', 'password': SECRET,
            'data': {'password': SECRET},
            'allowed': [{'uuid': 'root-disk', 'inode': 42, 'password': SECRET}],
            'mounts': [{'path': '/var/lib/mx-launcher', 'password': SECRET,
                        'identity': {'root': '/k8s/launcher', 'device': 'data-disk',
                                     'password': SECRET}}]})
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result['allowed'], [{'uuid': 'root-disk', 'inode': 42}])
        self.assertEqual(result['mounts'][0]['identity']['root'], '/k8s/launcher')

    def test_runtime_flags_select_only_storage_fields(self):
        result = inventory.runtime_flags(
            ['containerd', '--root=/data/runtime', '--token', SECRET,
             '--config', '/etc/containerd/config.toml'], ('--root', '--config'))
        self.assertEqual(result, {'--root': '/data/runtime',
                                  '--config': '/etc/containerd/config.toml'})
        self.assertNotIn(SECRET, json.dumps(result))

    def test_malformed_or_duplicate_runtime_flags_fail_closed(self):
        for argv in (['kubelet', '--root-dir'],
                     ['kubelet', '--root-dir', '--secret'],
                     ['kubelet', '--root-dir=/data/one', '--root-dir=/data/two']):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                inventory.runtime_flags(argv, ('--root-dir',))

    def test_containerd_config_only_reports_literal_storage_paths(self):
        inspector = inventory.Inspector(args())
        command = b'containerd\0--config\0/etc/containerd/custom.toml\0--token\0' + SECRET.encode() + b'\0'
        config = 'root = "/data/containerd"\nstate = "/run/containerd"\nimports = ["other.toml"]\n[plugins.auth]\npassword = "' + SECRET + '"\n'
        with mock.patch.object(inventory.Path, 'read_bytes', return_value=command), \
                mock.patch.object(inventory.Path, 'is_file', return_value=True), \
                mock.patch.object(inventory.Path, 'read_text', return_value=config):
            result = inspector.runtime({'containerd': {'MainPID': '123'}})
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result['containerd']['top_level_paths'],
                         {'root': '/data/containerd', 'state': '/run/containerd'})
        self.assertTrue(result['containerd']['has_imports'])

    def test_kubernetes_collection_reads_only_required_resource_types(self):
        inspector = inventory.Inspector(args())
        with mock.patch.object(inspector, 'kube', return_value={'items': []}) as kube, \
                mock.patch.object(inventory, 'stage'):
            inspector.read_cluster()
        resources = []
        for call in kube.call_args_list:
            argv = call[0]
            self.assertEqual(argv[0], 'get')
            self.assertEqual(argv[-2:], ('-o', 'json'))
            resources.append(argv[1])
        self.assertEqual(set(resources), {'nodes', 'pv', 'pvc', 'pods',
            'deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs'})
        self.assertNotIn('secrets', resources)

    def test_pay_configmap_is_name_filtered_and_identity_is_sanitized(self):
        inspector = inventory.Inspector(args())
        payload = {'items': [{'metadata': {'namespace': 'pay'}, 'data': {
            'password': SECRET, 'identity': json.dumps({
                'root': '/data/pay', 'password': SECRET})}}]}
        with mock.patch.object(inspector, 'kube', return_value=payload) as kube:
            result = inspector.pay_identities({'workloads': []})
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result[0]['storage']['root'], '/data/pay')
        kube.assert_called_once_with('get', 'configmaps', '-A',
            '--field-selector=metadata.name=mx-pay-database', '-o', 'json')

    def test_storage_receipts_never_read_launcher_recovery_credentials(self):
        inspector = inventory.Inspector(args())
        read_paths = []

        def read_text(path, *unused_args, **unused_kwargs):
            read_paths.append(str(path))
            return json.dumps({'root': '/data/service', 'password': SECRET,
                               'credentials': {'password': SECRET}})

        with mock.patch.object(inventory.Path, 'exists', return_value=True), \
                mock.patch.object(inventory.Path, 'read_text', read_text):
            result = inspector.identities(['pay'])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(set(read_paths), {
            '/var/lib/mx-move/active-etcd.json',
            '/var/lib/mx-common/storage-identity.json',
            '/var/lib/mx-pay/pay/storage-identity.json',
            '/var/lib/mx-launcher-recovery/host.json'})

    def test_docker_inspection_uses_templates_without_env_or_commands(self):
        inspector = inventory.Inspector(args())
        calls = []

        def run(command, timeout=30):
            calls.append(command)
            if command[1] == 'info':
                return '"/data/docker"'
            if command[1] == 'ps':
                return 'container-id\n'
            self.assertEqual(command[1:3], ['inspect', '--format'])
            self.assertNotIn('.Config', command[3])
            self.assertNotIn('.Env', command[3])
            self.assertNotIn('.Args', command[3])
            return json.dumps({'name': '/worker', 'running': True,
                'networkMode': 'host', 'mounts': [{'Type': 'bind',
                    'Source': '/data/database', 'Destination': '/db',
                    'RW': True, 'credentials': SECRET}]})

        with mock.patch.object(inventory.shutil, 'which', return_value='/usr/bin/docker'), \
                mock.patch.object(inventory, 'run', side_effect=run):
            result = inspector.docker()
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(result['containers'][0]['mounts'][0]['Source'], '/data/database')
        self.assertEqual([command[1] for command in calls], ['info', 'ps', 'inspect'])

    def test_postgres_identity_reads_bounded_control_and_discovers_external_links(self):
        inspector = inventory.Inspector(args())
        database = '/data/database/pgdata'
        link_targets = {database + '/pg_wal': '/data/wal',
                        database + '/pg_tblspc/16384': '/data/tablespace'}
        reads = []

        def open_file(path, mode='r', *unused_args, **unused_kwargs):
            self.assertEqual(mode, 'rb')
            reads.append(str(path))
            if str(path) == database + '/PG_VERSION':
                return io.BytesIO(b'16\n')
            if str(path) == database + '/global/pg_control':
                return io.BytesIO(b'12345678abcd' + SECRET.encode())
            self.fail('unexpected PostgreSQL file read: ' + str(path))

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(inventory.Path, 'is_file',
                side_effect=lambda path: str(path) == database + '/PG_VERSION', autospec=True))
            stack.enter_context(mock.patch.object(inventory.Path, 'open', open_file))
            stack.enter_context(mock.patch.object(inventory.Path, 'is_dir',
                side_effect=lambda path: str(path) == database + '/pg_tblspc', autospec=True))
            stack.enter_context(mock.patch.object(inventory.Path, 'is_symlink',
                side_effect=lambda path: str(path) in link_targets, autospec=True))
            stack.enter_context(mock.patch.object(inventory.Path, 'iterdir',
                return_value=iter([Path(database + '/pg_tblspc/16384')])) )
            stack.enter_context(mock.patch.object(inventory.os.path, 'realpath',
                side_effect=lambda path: link_targets[path]))
            result = inspector.postgres_links(['/data/database', database])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['version'], '16')
        self.assertEqual({link['target'] for link in result[0]['external_links']},
                         {'/data/wal', '/data/tablespace'})
        self.assertEqual(result[0]['control_first8_hex'], b'12345678'.hex())
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(reads, [database + '/PG_VERSION', database + '/global/pg_control'])


class CollectionTests(unittest.TestCase):
    """Exercise report assembly with every host/process access replaced by fixtures."""
    def collect(self, target_mount=None, read_error=False):
        inspector = inventory.Inspector(args(measure=False))
        mounts = [mount(), mount('/data', 'data-disk')]
        if target_mount:
            mounts.append(target_mount)
        cluster = inventory.cluster_summary(raw_cluster())
        cluster['pvs'] = cluster['pvcs'] = cluster['pods'] = cluster['workloads'] = []
        calls = []

        def run(command, timeout=30):
            calls.append(command)
            if command[0] == 'findmnt':
                rows = [dict(m, options='rw' if m['writable'] else 'ro') for m in mounts]
                return json.dumps({'filesystems': rows})
            if command[0] == 'lsblk':
                if read_error:
                    raise inventory.InspectionError(SECRET)
                return '{"blockdevices": []}'
            if command[0] == 'systemctl':
                return 'LoadState=loaded\nActiveState=active\n'
            self.fail('unexpected process access: ' + repr(command))

        def read_text(path, *unused_args, **unused_kwargs):
            if str(path) == '/etc/fstab':
                return '/dev/root / xfs defaults 0 0\n'
            if str(path) == '/sys/class/dmi/id/product_uuid':
                return 'HOST-UUID'
            self.fail('unexpected file read: ' + str(path))

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(inventory, 'run', side_effect=run))
            stack.enter_context(mock.patch.object(inventory, 'stage'))
            stack.enter_context(mock.patch.object(inspector, 'read_cluster', return_value=cluster))
            stack.enter_context(mock.patch.object(inspector, 'kube', return_value={
                'metadata': {'uid': 'cluster-uid'}, 'items': []}))
            stack.enter_context(mock.patch.object(inspector, 'docker', return_value={
                'status': 'inspected', 'root': '/var/lib/docker', 'containers': []}))
            stack.enter_context(mock.patch.object(inspector, 'identities', return_value=[]))
            stack.enter_context(mock.patch.object(inspector, 'postgres_links', return_value=[]))
            stack.enter_context(mock.patch.object(inventory.Path, 'read_text', read_text))
            stack.enter_context(mock.patch.object(inventory.Path, 'exists', return_value=True))
            stack.enter_context(mock.patch.object(inventory.os, 'lstat', side_effect=FileNotFoundError()))
            stack.enter_context(mock.patch.object(inventory.os, 'statvfs', return_value=types.SimpleNamespace(
                f_bavail=900, f_frsize=inventory.GIB, f_blocks=1000)))
            stack.enter_context(mock.patch.object(inventory.os.path, 'realpath', side_effect=lambda p: p))
            stack.enter_context(mock.patch.object(inventory.socket, 'gethostname', return_value='internal'))
            report = inspector.collect()
        return report, calls

    def test_complete_capacity_still_cannot_authorize_execution(self):
        report, calls = self.collect()
        self.assertTrue(report['read_only'])
        self.assertFalse(report['execution_supported'])
        self.assertTrue(report['capacity']['complete'])
        self.assertTrue(report['capacity']['lower_bound_fits'])
        self.assertTrue(report['blockers'])
        self.assertTrue(any('shutdown/backup/acceptance' in b for b in report['blockers']))
        self.assertTrue(all(c[0] in ('findmnt', 'lsblk', 'systemctl') for c in calls))
        self.assertTrue(all(c[1] == 'show' for c in calls if c[0] == 'systemctl'))

    def test_collection_errors_are_sanitized_and_block_planning(self):
        report, unused = self.collect(read_error=True)
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertTrue(report['collection_errors'])
        self.assertTrue(set(report['collection_errors']).issubset(report['blockers']))

    def test_target_on_data_disk_or_readonly_mount_is_blocked(self):
        for target_mount in (mount('/var/lib/mx-move', 'data-disk'),
                             mount('/var/lib/mx-move', 'root-disk', writable=False)):
            with self.subTest(mount=target_mount):
                report, unused = self.collect(target_mount)
                self.assertTrue(any('writable, UUID-identified local root filesystem' in b
                                    for b in report['blockers']))


if __name__ == '__main__':
    unittest.main()
