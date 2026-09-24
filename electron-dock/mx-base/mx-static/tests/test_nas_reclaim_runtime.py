import copy
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))

import cutover
import manage
import reclaim
from projects import infra_reclaim as review
from projects import infra_reclaim_runtime as runtime
from projects import infra_runtime as media
from test_nas_repair_switch import LocalFiles, local_json
import test_nas_storage


class RuntimeReclaimTests(LocalFiles):
    def setUp(self):
        super().setUp()
        fixture = test_nas_storage.StorageTests(); fixture.setUp()
        self.profile = dict(fixture.profile, report=str(self.output))
        self.rows, self.volume, self.mountinfo = fixture.rows, fixture.volume, fixture.mountinfo
        for c in self.rows:
            c['State'].update(Health={'Status': 'healthy'}, StartedAt='new-start')
            c.update(Image='new-image')
            c['Config'].update(Cmd=['new-command'])
        for name in ('postgres', 'redis'):
            self.rows.append({'Id': name + '-new-id', 'Image': name + '-new-image',
                'Config': {'Labels': {'com.docker.compose.project': 'mx_data', 'com.docker.compose.service': name}},
                'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                'Mounts': [{'Name': name + '_data', 'Type': 'volume', 'Destination': '/database',
                            'Source': '/data/docker/volumes/' + name + '_data/_data'}]})
        for root in (self.source, self.target):
            self.put(root, 'video/shared.mp4')
        self.put(self.source, 'video/mtime.mp4')
        self.put(self.target, 'video/mtime.mp4', when=1000000002)
        self.put(self.target, 'live/nas-only', b'live')
        self.tree = review.source_inventory(self.src, 'fixture')
        final = self.output / ('repair-final-' + 'a' * 32); final.mkdir(mode=0o700)
        fd = os.open(str(final), review.DIR_FLAGS)
        try:
            sha = review.write_tree(fd, 'files.jsonl', self.tree)
            manage.prep.private_write(fd, 'result.json', {'source_manifest_sha256': sha,
                'final_sync_passed': True, 'live_snapshot': False, 'stopped_writer_recheck_required': False})
        finally:
            os.close(fd)
        self.state = {'schema': 1, 'volume': manage.prep.VOLUME, 'report_directory': str(self.output),
            'phase': 'running_on_nas', 'final_sync_passed': True, 'nas_may_have_writes': True, 'reclaim_ready': False,
            'repair_of': '/historical', 'final_review': str(final),
            'new_ids': {n: 'historical-' + n for n in manage.prep.SERVICES}}
        (self.output / 'execution.json').write_text(json.dumps(self.state))
        self.op = SimpleNamespace(path=str(self.output), output=self.out, state=copy.deepcopy(self.state),
            source=self.src, target=self.dst, job=self.jobfd, held=[],
            saved={'precopy_state': {'target_inode': os.fstat(self.dst).st_ino}},
            overlay=json.loads((manage.CONFIG.parent / self.profile['storage_file']).read_text()),
            config_guard=mock.Mock(side_effect=AssertionError('Historic app config was accessed')),
            mounted_services=mock.Mock(side_effect=AssertionError('Historic container IDs were required')),
            identity_probe=mock.Mock(side_effect=AssertionError('Historic image was started')),
            http_probe=mock.Mock(), open_media=mock.Mock(), close=mock.Mock())
        self.auto = self.root / 'etc'; self.auto.mkdir(mode=0o700)
        self.patch(manage, 'AUTO_DIR', str(self.auto))
        self.patch(manage, 'profiles', return_value={'part1': self.profile})
        self.patch(runtime.infra_storage, 'collect', side_effect=lambda *a, **k: (self.rows, self.volume, self.mountinfo))
        _, _, contract = media.contract(manage, self.profile)
        record = {'schema': 1, 'project': 'mx_data', 'nas_authoritative': True, 'contract_sha256': contract}
        (self.auto / media.RECORD).write_text(json.dumps(record)); (self.auto / media.RECORD).chmod(0o600)
        self.patch(cutover, 'read_json', side_effect=local_json)
        self.patch(cutover, 'open_report', side_effect=lambda path: os.open(str(self.output), review.DIR_FLAGS))
        self.patch(cutover, 'Cutover', return_value=self.op)
        self.patch(review.precopy, 'read_state', return_value={'phase': 'cutover_running_on_nas'})
        self.patch(review.infra_repair_switch, 'media_guard')
        self.patch(review, 'recovery_evidence', return_value={'verified': True, 'installed_current': True, 'selected': True})
        self.run = self.patch(manage, 'run', return_value='{"nfs_identity_passed":true}')

    def patch(self, obj, name, *args, **kwargs):
        p = mock.patch.object(obj, name, *args, **kwargs)
        value = p.start(); self.addCleanup(p.stop)
        return value

    def session(self, expected=None):
        return runtime.Session(manage, self.profile, self.op, expected=expected)

    def row(self, name):
        return next(c for c in self.rows if c['Config']['Labels']['com.docker.compose.service'] == name)

    def test_redeployed_app_passes_without_old_config_ids_or_image_and_preserves_history(self):
        original = (self.output / 'execution.json').read_bytes()
        result = review.check(manage, self.profile, True)
        self.assertTrue(result['reclaim_ready']); self.assertTrue(result['business_acceptance_recorded'])
        self.assertFalse(result['source_deleted']); self.assertFalse(result['deletion_authorized'])
        self.assertEqual(result['nas_verification'], runtime.POLICY)
        self.assertEqual(result['comparison']['hashed_equal'], 1)
        evidence = json.loads((Path(result['plan_directory']) / 'runtime.json').read_text())
        self.assertEqual(result['runtime_snapshot_sha256'], runtime.digest(evidence))
        self.assertEqual(evidence['services']['web']['id'], 'web-id')
        self.assertNotIn('not-for-output', json.dumps(evidence))
        self.assertEqual((self.output / 'execution.json').read_bytes(), original)
        self.assertEqual(review.source_inventory(self.src, 'after'), self.tree)
        self.op.config_guard.assert_not_called(); self.op.mounted_services.assert_not_called()
        self.op.identity_probe.assert_not_called()
        self.assertEqual(self.run.call_args[0][0][:4], ['docker', 'exec', 'web-id', 'python'])
        self.assertEqual(self.op.http_probe.call_args[0][0]['gateway']['Id'], 'gateway-id')

    def test_no_acceptance_is_still_not_ready(self):
        result = review.check(manage, self.profile)
        self.assertFalse(result['reclaim_ready']); self.assertFalse(result['business_acceptance_recorded'])

    def test_changed_ssd_since_stopped_review_still_blocks(self):
        self.put(self.source, 'video/new.mp4')
        with self.assertRaisesRegex(RuntimeError, 'stopped-writer'):
            review.check(manage, self.profile, True)
        self.run.assert_not_called()

    def test_same_size_different_nas_content_blocks_and_retains_ssd(self):
        self.put(self.target, 'video/mtime.mp4', b'y' * 2048, when=1000000002)
        with self.assertRaisesRegex(RuntimeError, 'Content differs'):
            review.check(manage, self.profile, True)
        self.assertEqual(review.source_inventory(self.src, 'after'), self.tree)

    def test_missing_registration_or_pending_maintenance_blocks_without_fallback(self):
        path = self.auto / media.RECORD
        record = json.loads(path.read_text()); record['maintenance_report'] = '/pending'
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, '维护尚未完成'): self.session()
        path.unlink()
        with self.assertRaisesRegex(RuntimeError, '尚未登记'): self.session()

    def test_wrong_nfs_and_ssd_fallback_block(self):
        self.volume['Options'] = {}
        with self.assertRaises(RuntimeError): self.session()
        self.volume['Options'] = dict(manage.prep.OPTIONS)
        self.row('web')['Mounts'].pop()
        with self.assertRaises(RuntimeError): self.session()

    def test_declared_nfs_without_actual_kernel_nfs_blocks(self):
        self.mountinfo['web-id'] = self.mountinfo['web-id'].replace(' - nfs ', ' - xfs ')
        with self.assertRaises(RuntimeError): self.session()

    def test_unknown_ssd_writer_and_alias_in_registered_consumer_block(self):
        self.rows.append({'Id': 'other', 'Config': {'Labels': {}}, 'Mounts': [
            {'Type': 'bind', 'Source': '/data', 'Destination': '/data'}]})
        with self.assertRaises(RuntimeError): self.session()
        self.rows.pop()
        self.row('web')['Mounts'].append({'Type': 'volume', 'Name': manage.prep.VOLUME, 'Destination': '/alias'})
        with self.assertRaisesRegex(RuntimeError, 'retained SSD'): self.session()

    def test_temporary_or_duplicate_or_unhealthy_services_block(self):
        c = self.row('web')
        c['Config']['Labels']['com.docker.compose.oneoff'] = 'True'
        with self.assertRaises(RuntimeError): self.session()
        c['Config']['Labels'].pop('com.docker.compose.oneoff')
        self.rows.append(copy.deepcopy(c))
        with self.assertRaises(RuntimeError): self.session()
        self.rows.pop()
        self.row('redis')['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaises(RuntimeError): self.session()

    def test_runtime_change_during_check_blocks_and_plan_cannot_follow_redeployment(self):
        session = self.session()
        self.row('web')['Config']['Cmd'] = ['changed']
        with self.assertRaisesRegex(RuntimeError, 'Runtime changed during'): session.guard()
        with self.assertRaisesRegex(RuntimeError, 'Runtime changed since'):
            self.session(expected=session.evidence)
        # A new independent check can pin the now-stable legitimate deployment.
        self.session().guard()

    def test_changed_historical_execution_is_never_adopted(self):
        session = self.session()
        value = dict(self.state, final_sync_passed=False)
        (self.output / 'execution.json').write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'Historical execution'): session.guard()

    def test_nas_marker_change_and_failed_identity_probe_block(self):
        session = self.session()
        with mock.patch.object(runtime.precopy, 'read_state', return_value={'phase': 'cutover_in_progress'}):
            with self.assertRaisesRegex(RuntimeError, 'NAS marker'): session.guard()
        self.run.return_value = '{}'
        with self.assertRaisesRegex(RuntimeError, 'identity probe failed'): session.probes()
        self.op.http_probe.assert_not_called()

    def test_guard_failure_happens_before_deletion_intent_or_unlink(self):
        result = review.check(manage, self.profile, True)
        fd = os.open(result['plan_directory'], review.DIR_FLAGS); self.addCleanup(os.close, fd)
        nas = review.read_verified_target(fd, result, self.tree, self.op.state)
        session = self.session()
        journal = reclaim.private_file(fd, 'unlink-intents.jsonl', os.O_RDWR | os.O_CREAT | os.O_APPEND)
        self.addCleanup(os.close, journal)
        self.row('web')['State']['StartedAt'] = 'restarted'
        with self.assertRaisesRegex(RuntimeError, 'Runtime changed during'):
            reclaim.delete_files(self.src, self.dst, self.tree, sorted(p for p in self.tree if p.endswith('.mp4')),
                                 journal, session.guard, nas_tree=nas)
        self.assertEqual(reclaim.read_intents(journal, self.tree), set())
        self.assertEqual(review.source_inventory(self.src, 'after'), self.tree)

    def selected_plan(self):
        plan = review.check(manage, self.profile, True)
        self.profile['plan'] = plan['plan_directory']
        fd = os.open(plan['plan_directory'], review.DIR_FLAGS); self.addCleanup(os.close, fd)
        return plan, fd

    def test_new_context_deletes_only_verified_ssd_and_retains_all_nas_files(self):
        plan, fd = self.selected_plan()
        nas, session = reclaim.union_context(self.op, fd, plan, self.tree, manage)
        journal = reclaim.private_file(fd, 'unlink-intents.jsonl', os.O_RDWR | os.O_CREAT | os.O_APPEND)
        self.addCleanup(os.close, journal)
        remaining = reclaim.remaining_files(self.src, self.tree, set())
        reclaim.check_nas_files(self.dst, self.tree, remaining, nas_tree=nas)
        session.probes()
        removed, _ = reclaim.delete_files(self.src, self.dst, self.tree, remaining, journal, session.guard, nas_tree=nas)
        self.assertEqual(removed, 2)
        self.assertEqual(reclaim.remaining_files(self.src, self.tree, reclaim.read_intents(journal, self.tree)), [])
        self.assertEqual(review.counterparts(self.dst, self.tree), nas)
        self.assertEqual((self.target / 'live/nas-only').read_bytes(), b'live')
        self.assertTrue((self.source / 'video').is_dir())

    def test_deleter_blocks_unselected_unaccepted_and_altered_runtime_evidence(self):
        plan, fd = self.selected_plan()
        self.profile['plan'] = None
        with self.assertRaisesRegex(RuntimeError, 'explicitly registered'):
            reclaim.union_context(self.op, fd, plan, self.tree, manage)
        self.profile['plan'] = plan['plan_directory']
        with self.assertRaisesRegex(RuntimeError, 'accepted UNION'):
            reclaim.union_context(self.op, fd, dict(plan, business_acceptance_recorded=False), self.tree, manage)
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            reclaim.union_context(self.op, fd, dict(plan, runtime_snapshot_sha256='0'*64), self.tree, manage)
        self.row('web')['Config']['Env'].append('BUSINESS_SETTING=changed')
        with self.assertRaisesRegex(RuntimeError, 'Runtime changed since'):
            reclaim.union_context(self.op, fd, plan, self.tree, manage)
        self.assertEqual(review.source_inventory(self.src, 'after'), self.tree)

    def test_delete_guard_rechecks_registration_and_recovery_pause(self):
        plan, fd = self.selected_plan()
        _, session = reclaim.union_context(self.op, fd, plan, self.tree, manage)
        self.profile['plan'] = None
        with self.assertRaisesRegex(RuntimeError, 'registration changed'): session.guard()
        self.profile['plan'] = plan['plan_directory']
        with mock.patch.object(review, 'recovery_evidence', return_value={'verified': False}):
            with self.assertRaisesRegex(RuntimeError, 'Recovery coverage changed'): session.guard()

    def test_legacy_plan_does_not_silently_get_current_runtime_adapter(self):
        plan, fd = self.selected_plan()
        _, session = reclaim.union_context(self.op, fd, dict(plan, nas_verification=review.POLICY), self.tree, manage)
        self.assertIsNone(session)
        # Main retains planning.guard / historical configuration for old plans.
