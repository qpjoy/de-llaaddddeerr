"""Real delta switch/retained files, isolated Docker/NFS boundary; no server."""
import copy
import json
import os
from pathlib import Path
import unittest
from unittest import mock

import test_nas_delta_switch as fixtures
import catalog
import cutover
import manage
import precopy
from projects import delta_copy as media
from projects import delta_reclaim as review
from projects import delta_runtime as runtime
from projects import infra_reclaim as files
from projects import infra_storage
from verify import stamp


class DeltaReclaimTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.DeltaSwitchTests(); self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.state = self.f.execute()
        self.manager, self.profile = self.f.manager, self.f.profile
        self.manager.UNIT = manage.UNIT
        self.report = Path(self.state['report_directory'])
        self.m = self.f.media
        self.original = {p: p.read_bytes() for p in self.report.rglob('*') if p.is_file()}
        self.original[self.m.job / precopy.MARKER] = self.m.before
        self.original[self.f.auto / runtime.RECORD] = (self.f.auto / runtime.RECORD).read_bytes()
        self.f.commands.clear()
        self.manager.run.side_effect = self.run_command
        # Production cutover reader requires UID 0. Fixture reports are owned
        # by the developer; retain nofollow/private/single-link/stability checks.
        self.f.stack.enter_context(mock.patch.object(cutover, 'read_json',
            side_effect=lambda fd, name: media.read_private(fd, name)[0]))

    def run_command(self, args, **kwargs):
        if args[:2] == ['systemctl', 'show']:
            self.f.commands.append(args)
            return 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n'
        if args[:3] == ['findmnt', '-rn', '-T']:
            self.f.commands.append(args)
            return 'xfs'
        if args[:2] == ['docker', 'exec'] and 'nfs_identity_passed' in args[-1]:
            self.f.commands.append(args)
            self.assertNotIn('-u', args)
            self.assertNotIn('write', args[-1])
            return '{"nfs_identity_passed":true}'
        if args[:3] == ['docker', 'volume', 'inspect']:
            return self.f.fake_run(args, **kwargs)
        raise AssertionError('Unexpected/mutating command during read-only check: ' + repr(args))

    def check(self, accepted=False):
        return review.check(self.manager, self.profile, accepted)

    def service(self, name):
        return next(c for c in self.f.fixture.rows if self.f.name(c) == name)

    def assert_preserved(self):
        for p, data in self.original.items(): self.assertEqual(p.read_bytes(), data, str(p))
        self.assertTrue(self.m.candidate.exists())
        self.assertEqual(self.m.keep.read_bytes(), b'nas-only')

    def test_read_only_check_keeps_immutable_records_and_both_media_trees(self):
        before = {p: (stamp(p.stat()), p.read_bytes())
                  for root in (self.m.source, self.m.target) for p in root.rglob('*') if p.is_file()}
        result = self.check()
        self.assertEqual(result['regular_files'], 2)
        self.assertTrue(result['files_verified']); self.assertTrue(result['recovery']['verified'])
        self.assertFalse(result['verification_ready']); self.assertFalse(result['business_acceptance_recorded'])
        self.assertEqual(result['nas_verification'], review.POLICY)
        for k in ('source_deleted', 'deletion_supported', 'deletion_authorized', 'reclaim_ready'):
            self.assertFalse(result[k])
        receipt = Path(result['check_directory']) / 'check.json'
        self.assertEqual(json.loads(receipt.read_text()), result)
        self.assertEqual(stat_mode(receipt), 0o600)
        self.assertNotIn('private-value', (receipt.parent / 'runtime.json').read_text())
        self.assert_preserved()
        for p, value in before.items(): self.assertEqual((stamp(p.stat()), p.read_bytes()), value)

    def test_acceptance_records_fact_but_never_enables_deletion_or_selects_plan(self):
        before_profile = copy.deepcopy(self.profile)
        result = self.check(True)
        self.assertTrue(result['business_acceptance_recorded']); self.assertTrue(result['verification_ready'])
        self.assertFalse(result['deletion_supported']); self.assertFalse(result['reclaim_ready'])
        self.assertEqual(self.profile, before_profile); self.assertIsNone(self.profile['plan'])
        self.assert_preserved()

    def test_normal_redeployment_before_check_does_not_bind_historical_ids_or_env(self):
        for c in self.f.fixture.rows:
            c['Id'] += '-redeployed'
            c['State'].update(Pid=c['State']['Pid'] + 1000, StartedAt='redeployed')
            c['Config']['Env'].append('NEW_SETTING=private-new-value')
        self.assertTrue(self.check()['files_verified'])
        self.assert_preserved()

    def test_unavailable_mountless_websearch_does_not_block_media_check(self):
        self.service('websearch')['State'].update(Running=False, Health={'Status': 'unhealthy'})
        self.assertTrue(self.check()['files_verified'])

    def test_missing_nas_counterpart_and_source_changes_fail_without_complete_receipt(self):
        (self.m.target / 'video/new.bin').unlink()
        with self.assertRaises(FileNotFoundError): self.check()
        self.assertFalse(list(self.report.glob('reclaim-check-*/check.json')))
        self.assert_preserved()

    def test_added_or_changed_ssd_file_blocks_check(self):
        (self.m.source / 'video/after-switch.bin').write_bytes(b'new write')
        with self.assertRaisesRegex(RuntimeError, 'stopped-writer'): self.check()
        self.assert_preserved()

    def test_nas_only_addition_during_check_is_preserved(self):
        original = files.verify_pairs
        def with_new_file(*args):
            (self.m.target / 'video/business-new.bin').write_bytes(b'live NAS data')
            return original(*args)
        with mock.patch.object(files, 'verify_pairs', side_effect=with_new_file):
            self.assertTrue(self.check()['files_verified'])
        self.assertEqual((self.m.target / 'video/business-new.bin').read_bytes(), b'live NAS data')

    def test_nas_mtime_conflict_is_hashed_without_changing_permissions(self):
        p = self.m.target / 'video/new.bin'
        p.chmod(0o600); os.utime(str(p), (1000000000, 1000000000))
        before = stamp(p.stat())
        result = self.check()
        self.assertEqual(result['comparison']['hashed_equal'], 1)
        self.assertEqual(stamp(p.stat()), before)

    def test_nas_content_conflict_and_symlink_fail(self):
        p = self.m.target / 'video/new.bin'
        p.write_bytes(b'bad-media'); os.utime(str(p), (1000000000, 1000000000))
        with self.assertRaisesRegex(RuntimeError, 'Content differs'): self.check()
        p.unlink(); p.symlink_to(self.m.candidate)
        with self.assertRaisesRegex(RuntimeError, 'Unsupported NAS'): self.check()
        self.assertFalse(list(self.report.glob('reclaim-check-*/check.json')))

    def test_runtime_restart_during_check_is_rejected(self):
        original = files.verify_pairs
        def restart(*args):
            self.service('worker')['State']['Pid'] += 1
            return original(*args)
        with mock.patch.object(files, 'verify_pairs', side_effect=restart):
            with self.assertRaisesRegex(RuntimeError, 'runtime changed'): self.check()
        self.assert_preserved()

    def test_nas_fallback_fails_before_inventory(self):
        self.service('web')['Mounts'] = [m for m in self.service('web')['Mounts'] if m['Destination'] != media.RAW]
        with mock.patch.object(files, 'source_inventory') as walk:
            with self.assertRaises(RuntimeError): self.check()
            walk.assert_not_called()

    def test_extra_source_bind_in_known_container_is_rejected(self):
        self.service('worker')['Mounts'].append({'Type': 'bind', 'Source': media.SOURCE,
                                               'Destination': '/uncovered', 'RW': True})
        with self.assertRaisesRegex(RuntimeError, 'extra mount'): self.check()

    def test_other_project_access_and_volume_driver_alias_are_rejected(self):
        c = copy.deepcopy(self.service('websearch'))
        c['Id'] = 'outsider'; c['Config']['Labels']['com.docker.compose.project'] = 'other'
        c['Mounts'] = [{'Type': 'bind', 'Source': '/data', 'Destination': '/disk', 'RW': True}]
        self.f.fixture.rows.append(c)
        with self.assertRaises(RuntimeError): self.check()
        c['Mounts'] = [{'Type': 'volume', 'Name': 'alias', 'Source': '/hidden-alias', 'Destination': '/disk', 'RW': True}]
        self.f.volumes['alias'] = {'Name': 'alias', 'Driver': 'local', 'Options': {'device': media.SOURCE, 'o': 'bind'}}
        with self.assertRaisesRegex(RuntimeError, 'aliases delta'): self.check()

    def test_recovery_disabled_or_database_unhealthy_blocks_before_inventory(self):
        self.f.policy['suspended'] = True
        with self.assertRaisesRegex(RuntimeError, 'recovery must'): self.check()
        self.f.policy['suspended'] = False
        self.service('postgres')['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaisesRegex(RuntimeError, 'not stably running'): self.check()

    def test_stopped_manifest_corruption_blocks(self):
        p = Path(self.state['final_review']) / 'files.jsonl'
        p.write_bytes(p.read_bytes() + b'\n')
        with self.assertRaises((RuntimeError, ValueError)): self.check()
        self.assertFalse(list(self.report.glob('reclaim-check-*/check.json')))

    def test_current_report_changes_during_check_fail(self):
        original = files.verify_pairs
        def change(*args):
            p = self.report / 'execution.json'
            v = json.loads(p.read_text()); v['unexpected'] = True
            p.write_text(json.dumps(v))
            return original(*args)
        with mock.patch.object(files, 'verify_pairs', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'switch evidence changed'): self.check()
        self.assertFalse(list(self.report.glob('reclaim-check-*/check.json')))

    def test_marker_change_is_not_silently_rebased(self):
        marker = json.loads((self.m.job / precopy.MARKER).read_text())
        marker['consumer_fingerprint'] = 'd' * 64
        (self.m.job / precopy.MARKER).write_text(json.dumps(marker))
        with self.assertRaisesRegex(RuntimeError, 'identity changed since switch'): self.check()

    def test_report_directory_replacement_is_detected(self):
        original = files.verify_pairs
        def replace_report(*args):
            self.report.rename(str(self.report) + '-retained')
            self.report.mkdir(mode=0o700)
            return original(*args)
        with mock.patch.object(files, 'verify_pairs', side_effect=replace_report):
            with self.assertRaisesRegex(RuntimeError, 'report directory changed'): self.check()

    def test_media_identity_mismatch_is_rejected_before_check_directory_creation(self):
        p = self.report / 'baseline.private.json'
        value = json.loads(p.read_text())
        value['copy']['media_identity']['target_identity']['inode'] += 1
        p.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'identity changed since switch'): self.check()
        self.assertFalse(list(self.report.glob('reclaim-check-*')))

    def test_route_only_opens_read_check_with_read_only_media_mounts(self):
        routed = catalog.route(['delta', 'cleanup', 'check'], manage.CONFIG)
        self.assertEqual(routed, ['delta-reclaim-check', 'part2'])
        args = manage.parser().parse_args(routed)
        with mock.patch.object(manage, 'run', return_value='') as run:
            manage.launch(args.action, manage.profiles()['part2'], args)
        command = run.call_args.args[0]
        self.assertIn('--property=ReadOnlyPaths=/data /mnt/nas', command)
        self.assertIn('_execute-delta-reclaim-check', command)
        self.assertNotIn('--business-accepted', command)
        for route in (['delta', 'cleanup', '--business-accepted'], ['delta', 'task', 'part2', 'cleanup']):
            with self.assertRaises(RuntimeError): catalog.route(route, manage.CONFIG)
        with self.assertRaises(RuntimeError): manage.task_command('delta-reclaim-check', manage.profiles()['part1'], args)


def stat_mode(path): return path.stat().st_mode & 0o777


if __name__ == '__main__': unittest.main()
