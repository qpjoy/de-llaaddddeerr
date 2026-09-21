"""Temporary local fixtures; no Docker, production files or NAS access."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import sample_copy as sample


def old_file(path, content=b'media fixture', formal=False):
    if formal:
        path = path.parent / (hashlib.sha256(content).hexdigest() + '.mp4')
    path.write_bytes(content)
    os.utime(str(path), (int(time.time()) - 90000,) * 2)
    return path


class SampleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'; self.source.mkdir()
        (self.source / 'video').mkdir()
        self.nas = self.root / 'nas'; self.nas.mkdir()
        self.source_fd = os.open(str(self.source), sample.DIR_FLAGS)
        self.nas_fd = os.open(str(self.nas), sample.DIR_FLAGS)
        self.lock_fd = os.open(str(self.root / 'lock'), os.O_CREAT | os.O_RDWR, 0o600)

    def tearDown(self):
        for fd in (self.source_fd, self.nas_fd, self.lock_fd): os.close(fd)
        self.temp.cleanup()

    def selection(self):
        return sample.select_sample(self.source_fd)

    def run_copy(self, selected, examined):
        with contextlib.redirect_stdout(io.StringIO()):
            return sample.copy_sample('po_infra_media_data', self.source_fd, self.nas_fd,
                                      selected, examined, self.lock_fd)

    def descriptor_for_local_test(self, fd):
        if sys.platform.startswith('linux'):
            return '/proc/{}/fd/{}'.format(os.getpid(), fd)
        # Darwin's /dev/fd supports the source file but not directory traversal.
        # Only substitute the new temporary output directory in this test.
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            return str(next(self.nas.glob('.mx-static-copy-check-*')))
        return '/dev/fd/' + str(fd)

    @unittest.skipUnless(shutil.which('rsync'), 'rsync unavailable')
    def test_real_rsync_roundtrip_retains_source_and_sample(self):
        formal = old_file(self.source / 'video/formal', formal=True)
        temporary = old_file(self.source / 'video/raw-media-fixture.tmp', b'partial old fixture')
        before = {p: (p.read_bytes(), sample.signature(p.stat())) for p in (formal, temporary)}
        with patch.object(sample, 'descriptor_path', side_effect=self.descriptor_for_local_test):
            result = self.run_copy(*self.selection())
        self.assertTrue(result['passed'], result)
        self.assertEqual(len(result['files']), 2)
        for path, expected in before.items():
            self.assertEqual((path.read_bytes(), sample.signature(path.stat())), expected)
        directory = next(self.nas.iterdir())
        self.assertTrue(json.loads((directory / 'result.json').read_text())['passed'])
        self.assertEqual(len(list(directory.iterdir())), 3)

    def test_scan_limits_age_type_and_total_bytes(self):
        old_file(self.source / 'video/a', b'f' * 10, formal=True)
        old_file(self.source / 'video/raw-media-old.tmp', b't' * 10)
        young = self.source / 'video/raw-media-young.tmp'; young.write_bytes(b'new')
        old_file(self.source / 'video/raw-media-large.tmp', b'x' * 100)
        (self.source / 'video/raw-media-link.tmp').symlink_to(young)
        with patch.object(sample, 'MAX_FILE', 20), patch.object(sample, 'MAX_TOTAL', 20):
            chosen, examined = self.selection()
        self.assertEqual(len(chosen), 2)
        self.assertEqual(sum(item[2][2] for item in chosen), 20)
        self.assertEqual(examined, 5)
        with patch.object(sample, 'MAX_ENTRIES', 0):
            with self.assertRaisesRegex(RuntimeError, 'No suitable files'):
                self.selection()
        self.assertEqual(list(self.nas.iterdir()), [])

    def test_python36_scandir_uses_pinned_path_and_retains_sample_limits(self):
        formal = old_file(self.source / 'video/formal', b'formal sample', formal=True)
        temporary = old_file(self.source / 'video/raw-media-old.tmp', b'temp sample')
        (self.source / 'video/raw-media-link.tmp').symlink_to(temporary)
        old_file(self.source / 'video/raw-media-large.tmp', b'x' * 100)
        (self.source / 'video/raw-media-young.tmp').write_bytes(b'new')
        native_scandir = os.scandir
        scanned = []

        def legacy_scandir(path):
            if isinstance(path, int):
                raise TypeError('scandir: path should be string, bytes, os.PathLike or None, not int')
            prefix = '/proc/{}/fd/'.format(os.getpid())
            self.assertTrue(path.startswith(prefix), path)
            fd = int(path[len(prefix):])
            self.assertEqual(os.fstat(fd).st_ino, (self.source / 'video').stat().st_ino)
            scanned.append(path)
            # Linux exercises the real /proc path. Darwin has no procfs; use
            # the fd encoded in that path for this temporary-directory fixture.
            return native_scandir(path if sys.platform.startswith('linux') else fd)

        with patch.object(sample.os, 'supports_fd', os.supports_fd - {native_scandir}), \
                patch.object(sample.os, 'scandir', new=legacy_scandir), \
                patch.object(sample, 'MAX_FILE', 20), patch.object(sample, 'MAX_TOTAL', 24):
            selected, examined = self.selection()
        self.assertTrue(scanned)
        self.assertEqual({item[1] for item in selected}, {formal.name, temporary.name})
        self.assertEqual(sum(item[2][2] for item in selected), 24)
        self.assertEqual(examined, 5)
        self.assertEqual(list(self.nas.iterdir()), [])

    def test_replaced_source_is_refused_before_rsync(self):
        path = old_file(self.source / 'video/raw-media-old.tmp')
        selected, examined = self.selection()
        path.unlink(); path.symlink_to(self.root / 'unrelated')
        with patch.object(sample, 'rsync_file') as copier:
            result = self.run_copy(selected, examined)
        copier.assert_not_called()
        self.assertFalse(result['passed'])

    def test_hash_filename_mismatch_is_not_certified(self):
        old_file(self.source / 'video' / ('a' * 64 + '.mp4'), b'not that hash')
        with patch.object(sample, 'rsync_file') as copier:
            result = self.run_copy(*self.selection())
        copier.assert_not_called()
        self.assertFalse(result['passed'])
        self.assertIn('SHA256 filename', result['error'])

    def test_rsync_failure_keeps_error_report_and_original(self):
        path = old_file(self.source / 'video/raw-media-old.tmp')
        with patch.object(sample, 'rsync_file', side_effect=RuntimeError('rsync exit 23')):
            result = self.run_copy(*self.selection())
        self.assertFalse(result['passed'])
        self.assertEqual(path.read_bytes(), b'media fixture')
        self.assertIn('23', result['error'])
        self.assertTrue(next(self.nas.iterdir()).joinpath('result.json').exists())

    def test_content_change_during_copy_fails_even_if_sample_matches_old_bytes(self):
        path = old_file(self.source / 'video/raw-media-old.tmp')
        def copying(src, dest, name, lock):
            target = next(self.nas.iterdir()) / name
            shutil.copy2(path, target)
            path.write_bytes(b'new business content')
        with patch.object(sample, 'rsync_file', side_effect=copying):
            result = self.run_copy(*self.selection())
        self.assertFalse(result['passed'])
        self.assertIn('Source changed', result['error'])
        self.assertEqual(path.read_bytes(), b'new business content')

    def test_same_size_destination_corruption_fails_checksum(self):
        path = old_file(self.source / 'video/raw-media-old.tmp', b'original')
        def copying(src, dest, name, lock):
            target = next(self.nas.iterdir()) / name
            target.write_bytes(b'corrupt!')
            shutil.copystat(path, target)
        with patch.object(sample, 'rsync_file', side_effect=copying):
            result = self.run_copy(*self.selection())
        self.assertFalse(result['passed'])
        self.assertIn('checksum mismatch', result['error'])
        self.assertEqual(path.read_bytes(), b'original')

    def test_permission_difference_is_not_ignored(self):
        path = old_file(self.source / 'video/raw-media-old.tmp')
        path.chmod(0o644)
        def copying(src, dest, name, lock):
            target = next(self.nas.iterdir()) / name
            shutil.copy2(path, target)
            target.chmod(0o600)
        with patch.object(sample, 'rsync_file', side_effect=copying):
            result = self.run_copy(*self.selection())
        self.assertFalse(result['passed'])
        self.assertIn('attributes differ', result['error'])

    def test_rsync_arguments_only_copy_open_file_and_preserve_lock(self):
        with patch.object(sample.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as run:
            sample.rsync_file(10, 11, '01-file.mp4', 12)
        args = run.call_args[0][0]
        self.assertIn('-aL', args)
        self.assertIn('--bwlimit=10240', args)
        self.assertEqual(run.call_args[1]['pass_fds'], (10, 11, 12))
        for forbidden in ('--delete', '--remove-source-files', '--inplace', '--append'):
            self.assertNotIn(forbidden, args)

    def test_entry_rejects_arbitrary_volume_or_missing_flag(self):
        script = str(ROOT / 'scripts/nas-sample-copy.sh')
        for arguments, status in [(['--help'], 0), (['po_infra_media_data'], 2), (['wrong', '--copy-test'], 2)]:
            result = subprocess.run(['bash', script] + arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, status)


if __name__ == '__main__':
    unittest.main()
