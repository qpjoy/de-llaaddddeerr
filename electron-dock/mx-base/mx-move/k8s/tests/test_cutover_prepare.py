"""Exercise real preparation with private local files and no host commands."""
import base64
from contextlib import contextmanager, ExitStack
import hashlib
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import cutover
finally:
    sys.path.pop(0)


class PrepareTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        """Only transaction artifacts use real file I/O; root reads are mapped."""
        backend = cutover.etcd_driver()
        with tempfile.TemporaryDirectory(prefix='mx-cutover-prepare-') as directory, ExitStack() as stack:
            root = Path(directory)
            run = root / 'transaction'
            run.mkdir(mode=0o700)
            original_tool = root / 'etcdctl-source'
            original_tool.write_bytes(b'fixture-etcdctl')
            kubernetes = root / 'kubernetes-source'
            kubernetes.mkdir(mode=0o700)
            (kubernetes / 'admin.conf').write_bytes(b'private-kubeconfig-fixture')
            payload = b'x' * 512
            snapshot = payload + hashlib.sha256(payload).digest()
            old_endpoint = b'containerRuntimeEndpoint: unix:///run/containerd/containerd.sock\n'
            unit = cutover.runtime_install.unit_text('/usr/bin/containerd', '/usr/bin/python3',
                                                     '/private/containerd.toml', '/private/runtime-data')
            files = {
                '/etc/fstab': b'fixture-fstab\n',
                str(cutover.runtime_install.RECORD): json.dumps({'unit_sha256': cutover.digest(unit)}).encode(),
                str(cutover.runtime_install.UNIT): unit,
                '/var/lib/kubelet/config.yaml': old_endpoint,
                '/var/lib/kubelet/instance-config.yaml': old_endpoint,
                '/var/lib/kubelet/kubeadm-flags.env': b'KUBELET_KUBEADM_ARGS=""\n',
            }
            original_reads, original_exists = Path.read_bytes, Path.exists
            original_copyfile, original_copytree = shutil.copyfile, shutil.copytree
            def read(path):
                if str(path) in files:
                    return files[str(path)]
                if str(path).startswith(('/etc/', '/var/lib/')):
                    raise AssertionError('unexpected host file read')
                return original_reads(path)
            def exists(path):
                return True if str(path) in files else original_exists(path)
            def copyfile(source, destination, **kwargs):
                return original_copyfile(source, destination, **kwargs)
            def copytree(source, destination, **kwargs):
                self.assertEqual(source, '/etc/kubernetes')
                return original_copytree(str(kubernetes), destination, **kwargs)
            def ctl(*args):
                self.assertEqual(args, ('snapshot', 'save', str(run / 'snapshot.db')))
                (run / 'snapshot.db').write_bytes(snapshot)
                return b''
            host = object.__new__(cutover.Host)
            host.etcd_module = backend
            host.etcd = SimpleNamespace(etcdctl=str(original_tool), ctl=mock.Mock(side_effect=ctl),
                                        launcher_check=mock.Mock(return_value={'namespace': 'mx-internal-shadow'}))
            host.run = mock.Mock(return_value=b'')
            host.identities = mock.Mock()
            data = {'run': str(run), 'kubelet_launch': {'fixture': True}, 'may_write': False,
                    'storage': {'entries': [{'logical': '/var/lib/kubelet'}, {'logical': '/var/lib/mx-launcher'}]}}
            stack.enter_context(mock.patch.object(Path, 'read_bytes', read))
            stack.enter_context(mock.patch.object(Path, 'exists', exists))
            stack.enter_context(mock.patch.object(cutover.sys, 'executable', '/usr/bin/python3'))
            guards = stack.enter_context(mock.patch.object(cutover.candidate_guard, 'safe'))
            endpoint = stack.enter_context(mock.patch.object(cutover.endpoint_config, 'verify'))
            copies = stack.enter_context(mock.patch.object(cutover.shutil, 'copyfile', side_effect=copyfile))
            trees = stack.enter_context(mock.patch.object(cutover.shutil, 'copytree', side_effect=copytree))
            stack.enter_context(mock.patch.object(cutover.prep, 'progress'))
            yield SimpleNamespace(host=host, data=data, run=run, files=files, snapshot=snapshot,
                                  copies=copies, trees=trees, guards=guards, endpoint=endpoint,
                                  backend=backend, original_tool=original_tool)

    def test_prepare_keeps_original_files_and_builds_private_backup_and_startup_intents(self):
        with self.fixture() as case:
            case.host.prepare(case.data)
            case.endpoint.assert_called_once_with(case.host.run, case.data['kubelet_launch'])
            case.host.identities.assert_called_once_with('prepare', case.data)
            self.assertEqual({path: base64.b64decode(raw) for path, raw in case.data['files'].items()}, case.files)
            self.assertEqual((case.run / 'etcdctl').read_bytes(), b'fixture-etcdctl')
            self.assertEqual(stat.S_IMODE((case.run / 'etcdctl').stat().st_mode), 0o700)
            self.assertEqual((case.run / 'kubernetes.before/admin.conf').read_bytes(), b'private-kubeconfig-fixture')
            self.assertEqual(stat.S_IMODE((case.run / 'snapshot.db').stat().st_mode), 0o600)
            self.assertEqual(case.data['snapshot_sha256'], hashlib.sha256(case.snapshot[:-32]).hexdigest())
            self.assertEqual(case.host.etcd.etcdctl, str(case.run / 'etcdctl'))
            self.assertEqual(case.data['launcher_before'], {'namespace': 'mx-internal-shadow'})
            unit_after = base64.b64decode(case.data['unit_after'])
            candidate_after = json.loads(base64.b64decode(case.data['candidate_after']))
            self.assertIn(b'RequiresMountsFor=/private/runtime-data /var/lib/kubelet /var/lib/mx-launcher\n', unit_after)
            self.assertIn(b'/usr/local/lib/mx-k8s-runtime/storage_guard.py', unit_after)
            self.assertEqual(candidate_after['unit_sha256'], cutover.digest(unit_after))
            case.host.run.assert_called_once_with(['sync', '-f', case.run], 180)
            self.assertFalse(case.data['may_write'])
            self.assertNotIn('blocked_record', case.data)
            self.assertNotIn('pg_shutdown', case.data)
            self.assertEqual(case.data['preparation_step'], 'flush')
            self.assertNotIn('preparation_failure', case.data)

    def failed(self, case, step, reason, exit_code=None, error_number=None):
        with self.assertRaises(cutover.prep.Refuse) as caught:
            case.host.prepare(case.data)
        message = str(caught.exception)
        report = json.loads(message.split('preparation_diagnostics=', 1)[1])
        fields = {'schema_version', 'step', 'reason', 'exit_code', 'errno', 'locations'}
        if step == 'kubernetes-backup' and reason == 'copy_failed':
            fields.update(('copy_errors', 'copy_error_count', 'copy_errors_truncated'))
        self.assertEqual(set(report), fields)
        self.assertEqual(report['schema_version'], 1)
        self.assertEqual(report['step'], step)
        self.assertEqual(report['reason'], reason)
        self.assertEqual(report['exit_code'], exit_code)
        self.assertEqual(report['errno'], error_number)
        self.assertEqual(case.data['preparation_failure'], report)
        self.assertEqual(case.data['preparation_step'], step)
        self.assertNotIn('private-', message)
        self.assertNotIn(str(case.run), message)
        self.assertTrue(0 < len(report['locations']) <= 3)
        for location in report['locations']:
            self.assertEqual(set(location), {'module', 'line'})
            self.assertIn(location['module'], ('k8s/cutover.py', 'etcd/move.py'))
            self.assertIs(type(location['line']), int)
            self.assertGreater(location['line'], 0)
        case.host.run.assert_not_called()
        self.assertFalse(case.data['may_write'])
        self.assertNotIn('snapshot_sha256', case.data)
        self.assertNotIn('launcher_before', case.data)
        self.assertNotIn('dropin', case.data)
        return report

    def test_tool_copy_io_error_is_safe_and_stops_before_kubernetes_backup(self):
        with self.fixture() as case:
            case.copies.side_effect = PermissionError(13, 'private-error', '/private-source')
            self.failed(case, 'etcd-tool-backup', 'filesystem_error', error_number=13)
            self.assertEqual(len(case.data['files']), 6)
            case.trees.assert_not_called()
            case.host.etcd.ctl.assert_not_called()
            self.assertEqual(case.host.etcd.etcdctl, str(case.original_tool))

    def test_partial_kubernetes_tree_failure_reports_no_source_paths_or_contents(self):
        with self.fixture() as case:
            def fail_copy(source, destination):
                Path(destination).mkdir(mode=0o700)
                raise shutil.Error([('/private-source', '/private-target', 'private-copy-error')])
            case.trees.side_effect = fail_copy
            report = self.failed(case, 'kubernetes-backup', 'copy_failed')
            self.assertEqual(report['copy_errors'], [{'path': 'unknown', 'errno': None,
                                                       'reason': 'unclassified_copy_error'}])
            self.assertEqual(report['copy_error_count'], 1)
            self.assertFalse(report['copy_errors_truncated'])
            self.assertTrue((case.run / 'etcdctl').is_file())
            self.assertTrue((case.run / 'kubernetes.before').is_dir())
            self.assertFalse((case.run / 'snapshot.db').exists())
            case.host.etcd.ctl.assert_not_called()
            case.host.etcd.launcher_check.assert_not_called()

    def test_snapshot_command_failure_keeps_backend_output_and_program_private(self):
        for kind, reason, code in [('exit', 'command_exit', 1), ('exec', 'command_unavailable', None),
                                   ('timeout', 'command_timeout', None)]:
            with self.subTest(kind=kind), self.fixture() as case:
                case.host.etcd.ctl.side_effect = case.backend.CommandFailed(
                    '/private-etcdctl', code, output=b'private-command-output', kind=kind)
                with mock.patch.object(case.backend, 'verify_snapshot') as verify:
                    self.failed(case, 'etcd-snapshot-save', reason, exit_code=code)
                verify.assert_not_called()
                self.assertFalse((case.run / 'snapshot.db').exists())
                case.host.etcd.launcher_check.assert_not_called()

    def test_snapshot_guard_rejection_retains_snapshot_without_leaking_error(self):
        with self.fixture() as case:
            with mock.patch.object(case.backend, 'verify_snapshot', side_effect=case.backend.Refuse('private-validation-error')):
                self.failed(case, 'etcd-snapshot-verify', 'etcd_guard_rejected')
            self.assertEqual((case.run / 'snapshot.db').read_bytes(), case.snapshot)
            self.assertEqual(stat.S_IMODE((case.run / 'snapshot.db').stat().st_mode), 0o600)
            case.host.etcd.launcher_check.assert_not_called()

    def test_instance_config_missing_endpoint_fails_before_any_file_copy(self):
        with self.fixture() as case:
            case.files['/var/lib/kubelet/instance-config.yaml'] = b'# private-instance-config\n'
            self.failed(case, 'endpoint-plan', 'invalid_data_or_api')
            case.copies.assert_not_called()
            case.trees.assert_not_called()
            case.host.etcd.ctl.assert_not_called()


if __name__ == '__main__':
    unittest.main()
