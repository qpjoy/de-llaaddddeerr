"""Offline startup-guard checks; no mounts, root or running services required."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    'mx_move_boot_guard_tested', Path(__file__).parents[1] / 'boot_guard.py')
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class BootGuardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='mx-move-boot-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / 'var/lib/etcd'
        (self.data / 'member/snap').mkdir(parents=True)
        (self.data / 'member/snap/db').write_bytes(b'etcd fixture database')
        self.record_path = self.root / 'state/active-etcd.json'
        self.record_path.parent.mkdir(mode=0o700)
        self.identity = {'uuid': 'trusted-fs-uuid', 'inode': self.data.stat().st_ino}
        self.record = {'version': 1, 'allowed': [self.identity], 'data': str(self.data)}
        self.write_record()
        self.mount = {'filesystems': [{'target': str(self.data), 'uuid': self.identity['uuid'],
                                      'options': 'rw,relatime', 'fsroot': '/current-generation'}]}

    def write_record(self):
        self.record_path.write_text(json.dumps(self.record))
        self.record_path.chmod(0o600)

    def verify(self):
        return guard.verify(self.record_path, self.data, os.getuid(), self.root,
                            lambda data: self.mount)

    def test_matching_mount_and_private_record_are_accepted_without_writes(self):
        before = {p: p.read_bytes() for p in [self.record_path, self.data / 'member/snap/db']}
        self.assertEqual(self.verify(), self.record)
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_missing_record_is_refused(self):
        self.record_path.unlink()
        with self.assertRaises(guard.GuardError):
            self.verify()

    def test_wrong_uuid_is_refused(self):
        self.mount['filesystems'][0]['uuid'] = 'another-disk'
        with self.assertRaisesRegex(guard.GuardError, 'UUID'):
            self.verify()

    def test_wrong_directory_inode_is_refused(self):
        self.identity['inode'] += 1
        self.write_record()
        with self.assertRaisesRegex(guard.GuardError, 'inode'):
            self.verify()

    def test_missing_bind_mount_never_falls_back_to_root_filesystem(self):
        self.mount['filesystems'][0]['target'] = '/'
        with self.assertRaisesRegex(guard.GuardError, '没有独立挂载'):
            self.verify()

    def test_unreadable_or_ambiguous_mount_is_refused(self):
        for value in [None, [], {}, {'filesystems': []},
                      {'filesystems': [None]}, {'filesystems': [{}, {}]}]:
            with self.subTest(value=value):
                self.mount = value
                with self.assertRaises(guard.GuardError):
                    self.verify()

    def test_read_only_or_missing_options_are_refused(self):
        for options in [None, 'ro,relatime', 'rw,ro', 'relatime', ['rw']]:
            with self.subTest(options=options):
                self.mount['filesystems'][0]['options'] = options
                with self.assertRaisesRegex(guard.GuardError, '可读写'):
                    self.verify()

    def test_missing_fsroot_is_refused(self):
        self.mount['filesystems'][0].pop('fsroot')
        with self.assertRaises(guard.GuardError):
            self.verify()

    def test_symlink_record_is_refused(self):
        original = self.record_path.with_suffix('.original')
        self.record_path.rename(original)
        self.record_path.symlink_to(original)
        with self.assertRaisesRegex(guard.GuardError, '符号链接'):
            self.verify()

    def test_symlink_data_directory_is_refused(self):
        original = self.data.with_name('original')
        self.data.rename(original)
        self.data.symlink_to(original, target_is_directory=True)
        with self.assertRaisesRegex(guard.GuardError, '符号链接'):
            self.verify()

    def test_symlink_database_is_refused(self):
        db = self.data / 'member/snap/db'
        original = db.with_suffix('.original')
        db.rename(original)
        db.symlink_to(original)
        with self.assertRaisesRegex(guard.GuardError, '符号链接'):
            self.verify()

    def test_record_needs_private_permissions(self):
        self.record_path.chmod(0o644)
        with self.assertRaisesRegex(guard.GuardError, '身份记录'):
            self.verify()

    def test_writable_parent_or_data_is_refused(self):
        for path in [self.record_path.parent, self.data, self.data / 'member']:
            with self.subTest(path=str(path)):
                original = path.stat().st_mode & 0o777
                path.chmod(0o777)
                with self.assertRaisesRegex(guard.GuardError, '写权限'):
                    self.verify()
                path.chmod(original)

    def test_non_root_equivalent_owner_is_refused(self):
        with self.assertRaisesRegex(guard.GuardError, '所有者'):
            guard.verify(self.record_path, self.data, os.getuid() + 1, self.root,
                         lambda data: self.mount)

    def test_missing_empty_or_nonregular_database_is_refused(self):
        database = self.data / 'member/snap/db'
        database.unlink()
        with self.assertRaises(guard.GuardError):
            self.verify()
        database.write_bytes(b'')
        with self.assertRaisesRegex(guard.GuardError, '数据库'):
            self.verify()
        database.unlink()
        database.mkdir()
        with self.assertRaisesRegex(guard.GuardError, '数据库'):
            self.verify()

    def test_database_inode_can_change_during_normal_compaction(self):
        database = self.data / 'member/snap/db'
        replacement = database.with_suffix('.next')
        replacement.write_bytes(b'compacted database')
        replacement.replace(database)
        self.verify()

    def test_record_schema_and_fixed_data_path_are_checked(self):
        for field, value in [('version', 2), ('version', True), ('data', '/untrusted'),
                             ('allowed', []), ('allowed', [self.identity] * 3),
                             ('allowed', [self.identity, self.identity]),
                             ('allowed', [{'uuid': '', 'inode': 1}]),
                             ('allowed', [{'uuid': 'disk', 'inode': True}]),
                             ('allowed', [{'uuid': 'disk', 'inode': -1}])]:
            with self.subTest(field=field, value=value):
                original = self.record[field]
                self.record[field] = value
                self.write_record()
                with self.assertRaises(guard.GuardError):
                    self.verify()
                self.record[field] = original

    def test_prewrite_transition_accepts_either_explicit_identity(self):
        alternate = {'uuid': 'destination-fs-uuid', 'inode': self.data.stat().st_ino}
        self.record['allowed'].append(alternate)
        self.write_record()
        self.verify()
        self.mount['filesystems'][0]['uuid'] = alternate['uuid']
        self.verify()

    def test_two_entries_do_not_allow_cross_combined_uuid_and_inode(self):
        self.identity['inode'] += 1
        self.record['allowed'].append({'uuid': 'other-disk', 'inode': self.data.stat().st_ino})
        self.write_record()
        with self.assertRaisesRegex(guard.GuardError, 'inode'):
            self.verify()

    def test_two_entries_do_not_allow_another_filesystem(self):
        self.record['allowed'].append({'uuid': 'other-disk', 'inode': self.data.stat().st_ino})
        self.write_record()
        self.mount['filesystems'][0]['uuid'] = 'third-disk'
        with self.assertRaisesRegex(guard.GuardError, 'UUID'):
            self.verify()

    def test_findmnt_failures_do_not_echo_command_output(self):
        for response in [subprocess.CompletedProcess([], 1, b'sensitive stdout', b'sensitive stderr'),
                         subprocess.CompletedProcess([], 0, b'sensitive invalid JSON', b'')]:
            with self.subTest(code=response.returncode), \
                    mock.patch.object(guard.subprocess, 'run', return_value=response):
                with self.assertRaises(guard.GuardError) as error:
                    guard.mounted_filesystem(self.data)
                self.assertNotIn('sensitive', str(error.exception))

    def test_cli_fixes_data_path_and_reports_failure(self):
        with mock.patch.object(guard, 'verify', side_effect=guard.GuardError('测试失败')) as verify, \
                mock.patch.object(guard.sys, 'stderr'):
            self.assertEqual(guard.main(['--record', str(self.record_path)]), 1)
        verify.assert_called_once_with(str(self.record_path))


if __name__ == '__main__':
    unittest.main()
