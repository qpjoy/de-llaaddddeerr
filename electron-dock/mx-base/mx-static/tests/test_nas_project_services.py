import copy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import manage
import recovery
from projects import infra_services as services
from projects import infra_runtime as media
import test_nas_media_runtime


class ProjectServicesTests(unittest.TestCase):
    patch = test_nas_media_runtime.MediaRuntimeTests.patch
    start = test_nas_media_runtime.MediaRuntimeTests.start

    def setUp(self):
        test_nas_media_runtime.MediaRuntimeTests.setUp(self)
        media.register(manage, self.profile)
        test_nas_media_runtime.MediaRuntimeTests.add_dependencies(self)
        self.patch(services.socket, 'create_connection')
        self.by_name = {c['Config']['Labels']['com.docker.compose.service']: c for c in self.rows}
        self.data_guard = self.patch(services, 'local_data_guard')
        self.commands = self.patch(manage, 'run', side_effect=self.start)
        self.receipt_reads.side_effect = AssertionError('Read old migration report')

    def stop(self, *names):
        for name in names: self.by_name[name]['State']['Running'] = False

    def starts(self): return [c.args[0][2] for c in self.commands.call_args_list]

    def test_all_running_is_noop_even_when_application_health_is_bad(self):
        for c in self.rows: c['State']['Health']['Status'] = 'unhealthy'
        manage.recover(self.profile)
        self.commands.assert_not_called(); self.data_guard.assert_not_called()

    def test_current_config_images_and_ids_do_not_bind_to_old_migration_report(self):
        for c in self.rows:
            old = c['Id']; c['Id'] = 'new-' + old
            if old in self.mountinfo: self.mountinfo[c['Id']] = self.mountinfo.pop(old)
            c['Config'].update(Env=['CURRENT_SETTING=changed'], Image='current-image')
        profile = dict(self.profile, report=None)
        manage.task_command('recover', profile, mock.Mock(part='part1'))
        manage.recover(profile)
        self.commands.assert_not_called()

    def test_missing_registration_never_uses_legacy_application_snapshot(self):
        (self.auto / media.RECORD).unlink()
        with self.assertRaisesRegex(RuntimeError, 'storage register'): manage.recover(self.profile)
        self.old_operations.assert_not_called(); self.commands.assert_not_called()

    def test_unreachable_nas_never_starts_databases_or_media(self):
        self.stop(*self.by_name)
        self.patch(services.socket, 'create_connection', side_effect=OSError('offline'))
        with self.assertRaises(OSError): manage.recover(self.profile)
        self.commands.assert_not_called()

    def test_wrong_kernel_mount_after_start_is_not_claimed_success(self):
        self.stop('web')
        def wrong(args, **kwargs):
            self.start(args); self.mountinfo['web-id'] = self.mountinfo['web-id'].replace(' - nfs ', ' - xfs ')
        self.commands.side_effect = wrong
        with self.assertRaisesRegex(RuntimeError, '媒体挂载'): manage.recover(self.profile)

    def test_explicit_start_does_not_enable_disabled_future_boot_recovery(self):
        self.stop('web'); self.policy['suspended'] = True
        manage.recover(self.profile)
        self.assertEqual(self.starts(), ['web-id']); self.assertTrue(self.policy['suspended'])

    def test_cold_boot_starts_existing_databases_then_media_and_gateway(self):
        self.stop(*self.by_name)
        manage.recover(dict(self.profile, report=None), automatic=True)
        sequence = self.starts()
        self.assertEqual(sequence[:2], ['postgres-id', 'redis-id'])
        self.assertLess(sequence.index('web-id'), sequence.index('gateway-id'))
        self.assertLess(sequence.index('chat-gateway-id'), sequence.index('gateway-id'))
        self.assertEqual(len(sequence), 12)
        self.assertTrue(all(c.args[0][:2] == ['docker', 'start'] for c in self.commands.call_args_list))

    def test_partial_outage_only_starts_stopped_services(self):
        self.stop('redis', 'web')
        manage.recover(self.profile)
        self.assertEqual(self.starts(), ['redis-id', 'web-id'])

    def test_real_depends_on_label_takes_precedence_over_legacy_group_order(self):
        self.stop('worker', 'web')
        self.by_name['web']['Config']['Labels'][services.LABEL] = 'worker:service_started:false'
        manage.recover(self.profile)
        self.assertEqual(self.starts(), ['worker-id', 'web-id'])

    def test_healthy_condition_waits_without_restarting_running_dependency(self):
        self.stop('web'); self.by_name['postgres']['State']['Health']['Status'] = 'starting'
        def ready(_): self.by_name['postgres']['State']['Health']['Status'] = 'healthy'
        sleeping = self.patch(services.time, 'sleep', side_effect=ready)
        manage.recover(self.profile)
        sleeping.assert_called_once(); self.assertEqual(self.starts(), ['web-id'])

    def test_service_started_does_not_require_health(self):
        self.stop('web'); self.by_name['postgres']['State'].pop('Health')
        self.by_name['web']['Config']['Labels'][services.LABEL] = 'postgres:service_started:false'
        manage.recover(self.profile)
        self.assertEqual(self.starts(), ['web-id'])

    def test_unhealthy_timeout_missing_health_never_starts_dependent(self):
        self.stop('web'); self.by_name['postgres']['State']['Health']['Status'] = 'unhealthy'
        self.patch(services, 'WAIT_SECONDS', 0)
        with self.assertRaisesRegex(RuntimeError, '超时'): manage.recover(self.profile)
        self.by_name['postgres']['State'].pop('Health')
        with self.assertRaisesRegex(RuntimeError, '没有健康检查'): manage.recover(self.profile)
        self.commands.assert_not_called()

    def test_dependency_cycle_unknown_and_job_conditions_block_before_start(self):
        self.stop('web')
        for label in ('web:service_started:false', 'migration:service_completed_successfully:false',
                      'unregistered:service_started:false', 'postgres:invalid:false'):
            self.by_name['web']['Config']['Labels'][services.LABEL] = label
            with self.assertRaises(RuntimeError): manage.recover(self.profile)
        self.commands.assert_not_called()

    def test_missing_db_wrong_nas_or_empty_db_blocks_all_starts(self):
        self.stop(*self.by_name)
        self.rows.remove(self.by_name['postgres'])
        with self.assertRaises(RuntimeError): manage.recover(self.profile)
        self.rows.append(self.by_name['postgres'])
        self.volume['Options'] = {}
        with self.assertRaises(RuntimeError): manage.recover(self.profile)
        self.volume['Options'] = dict(manage.prep.OPTIONS)
        self.data_guard.side_effect = RuntimeError('empty database')
        with self.assertRaisesRegex(RuntimeError, 'empty database'): manage.recover(self.profile)
        self.commands.assert_not_called()

    def test_concurrent_replacement_and_pause_block_remaining_services(self):
        self.stop('postgres', 'web')
        def replace(args, **kwargs):
            self.start(args); self.by_name['redis']['Id'] = 'another-redis'
        self.commands.side_effect = replace
        with self.assertRaisesRegex(RuntimeError, '恢复期间变化'): manage.recover(self.profile)
        self.assertEqual(self.starts(), ['postgres-id'])

    def test_pause_while_waiting_never_starts_application(self):
        self.stop('web'); self.by_name['postgres']['State']['Health']['Status'] = 'starting'
        self.patch(services.time, 'sleep', side_effect=lambda _: self.policy.update(suspended=True))
        with self.assertRaisesRegex(RuntimeError, '暂停'): manage.recover(self.profile, automatic=True)
        self.commands.assert_not_called()

    def test_boot_inventory_and_runner_include_stopped_databases(self):
        self.stop('postgres', 'redis')
        self.patch(manage.precopy, 'inspect_containers', return_value=self.rows)
        row = next(r for r in recovery.inventory(manage)[1] if r['task'] == 'part1')
        self.assertEqual(set(row['stopped']), {'postgres-id', 'redis-id'})
        recovery.run_all(manage)
        self.assertEqual(self.starts(), ['postgres-id', 'redis-id'])


class DependencyDataTests(unittest.TestCase):
    def test_local_volume_requires_existing_pg_markers_and_never_creates_files(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve(); data = root / 'pg' / '_data'; data.mkdir(parents=True)
            c = {'Config': {'Env': []}, 'Mounts': [{'Type': 'volume', 'Name': 'pg', 'RW': True,
                 'Destination': '/var/lib/postgresql/data', 'Source': str(data)}]}
            volume = [{'Name': 'pg', 'Driver': 'local', 'Options': None, 'Mountpoint': str(data)}]
            with mock.patch.object(services, 'LOCAL_VOLUMES', str(root)), mock.patch.object(manage, 'run', return_value=json.dumps(volume)) as run:
                with self.assertRaises(FileNotFoundError): services.local_data_guard(manage, 'postgres', c)
                self.assertEqual(list(data.iterdir()), [])
                (data / 'PG_VERSION').write_text('16'); (data / 'global').mkdir(); (data / 'global/pg_control').write_bytes(b'control')
                services.local_data_guard(manage, 'postgres', c)
                (data / 'PG_VERSION').unlink(); (data / 'PG_VERSION').symlink_to(data / 'global/pg_control')
                with self.assertRaises(RuntimeError): services.local_data_guard(manage, 'postgres', c)
                self.assertTrue(all(call.args[0] == ['docker', 'volume', 'inspect', 'pg'] for call in run.call_args_list))

    def test_missing_readonly_bind_or_nfs_database_volume_is_not_started(self):
        base = {'Config': {}, 'Mounts': [{'Type': 'volume', 'Name': 'pg', 'RW': True,
                'Destination': '/var/lib/postgresql/data', 'Source': '/data/docker/volumes/pg/_data'}]}
        with mock.patch.object(manage, 'run', return_value='[]'):
            with self.assertRaises(RuntimeError): services.local_data_guard(manage, 'postgres', base)
        for key, value in [('Type', 'bind'), ('RW', False)]:
            c = copy.deepcopy(base); c['Mounts'][0][key] = value
            with self.assertRaises(RuntimeError): services.local_data_guard(manage, 'postgres', c)


if __name__ == '__main__': unittest.main()
