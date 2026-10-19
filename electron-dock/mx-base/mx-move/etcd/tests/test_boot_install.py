"""Guard installation and manifest release tests without host changes."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1]))
SPEC = importlib.util.spec_from_file_location(
    'mx_move_boot_install_tested', Path(__file__).parents[1] / 'move.py')
move = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(move)


class BootInstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='mx-move-install-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.state = self.root / 'state'
        self.run_dir = self.state / 'run'
        self.run_dir.mkdir(parents=True)
        self.drop_dir = self.root / 'kubelet.service.d'
        self.drop_dir.mkdir()
        self.python = self.root / 'system-python'
        self.python.write_text('offline executable')
        self.guard = self.drop_dir / '90-mx-move-etcd.conf'
        self.host = mock.Mock()
        self.transaction = move.Move(self.host, self.state)
        self.transaction.j = {
            'run': str(self.run_dir), 'guard_python': str(self.python), 'may_write': True,
            'source_identity': {'device': 1, 'inode': 2}, 'source_disk': {'uuid': 'source'},
            'target_identity': {'device': 3, 'inode': 4}, 'target_disk': {'uuid': 'target'}}

    def mapped_path(self, value):
        if str(value) == '/etc/systemd/system/kubelet.service.d':
            return self.drop_dir
        if str(value) == '/usr/bin/python3':
            return self.python
        return Path(value)

    def install(self, execute=None):
        with mock.patch.object(move, 'Path', side_effect=self.mapped_path), \
                mock.patch.object(move, 'safe_path'), \
                mock.patch.object(move.shutil, 'which', side_effect=lambda name: '/usr/bin/' + name), \
                mock.patch.object(move, 'run', side_effect=execute) as run:
            self.transaction.boot_guard()
        return run

    def unit(self, isolated):
        args = [self.python]
        if isolated:
            args.append('-I')
        args.extend([self.state / 'boot-guard.py', '--record', self.state / 'active-etcd.json'])
        command = ' '.join('"{}"'.format(arg) for arg in args)
        return ('# Managed by mx-base/mx-move; kept on rollback.\n[Unit]\n'
                'RequiresMountsFor=/var/lib/etcd\n[Service]\nExecStartPre=' + command + '\n').encode()

    def test_install_executes_same_isolated_command_as_systemd_and_persists_python(self):
        calls = self.install().call_args_list
        expected = [str(self.python), '-I', self.state / 'boot-guard.py',
                    '--record', self.state / 'active-etcd.json']
        self.assertIn(mock.call(expected), calls)
        self.assertEqual(calls[0][0][0][1], '-I')
        self.assertEqual(calls[-1], mock.call(['systemctl', 'daemon-reload']))
        self.assertEqual(self.guard.read_bytes(), self.unit(True))
        self.transaction.persist('prepared')
        stored = json.loads((self.run_dir / 'journal.json').read_text())
        self.assertEqual(stored['guard_python'], str(self.python))

    def test_known_previous_python_guard_is_backed_up_and_upgraded(self):
        previous = self.unit(False)
        self.guard.write_bytes(previous)
        self.install()
        self.assertEqual((self.run_dir / 'boot-guard.before').read_bytes(), previous)
        self.assertEqual(self.guard.read_bytes(), self.unit(True))

    def test_known_legacy_guard_is_backed_up_and_upgraded(self):
        legacy = (b'# Managed by mx-base/mx-move; kept on rollback.\n[Unit]\n'
                  b'RequiresMountsFor=/var/lib/etcd\n[Service]\n'
                  b'ExecStartPre=/usr/bin/mountpoint -q /var/lib/etcd\n'
                  b'ExecStartPre=/usr/bin/test -s /var/lib/etcd/member/snap/db\n')
        self.guard.write_bytes(legacy)
        self.install()
        self.assertEqual((self.run_dir / 'boot-guard.before').read_bytes(), legacy)
        self.assertEqual(self.guard.read_bytes(), self.unit(True))

    def test_unrecognized_existing_dropin_is_not_overwritten(self):
        original = b'[Service]\nExecStartPre=/custom/guard\n'
        self.guard.write_bytes(original)
        with self.assertRaises(move.Refuse):
            self.install()
        self.assertEqual(self.guard.read_bytes(), original)

    def test_failed_install_validation_does_not_install_dropin(self):
        def execute(args):
            if '--record' in args:
                raise move.Refuse('offline guard failure')
        with self.assertRaises(move.Refuse):
            self.install(execute)
        self.assertFalse(self.guard.exists())

    def prepare_manifest(self):
        watched = self.root / 'manifests'
        watched.mkdir()
        self.manifest = watched / 'etcd.yaml'
        self.held = self.root / 'held.yaml'
        self.held.write_bytes(b'offline manifest')
        (self.run_dir / 'etcd.yaml').write_bytes(self.held.read_bytes())
        self.transaction.j['held'] = str(self.held)

    def test_manifest_release_runs_guard_before_restoring_manifest(self):
        self.prepare_manifest()
        expected = [str(self.python), '-I', self.state / 'boot-guard.py',
                    '--record', self.state / 'active-etcd.json']

        def execute(args):
            self.assertEqual(args, expected)
            self.assertFalse(self.manifest.exists())
            self.assertTrue(self.held.exists())
        with mock.patch.object(move, 'MANIFEST', self.manifest), \
                mock.patch.object(move, 'safe_path'), \
                mock.patch.object(move, 'run', side_effect=execute) as run:
            self.transaction.manifest_in()
        run.assert_called_once_with(expected)
        self.assertTrue(self.manifest.exists())
        self.assertFalse(self.held.exists())

    def test_failed_guard_keeps_manifest_outside_watched_directory(self):
        self.prepare_manifest()
        with mock.patch.object(move, 'MANIFEST', self.manifest), \
                mock.patch.object(move, 'safe_path'), \
                mock.patch.object(move, 'run', side_effect=move.Refuse('offline guard failure')):
            with self.assertRaises(move.Refuse):
                self.transaction.manifest_in()
        self.assertFalse(self.manifest.exists())
        self.assertTrue(self.held.exists())

    def test_missing_pinned_interpreter_refuses_manifest_release(self):
        self.prepare_manifest()
        self.transaction.j.pop('guard_python')
        with mock.patch.object(move, 'MANIFEST', self.manifest):
            with self.assertRaisesRegex(move.Refuse, 'Python'):
                self.transaction.manifest_in()
        self.assertFalse(self.manifest.exists())
        self.assertTrue(self.held.exists())

    def test_failed_guard_names_stage_and_read_only_command_without_raw_output(self):
        with mock.patch.object(move, 'safe_path'), \
                mock.patch.object(move, 'run', side_effect=move.CommandFailed(
                    self.python, 1, b'sensitive host output')):
            with self.assertRaises(move.Refuse) as error:
                self.transaction.check_boot_guard()
        message = str(error.exception)
        self.assertIn('etcd 启动保护检查失败', message)
        self.assertIn('只读复查：', message)
        self.assertIn(str(self.python) + ' -I ', message)
        self.assertIn('--record', message)
        self.assertNotIn('sensitive', message)


if __name__ == '__main__':
    unittest.main()
