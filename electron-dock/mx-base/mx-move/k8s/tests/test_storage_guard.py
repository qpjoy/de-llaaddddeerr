import contextlib
import copy
import io
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
import storage_guard as guard
import storage_ops as ops

UUID = 'ea7e456d-19db-4f6e-b8b0-02c00f59d066'
TRANSACTION = 'mx-k8s-20261020-010000-1234abcd'


def info(device=7, inode=10, mode=0o755, uid=0, kind=stat.S_IFDIR):
    return SimpleNamespace(st_dev=device, st_ino=inode, st_mode=kind | mode, st_uid=uid, st_gid=0, st_size=8)


class Fixture:
    def __init__(self):
        self.record = {'schema_version': 1, 'phase': 'active', 'hostname': 'fixture',
                       'transaction': TRANSACTION, 'root_uuid': UUID, 'entries': []}
        self.infos = {}
        self.mounts = {'/': {'target': '/', 'fsroot': '/', 'uuid': UUID}}
        self.postgres = {}
        for number, (key, logical) in enumerate(guard.ROOTS.items(), 1):
            target = guard.DATA_BASE + '/' + TRANSACTION + '/' + key
            entry = {'key': key, 'logical': logical, 'target': target, 'target_fsroot': target,
                     'target_identity': {'device': 7, 'inode': number}}
            self.infos[target] = self.infos[logical] = info(inode=number)
            self.mounts[target] = self.mounts['/'].copy()
            self.mounts[logical] = {'target': logical, 'fsroot': target, 'uuid': UUID}
            if key in guard.PG_PATHS:
                entry['postgres'] = {'version': '16', 'control_first8_hex': '0123456789abcdef'}
                self.postgres[str(Path(logical) / guard.PG_PATHS[key])] = entry['postgres']
            self.record['entries'].append(entry)

    def verify(self):
        with mock.patch.object(guard, 'read_record', return_value=self.record), \
                mock.patch.object(guard.socket, 'gethostname', return_value='fixture'), \
                mock.patch.object(guard, 'path_info', side_effect=lambda path, **kwargs: self.infos[str(path)]), \
                mock.patch.object(guard, 'pg_identity', side_effect=lambda path: self.postgres[str(path)]):
            return guard.verify(findmnt=lambda path: self.mounts[str(path)])


class StorageGuardTests(unittest.TestCase):
    def test_all_selected_roots_and_database_identifiers_are_required(self):
        fixture = Fixture()
        self.assertEqual(fixture.verify(), fixture.record)
        for key in fixture.postgres:
            with self.subTest(key=key):
                changed = Fixture()
                changed.postgres[key] = {'version': '16', 'control_first8_hex': 'ffffffffffffffff'}
                with self.assertRaises(guard.StorageError):
                    changed.verify()

    def test_blocked_or_missing_mount_never_falls_back_to_old_data(self):
        fixture = Fixture()
        fixture.record['phase'] = 'blocked'
        with self.assertRaises(guard.StorageError):
            fixture.verify()
        for logical in guard.ROOTS.values():
            fixture = Fixture()
            fixture.mounts[logical] = fixture.mounts['/']
            with self.assertRaises(guard.StorageError):
                fixture.verify()

    def test_same_uuid_different_inode_fsroot_or_mountpoint_is_refused(self):
        for key in guard.ROOTS:
            for mutation in ('inode', 'fsroot', 'target', 'uuid', 'backing'):
                fixture = Fixture()
                entry = next(e for e in fixture.record['entries'] if e['key'] == key)
                logical = entry['logical']
                if mutation == 'inode':
                    fixture.infos[logical] = info(inode=999)
                elif mutation == 'backing':
                    fixture.mounts[entry['target']] = {'target': '/var/lib/mx-move', 'fsroot': '/', 'uuid': UUID}
                else:
                    fixture.mounts[logical][mutation] = '/wrong'
                with self.subTest(key=key, mutation=mutation), self.assertRaises(guard.StorageError):
                    fixture.verify()

    def test_schema_foreign_host_paths_and_boolean_inode_are_rejected(self):
        mutations = [('hostname', 'other'), ('schema_version', True), ('root_uuid', None),
                     ('transaction', 'mx-k8s-../other'), ('entries', []), ('phase', 'ready')]
        for key, value in mutations:
            fixture = Fixture()
            fixture.record[key] = value
            with self.assertRaises(guard.StorageError):
                fixture.verify()
        for key, value in [('logical', '/var/lib/docker'), ('target', '/data/docker'),
                           ('target_fsroot', '/wrong'), ('target_identity', {'device': 7, 'inode': True})]:
            fixture = Fixture()
            fixture.record['entries'][0][key] = value
            with self.assertRaises(guard.StorageError):
                fixture.verify()

    def test_root_filesystem_cannot_change(self):
        for key, value in [('uuid', 'wrong'), ('target', '/other'), ('fsroot', '/other')]:
            fixture = Fixture()
            fixture.mounts['/'][key] = value
            with self.assertRaises(guard.StorageError):
                fixture.verify()

    def test_guard_cli_has_sanitized_errors_only(self):
        stderr = io.StringIO()
        with mock.patch.object(guard.sys, 'platform', 'linux'), mock.patch.object(guard.os, 'geteuid', return_value=0), \
                mock.patch.object(guard.sys, 'argv', ['storage_guard.py']), \
                mock.patch.object(guard, 'verify', side_effect=KeyError('secret-config-value')), contextlib.redirect_stderr(stderr):
            self.assertEqual(guard.main(), 1)
        self.assertNotIn('secret-config-value', stderr.getvalue())
        self.assertIn('no empty-directory fallback', stderr.getvalue())

    def test_path_protection_allows_application_leaf_but_not_untrusted_ancestors(self):
        leaf = '/data/mx-pay/mx-pay/postgres'
        values = {'/': info(), '/data': info(uid=1000), '/data/mx-pay': info(),
                  '/data/mx-pay/mx-pay': info(), leaf: info(mode=0o2770, uid=999)}
        with mock.patch.object(guard.Path, 'lstat', lambda path: values[str(path)]):
            self.assertEqual(guard.path_info(leaf, data_leaf=True).st_uid, 999)
            with self.assertRaises(guard.StorageError):
                guard.path_info(leaf)
            values['/data/mx-pay'] = info(mode=0o777)
            with self.assertRaises(guard.StorageError):
                guard.path_info(leaf, data_leaf=True)
            values['/data/mx-pay'] = info(kind=stat.S_IFLNK)
            with self.assertRaises(guard.StorageError):
                guard.path_info(leaf, data_leaf=True)

    def test_findmnt_rejects_remote_readonly_and_ambiguous_mounts(self):
        import json
        value = {'target': '/', 'uuid': UUID, 'fsroot': '/', 'fstype': 'xfs', 'options': 'rw'}
        self.assertEqual(guard.mount('/', lambda args: json.dumps({'filesystems': [value]})), value)
        for changes in ({'fstype': 'nfs'}, {'uuid': None}, {'options': 'ro'}, {'fsroot': '../bad'}):
            with self.assertRaises(guard.StorageError):
                guard.mount('/', lambda args: json.dumps({'filesystems': [dict(value, **changes)]}))
        for mounts in ([], [value, value]):
            with self.assertRaises(guard.StorageError):
                guard.mount('/', lambda args: json.dumps({'filesystems': mounts}))


if __name__ == '__main__':
    unittest.main()
