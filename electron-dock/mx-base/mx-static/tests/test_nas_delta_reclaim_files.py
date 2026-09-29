"""Real files for bounded NAS ctime proofs and exact-plan partial resumption."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/nas'))
import reclaim
from projects import delta_reclaim_files as proofs
from verify import stamp


class CtimeProofTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.source, self.target, self.folder = (self.root / p for p in ('ssd', 'nas', 'plan'))
        for p in (self.source, self.target, self.folder): p.mkdir(mode=0o700)
        self.content = b'avatar-content'
        self.sha = hashlib.sha256(self.content).hexdigest()
        self.path = 'avatar/' + self.sha + '.png'
        for p in (self.source, self.target): (p / 'avatar').mkdir()
        self.ssd, self.nas = self.source / self.path, self.target / self.path
        self.ssd.write_bytes(self.content); shutil.copy2(str(self.ssd), str(self.nas))
        self.op = SimpleNamespace(source=self.open_dir(self.source), target=self.open_dir(self.target),
            tree=self.tree(self.source), nas_tree=self.tree(self.target))
        self.folderfd = self.open_dir(self.folder)
        self.journal = reclaim.private_file(self.folderfd, 'unlink-intents.jsonl', os.O_RDWR | os.O_CREAT | os.O_APPEND)
        self.stack.callback(os.close, self.journal)
        self.guard = mock.Mock()
        self.plan = dict(plan_directory=str(self.folder), check_sha256='a'*64, manifest_sha256='b'*64,
                         target_manifest_sha256='c'*64, runtime_snapshot_sha256='d'*64, regular_files=1)
        self.validate = proofs.CtimeRevalidator(self.op, self.folderfd, self.plan, 'e'*64, self.guard)

    def open_dir(self, p):
        fd = os.open(str(p), reclaim.DIR_FLAGS); self.stack.callback(os.close, fd)
        return fd

    def tree(self, p):
        return {path: stamp((p / path).stat()) for path in ('', 'avatar', self.path)}

    def drift(self):
        old = stamp(self.nas.stat())
        os.chmod(str(self.nas), self.nas.stat().st_mode)
        self.assertEqual([k for k in old if old[k] != stamp(self.nas.stat())[k]], ['ctime_ns'])

    def check(self, callback=None):
        reclaim.check_nas_files(self.op.target, self.op.tree, [self.path],
                                nas_tree=self.op.nas_tree, revalidate=callback)

    def delete(self):
        return reclaim.delete_files(self.op.source, self.op.target, self.op.tree, [self.path],
                                    self.journal, self.guard, nas_tree=self.op.nas_tree, revalidate=self.validate)

    def test_fresh_two_sided_proof_at_preflight_and_unlink_preserves_manifests_nas(self):
        frozen = copy.deepcopy((self.op.tree, self.op.nas_tree, self.plan))
        self.drift(); nas_before = stamp(self.nas.stat())
        with self.assertRaisesRegex(RuntimeError, 'NAS file missing/changed'): self.check()
        self.check(self.validate)
        unlink = os.unlink
        def verify_receipts(name, **kw):
            saved = [json.loads(p.read_text()) for p in self.folder.glob('ctime-proof-*.json')]
            self.assertEqual(len(saved), 2)  # Do not reuse the preflight proof.
            self.assertEqual(reclaim.read_intents(self.journal, self.op.tree), {self.path})
            for entry in saved:
                self.assertEqual(entry['nas_sha256'], self.sha)
                self.assertEqual(entry['source_sha256'], self.sha)
                self.assertEqual(entry['recorded_nas_metadata'], self.op.nas_tree[self.path])
                self.assertEqual(entry['current_nas_metadata'], nas_before)
                self.assertEqual(entry['plan_sha256'], 'e'*64)
            return unlink(name, **kw)
        with mock.patch.object(reclaim.os, 'unlink', side_effect=verify_receipts):
            self.assertEqual(self.delete(), (1, len(self.content)))
        self.assertEqual((self.op.tree, self.op.nas_tree, self.plan), frozen)
        self.assertEqual(stamp(self.nas.stat()), nas_before)
        self.assertEqual(self.nas.read_bytes(), self.content)
        self.assertTrue(self.ssd.parent.is_dir())

    def test_drift_between_preflight_and_delete_is_rehashed(self):
        self.check(self.validate); self.assertEqual(self.validate.pairs, 0)
        self.drift(); self.delete()
        self.assertEqual(self.validate.pairs, 1)

    def test_content_rewrite_with_same_size_mtime_is_refused(self):
        old = self.nas.stat()
        self.nas.write_bytes(b'x' * len(self.content))
        os.utime(str(self.nas), ns=(old.st_atime_ns, old.st_mtime_ns))
        with self.assertRaisesRegex(RuntimeError, 'content/filename hash differs'): self.check(self.validate)
        self.assertTrue(self.ssd.exists()); self.assertFalse(list(self.folder.glob('ctime-proof-*')))

    def test_other_nas_metadata_and_source_ctime_are_refused(self):
        self.nas.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'not eligible'): self.check(self.validate)
        self.nas.chmod(self.op.nas_tree[self.path]['mode'])
        os.chmod(str(self.ssd), self.ssd.stat().st_mode)
        with self.assertRaisesRegex(RuntimeError, 'File changed'): self.check(self.validate)
        self.assertTrue(self.ssd.exists())

    def test_non_digest_name_and_tmp_never_get_exception(self):
        for name in ('raw-media-abc.tmp', self.sha + '.tmp', self.sha + '.TMP', 'ordinary.png'):
            with self.subTest(name=name):
                path = 'avatar/' + name
                shutil.copy2(str(self.ssd), str(self.source / path))
                shutil.copy2(str(self.nas), str(self.target / path))
                self.op.tree[path] = stamp((self.source / path).stat())
                self.op.nas_tree[path] = stamp((self.target / path).stat())
                os.chmod(str(self.target / path), (self.target / path).stat().st_mode)
                with self.assertRaisesRegex(RuntimeError, 'not eligible'): self.validate(path)

    def test_file_pair_and_total_read_budgets_refuse_before_hashing(self):
        self.drift()
        for key, limit in (('MAX_FILE_BYTES', 1), ('MAX_PAIRS', 0), ('MAX_READ_BYTES', 1)):
            with self.subTest(key=key), mock.patch.object(proofs, key, limit), mock.patch.object(proofs, 'digest') as digest:
                with self.assertRaisesRegex(RuntimeError, 'budget exceeded'): self.check(self.validate)
                digest.assert_not_called()
        with mock.patch.object(proofs, 'MAX_PAIRS', 1):
            self.check(self.validate)
            with self.assertRaisesRegex(RuntimeError, 'budget exceeded'): self.check(self.validate)

    def test_large_video_default_refusal_inspection_and_exact_explicit_read_budget(self):
        self.ssd.unlink(); self.nas.unlink()
        self.content = b'm' * (17 * 1024 ** 2)
        self.sha = hashlib.sha256(self.content).hexdigest()
        self.path = 'avatar/' + self.sha + '.mp4'
        self.ssd, self.nas = self.source / self.path, self.target / self.path
        self.ssd.write_bytes(self.content); shutil.copy2(str(self.ssd), str(self.nas))
        self.op.tree, self.op.nas_tree = self.tree(self.source), self.tree(self.target)
        self.drift()
        with mock.patch.object(proofs, 'emit') as emit:
            with self.assertRaisesRegex(RuntimeError, 'max_file_bytes'): self.check(self.validate)
        info = emit.call_args.kwargs
        self.assertEqual(info['exceeded'], ['max_file_bytes'])
        self.assertEqual(info['file_bytes'], len(self.content))
        with mock.patch.object(proofs, 'digest', side_effect=AssertionError('inspection must not hash')):
            inspected = proofs.inspect_remaining(self.op, [self.path], self.plan, self.guard)
        self.assertEqual(inspected['planned_read_bytes'], 68 * 1024 ** 2)
        self.assertEqual(inspected['recommended_read_mib'], 68)
        self.assertIn('--ctime-proof-read-mib 68', inspected['resume_command'])
        self.assertFalse(inspected['content_verified'])
        self.assertEqual(list(self.folder.glob('ctime-proof-*')), [])
        self.validate = proofs.CtimeRevalidator(self.op, self.folderfd, self.plan, 'e'*64, self.guard,
                                               budget=proofs.limits(68, 2))
        self.check(self.validate)
        self.assertEqual(self.delete(), (1, len(self.content)))
        self.assertEqual(self.validate.read_bytes, 68 * 1024 ** 2)
        self.assertEqual(self.nas.read_bytes(), self.content)

    def test_pair_and_read_budget_diagnostics_are_distinct_and_never_skip_hashes(self):
        self.drift(); self.check(self.validate)
        for budget, exceeded in ((dict(max_file_bytes=999, max_pairs=1, max_read_bytes=999), ['max_pairs']),
                                 (dict(max_file_bytes=999, max_pairs=9, max_read_bytes=2*len(self.content)), ['max_read_bytes'])):
            with self.subTest(exceeded=exceeded), mock.patch.object(proofs, 'emit') as emit, mock.patch.object(proofs, 'digest') as digest:
                self.validate.budget = budget
                with self.assertRaisesRegex(RuntimeError, 'budget exceeded'): self.check(self.validate)
                digest.assert_not_called()
                self.assertEqual(emit.call_args.kwargs['exceeded'], exceeded)
                self.assertEqual(emit.call_args.kwargs['pairs_used'], 1)

    def test_explicit_budget_validation_refuses_unbounded_or_invalid_values(self):
        for value in (0, -1, 1.5, True, '100', 8388609):
            with self.subTest(value=value), self.assertRaises(RuntimeError): proofs.limits(read_mib=value)
        for value in (0, -1, True, '100', 800001):
            with self.subTest(value=value), self.assertRaises(RuntimeError): proofs.limits(pairs=value)

    def test_larger_budget_does_not_admit_wrong_content_or_nonctime_change(self):
        self.validate.budget = proofs.limits(1024, 2000)
        old = self.nas.stat(); self.nas.write_bytes(b'x' * len(self.content))
        os.utime(str(self.nas), ns=(old.st_atime_ns, old.st_mtime_ns))
        with self.assertRaisesRegex(RuntimeError, 'content/filename'): self.check(self.validate)
        self.nas.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'not eligible'): self.check(self.validate)
        self.assertTrue(self.ssd.exists())

    def test_inspection_reports_other_changes_and_never_recommends_deletion_for_them(self):
        self.nas.chmod(0o600)
        result = proofs.inspect_remaining(self.op, [self.path], self.plan, self.guard)
        self.assertEqual(result['issues'], 1)
        self.assertIn('mode', result['errors'][0]['changed_fields'])
        self.assertIsNone(result['resume_command'])
        self.assertTrue(self.ssd.exists())

    def test_file_changed_during_hash_is_refused(self):
        self.drift(); digest = proofs.digest
        def change(fd, size):
            result = digest(fd, size)
            os.chmod(str(self.nas), self.nas.stat().st_mode)
            return result
        with mock.patch.object(proofs, 'digest', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'changed during NAS ctime proof'): self.check(self.validate)
        self.assertFalse(list(self.folder.glob('ctime-proof-*')))

    def test_change_during_proof_fsync_blocks_unlink(self):
        self.drift(); write = proofs.prep.private_write
        def change(*args):
            write(*args)
            os.chmod(str(self.nas), self.nas.stat().st_mode)
        with mock.patch.object(proofs.prep, 'private_write', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'changed during NAS ctime proof'): self.delete()
        self.assertTrue(self.ssd.exists())

    def test_detached_parent_or_symlink_or_hardlink_never_proves_content(self):
        self.drift()
        (self.target / 'avatar').rename(self.target / 'detached')
        (self.target / 'avatar').mkdir()
        shutil.copy2(str(self.ssd), str(self.nas))
        with self.assertRaisesRegex(RuntimeError, 'Directory replaced'): self.validate(self.path)
        self.nas.unlink(); (self.target / 'avatar').rmdir()
        (self.target / 'detached').rename(self.target / 'avatar')
        os.link(str(self.nas), str(self.target / 'alias'))
        with self.assertRaisesRegex(RuntimeError, 'not eligible'): self.validate(self.path)
        self.nas.unlink(); self.nas.symlink_to(self.ssd)
        with self.assertRaisesRegex(RuntimeError, 'not eligible'): self.validate(self.path)

    def test_proof_write_failure_or_runtime_guard_failure_blocks_unlink(self):
        self.drift()
        with mock.patch.object(proofs.prep, 'private_write', side_effect=OSError('audit fsync failed')):
            with self.assertRaisesRegex(OSError, 'audit fsync failed'): self.delete()
        self.guard.side_effect = RuntimeError('runtime changed')
        with self.assertRaisesRegex(RuntimeError, 'runtime changed'): self.delete()
        self.assertTrue(self.ssd.exists())


class PartialDeltaCtimeResumeTests(unittest.TestCase):
    def setUp(self):
        import test_nas_delta_cleanup as fixtures
        import test_nas_delta_switch as switch_fixtures
        self.sha = hashlib.sha256(b'live-avatar').hexdigest()
        self.path = 'video/z/' + self.sha + '.png'
        setup = switch_fixtures.DeltaSwitchTests.setUp
        def with_digest_file(f):
            setup(f)
            # New media before the stopped sync becomes immutable migration evidence.
            candidate = f.media.source / self.path
            candidate.parent.mkdir(); candidate.write_bytes(b'live-avatar')
            (f.media.target / self.path).parent.mkdir()
        with mock.patch.object(switch_fixtures.DeltaSwitchTests, 'setUp', with_digest_file):
            self.f = fixtures.DeltaCleanupTests(); self.addCleanup(self.f.doCleanups)
            self.f.setUp()

    def test_partial_same_plan_resumes_after_nas_ctime_only_failure(self):
        f = self.f; plan = f.prepare(); folder = Path(plan['plan_directory'])
        plan_bytes = (folder / 'plan.json').read_bytes()
        nas = f.m.target / self.path
        unlink = os.unlink; count = []
        def drift_after_second(name, **kwargs):
            result = unlink(name, **kwargs); count.append(name)
            if len(count) == 2: os.chmod(str(nas), nas.stat().st_mode)
            return result
        with mock.patch.object(reclaim.os, 'unlink', side_effect=drift_after_second), \
                mock.patch.object(proofs.CtimeRevalidator, '__call__', side_effect=RuntimeError('old strict check')):
            with self.assertRaisesRegex(RuntimeError, 'old strict check'): f.execute(plan)
        self.assertEqual(len(count), 2)
        self.assertTrue((f.m.source / self.path).exists())
        prefix = (folder / 'unlink-intents.jsonl').read_bytes()
        nas_before = {p: (stamp(p.stat()), p.read_bytes()) for p in f.m.target.rglob('*') if p.is_file()}
        result = f.execute(plan)
        self.assertEqual(result['manifest_files_total'], 3)
        self.assertEqual(result['removed_this_run'], 1)
        self.assertTrue((folder / 'unlink-intents.jsonl').read_bytes().startswith(prefix))
        self.assertEqual((folder / 'plan.json').read_bytes(), plan_bytes)
        self.assertEqual(len(list(folder.glob('ctime-proof-*.json'))), 2)
        for p, data in f.immutable.items(): self.assertEqual(p.read_bytes(), data)
        for p, value in nas_before.items(): self.assertEqual((stamp(p.stat()), p.read_bytes()), value)
        self.assertEqual((f.other / 'keep').read_bytes(), b'other media')

    def test_readonly_inspection_reconciles_same_partial_plan_and_changes_no_evidence(self):
        from projects import delta_cleanup as cleanup
        f = self.f; plan = f.prepare(); unlink = os.unlink; count = []
        def stop(name, **kw):
            if len(count) == 2: raise OSError('interrupted')
            count.append(name); return unlink(name, **kw)
        with mock.patch.object(reclaim.os, 'unlink', side_effect=stop):
            with self.assertRaisesRegex(OSError, 'interrupted'): f.execute(plan)
        nas = f.m.target / self.path; os.chmod(str(nas), nas.stat().st_mode)
        before = {p: (stamp(p.stat()), p.read_bytes()) for root in (f.f.report, f.m.source, f.m.target)
                  for p in root.rglob('*') if p.is_file()}
        with mock.patch.object(proofs, 'digest', side_effect=AssertionError('inspection must not hash')), \
                mock.patch.object(reclaim.os, 'unlink', side_effect=AssertionError('inspection must not delete')):
            result = cleanup.execute(f.manager, f.profile, plan['plan_directory'], inspect_ctime=True)
        self.assertEqual(result['remaining_files'], 1); self.assertEqual(result['missing_with_intent'], 2)
        self.assertEqual(result['ctime_only_candidates'], 1)
        after = {p: (stamp(p.stat()), p.read_bytes()) for root in (f.f.report, f.m.source, f.m.target)
                 for p in root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        with self.assertRaisesRegex(RuntimeError, 'business-accepted'):
            cleanup.execute(f.manager, f.profile, plan['plan_directory'], ctime_proof_read_mib=64)

    def test_inspection_refuses_truncated_journal_runtime_drift_and_missing_journal(self):
        from projects import delta_cleanup as cleanup
        f = self.f; plan = f.prepare()
        with mock.patch.object(reclaim.os, 'unlink', side_effect=OSError('interrupted')):
            with self.assertRaisesRegex(OSError, 'interrupted'): f.execute(plan)
        journal = Path(plan['plan_directory']) / 'unlink-intents.jsonl'; original = journal.read_bytes()
        journal.write_bytes(original + b'{')
        with self.assertRaisesRegex(RuntimeError, 'Incomplete reclaim journal'):
            cleanup.execute(f.manager, f.profile, plan['plan_directory'], inspect_ctime=True)
        journal.write_bytes(original); journal.unlink()
        with self.assertRaises(FileNotFoundError):
            cleanup.execute(f.manager, f.profile, plan['plan_directory'], inspect_ctime=True)
        self.assertFalse(journal.exists())
        f.f.service('worker')['State']['Pid'] += 1
        with self.assertRaisesRegex(RuntimeError, 'runtime changed'):
            cleanup.execute(f.manager, f.profile, plan['plan_directory'], inspect_ctime=True)

    def test_cli_passes_explicit_budgets_and_inspection_has_no_ssd_write_exception(self):
        import catalog
        import manage
        f = self.f; plan = f.prepare()
        for options in (['--inspect-ctime'], ['--business-accepted', '--ctime-proof-read-mib', '512', '--ctime-proof-pairs', '128']):
            with self.subTest(options=options):
                args = manage.parser().parse_args(catalog.route(['delta','cleanup',plan['plan_directory']]+options, manage.CONFIG))
                with mock.patch.object(manage, 'run', return_value='') as run:
                    manage.launch('delta-reclaim', manage.profiles()['part2'], args)
                command = run.call_args.args[0]
                for option in options: self.assertIn(option, command)
                self.assertIn('--property=ReadOnlyPaths=/data /mnt/nas', command)
                self.assertEqual(any(x.startswith('--property=ReadWritePaths=') for x in command), not args.inspect_ctime)
                args.ctime_proof_pairs = -1
                with self.assertRaises(RuntimeError): manage.task_command('delta-reclaim', f.profile, args)


if __name__ == '__main__': unittest.main()
