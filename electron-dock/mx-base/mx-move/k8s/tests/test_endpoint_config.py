"""Effective kubelet startup and crictl endpoint config; no system changes."""
from contextlib import ExitStack
import copy
import hashlib
import io
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import endpoint_config as config
finally:
    sys.path.pop(0)

FRAGMENT = '/usr/lib/systemd/system/kubelet.service'
DROPIN = '/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf'
FLAGS = '/var/lib/kubelet/kubeadm-flags.env'
OPTIONAL = '/etc/sysconfig/kubelet'
COMMAND = '{ path=/usr/bin/kubelet ; argv[]=/usr/bin/kubelet $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS ; ignore_errors=no ; start_time=[Tue 2026-10-20 00:00:00 UTC] ; stop_time=[n/a] ; pid=123 ; code=(null) ; status=0/0 }'


def metadata(inode=10, device=1, uid=0, mode=0o644, kind=stat.S_IFREG):
    return SimpleNamespace(st_dev=device, st_ino=inode, st_uid=uid, st_gid=0, st_mode=kind | mode)


class Fixture:
    def __init__(self):
        self.values = {'LoadState': 'loaded', 'FragmentPath': FRAGMENT, 'DropInPaths': DROPIN,
                       'EnvironmentFiles': FLAGS + ' (ignore_errors=no) ' + OPTIONAL + ' (ignore_errors=yes)',
                       'Environment': 'KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml',
                       'ExecStart': COMMAND, 'NeedDaemonReload': 'no'}
        self.files = {path: {'sha256': hashlib.sha256(path.encode()).hexdigest(), 'uid': 0, 'gid': 0, 'mode': 0o644}
                      for path in (FRAGMENT, DROPIN, FLAGS, config.EXTRA_DROPIN)}
        self.files[OPTIONAL] = {'missing': True}
        self.commands = []

    def run(self, args):
        self.commands.append(args)
        return ''.join('{}={}\n'.format(key, value) for key, value in self.values.items()).encode()

    def protected(self, path, optional=False):
        self.assert_optional(path, optional)
        return copy.deepcopy(self.files[path])

    @staticmethod
    def assert_optional(path, optional):
        assert optional == (path == OPTIONAL)

    def snapshot(self):
        with mock.patch.object(config, 'protected_file', side_effect=self.protected):
            return config.snapshot(self.run)

    def verify(self, receipt):
        with mock.patch.object(config, 'protected_file', side_effect=self.protected):
            return config.verify(self.run, receipt)


class ReceiptTests(unittest.TestCase):
    def test_snapshot_records_all_files_and_effective_command_without_mutation(self):
        fixture = Fixture()
        receipt = fixture.snapshot()
        self.assertEqual(set(receipt['files']), {FRAGMENT, DROPIN, FLAGS, OPTIONAL})
        self.assertEqual(receipt['files'][OPTIONAL], {'missing': True})
        self.assertEqual(receipt['configuration']['exec_start'], {'path': '/usr/bin/kubelet',
                         'argv': '/usr/bin/kubelet $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS', 'ignore_errors': False})
        self.assertEqual(len(fixture.commands), 2)
        self.assertTrue(all(command[:3] == ['systemctl', 'show', 'kubelet.service'] for command in fixture.commands))

    def test_verify_allows_only_fixed_additional_dropin_and_ignores_reload_pid_time(self):
        fixture = Fixture()
        receipt = fixture.snapshot()
        fixture.values['DropInPaths'] += ' ' + config.EXTRA_DROPIN
        fixture.values['NeedDaemonReload'] = 'yes'
        fixture.values['ExecStart'] = COMMAND.replace('pid=123', 'pid=456').replace('00:00:00', '01:00:00')
        self.assertEqual(fixture.verify(receipt), receipt)
        fixture.values['DropInPaths'] += ' /etc/systemd/system/kubelet.service.d/99-custom.conf'
        with self.assertRaises(config.EndpointError):
            fixture.verify(receipt)

    def test_original_files_environment_and_execstart_configuration_are_exact(self):
        changes = [('Environment', 'KUBELET_CONFIG_ARGS=--config=/etc/other.yaml'),
                   ('ExecStart', COMMAND.replace('/usr/bin/kubelet', '/usr/local/bin/kubelet')),
                   ('DropInPaths', ''), ('FragmentPath', '/etc/systemd/system/kubelet.service'),
                   ('EnvironmentFiles', FLAGS + ' (ignore_errors=yes)')]
        for name, value in changes:
            fixture = Fixture()
            receipt = fixture.snapshot()
            fixture.values[name] = value
            with self.subTest(name=name), self.assertRaises(config.EndpointError):
                fixture.verify(receipt)
        for key, value in [('sha256', 'f' * 64), ('uid', 1000), ('gid', 1000), ('mode', 0o600)]:
            fixture = Fixture()
            receipt = fixture.snapshot()
            fixture.files[FLAGS][key] = value
            with self.subTest(key=key), self.assertRaises(config.EndpointError):
                fixture.verify(receipt)

    def test_optional_environment_file_cannot_appear_or_disappear_unnoticed(self):
        fixture = Fixture()
        receipt = fixture.snapshot()
        fixture.files[OPTIONAL] = copy.deepcopy(fixture.files[FLAGS])
        with self.assertRaises(config.EndpointError):
            fixture.verify(receipt)
        fixture = Fixture()
        fixture.files[OPTIONAL] = copy.deepcopy(fixture.files[FLAGS])
        receipt = fixture.snapshot()
        fixture.files[OPTIONAL] = {'missing': True}
        with self.assertRaises(config.EndpointError):
            fixture.verify(receipt)

    def test_snapshot_rejects_stale_config_existing_migration_or_unsupported_service(self):
        for name, value in [('NeedDaemonReload', 'yes'), ('LoadState', 'not-found'),
                           ('DropInPaths', DROPIN + ' ' + config.EXTRA_DROPIN),
                           ('ExecStart', COMMAND + ' ' + COMMAND)]:
            fixture = Fixture()
            fixture.values[name] = value
            with self.subTest(name=name), self.assertRaises(config.EndpointError):
                fixture.snapshot()

    def test_literal_endpoint_and_root_overrides_in_effective_values_refuse(self):
        for property_name in ('Environment', 'ExecStart'):
            for flag in ('--container-runtime-endpoint=unix:///run/other.sock', '--root-dir=/data/other'):
                fixture = Fixture()
                fixture.values[property_name] += ' ' + flag
                with self.subTest(property=property_name, flag=flag), self.assertRaises(config.EndpointError):
                    fixture.snapshot()

    def test_config_change_during_snapshot_refuses(self):
        fixture = Fixture()
        original = fixture.run
        def changing(args):
            raw = original(args)
            if len(fixture.commands) == 1:
                fixture.values['Environment'] += ' CHANGED=yes'
            return raw
        with mock.patch.object(config, 'protected_file', side_effect=fixture.protected), self.assertRaises(config.EndpointError):
            config.snapshot(changing)

    def test_ambiguous_environment_file_formats_and_duplicate_properties_refuse(self):
        for value in ('/path', '/path (ignore_errors=maybe)', '/path with spaces (ignore_errors=yes)',
                      '/path (ignore_errors=yes) /path (ignore_errors=no)', '/path/../other (ignore_errors=yes)'):
            with self.subTest(value=value), self.assertRaises(config.EndpointError):
                config.environment_files(value)
        fixture = Fixture()
        with self.assertRaises(config.EndpointError):
            config.properties(lambda args: fixture.run(args) + b'Environment=ambiguous\n')


class ProtectedFileTests(unittest.TestCase):
    def fixture(self, stack, raw=b'KUBELET_EXTRA_ARGS=\n', inode=10, device=1):
        info = metadata(inode=inode, device=device)
        def lstat(path):
            return info if str(path) == FLAGS else metadata(kind=stat.S_IFDIR, mode=0o755)
        stack.enter_context(mock.patch.object(config.Path, 'lstat', lstat))
        stack.enter_context(mock.patch.object(config.os, 'open', return_value=7))
        stack.enter_context(mock.patch.object(config.os, 'fstat', return_value=info))
        stack.enter_context(mock.patch.object(config.os, 'fdopen', side_effect=lambda fd, mode: io.BytesIO(raw)))
        stack.enter_context(mock.patch.object(config.os, 'close'))
        return info

    def test_inode_and_device_change_after_copy_do_not_change_file_receipt(self):
        with ExitStack() as stack:
            self.fixture(stack, inode=10, device=1)
            before = config.protected_file(FLAGS)
        with ExitStack() as stack:
            self.fixture(stack, inode=999, device=50)
            after = config.protected_file(FLAGS)
        self.assertEqual(before, after)
        self.assertNotIn('inode', before)
        self.assertNotIn('device', before)

    def test_original_file_literal_overrides_refuse_before_recording_hash(self):
        for raw in (b'KUBELET_EXTRA_ARGS="--root-dir=/data/kubelet"\n',
                    b'ExecStart=/usr/bin/kubelet --container-runtime-endpoint=unix:///run/containerd/containerd.sock\n'):
            with ExitStack() as stack:
                self.fixture(stack, raw)
                with self.assertRaises(config.EndpointError):
                    config.protected_file(FLAGS)

    def test_missing_file_is_allowed_only_with_explicit_ignore_errors(self):
        def lstat(path):
            if str(path) == OPTIONAL:
                raise FileNotFoundError()
            return metadata(kind=stat.S_IFDIR, mode=0o755)
        with mock.patch.object(config.Path, 'lstat', lstat):
            self.assertEqual(config.protected_file(OPTIONAL, optional=True), {'missing': True})
            with self.assertRaises(config.EndpointError):
                config.protected_file(OPTIONAL)

    def test_symlink_writable_file_parent_or_nonroot_owner_refuses(self):
        for name, info in [(FLAGS, metadata(kind=stat.S_IFLNK)), (FLAGS, metadata(mode=0o666)),
                           ('/var/lib/kubelet', metadata(kind=stat.S_IFDIR, mode=0o777)), (FLAGS, metadata(uid=999))]:
            def lstat(path):
                return info if str(path) == name else metadata(kind=stat.S_IFREG if str(path) == FLAGS else stat.S_IFDIR, mode=0o755)
            with mock.patch.object(config.Path, 'lstat', lstat), self.subTest(name=name), self.assertRaises(config.EndpointError):
                config.protected_file(FLAGS)


class CrictlRewriteTests(unittest.TestCase):
    def test_absent_file_creates_only_two_explicit_new_endpoints(self):
        self.assertEqual(config.rewrite_crictl(None),
                         ('runtime-endpoint: unix://' + config.NEW + '\nimage-endpoint: unix://' + config.NEW + '\n').encode())

    def test_rewrites_both_aliases_preserving_comments_quotes_spacing_crlf_and_other_bytes(self):
        raw = (b'# config unchanged\r\nruntime-endpoint : "unix:///var/run/containerd/containerd.sock"  # runtime\r\n'
               b"image-endpoint:\t'/run/containerd/containerd.sock' # image\r\n"
               b'timeout: 10\r\ndebug: false\r\npull-image-on-create: false')
        expected = raw.replace(b'unix:///var/run/containerd/containerd.sock', ('unix://' + config.NEW).encode())
        expected = expected.replace(b"'/run/containerd/containerd.sock'", ("'unix://" + config.NEW + "'").encode())
        self.assertEqual(config.rewrite_crictl(raw), expected)

    def test_duplicate_unknown_nested_quoted_multidocument_merge_and_missing_keys_refuse(self):
        valid = b'runtime-endpoint: unix:///run/containerd/containerd.sock\nimage-endpoint: unix:///run/containerd/containerd.sock\n'
        variants = [valid + valid.splitlines(keepends=True)[0], valid.replace(b'/run/containerd/containerd.sock', b'/run/other.sock', 1),
                    valid.replace(b'runtime-endpoint:', b'  runtime-endpoint:'),
                    valid.replace(b'runtime-endpoint:', b'"runtime-endpoint":'),
                    b'---\n' + valid, valid + b'<<: *defaults\n', valid.splitlines(keepends=True)[0], b'',
                    valid.replace(b' unix:///run/containerd/containerd.sock', b' *endpoint', 1),
                    valid.replace(b' unix:///run/containerd/containerd.sock', b' {endpoint: old}', 1),
                    valid.replace(b'.sock\n', b'.sock#comment\n', 1)]
        for value in variants:
            with self.subTest(value=value), self.assertRaises(config.EndpointError):
                config.rewrite_crictl(value)

    def test_already_new_or_remote_endpoint_is_not_adopted_as_original(self):
        for endpoint in ('unix://' + config.NEW, 'tcp://127.0.0.1:2375', 'unix:///var/run/other.sock'):
            raw = ('runtime-endpoint: ' + endpoint + '\nimage-endpoint: unix://' + config.OLD + '\n').encode()
            with self.assertRaises(config.EndpointError):
                config.rewrite_crictl(raw)


if __name__ == '__main__':
    unittest.main()
