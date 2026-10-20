"""Standalone managed-runtime resolution: fixtures only, no host mutations."""
import contextlib
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
    import runtime_resolver as resolver
finally:
    sys.path.pop(0)

ROOT = '/var/lib/mx-move/k8s-runtime-prep/example/data'
STATE = '/run/mx-k8s-containerd'
ADDRESS = STATE + '/containerd.sock'
CONFIG = '/var/lib/mx-move/k8s-runtime-prep/example/containerd.toml'
KUBELET = '/var/lib/kubelet/config.yaml'
UUID = 'ea7e456d-19db-4f6e-b8b0-02c00f59d066'
SECRET = 'never-print-runtime-secret'
TOML = '''version = 2
root = "''' + ROOT + '''"
state = "''' + STATE + '''"
imports = []
[grpc]
address = "''' + ADDRESS + '''"
[plugins."io.containerd.grpc.v1.cri".registry.configs."private".auth]
password = "''' + SECRET + '''"
[timeouts]
"io.containerd.timeout.bolt.open" = "0s"
'''


def info(kind, mode, uid=0, inode=2):
    return SimpleNamespace(st_mode=kind | mode, st_uid=uid, st_dev=1, st_ino=inode, st_size=100)


class Host:
    def __init__(self):
        self.description = {'schema_version': 1, 'phase': 'active', 'hostname': 'fixture-host',
            'filesystem_uuid': UUID, 'address': ADDRESS, 'root': ROOT, 'state': STATE,
            'service': resolver.SERVICE, 'config_path': CONFIG,
            'config_sha256': hashlib.sha256(TOML.encode()).hexdigest(), 'kubelet_config_path': KUBELET}
        self.files = {CONFIG: TOML.encode(), KUBELET: ('containerRuntimeEndpoint: unix://' + ADDRESS + '\n').encode()}
        self.modes = {resolver.DESCRIPTOR: 0o644, CONFIG: 0o600, KUBELET: 0o644}
        self.directories = {}
        self.file_stats = {}
        self.services = {resolver.SERVICE: ('active', '22'), 'kubelet.service': ('active', '11')}
        self.arguments = {'22': ['/usr/bin/containerd', '--config', CONFIG],
                          '11': ['/usr/bin/kubelet', '--config=' + KUBELET]}
        self.executables = {'/proc/22/exe': '/usr/bin/containerd', '/proc/11/exe': '/usr/bin/kubelet'}
        self.sockets = {ADDRESS: info(stat.S_IFSOCK, 0o660, inode=90)}
        self.filesystems = {'/': UUID, ROOT: UUID}

    def lstat(self, path):
        if path in self.directories:
            value = self.directories[path]
            if isinstance(value, Exception):
                raise value
            return value
        return info(stat.S_IFDIR, 0o755)

    def stat(self, path):
        if path in self.sockets:
            return self.sockets[path]
        if path in self.file_stats:
            return self.file_stats[path]
        if path.startswith('/usr/bin/'):
            return info(stat.S_IFREG, 0o755)
        raise FileNotFoundError(path)

    def read_file(self, path):
        raw = self.files.get(path)
        if path == resolver.DESCRIPTOR and raw is None:
            raw = json.dumps(self.description).encode()
        if raw is None:
            raise FileNotFoundError(path)
        return raw, self.file_stats.get(path, info(stat.S_IFREG, self.modes[path]))

    def proc_args(self, pid):
        return self.arguments[pid]

    def readlink(self, path):
        return self.executables[path]

    def service(self, name):
        return self.services[name]

    def filesystem_uuid(self, path):
        return self.filesystems[path]

    def hostname(self):
        return 'fixture-host'


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.host = Host()
        self.resolve = resolver.Resolver(self.host).resolve

    def test_each_field_is_validated_before_output(self):
        for field, expected in [('address', ADDRESS), ('root', ROOT), ('service', resolver.SERVICE),
                                ('cri-endpoint', 'unix://' + ADDRESS)]:
            self.assertEqual(self.resolve(field), expected)

    def test_cli_endpoint_takes_precedence_over_actual_config(self):
        self.host.files[KUBELET] = b'containerRuntimeEndpoint: unix:///run/old.sock\n'
        self.host.arguments['11'] += ['--container-runtime-endpoint=unix://' + ADDRESS]
        self.assertEqual(self.resolve('address'), ADDRESS)
        self.host.arguments['11'][-1] = '--container-runtime-endpoint=unix:///run/wrong.sock'
        self.host.sockets['/run/wrong.sock'] = info(stat.S_IFSOCK, 0o660, inode=91)
        with self.assertRaises(resolver.Refuse):
            self.resolve('address')

    def test_effective_endpoint_alias_must_be_the_same_socket(self):
        alias = STATE + '/alias.sock'
        self.host.arguments['11'] += ['--container-runtime-endpoint', 'unix://' + alias]
        self.host.sockets[alias] = info(stat.S_IFSOCK, 0o660, inode=90)
        self.assertEqual(self.resolve('address'), ADDRESS)

    def test_cli_endpoint_does_not_require_a_shadowed_yaml_endpoint(self):
        self.host.files[KUBELET] = b'kind: KubeletConfiguration\n'
        self.host.arguments['11'] += ['--container-runtime-endpoint=unix://' + ADDRESS]
        self.assertEqual(self.resolve('address'), ADDRESS)

    def test_running_runtime_flags_cannot_override_descriptor_paths(self):
        for flag in ('--root=/data/old', '--state=/run/old', '--address=/run/old.sock'):
            with self.subTest(flag=flag):
                self.host.arguments['22'] = ['/usr/bin/containerd', '-c', CONFIG, flag]
                with self.assertRaises(resolver.Refuse):
                    self.resolve('address')

    def test_running_config_paths_and_executables_are_verified(self):
        self.host.arguments['11'] = ['/usr/bin/kubelet', '--config=/elsewhere/config.yaml']
        with self.assertRaises(resolver.Refuse):
            self.resolve('root')
        self.host.arguments['11'] = ['/usr/bin/kubelet', '--config=' + KUBELET]
        self.host.executables['/proc/22/exe'] = '/usr/bin/another-runtime'
        with self.assertRaises(resolver.Refuse):
            self.resolve('root')

    def test_recovery_mode_checks_files_without_stopped_service_sockets(self):
        self.host.services = {resolver.SERVICE: ('inactive', '0'), 'kubelet.service': ('inactive', '0')}
        self.host.sockets = {}
        self.host.directories[STATE] = FileNotFoundError()
        self.assertEqual(self.resolve('service', True), resolver.SERVICE)
        self.assertEqual(self.resolve('root', True), ROOT)
        for field in ('address', 'cri-endpoint'):
            with self.assertRaises(resolver.Refuse):
                self.resolve(field, True)
        with self.assertRaises(resolver.Refuse):
            self.resolve('root')

    def test_recovery_does_not_skip_wrong_running_endpoint_or_wrong_disk(self):
        self.host.services['kubelet.service'] = ('inactive', '0')
        self.host.files[KUBELET] = b'containerRuntimeEndpoint: unix:///run/old.sock\n'
        with self.assertRaises(resolver.Refuse):
            self.resolve('service', True)
        self.host.files[KUBELET] = ('containerRuntimeEndpoint: unix://' + ADDRESS + '\n').encode()
        self.host.filesystems[ROOT] = 'another-filesystem'
        with self.assertRaises(resolver.Refuse):
            self.resolve('service', True)

    def test_recovery_rejects_inactive_services_with_a_live_pid(self):
        self.host.services['kubelet.service'] = ('inactive', '11')
        with self.assertRaises(resolver.Refuse):
            self.resolve('root', True)

    def test_schema_phase_host_and_service_are_pinned(self):
        for key, value in [('phase', 'prepared'), ('schema_version', True), ('hostname', 'other-host'),
                           ('service', 'containerd.service'), ('extra', 'unreviewed')]:
            with self.subTest(key=key):
                host = Host()
                host.description[key] = value
                with self.assertRaises(resolver.Refuse):
                    resolver.Resolver(host).resolve('address')

    def test_checksum_and_effective_toml_paths_are_both_required(self):
        self.host.files[CONFIG] += b'\n# changed\n'
        with self.assertRaises(resolver.Refuse):
            self.resolve('address')
        self.host.files[CONFIG] = TOML.replace(ROOT, '/data/wrong').encode()
        self.host.description['config_sha256'] = hashlib.sha256(self.host.files[CONFIG]).hexdigest()
        with self.assertRaises(resolver.Refuse):
            self.resolve('address')

    def test_root_filesystem_and_descriptor_filesystem_must_both_match(self):
        self.host.filesystems['/'] = 'different-root'
        with self.assertRaises(resolver.Refuse):
            self.resolve('address')

    def test_writable_ancestors_symlinks_modes_and_ownership_fail_closed(self):
        for path, metadata in [('/etc/mx-k8s-runtime', info(stat.S_IFDIR, 0o777)),
                               ('/var/lib/mx-move', info(stat.S_IFLNK, 0o777)),
                               ('/run/mx-k8s-containerd', info(stat.S_IFDIR, 0o755, uid=1000))]:
            host = Host()
            host.directories[path] = metadata
            with self.assertRaises(resolver.Refuse):
                resolver.Resolver(host).resolve('address')
        for path, metadata in [(resolver.DESCRIPTOR, info(stat.S_IFLNK, 0o777)),
                               (resolver.DESCRIPTOR, info(stat.S_IFREG, 0o600)),
                               (CONFIG, info(stat.S_IFREG, 0o644)),
                               (CONFIG, info(stat.S_IFREG, 0o600, uid=1000))]:
            host = Host()
            host.file_stats[path] = metadata
            with self.assertRaises(resolver.Refuse):
                resolver.Resolver(host).resolve('address')

    def test_non_socket_target_fails_closed(self):
        self.host.sockets[ADDRESS] = info(stat.S_IFREG, 0o600, inode=90)
        with self.assertRaises(resolver.Refuse):
            self.resolve('address')

    def test_service_pid_drift_is_detected(self):
        original = self.host.service
        count = [0]
        def changing(name):
            count[0] += 1
            if count[0] > 2 and name == resolver.SERVICE:
                return 'active', '33'
            return original(name)
        self.host.service = changing
        with self.assertRaises(resolver.Refuse):
            self.resolve('address')

    def test_duplicate_descriptor_keys_and_imports_are_rejected(self):
        self.host.files[resolver.DESCRIPTOR] = b'{"schema_version":1,"schema_version":1}'
        with self.assertRaises(resolver.Refuse):
            self.resolve('address')
        with self.assertRaises(resolver.Refuse):
            resolver.config_paths(TOML.replace('imports = []', 'imports = ["/etc/old.toml"]'))

    def test_canonical_quoted_tables_and_private_prepared_ancestors_work(self):
        quoted = TOML.replace('[grpc]', '["grpc"]').replace('root = ', '"root" = ').replace('state = ', '"state" = ')
        self.host.files[CONFIG] = quoted.encode()
        self.host.description['config_sha256'] = hashlib.sha256(quoted.encode()).hexdigest()
        self.host.directories['/var/lib/mx-move/k8s-runtime-prep'] = info(stat.S_IFDIR, 0o700)
        self.host.directories['/var/lib/mx-move/k8s-runtime-prep/example'] = info(stat.S_IFDIR, 0o700)
        self.host.directories[ROOT] = info(stat.S_IFDIR, 0o700)
        self.assertEqual(self.resolve('root'), ROOT)

    def test_cli_hides_raw_exceptions_and_never_falls_back(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(resolver.Resolver, 'resolve', side_effect=OSError(SECRET)), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = resolver.main(['address'])
        self.assertEqual(result, 2)
        self.assertEqual(out.getvalue(), '')
        self.assertNotIn(SECRET, err.getvalue())
        self.assertEqual(err.getvalue(), 'managed Kubernetes runtime unavailable: unavailable\n')

    def test_command_runner_is_read_only_and_suppresses_stderr(self):
        with mock.patch.object(resolver.subprocess, 'run') as run:
            run.return_value = SimpleNamespace(returncode=0, stdout=b'LoadState=loaded\nActiveState=active\nMainPID=22\n')
            self.assertEqual(resolver.System().service(resolver.SERVICE), ('active', '22'))
            self.assertEqual(run.call_args[0][0][:2], ['systemctl', 'show'])
            self.assertEqual(run.call_args[1]['stderr'], resolver.subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
