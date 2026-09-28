"""Delta continuation isolation: real files, mocked Docker/kernel/NFS boundary."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import catalog
import manage
import precopy
from projects import delta_copy as delta


class DeltaContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'; self.source.mkdir()
        self.job = self.root / 'job'; self.job.mkdir()
        self.target = self.job / 'data_hub_raw_media'; self.target.mkdir()
        self.reports = self.root / 'reports'; self.reports.mkdir()
        self.profile = manage.profiles()['part2']
        for root in (self.source, self.target): (root / 'video').mkdir()
        self.candidate = self.source / 'video/new.bin'; self.candidate.write_bytes(b'new-media')
        self.keep = self.target / 'video/nas-only.bin'; self.keep.write_bytes(b'nas-only')
        self.fds = [os.open(str(p), delta.DIR_FLAGS) for p in (self.source, self.target, self.job)]
        self.src, self.dst, self.jobfd = self.fds
        self.marker = {'schema': 1, 'volume': delta.VOLUME, 'source_identity': precopy.source_identity(self.src),
                       'target': delta.TARGET, 'target_inode': os.fstat(self.dst).st_ino,
                       'consumer_fingerprint': 'a' * 64, 'job_id': 'b' * 32,
                       'phase': 'precopy_pass_complete', 'last_exit_code': 0,
                       'cutover_ready': False, 'reclaim_ready': False}
        precopy.write_state(self.jobfd, self.marker)
        self.before = (self.job / precopy.MARKER).read_bytes()
        self.baseline = {'consumer_fingerprint': 'c' * 64, 'consumers': [], 'kernel_sources': {}}
        self.manager = mock.Mock()
        self.manager.profiles.return_value = {'part2': self.profile}
        self.manager.run.return_value = 'xfs'
        self.manager.secure_directory.side_effect = lambda path: os.open(path, delta.DIR_FLAGS)
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(mock.patch.object(delta, 'REPORT_ROOT', str(self.reports)))
        self.stack.enter_context(mock.patch.object(delta, 'media', self.media))
        self.current = self.stack.enter_context(mock.patch.object(delta, 'current', side_effect=lambda _: copy.deepcopy(self.baseline)))
        # System report path ownership is independently tested below; fixture
        # parents are temporary paths owned by the local developer, not root.
        opener = delta.open_absolute
        self.stack.enter_context(mock.patch.object(delta, 'open_absolute', side_effect=lambda p, private=False: opener(p)))

    @contextlib.contextmanager
    def media(self):
        marker, sha = delta.read_private(self.jobfd, precopy.MARKER)
        delta.marker_check(marker, self.src, self.dst)
        yield {'source': self.src, 'target': self.dst, 'job': self.jobfd,
               'marker': marker, 'marker_sha256': sha,
               'source_identity': precopy.source_identity(self.src),
               'target_identity': precopy.source_identity(self.dst),
               'job_identity': precopy.source_identity(self.jobfd)}

    def tearDown(self):
        self.stack.close()
        for fd in self.fds: os.close(fd)
        self.temp.cleanup()

    def prepare(self):
        return delta.prepare(self.manager, self.profile)

    def test_prepare_is_read_only_and_retains_both_fingerprints_and_marker_bytes(self):
        path = self.prepare()
        plan = json.loads((Path(path) / 'plan.json').read_text())
        self.assertEqual(plan['media_identity']['marker'], self.marker)
        self.assertEqual(plan['baseline']['consumer_fingerprint'], 'c' * 64)
        self.assertEqual(plan['groups']['ssd_only']['files'], 1)
        self.assertFalse(plan['reclaim_ready'])
        self.assertEqual((self.job / precopy.MARKER).read_bytes(), self.before)
        self.assertEqual(sorted(p.name for p in (self.target / 'video').iterdir()), ['nas-only.bin'])

    def test_addition_readback_retry_never_rewrites_nas_or_legacy_marker(self):
        path = self.prepare()
        before_plan = (Path(path) / 'plan.json').read_bytes()
        keep_stat = delta.stamp(self.keep.stat())
        source_stat = delta.stamp(self.candidate.stat())
        result = delta.execute(self.manager, self.profile, path)
        self.assertEqual(result['copied'], 1)
        self.assertTrue(result['bandwidth_unlimited'])
        self.assertTrue(result['stopped_writer_recheck_required'])
        self.assertFalse(result['reclaim_ready'])
        self.assertEqual((self.target / 'video/new.bin').read_bytes(), b'new-media')
        retried = delta.execute(self.manager, self.profile, path)
        self.assertEqual(retried['copied'], 0); self.assertEqual(retried['already_present'], 1)
        self.assertEqual((self.job / precopy.MARKER).read_bytes(), self.before)
        self.assertEqual((Path(path) / 'plan.json').read_bytes(), before_plan)
        self.assertEqual(delta.stamp(self.keep.stat()), keep_stat)
        self.assertEqual(delta.stamp(self.candidate.stat()), source_stat)
        self.assertEqual(sorted(p.name for p in self.job.iterdir()), [precopy.MARKER, 'data_hub_raw_media'])
        for call in self.manager.run.call_args_list:
            self.assertEqual(call.args[0][0], 'findmnt')

    def test_shared_mtime_conflict_hashes_equal_and_nas_permissions_retained(self):
        src = self.source / 'video/shared.bin'; dst = self.target / 'video/shared.bin'
        src.write_bytes(b'old-data'); dst.write_bytes(b'old-data')
        src.chmod(0o644); dst.chmod(0o600)
        os.utime(str(src), (1000000000, 1000000000)); os.utime(str(dst), (1000000010, 1000000010))
        before = delta.stamp(dst.stat())
        path = self.prepare()
        plan = json.loads((Path(path) / 'plan.json').read_text())
        self.assertEqual(plan['groups']['shared_hash_same']['files'], 1)
        delta.execute(self.manager, self.profile, path)
        self.assertEqual(delta.stamp(dst.stat()), before)

    def test_different_shared_content_fails_without_nas_or_source_changes(self):
        (self.target / 'video/new.bin').write_bytes(b'not-new-media')
        with self.assertRaisesRegex(RuntimeError, 'conflicts'):
            self.prepare()
        self.assertEqual((self.target / 'video/new.bin').read_bytes(), b'not-new-media')
        self.assertEqual(self.candidate.read_bytes(), b'new-media')
        self.assertFalse(list(self.reports.glob('*/plan.json')))
        self.assertEqual((self.job / precopy.MARKER).read_bytes(), self.before)

    def test_new_directory_requires_review_and_is_not_created_on_nas(self):
        (self.source / 'unreviewed').mkdir(); (self.source / 'unreviewed/file').write_text('x')
        with self.assertRaisesRegex(RuntimeError, 'parent directory'):
            self.prepare()
        self.assertFalse((self.target / 'unreviewed').exists())

    def test_stale_current_consumer_snapshot_prevents_any_write(self):
        path = self.prepare()
        self.baseline['consumer_fingerprint'] = 'd' * 64
        with self.assertRaisesRegex(RuntimeError, 'consumers changed'):
            delta.execute(self.manager, self.profile, path)
        self.assertFalse((self.target / 'video/new.bin').exists())
        self.assertFalse(list(Path(path).glob('copy-*')))

    def test_changed_legacy_bytes_or_inode_or_sealed_phase_never_adopted(self):
        path = self.prepare()
        for change in ({'extra': 'changed'}, {'phase': 'cutover_running_on_nas'},
                       {'target_inode': 1}, {'source_identity': {'device': 1, 'inode': 2}},
                       {'cutover_ready': True}, {'last_exit_code': 1}):
            with self.subTest(change=change):
                precopy.write_state(self.jobfd, dict(self.marker, **change))
                with self.assertRaises(RuntimeError): delta.execute(self.manager, self.profile, path)
        self.assertFalse((self.target / 'video/new.bin').exists())

    def test_changed_source_or_manifest_blocks_without_overwrite(self):
        path = self.prepare()
        self.candidate.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'Candidate cannot'):
            delta.execute(self.manager, self.profile, path)
        self.assertFalse((self.target / 'video/new.bin').exists())
        with (Path(path) / 'union-manifest.jsonl').open('ab') as stream: stream.write(b'\n')
        with self.assertRaises((ValueError, RuntimeError)):
            delta.execute(self.manager, self.profile, path)

    def test_nas_target_created_after_plan_is_never_replaced(self):
        path = self.prepare()
        other = self.target / 'video/new.bin'; other.write_bytes(b'unrelated')
        before = delta.stamp(other.stat())
        with self.assertRaisesRegex(RuntimeError, 'Existing NAS target differs'):
            delta.execute(self.manager, self.profile, path)
        self.assertEqual(delta.stamp(other.stat()), before)
        self.assertEqual(other.read_bytes(), b'unrelated')
        self.assertTrue(list(Path(path).glob('copy-*/failed.json')))

    def test_partial_copy_retained_and_retry_is_additive(self):
        (self.source / 'video/z.bin').write_bytes(b'second-file')
        path = self.prepare()
        original = delta.files.copy_one
        def fail_second(*args):
            if args[3].endswith('z.bin'): raise RuntimeError('simulated interruption')
            return original(*args)
        with mock.patch.object(delta.files, 'copy_one', side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, 'simulated interruption'):
                delta.execute(self.manager, self.profile, path)
        self.assertEqual((self.target / 'video/new.bin').read_bytes(), b'new-media')
        result = delta.execute(self.manager, self.profile, path)
        self.assertEqual((result['copied'], result['already_present']), (1, 1))
        self.assertEqual((self.job / precopy.MARKER).read_bytes(), self.before)

    def test_wrong_project_or_migrated_registration_never_opens_report(self):
        for profile in (manage.profiles()['part1'], dict(self.profile, report='/cutover/delta'),
                        dict(self.profile, recovery_mode='media-v1')):
            with mock.patch.object(delta, 'new_report') as create, self.assertRaises(RuntimeError):
                delta.prepare(self.manager, profile)
            create.assert_not_called()

    def test_drift_during_prepare_does_not_publish_plan(self):
        self.current.side_effect = [copy.deepcopy(self.baseline), dict(self.baseline, consumer_fingerprint='e' * 64)]
        with self.assertRaisesRegex(RuntimeError, 'consumers changed'): self.prepare()
        self.assertFalse(list(self.reports.glob('*/plan.json')))

    def test_drift_detected_after_addition_records_failure_without_rollback(self):
        path = self.prepare()
        original = delta.files.copy_one
        def drift_after(*args):
            result = original(*args)
            self.baseline['consumer_fingerprint'] = 'f' * 64
            return result
        with mock.patch.object(delta.files, 'copy_one', side_effect=drift_after):
            with self.assertRaisesRegex(RuntimeError, 'consumers changed'):
                delta.execute(self.manager, self.profile, path)
        self.assertEqual((self.target / 'video/new.bin').read_bytes(), b'new-media')
        self.assertFalse(list(Path(path).glob('copy-*/result.json')))
        self.assertTrue(list(Path(path).glob('copy-*/failed.json')))
        self.assertEqual((self.job / precopy.MARKER).read_bytes(), self.before)

    def test_plan_modification_during_copy_is_not_a_success(self):
        path = self.prepare()
        original = delta.files.copy_one
        def change_plan(*args):
            result = original(*args)
            p = Path(path) / 'plan.json'
            content = json.loads(p.read_text()); content['time_unix'] += 1
            p.write_text(json.dumps(content))
            return result
        with mock.patch.object(delta.files, 'copy_one', side_effect=change_plan):
            with self.assertRaisesRegex(RuntimeError, 'report changed'):
                delta.execute(self.manager, self.profile, path)
        self.assertFalse(list(Path(path).glob('copy-*/result.json')))

    def test_new_target_root_identity_requires_a_new_review(self):
        path = self.prepare()
        old = self.dst
        replacement = self.job / 'replacement'; replacement.mkdir()
        self.dst = os.open(str(replacement), delta.DIR_FLAGS); self.fds.append(self.dst)
        try:
            with self.assertRaisesRegex(RuntimeError, 'marker identity'):
                delta.execute(self.manager, self.profile, path)
        finally: self.dst = old
        self.assertFalse((self.target / 'video/new.bin').exists())


class DeltaRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.rows = []
        for i, service in enumerate(sorted(precopy.SERVICES), 1):
            self.rows.append({'Id': 'container-' + service, 'Image': 'image-' + service,
                              'Config': {'Labels': {'com.docker.compose.project': delta.PROJECT,
                                                    'com.docker.compose.service': service}},
                              'State': {'Running': True, 'Pid': i, 'StartedAt': 'stable', 'Health': {'Status': 'healthy'}},
                              'Mounts': [{'Type': 'volume', 'Name': delta.VOLUME, 'Source': delta.SSD_PARENT,
                                          'Destination': '/app/media', 'RW': service != 'gateway'}]})
        self.definitions = [{'Name': delta.VOLUME, 'Driver': 'local', 'Options': None}]
        self.manager = mock.Mock()
        self.manager.run.side_effect = lambda _: json.dumps(self.definitions)
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(mock.patch.object(precopy, 'inspect_containers', side_effect=lambda: self.rows))
        def proc(path):
            pid = int(str(path).split('/')[2])
            service = self.rows[pid - 1]['Config']['Labels']['com.docker.compose.service']
            mode = 'ro' if service == 'gateway' else 'rw'
            return ('1 0 1:1 / / rw - overlay overlay rw\n'
                    '2 1 259:5 /docker/volumes/delta_59202_media_data/_data /app/media {} - xfs /dev/nvme0n1p1 rw\n').format(mode)
        self.proc = self.stack.enter_context(mock.patch.object(delta.Path, 'read_text', autospec=True, side_effect=proc))

    def tearDown(self): self.stack.close()

    def test_exact_current_ssd_consumers_and_read_only_docker_queries(self):
        initial = delta.current(self.manager)
        self.assertEqual(len(initial['consumers']), 10)
        self.assertEqual(initial, delta.current(self.manager))
        self.assertTrue(all(c.args[0][:3] == ['docker', 'volume', 'inspect'] for c in self.manager.run.call_args_list))

    def test_wrong_kernel_source_or_child_mount_rejects(self):
        for text in ('1 0 0:2 / / rw - overlay overlay rw\n',
                     '1 0 0:2 / / rw - overlay overlay rw\n2 1 0:3 / /app/media/data_hub_raw_media rw - nfs nas:/share rw\n'):
            self.proc.side_effect = None; self.proc.return_value = text
            with self.assertRaisesRegex(RuntimeError, 'Kernel'): delta.current(self.manager)

    def test_new_nas_consumer_or_foreign_bind_blocks(self):
        self.rows.append({'Id': 'foreign', 'Mounts': [{'Type': 'bind', 'Source': '/mnt/nas', 'Destination': '/nas'}]})
        with self.assertRaisesRegex(RuntimeError, 'extra Docker'): delta.current(self.manager)
        self.rows[-1]['Mounts'] = [{'Type': 'volume', 'Name': delta.NFS_VOLUME}]
        with self.assertRaisesRegex(RuntimeError, 'already attached'): delta.current(self.manager)

    def test_aliased_nfs_or_local_bind_volume_blocks(self):
        for device in (':/volume1/data1', delta.SOURCE):
            self.rows.append({'Id': 'foreign', 'Mounts': [{'Type': 'volume', 'Name': 'alias', 'Source': '/elsewhere', 'Destination': '/alias'}]})
            self.definitions.append({'Name': 'alias', 'Driver': 'local', 'Options': {'device': device}})
            with self.assertRaisesRegex(RuntimeError, 'aliases'): delta.current(self.manager)
            self.rows.pop(); self.definitions.pop()

    def test_wrong_parent_access_and_unhealthy_services_block(self):
        self.rows[0]['Mounts'][0]['RW'] = False
        with self.assertRaisesRegex(RuntimeError, 'Unexpected delta'): delta.current(self.manager)
        self.rows[0]['Mounts'][0]['RW'] = True
        self.rows[0]['State']['Paused'] = True
        with self.assertRaisesRegex(RuntimeError, 'stably running'): delta.current(self.manager)

    def test_unknown_service_or_duplicate_is_not_adopted(self):
        self.rows.append(copy.deepcopy(self.rows[0]))
        with self.assertRaisesRegex(RuntimeError, 'exactly ten'): delta.current(self.manager)


class DeltaCliTests(unittest.TestCase):
    def test_project_routes_no_infra_reuse_and_always_unlimited(self):
        path = delta.REPORT_ROOT + '/delta-' + 'c' * 32
        self.assertEqual(catalog.route(['delta', 'copy', 'prepare'], manage.CONFIG), ['delta-copy-prepare', 'part2'])
        args = manage.parser().parse_args(catalog.route(['delta', 'copy', 'resume', path, '--unlimited'], manage.CONFIG))
        command = manage.task_command(args.action, manage.profiles()['part2'], args)
        self.assertEqual(command[-3:], ['_execute-delta-copy', 'part2', path])
        self.assertNotIn('--bwlimit', ' '.join(command))
        with self.assertRaises(RuntimeError): catalog.route(['infra', 'copy', 'prepare'], manage.CONFIG)
        with self.assertRaises(RuntimeError): delta.validate_path('/var/lib/mx-static/nas-repair/infra-' + 'c' * 32)

    def test_background_copy_mounts_ssd_read_only_and_returns_exact_journal(self):
        path = delta.REPORT_ROOT + '/delta-' + 'c' * 32
        args = manage.parser().parse_args(['delta-copy-resume', 'part2', path])
        with mock.patch.object(manage, 'run', return_value=''), mock.patch.object(manage, 'emit') as event:
            with mock.patch.object(manage, 'run', return_value='') as run:
                manage.launch(args.action, manage.profiles()['part2'], args)
        command = run.call_args.args[0]
        self.assertIn('--property=ReadOnlyPaths=/data', command)
        self.assertIn('--property=Nice=19', command)
        self.assertIn(event.call_args.kwargs['unit'], event.call_args.kwargs['logs'])
        self.assertFalse(event.call_args.kwargs['reboot_auto_resume'])


class DeltaPathTests(unittest.TestCase):
    def test_report_symlinks_and_public_private_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'real').mkdir(); (root / 'alias').symlink_to(root / 'real')
            with self.assertRaises(OSError): delta.open_absolute(str(root / 'alias'))
            fd = os.open(str(root), delta.DIR_FLAGS)
            try:
                (root / 'private.json').write_text('{}'); (root / 'private.json').chmod(0o644)
                with self.assertRaisesRegex(RuntimeError, 'Unsafe private'): delta.read_private(fd, 'private.json')
                (root / 'private.json').chmod(0o600)
                os.link(str(root / 'private.json'), str(root / 'hardlink.json'))
                with self.assertRaisesRegex(RuntimeError, 'Invalid private'): delta.read_private(fd, 'private.json')
            finally: os.close(fd)

    def test_private_receipt_read_ignores_only_atime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); fd = os.open(str(root), delta.DIR_FLAGS)
            try:
                delta.private_reports.private_write(fd, 'receipt.json', {'original': True})
                os.utime(str(root / 'receipt.json'), (1, 1))
                first = delta.read_private(fd, 'receipt.json')
                self.assertEqual(delta.read_private(fd, 'receipt.json'), first)
            finally: os.close(fd)


if __name__ == '__main__': unittest.main()
