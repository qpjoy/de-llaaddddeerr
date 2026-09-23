import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import catalog
import manage
import recovery
from projects import infra_runtime as runtime
from projects import infra_storage as storage
import test_nas_storage


class MediaRuntimeTests(unittest.TestCase):
    def setUp(self):
        fixture = test_nas_storage.StorageTests()
        fixture.setUp()
        self.profile, self.rows, self.volume, self.mountinfo = fixture.profile, fixture.rows, fixture.volume, fixture.mountinfo
        for c in self.rows: c['State']['Health'] = {'Status': 'healthy'}
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.output = contextlib.redirect_stdout(io.StringIO()); self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)
        self.auto = Path(self.tmp.name) / 'etc'; self.auto.mkdir(mode=0o700)
        self.patch(manage, 'AUTO_DIR', str(self.auto))
        self.patch(manage, 'secure_directory', side_effect=lambda p: os.open(str(p), manage.DIR_FLAGS))
        self.patch(storage, 'collect', side_effect=lambda *a, **k: (self.rows, self.volume, self.mountinfo))
        self.policy = {'schema': 1, 'mode': 'migrated', 'enabled_parts': [], 'disabled_parts': [], 'suspended': False}
        self.patch(manage, 'auto_config', side_effect=lambda: self.policy)
        self.old_operations = self.patch(manage, 'operation', side_effect=AssertionError('Historical application snapshot was accessed'))
        # A real private file is used to exercise registration persistence.
        report = Path(self.tmp.name) / 'receipt'; report.mkdir()
        self.patch(manage.cutover, 'open_report', side_effect=lambda p: os.open(str(report), manage.DIR_FLAGS))
        self.state = {'schema': 1, 'volume': self.profile['volume'], 'report_directory': self.profile['report'],
                      'phase': 'running_on_nas', 'final_sync_passed': True, 'nas_may_have_writes': True}
        self.receipt_reads = self.patch(manage.cutover, 'read_json', side_effect=lambda *a: self.state)

    def patch(self, obj, name, *args, **kwargs):
        p = mock.patch.object(obj, name, *args, **kwargs)
        value = p.start(); self.addCleanup(p.stop)
        return value

    def register(self): runtime.register(manage, self.profile)

    def start(self, args, **kwargs):
        self.assertEqual(args[:2], ['docker', 'start'])
        next(c for c in self.rows if c['Id'] == args[2])['State']['Running'] = True
        return ''

    def add_dependencies(self):
        for name in ('postgres', 'redis'):
            self.rows.append({'Id': name+'-id', 'Config': {'Labels': {
                'com.docker.compose.project': 'mx_data', 'com.docker.compose.service': name}},
                'State': {'Running': True, 'Health': {'Status': 'healthy'}}, 'Mounts': []})

    def test_explicit_registration_persists_no_app_secrets_ids_or_images(self):
        run = self.patch(manage, 'run')
        self.register()
        path = self.auto / runtime.RECORD
        record = json.loads(path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertTrue(record['nas_authoritative'])
        for forbidden in ('not-for-output', 'Env', 'Image', 'beat-id', 'config_files_sha256'):
            self.assertNotIn(forbidden, path.read_text())
        before = path.read_bytes()
        self.register()
        self.assertEqual(path.read_bytes(), before)
        run.assert_not_called()

    def test_registration_requires_a_completed_migration_and_live_nfs(self):
        for key, value in [('final_sync_passed', False), ('nas_may_have_writes', False), ('phase', 'nas_containers_created')]:
            old = self.state[key]; self.state[key] = value
            with self.assertRaises(RuntimeError): self.register()
            self.state[key] = old
        self.rows[0]['Mounts'].pop()
        with self.assertRaises(RuntimeError): self.register()
        self.assertFalse((self.auto / runtime.RECORD).exists())

    def test_replicas_must_all_have_correct_mounts_and_oneoffs_are_never_adopted(self):
        self.register()
        extra = copy.deepcopy(self.rows[0]); extra['Id'] = 'another-replica'
        self.rows.append(extra); self.mountinfo[extra['Id']] = self.mountinfo[self.rows[0]['Id']]
        self.assertEqual(len(runtime.check(manage, self.profile)), 11)
        extra['Config']['Labels']['com.docker.compose.oneoff'] = 'True'
        with self.assertRaisesRegex(RuntimeError, '临时容器'): runtime.check(manage, self.profile)
        extra['Config']['Labels'].pop('com.docker.compose.oneoff')
        extra['HostConfig']['Mounts'] = []
        with self.assertRaises(RuntimeError): runtime.check(manage, self.profile)

    def test_missing_service_unknown_bind_consumer_and_tmpfs_fail_closed(self):
        self.register()
        first = self.rows.pop()
        with self.assertRaises(RuntimeError): runtime.check(manage, self.profile)
        self.rows.append(first)
        self.rows.append({'Id': 'unknown-writer', 'Mounts': [{'Type': 'bind', 'Source': '/data/docker/volumes/po_infra_media_data/_data'}]})
        with self.assertRaises(RuntimeError): runtime.check(manage, self.profile)
        self.rows.pop()
        first['State']['Running'] = False
        first['HostConfig']['Tmpfs'] = {storage.RAW: 'rw'}
        with self.assertRaises(RuntimeError): runtime.check(manage, self.profile)

    def test_changed_or_unsafe_registration_is_never_silently_rebased(self):
        self.register(); path = self.auto / runtime.RECORD
        data = json.loads(path.read_text()); data['contract_sha256'] = 'other'
        path.write_text(json.dumps(data))
        with self.assertRaises(RuntimeError): self.register()
        with self.assertRaises(RuntimeError): manage.recover(self.profile)
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'): runtime.read_record(manage)

    def test_global_recovery_uses_media_adapter_without_opening_historical_report(self):
        self.register()
        self.add_dependencies()
        self.receipt_reads.side_effect = AssertionError('Read migration report')
        self.patch(manage.precopy, 'inspect_containers', return_value=self.rows)
        policy, rows = recovery.inventory(manage)
        infra = next(row for row in rows if row['task'] == 'part1')
        self.assertEqual(infra['state'], 'eligible'); self.assertEqual(infra['coverage'], '已纳入')
        self.assertEqual(next(row for row in rows if row['task'] == 'part2')['state'], 'not_migrated')
        self.policy['disabled_parts'] = ['part1']
        self.assertEqual(next(r for r in recovery.inventory(manage)[1] if r['task'] == 'part1')['coverage'], '项目已暂停')

    def test_project_status_uses_current_containers_without_migration_history(self):
        self.register()
        self.add_dependencies()
        self.receipt_reads.side_effect = AssertionError('Status reopened migration history')
        self.patch(manage.precopy, 'inspect_containers', return_value=self.rows)
        self.patch(manage.os, 'statvfs', return_value=SimpleNamespace(f_bavail=100, f_frsize=4096))
        self.patch(manage, 'systemd_summary', return_value={'exit': 0, 'units': ''})
        self.patch(storage, 'check', return_value=True)
        events = self.patch(manage, 'emit')
        manage.status('part1', self.profile)
        state = next(c for c in events.call_args_list if c.args[0]=='nas_media_project_state')
        self.assertTrue(state.kwargs['ready'])
        self.old_operations.assert_not_called()

    def test_boot_check_and_new_registration_route_do_not_call_migration_adapter(self):
        self.assertEqual(catalog.route(['infra', 'storage', 'register'], manage.CONFIG), ['storage-register', 'part1'])
        with self.assertRaises(RuntimeError): catalog.route(['delta', 'storage', 'register'], manage.CONFIG)
        self.register(); self.add_dependencies(); manage.boot_check('part1', self.profile)
        self.old_operations.assert_not_called()

    def test_project_start_routes_to_current_nas_recovery_not_compose_up(self):
        for args in (['infra', 'start'], ['project', 'infra', 'start'], ['infra', 'recovery']):
            self.assertEqual(catalog.route(args, manage.CONFIG), ['recover', 'part1'])
        with self.assertRaises(RuntimeError): catalog.route(['delta', 'start'], manage.CONFIG)

    def test_interrupted_maintenance_blocks_automatic_and_manual_recovery(self):
        self.register()
        runtime.maintenance_state(manage, self.profile, '/private/pending-maintenance')
        self.rows[0]['State']['Running'] = False
        run = self.patch(manage, 'run')
        for automatic in (False, True):
            with self.assertRaisesRegex(RuntimeError, '维护尚未完成'): manage.recover(self.profile, automatic=automatic)
        with self.assertRaises(RuntimeError): runtime.check(manage, self.profile)
        with self.assertRaises(RuntimeError): runtime.maintenance_state(manage, self.profile, '/wrong-owner', complete=True)
        run.assert_not_called()
        runtime.maintenance_state(manage, self.profile, '/private/pending-maintenance', complete=True)
        self.assertEqual(len(runtime.check(manage, self.profile)), 10)


if __name__ == '__main__': unittest.main()
