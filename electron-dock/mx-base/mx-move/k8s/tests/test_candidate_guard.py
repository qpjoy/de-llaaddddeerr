"""Candidate startup guard: protected-file and service fixtures, no host writes."""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import candidate_guard as guard
finally:
    sys.path.pop(0)

PREPARED = '/var/lib/mx-move/k8s-runtime-prep/mx-k8s-20261020-010000-1234abcd'
ROOT = PREPARED + '/data'
UUID = 'ea7e456d-19db-4f6e-b8b0-02c00f59d066'
SECRET = 'never-print-candidate-secret'


def info(kind=stat.S_IFREG, mode=0o600, uid=0, device=7, inode=99):
    return SimpleNamespace(st_mode=kind | mode, st_uid=uid, st_dev=device, st_ino=inode)


class Host:
    def __init__(self):
        self.record = {'schema_version': 1, 'phase': 'starting', 'hostname': 'fixture-host',
            'service': guard.SERVICE, 'state': guard.STATE, 'address': guard.ADDRESS,
            'prepared_directory': PREPARED, 'root': ROOT,
            'root_identity': {'device': 7, 'inode': 99}, 'filesystem_uuid': UUID}
        paths = {'config': PREPARED + '/containerd.toml', 'environment': guard.ENVIRONMENT,
                 'unit': guard.UNIT, 'binary': '/usr/bin/containerd', 'guard': guard.GUARD}
        self.files = {}
        self.metadata = {guard.RECORD: info(), ROOT: info(stat.S_IFDIR, 0o700)}
        for key, path in paths.items():
            self.record[key + '_path'] = path
            raw = (key + '\n' + SECRET + '\n').encode()
            self.files[path] = raw
            self.record[key + '_sha256'] = hashlib.sha256(raw).hexdigest()
            self.metadata[path] = info(mode=0o600 if key in ('config', 'environment') else 0o755 if key == 'binary' else 0o644)
        self.record_raw = None
        self.mounts = {path: {'filesystems': [{'target': '/', 'fstype': 'xfs', 'uuid': UUID, 'options': 'rw,relatime'}]}
                       for path in (ROOT, '/')}
        self.unit = 'FragmentPath=' + guard.UNIT + '\nDropInPaths=\nNeedDaemonReload=no\n'
        self.state_exists = False
        self.commands = []

    def lstat(self, path):
        value = self.metadata.get(path, info(stat.S_IFDIR, 0o755))
        if isinstance(value, Exception):
            raise value
        return value

    def open(self, path, mode='r'):
        raw = self.files.get(path)
        if path == guard.RECORD:
            raw = self.record_raw if self.record_raw is not None else json.dumps(self.record).encode()
        if raw is None:
            raise FileNotFoundError(path)
        return io.BytesIO(raw) if 'b' in mode else io.StringIO(raw.decode())

    def run(self, args):
        self.commands.append(args)
        if args[0] == 'findmnt':
            result = self.mounts[args[args.index('--target') + 1]]
            return json.dumps(result) if not isinstance(result, str) else result
        if args[:3] == ['systemctl', 'show', guard.SERVICE]:
            return self.unit
        raise AssertionError('unexpected command')

    @contextlib.contextmanager
    def installed(self):
        host = self
        with mock.patch.object(guard.Path, 'lstat', lambda path: host.lstat(str(path))), \
                mock.patch('builtins.open', side_effect=self.open), \
                mock.patch.object(guard.socket, 'gethostname', return_value='fixture-host'), \
                mock.patch.object(guard, 'run', side_effect=self.run), \
                mock.patch.object(guard.os.path, 'lexists', return_value=self.state_exists):
            yield

    def verify(self):
        with self.installed():
            return guard.verify()


class CandidateGuardTests(unittest.TestCase):
    def test_only_starting_importing_ready_phases_can_start(self):
        for phase in ('allocating', 'starting', 'importing', 'ready', 'active', 'failed'):
            with self.subTest(phase=phase):
                host = Host()
                host.record['phase'] = phase
                if phase in ('starting', 'importing', 'ready'):
                    self.assertEqual(host.verify(), host.record)
                    self.assertTrue(all(command[0] == 'findmnt' or command[:2] == ['systemctl', 'show']
                                        for command in host.commands))
                else:
                    with self.assertRaises(guard.GuardError):
                        host.verify()
                    self.assertFalse(host.commands)

    def test_schema_and_node_paths_are_pinned(self):
        changes = [('schema_version', True), ('schema_version', 1.0), ('hostname', 'other-host'),
                   ('service', 'containerd.service'), ('state', '/run/containerd'),
                   ('address', '/run/containerd/containerd.sock'), ('prepared_directory', '/data/prepared'),
                   ('root', PREPARED + '/empty'), ('config_path', '/etc/containerd/config.toml'),
                   ('environment_path', '/etc/other.env'), ('unit_path', '/etc/systemd/system/containerd.service'),
                   ('guard_path', '/tmp/guard.py'), ('filesystem_uuid', None)]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                host = Host()
                host.record[key] = value
                with self.assertRaises(guard.GuardError):
                    host.verify()

    def test_missing_or_replaced_runtime_directory_never_starts_an_empty_store(self):
        for metadata in (FileNotFoundError(SECRET), info(stat.S_IFDIR, 0o700, device=8),
                         info(stat.S_IFDIR, 0o700, inode=100), info(stat.S_IFLNK, 0o777),
                         info(stat.S_IFDIR, 0o700, uid=1000), info(stat.S_IFDIR, 0o755)):
            host = Host()
            host.metadata[ROOT] = metadata
            with self.assertRaises((guard.GuardError, OSError)):
                host.verify()
        for identity in ({'device': True, 'inode': 99}, {'device': 7, 'inode': True},
                         {'device': 7, 'inode': 0}, {'device': 7, 'inode': 99, 'ignored': 1}):
            host = Host()
            host.record['root_identity'] = identity
            with self.assertRaises(guard.GuardError):
                host.verify()

    def test_record_config_and_environment_are_private_and_all_ancestors_protected(self):
        changes = [(guard.RECORD, info(mode=0o644)),
                   (PREPARED + '/containerd.toml', info(mode=0o640)),
                   (guard.ENVIRONMENT, info(mode=0o644)),
                   (guard.UNIT, info(mode=0o664)),
                   (guard.GUARD, info(mode=0o644, uid=1000)),
                   ('/usr/bin/containerd', info(stat.S_IFLNK, 0o777)),
                   ('/etc/mx-k8s-runtime', info(stat.S_IFDIR, 0o777)),
                   ('/var/lib/mx-move', info(stat.S_IFLNK, 0o777))]
        for path, metadata in changes:
            with self.subTest(path=path):
                host = Host()
                host.metadata[path] = metadata
                with self.assertRaises(guard.GuardError):
                    host.verify()

    def test_every_copied_file_and_the_binary_are_checksum_pinned(self):
        for key in ('config', 'environment', 'unit', 'binary', 'guard'):
            with self.subTest(key=key):
                host = Host()
                host.files[host.record[key + '_path']] += b'changed'
                with self.assertRaises(guard.GuardError):
                    host.verify()
                host = Host()
                host.record[key + '_sha256'] = 'not-a-checksum'
                with self.assertRaises(guard.GuardError):
                    host.verify()

    def test_both_runtime_and_root_mount_uuid_and_rw_filesystem_are_required(self):
        for path in (ROOT, '/'):
            for key, value in [('uuid', 'another-disk'), ('uuid', None), ('fstype', 'nfs'),
                               ('options', 'ro,relatime'), ('options', None), ('options', ['rw'])]:
                with self.subTest(path=path, key=key, value=value):
                    host = Host()
                    host.mounts[path]['filesystems'][0][key] = value
                    with self.assertRaises(guard.GuardError):
                        host.verify()
        for value in ([], {}, [None], [copy.deepcopy(Host().mounts[ROOT]['filesystems'][0])] * 2):
            host = Host()
            host.mounts[ROOT]['filesystems'] = value
            with self.assertRaises(guard.GuardError):
                host.verify()

    def test_existing_state_directory_is_checked_but_first_start_may_create_it(self):
        self.assertEqual(Host().verify()['phase'], 'starting')
        host = Host()
        host.state_exists = True
        host.metadata[guard.STATE] = info(stat.S_IFDIR, 0o700)
        self.assertEqual(host.verify()['phase'], 'starting')
        for metadata in (info(stat.S_IFDIR, 0o777), info(stat.S_IFLNK, 0o777), info(stat.S_IFDIR, 0o700, uid=1000)):
            host.metadata[guard.STATE] = metadata
            with self.assertRaises(guard.GuardError):
                host.verify()

    def test_loaded_unit_rejects_dropins_stale_reload_other_fragment_or_duplicate_properties(self):
        changes = [
            'FragmentPath=' + guard.UNIT + '\nDropInPaths=/etc/systemd/system/mx-k8s-containerd.service.d/override.conf\nNeedDaemonReload=no\n',
            'FragmentPath=' + guard.UNIT + '\nDropInPaths=\nNeedDaemonReload=yes\n',
            'FragmentPath=/run/systemd/system/mx-k8s-containerd.service\nDropInPaths=\nNeedDaemonReload=no\n',
            'FragmentPath=' + guard.UNIT + '\nDropInPaths=/tmp/override.conf\nDropInPaths=\nNeedDaemonReload=no\n',
            'FragmentPath=' + guard.UNIT + '\nDropInPaths=\n',
        ]
        for value in changes:
            host = Host()
            host.unit = value
            with self.assertRaises(guard.GuardError):
                host.verify()

    def test_duplicate_record_and_mount_keys_are_rejected(self):
        host = Host()
        host.record_raw = b'{"phase":"allocating","phase":"ready"}'
        with self.assertRaises(guard.GuardError):
            host.verify()
        host = Host()
        host.mounts[ROOT] = '{"filesystems":[],"filesystems":' + json.dumps(host.mounts[ROOT]['filesystems']) + '}'
        with self.assertRaises(guard.GuardError):
            host.verify()

    def test_unsafe_path_values_fail_without_stat_or_read(self):
        for path in ('/', '//etc/secret', '/etc/../etc/secret', '/etc/secret\n', '/etc/secret\0', 'relative', None):
            with self.subTest(path=path), mock.patch.object(guard.Path, 'lstat') as lstat:
                with self.assertRaises(guard.GuardError):
                    guard.safe(path)
                lstat.assert_not_called()

    def test_main_suppresses_private_values_and_tracebacks_for_malformed_json_and_unexpected_errors(self):
        for raw in (('{"secret":"' + SECRET).encode(), b'[]', b'null', b'{"schema_version":1}', b'\xff'):
            host = Host()
            host.record_raw = raw
            out, err = io.StringIO(), io.StringIO()
            with host.installed(), mock.patch.object(guard.sys, 'platform', 'linux'), \
                    mock.patch.object(guard.os, 'geteuid', return_value=0), \
                    mock.patch.object(guard.sys, 'argv', ['candidate_guard.py']), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(guard.main(), 1)
            self.assertEqual(out.getvalue(), '')
            self.assertNotIn(SECRET, err.getvalue())
            self.assertNotIn('Traceback', err.getvalue())
            self.assertIn('no fallback runtime', err.getvalue())
        for error in (AttributeError(SECRET), RecursionError(SECRET), OSError(SECRET)):
            with mock.patch.object(guard.sys, 'platform', 'linux'), \
                    mock.patch.object(guard.os, 'geteuid', return_value=0), \
                    mock.patch.object(guard.sys, 'argv', ['candidate_guard.py']), \
                    mock.patch.object(guard, 'verify', side_effect=error), \
                    contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(guard.main(), 1)
                self.assertNotIn(SECRET, err.getvalue())
                self.assertNotIn('Traceback', err.getvalue())

    def test_main_rejects_nonroot_nonlinux_and_arguments_before_any_checks(self):
        for platform, uid, argv in [('darwin', 0, ['guard.py']), ('linux', 1000, ['guard.py']), ('linux', 0, ['guard.py', 'extra'])]:
            with mock.patch.object(guard.sys, 'platform', platform), mock.patch.object(guard.os, 'geteuid', return_value=uid), \
                    mock.patch.object(guard.sys, 'argv', argv), mock.patch.object(guard, 'verify') as verify, \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(guard.main(), 1)
                verify.assert_not_called()

    def test_command_failures_hide_stderr_and_commands_have_bounded_read_only_execution(self):
        with mock.patch.object(guard.subprocess, 'run') as run:
            run.return_value = SimpleNamespace(returncode=0, stdout=b'ok', stderr=SECRET.encode())
            self.assertEqual(guard.run(['systemctl', 'show', guard.SERVICE]), 'ok')
            self.assertEqual(run.call_args.kwargs['timeout'], 30)
            self.assertEqual(run.call_args.kwargs['stderr'], guard.subprocess.PIPE)
            self.assertNotIn('shell', run.call_args.kwargs)
            for result in [SimpleNamespace(returncode=1, stdout=SECRET.encode(), stderr=SECRET.encode()),
                           SimpleNamespace(returncode=0, stdout=b'\xff', stderr=SECRET.encode())]:
                run.return_value = result
                with self.assertRaises(guard.GuardError) as caught:
                    guard.run(['findmnt', '--json'])
                self.assertNotIn(SECRET, str(caught.exception))
            for error in [OSError(SECRET), guard.subprocess.TimeoutExpired('findmnt', 30, output=SECRET, stderr=SECRET)]:
                run.side_effect = error
                with self.assertRaises(guard.GuardError) as caught:
                    guard.run(['findmnt', '--json'])
                self.assertNotIn(SECRET, str(caught.exception))


if __name__ == '__main__':
    unittest.main()
