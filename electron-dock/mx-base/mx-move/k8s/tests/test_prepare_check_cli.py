"""Preparation diagnostics must never become a migration or replace recovery state."""
from contextlib import contextmanager, ExitStack, redirect_stdout
import io
import json
from pathlib import Path
import stat
import subprocess
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


OLD_TRANSACTION = 'mx-k8s-20261020-043136-47c1e44e'


class PrepareCheckCliTests(unittest.TestCase):
    @contextmanager
    def fixture(self, current_phase=None):
        with tempfile.TemporaryDirectory(prefix='mx-prepare-check-cli-') as directory, ExitStack() as stack:
            base = Path(directory)
            current = base / 'current.json'
            old_path = base / OLD_TRANSACTION / 'journal.json'
            original = {}
            if current_phase is not None:
                old_path.parent.mkdir(mode=0o700)
                old = {'schema_version': 1, 'phase': current_phase, 'transaction': OLD_TRANSACTION,
                       'run': str(old_path.parent), 'may_write': current_phase == 'committed',
                       'old_recovery_data': 'preserve-this-private-record'}
                old_path.write_bytes(cutover.raw_json(old))
                current.write_bytes(cutover.raw_json({'transaction': OLD_TRANSACTION}))
                for path in (current, old_path):
                    path.chmod(0o600)
                    original[path] = (path.read_bytes(), path.stat().st_mtime_ns)
            state = SimpleNamespace(locked=False, created=None, writes=[], prepared=None)

            @contextmanager
            def locks():
                self.assertFalse(state.locked)
                state.locked = True
                try:
                    yield
                finally:
                    state.locked = False

            def preflight(transaction):
                self.assertTrue(state.locked)
                self.assertNotEqual(transaction, OLD_TRANSACTION)
                state.created = base / transaction
                return {'schema_version': 1, 'phase': 'preparing', 'transaction': transaction,
                        'run': str(state.created), 'may_write': False,
                        'storage': {'entries': [{'logical': '/var/lib/kubelet'}]}}

            def private_directory(path, create=False):
                self.assertTrue(state.locked)
                self.assertTrue(create)
                self.assertEqual(Path(path), state.created)
                Path(path).mkdir(mode=0o700)

            def replace(path, desired, before, mode=0o600):
                # Reject writes to CURRENT, the old transaction, or any host path.
                self.assertTrue(state.locked)
                self.assertEqual(Path(path), state.created / 'journal.json')
                self.assertEqual(mode, 0o600)
                existing = Path(path).read_bytes() if Path(path).exists() else None
                self.assertEqual(existing, before)
                Path(path).write_bytes(desired)
                Path(path).chmod(mode)
                state.writes.append(json.loads(desired))

            def prepare(journal):
                self.assertTrue(state.locked)
                state.prepared = journal
                self.assertEqual(json.loads((state.created / 'journal.json').read_bytes()), journal)
                journal['preparation_step'] = 'flush'

            host = mock.Mock()
            host.preflight.side_effect = preflight
            host.prepare.side_effect = prepare
            stack.enter_context(mock.patch.object(cutover, 'BASE', base))
            stack.enter_context(mock.patch.object(cutover, 'CURRENT', current))
            stack.enter_context(mock.patch.object(cutover, 'Host', return_value=host))
            stack.enter_context(mock.patch.object(cutover, 'locks', side_effect=locks))
            stack.enter_context(mock.patch.object(cutover, 'replace_file', side_effect=replace))
            stack.enter_context(mock.patch.object(cutover.prep, 'secure_directory', side_effect=private_directory))
            stack.enter_context(mock.patch.object(cutover.prep, 'progress'))
            stack.enter_context(mock.patch.object(cutover.prep, 'stage'))
            stack.enter_context(mock.patch.object(cutover.candidate_guard, 'safe'))
            stack.enter_context(mock.patch.object(cutover.os, 'geteuid', return_value=0))
            stack.enter_context(mock.patch.object(cutover.os, 'umask'))
            stack.enter_context(mock.patch.object(cutover.sys, 'platform', 'linux'))
            execute = stack.enter_context(mock.patch.object(cutover.Move, 'execute', side_effect=AssertionError('migration executed')))
            resume = stack.enter_context(mock.patch.object(cutover.Move, 'resume', side_effect=AssertionError('recovery executed')))
            yield SimpleNamespace(base=base, current=current, original=original, host=host,
                                  state=state, execute=execute, resume=resume)
            execute.assert_not_called()
            resume.assert_not_called()
            self.assertFalse(state.locked)
            for path, (raw, mtime) in original.items():
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(path.stat().st_mtime_ns, mtime)
            if current_phase is None:
                self.assertFalse(current.exists())

    def invoke(self):
        output = io.StringIO()
        with redirect_stdout(output):
            cutover.main(['prepare-check'])
        return json.loads(output.getvalue())

    def test_success_saves_private_diagnostic_transaction_without_publishing_current(self):
        for prior in (None, 'aborted'):
            with self.subTest(prior=prior), self.fixture(prior) as case:
                report = self.invoke()
                self.assertEqual(report['phase'], 'preparation-checked')
                self.assertFalse(report['may_write'])
                self.assertFalse(report['execution_started'])
                self.assertFalse(report['service_changes'])
                self.assertEqual(report['preparation_step'], 'flush')
                self.assertEqual([value['phase'] for value in case.state.writes],
                                 ['preparing', 'preparation-checked'])
                self.assertEqual([call[0] for call in case.host.mock_calls], ['preflight', 'prepare'])
                self.assertEqual(stat.S_IMODE(case.state.created.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE((case.state.created / 'journal.json').stat().st_mode), 0o600)

    def test_failure_saves_safe_diagnostics_without_service_actions_or_replacing_old_recovery(self):
        diagnostic = {'schema_version': 1, 'step': 'etcd-snapshot-save', 'reason': 'command_exit',
                      'exit_code': 1, 'errno': None, 'locations': []}
        with self.fixture('aborted') as case:
            def fail(journal):
                journal.update(preparation_step=diagnostic['step'], preparation_failure=diagnostic)
                raise cutover.prep.Refuse('preparation_diagnostics=' + json.dumps(diagnostic))
            case.host.prepare.side_effect = fail
            with self.assertRaises(cutover.prep.Refuse) as error:
                self.invoke()
            saved = json.loads((case.state.created / 'journal.json').read_bytes())
            self.assertEqual(saved['phase'], 'preparation-failed')
            self.assertEqual(saved['preparation_failure'], diagnostic)
            self.assertFalse(saved['may_write'])
            self.assertEqual([call[0] for call in case.host.mock_calls], ['preflight', 'prepare'])
            self.assertEqual(json.loads(str(error.exception).split('=', 1)[1]), diagnostic)

    def test_interruption_is_recorded_without_attempting_abort_or_resume(self):
        with self.fixture('aborted') as case:
            case.host.prepare.side_effect = KeyboardInterrupt()
            with self.assertRaises(KeyboardInterrupt):
                self.invoke()
            self.assertEqual(case.state.writes[-1]['phase'], 'preparation-failed')
            self.assertFalse(case.state.writes[-1]['may_write'])
            self.assertEqual([call[0] for call in case.host.mock_calls], ['preflight', 'prepare'])

    def test_existing_active_transaction_refuses_before_preflight_or_new_artifacts(self):
        for phase in ('preparing', 'quiescing', 'committed', 'services-restored'):
            with self.subTest(phase=phase), self.fixture(phase) as case:
                with self.assertRaises(cutover.prep.Refuse):
                    self.invoke()
                self.assertEqual(case.host.mock_calls, [])
                self.assertIsNone(case.state.created)
                self.assertEqual(case.state.writes, [])
                self.assertEqual(set(path.name for path in case.base.iterdir()),
                                 {'current.json', OLD_TRANSACTION})

    def test_failed_preflight_never_creates_diagnostic_artifacts_or_runs_preparation(self):
        with self.fixture('aborted') as case:
            case.host.preflight.side_effect = cutover.prep.Refuse('preflight rejected')
            with self.assertRaises(cutover.prep.Refuse):
                self.invoke()
            case.host.prepare.assert_not_called()
            self.assertEqual(case.state.writes, [])
            self.assertEqual(set(path.name for path in case.base.iterdir()),
                             {'current.json', OLD_TRANSACTION})

    def test_both_manage_entrypoints_route_prepare_check_help_without_host_access(self):
        module = Path(__file__).parents[2]
        for script in (module / 'scripts/manage.sh', module.parent / 'scripts/manage.sh'):
            with self.subTest(script=str(script)):
                result = subprocess.run(['bash', str(script), 'k8s', 'prepare-check', '--help'],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(b'cutover-check,prepare-check,migrate', result.stdout)
                self.assertNotIn('未知应用'.encode(), result.stderr)


if __name__ == '__main__':
    unittest.main()
