"""Isolated local fixtures for the full pre-copy guard; no Docker/NAS access."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import precopy


class PrecopyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'; self.source.mkdir()
        self.parent = self.root / 'nas'; self.parent.mkdir()
        self.source_fd = os.open(str(self.source), precopy.DIR_FLAGS)
        self.parent_fd = os.open(str(self.parent), precopy.DIR_FLAGS)
        self.opened = []

    def tearDown(self):
        for fd in self.opened + [self.source_fd, self.parent_fd]: os.close(fd)
        self.temp.cleanup()

    def job(self, volume='po_infra_media_data', fingerprint='fixture', create=True):
        job, target, state = precopy.open_job(self.parent_fd, volume, self.source_fd, fingerprint, create)
        self.opened.extend((job, target))
        return job, target, state

    def test_host_pins_local_docker_and_rejects_wrong_identity(self):
        with patch.object(precopy.socket, 'gethostname', return_value='other-host'):
            with self.assertRaisesRegex(RuntimeError, 'registered only'):
                precopy.check_host()
        from types import SimpleNamespace
        with patch.object(precopy.socket, 'gethostname', return_value='mx-internal-server'), \
                patch.object(precopy.os, 'stat', return_value=SimpleNamespace(st_mode=stat.S_IFSOCK)), \
                patch.dict(os.environ, {'DOCKER_CONTEXT': 'remote', 'DOCKER_TLS_VERIFY': '1'}), \
                patch.object(precopy.subprocess, 'check_output', return_value='mx-internal-server /data/docker') as query:
            precopy.check_host()
            self.assertNotIn('DOCKER_CONTEXT', os.environ)
            self.assertNotIn('DOCKER_TLS_VERIFY', os.environ)
            self.assertEqual(os.environ['DOCKER_HOST'], 'unix:///var/run/docker.sock')
            query.return_value = 'other-host /data/docker'
            with self.assertRaisesRegex(RuntimeError, 'Unexpected local Docker'):
                precopy.check_host()

    def test_prepare_and_resume_keep_separate_volumes_and_no_cleanup_readiness(self):
        job, target, state = self.job()
        (self.parent / 'data/docker/media-volumes/po_infra_media_data/data_hub_raw_media/kept').write_text('existing')
        _, same, resumed = self.job(create=False)
        self.assertEqual(os.fstat(target).st_ino, os.fstat(same).st_ino)
        self.assertEqual(state['job_id'], resumed['job_id'])
        self.assertFalse(resumed['cutover_ready'])
        self.assertFalse(resumed['reclaim_ready'])
        _, other, _ = self.job(volume='delta_59202_media_data')
        self.assertNotEqual(os.fstat(target).st_ino, os.fstat(other).st_ino)
        self.assertEqual(precopy.read_state(job)['phase'], 'prepared')

    def test_status_does_not_create_target(self):
        with self.assertRaises(FileNotFoundError): self.job(create=False)
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_foreign_destination_and_symlink_are_refused(self):
        foreign = self.parent / 'data/docker/media-volumes/po_infra_media_data'
        foreign.mkdir(parents=True)
        (foreign / 'keep').write_text('do not replace')
        with self.assertRaises(FileNotFoundError): self.job()
        self.assertEqual((foreign / 'keep').read_text(), 'do not replace')
        (self.parent / 'data/docker/media-volumes/delta_59202_media_data').symlink_to(self.source)
        with self.assertRaises(OSError): self.job(volume='delta_59202_media_data')
        self.assertEqual(list(self.source.iterdir()), [])

    def test_sealed_marker_or_changed_consumers_prevents_resuming(self):
        job, _, state = self.job()
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.job(fingerprint='new-deployment')
        state['phase'] = 'cutover_started'
        precopy.write_state(job, state)
        with self.assertRaisesRegex(RuntimeError, 'sealed'):
            self.job()

    def test_replaced_target_inode_is_refused(self):
        self.job()
        target = self.parent / 'data/docker/media-volumes/po_infra_media_data/data_hub_raw_media'
        target.rename(target.with_name('retained-original'))
        target.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'replaced'):
            self.job()

    def test_command_copies_all_files_and_never_deletes_or_updates_in_place(self):
        _, target, state = self.job()
        command = precopy.copy_command(self.source_fd, target, state)
        self.assertIn('--bwlimit=61440', command)
        self.assertIn('--one-file-system', command)
        self.assertIn('--partial-dir=.mx-static-partial-' + state['job_id'], command)
        for flag in ('--delete', '--remove-source-files', '--inplace', '--append', '--exclude', '-L'):
            self.assertNotIn(flag, command)
        self.assertTrue(command[-2].endswith('/'))
        self.assertTrue(command[-1].endswith('/'))

    @unittest.skipUnless(shutil.which('rsync'), 'rsync unavailable')
    def test_real_rsync_precopy_keeps_source_and_resumes_without_overwriting_unrelated_files(self):
        job, target, state = self.job()
        (self.source / 'video').mkdir()
        (self.source / 'video/raw-media-live.tmp').write_bytes(b'keep tmp as data')
        (self.source / 'video/a.mp4').write_bytes(b'formal bytes')
        target_path = self.parent / 'data/docker/media-volumes/po_infra_media_data/data_hub_raw_media'
        before = {p.relative_to(self.source): p.read_bytes() for p in self.source.rglob('*') if p.is_file()}
        def local_descriptor(fd):
            return str(self.source if fd == self.source_fd else target_path)
        with patch.object(precopy, 'descriptor_path', side_effect=local_descriptor):
            command = precopy.copy_command(self.source_fd, target, state)
        # macOS rsync 2.6.9 lacks progress2; test actual copying with other flags.
        command = [arg for arg in command if arg != '--info=progress2']
        first = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(first.returncode, 0, first.stderr)
        (target_path / 'unrelated-retain').write_bytes(b'do not delete')
        (self.source / 'video/raw-media-live.tmp').write_bytes(b'changed source is copied on next pass')
        second = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual((target_path / 'unrelated-retain').read_bytes(), b'do not delete')
        self.assertEqual((target_path / 'video/raw-media-live.tmp').read_bytes(),
                         (self.source / 'video/raw-media-live.tmp').read_bytes())
        self.assertEqual((self.source / 'video/a.mp4').read_bytes(), before[Path('video/a.mp4')])
        self.assertFalse(precopy.read_state(job)['reclaim_ready'])

    def test_consumers_refuse_nas_child_mount_or_missing_service(self):
        containers = []
        for service in sorted(precopy.SERVICES):
            containers.append({'Id': service, 'Image': 'sha256:fixture', 'Name': service,
                               'Config': {'Labels': {'com.docker.compose.project': 'mx_data',
                                                     'com.docker.compose.service': service}},
                               'Mounts': [{'Name': 'po_infra_media_data', 'Destination': '/app/media'}]})
        def checking(args, **kwargs):
            return 'ids' if args[:3] == ['docker', 'ps', '-aq'] else json.dumps(containers).encode()
        with patch.object(precopy.subprocess, 'check_output', side_effect=checking):
            self.assertEqual(len(precopy.check_consumers('po_infra_media_data')), 64)
            containers[0]['Mounts'].append({'Destination': '/app/media/data_hub_raw_media'})
            with self.assertRaisesRegex(RuntimeError, 'changed media mounts'):
                precopy.check_consumers('po_infra_media_data')
            containers.pop(0)
            with self.assertRaisesRegex(RuntimeError, 'ten consumers'):
                precopy.check_consumers('po_infra_media_data')


if __name__ == '__main__':
    unittest.main()
