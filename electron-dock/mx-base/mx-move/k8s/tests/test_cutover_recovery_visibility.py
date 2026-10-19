"""Recovery diagnostics remain private and cannot prevent original-side recovery."""
from contextlib import ExitStack
import copy
import json
import subprocess
import unittest
from unittest import mock

from test_cutover import cutover, DurableJournal, FakeHost, InjectedFailure, JOURNAL_PATH, journal


class RecoveryVisibilityTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.durable = DurableJournal()
        self.replace = self.stack.enter_context(
            mock.patch.object(cutover, 'replace_file', side_effect=self.durable.replace))
        self.stack.enter_context(mock.patch.object(cutover.prep, 'secure_directory'))
        self.stage = self.stack.enter_context(mock.patch.object(cutover.prep, 'stage'))
        self.stack.enter_context(mock.patch.object(cutover.prep, 'progress'))
        self.host = FakeHost(self.durable)
        self.move = cutover.Move(self.host, JOURNAL_PATH)

    def assert_private(self, value):
        encoded = json.dumps(value, ensure_ascii=True)
        self.assertNotIn('secret', encoded)
        self.assertNotIn('/private/', encoded)

    def test_failure_and_recovery_status_are_durable_before_abort_without_changing_phase(self):
        phases = [('prepare', 'preparing'), ('quiesce', 'quiescing'),
                  ('stop-old', 'stopping'), ('copy-common', 'copying'),
                  ('install-configuration', 'switching')]
        for failure, phase in phases:
            with self.subTest(phase=phase):
                self.durable.raw, self.durable.revisions = None, []
                host = FakeHost(self.durable)
                host.fail_at = failure
                move = cutover.Move(host, JOURNAL_PATH)
                original_abort = host.abort

                def inspect_abort(value):
                    stored = self.durable.read()
                    self.assertEqual(stored['phase'], phase)
                    self.assertEqual(value['phase'], phase)
                    self.assertEqual(stored['recovery_status'], 'restoring-original')
                    self.assertEqual(stored['failure_diagnostics']['phase'], phase)
                    self.assertEqual(stored['failure_diagnostics'], value['failure_diagnostics'])
                    original_abort(value)

                host.abort = mock.Mock(side_effect=inspect_abort)
                with self.assertRaises(InjectedFailure):
                    move.execute(journal())
                host.abort.assert_called_once()
                stored = self.durable.read()
                self.assertEqual(stored['phase'], 'aborted')
                self.assertEqual(stored['recovery_status'], 'restored')
                self.assertEqual(stored['failure_diagnostics']['phase'], phase)
                self.assertEqual(cutover.summary(stored)['failure_diagnostics'], stored['failure_diagnostics'])

    def test_abort_failure_retains_original_error_and_records_incomplete_recovery(self):
        original = OSError(13, 'secret original error', '/private/database')
        recovery = RuntimeError('secret recovery error /private/config')
        self.host.storage.cold_copy = mock.Mock(side_effect=original)
        original_abort = self.host.abort
        self.host.abort = mock.Mock(side_effect=recovery)
        with self.assertRaises(OSError) as caught:
            self.move.execute(journal())
        self.assertIs(caught.exception, original)
        stored = self.durable.read()
        self.assertEqual(stored['phase'], 'copying')
        self.assertEqual(stored['recovery_status'], 'incomplete')
        self.assertEqual(stored['failure_diagnostics']['reason'], 'filesystem_error')
        self.assertEqual(stored['failure_diagnostics']['errno'], 13)
        self.assertEqual(stored['recovery_diagnostics']['reason'], 'unexpected_error')
        self.assertEqual(stored['recovery_diagnostics']['phase'], 'copying')
        self.assert_private(cutover.summary(stored))
        self.assert_private([str(call[0][0]) for call in self.stage.call_args_list])
        self.host.abort = original_abort
        restarted = cutover.Move(self.host, JOURNAL_PATH)
        restarted.journal, restarted.previous = stored, self.durable.raw
        restarted.resume()
        restored = self.durable.read()
        self.assertEqual(restored['phase'], 'aborted')
        self.assertEqual(restored['recovery_status'], 'restored')
        self.assertEqual(restored['failure_diagnostics'], stored['failure_diagnostics'])

    def test_diagnostic_write_failure_never_prevents_abort(self):
        self.host.fail_at = 'quiesce'
        self.stage.side_effect = BrokenPipeError(32, 'secret closed log /private/stderr')
        failed = []

        def replace(path, desired, before, mode=0o600):
            record = json.loads(desired)
            if record.get('recovery_status') == 'restoring-original' and not failed:
                failed.append(True)
                raise OSError(28, 'secret diagnostic disk failure', '/private/journal')
            return self.durable.replace(path, desired, before, mode)

        self.replace.side_effect = replace
        with self.assertRaises(InjectedFailure):
            self.move.execute(journal())
        self.assertEqual(failed, [True])
        self.assertEqual(self.host.events.count('abort'), 1)
        self.assertTrue(self.host.original_writers)
        self.assertFalse(self.host.new_writers)
        self.assertEqual(self.durable.read()['phase'], 'aborted')
        self.assertEqual(self.durable.read()['recovery_status'], 'restored')
        self.assert_private([str(call[0][0]) for call in self.stage.call_args_list])

    def test_closed_log_output_cannot_skip_abort_or_replace_original_error(self):
        for abort_fails in (False, True):
            with self.subTest(abort_fails=abort_fails):
                self.durable.raw, self.durable.revisions = None, []
                host = FakeHost(self.durable)
                original = OSError(5, 'secret copy error', '/private/source')
                host.storage.cold_copy = mock.Mock(side_effect=original)
                host.abort_failure = abort_fails
                self.stage.side_effect = BrokenPipeError(32, 'secret closed log /private/stderr')
                move = cutover.Move(host, JOURNAL_PATH)
                with self.assertRaises(OSError) as caught:
                    move.execute(journal())
                self.assertIs(caught.exception, original)
                self.assertEqual(host.events.count('abort'), 1)
                stored = self.durable.read()
                self.assertEqual(stored['recovery_status'], 'incomplete' if abort_fails else 'restored')
                self.assertEqual(stored['phase'], 'copying' if abort_fails else 'aborted')
                self.assertEqual(stored['failure_diagnostics']['reason'], 'filesystem_error')
                if not abort_fails:
                    self.assertTrue(host.original_writers)
                self.assert_private(cutover.summary(stored))

    def test_progress_startup_or_cleanup_failure_cannot_prevent_or_invalidate_recovery(self):
        for failure in ('enter', 'exit'):
            with self.subTest(failure=failure):
                self.durable.raw, self.durable.revisions = None, []
                host = FakeHost(self.durable)
                original = OSError(5, 'secret copy error', '/private/source')
                host.storage.cold_copy = mock.Mock(side_effect=original)
                move = cutover.Move(host, JOURNAL_PATH)

                def progress(label):
                    manager = mock.MagicMock()
                    if label.startswith('恢复原 Kubernetes'):
                        method = manager.__enter__ if failure == 'enter' else manager.__exit__
                        method.side_effect = BrokenPipeError(32, 'secret progress /private/stderr')
                    return manager

                with mock.patch.object(cutover.prep, 'progress', side_effect=progress):
                    with self.assertRaises(OSError) as caught:
                        move.execute(journal())
                self.assertIs(caught.exception, original)
                self.assertEqual(host.events.count('abort'), 1)
                self.assertTrue(host.original_writers)
                stored = self.durable.read()
                self.assertEqual(stored['phase'], 'aborted')
                self.assertEqual(stored['recovery_status'], 'restored')
                self.assertNotIn('recovery_diagnostics', stored)

    def test_keyboard_interrupt_still_restores_original_services(self):
        original = KeyboardInterrupt('secret interruption /private/path')
        self.host.cluster.quiesce = mock.Mock(side_effect=original)
        with self.assertRaises(KeyboardInterrupt) as caught:
            self.move.execute(journal())
        self.assertIs(caught.exception, original)
        self.assertEqual(self.host.events.count('abort'), 1)
        self.assertTrue(self.host.original_writers)
        stored = self.durable.read()
        self.assertEqual(stored['phase'], 'aborted')
        self.assertEqual(stored['recovery_status'], 'restored')
        self.assertEqual(stored['failure_diagnostics']['reason'], 'interrupted')
        self.assertEqual(stored['failure_diagnostics']['phase'], 'quiescing')
        self.assert_private(cutover.summary(stored))

    def test_uncertain_commit_does_not_add_diagnostic_writes_or_abort(self):
        for failure, durable_phase in [('before-write', 'switching'), ('after-write', 'committed')]:
            with self.subTest(failure=failure):
                self.durable.raw, self.durable.revisions = None, []
                self.durable.fail_commit = failure
                host = FakeHost(self.durable)
                move = cutover.Move(host, JOURNAL_PATH)
                with self.assertRaises(InjectedFailure):
                    move.execute(journal())
                self.assertEqual(self.durable.read()['phase'], durable_phase)
                self.assertNotIn('abort', host.events)
                for revision in self.durable.revisions:
                    self.assertNotIn('failure_diagnostics', revision)
                    self.assertNotIn('recovery_diagnostics', revision)
                    self.assertNotIn('recovery_status', revision)

    def test_failure_projection_uses_fixed_categories_and_never_raw_exception_data(self):
        cases = [
            (KeyboardInterrupt('secret'), 'interrupted', None, None),
            (SystemExit('/private/secret'), 'interrupted', None, None),
            (cutover.cluster_ops.ClusterError('secret /private/cluster'), 'cluster_guard_rejected', None, None),
            (cutover.prep.Refuse('secret /private/guard'), 'guard_rejected', None, None),
            (subprocess.TimeoutExpired(['/private/secret'], 30, output=b'secret'), 'command_timeout', None, None),
            (subprocess.CalledProcessError(7, ['/private/secret'], output=b'secret', stderr=b'secret'),
             'command_exit', 7, None),
            (OSError(13, 'secret', '/private/source'), 'filesystem_error', None, 13),
            (ValueError('secret /private/value'), 'invalid_data_or_api', None, None),
            (RuntimeError('secret /private/unexpected'), 'unexpected_error', None, None),
        ]
        for error, reason, exit_code, number in cases:
            with self.subTest(reason=reason, exception=type(error).__name__):
                value = cutover.failure_diagnostic(error, '/private/secret-phase')
                self.assertEqual(value, {'schema_version': 1, 'phase': 'unknown', 'reason': reason,
                                         'exit_code': exit_code, 'errno': number, 'locations': []})
                self.assertEqual(cutover.public_failure_diagnostic(value), value)
                self.assert_private(value)

    def test_summary_omits_malformed_diagnostics_and_unknown_recovery_status(self):
        valid = cutover.failure_diagnostic(RuntimeError(), 'copying')
        bad_values = [None, 'secret /private/raw', [], {},
                      dict(valid, raw='secret /private/raw'), dict(valid, schema_version=True),
                      dict(valid, phase='/private/secret'), dict(valid, reason='secret'),
                      dict(valid, exit_code=True), dict(valid, errno='13'),
                      dict(valid, locations={'secret': '/private/location'}),
                      dict(valid, locations=[{'module': 'k8s/cutover.py', 'line': 1}] * 4),
                      dict(valid, locations=[{'module': '/private/secret', 'line': 1}]),
                      dict(valid, locations=[{'module': 'k8s/cutover.py', 'line': True}]),
                      dict(valid, locations=[{'module': 'k8s/cutover.py', 'line': 0}]),
                      dict(valid, locations=[{'module': 'k8s/cutover.py', 'line': 100001}]),
                      dict(valid, locations=[{'module': 'k8s/cutover.py', 'line': 3, 'raw': 'secret'}])]
        for bad in bad_values:
            with self.subTest(value=bad):
                self.assertIsNone(cutover.public_failure_diagnostic(bad))
                data = journal()
                data.update(failure_diagnostics=bad, recovery_diagnostics=bad,
                            recovery_status='/private/secret-state')
                value = cutover.summary(data)
                for key in ('failure_diagnostics', 'recovery_diagnostics', 'recovery_status'):
                    self.assertNotIn(key, value)
                self.assert_private(value)

    def test_valid_public_diagnostic_is_an_independent_projection(self):
        value = cutover.failure_diagnostic(RuntimeError(), 'copying')
        value['locations'] = [{'module': 'k8s/cutover.py', 'line': 123}]
        original = copy.deepcopy(value)
        public = cutover.public_failure_diagnostic(value)
        public['locations'][0]['line'] = 456
        self.assertEqual(value, original)


if __name__ == '__main__':
    unittest.main()
