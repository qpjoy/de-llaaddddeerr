"""Kubelet owns local bind teardown; only reviewed tmpfs can be unmounted here."""
import copy
import itertools
import unittest
from unittest import mock

import test_storage_ops as fixtures

ops = fixtures.ops


def temporary():
    return {'target': '/var/lib/kubelet/pods/97643e51-8ea8-4a98-8d9b-c7eb55fa6e1c/'
                      'volumes/kubernetes.io~projected/kube-api-access-test',
            'fstype': 'tmpfs', 'source': 'tmpfs', 'fsroot': '/', 'uuid': None, 'options': 'rw'}


def local_bindings():
    pay = fixtures.mount('/var/lib/kubelet/pods/2518112c-3f66-48f6-857d-1e7b58072aac/'
                         'volumes/kubernetes.io~local-volume/mx-pay-postgres-data',
                         fixtures.SOURCE_UUID, '/mx-pay/mx-pay/postgres')
    es = fixtures.mount('/var/lib/kubelet/pods/27d7dd3e-debf-42f7-a382-d2a8bdc68f21/'
                        'volume-subpaths/config/elasticsearch/2', fixtures.SOURCE_UUID,
                        '/mx-runtime/kubelet/pods/27d7dd3e-debf-42f7-a382-d2a8bdc68f21/'
                        'volumes/kubernetes.io~configmap/config/'
                        '..2026_09_21_10_27_40.4146068500/elasticsearch.yml')
    return [pay, es]


def nas(target='/mnt/nas'):
    return {'target': target, 'uuid': None, 'fstype': 'nfs', 'fsroot': '/',
            'source': 'nas:/volume', 'options': 'rw,hard'}


class KubeletReleaseTests(unittest.TestCase):
    def fixture(self, managed=()):
        data = fixtures.snapshot()
        entry = next(item for item in data['entries'] if item['key'] == 'kubelet')
        entry['kubelet_children'] = [temporary()]
        entry['kubelet_managed_bindings'] = copy.deepcopy(list(managed))
        host = fixtures.Host(entry)
        return data, host, ops.Storage(host)

    def test_tmpfs_and_nas_any_order_refuse_entire_batch_without_unmount(self):
        remote = nas('/var/lib/kubelet/pods/97643e51-8ea8-4a98-8d9b-c7eb55fa6e1c/'
                     'volumes/kubernetes.io~nfs/application')
        for children in itertools.permutations([temporary(), remote]):
            with self.subTest(first=children[0]['fstype']):
                data, host, storage = self.fixture()
                host.nested = list(children) + [nas()]
                before = copy.deepcopy(host.nested)
                with self.assertRaises(ops.StorageError):
                    storage.kubelet_bindings_released(data)
                with self.assertRaises(ops.StorageError):
                    storage.unmount_kubelet_children(data, mock.Mock())
                self.assertEqual(host.commands, [])
                self.assertEqual(host.nested, before)

    def test_verified_pay_and_es_bindings_are_never_manually_unmounted(self):
        for binding in local_bindings():
            for children in itertools.permutations([temporary(), binding]):
                with self.subTest(target=binding['target'], first=children[0]['fstype']):
                    data, host, storage = self.fixture([binding])
                    host.nested = list(children) + [nas()]
                    before = copy.deepcopy(host.nested)
                    self.assertFalse(storage.kubelet_bindings_released(data))
                    with self.assertRaises(ops.StorageError):
                        storage.unmount_kubelet_children(data, mock.Mock())
                    self.assertEqual(host.commands, [])
                    self.assertEqual(host.nested, before)

    def test_after_kubelet_releases_binds_only_recorded_tmpfs_is_unmounted(self):
        data, host, storage = self.fixture(local_bindings())
        outside = nas()
        host.nested = [temporary(), outside]
        self.assertTrue(storage.kubelet_bindings_released(data))
        self.assertEqual(host.commands, [])
        stopped = mock.Mock()
        storage.unmount_kubelet_children(data, stopped)
        self.assertEqual(host.commands, [['umount', '--', temporary()['target']]])
        self.assertEqual(host.nested, [outside])
        stopped.assert_called_once_with()

    def test_changed_verified_bind_metadata_blocks_all_unmounts(self):
        for binding in local_bindings():
            for key, changed in [('uuid', fixtures.ROOT_UUID), ('fsroot', '/different-data'),
                                 ('source', '/dev/changed'), ('options', 'ro'), ('fstype', 'nfs')]:
                with self.subTest(target=binding['target'], field=key):
                    data, host, storage = self.fixture([binding])
                    host.nested = [temporary(), dict(binding, **{key: changed}), nas()]
                    with self.assertRaises(ops.StorageError):
                        storage.kubelet_bindings_released(data)
                    with self.assertRaises(ops.StorageError):
                        storage.unmount_kubelet_children(data, mock.Mock())
                    self.assertEqual(host.commands, [])

    def test_released_known_binds_do_not_allow_a_new_unknown_submount(self):
        for child in [nas('/var/lib/kubelet/new-remote'),
                      fixtures.mount('/var/lib/kubelet/new-local', fixtures.SOURCE_UUID)]:
            with self.subTest(fstype=child['fstype']):
                data, host, storage = self.fixture(local_bindings())
                host.nested = [temporary(), child, nas()]
                with self.assertRaises(ops.StorageError):
                    storage.kubelet_bindings_released(data)
                with self.assertRaises(ops.StorageError):
                    storage.unmount_kubelet_children(data, mock.Mock())
                self.assertEqual(host.commands, [])

    def test_tmpfs_metadata_drift_still_prevents_manual_unmount(self):
        data, host, storage = self.fixture(local_bindings())
        host.nested = [dict(temporary(), options='ro'), nas()]
        with self.assertRaises(ops.StorageError):
            storage.unmount_kubelet_children(data, mock.Mock())
        self.assertEqual(host.commands, [])


class KubeletSnapshotClassificationTests(unittest.TestCase):
    def test_verified_application_binds_are_separate_from_manual_tmpfs_list(self):
        fixture = fixtures.SnapshotTests()
        host, mounts = fixture.fixture()
        application = local_bindings()
        child = temporary()
        mounts.extend([application[0], child, application[1]])
        objects = {'fixture': 'already captured Kubernetes objects'}
        before = copy.deepcopy(mounts)
        with fixture.files(), mock.patch.object(ops.kubelet_bindings, 'verify') as verify:
            result = ops.Storage(host).snapshot(fixtures.TRANSACTION, fixtures.ROOT_UUID,
                                                fixtures.SOURCE_UUID, objects=objects)
        entry = next(item for item in result['entries'] if item['key'] == 'kubelet')
        self.assertEqual(entry['kubelet_children'], [child])
        self.assertEqual(entry['kubelet_managed_bindings'], application)
        self.assertEqual(verify.call_count, 2)
        self.assertEqual([call.args[0] for call in verify.call_args_list], application)
        for call in verify.call_args_list:
            self.assertIs(call.args[1], objects)
            self.assertEqual(call.args[2], fixtures.SOURCE_UUID)
            self.assertEqual(call.args[3]['target'], '/var/lib/kubelet')
        self.assertEqual(mounts, before)
        host.run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
