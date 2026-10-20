"""Private Kubernetes backups preserve reviewed history without following links."""
from contextlib import contextmanager, ExitStack
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import cutover
finally:
    sys.path.pop(0)


HISTORY = 'mx-kubelet-auth-repair.CeHaeh'
LINKS = (HISTORY + '/pki.before/kubelet-client-current.pem',
         HISTORY + '/old-clients/kubelet-client-current.pem')


class KubernetesBackupTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(prefix='mx-kb-') as directory, ExitStack() as stack:
            base = Path(directory)
            source, destination = base / 'source', base / 'backup'
            source.mkdir(mode=0o700)
            mount = {'target': '/', 'fsroot': '/', 'uuid': cutover.ROOT_UUID, 'fstype': 'xfs'}
            storage_host = SimpleNamespace(mount=mock.Mock(return_value=mount),
                                           mounts=mock.Mock(return_value=[]))
            host = object.__new__(cutover.Host)
            host.storage = cutover.storage_ops.Storage(storage_host)
            stack.enter_context(mock.patch.object(cutover, 'KUBERNETES_CONFIG', source))
            guard = stack.enter_context(mock.patch.object(cutover.storage_guard, 'path_info',
                                                          return_value=source.lstat()))
            yield SimpleNamespace(source=source, destination=destination, host=host,
                                  mount=mount, storage_host=storage_host, guard=guard)

    def write(self, source, relative, contents=b'fixture-private-data', mode=0o600):
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        path.chmod(mode)
        return path

    def link(self, source, relative, target):
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)
        return path

    def test_complete_backup_preserves_dangling_history_and_never_accesses_nas_target(self):
        with self.fixture() as case:
            files = {
                'admin.conf': (b'fixture-kubeconfig', 0o600),
                'pki/etcd/server.key': (b'fixture-current-key', 0o600),
                'pki/ca.crt': (b'fixture-current-certificate', 0o644),
                HISTORY + '/pki.before/kubelet-client-old.pem': (b'fixture-old-client', 0o600),
                HISTORY + '/kubelet.conf.before': (b'fixture-old-config', 0o600),
            }
            for relative, (contents, mode) in files.items():
                self.write(case.source, relative, contents, mode)
            targets = {LINKS[0]: 'kubelet-client-missing.pem', LINKS[1]: '/mnt/nas/private-client.pem'}
            source_links = set()
            for relative, target in targets.items():
                source_links.add(str(self.link(case.source, relative, target)))
            real_stat, real_open = os.stat, open

            def guarded_stat(path, *args, **kwargs):
                value = str(path)
                self.assertFalse(value.startswith('/mnt/nas'))
                self.assertFalse(value in source_links and kwargs.get('follow_symlinks', True))
                return real_stat(path, *args, **kwargs)

            def guarded_open(path, *args, **kwargs):
                self.assertFalse(str(path).startswith('/mnt/nas'))
                self.assertNotIn(str(path), source_links)
                return real_open(path, *args, **kwargs)

            with mock.patch.object(os, 'stat', side_effect=guarded_stat), \
                    mock.patch('builtins.open', side_effect=guarded_open):
                case.host.backup_kubernetes(case.destination)
            self.assertEqual(cutover.kubernetes_backup_links(case.source), targets)
            self.assertEqual(cutover.kubernetes_backup_links(case.destination), targets)
            for relative, (contents, mode) in files.items():
                for root in (case.source, case.destination):
                    self.assertEqual((root / relative).read_bytes(), contents)
                    self.assertEqual(stat.S_IMODE((root / relative).lstat().st_mode), mode)
            for relative, target in targets.items():
                self.assertTrue(stat.S_ISLNK((case.destination / relative).lstat().st_mode))
                self.assertEqual(os.readlink(str(case.destination / relative)), target)
            self.assertTrue(case.guard.called)
            self.assertTrue(case.storage_host.mount.called)
            self.assertTrue(case.storage_host.mounts.called)

    def test_unreviewed_active_historical_and_directory_links_are_rejected(self):
        paths = ['admin.conf', 'pki/kubelet-client-current.pem', 'pki',
                 HISTORY + '/pki.before/other.pem',
                 'mx-kubelet-auth-repair.Other/pki.before/kubelet-client-current.pem',
                 'mx-kubelet-auth-recovery-new/pki.before/kubelet-client-current.pem']
        for relative in paths:
            with self.subTest(relative=relative), self.fixture() as case:
                self.link(case.source, relative, '/mnt/nas/private')
                with mock.patch.object(cutover.shutil, 'copytree') as copy:
                    with self.assertRaises(cutover.prep.Refuse):
                        case.host.backup_kubernetes(case.destination)
                copy.assert_not_called()

    def test_reviewed_names_can_still_contain_regular_files(self):
        with self.fixture() as case:
            for relative in LINKS:
                self.write(case.source, relative)
            case.host.backup_kubernetes(case.destination)
            self.assertEqual(cutover.kubernetes_backup_links(case.destination), {})
            for relative in LINKS:
                self.assertEqual((case.destination / relative).read_bytes(), b'fixture-private-data')

    def test_root_symlink_is_rejected_without_traversal(self):
        with self.fixture() as case:
            link = case.source.parent / 'source-link'
            link.symlink_to(case.source, target_is_directory=True)
            with self.assertRaises(cutover.prep.Refuse):
                cutover.kubernetes_backup_links(link)

    def test_fifo_is_rejected_before_copy(self):
        with self.fixture() as case:
            os.mkfifo(str(case.source / 'special'), 0o600)
            with mock.patch.object(cutover.shutil, 'copytree') as copy:
                with self.assertRaises(cutover.prep.Refuse):
                    case.host.backup_kubernetes(case.destination)
            copy.assert_not_called()

    def test_socket_device_file_or_cross_device_entry_is_rejected_without_reading_it(self):
        for kind in ('socket', 'device', 'cross-device-file', 'cross-device-directory'):
            with self.subTest(kind=kind), self.fixture() as case:
                path = case.source / 'foreign'
                if kind == 'cross-device-directory':
                    path.mkdir()
                else:
                    self.write(case.source, 'foreign')
                real_lstat = Path.lstat
                values = list(real_lstat(path))
                if kind in ('socket', 'device'):
                    # Simulate kernel metadata; no device creation or socket
                    # binding privileges are needed to exercise the guard.
                    values[0] = (stat.S_IFSOCK if kind == 'socket' else stat.S_IFCHR) | 0o600
                else:
                    values[2] += 1
                foreign = os.stat_result(values)

                def lstat(item, *args, **kwargs):
                    return foreign if item == path else real_lstat(item, *args, **kwargs)

                with mock.patch.object(Path, 'lstat', lstat), \
                        mock.patch.object(cutover.shutil, 'copytree') as copy:
                    with self.assertRaises(cutover.prep.Refuse):
                        case.host.backup_kubernetes(case.destination)
                copy.assert_not_called()

    def test_nested_mount_and_wrong_covering_mount_are_rejected_before_tree_scan(self):
        for kind in ('nested-nas', 'wrong-uuid', 'bind-root', 'non-root-mount'):
            with self.subTest(kind=kind), self.fixture() as case:
                if kind == 'nested-nas':
                    case.storage_host.mounts.return_value = [
                        {'target': str(case.source / 'mounted'), 'fstype': 'nfs'}]
                elif kind == 'wrong-uuid':
                    case.mount['uuid'] = cutover.SOURCE_UUID
                elif kind == 'bind-root':
                    case.mount['fsroot'] = '/other'
                else:
                    case.mount['target'] = str(case.source)
                with mock.patch.object(cutover, 'kubernetes_backup_links') as scan, \
                        mock.patch.object(cutover.shutil, 'copytree') as copy:
                    with self.assertRaises((cutover.prep.Refuse, cutover.storage_ops.StorageError)):
                        case.host.backup_kubernetes(case.destination)
                scan.assert_not_called()
                copy.assert_not_called()

    def test_changed_source_or_destination_link_cannot_pass_verification(self):
        for changed in ('source', 'destination'):
            with self.subTest(changed=changed), self.fixture() as case:
                self.link(case.source, LINKS[0], 'original.pem')
                real_copytree = shutil.copytree

                def copytree(source, destination, **kwargs):
                    # Recursive copytree invokes the patched global as well.
                    with mock.patch.object(cutover.shutil, 'copytree', real_copytree):
                        result = real_copytree(source, destination, **kwargs)
                    root = case.source if changed == 'source' else case.destination
                    link = root / LINKS[0]
                    link.unlink()
                    link.symlink_to('changed.pem')
                    return result

                with mock.patch.object(cutover.shutil, 'copytree', side_effect=copytree):
                    with self.assertRaises(cutover.prep.Refuse):
                        case.host.backup_kubernetes(case.destination)


if __name__ == '__main__':
    unittest.main()
