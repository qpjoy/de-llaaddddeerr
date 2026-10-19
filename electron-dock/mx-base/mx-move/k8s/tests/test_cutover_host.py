"""Host/CLI integration contracts with fake commands and protected-file reads."""
import contextlib
import base64
from contextlib import ExitStack
import copy
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import cutover
finally:
    sys.path.pop(0)

TRANSACTION = 'mx-k8s-20261020-010000-1234abcd'
IDS = ['a' * 64, 'b' * 64]


def host_without_initialization():
    return object.__new__(cutover.Host)


def journal():
    return {'schema_version': 1, 'phase': 'committed', 'may_write': True,
            'transaction': TRANSACTION, 'run': str(cutover.BASE / TRANSACTION),
            'storage': {'entries': []}, 'cluster': {}}


class DockerSnapshotTests(unittest.TestCase):
    def fixture(self, first=None, second=None, mounts=None, complete=True):
        report = {'complete': complete, 'info': {'root': '/data/docker'},
                  'containers': [{'id': identifier, 'running': True} for identifier in IDS]}
        commands, lists = [], iter([first if first is not None else IDS, second if second is not None else IDS])
        values = mounts if mounts is not None else {identifier: [{'Type': 'bind', 'Source': '/data/app-' + identifier[0],
                                                                 'Destination': '/app', 'RW': True}] for identifier in IDS}
        host = host_without_initialization()
        def run(args, timeout=60):
            commands.append(args)
            self.assertEqual(args[:2], ['docker', '--host=unix:///var/run/docker.sock'])
            if args[2] == 'ps':
                self.assertEqual(args[2:], ['ps', '-aq', '--no-trunc'])
                return ('\n'.join(next(lists)) + '\n').encode()
            self.assertEqual(args[2:5], ['inspect', '--format', '{{json .Mounts}}'])
            return json.dumps(values[args[-1]]).encode()
        host.run = run
        return host, report, commands, values

    def test_reads_every_container_mount_list_from_explicit_local_socket(self):
        host, report, commands, mounts = self.fixture()
        with mock.patch.object(cutover.prep.probe.RuntimeInspector, 'docker_local', return_value=report) as inspection:
            result = host.docker_snapshot()
        inspection.assert_called_once_with()
        self.assertEqual(result['mounts'], mounts)
        self.assertEqual([c[-1] for c in commands if c[2] == 'inspect'], IDS)
        self.assertEqual(sum(c[2] == 'ps' for c in commands), 2)
        self.assertFalse(any('--context' in arg or 'DOCKER_HOST' in arg for c in commands for arg in c))

    def test_container_set_change_before_or_after_mount_reads_refuses(self):
        for first, second in [(IDS[:1], IDS), (IDS, IDS + ['c' * 64]), (IDS, [])]:
            host, report, commands, mounts = self.fixture(first, second)
            with mock.patch.object(cutover.prep.probe.RuntimeInspector, 'docker_local', return_value=report), \
                    self.assertRaises(cutover.prep.Refuse):
                host.docker_snapshot()
            if first != IDS:
                self.assertFalse(any(c[2] == 'inspect' for c in commands))

    def test_incomplete_probe_and_malformed_mount_projection_refuse(self):
        host, report, commands, values = self.fixture(complete=False)
        with mock.patch.object(cutover.prep.probe.RuntimeInspector, 'docker_local', return_value=report), \
                self.assertRaises(cutover.prep.Refuse):
            host.docker_snapshot()
        self.assertFalse(commands)
        for value in ({'Mounts': []}, [{}], [{'Source': 1}], [None]):
            host, report, commands, values = self.fixture(mounts={IDS[0]: value, IDS[1]: []})
            with mock.patch.object(cutover.prep.probe.RuntimeInspector, 'docker_local', return_value=report), \
                    self.assertRaises(cutover.prep.Refuse):
                host.docker_snapshot()


class PayPatchTests(unittest.TestCase):
    def test_only_patch_array_is_written_and_empty_wrapper_does_not_patch(self):
        host = host_without_initialization()
        host.identities, host.kubectl, host.pay_resources = mock.Mock(), mock.Mock(), mock.Mock(return_value={'live': True})
        patch = [{'op': 'test', 'path': '/metadata/uid', 'value': 'original-uid'},
                 {'op': 'replace', 'path': '/data/volumeMountRoot', 'value': '/var/lib/mx-move/k8s-data/transaction/pay-postgres'}]
        wrappers = {'configMap': {'kind': 'configmap', 'namespace': 'mx-pay', 'name': 'mx-pay-database', 'patch': patch},
                    'statefulSet': {'kind': 'statefulset', 'namespace': 'mx-pay', 'name': 'mx-pay-postgres', 'patch': []}}
        data = journal()
        with mock.patch.object(cutover, 'private_json', return_value=wrappers), \
                mock.patch.object(cutover.Path, 'exists', return_value=False), \
                mock.patch.object(cutover.prep, 'save_private') as save:
            host.apply_pay_patches(data)
        host.identities.assert_called_once_with('patches', data, {'live': True})
        save.assert_called_once()
        self.assertEqual(json.loads(save.call_args.args[1]), patch)
        host.kubectl.assert_called_once_with('-n', 'mx-pay', 'patch', 'configmap', 'mx-pay-database', '--type=json',
                                            '--patch-file=' + str(Path(data['run']) / 'configMap-patch.json'))

    def test_both_empty_patch_arrays_have_no_mutations(self):
        host = host_without_initialization()
        host.identities, host.kubectl, host.pay_resources = mock.Mock(), mock.Mock(), mock.Mock(return_value={})
        with mock.patch.object(cutover, 'private_json', return_value={'configMap': {'patch': []}, 'statefulSet': {'patch': []}}), \
                mock.patch.object(cutover.prep, 'save_private') as save, mock.patch.object(cutover, 'replace_file') as replace:
            host.apply_pay_patches(journal())
        host.kubectl.assert_not_called()
        save.assert_not_called()
        replace.assert_not_called()


class MainDispatchTests(unittest.TestCase):
    def fixture(self, stack, action):
        lock = {'held': False}
        data = journal()
        host = mock.Mock()
        path = cutover.BASE / TRANSACTION / 'journal.json'
        @contextlib.contextmanager
        def locked():
            self.assertFalse(lock['held'])
            lock['held'] = True
            try:
                yield
            finally:
                lock['held'] = False
        def read_private(file):
            if action != 'status':
                self.assertTrue(lock['held'], 'CURRENT read before acquiring migration lock')
            self.assertEqual(file, cutover.CURRENT)
            return {'transaction': TRANSACTION}
        def read(path_value):
            if action != 'status':
                self.assertTrue(lock['held'], 'journal read before acquiring migration lock')
            self.assertEqual(path_value, path)
            return cutover.raw_json(data)
        stack.enter_context(mock.patch.object(cutover.sys, 'platform', 'linux'))
        stack.enter_context(mock.patch.object(cutover.os, 'geteuid', return_value=0))
        stack.enter_context(mock.patch.object(cutover.os, 'umask'))
        stack.enter_context(mock.patch.object(cutover, 'Host', return_value=host))
        stack.enter_context(mock.patch.object(cutover, 'locks', locked))
        stack.enter_context(mock.patch.object(cutover, 'private_json', side_effect=read_private))
        stack.enter_context(mock.patch.object(cutover.candidate_guard, 'safe'))
        stack.enter_context(mock.patch.object(cutover.Path, 'read_bytes', read))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        return host, data, lock

    def test_resume_and_verify_read_current_and_journal_after_lock(self):
        for action in ('resume', 'verify'):
            with self.subTest(action=action), ExitStack() as stack:
                host, data, lock = self.fixture(stack, action)
                resume = stack.enter_context(mock.patch.object(cutover.Move, 'resume'))
                host.verify.side_effect = lambda value: self.assertTrue(lock['held'])
                cutover.main([action])
                if action == 'verify':
                    host.verify.assert_called_once_with(data)
                    resume.assert_not_called()
                    host.run.assert_not_called()
                else:
                    resume.assert_called_once_with()
                    host.verify.assert_not_called()
                self.assertFalse(lock['held'])

    def test_status_is_read_only_and_never_resumes_or_verifies(self):
        with ExitStack() as stack:
            host, data, lock = self.fixture(stack, 'status')
            resume = stack.enter_context(mock.patch.object(cutover.Move, 'resume'))
            cutover.main(['status'])
            resume.assert_not_called()
            host.verify.assert_not_called()
            host.run.assert_not_called()

    def test_new_journal_is_durable_before_publishing_current_pointer(self):
        data = journal()
        data.update(phase='preparing', may_write=False)
        host = mock.Mock()
        host.preflight.side_effect = lambda transaction: dict(data, transaction=transaction, run=str(cutover.BASE / transaction))
        writes = []
        def replace(path, raw, before, mode=0o600):
            writes.append((Path(path), json.loads(raw)))
            if Path(path) == cutover.CURRENT:
                self.assertTrue(any(p.name == 'journal.json' for p, value in writes[:-1]), 'CURRENT published without journal')
        with mock.patch.object(cutover.sys, 'platform', 'linux'), mock.patch.object(cutover.os, 'geteuid', return_value=0), \
                mock.patch.object(cutover.os, 'umask'), mock.patch.object(cutover, 'Host', return_value=host), \
                mock.patch.object(cutover, 'locks', contextlib.nullcontext), \
                mock.patch.object(cutover.Path, 'exists', return_value=False), \
                mock.patch.object(cutover.prep, 'secure_directory'), mock.patch.object(cutover, 'replace_file', side_effect=replace), \
                mock.patch.object(cutover.Move, 'execute') as execute, contextlib.redirect_stdout(io.StringIO()):
            cutover.main(['migrate'])
        self.assertEqual([p.name for p, value in writes], ['journal.json', 'current.json'])
        execute.assert_called_once()


class ProductRuntimeEntryTests(unittest.TestCase):
    def test_repository_scripts_support_shared_rig_resolver(self):
        manage = cutover.REPO / 'mx-rig/scripts/manage.sh'
        self.assertNotIn(b'/usr/local/lib/mx-k8s-runtime/resolve.py', manage.read_bytes())
        cutover.verify_product_runtime_entries(cutover.REPO)

    def assert_incomplete(self, relative, old, new):
        target = cutover.REPO / relative
        original_read = Path.read_bytes
        body = original_read(target)
        self.assertIn(old, body)
        changed = body.replace(old, new)
        with mock.patch.object(Path, 'read_bytes',
                               lambda path: changed if path == target else original_read(path)):
            with self.assertRaisesRegex(cutover.prep.Refuse, '产品运行时入口未同步完整适配：' + relative):
                cutover.verify_product_runtime_entries(cutover.REPO)

    def test_rig_caller_requires_loaded_helper_and_explicit_endpoint(self):
        for old, new in (
                (b'source "${ROOT_DIR}/scripts/build-proxy.sh"',
                 b'# source "${ROOT_DIR}/scripts/build-proxy.sh"'),
                (b'address="$(rig_managed_runtime_value address)" || return 1',
                 b'# address="$(rig_managed_runtime_value address)" || return 1'),
                (b'ctr --address "$address" -n k8s.io', b'ctr -n k8s.io')):
            with self.subTest(removed=old):
                self.assert_incomplete('mx-rig/scripts/manage.sh', old, new)

    def test_rig_provider_requires_resolver_and_helper_definition(self):
        for old, new in (
                (b'/usr/local/lib/mx-k8s-runtime/resolve.py', b'/legacy/resolve.py'),
                (b'rig_managed_runtime_value() {', b'legacy_runtime_value() {'),
                (b'/etc/mx-k8s-runtime/active.json', b'/legacy/active.json')):
            with self.subTest(removed=old):
                self.assert_incomplete('mx-rig/scripts/build-proxy.sh', old, new)

    def test_missing_rig_provider_is_refused(self):
        target = cutover.REPO / 'mx-rig/scripts/build-proxy.sh'
        original_read = Path.read_bytes
        def read(path):
            if path == target:
                raise FileNotFoundError(str(path))
            return original_read(path)
        with mock.patch.object(Path, 'read_bytes', read):
            with self.assertRaisesRegex(cutover.prep.Refuse, '无法读取产品运行时入口：mx-rig/scripts/build-proxy.sh'):
                cutover.verify_product_runtime_entries(cutover.REPO)


class CandidatePreflightTests(unittest.TestCase):
    def fixture(self, stack, candidate_images=None, source_images=None):
        # Use the actual product scripts: synthetic marker-only strings hid
        # the Rig entry point's delegation to its sourced build-proxy helper.
        product_sources = {path: path.read_bytes() for path in (
            cutover.REPO / 'mx-launcher/scripts/k8s-production-recovery.sh',
            cutover.REPO / 'mx-insight-hub/scripts/manage.sh',
            cutover.REPO / 'mx-common/scripts/manage.sh',
            cutover.REPO / 'mx-rig/scripts/manage.sh',
            cutover.REPO / 'mx-rig/scripts/build-proxy.sh',
            cutover.REPO / 'mx-base/mx-pay/scripts/runtime.mjs',
            cutover.REPO / 'mx-base/mx-pay/scripts/build-proxy.sh')}
        host = host_without_initialization()
        host.cluster = mock.Mock()
        host.cluster.snapshot.return_value = {'objects': {'configmaps': [], 'nodes': [{'metadata': {}}]}}
        host.etcd = mock.Mock()
        host.etcd.discover.return_value = {'node': cutover.NODE, 'cluster_uid': cutover.CLUSTER_UID}
        host.runtime, host.storage = mock.Mock(), mock.Mock()
        host.runtime.tasks.return_value = ['docker-task']
        host.storage.snapshot.return_value = {'entries': []}
        host.pay_resources, host.check_identities = mock.Mock(return_value={}), mock.Mock()
        host.docker_snapshot = mock.Mock(return_value={'info': {'root': '/data/docker'}, 'mounts': {IDS[0]: [{'Source': '/data/docker-consumer'}]}})
        images = [{'name': 'registry/app:v1', 'digest': 'sha256:' + 'a' * 64,
                   'media_type': 'index', 'platforms': 'linux/amd64,linux/arm64'}]
        candidate = {'phase': 'ready', 'filesystem_uuid': cutover.ROOT_UUID, 'prepared_directory': '/fixture/prepared'}
        inspector = mock.Mock()
        inspector.facts.return_value = {'runtime': {'kubelet': {'flags': {'config': '/var/lib/kubelet/config.yaml'}},
                                                    'containerd': {'address': cutover.cutover_runtime.OLD}}, 'dump': 'verified-config'}
        inspector.images.side_effect = lambda address: (source_images if source_images is not None else images) if address == cutover.cutover_runtime.OLD else (candidate_images if candidate_images is not None else images)
        inspector.image_state.return_value = {'sha256:source': {'tags': ['registry/app:v1'], 'digests': []}}
        def private(path):
            return images if Path(path).name == 'images.json' else {'source_config_sha256': cutover.digest(b'verified-config')}
        stack.enter_context(mock.patch.object(cutover.os, 'uname', return_value=SimpleNamespace(nodename=cutover.NODE)))
        stack.enter_context(mock.patch.object(cutover.os.path, 'lexists', return_value=False))
        stack.enter_context(mock.patch.object(cutover.shutil, 'which', return_value='/usr/bin/fixture'))
        stack.enter_context(mock.patch.object(cutover.candidate_guard, 'verify', return_value=candidate))
        stack.enter_context(mock.patch.object(cutover.runtime_install, 'Host', return_value=inspector))
        stack.enter_context(mock.patch.object(cutover, 'private_json', side_effect=private))
        stack.enter_context(mock.patch.object(cutover.Path, 'read_bytes',
                                             lambda path: product_sources.get(path, b'verified-installed-resolver')))
        stack.enter_context(mock.patch.object(cutover.prep, 'available', return_value=cutover.prep.RESERVE + 1))
        stack.enter_context(mock.patch.object(cutover.endpoint_config, 'snapshot', return_value={}))
        stack.enter_context(mock.patch.object(cutover.endpoint_config, 'rewrite_crictl', return_value=b'new-crictl'))
        return host, images, inspector

    def test_candidate_may_add_aliases_but_must_cover_all_original_reference_digests(self):
        with ExitStack() as stack:
            host, images, inspector = self.fixture(stack)
            imported = [dict(images[0], platforms='linux/amd64'),
                        dict(images[0], name='sha256:' + 'b' * 64, platforms='linux/amd64')]
            inspector.images.side_effect = lambda address: images if address == cutover.cutover_runtime.OLD else imported
            result = host.preflight(TRANSACTION)
        self.assertFalse(result['may_write'])
        host.check_identities.assert_called_once_with(result)
        self.assertEqual(set(host.storage.snapshot.call_args.kwargs['protected_paths']), {'/data/docker', '/data/docker-consumer'})

    def test_missing_changed_candidate_reference_or_changed_source_refuses_before_storage(self):
        changes = ('missing', 'digest', 'source')
        for change in changes:
            with self.subTest(change=change), ExitStack() as stack:
                host, images, inspector = self.fixture(stack)
                changed = [] if change == 'missing' else [dict(images[0], digest='sha256:' + 'f' * 64)]
                inspector.images.side_effect = lambda address: (changed if change == 'source' else images) if address == cutover.cutover_runtime.OLD else (images if change == 'source' else changed)
                with self.assertRaises(cutover.prep.Refuse):
                    host.preflight(TRANSACTION)
                host.storage.snapshot.assert_not_called()

class HostVerificationTests(unittest.TestCase):
    def test_verify_checks_current_state_without_starting_or_restoring_services(self):
        host = host_without_initialization()
        host.run, host.activate, host.identities, host.pay_resources = mock.Mock(), mock.Mock(), mock.Mock(), mock.Mock(return_value={})
        host.cluster, host.etcd, host.storage, host.runtime = mock.Mock(spec=cutover.cluster_ops.Cluster), mock.Mock(), mock.Mock(), mock.Mock()
        host.cluster.validate_cluster_baseline.return_value = {'nodes': [{'metadata': {}, 'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}]}
        host.etcd.etcd_status.return_value = {'cluster_id': 'same-cluster', 'member_id': 'same-member', 'revision': 101}
        host.etcd.launcher_check.return_value = {'credentials_digest': 'unchanged'}
        host.runtime.tasks.side_effect = lambda address, namespace='k8s.io': ['docker-task'] if namespace == 'moby' else []
        host.docker_snapshot = mock.Mock(return_value={'complete': True, 'mounts': {}})
        data = journal()
        data['cluster']['objects'] = {'nodes': [{'metadata': {}}]}
        data.update(kubelet_launch={}, dropin=base64.b64encode(b'fstab').decode(), crictl_after=base64.b64encode(b'fstab').decode())
        data.update(etcd={'etcd': {'cluster_id': 'same-cluster', 'member_id': 'same-member', 'revision': 100}},
                    launcher_before={'credentials_digest': 'unchanged'}, moby_before=['docker-task'],
                    docker_before={'complete': True, 'mounts': {}})
        data['storage']['entries'] = [{'key': 'pay-postgres', 'logical': cutover.storage_ops.ROOTS['pay-postgres'],
                                      'target_fsroot': '/var/lib/mx-move/k8s-data/' + TRANSACTION + '/pay-postgres'}]
        with mock.patch.object(cutover.candidate_guard, 'verify'), mock.patch.object(cutover.storage_guard, 'verify'), \
                mock.patch.object(cutover.endpoint_config, 'verify'), \
                mock.patch.object(cutover.Path, 'read_bytes', return_value=b'fstab'), \
                mock.patch.object(cutover.runtime_resolver.Resolver, 'resolve', return_value=cutover.cutover_runtime.NEW):
            host.verify(data)
        host.run.assert_not_called()
        host.activate.assert_not_called()
        host.cluster.resume.assert_not_called()
        self.assertEqual(host.identities.call_args.args[0], 'verify')
        host.runtime.stop_old.assert_not_called()
        host.storage.switch.assert_not_called()
        host.storage.restore.assert_not_called()

    def test_uncommitted_verify_fails_before_any_service_or_storage_check(self):
        host = host_without_initialization()
        data = journal()
        data['may_write'] = False
        with mock.patch.object(cutover.candidate_guard, 'verify') as candidate, \
                mock.patch.object(cutover.storage_guard, 'verify') as storage, self.assertRaises(cutover.prep.Refuse):
            host.verify(data)
        candidate.assert_not_called()
        storage.assert_not_called()


class NodeEndpointTests(unittest.TestCase):
    def fixture(self, before=None, current=None, uid='original'):
        host = host_without_initialization()
        def node(endpoint):
            return {'metadata': {'uid': uid, 'resourceVersion': '22',
                                 'annotations': {} if endpoint is None else {cutover.NODE_ENDPOINT: endpoint}}}
        data = journal()
        data['cluster'] = {'node_uid': 'original', 'objects': {'nodes': [node(before)]}}
        host.kubectl, host.run = mock.Mock(return_value=cutover.raw_json(node(current))), mock.Mock()
        return host, data

    def test_updates_only_existing_annotation_with_uid_resource_version_and_value_cas(self):
        old = 'unix://' + cutover.cutover_runtime.OLD
        host, data = self.fixture(old, old)
        host.reconcile_node_endpoint(data)
        patch = json.loads(host.run.call_args.kwargs['input_data'])
        self.assertEqual([v['op'] for v in patch], ['test', 'test', 'test', 'replace'])
        self.assertEqual(patch[-1]['value'], 'unix://' + cutover.cutover_runtime.NEW)
        self.assertEqual(patch[-1]['path'], '/metadata/annotations/kubeadm.alpha.kubernetes.io~1cri-socket')

    def test_absent_or_already_updated_annotation_is_not_recreated(self):
        for before, current in ((None, None), ('unix://' + cutover.cutover_runtime.OLD, 'unix://' + cutover.cutover_runtime.NEW)):
            host, data = self.fixture(before, current)
            host.reconcile_node_endpoint(data)
            host.run.assert_not_called()

    def test_replaced_node_or_conflicting_annotation_refuses(self):
        for current, uid in (('unix:///run/unrelated.sock', 'original'), (None, 'replaced')):
            host, data = self.fixture(None, current, uid)
            with self.assertRaises(cutover.prep.Refuse):
                host.reconcile_node_endpoint(data)
            host.run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
