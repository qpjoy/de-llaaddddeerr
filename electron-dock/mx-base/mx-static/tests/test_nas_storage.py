import copy
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import catalog
import display
import manage
from projects import infra_storage as storage


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.profile = manage.profiles()['part1']
        self.volume = {'Name': manage.prep.NFS_VOLUME, 'Driver': 'local', 'Options': dict(manage.prep.OPTIONS)}
        self.rows = []
        self.mountinfo = {}
        for i, name in enumerate(sorted(manage.prep.SERVICES), 100):
            row = {'Id': name + '-id', 'State': {'Running': True, 'Pid': i},
                   'Config': {'Labels': {'com.docker.compose.project': 'mx_data', 'com.docker.compose.service': name},
                              'Env': ['PASSWORD=not-for-output']},
                   'HostConfig': {'Mounts': [{'Type': 'volume', 'Source': manage.prep.NFS_VOLUME,
                                            'Target': storage.RAW, 'VolumeOptions': {'NoCopy': True}}]},
                   'Mounts': [{'Type': 'volume', 'Name': vol, 'Destination': dest,
                               'Source': '/data/docker/volumes/' + vol + '/_data', 'RW': name != 'gateway'}
                              for vol, dest in ((manage.prep.VOLUME, '/app/media'), (manage.prep.NFS_VOLUME, storage.RAW))]}
            self.rows.append(row)
            self.mountinfo[row['Id']] = ('1 0 0:1 / / rw - overlay overlay rw\n'
                '2 1 259:1 /docker/volumes/po_infra_media_data/_data /app/media rw - xfs /dev/nvme0n1p1 rw\n'
                '3 2 0:700 / {} {} - nfs {} rw,hard,vers=3,addr=192.168.1.3\n').format(
                    storage.RAW, 'ro' if name == 'gateway' else 'rw', manage.prep.OPTIONS['device'])

    def result(self):
        return storage.evaluate(self.profile, self.rows, self.volume, self.mountinfo)

    def test_all_ten_nfs_children_and_gateway_readonly_pass(self):
        result = self.result()
        self.assertTrue(result['ok'])
        self.assertEqual(len(result['services']), 10)
        self.assertFalse(result['nas_walk'])
        self.assertNotIn('not-for-output', json.dumps(result))

    def test_current_incident_recreated_with_parent_only_is_detected(self):
        for row in self.rows:
            row['Mounts'].pop()
            row['HostConfig']['Mounts'] = []
            self.mountinfo[row['Id']] = '\n'.join(self.mountinfo[row['Id']].splitlines()[:2])
        result = self.result()
        self.assertFalse(result['ok'])
        self.assertTrue(all(s['kernel_source']['type'] == 'xfs' and not s['matched'] for s in result['services']))
        text = display.render(dict(result, event='nas_infra_storage_check'))
        self.assertIn('不通过', text)
        self.assertIn('xfs /app/media', text)

    def test_docker_reinstall_missing_or_local_volume_never_matches(self):
        for volume in (None, {'Name': manage.prep.NFS_VOLUME, 'Driver': 'local', 'Options': {}},
                       dict(self.volume, Options=dict(manage.prep.OPTIONS, device=':/wrong'))):
            self.volume = volume
            self.assertFalse(self.result()['ok'])
        self.rows = []
        self.assertFalse(self.result()['ok'])

    def test_declared_nfs_without_real_kernel_mount_fails(self):
        row = self.rows[0]
        for change in (lambda s: s.replace(' - nfs ', ' - xfs '),
                       lambda s: s.replace('addr=192.168.1.3', 'addr=192.168.1.4'),
                       lambda s: s.replace('hard,vers=3', 'soft,vers=3'),
                       lambda s: s.replace(manage.prep.OPTIONS['device'], ':/wrong'),
                       lambda s: s.replace('3 2 0:700 / ', '3 2 0:700 /other '),
                       lambda s: s + '4 3 259:1 / /app/media/data_hub_raw_media/video rw - xfs /dev/x rw\n'):
            original = self.mountinfo[row['Id']]
            self.mountinfo[row['Id']] = change(original)
            self.assertFalse(self.result()['ok'])
            self.mountinfo[row['Id']] = original

    def test_stopped_or_disappearing_container_is_unverified(self):
        row = self.rows[0]
        row['State']['Running'] = False
        self.assertFalse(self.result()['ok'])
        row['State']['Running'] = True
        del self.mountinfo[row['Id']]
        self.assertFalse(self.result()['ok'])

    def test_duplicate_unknown_consumers_readwrite_gateway_and_missing_nocopy_fail(self):
        original = copy.deepcopy(self.rows)
        self.rows.append(copy.deepcopy(self.rows[0]))
        self.assertFalse(self.result()['ok'])
        self.rows[-1]['Config']['Labels']['com.docker.compose.project'] = 'other'
        self.assertFalse(self.result()['ok'])
        self.rows = original
        gateway = next(r for r in self.rows if r['Config']['Labels']['com.docker.compose.service'] == 'gateway')
        gateway['Mounts'][1]['RW'] = True
        self.assertFalse(self.result()['ok'])
        gateway['Mounts'][1]['RW'] = False
        self.rows[0]['HostConfig']['Mounts'][0]['VolumeOptions']['NoCopy'] = False
        self.assertFalse(self.result()['ok'])

    def test_collection_only_reads_docker_metadata_and_procfs(self):
        def read_text(path):
            row = next(r for r in self.rows if path == Path('/proc/{}/mountinfo'.format(r['State']['Pid'])))
            return self.mountinfo[row['Id']]
        with mock.patch.object(manage, 'run', side_effect=[manage.prep.NFS_VOLUME + '\n', json.dumps([self.volume])]) as run, \
                mock.patch.object(storage.Path, 'read_text', autospec=True, side_effect=read_text), \
                mock.patch.object(storage, 'emit') as emit:
            self.assertTrue(storage.check(manage, self.profile, self.rows))
        self.assertEqual(run.call_args_list, [mock.call(['docker', 'volume', 'ls', '--format', '{{.Name}}']),
                                           mock.call(['docker', 'volume', 'inspect', manage.prep.NFS_VOLUME])])
        self.assertTrue(emit.call_args.kwargs['ok'])

    def test_route_scope_and_failed_check_exit(self):
        self.assertEqual(catalog.route(['infra', 'storage', 'check'], manage.CONFIG), ['storage-check', 'part1'])
        with self.assertRaises(RuntimeError):
            catalog.route(['delta', 'storage', 'check'], manage.CONFIG)
        with self.assertRaises(RuntimeError):
            storage.evaluate(manage.profiles()['part2'], [], None, {})
        with mock.patch.object(sys, 'argv', ['manage.py', 'infra', 'storage', 'check']), \
                mock.patch.object(sys, 'platform', 'linux'), mock.patch.object(manage.os, 'geteuid', return_value=0), \
                mock.patch.object(manage.socket, 'gethostname', return_value='mx-internal-server'), \
                mock.patch.object(manage.precopy, 'check_host'), mock.patch.object(storage, 'check', return_value=False), \
                mock.patch.object(manage, 'audit') as audit:
            self.assertEqual(manage.main(), 1)
        audit.assert_not_called()

    def test_historical_receipt_is_not_presented_as_live_storage(self):
        text = display.render({'event': 'nas_migration_state', 'phase': 'running_on_nas'})
        self.assertIn('历史切换记录', text)
        self.assertIn('不代表当前仍在 NAS', text)


if __name__ == '__main__':
    unittest.main()
