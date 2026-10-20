"""Candidate transaction tests with real private files and fake daemon APIs.

No test starts a runtime or writes outside its temporary directory. Startup
permissions/UUID/process checks have independent guard/resolver test suites.
"""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import runtime_install as install
finally:
    sys.path.pop(0)
from test_runtime_prepare import archive_fixture


class CandidateFixture:
    def __init__(self, case):
        self.stack = ExitStack()
        case.addCleanup(self.stack.close)
        self.folder = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.prepared = self.folder / 'prepared'
        self.prepared.mkdir()
        self.config = self.prepared / 'containerd.toml'
        install.prep.save_private(self.config, 'private-config')
        self.archive = self.prepared / 'k8s-images.tar'
        digest = archive_fixture(self.archive)
        self.images = [{'name': 'registry/app:v1', 'digest': digest}]
        install.prep.save_private(self.prepared / 'images.json', json.dumps(self.images))
        self.cri = {'sha256:' + 'a' * 64: {'tags': ['registry/app:v1'], 'digests': ['registry/app@' + digest]}}
        self.binary = self.folder / 'containerd'
        self.binary.write_bytes(b'binary')
        self.runtime = {'address': '/run/old.sock', 'executable': str(self.binary), 'pid': '123',
                        'version': '1.6.32', 'config_dump': {'root': '/data/containerd'}}
        self.facts = {'runtime': {'containerd': self.runtime}, 'socket': {'device': 1, 'inode': 2}, 'dump': 'source-config'}
        self.receipt = {'schema_version': 1, 'phase': 'artifacts-prepared', 'host': install.socket.gethostname(),
                        'source_version': '1.6.32', 'source_root': '/data/containerd', 'platform': 'linux/amd64',
                        'source_socket': self.facts['socket'], 'source_config_sha256': hashlib.sha256(b'source-config').hexdigest(),
                        'target_filesystem_uuid': 'ea7e456d-19db-4f6e-b8b0-02c00f59d066',
                        'target': {'root': str(self.prepared / 'data'), 'state': install.STATE, 'address': install.ADDRESS},
                        'config_sha256': install.prep.sha256_file(self.config), 'image_count': 1,
                        'archive': {'bytes': self.archive.stat().st_size, 'sha256': install.prep.sha256_file(self.archive)}}
        install.prep.save_private(self.prepared / 'prepared.json', json.dumps(self.receipt))
        self.host = mock.Mock()
        self.host.facts.return_value = self.facts
        self.host.images.return_value = self.images
        self.host.image_state.return_value = self.cri
        self.host.environment.return_value = b'HTTPS_PROXY="http://proxy:1234"\n'
        self.host.ready.return_value = {'device': 1, 'inode': 3, 'is_socket': True}
        self.commands = []
        def command(args, timeout=60):
            self.commands.append(args)
            if args == ['systemctl', 'show', install.SERVICE, '-p', 'LoadState', '-p', 'FragmentPath']:
                return 'LoadState=not-found\nFragmentPath=\n'
            if args == ['systemctl', 'show', install.SERVICE, '-p', 'UnitFileState', '--value']:
                return 'disabled\n'
            case.assertIn(args, (['systemctl', 'daemon-reload'], ['systemctl', 'start', install.SERVICE]))
            return ''
        self.host.command.side_effect = command
        directory = self.folder / 'etc'
        helpers = self.folder / 'helpers'
        self.unit = self.folder / 'runtime.service'
        self.record_path = directory / 'candidate.json'
        self.active = directory / 'active.json'
        patches = {'DIRECTORY': directory, 'HELPERS': helpers, 'UNIT': self.unit,
                   'RECORD': self.record_path, 'ACTIVE': self.active,
                   'PREPARED_PATTERN': re.escape(str(self.prepared)), 'STATE': str(self.folder / 'run')}
        self.receipt['target']['state'] = patches['STATE']
        (self.prepared / 'prepared.json').write_text(json.dumps(self.receipt))
        for key, value in patches.items():
            self.stack.enter_context(mock.patch.object(install, key, value))
        # Host Python is a protected Linux path in production. Homebrew uses
        # an '@' versioned path which this deliberately strict unit disallows.
        self.stack.enter_context(mock.patch.object(install.sys, 'executable', str(self.binary)))
        self.stack.enter_context(mock.patch.object(install.prep, 'secure_directory'))
        self.stack.enter_context(mock.patch.object(install.guard, 'safe', side_effect=lambda p, **kw: Path(p).lstat()))
        self.verify = self.stack.enter_context(mock.patch.object(install.guard, 'verify'))
        self.space = self.stack.enter_context(mock.patch.object(install.prep, 'available', return_value=300 * install.prep.GIB))
        self.stack.enter_context(mock.patch.object(install.time, 'sleep'))
        self.importer = self.stack.enter_context(mock.patch.object(install.Install, 'import_images'))

    def execute(self):
        return install.Install(self.host).execute(self.prepared)

    def record(self):
        return json.loads(self.record_path.read_text())


class TransactionTests(unittest.TestCase):
    def test_install_imports_only_new_kubernetes_instance_without_active_or_enable(self):
        fixture = CandidateFixture(self)
        result = fixture.execute()
        self.assertEqual(result['phase'], 'candidate-ready')
        for field in ('kubelet_switched', 'docker_data_moved', 'database_data_moved', 'active_descriptor_published', 'cutover_supported'):
            self.assertFalse(result[field])
        self.assertFalse(fixture.active.exists())
        self.assertEqual(fixture.record()['phase'], 'ready')
        self.assertEqual(stat.S_IMODE(fixture.record_path.stat().st_mode), 0o600)
        command = fixture.importer.call_args[0][0]
        self.assertEqual(command, ['ctr', '--address', install.ADDRESS, '--namespace', 'k8s.io', 'images', 'import',
                                  '--platform', 'linux/amd64', '--snapshotter', 'overlayfs', str(fixture.archive)])
        self.assertNotIn('enable', json.dumps(fixture.commands))
        self.assertNotIn('kubelet', json.dumps(fixture.commands))
        self.assertEqual(fixture.host.ready.call_count, 2)

    def test_ready_repeat_revalidates_without_reimport_or_overwriting(self):
        fixture = CandidateFixture(self)
        fixture.execute()
        first_identity = fixture.record()['root_identity']
        fixture.execute()
        self.assertEqual(fixture.importer.call_count, 1)
        self.assertEqual(fixture.record()['root_identity'], first_identity)
        self.assertTrue(fixture.archive.exists())

    def test_failed_import_can_resume_same_candidate_and_retains_archive(self):
        fixture = CandidateFixture(self)
        fixture.importer.side_effect = install.prep.Refuse('interrupted')
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual(fixture.record()['phase'], 'importing')
        identity = fixture.record()['root_identity']
        fixture.importer.side_effect = None
        fixture.execute()
        self.assertEqual(fixture.record()['phase'], 'ready')
        self.assertEqual(fixture.record()['root_identity'], identity)
        self.assertEqual(fixture.importer.call_count, 2)
        self.assertTrue(fixture.archive.exists())

    def test_archive_corruption_refuses_before_any_service_or_install(self):
        fixture = CandidateFixture(self)
        with fixture.archive.open('ab') as stream:
            stream.write(b'corrupt')
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual(fixture.commands, [])
        self.assertFalse(fixture.record_path.exists())

    def test_dangling_active_marker_refuses_without_source_commands(self):
        fixture = CandidateFixture(self)
        fixture.active.parent.mkdir()
        fixture.active.symlink_to(fixture.folder / 'missing')
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        fixture.host.facts.assert_not_called()

    def test_changed_source_refuses_before_mutation(self):
        fixture = CandidateFixture(self)
        fixture.host.images.return_value = []
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual(fixture.commands, [])
        self.assertFalse(fixture.record_path.exists())

    def test_cri_missing_image_never_publishes_ready(self):
        fixture = CandidateFixture(self)
        fixture.host.image_state.side_effect = lambda address: fixture.cri if address == '/run/old.sock' else {}
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual(fixture.record()['phase'], 'importing')
        self.assertFalse(fixture.active.exists())

    def test_guard_failure_cannot_start_service(self):
        fixture = CandidateFixture(self)
        fixture.verify.side_effect = install.guard.GuardError('identity changed')
        with self.assertRaises(install.guard.GuardError):
            fixture.execute()
        self.assertNotIn(['systemctl', 'start', install.SERVICE], fixture.commands)
        fixture.importer.assert_not_called()

    def test_source_environment_change_prevents_success(self):
        fixture = CandidateFixture(self)
        fixture.host.environment.side_effect = [b'', b'HTTP_PROXY="changed"\n']
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual(fixture.record()['phase'], 'importing')

    def test_resume_never_overwrites_changed_unit(self):
        fixture = CandidateFixture(self)
        fixture.execute()
        fixture.unit.write_text('unexpected-other-service')
        fixture.commands.clear()
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual(fixture.unit.read_text(), 'unexpected-other-service')
        self.assertEqual(fixture.commands, [])

    def test_existing_unowned_candidate_data_refused(self):
        fixture = CandidateFixture(self)
        (fixture.prepared / 'data').mkdir()
        (fixture.prepared / 'data' / 'retain').write_text('existing')
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual((fixture.prepared / 'data' / 'retain').read_text(), 'existing')
        self.assertFalse(fixture.record_path.exists())

    def test_low_space_before_install_starts_nothing(self):
        fixture = CandidateFixture(self)
        fixture.space.return_value = install.prep.RESERVE
        with self.assertRaises(install.prep.Refuse):
            fixture.execute()
        self.assertEqual(fixture.commands, [])


class HelperTests(unittest.TestCase):
    def test_public_marker_parent_is_traversable_under_private_umask(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(install.prep, 'secure_directory'), \
                mock.patch.object(install.guard, 'safe', side_effect=lambda p, **kw: Path(p).lstat()):
            path = Path(folder) / 'public'
            old = os.umask(0o077)
            try:
                install.public_directory(path)
            finally:
                os.umask(old)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
            path.chmod(0o700)
            with self.assertRaises(install.prep.Refuse):
                install.public_directory(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)

    def test_effective_environment_projection_preserves_proxy_specials(self):
        raw = b'PATH=/bin\0NOTIFY_SOCKET=/run/old\0HTTPS_PROXY=http://u:$p%20\\q"@proxy:12\0NO_PROXY=localhost,10.0.0.0/8\0'
        result = install.environment_file(raw).decode()
        self.assertEqual(result, 'HTTPS_PROXY="http://u:$p%20\\\\q\\"@proxy:12"\nNO_PROXY="localhost,10.0.0.0/8"\n')
        self.assertNotIn('NOTIFY_SOCKET', result)
        self.assertNotIn('PATH=', result)
        for raw in (b'HTTP_PROXY=a\nsecret\0', b'HTTP_PROXY=a\0HTTP_PROXY=b\0', b'HTTP_PROXY=a'):
            with self.assertRaises(install.prep.Refuse):
                install.environment_file(raw)

    def test_unit_rejects_systemd_expansion_or_shell_characters(self):
        for path in ('/bin/%n', '/tmp/a b', '/tmp/$(echo)', '/tmp/"x'):
            with self.assertRaises(install.prep.Refuse):
                install.unit_text(path, '/usr/bin/python3', '/a/config', '/a/data')

    def test_cri_identity_requires_all_tags_and_digests(self):
        identifier = 'sha256:' + 'a' * 64
        source = install.cri_images(json.dumps({'images': [{'id': identifier, 'repoTags': ['app:v1'], 'repoDigests': ['app@' + identifier]}]}))
        self.assertTrue(install.images_cover(source, source))
        self.assertFalse(install.images_cover({identifier: {'tags': ['app:v1'], 'digests': []}}, source))
        with self.assertRaises(install.prep.Refuse):
            install.cri_images('{"images":[]}')

    def test_capacity_cancel_stops_only_our_import_client(self):
        child = mock.Mock()
        child.poll.return_value = None
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(install.subprocess, 'Popen', return_value=child), \
                mock.patch.object(install.prep, 'available', return_value=0), mock.patch.object(install.prep, 'stop_child') as stop:
            with self.assertRaises(install.prep.Refuse):
                install.Install(mock.Mock()).import_images(['ctr'], Path(folder))
            stop.assert_called_once_with(child)

    def test_parent_and_module_forward_install_help_without_host_mutations(self):
        module = Path(__file__).parents[2]
        for script in (module / 'scripts/manage.sh', module.parent / 'scripts/manage.sh'):
            result = subprocess.run(['bash', str(script), 'k8s', 'install-runtime', '--help'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(b'--prepared', result.stdout)


class RuntimeAPITests(unittest.TestCase):
    def setUp(self):
        self.host = install.Host()
        self.environment = b'HTTP_PROXY="http://proxy:1234"\n'
        self.record = {'binary_path': '/usr/bin/containerd', 'config_path': '/private/containerd.toml',
                       'source_address': '/run/old.sock', 'environment_sha256': hashlib.sha256(self.environment).hexdigest()}
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(install.guard, 'verify'))
        self.inspector = self.stack.enter_context(mock.patch.object(install.probe, 'RuntimeInspector'))
        self.inspector.return_value.service.return_value = {'ActiveState': 'active', 'MainPID': '456'}
        self.stack.enter_context(mock.patch.object(install.os, 'readlink', return_value='/usr/bin/containerd'))
        self.args = self.stack.enter_context(mock.patch.object(install.Path, 'read_bytes',
                              return_value=b'/usr/bin/containerd\0--config\0/private/containerd.toml\0'))
        self.stack.enter_context(mock.patch.object(self.host, 'environment', return_value=self.environment))
        self.sockets = self.stack.enter_context(mock.patch.object(install.probe, 'socket_identity',
                              side_effect=lambda path: {'is_socket': True, 'device': 1, 'inode': 2 if path == install.ADDRESS else 3}))
        self.responses = {'info': json.dumps({'status': {'conditions': [{'type': 'RuntimeReady', 'status': True}]}}),
                          'pods': '', 'ps': ''}
        self.cri = self.stack.enter_context(mock.patch.object(self.host, 'cri', side_effect=lambda address, *args: self.responses[args[0]]))
        self.command = self.stack.enter_context(mock.patch.object(self.host, 'command', return_value='TASK PID STATUS\n'))

    def test_empty_candidate_is_ready_only_with_distinct_socket_and_cri_ready(self):
        self.assertEqual(self.host.ready(self.record)['inode'], 2)
        self.command.assert_called_once_with(['ctr', '--address', install.ADDRESS, '--namespace', 'k8s.io', 'tasks', 'list'])

    def test_candidate_cannot_use_original_socket(self):
        self.sockets.side_effect = None
        self.sockets.return_value = {'is_socket': True, 'device': 1, 'inode': 3}
        with self.assertRaises(install.prep.Refuse):
            self.host.ready(self.record)
        self.cri.assert_not_called()

    def test_any_candidate_workload_blocks_import_readiness(self):
        for kind in ('pods', 'ps', 'task'):
            with self.subTest(kind=kind):
                self.responses['pods'] = 'sandbox-id' if kind == 'pods' else ''
                self.responses['ps'] = 'container-id' if kind == 'ps' else ''
                self.command.return_value = 'TASK PID STATUS\n' + ('existing 123 RUNNING\n' if kind == 'task' else '')
                with self.assertRaises(install.prep.Refuse):
                    self.host.ready(self.record)

    def test_effective_root_override_refuses_before_cri(self):
        self.args.return_value += b'--root\0/data/containerd\0'
        with self.assertRaises(install.prep.Refuse):
            self.host.ready(self.record)
        self.cri.assert_not_called()

    def test_wrong_effective_environment_refuses_before_cri(self):
        self.host.environment.return_value = b''
        with self.assertRaises(install.prep.Refuse):
            self.host.ready(self.record)
        self.cri.assert_not_called()

    def test_not_ready_cri_refuses_even_with_correct_socket(self):
        self.responses['info'] = '{"status":{"conditions":[{"type":"RuntimeReady","status":false}]}}'
        with self.assertRaises(install.prep.Refuse):
            self.host.ready(self.record)


if __name__ == '__main__':
    unittest.main()
