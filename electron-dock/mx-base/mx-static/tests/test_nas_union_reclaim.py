import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import catalog
import cutover
import cutover_prepare as prep
import manage
import reclaim
from projects import infra_reclaim as review
from test_nas_repair_switch import LocalFiles, local_json


class UnionReviewTests(LocalFiles):
    def setUp(self):
        super().setUp()
        for root in (self.source, self.target):
            self.put(root, 'video/shared.mp4')
            self.put(root, 'video/raw-media-x.tmp', mode=0o644 if root == self.source else 0o600)
        self.put(self.source, 'video/mtime.mp4')
        self.put(self.target, 'video/mtime.mp4', when=1000000002)
        self.put(self.target, 'live/nas-only', b'live')
        (self.target / 'live/unchecked-link').symlink_to('/missing')
        self.tree = review.source_inventory(self.src, 'fixture')
        name = 'repair-final-' + 'a' * 32
        final = self.output / name; final.mkdir(mode=0o700)
        fd = os.open(str(final), review.DIR_FLAGS)
        try:
            sha = review.write_tree(fd, 'files.jsonl', self.tree)
            prep.private_write(fd, 'result.json', {'source_manifest_sha256': sha,
                'final_sync_passed': True, 'live_snapshot': False, 'stopped_writer_recheck_required': False})
        finally: os.close(fd)
        self.op = mock.Mock(source=self.src, target=self.dst, job=self.jobfd, output=self.out,
            path=str(self.output), state={'repair_of': '/historical', 'final_review': str(final), 'phase': 'running_on_nas'})
        self.profile = manage.profiles()['part1']
        self.restored = {'verified': True, 'installed_current': True, 'selected': True, 'timer': {}}
        self.rows = {n: {'Id': n} for n in prep.SERVICES}

    def run_check(self, accepted=False):
        @contextlib.contextmanager
        def operation(*a, **kw): yield self.op, self.rows
        with mock.patch.object(manage, 'operation', operation), \
                mock.patch.object(review.reclaim_plan, 'guard'), \
                mock.patch.object(review.precopy, 'read_state', return_value={'phase': 'cutover_running_on_nas'}), \
                mock.patch.object(review.infra_repair_switch, 'media_guard'), \
                mock.patch.object(review.infra_storage, 'check', return_value=True), \
                mock.patch.object(cutover, 'read_json', side_effect=local_json), \
                mock.patch.object(review, 'recovery_evidence', side_effect=lambda m: dict(self.restored)):
            return review.check(manage, self.profile, accepted)

    def plan_fd(self, result):
        fd = os.open(result['plan_directory'], review.DIR_FLAGS)
        self.addCleanup(os.close, fd)
        return fd

    def test_readonly_review_retains_both_trees_and_records_pending_business_acceptance(self):
        before_source = review.source_inventory(self.src, 'before')
        before_nas = review.counterparts(self.dst, self.tree)
        result = self.run_check()
        self.assertEqual(result['regular_files'], 3)
        self.assertTrue(result['files_verified']); self.assertFalse(result['reclaim_ready'])
        self.assertFalse(result['business_acceptance_recorded']); self.assertFalse(result['deletion_authorized'])
        self.assertTrue(result['recovery']['verified']); self.assertFalse(result['source_deleted'])
        self.assertEqual(result['comparison']['hashed_equal'], 1)
        self.assertEqual(result['comparison']['nas_attributes_retained'], 1)
        self.assertEqual(review.source_inventory(self.src, 'after'), before_source)
        self.assertEqual(review.counterparts(self.dst, self.tree), before_nas)
        self.op.stop.assert_not_called(); self.op.start.assert_not_called(); self.op.seal.assert_not_called()
        self.op.checkpoint.assert_not_called(); self.op.command.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'accepted UNION'):
            review.read_verified_target(self.plan_fd(result), result, self.tree, self.op.state)

    def test_recovery_not_verified_cannot_become_ready_even_with_acceptance(self):
        self.restored['verified'] = False
        result = self.run_check(True)
        self.assertFalse(result['reclaim_ready']); self.assertTrue(result['business_acceptance_recorded'])

    def test_changed_ssd_since_stopped_review_is_rejected_before_hashing(self):
        self.put(self.source, 'video/new.mp4')
        with mock.patch.object(review, 'digest') as digest, self.assertRaisesRegex(RuntimeError, 'stopped-writer'):
            self.run_check()
        digest.assert_not_called()

    def test_missing_or_changed_nas_content_retains_all_ssd(self):
        self.put(self.target, 'video/mtime.mp4', b'y' * 2048, when=1000000002)
        with self.assertRaisesRegex(RuntimeError, 'Content differs'): self.run_check()
        self.assertEqual(review.source_inventory(self.src, 'after'), self.tree)
        (self.target / 'video/mtime.mp4').unlink()
        with self.assertRaises(FileNotFoundError): self.run_check()
        self.assertEqual(review.source_inventory(self.src, 'after'), self.tree)

    def test_hash_budget_failure_does_not_read_all_contents(self):
        with mock.patch.object(review.infra_repair, 'MAX_HASH_BYTES', 1), mock.patch.object(review, 'digest') as digest:
            with self.assertRaisesRegex(RuntimeError, 'budget'): self.run_check()
        digest.assert_not_called()

    def test_nas_change_after_hashing_invalidates_plan(self):
        write = review.write_tree
        def changed(folder, name, tree):
            value = write(folder, name, tree)
            if name == 'nas-files.jsonl': (self.target / 'video/mtime.mp4').chmod(0o644)
            return value
        with mock.patch.object(review, 'write_tree', side_effect=changed), self.assertRaisesRegex(RuntimeError, 'NAS file'):
            self.run_check(True)
        self.assertEqual(review.source_inventory(self.src, 'after'), self.tree)

    def test_saved_target_manifest_and_execution_are_bound_to_accepted_plan(self):
        result = self.run_check(True); fd = self.plan_fd(result)
        self.assertTrue(result['reclaim_ready']); self.assertFalse(result['deletion_authorized'])
        nas = review.read_verified_target(fd, result, self.tree, self.op.state)
        self.assertEqual(set(nas), set(self.tree))
        with self.assertRaisesRegex(RuntimeError, 'accepted UNION'):
            review.read_verified_target(fd, result, self.tree, dict(self.op.state, phase='changed'))
        path = Path(result['plan_directory']) / 'nas-files.jsonl'
        path.write_bytes(path.read_bytes() + b'\n')
        with self.assertRaises((RuntimeError, ValueError)):
            review.read_verified_target(fd, result, self.tree, self.op.state)

    def test_future_deleter_checks_nas_baseline_attributes_and_retains_all_nas_data(self):
        result = self.run_check(True); fd = self.plan_fd(result)
        nas = review.read_verified_target(fd, result, self.tree, self.op.state)
        journal = reclaim.private_file(fd, 'unlink-intents.jsonl', os.O_RDWR | os.O_CREAT | os.O_APPEND)
        self.addCleanup(os.close, journal)
        paths = reclaim.remaining_files(self.src, self.tree, set())
        (self.target / 'live/after-plan').write_bytes(b'new live data')
        with self.assertRaises(RuntimeError): reclaim.check_nas_files(self.dst, self.tree, paths)
        reclaim.check_nas_files(self.dst, self.tree, paths, nas_tree=nas)
        count, _ = reclaim.delete_files(self.src, self.dst, self.tree, paths, journal, lambda: None, nas_tree=nas)
        self.assertEqual(count, 3)
        self.assertTrue((self.source / 'video').is_dir())
        self.assertEqual(review.counterparts(self.dst, self.tree), nas)
        self.assertEqual((self.target / 'live/after-plan').read_bytes(), b'new live data')
        self.assertTrue((self.target / 'live/unchecked-link').is_symlink())

    def test_future_deletion_refuses_changed_nas_ctime_even_if_old_quick_fields_match(self):
        result = self.run_check(True); fd = self.plan_fd(result)
        nas = review.read_verified_target(fd, result, self.tree, self.op.state)
        path = self.target / 'video/shared.mp4'; path.chmod(0o644); path.chmod(0o600)
        journal = reclaim.private_file(fd, 'unlink-intents.jsonl', os.O_RDWR | os.O_CREAT | os.O_APPEND)
        self.addCleanup(os.close, journal)
        with self.assertRaisesRegex(RuntimeError, 'NAS file'):
            reclaim.delete_files(self.src, self.dst, self.tree, ['video/shared.mp4'], journal, lambda: None, nas_tree=nas)
        self.assertTrue((self.source / 'video/shared.mp4').is_file())

    def test_nas_directory_replacement_invalidates_future_deletion(self):
        result = self.run_check(True); fd = self.plan_fd(result)
        nas = review.read_verified_target(fd, result, self.tree, self.op.state)
        (self.target / 'video').rename(self.target / 'video-old')
        (self.target / 'video').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'parent identity'):
            reclaim.check_nas_files(self.dst, self.tree, ['video/shared.mp4'], nas_tree=nas)


class RegistryTests(unittest.TestCase):
    def test_second_drift_clears_selection_and_missing_plan_blocks_deletion(self):
        profile = manage.profiles()['part1']
        self.assertTrue(profile['report'].endswith('-33e5abb193d04e7595251a5e6a6046ae'))
        self.assertIsNone(profile['plan'])
        accepted = dict(profile, plan=profile['report'] + '/reclaim-plan-a1dc4bb0dfea4d5d83ce143daaf052e9')
        with mock.patch.object(manage, 'run') as run, self.assertRaisesRegex(RuntimeError, 'requires --business-accepted'):
            manage.launch('reclaim', accepted, manage.parser().parse_args(['reclaim', 'part1']))
        run.assert_not_called()
        with mock.patch.object(manage, 'run') as run, self.assertRaisesRegex(RuntimeError, 'No current reclaim plan'):
            manage.launch('reclaim', profile, manage.parser().parse_args(['reclaim', 'part1', '--business-accepted']))
        run.assert_not_called()

    def test_check_is_a_readonly_background_job_and_never_implies_acceptance(self):
        route = catalog.route(['infra', 'cleanup', 'check'], manage.CONFIG)
        self.assertEqual(route, ['reclaim-check', 'part1'])
        args = manage.parser().parse_args(route); self.assertFalse(args.business_accepted)
        with mock.patch.object(manage, 'run', return_value='') as run, contextlib.redirect_stdout(io.StringIO()):
            manage.launch(args.action, manage.profiles()['part1'], args)
        command = run.call_args[0][0]
        self.assertIn('--property=ReadOnlyPaths=/data /mnt/nas', command)
        self.assertIn('_execute-reclaim-check', command); self.assertNotIn('--business-accepted', command)
        with self.assertRaises(RuntimeError): catalog.route(['delta', 'cleanup', 'check'], manage.CONFIG)

    def test_recovery_evidence_requires_current_install_selected_policy_and_persistent_timer(self):
        manager = mock.Mock(UNIT='mx-static-nas-boot')
        manager.auto_config.return_value = {'mode': 'migrated', 'enabled_parts': []}
        manager.run.return_value = 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n'
        with mock.patch.object(review.recovery, 'installed_current', return_value=True):
            self.assertTrue(review.recovery_evidence(manager)['verified'])
            manager.auto_config.return_value['suspended'] = True
            self.assertFalse(review.recovery_evidence(manager)['verified'])
            manager.auto_config.return_value['suspended'] = False
            manager.run.return_value = 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled-runtime\n'
            self.assertFalse(review.recovery_evidence(manager)['verified'])
        with mock.patch.object(review.recovery, 'installed_current', return_value=False):
            self.assertFalse(review.recovery_evidence(manager)['verified'])
