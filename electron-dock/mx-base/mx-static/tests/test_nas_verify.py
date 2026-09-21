"""Actual local file hashes/races; no production Docker, NAS or service calls."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import verify


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.target = self.root / 'target'
        (self.source / 'video').mkdir(parents=True)
        (self.source / 'empty').mkdir()
        (self.source / 'video/a.bin').write_bytes(b'video' * 1024)
        (self.source / 'video/raw-media-retain.tmp').write_bytes(b'tmp is data')
        shutil.copytree(str(self.source), str(self.target))
        self.source_fd = os.open(str(self.source), verify.DIR_FLAGS)
        self.target_fd = os.open(str(self.target), verify.DIR_FLAGS)

    def tearDown(self):
        os.close(self.source_fd)
        os.close(self.target_fd)
        self.temp.cleanup()

    def run_check(self):
        stream = io.BytesIO()
        report = verify.Report(stream)
        with contextlib.redirect_stdout(io.StringIO()):
            verify.verify_trees(self.source_fd, self.target_fd, report)
        rows = [json.loads(line) for line in stream.getvalue().splitlines()]
        return report, rows

    def test_equal_files_all_hashed_including_tmp_and_empty_directories(self):
        before = {p.relative_to(self.source): p.read_bytes() for p in self.source.rglob('*') if p.is_file()}
        report, rows = self.run_check()
        self.assertEqual(report.counts['issues'], 0)
        self.assertEqual(report.counts['matched_files'], 2)
        self.assertEqual(report.counts['hashed_source_bytes'], sum(len(v) for v in before.values()))
        self.assertEqual(report.counts['hashed_target_bytes'], report.counts['hashed_source_bytes'])
        self.assertTrue(any(row.get('path') == 'empty' and row['kind'] == 'directory' for row in rows))
        for row in rows:
            if row['kind'] == 'file':
                self.assertEqual(row['source_sha256'], hashlib.sha256(before[Path(row['path'])]).hexdigest())
                self.assertEqual(row['source_sha256'], row['target_sha256'])
        self.assertEqual(before, {p.relative_to(self.source): p.read_bytes() for p in self.source.rglob('*') if p.is_file()})

    def test_same_size_same_mtime_corruption_is_detected(self):
        path = self.target / 'video/a.bin'
        saved = path.stat()
        path.write_bytes(b'x' * saved.st_size)
        os.utime(str(path), ns=(saved.st_atime_ns, saved.st_mtime_ns))
        report, rows = self.run_check()
        self.assertGreater(report.counts['issues'], 0)
        self.assertTrue(any(row.get('reason') == 'content_differs' for row in rows))
        self.assertEqual(path.read_bytes(), b'x' * saved.st_size)  # No repair.

    def test_missing_extra_partial_and_permission_differences_are_retained(self):
        missing = self.target / 'video/a.bin'
        missing.unlink()
        extra = self.target / '.mx-static-partial-fixture'
        extra.mkdir()
        (extra / 'keep').write_bytes(b'partial')
        (self.target / 'video/raw-media-retain.tmp').chmod(0o600)
        _, rows = self.run_check()
        reasons = {row.get('reason') for row in rows}
        self.assertTrue({'missing_on_nas', 'extra_on_nas', 'file_attributes_differ'} <= reasons)
        self.assertFalse(missing.exists())
        self.assertEqual((extra / 'keep').read_bytes(), b'partial')

    def test_change_during_hash_cannot_pass_even_when_mtime_restored(self):
        original_digest = verify.digest
        path = self.source / 'video/a.bin'
        done = []
        def mutate(fd, size):
            value = original_digest(fd, size)
            if not done:
                saved = path.stat()
                path.write_bytes(b'q' * size)
                os.utime(str(path), ns=(saved.st_atime_ns, saved.st_mtime_ns))
                done.append(True)
            return value
        with patch.object(verify, 'digest', side_effect=mutate):
            report, rows = self.run_check()
        self.assertGreater(report.counts['issues'], 0)
        self.assertTrue(any(row.get('reason') == 'changed_during_hash' for row in rows))

    def test_post_hash_mutation_and_new_file_are_found_by_final_inventory(self):
        original_digest = verify.digest
        calls = []
        def mutate_later(fd, size):
            value = original_digest(fd, size)
            calls.append(True)
            if len(calls) == 4:
                (self.source / 'video/a.bin').write_bytes(b'changed after its hash')
                (self.source / 'video/new.bin').write_bytes(b'new')
            return value
        with patch.object(verify, 'digest', side_effect=mutate_later):
            report, rows = self.run_check()
        self.assertGreater(report.counts['issues'], 0)
        changed = {row['path'] for row in rows if row.get('reason') == 'changed_since_inventory'}
        self.assertTrue({'video/a.bin', 'video/new.bin'} <= changed)

    def test_links_fifo_and_submount_are_never_read(self):
        outside = self.root / 'outside'
        outside.write_bytes(b'must not be read')
        (self.target / 'link').symlink_to(outside)
        os.mkfifo(str(self.target / 'fifo'))
        os.link(str(self.source / 'video/a.bin'), str(self.source / 'hardlink'))
        report, rows = self.run_check()
        self.assertGreater(report.counts['issues'], 0)
        self.assertFalse(any(row['kind'] == 'file' and row['path'] in ('link', 'fifo', 'hardlink', 'video/a.bin') for row in rows))
        baseline = {'': verify.stamp(os.fstat(self.source_fd)),
                    'video': verify.stamp((self.source / 'video').stat()),
                    'video/raw-media-retain.tmp': verify.stamp((self.source / 'video/raw-media-retain.tmp').stat())}
        baseline['']['dev'] += 1
        with self.assertRaisesRegex(RuntimeError, 'expected filesystem'):
            verify.open_file(self.source_fd, 'video/raw-media-retain.tmp', baseline)
        self.assertEqual(outside.read_bytes(), b'must not be read')

    def test_replaced_parent_and_relative_escape_refused(self):
        with contextlib.redirect_stdout(io.StringIO()):
            baseline = verify.inventory(self.target_fd, 'target', verify.Report(io.BytesIO()))
        (self.target / 'video').rename(self.target / 'old-video')
        shutil.copytree(str(self.source / 'video'), str(self.target / 'video'))
        with self.assertRaisesRegex(RuntimeError, 'Parent directory was replaced'):
            verify.open_file(self.target_fd, 'video/a.bin', baseline)
        for path in ('../outside', '/absolute', 'video/../outside'):
            with self.assertRaisesRegex(RuntimeError, 'Unsafe relative path'):
                verify.open_file(self.target_fd, path, baseline)

    def test_hash_named_formal_media_is_also_checked_against_name(self):
        name = '0' * 64 + '.mp4'
        (self.source / name).write_bytes(b'not that hash')
        shutil.copy2(str(self.source / name), str(self.target / name))
        _, rows = self.run_check()
        self.assertTrue(any(row.get('reason') == 'source_hash_filename_differs' for row in rows))

    def test_python36_scandir_fallback_uses_pinned_descriptor_path(self):
        with patch.object(verify.os, 'supports_fd', set()), \
                patch.object(verify, 'descriptor_path', return_value=str(self.source)) as descriptor:
            self.assertEqual(verify.directory_names(self.source_fd), ['empty', 'video'])
        descriptor.assert_called_once_with(self.source_fd)

    def test_interrupted_or_failed_precopy_is_not_accepted(self):
        for state in ({}, {'phase': 'precopy_running', 'last_exit_code': 0},
                      {'phase': 'precopy_pass_complete', 'last_exit_code': 24}):
            with self.assertRaises(RuntimeError):
                verify.require_complete(state)
        verify.require_complete({'phase': 'precopy_pass_complete', 'last_exit_code': 0})

    def test_cli_rejects_destructive_or_unknown_options(self):
        for args in (['unknown', '--verify'], ['po_infra_media_data', '--delete'],
                     ['po_infra_media_data', '--verify', '--copy']):
            result = subprocess.run(['bash', str(ROOT / 'scripts/nas-verify.sh')] + args,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 2)

    def test_report_write_failure_is_not_hidden(self):
        class Broken:
            def write(self, data):
                raise OSError('No space left on device')
        with self.assertRaises(OSError), contextlib.redirect_stdout(io.StringIO()):
            verify.verify_trees(self.source_fd, self.target_fd, verify.Report(Broken()))

    def test_controller_writes_durable_bound_ledger_but_never_readiness(self):
        # Simulate host identity only; actual file reads/report writes/fsync run.
        output = self.root / 'reports'
        output.mkdir(mode=0o700)
        lock_path = self.root / 'lock'
        lock_path.touch(mode=0o600)
        real_open, real_stat, real_fstat = os.open, os.stat, os.fstat
        roots = {self.source.stat().st_ino, self.target.stat().st_ino, lock_path.stat().st_ino}
        def opened(path, *args, **kwargs):
            return real_open(str(lock_path) if path == '/run/lock/mx-static-nas-sample.lock' else path, *args, **kwargs)
        def inspected(path, *args, **kwargs):
            if path == '/dev/nvme0n1p1':
                return SimpleNamespace(st_rdev=real_stat(str(self.source)).st_dev)
            return real_stat(path, *args, **kwargs)
        def fd_info(fd):
            info = real_fstat(fd)
            if info.st_ino not in roots:
                return info
            values = {key: getattr(info, key) for key in dir(info) if key.startswith('st_')}
            values['st_uid'] = 0
            return SimpleNamespace(**values)
        state = {'phase': 'precopy_pass_complete', 'last_exit_code': 0, 'target': str(self.target)}
        def job(*args, **kwargs):
            self.assertFalse(kwargs['create'])
            return os.dup(self.target_fd), os.dup(self.target_fd), dict(state)
        with contextlib.ExitStack() as stack:
            for obj, name, value in ((verify, 'REPORT_ROOT', str(output)),
                                     (verify.sys, 'argv', ['verify.py', 'po_infra_media_data', '--verify']),
                                     (verify.sys, 'platform', 'linux')):
                stack.enter_context(patch.object(obj, name, value))
            for obj, name, kwargs in (
                    (verify.os, 'open', {'side_effect': opened}),
                    (verify.os, 'stat', {'side_effect': inspected}),
                    (verify.os, 'fstat', {'side_effect': fd_info}),
                    (verify.os, 'geteuid', {'return_value': 0}),
                    (verify, 'check_host', {'return_value': None}),
                    (verify, 'checked_root', {'return_value': str(self.source)}),
                    (verify, 'check_consumers', {'side_effect': lambda *a, **kw: ('fixture', []) if kw.get('with_records') else 'fixture'}),
                    (verify, 'open_parent', {'side_effect': lambda: os.dup(self.target_fd)}),
                    (verify, 'open_job', {'side_effect': job}),
                    (verify, 'read_state', {'return_value': state}),
                    (verify, 'open_reports', {'side_effect': lambda: real_open(str(output), verify.DIR_FLAGS)})):
                stack.enter_context(patch.object(obj, name, **kwargs))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            self.assertEqual(verify.main(), 0)
            (self.target / 'video/a.bin').write_bytes(b'corrupt')
            self.assertEqual(verify.main(), 2)
        summaries = list(output.glob('*/result.json'))
        self.assertEqual(len(summaries), 2)
        self.assertEqual({json.loads(p.read_text())['observed_match'] for p in summaries}, {True, False})
        for path in summaries:
            data = json.loads(path.read_text())
            self.assertFalse(data['cutover_ready'])
            self.assertFalse(data['reclaim_ready'])
            self.assertFalse(data['consistent_snapshot'])
            self.assertEqual(data['ledger_sha256'], hashlib.sha256(path.with_name('files.jsonl').read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
