"""Offline regressions for the local, read-only runtime separation probe."""
import json
import contextlib
import io
import os
from pathlib import Path
import stat
import sys
import types
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import runtime_check as probe
finally:
    sys.path.pop(0)

SECRET = 'credential-value-must-not-be-reported'
CONTAINER_ID = 'a' * 64
DUMP = '''version = 2
root = "/data/mx-runtime/containerd"
state = "/run/containerd"
imports = []
disabled_plugins = []
[grpc]
address = "/run/containerd/containerd.sock"
[ttrpc]
address = ""
[plugins."io.containerd.grpc.v1.cri"]
sandbox_image = "registry.k8s.io/pause:3.9"
[plugins."io.containerd.grpc.v1.cri".containerd]
snapshotter = "overlayfs"
default_runtime_name = "runc"
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
runtime_type = "io.containerd.runc.v2"
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
BinaryName = ""
SystemdCgroup = true
[plugins."io.containerd.grpc.v1.cri".cni]
bin_dir = "/opt/cni/bin"
conf_dir = "/etc/cni/net.d"
max_conf_num = 1
[plugins."io.containerd.grpc.v1.cri".registry]
config_path = "/etc/containerd/certs.d"
[plugins."io.containerd.grpc.v1.cri".registry.configs."registry.example".auth]
password = "''' + SECRET + '''"
[proxy_plugins.stargz]
address = "/run/containerd-stargz-grpc/containerd-stargz-grpc.sock"
type = "snapshot"
[plugins."io.containerd.nri.v1.nri"]
disable = true
socket_path = "/var/run/nri/nri.sock"
'''


class ParsingTests(unittest.TestCase):
    def test_paths_do_not_include_registry_credentials(self):
        result = probe.config_summary(DUMP)
        self.assertEqual(result, {'root': '/data/mx-runtime/containerd', 'state': '/run/containerd',
                                  'address': '/run/containerd/containerd.sock', 'imports': 'empty'})
        self.assertNotIn(SECRET, json.dumps(result))

    def test_empty_imports_are_different_from_present_and_absent(self):
        for raw, expected in [('imports = []', 'empty'), ('imports = [ ] # comment', 'empty'),
                              ('"imports" = []', 'empty'),
                              ('imports = ["/etc/containerd/conf.d/*.toml"]', 'present'),
                              ('imports = [\'/a\', \'/b\',]', 'present'), ('', 'absent')]:
            self.assertEqual(probe.config_summary(raw)['imports'], expected)
        with self.assertRaises(ValueError):
            probe.config_summary('imports = [\n "/a"\n]')

    def test_effective_command_flags_override_dump(self):
        flags = probe.canonical_flags(['containerd', '--root=/override', '--state', '/run/custom',
                                       '-a', '/run/custom/daemon.sock', '-c', '/etc/custom.toml'],
                                      {'--root': 'root', '--state': 'state', '-a': 'address', '-c': 'config'})
        result = probe.effective_config(probe.config_summary(DUMP), flags)
        self.assertEqual(result['root'], '/override')
        self.assertEqual(result['state'], '/run/custom')
        self.assertEqual(result['address'], '/run/custom/daemon.sock')
        self.assertNotIn('config', result)

    def test_duplicate_and_missing_flags_are_unknown(self):
        for argv in (['-c', '/a', '--config=/b'], ['-c'], ['-c', 'relative']):
            with self.assertRaises(ValueError):
                probe.canonical_flags(argv, {'-c': 'config', '--config': 'config'})

    def test_duplicate_paths_or_incomplete_dump_fail(self):
        with self.assertRaises(ValueError):
            probe.config_summary('root = "/one"\nroot = "/two"')
        with self.assertRaises(ValueError):
            probe.effective_config(probe.config_summary('root = "/one"'), {})

    def test_only_simple_top_level_yaml_endpoint_is_accepted(self):
        for value in ('unix:///run/containerd/containerd.sock', '"unix:///run/containerd/containerd.sock"',
                      "'/run/containerd/containerd.sock' # okay"):
            self.assertEqual(probe.yaml_endpoint('kind: KubeletConfiguration\ncontainerRuntimeEndpoint: ' + value),
                             '/run/containerd/containerd.sock')
        for raw in ('nested:\n  containerRuntimeEndpoint: /run/wrong.sock',
                    'containerRuntimeEndpoint: /run/a\ncontainerRuntimeEndpoint: /run/b',
                    'containerRuntimeEndpoint: *anchor', '---\ncontainerRuntimeEndpoint: /run/a',
                    'containerRuntimeEndpoint: tcp://remote:1234', 'containerRuntimeEndpoint: "/a\\b"'):
            with self.assertRaises(ValueError):
                probe.yaml_endpoint(raw)

    def test_compatibility_projection_drops_auth_and_keeps_required_fields(self):
        result = probe.compatibility_summary(DUMP)
        self.assertEqual(result['config_version'], 2)
        self.assertTrue(result['requires_manual_review'])
        fields = {(tuple(v['section']), v['key']): v['value'] for v in result['fields']}
        self.assertEqual(fields[(('plugins', 'io.containerd.grpc.v1.cri', 'cni'), 'max_conf_num')], 1)
        self.assertIs(fields[(('plugins', 'io.containerd.grpc.v1.cri', 'containerd', 'runtimes', 'runc', 'options'), 'SystemdCgroup')], True)
        self.assertEqual(fields[(('proxy_plugins', 'stargz'), 'address')], '/run/containerd-stargz-grpc/containerd-stargz-grpc.sock')
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn('password', json.dumps(result))

    def test_unsupported_relevant_scalars_fail_without_echoing_them(self):
        for raw in ('version = "mystery"', '[grpc]\naddress = "http://user:password@host"',
                    '[plugins."io.containerd.grpc.v1.cri"]\nsandbox_image = "user:password@host/image"',
                    'disabled_plugins = [\n "cri"\n]'):
            with self.assertRaises(ValueError):
                probe.compatibility_summary(raw)

    def test_version_projection_is_only_version(self):
        self.assertEqual(probe.version_value('containerd github.com/containerd/containerd 1.7.17 hash', 'containerd'), '1.7.17')
        self.assertEqual(probe.version_value('Kubernetes v1.28.10', 'kubelet'), 'v1.28.10')
        with self.assertRaises(ValueError):
            probe.version_value(SECRET, 'containerd')

    def test_task_output_does_not_emit_task_ids(self):
        result = probe.tasks_summary('TASK PID STATUS\n' + SECRET + ' 100 RUNNING\ntask2 101 STOPPED\n')
        self.assertEqual(result, {'total': 2, 'status_counts': {'RUNNING': 1, 'STOPPED': 1}})
        self.assertNotIn(SECRET, json.dumps(result))
        with self.assertRaises(ValueError):
            probe.tasks_summary('TASK PID STATUS\nwrong')

    def test_docker_projection_drops_all_unrequested_fields(self):
        info = probe.docker_info(json.dumps({'root': '/var/lib/docker', 'live_restore': False,
                                           'name': 'internal', 'swarm_state': 'inactive', 'auth': SECRET}))
        container = probe.docker_container({'id': CONTAINER_ID, 'name': '/app', 'running': True,
                    'paused': False, 'stop_signal': 'SIGTERM', 'restart_policy': {'Name': 'unless-stopped',
                    'MaximumRetryCount': 0, 'extra': SECRET}, 'env': SECRET, 'mounts': SECRET})
        self.assertNotIn(SECRET, json.dumps([info, container]))
        self.assertEqual(container['restart_policy'], {'Name': 'unless-stopped', 'MaximumRetryCount': 0})


class ProbeTests(unittest.TestCase):
    def test_socket_identity_resolves_alias_without_confusing_regular_files(self):
        sock = types.SimpleNamespace(st_mode=stat.S_IFSOCK, st_dev=1, st_ino=22)
        regular = types.SimpleNamespace(st_mode=stat.S_IFREG, st_dev=1, st_ino=23)
        with mock.patch.object(probe.os, 'stat', side_effect=[sock, sock, sock, regular]):
            self.assertTrue(probe.same_socket(probe.socket_identity('/run/containerd.sock'),
                                              probe.socket_identity('unix:///var/run/containerd.sock')))
            self.assertIsNone(probe.same_socket(probe.socket_identity('/run/containerd.sock'),
                                                probe.socket_identity('/plain')))
        self.assertIsNone(probe.same_socket(None, None))

    def test_runner_discards_remote_docker_environment(self):
        with mock.patch.dict(os.environ, {'DOCKER_CONTEXT': 'remote', 'DOCKER_HOST': 'tcp://remote:2376',
                                          'DOCKER_TLS_VERIFY': '1'}), mock.patch.object(probe.subprocess, 'run') as call:
            call.return_value = types.SimpleNamespace(returncode=0, stdout=b'ok')
            self.assertEqual(probe.run(['docker', '--host', 'unix:///var/run/docker.sock', 'info']), 'ok')
        self.assertFalse(any(k.startswith('DOCKER_') for k in call.call_args[1]['env']))

    def test_failed_command_never_emits_subprocess_output(self):
        inspector = probe.RuntimeInspector()
        with mock.patch.object(probe.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1, stdout=SECRET.encode(), stderr=SECRET.encode())):
            self.assertIsNone(inspector.attempt('fixed label', lambda: probe.run(['ctr', 'bad'])))
        self.assertNotIn(SECRET, json.dumps(inspector.errors))

    def test_full_collection_has_only_read_only_commands_and_redacted_output(self):
        commands = []
        cmdlines = {'/proc/11/cmdline': 'kubelet\0--config=/var/lib/kubelet/config.yaml\0--token=' + SECRET,
                    '/proc/12/cmdline': 'containerd\0--config=/etc/containerd/config.toml\0--root=/data/override\0',
                    '/proc/13/cmdline': 'dockerd\0--containerd=/var/run/containerd/containerd.sock\0'}
        files = {'/var/lib/kubelet/config.yaml': 'containerRuntimeEndpoint: unix:///run/containerd/containerd.sock',
                 '/etc/containerd/config.toml': DUMP}
        def command(args):
            commands.append(args)
            if args[0] == 'systemctl':
                self.assertEqual(args[1], 'show')
                pid = {'kubelet.service': 11, 'containerd.service': 12, 'docker.service': 13}[args[2]]
                return 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID={}\nEnvironment={}'.format(pid, SECRET)
            if args[0] == '/proc/11/exe':
                self.assertEqual(args[1:], ['--version'])
                return 'Kubernetes v1.28.10'
            if args[0] == '/proc/12/exe':
                if args[1:] == ['--version']:
                    return 'containerd github.com/containerd/containerd 1.7.17 abc'
                self.assertEqual(args[1:], ['--config', '/etc/containerd/config.toml', '--root', '/data/override', 'config', 'dump'])
                return DUMP
            if args[0] == 'ctr':
                self.assertEqual(args[1:3], ['--address', '/run/containerd/containerd.sock'])
                if args[3:] == ['namespaces', 'list', '--quiet']:
                    return 'k8s.io\nmoby\nplugins.moby\n'
                self.assertEqual(args[3], '--namespace')
                if args[5:] == ['tasks', 'list']:
                    return 'TASK PID STATUS\n' + SECRET + ' 123 RUNNING\n'
                self.assertEqual(args[3:], ['--namespace', 'k8s.io', 'images', 'list', '--quiet'])
                return SECRET + '\nregistry.example/image\n'
            if args[0] == 'docker':
                self.assertEqual(args[1:3], ['--host', 'unix:///var/run/docker.sock'])
                if args[3] == 'info':
                    self.assertEqual(args[4], '--format')
                    return json.dumps({'root': '/var/lib/docker', 'live_restore': False, 'name': 'internal', 'swarm_state': 'inactive', 'credential': SECRET})
                if args[3] == 'ps':
                    self.assertEqual(args[4:], ['--all', '--quiet', '--no-trunc'])
                    return CONTAINER_ID
                self.assertEqual(args[3:5], ['inspect', '--format'])
                self.assertEqual(args[-1], CONTAINER_ID)
                return json.dumps({'id': CONTAINER_ID, 'name': '/app', 'running': True, 'paused': False,
                                   'stop_signal': '', 'restart_policy': {'Name': 'always', 'MaximumRetryCount': 0}, 'environment': SECRET})
            self.assertEqual(args, ['findmnt', '--json', '--list', '--output', 'TARGET,SOURCE,FSTYPE,FSROOT,UUID,OPTIONS'])
            return json.dumps({'filesystems': [{'target': '/', 'source': '/dev/root', 'fstype': 'xfs', 'uuid': 'root', 'fsroot': '/', 'options': 'rw'},
                                               {'target': '/mnt/nas', 'source': SECRET, 'fstype': 'nfs', 'options': 'rw'}]})
        def readlink(path):
            return {'/proc/11/exe': '/usr/bin/kubelet', '/proc/12/exe': '/usr/bin/containerd',
                    '/proc/13/exe': '/usr/bin/dockerd', '/shared_dir': '/mnt/nas/shared_dir'}[path]
        inspector = probe.RuntimeInspector()
        with mock.patch.object(probe, 'run', side_effect=command), \
             mock.patch.object(probe.Path, 'read_bytes', lambda p: cmdlines[str(p)].encode()), \
             mock.patch.object(probe.Path, 'read_text', lambda p: files[str(p)]), \
             mock.patch.object(probe.os, 'readlink', side_effect=readlink), \
             mock.patch.object(probe.os, 'lstat', return_value=types.SimpleNamespace(st_mode=stat.S_IFLNK)), \
             mock.patch.object(probe.os, 'stat', return_value=types.SimpleNamespace(st_mode=stat.S_IFSOCK, st_dev=1, st_ino=22)):
            result = inspector.collect()
        self.assertFalse(result['collection_errors'])
        self.assertTrue(all(result['shares_socket'].values()))
        self.assertEqual(result['runtime']['containerd']['config_dump']['root'], '/data/override')
        self.assertEqual(result['runtime']['containerd']['source_imports'], 'empty')
        self.assertEqual(result['containerd_namespaces'][0]['image_count'], 2)
        self.assertEqual(result['shared_dir']['lexical_target_mount']['target'], '/mnt/nas')
        self.assertEqual(result['shared_dir']['target_resolution'], 'lexical-only-not-followed')
        self.assertEqual(result['docker']['running'], 1)
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertTrue(commands)

    def test_help_does_not_require_root_or_linux(self):
        with mock.patch.object(probe.sys, 'platform', 'darwin'), \
                mock.patch.object(probe.os, 'geteuid', return_value=501), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(SystemExit) as stopped:
                probe.main(['--help'])
        self.assertEqual(stopped.exception.code, 0)
        self.assertIn('runtime-check', output.getvalue())

    def test_main_failure_is_sanitized(self):
        with mock.patch.object(probe.sys, 'platform', 'linux'), \
                mock.patch.object(probe.os, 'geteuid', return_value=0), \
                mock.patch.object(probe.RuntimeInspector, 'collect', side_effect=ValueError(SECRET)), \
                contextlib.redirect_stderr(io.StringIO()) as output:
            self.assertEqual(probe.main([]), 1)
        self.assertNotIn(SECRET, output.getvalue())


if __name__ == '__main__':
    unittest.main()
