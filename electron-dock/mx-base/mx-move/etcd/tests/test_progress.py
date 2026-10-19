"""Progress output tests: no privileged commands, mounts or cluster access."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1]))
SPEC = importlib.util.spec_from_file_location(
    'mx_move_progress_tested', Path(__file__).parents[1] / 'move.py')
move = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(move)


class HeartbeatOutput(io.StringIO):
    """Release a simulated long operation only after observing a heartbeat."""
    def __init__(self):
        super().__init__()
        self.heartbeat = threading.Event()

    def write(self, text):
        result = super().write(text)
        if '仍在执行' in text:
            self.heartbeat.set()
        return result


class ProgressTests(unittest.TestCase):
    def test_slow_command_reports_heartbeat_and_stops_thread_on_completion(self):
        stderr, stdout, threads = HeartbeatOutput(), io.StringIO(), []
        original_thread = threading.Thread

        def tracked_thread(*args, **kwargs):
            thread = original_thread(*args, **kwargs)
            threads.append(thread)
            return thread

        def slow_command(args, **kwargs):
            self.assertTrue(stderr.heartbeat.wait(2), 'operation received no progress heartbeat')
            return subprocess.CompletedProcess(args, 0, b'result-bytes', b'private-child-stderr')

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                mock.patch.object(move.threading, 'Thread', side_effect=tracked_thread), \
                mock.patch.object(move.subprocess, 'run', side_effect=slow_command):
            with move.progress('测试冷副本复制', interval=0.01):
                result = move.run(['copy-tool', '--token=private-command-argument'], timeout=77)
            final_output = stderr.getvalue()
            # Join is required before leaving the context: no timing-based sleep
            # is needed to establish that no heartbeat writer can survive it.
            self.assertTrue(threads)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertEqual(stderr.getvalue(), final_output)

        self.assertEqual(result, b'result-bytes')
        self.assertEqual(stdout.getvalue(), '')
        self.assertIn('测试冷副本复制', final_output)
        self.assertIn('仍在执行', final_output)
        self.assertIn('完成', final_output)
        self.assertRegex(final_output, r'\d+(?:\.\d+)?\s*(?:秒|s)')
        for secret in ['result-bytes', 'private-child-stderr', 'private-command-argument', 'copy-tool']:
            self.assertNotIn(secret, final_output)

    def test_command_failure_keeps_private_output_and_failure_details(self):
        stderr, stdout = io.StringIO(), io.StringIO()
        result = subprocess.CompletedProcess([], 7, b'private-stdout', b'private-stderr')
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                mock.patch.object(move.subprocess, 'run', return_value=result) as execute:
            with self.assertRaises(move.CommandFailed) as caught:
                with move.progress('测试校验', interval=60):
                    move.run(['verify-tool', '--credential=private-argument'], timeout=123,
                             input_data=b'private-input')
        self.assertEqual(caught.exception.returncode, 7)
        self.assertEqual(caught.exception.output, b'private-stderr\nprivate-stdout')
        self.assertEqual(caught.exception.kind, 'exit')
        self.assertEqual(stdout.getvalue(), '')
        self.assertIn('测试校验', stderr.getvalue())
        self.assertIn('未完成', stderr.getvalue())
        for secret in ['private-stdout', 'private-stderr', 'private-argument', 'private-input', 'verify-tool']:
            self.assertNotIn(secret, stderr.getvalue())
        # Progress is outside run(); it must not alter subprocess's established
        # timeout, input, or output-capture contract.
        execute.assert_called_once_with(
            ['verify-tool', '--credential=private-argument'], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=123, input=b'private-input')

    def test_exceptions_including_keyboard_interrupt_are_reraised_unchanged(self):
        for exception in [move.Refuse('private-refusal'), KeyboardInterrupt('private-interrupt')]:
            with self.subTest(exception=type(exception).__name__):
                stderr, threads = io.StringIO(), []
                original_thread = threading.Thread

                def tracked_thread(*args, **kwargs):
                    thread = original_thread(*args, **kwargs)
                    threads.append(thread)
                    return thread

                with contextlib.redirect_stderr(stderr), \
                        mock.patch.object(move.threading, 'Thread', side_effect=tracked_thread):
                    with self.assertRaises(type(exception)) as caught:
                        with move.progress('测试中断', interval=60):
                            raise exception
                self.assertIs(caught.exception, exception)
                self.assertTrue(threads)
                self.assertTrue(all(not thread.is_alive() for thread in threads))
                self.assertIn('测试中断', stderr.getvalue())
                self.assertIn('未完成', stderr.getvalue())
                self.assertNotIn('private-refusal', stderr.getvalue())
                self.assertNotIn('private-interrupt', stderr.getvalue())

    def test_subprocess_timeout_is_not_swallowed_or_logged_raw(self):
        stderr = io.StringIO()
        expired = subprocess.TimeoutExpired(['secret-tool', '--secret'], 17,
                                            output=b'secret-output', stderr=b'secret-stderr')
        with contextlib.redirect_stderr(stderr), \
                mock.patch.object(move.subprocess, 'run', side_effect=expired):
            with self.assertRaises(move.CommandFailed) as caught:
                with move.progress('测试等待超时', interval=60):
                    move.run(['secret-tool', '--secret'], timeout=17)
        self.assertEqual(caught.exception.kind, 'timeout')
        self.assertIn('未完成', stderr.getvalue())
        self.assertNotIn('secret', stderr.getvalue())

    def test_closed_or_broken_log_stream_does_not_interrupt_operation(self):
        class BrokenPipe(io.StringIO):
            def write(self, text):
                raise BrokenPipeError('log consumer exited')

        closed = io.StringIO()
        closed.close()
        for stream in [closed, BrokenPipe()]:
            with self.subTest(stream=type(stream).__name__):
                completed = []
                with contextlib.redirect_stderr(stream):
                    with move.progress('测试输出断开', interval=60):
                        completed.append(True)
                self.assertEqual(completed, [True])

    def test_unavailable_heartbeat_thread_does_not_block_migration_or_recovery(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), mock.patch.object(move.threading, 'Thread') as factory:
            factory.return_value.start.side_effect = RuntimeError('cannot create thread')
            with move.progress('测试恢复', interval=60):
                result = 'operation completed'
            factory.return_value.join.assert_not_called()
        self.assertEqual(result, 'operation completed')
        self.assertIn('周期提示不可用', stderr.getvalue())
        self.assertIn('测试恢复：完成', stderr.getvalue())

    def test_plan_and_status_keep_json_stdout_even_with_progress(self):
        facts = {'source': '/source', 'target_root': '/target', 'space': {'reserve_gib': 50}}
        journal = {'direction': 'migrate', 'phase': 'complete', 'may_write': True,
                   'source': '/source', 'target': '/target/generation', 'origin': '/source',
                   'run': '/state/run', 'changed_business_containers': 1,
                   'private_field': 'not-for-status'}
        status_keys = ['direction', 'phase', 'may_write', 'source', 'target', 'origin',
                       'run', 'changed_business_containers']
        for action, result in [('plan', facts), ('status', journal)]:
            with self.subTest(action=action):
                stdout, stderr = io.StringIO(), io.StringIO()

                def read_only_step(*args, **kwargs):
                    with move.progress('测试只读检查', interval=60):
                        return result

                with mock.patch.object(move, 'Host'), mock.patch.object(move, 'Move') as move_class, \
                        mock.patch.object(move.sys, 'platform', 'linux'), \
                        mock.patch.object(move.os, 'geteuid', return_value=0), \
                        mock.patch.object(move.os, 'umask'), \
                        mock.patch.object(move, 'locks', side_effect=AssertionError('read-only action locked')), \
                        contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    transaction = move_class.return_value
                    transaction.plan.side_effect = read_only_step
                    transaction.load.side_effect = read_only_step
                    move.main(['etcd', action])
                    transaction.execute.assert_not_called()
                    transaction.recover.assert_not_called()
                expected = facts if action == 'plan' else {key: journal[key] for key in status_keys}
                self.assertEqual(json.loads(stdout.getvalue()), expected)
                self.assertIn('测试只读检查', stderr.getvalue())
                self.assertNotIn('测试只读检查', stdout.getvalue())
                self.assertNotIn('not-for-status', stdout.getvalue())


if __name__ == '__main__':
    unittest.main()
