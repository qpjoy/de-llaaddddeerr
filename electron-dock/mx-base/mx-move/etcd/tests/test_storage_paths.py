import errno
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location('storage_paths', Path(__file__).parents[1] / 'storage_paths.py')
storage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage)


class FakeDirectories:
    """Model root-owned ancestors without requiring root on the test host."""
    def __init__(self):
        self.nodes = {}
        self.handles = {}
        self.opens = []
        self.counter = 10
        for index, path in enumerate(('/', '/data', '/data/mx-runtime', '/data/mx-runtime/etcd', '/data/mx-runtime/etcd/member')):
            self.nodes[path] = types.SimpleNamespace(st_dev=1, st_ino=index + 1,
                st_uid=1003 if path == '/data' else 0, st_mode=stat.S_IFDIR | 0o755)

    def open(self, path, flags, dir_fd=None):
        if dir_fd is None:
            resolved = str(path)
        else:
            resolved = str(Path(self.handles[dir_fd][0]) / path)
        node = self.nodes.get(resolved)
        if node is None:
            raise FileNotFoundError(errno.ENOENT, 'not found')
        if stat.S_ISLNK(node.st_mode):
            raise OSError(errno.ELOOP, 'symlink')
        self.counter += 1
        self.handles[self.counter] = (resolved, node)
        self.opens.append((resolved, flags, dir_fd))
        return self.counter

    def fstat(self, fd):
        return self.handles[fd][1]

    def close(self, fd):
        del self.handles[fd]

    def patched(self):
        return mock.patch.multiple(storage.os, open=self.open, fstat=self.fstat, close=self.close)


class StoragePolicyTests(unittest.TestCase):
    def setUp(self):
        self.fs = FakeDirectories()
        self.path = '/data/mx-runtime/etcd'

    def test_exact_shared_mount_owner_is_supported(self):
        with self.fs.patched():
            with storage.pinned_directory(self.path, shared_mount='/data') as pinned:
                self.assertEqual(pinned.path, Path(self.path))
                self.assertEqual(pinned.identity, {'device': 1, 'inode': 4})
                self.assertEqual(pinned.proc_path, '/proc/{}/fd/{}'.format(os.getpid(), pinned.fd))
                pinned.assert_current()
        self.assertFalse(self.fs.handles)
        for path, flags, parent in self.fs.opens:
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertTrue(flags & os.O_DIRECTORY)
            self.assertEqual(parent is None, path == '/')

    def test_default_does_not_allow_non_root_ancestor(self):
        with self.fs.patched(), self.assertRaises(storage.StoragePathError):
            with storage.pinned_directory(self.path):
                self.fail('must reject /data ownership')
        self.assertFalse(self.fs.handles)

    def test_shared_mount_still_rejects_group_or_world_writes(self):
        for mode in (0o775, 0o777, 0o757):
            self.fs.nodes['/data'].st_mode = stat.S_IFDIR | mode
            with self.fs.patched(), self.assertRaises(storage.StoragePathError):
                with storage.pinned_directory(self.path, shared_mount='/data'):
                    self.fail('must reject shared writable directory')
            self.assertFalse(self.fs.handles)

    def test_shared_exception_does_not_apply_to_descendants_or_leaf(self):
        for path in ('/data/mx-runtime', self.path):
            self.fs.nodes[path].st_uid = 1003
            with self.fs.patched(), self.assertRaises(storage.StoragePathError):
                with storage.pinned_directory(self.path, shared_mount='/data'):
                    self.fail('must reject non-root child')
            self.fs.nodes[path].st_uid = 0
            self.assertFalse(self.fs.handles)

    def test_rejects_unrelated_or_leaf_shared_mount(self):
        for shared in ('/another', self.path):
            with self.fs.patched(), self.assertRaises(storage.StoragePathError):
                with storage.pinned_directory(self.path, shared_mount=shared):
                    self.fail('shared mount must be strict ancestor')
        self.assertFalse(self.fs.opens)

    def test_rejects_symlinks_at_any_component(self):
        for path in ('/data', '/data/mx-runtime', self.path):
            self.fs.nodes[path].st_mode = stat.S_IFLNK | 0o755
            with self.fs.patched(), self.assertRaises(storage.StoragePathError):
                with storage.pinned_directory(self.path, shared_mount='/data'):
                    self.fail('symlinks must not be followed')
            self.fs.nodes[path].st_mode = stat.S_IFDIR | 0o755
            self.assertFalse(self.fs.handles)

    def test_rejects_missing_or_non_directory_path(self):
        for path in (self.path + '/missing', self.path):
            self.fs.nodes[self.path].st_mode = (stat.S_IFREG | 0o644) if path == self.path else (stat.S_IFDIR | 0o755)
            with self.fs.patched(), self.assertRaises(storage.StoragePathError):
                with storage.pinned_directory(path, shared_mount='/data'):
                    self.fail('must be an existing directory')
            self.assertFalse(self.fs.handles)

    def test_expected_device_and_inode_are_checked(self):
        with self.fs.patched():
            with storage.pinned_directory(self.path, shared_mount='/data', expected={'device': 1, 'inode': 4}):
                pass
            for expected in ({'device': 2, 'inode': 4}, {'device': 1, 'inode': 5}):
                with self.assertRaises(storage.StoragePathError):
                    with storage.pinned_directory(self.path, shared_mount='/data', expected=expected):
                        self.fail('unexpected directory identity')
        self.assertFalse(self.fs.handles)

    def test_reopening_detects_replacement_and_rechecks_permissions(self):
        with self.fs.patched():
            with storage.pinned_directory(self.path, shared_mount='/data') as pinned:
                self.fs.nodes[self.path] = types.SimpleNamespace(st_dev=1, st_ino=99, st_uid=0, st_mode=stat.S_IFDIR | 0o755)
                with self.assertRaises(storage.StoragePathError):
                    pinned.assert_current()
                self.assertEqual(self.fs.fstat(pinned.fd).st_ino, 4)
                self.fs.nodes['/data'].st_mode = stat.S_IFDIR | 0o777
                with self.assertRaises(storage.StoragePathError):
                    pinned.assert_current()
        self.assertFalse(self.fs.handles)

    def test_child_is_opened_relative_to_pinned_parent(self):
        with self.fs.patched():
            with storage.pinned_directory(self.path, shared_mount='/data') as pinned:
                with pinned.open_child('member') as child:
                    self.assertEqual(child.path, Path(self.path) / 'member')
                    self.assertEqual(self.fs.opens[-1][2], pinned.fd)
                for name in ('', '.', '..', '../elsewhere', '/etc', 'a/b', 'a\x00b'):
                    with self.assertRaises(storage.StoragePathError):
                        with pinned.open_child(name):
                            self.fail('invalid child name')
                self.fs.nodes[self.path + '/member'].st_uid = 1003
                with self.assertRaises(storage.StoragePathError):
                    with pinned.open_child('member'):
                        self.fail('child ownership must remain protected')
        self.assertFalse(self.fs.handles)

    def test_context_body_exception_is_preserved_and_fd_closed(self):
        original = OSError('operation failed')
        with self.fs.patched(), self.assertRaises(OSError) as caught:
            with storage.pinned_directory(self.path, shared_mount='/data') as pinned:
                with pinned.open_child('member'):
                    raise original
        self.assertIs(caught.exception, original)
        self.assertFalse(self.fs.handles)

    def test_rejects_relative_or_traversal_paths_before_open(self):
        for path in ('data/etcd', '/data/../data/etcd', '//data/etcd'):
            with self.fs.patched(), self.assertRaises(storage.StoragePathError):
                with storage.pinned_directory(path):
                    self.fail('invalid path')
        self.assertFalse(self.fs.opens)


class RealDirectoryPinTests(unittest.TestCase):
    def test_pin_survives_ancestor_rename_but_assert_current_rejects_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            parent = base / 'data'
            parent.mkdir()
            original = parent / 'etcd'
            original.mkdir()
            (original / 'member').mkdir()
            (original / 'member' / 'marker').write_text('original')
            validate = storage._validate_directory

            def validate_test_directory(fd, path, shared_mount, owner_uid):
                # Test-host /tmp ancestry may be writable and has mixed owners.
                # Production policy is exercised separately above. Keep real
                # metadata checks for this test's private directory tree.
                if path == base or base in path.parents:
                    return validate(fd, path, shared_mount, owner_uid)
                return os.fstat(fd)

            with mock.patch.object(storage, '_validate_directory', side_effect=validate_test_directory):
                with storage.pinned_directory(original, owner_uid=os.getuid()) as pinned:
                    identity = pinned.identity.copy()
                    os.rename(str(parent), str(base / 'renamed-data'))
                    parent.mkdir()
                    (parent / 'etcd').mkdir()
                    (parent / 'etcd' / 'member').mkdir()
                    (parent / 'etcd' / 'member' / 'marker').write_text('replacement')
                    with pinned.open_child('member') as child:
                        marker = os.open('marker', os.O_RDONLY, dir_fd=child.fd)
                        with os.fdopen(marker) as stream:
                            self.assertEqual(stream.read(), 'original')
                        with self.assertRaises(storage.StoragePathError):
                            child.assert_current()
                    self.assertEqual(storage._identity(os.fstat(pinned.fd)), identity)
                    with self.assertRaises(storage.StoragePathError):
                        pinned.assert_current()
                with self.assertRaises(OSError):
                    os.fstat(pinned.fd)


if __name__ == '__main__':
    unittest.main()
