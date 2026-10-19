"""Scoped mount-stack regressions; all host files and mount operations are fake."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
import storage_ops as ops
import test_storage_ops as fixtures


BINFMT = '/proc/sys/fs/binfmt_misc'


def add_stack(mounts, target):
    existing = next((row for row in mounts if row['target'] == target), None)
    if existing is None:
        existing = fixtures.mount(target, fixtures.SOURCE_UUID)
        mounts.append(existing)
    mounts.append(dict(existing))


class ScopeTests(unittest.TestCase):
    def test_raw_host_inventory_preserves_unrelated_identical_layers(self):
        mounts = [fixtures.mount('/', fixtures.ROOT_UUID)]
        add_stack(mounts, BINFMT)
        host = ops.Host()
        with mock.patch.object(host, 'run', return_value=json.dumps({'filesystems': mounts}).encode()):
            self.assertEqual(host.mounts(), mounts)

    def test_scoped_inventory_retains_unrelated_stacks_without_collapsing_rows(self):
        mounts = [fixtures.mount('/', fixtures.ROOT_UUID)]
        add_stack(mounts, BINFMT)
        before = copy.deepcopy(mounts)
        host = mock.Mock(spec=ops.Host)
        host.mounts.return_value = mounts
        result = ops.Storage(host).mounts(paths=('/', '/data'), trees=('/var/lib/kubelet',))
        self.assertEqual(result, before)
        self.assertEqual(mounts, before)
        self.assertEqual(sum(row['target'] == BINFMT for row in result), 2)

    def test_no_scope_is_refused_instead_of_silently_allowing_every_stack(self):
        with self.assertRaises((ValueError, ops.StorageError)):
            ops.check_mount_stacks([])

    def test_exact_ancestors_and_recursive_children_are_rejected(self):
        tree = '/data/k8s/app'
        for target in ('/', '/data', '/data/k8s', tree, tree + '/pgdata'):
            with self.subTest(target=target):
                mounts = []
                add_stack(mounts, target)
                with self.assertRaises(ops.StorageError):
                    ops.check_mount_stacks(mounts, trees=(tree,))
        for target in ('/', '/srv', '/srv/docker'):
            with self.subTest(protected_target=target):
                mounts = []
                add_stack(mounts, target)
                with self.assertRaises(ops.StorageError):
                    ops.check_mount_stacks(mounts, paths=('/srv/docker',))

    def test_protected_descendants_and_similar_prefixes_do_not_expand_scope(self):
        mounts = []
        for target in ('/srv/docker/overlay', '/data/k8s/app-old', BINFMT):
            add_stack(mounts, target)
        before = copy.deepcopy(mounts)
        ops.check_mount_stacks(mounts, paths=('/', '/data', '/srv/docker'), trees=('/data/k8s/app',))
        self.assertEqual(mounts, before)

    def test_relevant_stack_error_omits_sources_and_mount_options(self):
        rows = [dict(fixtures.mount('/data', fixtures.SOURCE_UUID),
                     source='PRIVATE_DEVICE', options='rw,PRIVATE_OPTION')] * 2
        with self.assertRaises(ops.StorageError) as failure:
            ops.check_mount_stacks(rows, paths=('/data/mx-rig',))
        message = str(failure.exception)
        self.assertIn('/data', message)
        self.assertNotIn('PRIVATE_DEVICE', message)
        self.assertNotIn('PRIVATE_OPTION', message)


class SnapshotStackTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.SnapshotTests()

    def test_real_binfmt_double_mount_allows_complete_five_root_snapshot(self):
        host, mounts = self.fixture.fixture()
        add_stack(mounts, BINFMT)
        before = copy.deepcopy(mounts)
        with self.fixture.files():
            result = ops.Storage(host).snapshot(fixtures.TRANSACTION, fixtures.ROOT_UUID, fixtures.SOURCE_UUID)
        self.assertEqual(len(result['entries']), 5)
        self.assertEqual([row['key'] for row in result['entries']], list(ops.ROOTS))
        self.assertEqual(mounts, before)
        host.run.assert_not_called()

    def test_snapshot_rejects_logical_physical_source_and_future_target_stacks(self):
        target = fixtures.entry('launcher')['target']
        source = fixtures.entry('launcher')['source']
        for duplicate in ('/', '/data', '/var/lib', '/var/lib/kubelet',
                          source, source + '/k8s/postgres',
                          str(Path(target).parent), target, target + '/k8s/postgres'):
            with self.subTest(duplicate=duplicate):
                host, mounts = self.fixture.fixture()
                add_stack(mounts, duplicate)
                with self.fixture.files(), self.assertRaises(ops.StorageError):
                    ops.Storage(host).snapshot(fixtures.TRANSACTION, fixtures.ROOT_UUID, fixtures.SOURCE_UUID)
                host.run.assert_not_called()

    def test_dynamic_docker_source_and_ancestor_stacks_are_rejected(self):
        protected = '/srv/docker-content'
        for duplicate in ('/srv', protected):
            with self.subTest(duplicate=duplicate):
                host, mounts = self.fixture.fixture()
                add_stack(mounts, duplicate)
                with self.fixture.files(), self.assertRaises(ops.StorageError):
                    ops.Storage(host).snapshot(fixtures.TRANSACTION, fixtures.ROOT_UUID,
                                               fixtures.SOURCE_UUID, protected_paths=(protected,))
                host.run.assert_not_called()


class MutationStackTests(unittest.TestCase):
    def test_no_children_rejects_same_path_and_ancestor_stacks(self):
        item = fixtures.entry('launcher')
        for target in (item['logical'], '/var/lib', '/'):
            with self.subTest(target=target):
                host = fixtures.Host(item)
                add_stack(host.nested, target)
                with self.assertRaises(ops.StorageError):
                    ops.Storage(host).no_children(item['logical'])
                self.assertEqual(host.commands, [])

    def test_source_and_target_rechecks_refuse_changed_mounts(self):
        item = fixtures.entry('launcher')
        for method, field in (('validate_source', 'source'), ('validate_target', 'target')):
            for suffix in ('', '/nested'):
                with self.subTest(method=method, suffix=suffix):
                    host = fixtures.Host(item)
                    add_stack(host.nested, item[field] + suffix)
                    args = (item, fixtures.ROOT_UUID) if method == 'validate_target' else (item,)
                    with self.assertRaises(ops.StorageError):
                        getattr(ops.Storage(host), method)(*args)
                    self.assertEqual(host.commands, [])

    def test_switch_and_restore_do_not_unmount_before_rejecting_changed_source_or_target(self):
        for method in ('switch', 'restore'):
            for field in ('source', 'target'):
                with self.subTest(method=method, field=field):
                    item = fixtures.entry('launcher')
                    host = fixtures.Host(item)
                    if method == 'restore':
                        host.current = fixtures.mount(item['logical'], fixtures.ROOT_UUID, item['target'])
                        host.current_identity = item['target_identity']
                    add_stack(host.nested, item[field] + '/nested')
                    with mock.patch.object(ops.guard, 'path_info'), self.assertRaises(ops.StorageError):
                        getattr(ops.Storage(host), method)(item, lambda: None, fixtures.ROOT_UUID)
                    self.assertEqual(host.commands, [])

    def test_resumed_cold_copy_checks_target_parent_and_children_before_writing(self):
        for relative in ('parent', 'target', 'child'):
            with self.subTest(relative=relative):
                item = fixtures.entry('launcher')
                item.pop('copied')
                target = {'parent': str(Path(item['target']).parent),
                          'target': item['target'], 'child': item['target'] + '/nested'}[relative]
                host = fixtures.Host(item)
                add_stack(host.nested, target)
                with mock.patch.object(ops.guard, 'path_info'), self.assertRaises(ops.StorageError):
                    ops.Storage(host).cold_copy(item, lambda: None, lambda value: None)
                self.assertEqual(host.commands, [])

    def test_binfmt_stack_remains_untouched_during_switch_and_restore(self):
        item = fixtures.entry('launcher')
        host = fixtures.Host(item)
        add_stack(host.nested, BINFMT)
        before = copy.deepcopy(host.nested)
        storage = ops.Storage(host)
        with mock.patch.object(ops.guard, 'path_info'):
            storage.switch(item, lambda: None, fixtures.ROOT_UUID)
            storage.restore(item, lambda: None, fixtures.ROOT_UUID)
        self.assertEqual(host.nested, before)
        self.assertFalse(any(BINFMT in command for command in host.commands))
        self.assertEqual(host.current_identity, item['source_identity'])

    def test_journal_and_current_kubelet_stacks_never_unmount_a_layer(self):
        child = fixtures.KubeletUnmountTests().child()
        for journal_stack, current_stack in ((True, False), (False, True)):
            with self.subTest(journal_stack=journal_stack, current_stack=current_stack):
                data = fixtures.snapshot()
                item = data['entries'][0]
                item['kubelet_children'] = [child] * (2 if journal_stack else 1)
                host = fixtures.Host(item)
                host.nested = [child] * (2 if current_stack else 1)
                with self.assertRaises(ops.StorageError):
                    ops.Storage(host).unmount_kubelet_children(data, lambda: None)
                self.assertEqual(host.commands, [])

    def test_duplicate_added_before_kubelet_unmount_is_rejected(self):
        data = fixtures.snapshot()
        item = data['entries'][0]
        child = fixtures.KubeletUnmountTests().child()
        item['kubelet_children'] = [child]
        host = fixtures.Host(item)
        host.nested = [child]
        def stopped():
            host.nested.append(dict(child))
        with self.assertRaises(ops.StorageError):
            ops.Storage(host).unmount_kubelet_children(data, stopped)
        self.assertEqual(host.commands, [])


if __name__ == '__main__':
    unittest.main()
