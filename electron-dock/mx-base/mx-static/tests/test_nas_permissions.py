"""Safety regressions for the explicit probe; temporary local files only."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import permissions as probe


class ProbeTests(unittest.TestCase):
    def run_probe(self, parent):
        fd = os.open(str(parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return probe.probe(fd)
        finally:
            os.close(fd)

    def test_roundtrip_and_cleanup_do_not_touch_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sentinel = root / 'business'; sentinel.write_bytes(b'keep me')
            # Ordinary local test users cannot chown to root. Exercise the rest
            # using their own identity; the report must not falsely certify 0:0.
            with patch.object(probe.os, 'fchown', return_value=None):
                result = self.run_probe(root)
            self.assertTrue(result['io_passed'])
            self.assertTrue(result['metadata_passed'])
            self.assertTrue(result['cleanup_passed'])
            self.assertEqual(result['root_owner_preservation'], (os.geteuid(), os.getegid()) == (0, 0))
            self.assertEqual(list(root.iterdir()), [sentinel])
            self.assertEqual(sentinel.read_bytes(), b'keep me')

    def test_chown_denial_preserves_io_evidence_and_cleans_only_own_files(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(probe.os, 'fchown', side_effect=PermissionError(1, 'root squashed')):
                result = self.run_probe(directory)
            self.assertTrue(result['io_passed'])
            self.assertFalse(result['root_owner_preservation'])
            self.assertEqual(result['error']['phase'], 'chown_0_0')
            self.assertTrue(result['cleanup_passed'])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_fsync_failure_cleans_unpublished_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(probe.os, 'fsync', side_effect=OSError(5, 'fixture I/O failure')):
                result = self.run_probe(directory)
            self.assertFalse(result['io_passed'])
            self.assertTrue(result['cleanup_passed'])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_reopen_failure_is_reported_without_double_closing_fd(self):
        with tempfile.TemporaryDirectory() as directory:
            original = os.open
            def fail_reopen(path, flags, *args, **kwargs):
                if path == 'payload.final':
                    raise OSError(5, 'fixture reopen failure')
                return original(path, flags, *args, **kwargs)
            with patch.object(probe.os, 'open', side_effect=fail_reopen):
                result = self.run_probe(directory)
            self.assertEqual(result['error']['phase'], 'rename_readback')
            self.assertTrue(result['cleanup_passed'])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_existing_probe_name_is_never_reused_or_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            class FixedUUID:
                hex = 'fixture'
            existing = Path(directory) / '.mx-static-probe-fixture'; existing.mkdir()
            payload = existing / 'payload.tmp'; payload.write_bytes(b'existing')
            with patch.object(probe.uuid, 'uuid4', return_value=FixedUUID()):
                result = self.run_probe(directory)
            self.assertEqual(result['error']['phase'], 'mkdir')
            self.assertEqual(payload.read_bytes(), b'existing')

    def test_cleanup_does_not_follow_replaced_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sentinel = root / 'business'; sentinel.write_bytes(b'untouched')
            def replace_payload(fd, uid, gid):
                scratch = next(root.glob('.mx-static-probe-*'))
                (scratch / 'payload.final').unlink()
                (scratch / 'payload.final').symlink_to(sentinel)
                raise PermissionError('fixture concurrent replacement')
            with patch.object(probe.os, 'fchown', side_effect=replace_payload):
                result = self.run_probe(root)
            self.assertFalse(result['cleanup_passed'])
            self.assertEqual(sentinel.read_bytes(), b'untouched')
            self.assertTrue(next(root.glob('.mx-static-probe-*')).joinpath('payload.final').is_symlink())

    def test_wrong_mount_never_opens_or_creates_nas_path(self):
        result = subprocess.CompletedProcess([], 0, '/mnt/nas systemd-1 autofs 0:4', '')
        with patch.object(probe.subprocess, 'run', return_value=result), patch.object(probe.os, 'open') as opening:
            with self.assertRaisesRegex(RuntimeError, 'not mounted'):
                probe.open_parent()
        opening.assert_not_called()

    def test_device_mismatch_and_symlink_refused_before_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            mount = root / 'mount'; mount.mkdir()
            host = mount / 'host'; host.mkdir()
            fake_mount = subprocess.CompletedProcess([], 0, 'valid fields here 0:0', '')
            with patch.object(probe, 'HOST_ROOT', str(host)), patch.object(probe, 'NAS_MOUNT', str(mount)), \
                    patch.object(probe, 'expected_mount', return_value=True), \
                    patch.object(probe.subprocess, 'run', return_value=fake_mount), \
                    patch.object(probe.os, 'mkdir') as mkdir, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'device differs'):
                    probe.open_parent()
                host.rmdir(); host.symlink_to(root, target_is_directory=True)
                with patch.object(probe.os, 'makedev', return_value=root.stat().st_dev):
                    with self.assertRaises(OSError):
                        probe.open_parent()
                mkdir.assert_not_called()

    def test_entry_requires_explicit_write_flag(self):
        script = str(ROOT / 'scripts/nas-probe.sh')
        for arguments, status in [(['--help'], 0), (['permissions'], 2), (['copy', '--write-test'], 2)]:
            result = subprocess.run(['bash', script] + arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, status)


if __name__ == '__main__':
    unittest.main()
