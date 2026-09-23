import contextlib
import errno
import hashlib
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
from projects import infra_repair as planning
from projects import infra_repair_copy as copying
from verify import Report


class RepairCopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.source = self.root / 'ssd'; self.source.mkdir()
        self.job = self.root / 'job'; self.job.mkdir()
        self.target = self.job / 'media'; self.target.mkdir()
        self.stage = self.job / 'private-stage'; self.stage.mkdir(mode=0o700)
        self.output = self.root / 'report'; self.output.mkdir(mode=0o700)
        for root in (self.source, self.target): (root / 'video').mkdir()
        self.file = self.source / 'video/candidate.bin'
        self.file.write_bytes(b'new-media'); self.file.chmod(0o644)
        os.utime(str(self.file), (1000000000, 1000000000))
        self.keep = self.target / 'video/nas-only.bin'; self.keep.write_bytes(b'nas-only'); self.keep.chmod(0o600)
        self.fds = [os.open(str(p), copying.DIR_FLAGS) for p in (self.source, self.target, self.stage, self.output)]
        self.src, self.dst, self.stg, self.out = self.fds
        self.stdout = contextlib.redirect_stdout(io.StringIO()); self.stdout.__enter__()
        with (self.output / 'union-manifest.jsonl').open('wb') as stream:
            report = Report(stream)
            self.plan = planning.compare(self.src, self.dst, report)
            self.plan['manifest_sha256'] = report.sha256.hexdigest()
        (self.output / 'union-manifest.jsonl').chmod(0o600)
        self.tree, self.dirs, self.paths = copying.read_manifest(self.out, self.plan)
        self.journal = copying.private_file(self.out, 'journal.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        self.fds.append(self.journal)

    def tearDown(self):
        self.stdout.__exit__(None, None, None)
        for fd in reversed(self.fds): os.close(fd)
        self.tmp.cleanup()

    def copy(self):
        return copying.copy_one(self.src, self.dst, self.stg, self.paths[0], self.tree, self.dirs, self.journal)

    def hashed_candidate(self):
        path = self.file.with_name(hashlib.sha256(self.file.read_bytes()).hexdigest() + '.bin')
        self.file.rename(path); self.file = path
        with (self.output / 'union-manifest.jsonl').open('wb') as stream:
            report = Report(stream)
            self.plan = planning.compare(self.src, self.dst, report)
            self.plan['manifest_sha256'] = report.sha256.hexdigest()
        self.tree, self.dirs, self.paths = copying.read_manifest(self.out, self.plan)

    def change_ctime(self):
        self.file.chmod(0o600); self.file.chmod(0o644)
        current = copying.stamp(self.file.stat())
        self.assertEqual([k for k in copying.STAT_FIELDS if current[k] != self.tree[self.paths[0]][k]], ['ctime_ns'])

    def test_ctime_only_hash_filename_recheck_preserves_original_manifest(self):
        self.hashed_candidate(); self.change_ctime()
        before = (self.output / 'union-manifest.jsonl').read_bytes()
        prepared = dict(self.tree[self.paths[0]])
        reviewed, changes = copying.recheck_sources(self.src, self.tree, self.paths)
        self.assertEqual(self.tree[self.paths[0]], prepared)
        self.assertEqual((self.output / 'union-manifest.jsonl').read_bytes(), before)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]['prepared'], prepared)
        self.assertEqual(changes[0]['observed'], copying.stamp(self.file.stat()))
        outcome, _ = copying.copy_one(self.src, self.dst, self.stg, self.paths[0], reviewed, self.dirs, self.journal)
        self.assertEqual(outcome, 'copied')
        self.assertEqual((self.target / self.paths[0]).read_bytes(), b'new-media')

    def test_unchanged_candidate_recheck_never_hashes_contents(self):
        with mock.patch.object(copying, 'digest', side_effect=AssertionError('no extra content read')):
            reviewed, changes = copying.recheck_sources(self.src, self.tree, self.paths)
        self.assertEqual(reviewed, self.tree); self.assertEqual(changes, [])

    def test_ctime_only_without_hash_filename_still_refused(self):
        self.change_ctime()
        with mock.patch.object(copying, 'digest') as digest, self.assertRaisesRegex(RuntimeError, 'without a SHA256 filename'):
            copying.recheck_sources(self.src, self.tree, self.paths)
        digest.assert_not_called()
        self.assertFalse((self.target / self.paths[0]).exists())

    def test_same_size_corruption_with_restored_mtime_is_not_accepted_as_ctime_only(self):
        self.hashed_candidate()
        expected = self.tree[self.paths[0]]
        self.file.write_bytes(b'bad-media')
        os.utime(str(self.file), ns=(expected['mtime_ns'], expected['mtime_ns']))
        self.assertEqual([k for k in copying.STAT_FIELDS if copying.stamp(self.file.stat())[k] != expected[k]], ['ctime_ns'])
        with self.assertRaisesRegex(RuntimeError, 'differs from its hash filename'):
            copying.recheck_sources(self.src, self.tree, self.paths)
        self.assertFalse((self.target / self.paths[0]).exists())

    def test_other_metadata_changes_are_not_relaxed_for_hash_filenames(self):
        self.hashed_candidate(); self.file.chmod(0o600)
        with mock.patch.object(copying, 'digest') as digest, self.assertRaisesRegex(RuntimeError, 'mode'):
            copying.recheck_sources(self.src, self.tree, self.paths)
        digest.assert_not_called()

    def test_changes_during_recheck_or_later_permission_changes_still_block_copy(self):
        self.hashed_candidate(); self.change_ctime()
        original = copying.digest
        def changed(fd, size):
            result = original(fd, size)
            self.file.chmod(0o600)
            return result
        with mock.patch.object(copying, 'digest', side_effect=changed), self.assertRaisesRegex(RuntimeError, 'during ctime content recheck'):
            copying.recheck_sources(self.src, self.tree, self.paths)
        self.file.chmod(0o644)
        reviewed, _ = copying.recheck_sources(self.src, self.tree, self.paths)
        self.file.chmod(0o600)
        with self.assertRaises(RuntimeError):
            copying.copy_one(self.src, self.dst, self.stg, self.paths[0], reviewed, self.dirs, self.journal)
        self.assertFalse((self.target / self.paths[0]).exists())

    def test_ctime_change_while_queued_is_rehashed_and_journaled_before_nas_write(self):
        self.hashed_candidate()
        reviewed, _ = copying.recheck_sources(self.src, self.tree, self.paths)
        self.change_ctime()
        before = dict(reviewed[self.paths[0]])
        original = copying.os.open
        def check_before_staging(name, flags, *args, **kwargs):
            if kwargs.get('dir_fd') == self.stg and flags & os.O_CREAT:
                records = [json.loads(line) for line in (self.output / 'journal.jsonl').read_text().splitlines()]
                self.assertEqual(records[-1]['event'], 'source_ctime_revalidated_before_copy')
                self.assertEqual(records[-1]['previously_checked'], before)
                self.assertEqual(records[-1]['observed'], copying.stamp(self.file.stat()))
                self.assertEqual(records[-1]['sha256'], hashlib.sha256(b'new-media').hexdigest())
            return original(name, flags, *args, **kwargs)
        with mock.patch.object(copying.os, 'open', side_effect=check_before_staging):
            outcome, _ = copying.copy_one(self.src, self.dst, self.stg, self.paths[0], reviewed, self.dirs, self.journal)
        self.assertEqual(outcome, 'copied')
        self.assertEqual(reviewed[self.paths[0]], before)
        self.assertEqual((self.target / self.paths[0]).read_bytes(), b'new-media')

    def test_copy_start_revalidation_journal_failure_prevents_nas_write(self):
        self.hashed_candidate(); self.change_ctime()
        with mock.patch.object(copying.os, 'fsync', side_effect=OSError('journal sync failed')), self.assertRaises(OSError):
            self.copy()
        self.assertFalse((self.target / self.paths[0]).exists())
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_copy_start_revalidation_does_not_accept_corruption_or_temp_drift(self):
        self.change_ctime()
        with self.assertRaisesRegex(RuntimeError, 'without a SHA256 filename'): self.copy()
        self.hashed_candidate()
        expected = self.tree[self.paths[0]]
        self.file.write_bytes(b'bad-media')
        os.utime(str(self.file), ns=(expected['mtime_ns'], expected['mtime_ns']))
        with self.assertRaisesRegex(RuntimeError, 'differs from its hash filename'): self.copy()
        self.assertFalse((self.target / self.paths[0]).exists())
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_ctime_only_change_during_copy_is_not_retried_or_published(self):
        self.hashed_candidate()
        original = copying.digest
        def changed(fd, size):
            value = original(fd, size)
            self.change_ctime()
            return value
        with mock.patch.object(copying, 'digest', side_effect=changed), self.assertRaisesRegex(RuntimeError, 'before publication'):
            self.copy()
        self.assertFalse((self.target / self.paths[0]).exists())
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_retry_after_partial_copy_keeps_published_file_and_fills_next_file(self):
        self.copy()
        target = self.target / self.paths[0]; target.chmod(0o600)
        previous = target.stat()
        next_file = self.source / 'video' / (hashlib.sha256(b'next-file').hexdigest() + '.mp4')
        next_file.write_bytes(b'next-file'); next_file.chmod(0o644)
        next_path = 'video/' + next_file.name
        # A second candidate is already in this simulated prepared batch.
        self.tree[next_path] = copying.stamp(next_file.stat())
        next_file.chmod(0o600); next_file.chmod(0o644)
        outcome, _ = self.copy()
        self.assertEqual(outcome, 'already_present')
        outcome, _ = copying.copy_one(self.src, self.dst, self.stg, next_path, self.tree, self.dirs, self.journal)
        self.assertEqual(outcome, 'copied')
        self.assertEqual((target.stat().st_ino, target.stat().st_mode, target.stat().st_mtime_ns),
                         (previous.st_ino, previous.st_mode, previous.st_mtime_ns))
        self.assertEqual((self.target / next_path).read_bytes(), b'next-file')

    def test_source_recheck_rejects_missing_symlink_hardlink_and_replaced_parent(self):
        self.hashed_candidate()
        self.file.unlink()
        with self.assertRaises(RuntimeError): copying.recheck_sources(self.src, self.tree, self.paths)
        self.file.symlink_to(self.keep)
        with self.assertRaises(RuntimeError): copying.recheck_sources(self.src, self.tree, self.paths)
        self.file.unlink(); self.file.write_bytes(b'new-media'); self.hashed_candidate()
        os.link(str(self.file), str(self.source / 'extra-link'))
        with self.assertRaisesRegex(RuntimeError, 'nlink'): copying.recheck_sources(self.src, self.tree, self.paths)
        (self.source / 'extra-link').unlink()
        (self.source / 'video').rename(self.source / 'retained')
        (self.source / 'video').symlink_to(self.source / 'retained', target_is_directory=True)
        with self.assertRaises(RuntimeError): copying.recheck_sources(self.src, self.tree, self.paths)
        (self.source / 'video').unlink(); (self.source / 'video').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'directory was replaced'):
            copying.recheck_sources(self.src, self.tree, self.paths)

    def test_missing_only_copy_preserves_source_and_nas_extras(self):
        before = self.file.stat(); keep = self.keep.stat()
        outcome, sha = self.copy()
        self.assertEqual(outcome, 'copied'); self.assertEqual(sha, hashlib.sha256(b'new-media').hexdigest())
        target = self.target / self.paths[0]
        self.assertEqual(target.read_bytes(), b'new-media')
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)
        self.assertEqual(target.stat().st_mtime, before.st_mtime)
        self.assertEqual(target.stat().st_nlink, 1)
        self.assertEqual(self.file.read_bytes(), b'new-media')
        self.assertEqual((self.file.stat().st_ino, self.file.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertEqual(self.keep.read_bytes(), b'nas-only')
        self.assertEqual((self.keep.stat().st_mode, self.keep.stat().st_mtime_ns), (keep.st_mode, keep.st_mtime_ns))
        self.assertEqual(list(self.stage.iterdir()), [])
        records = [json.loads(line) for line in (self.output / 'journal.jsonl').read_text().splitlines()]
        self.assertEqual([r['event'] for r in records], ['stage_created', 'publish_intent', 'published_verified'])

    def test_retry_reads_existing_without_changing_its_mode_or_inode(self):
        self.copy()
        target = self.target / self.paths[0]; target.chmod(0o600)
        before = target.stat()
        with mock.patch.object(copying.os, 'link', side_effect=AssertionError('no publication on retry')):
            outcome, _ = self.copy()
        self.assertEqual(outcome, 'already_present')
        self.assertEqual((target.stat().st_ino, target.stat().st_mode, target.stat().st_mtime_ns),
                         (before.st_ino, before.st_mode, before.st_mtime_ns))
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_different_existing_target_is_never_overwritten(self):
        target = self.target / self.paths[0]; target.write_bytes(b'NAS-data!')
        with self.assertRaises(RuntimeError): self.copy()
        self.assertEqual(target.read_bytes(), b'NAS-data!')
        self.assertEqual(self.file.read_bytes(), b'new-media')
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_collision_during_link_preserves_the_concurrent_target(self):
        original = os.link
        def raced(source, name, **kwargs):
            (self.target / self.paths[0]).write_bytes(b'other-nas')
            return original(source, name, **kwargs)
        with mock.patch.object(copying.os, 'link', side_effect=raced), self.assertRaises(RuntimeError): self.copy()
        self.assertEqual((self.target / self.paths[0]).read_bytes(), b'other-nas')
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_same_content_collision_keeps_concurrent_nas_permissions(self):
        original = os.link
        def raced(source, name, **kwargs):
            target = self.target / self.paths[0]; target.write_bytes(b'new-media'); target.chmod(0o600)
            return original(source, name, **kwargs)
        with mock.patch.object(copying.os, 'link', side_effect=raced): outcome, _ = self.copy()
        self.assertEqual(outcome, 'already_present')
        self.assertEqual((self.target / self.paths[0]).stat().st_mode & 0o777, 0o600)

    def test_lost_nfs_link_reply_recognizes_only_own_published_inode(self):
        original = os.link
        def ambiguous(*args, **kwargs):
            original(*args, **kwargs)
            raise OSError(errno.EIO, 'reply lost after server committed LINK')
        with mock.patch.object(copying.os, 'link', side_effect=ambiguous): outcome, _ = self.copy()
        self.assertEqual(outcome, 'copied')
        self.assertEqual((self.target / self.paths[0]).stat().st_nlink, 1)
        self.assertEqual((self.target / self.paths[0]).read_bytes(), b'new-media')

    def test_unsupported_link_never_falls_back_to_overwriting_rename(self):
        with mock.patch.object(copying.os, 'link', side_effect=OSError(errno.EOPNOTSUPP, 'unsupported')), \
                mock.patch.object(copying.os, 'rename') as rename, self.assertRaises(OSError) as failure:
            self.copy()
        self.assertEqual(failure.exception.errno, errno.EOPNOTSUPP)
        rename.assert_not_called()
        self.assertFalse((self.target / self.paths[0]).exists())

    def test_changed_source_since_prepare_is_refused_before_writing_nas(self):
        self.file.write_bytes(b'changed-data')
        with self.assertRaises(RuntimeError): self.copy()
        self.assertFalse((self.target / self.paths[0]).exists())
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_source_change_during_staged_readback_blocks_publication(self):
        original = copying.digest
        def changed(fd, size):
            value = original(fd, size)
            self.file.write_bytes(b'changed')
            return value
        with mock.patch.object(copying, 'digest', side_effect=changed), self.assertRaises(RuntimeError): self.copy()
        self.assertFalse((self.target / self.paths[0]).exists())
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_bad_staged_readback_never_publishes(self):
        with mock.patch.object(copying, 'digest', return_value='wrong'), self.assertRaises(RuntimeError): self.copy()
        self.assertFalse((self.target / self.paths[0]).exists())
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_symlink_parent_or_leaf_is_refused(self):
        target = self.target / self.paths[0]; target.symlink_to(self.keep)
        with self.assertRaises((OSError, RuntimeError)): self.copy()
        target.unlink()
        (self.target / 'video').rename(self.target / 'retained')
        (self.target / 'video').symlink_to(self.target / 'retained', target_is_directory=True)
        with self.assertRaises((OSError, RuntimeError)): self.copy()
        self.assertEqual((self.target / 'retained/nas-only.bin').read_bytes(), b'nas-only')

    def test_interrupted_hardlink_pair_requires_review_not_automatic_deletion(self):
        target = self.target / self.paths[0]; target.write_bytes(b'new-media')
        os.link(str(target), str(self.stage / 'old-attempt'))
        with self.assertRaises(RuntimeError): self.copy()
        self.assertEqual(target.stat().st_nlink, 2)
        self.assertTrue((self.stage / 'old-attempt').exists())

    def test_unlinks_are_confined_to_own_private_temporary_files(self):
        original = os.unlink
        def unlink(name, **kwargs):
            self.assertTrue(name.startswith('file-'))
            self.assertEqual(kwargs, {'dir_fd': self.stg})
            return original(name, **kwargs)
        with mock.patch.object(copying.os, 'unlink', side_effect=unlink): self.copy()
        self.assertTrue(self.file.exists()); self.assertTrue(self.keep.exists())

    def test_manifest_checksum_and_path_traversal_are_refused(self):
        manifest = self.output / 'union-manifest.jsonl'; original = manifest.read_bytes()
        manifest.write_bytes(original + b'\n')
        with self.assertRaises((ValueError, RuntimeError)): copying.read_manifest(self.out, self.plan)
        records = [json.loads(line) for line in original.splitlines()]
        next(r for r in records if r['kind'] == 'ssd_only')['path'] = '../escape'
        data = b''.join((json.dumps(r) + '\n').encode() for r in records)
        manifest.write_bytes(data)
        self.plan['manifest_sha256'] = hashlib.sha256(data).hexdigest()
        with self.assertRaises(RuntimeError): copying.read_manifest(self.out, self.plan)

    def test_missing_parent_or_budget_never_expands_copy_scope(self):
        with mock.patch.object(copying, 'MAX_FILES', 0), self.assertRaises(RuntimeError):
            copying.read_manifest(self.out, self.plan)
        manifest = self.output / 'union-manifest.jsonl'
        records = [json.loads(line) for line in manifest.read_bytes().splitlines()]
        next(r for r in records if r['kind'] == 'directory' and r['path'] == 'video')['target'] = None
        data = b''.join((json.dumps(r) + '\n').encode() for r in records)
        manifest.write_bytes(data); self.plan['manifest_sha256'] = hashlib.sha256(data).hexdigest()
        with self.assertRaises(RuntimeError): copying.read_manifest(self.out, self.plan)

    def test_background_job_keeps_ssd_readonly_and_routes_only_infra(self):
        path = planning.REPORT_ROOT + '/infra-' + 'a' * 32
        routed = catalog.route(['infra', 'repair', 'copy', path], manage.CONFIG)
        self.assertEqual(routed, ['repair-copy', 'part1', path])
        args = manage.parser().parse_args(routed)
        with mock.patch.object(manage, 'run', return_value='') as run:
            manage.launch('repair-copy', manage.profiles()['part1'], args)
        command = run.call_args.args[0]
        self.assertIn('--property=ReadOnlyPaths=/data', command)
        self.assertIn('--property=Nice=19', command)
        self.assertEqual(command[-3:], ['_execute-repair-copy', 'part1', path])
        with self.assertRaises(RuntimeError): catalog.route(['delta', 'repair', 'copy', path], manage.CONFIG)
        for value in ('/tmp/x', path + '/../other', manage.profiles()['part1']['report']):
            with self.assertRaises(RuntimeError): copying.validate_path(value)

    def test_complete_copy_and_repeat_keep_historical_plan_and_deployment_unchanged(self):
        self.complete_copy_and_repeat()

    def test_ctime_revalidation_is_durable_before_nas_write_and_preserves_original_plan(self):
        self.hashed_candidate(); self.change_ctime()
        self.complete_copy_and_repeat(ctime_revalidated=True)

    def complete_copy_and_repeat(self, ctime_revalidated=False):
        profile = manage.profiles()['part1']
        report_path = planning.REPORT_ROOT + '/infra-' + 'a' * 32
        history = {'schema': 1, 'volume': manage.prep.VOLUME, 'report_directory': profile['report'],
                   'phase': 'running_on_nas', 'final_sync_passed': True, 'nas_may_have_writes': True,
                   'reclaim_ready': False, 'new_ids': {n: n for n in manage.prep.SERVICES},
                   'databases': {'postgres': 'pg', 'redis': 'rd'}}
        marker = {'phase': 'cutover_running_on_nas', 'job_id': 'original'}
        self.plan.update(schema=1, phase='prepared', report_directory=report_path,
                         historical_report=profile['report'], historical_execution=history,
                         volume=manage.prep.VOLUME, nfs_volume=manage.prep.NFS_VOLUME,
                         application_image=planning.APP_IMAGE, gateway_image=planning.GATEWAY_IMAGE,
                         execution_allowed=False, reclaim_ready=False, nas_marker=marker)
        baseline = {'config_files_sha256': {'env': 'current'}, 'consumer_fingerprint': 'current'}
        for name, value in (('repair-plan.json', self.plan), ('deployment-baseline.private.json', baseline),
                            ('execution.json', history)):
            (self.output / name).write_text(json.dumps(value)); (self.output / name).chmod(0o600)
        before = {p.name: p.read_bytes() for p in self.output.iterdir() if p.is_file()}
        job_fd = os.open(str(self.job), copying.DIR_FLAGS); self.fds.append(job_fd)
        operations = []
        def operation(path, fd):
            op = mock.Mock(path=path, output=fd, held=[], source=None, target=None, job=None)
            def opened(**kwargs):
                self.assertEqual(kwargs, {'sealed': True})
                op.source, op.target, op.job = os.dup(self.src), os.dup(self.dst), os.dup(job_fd)
                op.held.extend((op.source, op.target, op.job))
            def close():
                for item in op.held: os.close(item)
                op.held.clear()
            op.open_media.side_effect = opened; op.close.side_effect = close
            operations.append(op)
            return op
        def read_json(fd, name):
            leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            with os.fdopen(leaf) as stream: return json.load(stream)
        volume = {'Name': manage.prep.NFS_VOLUME, 'Driver': 'local', 'Options': manage.prep.OPTIONS}
        with mock.patch.object(copying, 'open_report', side_effect=lambda path: os.dup(self.out)), \
                mock.patch.object(copying.cutover, 'open_report', side_effect=lambda path: os.dup(self.out)), \
                mock.patch.object(copying.cutover, 'Cutover', side_effect=operation), \
                mock.patch.object(copying.cutover, 'read_json', side_effect=read_json), \
                mock.patch.object(copying.prep, 'file_hashes', return_value={'env': 'current'}), \
                mock.patch.object(copying.precopy, 'inspect_containers', return_value=[]), \
                mock.patch.object(copying.precopy, 'check_consumers', return_value='current'), \
                mock.patch.object(copying.precopy, 'read_state', return_value=marker), \
                mock.patch.object(copying.cutover, 'select_services', return_value={}), \
                mock.patch.object(copying.reclaim_plan, 'health_guard'), \
                mock.patch.object(copying.reclaim_plan, 'extra_source_consumers', return_value=[]), \
                mock.patch.object(manage, 'run', return_value=json.dumps([volume])) as run:
            original_copy = copying.copy_one
            def require_revalidation_record(*args):
                if ctime_revalidated:
                    records = list(self.output.glob('copy-*/source-revalidation.json'))
                    self.assertEqual(len(records), 1)
                    self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)
                    record = json.loads(records[0].read_text())
                    self.assertEqual(record['manifest_sha256'], self.plan['manifest_sha256'])
                    self.assertEqual(record['entries'][0]['prepared'], self.tree[self.paths[0]])
                    self.assertEqual(record['entries'][0]['sha256'], hashlib.sha256(b'new-media').hexdigest())
                return original_copy(*args)
            with mock.patch.object(copying, 'copy_one', side_effect=require_revalidation_record):
                first = copying.execute(manage, profile, report_path)
            second = copying.execute(manage, profile, report_path)
            # An environment change must stop before any further NAS staging.
            folders = sorted(p.name for p in self.job.iterdir())
            with mock.patch.object(copying.prep, 'file_hashes', return_value={'env': 'changed'}), self.assertRaises(RuntimeError):
                copying.execute(manage, profile, report_path)
        self.assertEqual(first['copied'], 1); self.assertEqual(first['already_present'], 0)
        self.assertEqual(second['copied'], 0); self.assertEqual(second['already_present'], 1)
        self.assertFalse(first['reclaim_ready']); self.assertFalse(first['production_restart'])
        self.assertEqual(first['source_ctime_revalidated'], int(ctime_revalidated))
        self.assertEqual(sorted(p.name for p in self.job.iterdir()), folders)
        for name, data in before.items(): self.assertEqual((self.output / name).read_bytes(), data)
        for op in operations:
            for method in ('stop', 'start', 'sync', 'seal', 'checkpoint', 'command'):
                getattr(op, method).assert_not_called()
            self.assertEqual(op.held, [])
        self.assertTrue(all(c.args[0] == ['docker', 'volume', 'inspect', manage.prep.NFS_VOLUME] for c in run.call_args_list))
        results = list(self.output.glob('copy-*/result.json'))
        self.assertEqual(len(results), 2)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in results))
        self.assertFalse(list(self.job.glob('.mx-static-repair-copy-*')))
        self.assertTrue(self.file.exists()); self.assertTrue(self.keep.exists())


if __name__ == '__main__':
    unittest.main()
