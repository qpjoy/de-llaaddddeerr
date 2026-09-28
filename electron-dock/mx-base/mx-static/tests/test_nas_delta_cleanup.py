"""Explicit delta cleanup uses real disposable files; no server/Docker mutation."""
import json
import os
from pathlib import Path
import unittest
from unittest import mock

import test_nas_delta_reclaim as fixtures
import catalog
import manage
import reclaim
from projects import delta_cleanup as cleanup
from projects import delta_copy as media
from projects import delta_reclaim as review
from verify import stamp


class DeltaCleanupTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.DeltaReclaimTests(); self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.manager, self.profile, self.m = self.f.manager, self.f.profile, self.f.m
        self.check = self.f.check()
        self.check_path = self.check['check_directory']
        self.immutable = dict(self.f.original)
        self.immutable.update({p: p.read_bytes() for p in Path(self.check_path).iterdir() if p.is_file()})
        self.nas = {p: (stamp(p.stat()), p.read_bytes()) for p in self.m.target.rglob('*') if p.is_file()}
        self.other = self.m.root / 'agent_runs'; self.other.mkdir(); (self.other / 'keep').write_bytes(b'other media')

    def prepare(self): return cleanup.prepare(self.manager, self.profile, self.check_path, True)

    def execute(self, plan): return cleanup.execute(self.manager, self.profile, plan['plan_directory'], True)

    def assert_preserved(self):
        for p, data in self.immutable.items(): self.assertEqual(p.read_bytes(), data, str(p))
        for p, value in self.nas.items(): self.assertEqual((stamp(p.stat()), p.read_bytes()), value, str(p))
        self.assertEqual((self.other / 'keep').read_bytes(), b'other media')
        self.assertTrue(self.m.source.is_dir()); self.assertTrue((self.m.source / 'video').is_dir())

    def test_prepare_accepts_existing_unaccepted_check_without_rewriting_it(self):
        plan = self.prepare()
        self.assertFalse(self.check['business_acceptance_recorded'])
        self.assertTrue(plan['business_acceptance_recorded']); self.assertTrue(plan['reclaim_ready'])
        self.assertFalse(plan['source_deleted']); self.assertFalse(plan['deletion_authorized'])
        self.assertTrue(self.m.candidate.exists())
        self.assertFalse((self.f.report / cleanup.OWNER).exists())
        self.assert_preserved()

    def test_full_cleanup_and_repeated_command_preserve_nas_and_other_data(self):
        plan = self.prepare()
        before_root = self.m.source.stat().st_ino
        result = self.execute(plan)
        self.assertEqual(result['phase'], 'ssd_files_reclaimed')
        self.assertEqual(result['manifest_files_total'], 2)
        self.assertEqual(result['removed_this_run'], 2)
        self.assertFalse(any(p.is_file() for p in self.m.source.rglob('*')))
        self.assertEqual(self.m.source.stat().st_ino, before_root)
        self.assertEqual(self.execute(plan), result)
        self.assertEqual(cleanup.status(self.manager, self.profile), result)
        self.assert_preserved()
        with self.assertRaisesRegex(RuntimeError, 'started/completed'): self.f.check()

    def test_prepare_and_delete_both_require_acceptance(self):
        with self.assertRaisesRegex(RuntimeError, 'acceptance'):
            cleanup.prepare(self.manager, self.profile, self.check_path)
        plan = self.prepare()
        with self.assertRaisesRegex(RuntimeError, 'business-accepted'):
            cleanup.execute(self.manager, self.profile, plan['plan_directory'])
        self.assertTrue(self.m.candidate.exists()); self.assert_preserved()

    def test_check_directory_and_infra_path_are_not_deletion_plans(self):
        for path in (self.check_path, '/var/lib/mx-static/nas-cutover/po_infra_media_data-x/reclaim-plan-'+'a'*32):
            with self.assertRaises(RuntimeError): cleanup.execute(self.manager, self.profile, path, True)
        with self.assertRaises(RuntimeError): cleanup.prepare(self.manager, manage.profiles()['part1'], self.check_path, True)
        self.assert_preserved()

    def test_plan_manifest_or_check_tamper_fails(self):
        plan = self.prepare(); p = Path(plan['plan_directory']) / 'plan.json'
        plan['manifest_sha256'] = '0' * 64; p.write_text(json.dumps(plan))
        with self.assertRaisesRegex(RuntimeError, 'no longer matches'): self.execute(plan)
        self.assertTrue(self.m.candidate.exists())
        p = Path(self.check_path) / 'files.jsonl'; p.write_bytes(p.read_bytes()+b'\n')
        with self.assertRaises((RuntimeError, ValueError)): self.prepare()

    def test_new_or_changed_ssd_blocks_before_owner_or_unlink(self):
        plan = self.prepare()
        (self.m.source / 'video/new-after-plan').write_bytes(b'keep')
        with self.assertRaisesRegex(RuntimeError, 'unexpected entries'): self.execute(plan)
        self.assertFalse((self.f.report / cleanup.OWNER).exists())
        self.assertTrue(self.m.candidate.exists())

    def test_missing_nas_counterpart_and_metadata_drift_block_deletion(self):
        plan = self.prepare()
        p = self.m.target / 'video/new.bin'
        os.utime(str(p), (1000000000, 1000000000))
        with self.assertRaisesRegex(RuntimeError, 'NAS file missing/changed'): self.execute(plan)
        p.unlink()
        with self.assertRaises(FileNotFoundError): self.execute(plan)
        self.assertTrue(self.m.candidate.exists())
        self.assertFalse((self.f.report / cleanup.OWNER).exists())

    def test_runtime_redeploy_or_recovery_disabled_blocks(self):
        plan = self.prepare()
        self.f.f.policy['suspended'] = True
        with self.assertRaisesRegex(RuntimeError, 'recovery is not'): self.execute(plan)
        self.f.f.policy['suspended'] = False
        self.f.service('worker')['Id'] += '-new'
        with self.assertRaisesRegex(RuntimeError, 'runtime changed'): self.execute(plan)
        self.assertTrue(self.m.candidate.exists()); self.assert_preserved()

    def interrupt(self, plan):
        unlink = os.unlink; deleted = []
        def fail_after_one(name, **kwargs):
            self.assertTrue((self.f.report / cleanup.OWNER).exists())
            journal = Path(plan['plan_directory']) / 'unlink-intents.jsonl'
            intent = json.loads(journal.read_text().splitlines()[0])
            self.assertEqual(intent['kind'], 'unlink_intent')
            self.assertEqual(len(intent['paths']), 2)
            if deleted: raise OSError('simulated host exit')
            deleted.append(name); return unlink(name, **kwargs)
        with mock.patch.object(reclaim.os, 'unlink', side_effect=fail_after_one):
            with self.assertRaisesRegex(OSError, 'simulated host exit'): self.execute(plan)
        self.assertEqual(len(list(self.m.source.glob('video/*'))), 1)

    def test_interruption_resumes_only_same_plan_with_durable_intent(self):
        plan = self.prepare(); self.interrupt(plan)
        with self.assertRaisesRegex(RuntimeError, 'already owns'): self.prepare()
        result = self.execute(plan)
        self.assertEqual(result['removed_this_run'], 1)
        self.assertEqual(result['manifest_files_total'], 2)
        self.assert_preserved()

    def test_other_prepared_plan_cannot_take_over_partial_cleanup(self):
        first, second = self.prepare(), self.prepare()
        self.interrupt(first)
        with self.assertRaisesRegex(RuntimeError, 'Another delta reclaim plan'): self.execute(second)
        self.execute(first); self.assert_preserved()

    def test_missing_owner_or_lost_intents_cannot_authorize_existing_holes(self):
        plan = self.prepare(); self.interrupt(plan)
        journal = Path(plan['plan_directory']) / 'unlink-intents.jsonl'
        journal.write_bytes(b'')
        with self.assertRaisesRegex(RuntimeError, 'Unjournaled missing|directory changed since the plan'): self.execute(plan)
        (self.f.report / cleanup.OWNER).unlink()
        with self.assertRaisesRegex(RuntimeError, 'Unowned'): self.execute(plan)
        self.assertEqual(len(list(self.m.source.glob('video/*'))), 1)

    def test_truncated_journal_is_not_silently_repaired(self):
        plan = self.prepare(); self.interrupt(plan)
        p = Path(plan['plan_directory']) / 'unlink-intents.jsonl'
        p.write_bytes(p.read_bytes()+b'{"kind":')
        with self.assertRaisesRegex(RuntimeError, 'Incomplete reclaim journal'): self.execute(plan)
        self.assertEqual(len(list(self.m.source.glob('video/*'))), 1)

    def test_runtime_change_after_first_batch_stops_next_batch(self):
        plan = self.prepare()
        unlink = os.unlink
        def change(name, **kwargs):
            value = unlink(name, **kwargs)
            self.f.service('worker')['State']['Pid'] += 1
            return value
        with mock.patch.object(reclaim, 'BATCH', 1), mock.patch.object(reclaim.os, 'unlink', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'runtime changed'): self.execute(plan)
        self.assertEqual(len(list(self.m.source.glob('video/*'))), 1)
        self.assert_preserved()

    def test_nas_new_business_file_never_enters_delete_scope(self):
        plan = self.prepare()
        p = self.m.target / 'video/new-business'; p.write_bytes(b'live')
        self.execute(plan)
        self.assertEqual(p.read_bytes(), b'live'); self.assert_preserved()

    def test_completion_write_interruption_reconciles_empty_source(self):
        plan = self.prepare()
        original = cleanup.cutover.atomic_json
        def fail_owner(fd, name, value):
            if name == cleanup.OWNER: raise OSError('simulated completion fsync')
            return original(fd, name, value)
        with mock.patch.object(cleanup.cutover, 'atomic_json', side_effect=fail_owner):
            with self.assertRaisesRegex(OSError, 'completion fsync'): self.execute(plan)
        self.assertFalse(any(p.is_file() for p in self.m.source.rglob('*')))
        self.assertEqual(self.execute(plan)['removed_this_run'], 0)
        self.assert_preserved()

    def test_routes_enforce_exact_paths_acceptance_and_write_scope(self):
        for tail, action, path in ((['cleanup','prepare'], 'delta-reclaim-prepare', self.check_path),
                                   (['cleanup'], 'delta-reclaim', str(self.f.report / ('reclaim-plan-'+'a'*32)))):
            routed = catalog.route(['delta']+tail+[path,'--business-accepted'], manage.CONFIG)
            args = manage.parser().parse_args(routed)
            with mock.patch.object(manage, 'run', return_value='') as run:
                manage.launch(action, manage.profiles()['part2'], args)
            command = run.call_args.args[0]
            self.assertIn('--property=ReadOnlyPaths=/data /mnt/nas', command)
            self.assertEqual('--property=ReadWritePaths='+media.SOURCE in command, action=='delta-reclaim')
            self.assertIn('_execute-'+action, command)
            args.business_accepted = False
            with self.assertRaises(RuntimeError): manage.task_command(action, self.profile, args)


if __name__ == '__main__': unittest.main()
