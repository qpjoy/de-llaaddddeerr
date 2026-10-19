"""Storage primitive fixtures never mount, stop services or use production files."""
import base64
import contextlib
import copy
import hashlib
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
import storage_ops as ops

ROOT_UUID = 'ea7e456d-19db-4f6e-b8b0-02c00f59d066'
SOURCE_UUID = '45fa3b72-5a59-4d3c-9a57-4f61aee13e5e'
TRANSACTION = 'mx-k8s-20261020-010000-1234abcd'
FSTAB = b'''UUID=abc / xfs defaults 0 0
/data/mx-runtime/containerd /var/lib/containerd none bind 0 0
/data/mx-runtime/kubelet /var/lib/kubelet none bind 0 0 # retain comment
/data/k8s/mx-runtime/mx-launcher /var/lib/mx-launcher none bind 0 0
nas:/volume /mnt/nas nfs rw,_netdev,hard 0 0
'''


def mount(target, uuid, fsroot='/'):
    return {'target': target, 'uuid': uuid, 'fsroot': fsroot, 'fstype': 'xfs', 'source': '/dev/fixture', 'options': 'rw'}


def entry(key):
    logical = ops.ROOTS[key]
    source = {'kubelet': '/data/mx-runtime/kubelet', 'launcher': '/data/k8s/mx-runtime/mx-launcher'}.get(key, logical)
    target = ops.guard.DATA_BASE + '/' + TRANSACTION + '/' + key
    value = {'key': key, 'logical': logical, 'source': source, 'source_bind': source != logical,
             'source_identity': {'device': 2, 'inode': 20}, 'target_identity': {'device': 1, 'inode': 30},
             'source_mount': ops.mount_identity(mount(logical if source != logical else '/data', SOURCE_UUID,
                                                     source[len('/data'):] if source != logical else '/')),
             'target': target, 'target_fsroot': target, 'target_uuid': ROOT_UUID, 'copied': True,
             'kubelet_children': []}
    if key in ops.guard.PG_PATHS:
        value['postgres'] = {'version': '16', 'control_first8_hex': '0123456789abcdef'}
    return value


def snapshot():
    return {'schema_version': 1, 'transaction': TRANSACTION, 'root_uuid': ROOT_UUID, 'source_uuid': SOURCE_UUID,
            'hostname': 'fixture', 'entries': [entry(key) for key in ops.ROOTS],
            'fstab_before_base64': base64.b64encode(FSTAB).decode(), 'fstab_before_sha256': ops.sha(FSTAB)}


class Host:
    def __init__(self, item):
        self.entry = item
        self.current = dict(item['source_mount'], source='/dev/fixture', options='rw')
        self.current_identity = item['source_identity']
        self.nested = []
        self.commands = []
        self.changed = False

    def mount(self, path):
        if path == self.entry['logical']:
            return self.current
        return mount('/', ROOT_UUID) if str(path).startswith('/var/lib/mx-move') else mount('/data', SOURCE_UUID)

    def mounts(self):
        return [self.current] + self.nested

    def identity(self, path):
        if path == self.entry['logical']:
            return self.current_identity
        return self.entry['target_identity'] if path == self.entry['target'] else self.entry['source_identity']

    @contextlib.contextmanager
    def pin(self, path, expected):
        assert self.identity(path) == expected
        yield '/proc/999/fd/' + ('target' if path == self.entry['target'] else 'source')

    def run(self, args, timeout=30):
        self.commands.append(args)
        if args[:2] == ['umount', '--']:
            if args[2] != self.entry['logical']:
                self.nested = [m for m in self.nested if m['target'] != args[2]]
            elif self.entry['source_bind']:
                self.current = mount('/', ROOT_UUID)
                self.current_identity = {'device': 1, 'inode': 10}
            else:
                self.current = mount('/data', SOURCE_UUID)
                self.current_identity = self.entry['source_identity']
        elif args[:2] == ['mount', '--bind']:
            if args[2].endswith('target'):
                self.current = mount(self.entry['logical'], ROOT_UUID, self.entry['target'])
                self.current_identity = self.entry['target_identity']
            else:
                self.current = dict(self.entry['source_mount'], source='/dev/fixture', options='rw')
                self.current_identity = self.entry['source_identity']
        return b''


class FstabTests(unittest.TestCase):
    def test_preserves_other_services_and_updates_exact_five_roots(self):
        updated = ops.fstab_after(FSTAB, snapshot()['entries'])
        self.assertIn(b'/data/mx-runtime/containerd /var/lib/containerd none bind 0 0\n', updated)
        self.assertIn(b'nas:/volume /mnt/nas nfs rw,_netdev,hard 0 0\n', updated)
        self.assertIn(b' # retain comment\n', updated)
        rows = ops.parse_fstab(updated)
        self.assertEqual(len(rows), 5)
        for item in snapshot()['entries']:
            self.assertEqual(rows[item['logical']][1][0], item['target'])

    def test_rejects_duplicate_missing_or_changed_existing_bind(self):
        for raw in (FSTAB + b'/bad /var/lib/kubelet none bind 0 0\n',
                    FSTAB.replace(b'/data/mx-runtime/kubelet', b'/elsewhere'),
                    FSTAB.replace(b'none bind', b'none bind,nofail'),
                    FSTAB.replace(b'none bind', b'none rbind'),
                    FSTAB.replace(b'none bind', b'ext4 defaults')):
            with self.assertRaises(ops.StorageError):
                ops.fstab_after(raw, snapshot()['entries'])

    def test_additions_get_newline_when_original_lacks_final_newline(self):
        self.assertIn(b'hard 0 0\n/var/lib/mx-move/', ops.fstab_after(FSTAB.rstrip(), snapshot()['entries']))

    def test_guard_starts_blocked_and_has_only_required_fields(self):
        record = ops.guard_record(snapshot())
        self.assertEqual(record['phase'], 'blocked')
        self.assertNotIn('source', record['entries'][0])
        self.assertEqual(ops.guard_record(snapshot(), 'active')['phase'], 'active')
        with self.assertRaises(ops.StorageError):
            ops.guard_record(snapshot(), 'starting')

    def test_fstab_install_and_rollback_require_exact_transaction_bytes(self):
        data = snapshot()
        updated = ops.fstab_after(FSTAB, data['entries'])
        for current, after, desired in [(FSTAB, True, updated), (updated, False, FSTAB), (updated, True, updated)]:
            host = mock.Mock(spec=ops.Host)
            with mock.patch.object(ops.Path, 'read_bytes', return_value=current), mock.patch.object(ops, 'atomic') as replace, \
                    mock.patch.object(ops.Storage, 'verify_mount_units') as units:
                ops.Storage(host).install_fstab(data, after)
            if current != desired:
                replace.assert_called_once_with(ops.FSTAB, desired, current)
            else:
                replace.assert_not_called()
            host.run.assert_called_once_with(['systemctl', 'daemon-reload'])
            units.assert_called_once_with(desired)
        with mock.patch.object(ops.Path, 'read_bytes', return_value=FSTAB + b'# admin edit\n'), \
                mock.patch.object(ops, 'atomic') as replace, self.assertRaises(ops.StorageError):
            ops.Storage(mock.Mock(spec=ops.Host)).install_fstab(data)
        replace.assert_not_called()

    def test_dropin_does_not_reset_existing_etcd_guard(self):
        value = ops.guard_dropin('/usr/bin/python3').decode()
        self.assertEqual(value.count('ExecStartPre='), 1)
        self.assertNotIn('ExecStartPre=\n', value)
        self.assertIn('RequiresMountsFor=' + ' '.join(ops.ROOTS.values()), value)
        with self.assertRaises(ops.StorageError):
            ops.guard_dropin('/usr/bin/python3 --unsafe')


class SwitchTests(unittest.TestCase):
    def stopped(self):
        pass

    def test_switch_and_restore_all_five_roots_preserve_source(self):
        for key in ops.ROOTS:
            with self.subTest(key=key):
                item = entry(key)
                host = Host(item)
                storage = ops.Storage(host)
                with mock.patch.object(ops.guard, 'path_info'):
                    storage.switch(item, self.stopped, ROOT_UUID)
                    self.assertEqual(host.current_identity, item['target_identity'])
                    storage.switch(item, self.stopped, ROOT_UUID)
                    storage.restore(item, self.stopped, ROOT_UUID)
                    self.assertEqual(host.current_identity, item['source_identity'])
                    storage.restore(item, self.stopped, ROOT_UUID)
                self.assertEqual(sum(c[:2] == ['mount', '--bind'] for c in host.commands), 2 if item['source_bind'] else 1)
                self.assertFalse(any('rm' in c or '--lazy' in c or '--force' in c for c in host.commands))

    def test_resume_after_original_bind_unmounted(self):
        for operation in ('switch', 'restore'):
            item = entry('kubelet')
            host = Host(item)
            host.current, host.current_identity = mount('/', ROOT_UUID), {'device': 1, 'inode': 10}
            with mock.patch.object(ops.guard, 'path_info'):
                getattr(ops.Storage(host), operation)(item, self.stopped, ROOT_UUID)
            self.assertEqual(host.current_identity, item['target_identity' if operation == 'switch' else 'source_identity'])

    def test_wrong_bind_is_never_unmounted(self):
        for operation in ('switch', 'restore'):
            item = entry('launcher')
            host = Host(item)
            host.current = mount(item['logical'], ROOT_UUID, '/wrong')
            with self.assertRaises(ops.StorageError):
                getattr(ops.Storage(host), operation)(item, self.stopped, ROOT_UUID)
            self.assertFalse(host.commands)

    def test_running_writers_prevent_every_mount_change(self):
        def running():
            raise RuntimeError('writers active')
        for operation in ('switch', 'restore'):
            item = entry('launcher')
            host = Host(item)
            with self.assertRaises(RuntimeError):
                getattr(ops.Storage(host), operation)(item, running, ROOT_UUID)
            self.assertFalse(host.commands)

    def test_checksum_verification_flag_is_required_before_switch(self):
        item = entry('rig')
        del item['copied']
        host = Host(item)
        with self.assertRaises(ops.StorageError):
            ops.Storage(host).switch(item, self.stopped, ROOT_UUID)
        self.assertFalse(host.commands)

    def test_foreign_submount_blocks_switch(self):
        item = entry('common')
        host = Host(item)
        host.nested = [mount(item['logical'] + '/postgres', SOURCE_UUID)]
        with self.assertRaises(ops.StorageError):
            ops.Storage(host).switch(item, self.stopped, ROOT_UUID)
        self.assertFalse(host.commands)


class KubeletUnmountTests(unittest.TestCase):
    def child(self):
        return {'target': '/var/lib/kubelet/pods/97643e51-8ea8-4a98-8d9b-c7eb55fa6e1c/volumes/kubernetes.io~projected/kube-api-access-test',
                'fstype': 'tmpfs', 'source': 'tmpfs', 'fsroot': '/', 'uuid': None, 'options': 'rw'}

    def test_unmounts_only_exact_recorded_tmpfs_mount(self):
        data = snapshot()
        item = data['entries'][0]
        child = self.child()
        item['kubelet_children'] = [child]
        host = Host(item)
        host.nested = [child]
        stopped = mock.Mock()
        ops.Storage(host).unmount_kubelet_children(data, stopped)
        self.assertEqual(host.commands, [['umount', '--', child['target']]])
        stopped.assert_called_once_with()

    def test_remote_bind_emptydir_unknown_volume_and_changed_mount_refused(self):
        for field, value in [('fstype', 'nfs'), ('source', '/data/pg'), ('fsroot', '/another'),
                             ('target', self.child()['target'].replace('projected', 'empty-dir')),
                             ('target', '/mnt/nas')]:
            child = self.child()
            child[field] = value
            with self.assertRaises(ops.StorageError):
                ops.Storage.check_kubelet_child(child)
        data = snapshot()
        item = data['entries'][0]
        item['kubelet_children'] = [self.child()]
        host = Host(item)
        host.nested = [dict(self.child(), options='ro')]
        with self.assertRaises(ops.StorageError):
            ops.Storage(host).unmount_kubelet_children(data, lambda: None)
        self.assertFalse(host.commands)

    def test_already_removed_children_are_idempotent(self):
        data = snapshot()
        item = data['entries'][0]
        item['kubelet_children'] = [self.child()]
        host = Host(item)
        ops.Storage(host).unmount_kubelet_children(data, lambda: None)
        self.assertFalse(host.commands)

class ColdCopyTests(unittest.TestCase):
    def fixture(self, directory):
        item = entry('kubelet')
        item.pop('target_identity')
        item.pop('copied')
        item['target'] = str(Path(directory) / 'kubelet')
        item['target_fsroot'] = item['target']
        host = mock.Mock(spec=ops.Host)
        host.mount.return_value = mount('/', ROOT_UUID)
        host.identity.return_value = {'device': 1, 'inode': 1234}
        @contextlib.contextmanager
        def pin(path, expected):
            yield '/fixture/source' if path == item['source'] else '/fixture/destination'
        host.pin.side_effect = pin
        host.run.side_effect = lambda args, **kwargs: b'4096\t/fixture/source\n' if args[0] == 'du' else b''
        storage = ops.Storage(host)
        storage.validate_source = mock.Mock()
        storage.no_children = mock.Mock()
        return item, host, storage

    def test_cold_copy_journals_identity_before_rsync_checksums_and_syncs(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            item, host, storage = self.fixture(directory)
            saved = []
            def persist(value):
                saved.append(copy.deepcopy(value))
                if len(saved) == 1:
                    self.assertFalse(host.run.called)
            with mock.patch.object(ops.guard, 'path_info'):
                storage.cold_copy(item, lambda: None, persist)
            commands = [call.args[0] for call in host.run.call_args_list]
            self.assertEqual(commands[0][:4], ['du', '-sHx', '--apparent-size', '--block-size=1'])
            self.assertEqual(commands[1][:3], ['rsync', '-aHAXx', '--numeric-ids'])
            self.assertEqual(commands[2][:4], ['rsync', '-aHAXxnci', '--delete', '--numeric-ids'])
            self.assertEqual(commands[3], ['sync', '-f', '/fixture/destination'])
            self.assertIn('target_identity', saved[0])
            self.assertNotIn('copied', saved[0])
            self.assertTrue(saved[-1]['copied'])
            self.assertEqual(host.capacity.call_args_list[0].args[1], 4096)

    def test_checksum_mismatch_never_sets_copied_or_syncs(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            item, host, storage = self.fixture(directory)
            host.run.side_effect = lambda args, **kwargs: (b'4096\t/source\n' if args[0] == 'du' else
                                                           b'>fcs.... private-name\n' if '--delete' in args else b'')
            with mock.patch.object(ops.guard, 'path_info'), self.assertRaises(ops.StorageError):
                storage.cold_copy(item, lambda: None, lambda entry: None)
            self.assertNotIn('copied', item)
            self.assertFalse(any(call.args[0][0] == 'sync' for call in host.run.call_args_list))

    def test_journal_write_failure_prevents_copy(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            item, host, storage = self.fixture(directory)
            def fail(value):
                raise OSError('disk-full')
            with mock.patch.object(ops.guard, 'path_info'), self.assertRaises(OSError):
                storage.cold_copy(item, lambda: None, fail)
            self.assertFalse(host.run.called)

    def test_existing_unrecorded_target_is_never_adopted(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            item, host, storage = self.fixture(directory)
            Path(item['target']).mkdir()
            with mock.patch.object(ops.guard, 'path_info'), self.assertRaises(ops.StorageError):
                storage.cold_copy(item, lambda: None, lambda entry: None)
            self.assertFalse(host.run.called)

    def test_wrong_uuid_and_previously_completed_copy_are_refused(self):
        import tempfile
        for complete in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                item, host, storage = self.fixture(directory)
                if complete:
                    item['copied'] = True
                else:
                    host.mount.return_value = mount('/', SOURCE_UUID)
                with mock.patch.object(ops.guard, 'path_info'), self.assertRaises(ops.StorageError):
                    storage.cold_copy(item, lambda: None, lambda entry: None)
                self.assertFalse(host.run.called)

class SnapshotTests(unittest.TestCase):
    def fixture(self):
        roots = [mount('/', ROOT_UUID), mount('/data', SOURCE_UUID),
                 mount('/var/lib/containerd', SOURCE_UUID, '/mx-runtime/containerd'),
                 mount('/var/lib/etcd', ROOT_UUID, '/var/lib/mx-move/etcd-data/existing'),
                 {'target': '/mnt/nas', 'uuid': None, 'fstype': 'nfs', 'fsroot': '/', 'source': 'nas:/volume', 'options': 'rw'}]
        expected = snapshot()['entries']
        for item in expected:
            if item['source_bind']:
                roots.append(dict(item['source_mount'], source='/dev/fixture', options='rw'))
        host = mock.Mock(spec=ops.Host)
        host.mounts.return_value = roots
        host.mount.side_effect = lambda path: max((m for m in roots if ops.within(str(path), m['target'])), key=lambda m: len(m['target']))
        host.identity.return_value = {'device': 2, 'inode': 20}
        return host, roots

    @contextlib.contextmanager
    def files(self):
        with mock.patch.object(ops.guard, 'path_info'), mock.patch.object(ops.Path, 'read_bytes', return_value=FSTAB), \
                mock.patch.object(ops.os.path, 'lexists', return_value=True), \
                mock.patch.object(ops.guard, 'pg_identity', return_value={'version': '16', 'control_first8_hex': '0123456789abcdef'}), \
                mock.patch.object(ops.Storage, 'verify_mount_units'):

            yield

    def test_fixed_roots_exclude_existing_docker_runtime_etcd_and_nas(self):
        host, mounts = self.fixture()
        with self.files():
            result = ops.Storage(host).snapshot(TRANSACTION, ROOT_UUID, SOURCE_UUID)
        self.assertEqual([e['logical'] for e in result['entries']], list(ops.ROOTS.values()))
        self.assertEqual(result['fstab_before_sha256'], hashlib.sha256(FSTAB).hexdigest())
        self.assertTrue(all(e['target_uuid'] == ROOT_UUID for e in result['entries']))
        self.assertTrue(all(e['source'].startswith('/data/') for e in result['entries']))

    def test_nested_remote_mount_and_source_filesystem_change_are_rejected(self):
        for mutation in ('nested', 'uuid'):
            host, mounts = self.fixture()
            if mutation == 'nested':
                mounts.append({'target': ops.ROOTS['common'] + '/remote', 'uuid': None, 'fstype': 'nfs', 'fsroot': '/', 'source': 'nas:/x'})
            else:
                mounts[1]['uuid'] = 'wrong-source'
            with self.files(), self.assertRaises(ops.StorageError):
                ops.Storage(host).snapshot(TRANSACTION, ROOT_UUID, SOURCE_UUID)

    def test_protected_docker_root_aliasing_selected_tree_is_rejected(self):
        host, mounts = self.fixture()
        # An alternate path on the same filesystem aliases the common root.
        mounts.append(mount('/var/lib/docker', SOURCE_UUID, '/k8s/mx-runtime/mx-common/k8s'))
        with self.files(), self.assertRaises(ops.StorageError):
            ops.Storage(host).snapshot(TRANSACTION, ROOT_UUID, SOURCE_UUID)

    def test_wrong_original_bind_layout_is_rejected(self):
        host, mounts = self.fixture()
        mounts[:] = [m for m in mounts if m['target'] != '/var/lib/kubelet']
        with self.files(), self.assertRaises(ops.StorageError):
            ops.Storage(host).snapshot(TRANSACTION, ROOT_UUID, SOURCE_UUID)

class MountUnitTests(unittest.TestCase):
    def fixture(self, raw=FSTAB):
        rows = ops.parse_fstab(raw)
        host = mock.Mock(spec=ops.Host)
        values, files = {}, {}
        for logical in ops.ROOTS.values():
            unit = ops.mount_unit_name(logical)
            if logical in rows:
                fragment = '/run/systemd/generator/' + unit
                source = rows[logical][1][0]
                fields = {'LoadState': 'loaded', 'FragmentPath': fragment, 'SourcePath': '/etc/fstab',
                          'DropInPaths': '', 'NeedDaemonReload': 'no'}
                files[fragment] = ('# Automatically generated\n[Unit]\nSourcePath=/etc/fstab\n[Mount]\n'
                                   'What={}\nWhere={}\nOptions=bind\n').format(source, logical).encode()
            else:
                fields = {'LoadState': 'not-found', 'FragmentPath': '', 'SourcePath': '',
                          'DropInPaths': '', 'NeedDaemonReload': 'no'}
            values[unit] = fields
        def run(args, **kwargs):
            return ''.join('{}={}\n'.format(k, v) for k, v in values[args[-1]].items()).encode()
        host.run.side_effect = run
        return host, values, files

    @contextlib.contextmanager
    def files(self, files, existing=(), overrides=None):
        # Keep the real path validator: bypassing it hid the escaped systemd
        # filename being rejected by the stricter data-directory rules.
        metadata = {}
        for file in files:
            metadata[file] = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0)
            for parent in Path(file).parents:
                metadata[str(parent)] = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        metadata.update(overrides or {})
        with mock.patch.object(ops.os.path, 'lexists', side_effect=lambda p: p in existing), \
                mock.patch.object(ops.Path, 'lstat', lambda p: metadata[str(p)]), \
                mock.patch.object(ops.Path, 'read_bytes', lambda p: files[str(p)]):
            yield

    def test_generated_before_and_after_layouts_are_accepted(self):
        for raw in (FSTAB, ops.fstab_after(FSTAB, snapshot()['entries'])):
            host, values, files = self.fixture(raw)
            with self.files(files):
                ops.Storage(host).verify_mount_units(raw)
            self.assertEqual(host.run.call_count, 5)
            self.assertTrue(all(call.kwargs['allowed'] == (0, 1, 4) for call in host.run.call_args_list))

    def test_dash_escaping_matches_systemd_path_unit_names(self):
        self.assertEqual(ops.mount_unit_name('/var/lib/kubelet'), 'var-lib-kubelet.mount')
        self.assertEqual(ops.mount_unit_name('/var/lib/mx-launcher'), r'var-lib-mx\x2dlauncher.mount')
        self.assertEqual(ops.mount_unit_name('/data/mx-pay/mx-pay/postgres'), r'data-mx\x2dpay-mx\x2dpay-postgres.mount')
        with self.assertRaises(ops.StorageError):
            ops.mount_unit_name('/var/lib/docker')

    def test_generated_units_and_parents_keep_permission_and_symlink_guards(self):
        fragment = '/run/systemd/generator/' + ops.mount_unit_name('/var/lib/mx-launcher')
        for path in ('/run/systemd/generator', fragment):
            kind = stat.S_IFREG if path == fragment else stat.S_IFDIR
            for mode, uid in ((kind | 0o664, 0), (kind | 0o644, 1000), (stat.S_IFLNK | 0o777, 0)):
                host, values, files = self.fixture()
                changed = {path: SimpleNamespace(st_mode=mode, st_uid=uid)}
                with self.subTest(path=path, mode=mode, uid=uid), self.files(files, overrides=changed):
                    with self.assertRaises(ops.StorageError):
                        ops.Storage(host).verify_mount_units(FSTAB)
        host, values, files = self.fixture()
        changed = {fragment: SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)}
        with self.files(files, overrides=changed), self.assertRaises(ops.StorageError):
            ops.Storage(host).verify_mount_units(FSTAB)

    def test_escaped_unit_names_are_not_accepted_as_data_paths(self):
        with self.assertRaises(ops.StorageError):
            ops.guard.canonical(r'/data/mx\x2drig')

    def test_native_or_masked_unit_and_dropin_are_refused_even_if_not_loaded(self):
        unit = ops.mount_unit_name('/data/mx-rig')
        for name in ('/etc/systemd/system/' + unit, '/run/systemd/system/' + unit + '.d',
                     '/usr/lib/systemd/system/' + unit):
            host, values, files = self.fixture()
            with self.files(files, (name,)), self.assertRaises(ops.StorageError):
                ops.Storage(host).verify_mount_units(FSTAB)

    def test_loaded_properties_reject_overrides_stale_reload_and_dynamic_mounts(self):
        for key, value in [('FragmentPath', '/etc/systemd/system/override.mount'),
                           ('SourcePath', '/run/systemd/transient'), ('LoadState', 'masked'),
                           ('DropInPaths', '/etc/systemd/system/unit.d/custom.conf'), ('NeedDaemonReload', 'yes')]:
            host, values, files = self.fixture()
            values['var-lib-kubelet.mount'][key] = value
            with self.files(files), self.assertRaises(ops.StorageError):
                ops.Storage(host).verify_mount_units(FSTAB)
        host, values, files = self.fixture()
        values[ops.mount_unit_name('/data/mx-rig')]['LoadState'] = 'loaded'
        with self.files(files), self.assertRaises(ops.StorageError):
            ops.Storage(host).verify_mount_units(FSTAB)

    def test_generated_wrong_what_where_source_and_optional_readonly_bind_are_refused(self):
        for old, new in [(b'What=/data/mx-runtime/kubelet', b'What=/data/empty'),
                         (b'Where=/var/lib/kubelet', b'Where=/var/lib/containerd'),
                         (b'SourcePath=/etc/fstab', b'SourcePath=/etc/other'),
                         (b'Options=bind', b'Options=bind,nofail'),
                         (b'Options=bind', b'Options=bind,ro'),
                         (b'Options=bind', b'Options=rbind'),
                         (b'Options=bind', b'Options=bind\nOptions=bind'),
                         (b'Options=bind', b'Options=bind\\\n')]:
            host, values, files = self.fixture()
            name = '/run/systemd/generator/var-lib-kubelet.mount'
            files[name] = files[name].replace(old, new)
            with self.files(files), self.assertRaises(ops.StorageError):
                ops.Storage(host).verify_mount_units(FSTAB)

    def test_missing_or_duplicate_properties_never_count_as_absent_safe_unit(self):
        host, values, files = self.fixture()
        del values['var-lib-kubelet.mount']['DropInPaths']
        with self.files(files), self.assertRaises(ops.StorageError):
            ops.Storage(host).verify_mount_units(FSTAB)
        host, values, files = self.fixture()
        original = host.run.side_effect
        host.run.side_effect = lambda args, **kwargs: original(args, **kwargs) + b'LoadState=loaded\n'
        with self.files(files), self.assertRaises(ops.StorageError):
            ops.Storage(host).verify_mount_units(FSTAB)


if __name__ == '__main__':
    unittest.main()
