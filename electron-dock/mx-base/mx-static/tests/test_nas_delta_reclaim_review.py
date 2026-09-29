"""Same-plan runtime review after partial deletion: disposable files, mocked host."""
import json
import os
from pathlib import Path
import unittest
from unittest import mock

import test_nas_delta_cleanup as fixtures
import catalog
import manage
import reclaim
from projects import delta_cleanup as cleanup
from projects import delta_reclaim_review as reviews
from projects import delta_reclaim_files as proofs
from projects import infra_reclaim_runtime as evidence
from verify import stamp


class PartialRuntimeReviewTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.DeltaCleanupTests(); self.addCleanup(self.f.doCleanups); self.f.setUp()
        self.plan = self.f.prepare(); self.folder = Path(self.plan['plan_directory'])
        self.f.interrupt(self.plan)
        self.journal = self.folder / 'unlink-intents.jsonl'
        self.owner = self.f.f.report / cleanup.OWNER
        self.old_evidence = {p: (stamp(p.stat()), p.read_bytes()) for p in self.f.f.report.rglob('*') if p.is_file()}
        self.redeploy()

    def redeploy(self):
        c = self.f.f.service('worker')
        c['Id'] += '-new'; c['Image'] = c.get('Image', '') + '-new'
        c['State']['Pid'] += 1
        c['Config']['Env'].append('NEW_SECRET=must-not-print')

    def run_cleanup(self, **kwargs):
        return cleanup.execute(self.f.manager, self.f.profile, str(self.folder), **kwargs)

    def review(self): return self.run_cleanup(review_runtime=True)

    def remaining(self):
        return {p: (stamp(p.stat()), p.read_bytes()) for p in self.f.m.source.rglob('*') if p.is_file()}

    def assert_original_evidence(self):
        for p, v in self.old_evidence.items(): self.assertEqual((stamp(p.stat()), p.read_bytes()), v, str(p))
        self.f.assert_preserved()

    def test_review_is_readonly_and_never_auto_selected_then_explicit_resume(self):
        before = self.remaining()
        with mock.patch.object(reclaim.os, 'unlink', side_effect=AssertionError('review cannot unlink')), \
                mock.patch.object(proofs, 'digest', side_effect=AssertionError('review cannot hash media')):
            result = self.review()
        path = result['review_directory']; value = json.loads((Path(path) / 'review.json').read_text())
        self.assertEqual(result['statistics']['remaining_files'], 1)
        self.assertEqual(result['statistics']['missing_with_intent'], 1)
        self.assertTrue(result['business_acceptance_pending']); self.assertFalse(result['deletion_authorized'])
        self.assertFalse(value['business_acceptance_recorded'])
        self.assertEqual(value['original_runtime_sha256'], self.plan['runtime_snapshot_sha256'])
        self.assertIn('worker', result['changes']['changed_services'])
        self.assertEqual(result['changes']['changed_fields'], [])
        self.assertNotIn('must-not-print', json.dumps(value))
        self.assertIn('--runtime-review '+path, result['resume_command'])
        self.assertEqual(self.remaining(), before); self.assert_original_evidence()
        for kw in ({'inspect_ctime': True}, {'business_accepted': True}):
            with self.assertRaisesRegex(RuntimeError, 'runtime changed'): self.run_cleanup(**kw)
        with self.assertRaisesRegex(RuntimeError, 'business-accepted'): self.run_cleanup(runtime_review=path)
        inspected = self.run_cleanup(runtime_review=path, inspect_ctime=True)
        self.assertIn('--runtime-review '+path, inspected['resume_command'])
        result = self.run_cleanup(runtime_review=path, business_accepted=True)
        self.assertEqual(result['removed_this_run'], 1)
        self.assertEqual(result['runtime_review_directory'], path)
        self.assertEqual(result['manifest_files_total'], 2)
        self.assertEqual(self.remaining(), {})
        self.f.assert_preserved()

    def test_original_runtime_mismatch_reports_unknown_history_not_no_partial_delete(self):
        with mock.patch.object(cleanup, 'emit') as emit:
            with self.assertRaisesRegex(RuntimeError, 'runtime changed'): self.run_cleanup(inspect_ctime=True)
        failure = emit.call_args.kwargs
        self.assertIsNone(failure['may_be_partially_reclaimed'])
        self.assertFalse(failure['prior_ownership_checked']); self.assertTrue(failure['inspect_only'])
        self.assertEqual(len(self.remaining()), 1)

    def test_new_deployment_after_review_still_blocks_selected_resume(self):
        path = self.review()['review_directory']; self.redeploy(); before = self.remaining()
        with self.assertRaisesRegex(RuntimeError, 'runtime changed'):
            self.run_cleanup(runtime_review=path, business_accepted=True)
        self.assertEqual(self.remaining(), before); self.assert_original_evidence()

    def test_runtime_changes_while_review_is_written_leave_no_valid_seal(self):
        write = reviews.prep.private_write
        def redeploy(fd, name, value):
            write(fd, name, value)
            if name == 'review.json': self.redeploy()
        with mock.patch.object(reviews.prep, 'private_write', side_effect=redeploy):
            with self.assertRaisesRegex(RuntimeError, 'runtime changed'): self.review()
        path = next(self.folder.glob('runtime-review-*'))
        self.assertFalse((path / 'complete.json').exists())
        with self.assertRaises(FileNotFoundError): self.run_cleanup(runtime_review=str(path), business_accepted=True)
        self.assert_original_evidence()

    def test_review_rejects_nas_fallback_and_exposed_ssd_alias(self):
        c = self.f.f.service('web'); original = c['Mounts'][:]
        c['Mounts'] = [m for m in original if m['Destination'] != cleanup.media.RAW]
        with self.assertRaises(RuntimeError): self.review()
        c['Mounts'] = original + [{'Type': 'bind', 'Source': cleanup.media.SOURCE, 'Destination': '/exposed', 'RW': True}]
        with self.assertRaisesRegex(RuntimeError, 'extra mount'): self.review()
        self.assertFalse(list(self.folder.glob('runtime-review-*'))); self.assert_original_evidence()

    def test_recovery_unhealthy_dependencies_and_failed_probe_do_not_seal(self):
        self.f.f.f.policy['suspended'] = True
        with self.assertRaisesRegex(RuntimeError, 'recovery is not'): self.review()
        self.f.f.f.policy['suspended'] = False
        self.f.f.service('postgres')['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaises(RuntimeError): self.review()
        self.f.f.service('postgres')['State']['Health']['Status'] = 'healthy'
        with mock.patch.object(cleanup.cutover.Cutover, 'http_probe', side_effect=RuntimeError('HTTP probe failed')):
            with self.assertRaisesRegex(RuntimeError, 'HTTP probe failed'): self.review()
        self.assertFalse(list(self.folder.glob('runtime-review-*'))); self.assert_original_evidence()

    def test_unknown_missing_ssd_or_new_ssd_entry_cannot_be_adopted(self):
        before = self.journal.read_bytes(); self.journal.write_bytes(b'')
        with self.assertRaisesRegex(RuntimeError, 'Unjournaled missing|directory changed since the plan'): self.review()
        self.journal.write_bytes(before)
        p = self.f.m.source / 'video/unexpected'; p.write_bytes(b'keep')
        with self.assertRaisesRegex(RuntimeError, 'unexpected entries'): self.review()
        self.assertTrue(p.exists()); self.assertFalse(list(self.folder.glob('runtime-review-*')))

    def test_nas_nonctime_metadata_change_is_not_accepted(self):
        remaining = next(iter(self.remaining())).relative_to(self.f.m.source)
        (self.f.m.target / remaining).chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'Non-ctime NAS differences'): self.review()
        self.assertFalse(list(self.folder.glob('runtime-review-*')))

    def test_journal_cannot_be_truncated_or_replaced_or_lost_after_review(self):
        path = self.review()['review_directory']; original = self.journal.read_bytes()
        self.journal.write_bytes(b'')
        with self.assertRaisesRegex(RuntimeError, 'journal prefix'): self.run_cleanup(runtime_review=path, business_accepted=True)
        self.journal.write_bytes(original.replace(b'unlink_intent', b'xxxxxx_intent'))
        with self.assertRaisesRegex(RuntimeError, 'journal prefix'): self.run_cleanup(runtime_review=path, business_accepted=True)
        self.journal.unlink()
        with self.assertRaises(FileNotFoundError): self.run_cleanup(runtime_review=path, business_accepted=True)
        self.assertFalse(self.journal.exists()); self.assertEqual(len(self.remaining()), 1)

    def test_same_review_can_resume_after_appended_intents_and_another_interruption(self):
        path = self.review()['review_directory']; prefix = self.journal.read_bytes()
        with mock.patch.object(reclaim.os, 'unlink', side_effect=OSError('another interruption')):
            with self.assertRaisesRegex(OSError, 'another interruption'):
                self.run_cleanup(runtime_review=path, business_accepted=True)
        self.assertGreater(len(self.journal.read_bytes()), len(prefix))
        self.assertTrue(self.journal.read_bytes().startswith(prefix))
        self.assertEqual(self.run_cleanup(runtime_review=path, business_accepted=True)['removed_this_run'], 1)
        self.f.assert_preserved()

    def test_review_json_and_completion_seal_are_checked_and_pinned(self):
        path = Path(self.review()['review_directory']); original = (path / 'review.json').read_bytes()
        value = json.loads(original); value['runtime']['project'] = 'other-project'
        (path / 'review.json').write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'scope/checksum'): self.run_cleanup(runtime_review=str(path), business_accepted=True)
        (path / 'review.json').write_bytes(original)
        with reviews.load(str(path), self.plan, reviews.media.read_private(self.open_folder(), 'plan.json')[1]) as selected:
            (path / 'complete.json').write_bytes(b'{}')
            with self.assertRaisesRegex(RuntimeError, 'Selected runtime review changed'): selected['guard']()
        with self.assertRaisesRegex(RuntimeError, 'scope/checksum'): self.run_cleanup(runtime_review=str(path), business_accepted=True)

    def open_folder(self):
        fd = os.open(str(self.folder), reclaim.DIR_FLAGS); self.addCleanup(os.close, fd); return fd

    def test_review_from_other_plan_or_different_storage_contract_is_refused(self):
        path = Path(self.review()['review_directory']); plan = dict(self.plan, plan_directory=str(self.folder)+'x')
        with self.assertRaisesRegex(RuntimeError, 'exact child'):
            with reviews.load(str(path), plan, 'x'): pass
        snapshot = cleanup.review.snapshot
        def different(*args):
            value, rows = snapshot(*args); value['contract_sha256'] = 'different'; return value, rows
        with mock.patch.object(cleanup.review, 'snapshot', side_effect=different):
            with self.assertRaisesRegex(RuntimeError, 'storage contract'): self.review()
        self.assert_original_evidence()

    def test_missing_owner_cannot_be_replaced_by_runtime_review(self):
        self.owner.unlink()
        with self.assertRaisesRegex(RuntimeError, 'existing partial cleanup owner'): self.review()
        self.assertFalse(self.owner.exists()); self.assertEqual(len(self.remaining()), 1)

    def test_journal_change_during_review_write_prevents_completion(self):
        write = reviews.prep.private_write
        def change(fd, name, value):
            write(fd, name, value)
            if name == 'review.json':
                with self.journal.open('ab') as journal: journal.write(b'\n')
        with mock.patch.object(reviews.prep, 'private_write', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'Intent journal changed'): self.review()
        self.assertFalse(list(self.folder.glob('runtime-review-*/complete.json')))
        self.assertEqual(len(self.remaining()), 1)

    def test_missing_journal_review_does_not_create_replacement(self):
        self.journal.unlink()
        with self.assertRaises(FileNotFoundError): self.review()
        self.assertFalse(self.journal.exists()); self.assertTrue(self.owner.exists())
        self.assertFalse(list(self.folder.glob('runtime-review-*')))

    def test_cli_review_is_readonly_and_selection_is_explicit(self):
        path = str(self.folder / ('runtime-review-'+'a'*32))
        for options, writing in ((['--review-runtime'], False),
                (['--runtime-review',path,'--inspect-ctime'], False),
                (['--runtime-review',path,'--business-accepted'], True)):
            args = manage.parser().parse_args(catalog.route(['delta','cleanup',str(self.folder)]+options, manage.CONFIG))
            with mock.patch.object(manage, 'run', return_value='') as run:
                manage.launch('delta-reclaim', manage.profiles()['part2'], args)
            command = run.call_args.args[0]
            self.assertIn('--property=ReadOnlyPaths=/data /mnt/nas', command)
            self.assertEqual(any(c.startswith('--property=ReadWritePaths=') for c in command), writing)
            for token in options: self.assertIn(token, command)
        args.review_runtime = True
        with self.assertRaisesRegex(RuntimeError, 'separate operations'): manage.task_command('delta-reclaim', self.f.profile, args)


class ReviewedCtimeProofTests(unittest.TestCase):
    def setUp(self):
        import test_nas_delta_reclaim_files as fixtures_with_hash
        self.fixture = fixtures_with_hash.PartialDeltaCtimeResumeTests()
        self.addCleanup(self.fixture.doCleanups); self.fixture.setUp()
        self.f = self.fixture.f; self.plan = self.f.prepare()
        self.folder = Path(self.plan['plan_directory'])
        unlink = os.unlink; count = []
        def interrupt(name, **kwargs):
            if len(count) == 2: raise OSError('interrupted')
            count.append(name); return unlink(name, **kwargs)
        with mock.patch.object(reclaim.os, 'unlink', side_effect=interrupt):
            with self.assertRaisesRegex(OSError, 'interrupted'): self.f.execute(self.plan)
        self.f.f.service('worker')['Id'] += '-new'
        self.nas = self.f.m.target / self.fixture.path

    def execute(self, **kwargs):
        return cleanup.execute(self.f.manager, self.f.profile, str(self.folder), **kwargs)

    def test_selected_runtime_still_requires_two_fresh_complete_content_proofs(self):
        os.chmod(str(self.nas), self.nas.stat().st_mode)
        before = (stamp(self.nas.stat()), self.nas.read_bytes())
        reviewed = self.execute(review_runtime=True)
        self.assertEqual(reviewed['statistics']['ctime_only_candidates'], 1)
        self.assertFalse(list(self.folder.glob('ctime-proof-*')))
        result = self.execute(runtime_review=reviewed['review_directory'], business_accepted=True)
        self.assertEqual(result['removed_this_run'], 1)
        receipts = [json.loads(p.read_text()) for p in self.folder.glob('ctime-proof-*')]
        self.assertEqual(len(receipts), 2)
        for proof in receipts:
            self.assertEqual(proof['source_sha256'], self.fixture.sha)
            self.assertEqual(proof['nas_sha256'], self.fixture.sha)
            self.assertEqual(proof['runtime_snapshot_sha256'], self.plan['runtime_snapshot_sha256'])
            self.assertEqual(proof['active_runtime_sha256'], reviewed['runtime_sha256'])
            self.assertEqual(proof['runtime_review_directory'], reviewed['review_directory'])
        self.assertEqual((stamp(self.nas.stat()), self.nas.read_bytes()), before)
        for p, data in self.f.immutable.items(): self.assertEqual(p.read_bytes(), data)

    def test_metadata_review_never_waives_wrong_content_or_later_runtime_change(self):
        old = self.nas.stat(); self.nas.write_bytes(b'x' * old.st_size)
        os.utime(str(self.nas), ns=(old.st_atime_ns, old.st_mtime_ns))
        reviewed = self.execute(review_runtime=True)
        with self.assertRaisesRegex(RuntimeError, 'content/filename'):
            self.execute(runtime_review=reviewed['review_directory'], business_accepted=True)
        self.assertTrue((self.f.m.source / self.fixture.path).exists())
        self.assertFalse(list(self.folder.glob('ctime-proof-*')))


if __name__ == '__main__': unittest.main()
