"""Local-bind attestations inspect fixture metadata only; never access a host."""
import copy
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
import kubelet_bindings as bindings

SOURCE_UUID = '45fa3b72-5a59-4d3c-9a57-4f61aee13e5e'
PAY_UID = '2518112c-3f66-48f6-857d-1e7b58072aac'
ES_UID = '27d7dd3e-debf-42f7-a382-d2a8bdc68f21'
GENERATION = '..2026_09_21_10_27_40.4146068500'
ES_VOLUME = '/var/lib/kubelet/pods/' + ES_UID + '/volumes/kubernetes.io~configmap/config'
KUBELET = {'target': '/var/lib/kubelet', 'fstype': 'xfs', 'uuid': SOURCE_UUID, 'fsroot': '/mx-runtime/kubelet'}


def obj(name, namespace='', uid=None, **kwargs):
    return dict({'metadata': {'name': name, 'namespace': namespace, 'uid': uid or name + '-uid'}}, **kwargs)


def objects():
    pay_owner = obj('mx-pay-postgres', 'mx-pay')
    es_owner = obj('mx-common-elasticsearch', 'mx-common')
    def pod(owner, uid, volumes, containers):
        value = obj(owner['metadata']['name'] + '-0', owner['metadata']['namespace'], uid,
                    spec={'nodeName': 'mx-internal-server', 'volumes': volumes, 'containers': containers})
        value['metadata']['ownerReferences'] = [dict(owner['metadata'], kind='StatefulSet', controller=True)]
        return value
    pay = pod(pay_owner, PAY_UID,
              [{'name': 'data', 'persistentVolumeClaim': {'claimName': bindings.PAY_PV}}],
              [{'name': 'postgres', 'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}]}])
    es = pod(es_owner, ES_UID, [{'name': 'config', 'configMap': {'name': bindings.ES_CONFIG}}],
             [{'name': 'elasticsearch', 'volumeMounts': [
                 {'name': 'data'}, {'name': 'snapshots'},
                 {'name': 'config', 'mountPath': '/usr/share/elasticsearch/config/elasticsearch.yml',
                  'subPath': 'elasticsearch.yml', 'readOnly': True}]}])
    pvc = obj(bindings.PAY_PV, 'mx-pay', spec={'volumeName': bindings.PAY_PV}, status={'phase': 'Bound'})
    pv = obj(bindings.PAY_PV, spec={
        'local': {'path': bindings.PAY_PATH}, 'persistentVolumeReclaimPolicy': 'Retain',
        'claimRef': {'name': bindings.PAY_PV, 'namespace': 'mx-pay', 'uid': pvc['metadata']['uid']}},
        status={'phase': 'Bound'})
    return {'pods': [pay, es], 'statefulsets': [pay_owner, es_owner], 'pv': [pv], 'pvc': [pvc],
            'configmaps': [obj(bindings.ES_CONFIG, 'mx-common', data={'elasticsearch.yml': 'PRIVATE-CONTENT'})]}


def mount(kind):
    if kind == 'pay':
        target = '/var/lib/kubelet/pods/' + PAY_UID + '/volumes/kubernetes.io~local-volume/' + bindings.PAY_PV
        root = '/mx-pay/mx-pay/postgres'
    else:
        target = '/var/lib/kubelet/pods/' + ES_UID + '/volume-subpaths/config/elasticsearch/2'
        root = '/mx-runtime/kubelet' + ES_VOLUME[len('/var/lib/kubelet'):] + '/' + GENERATION + '/elasticsearch.yml'
    return dict(target=target, fsroot=root, fstype='xfs', uuid=SOURCE_UUID,
                source='PRIVATE-SOURCE', options='PRIVATE-OPTIONS')


def info(directory=False, inode=99):
    return SimpleNamespace(st_dev=123, st_ino=inode, st_mode=(stat.S_IFDIR if directory else stat.S_IFREG) | 0o755)


def path_info(path, inode=99):
    return info(not (str(path).endswith('/elasticsearch.yml') or str(path) == mount('es')['target']), inode)


class LocalBindingTests(unittest.TestCase):
    def setUp(self):
        self.paths = mock.patch.object(bindings, 'path_info', side_effect=path_info).start()
        self.links = mock.patch.object(bindings.os, 'readlink', side_effect=lambda path:
                                       GENERATION if path.endswith('/..data') else '..data/elasticsearch.yml').start()
        self.realpath = mock.patch.object(bindings.os.path, 'realpath',
                                          return_value=ES_VOLUME + '/' + GENERATION + '/elasticsearch.yml').start()
        self.addCleanup(mock.patch.stopall)

    def verify(self, value, data=None, kubelet=None):
        return bindings.verify(value, data if data is not None else objects(), SOURCE_UUID,
                               kubelet if kubelet is not None else KUBELET)

    def refused(self, value, data=None, reason=None, kubelet=None):
        with self.assertRaises(bindings.guard.StorageError) as caught:
            self.verify(value, data, kubelet)
        message = str(caught.exception)
        self.assertNotIn('PRIVATE-', message)
        diagnostic = json.loads(message.split('kubelet_binding=', 1)[1])
        self.assertEqual(set(diagnostic), {'target', 'fstype', 'reason'})
        if reason:
            self.assertEqual(diagnostic['reason'], reason)

    def test_exact_pay_local_pv_uses_same_directory_identity_without_reading_files(self):
        self.assertIsNone(self.verify(mount('pay')))
        self.assertEqual(self.paths.call_args_list,
                         [mock.call(bindings.PAY_PATH), mock.call(mount('pay')['target'])])
        self.links.assert_not_called()
        self.realpath.assert_not_called()

    def test_exact_es_config_bind_matches_atomic_file_and_physical_source(self):
        value = mount('es')
        self.assertIsNone(self.verify(value))
        self.assertEqual(self.paths.call_args_list, [mock.call(ES_VOLUME),
            mock.call(ES_VOLUME + '/' + GENERATION + '/elasticsearch.yml'),
            mock.call('/data' + value['fsroot']), mock.call(value['target'])])
        self.realpath.assert_called_once_with(ES_VOLUME + '/elasticsearch.yml')

    def test_remote_wrong_disk_and_unknown_xfs_targets_never_touch_paths(self):
        cases = [('fstype', 'nfs'), ('fstype', 'nfs4'), ('fstype', 'cifs'), ('uuid', 'another-disk'),
                 ('target', '/mnt/nas'), ('target', mount('pay')['target'] + '/child'),
                 ('target', mount('es')['target'].replace('/2', '/3'))]
        for field, replacement in cases:
            with self.subTest(field=field, replacement=replacement):
                value = mount('pay')
                value[field] = replacement
                self.refused(value)
        self.paths.assert_not_called()
        self.links.assert_not_called()

    def test_kubelet_backing_must_still_be_original_local_source(self):
        for field, value in [('uuid', 'different'), ('fstype', 'nfs'), ('fsroot', '/other'), ('target', '/mnt/nas')]:
            with self.subTest(field=field):
                self.refused(mount('es'), kubelet=dict(KUBELET, **{field: value}), reason='local-source-filesystem-mismatch')
        self.paths.assert_not_called()

    def test_pay_requires_pod_owner_claim_and_retained_local_pv_relationship(self):
        changes = [
            lambda d: d['pods'][0]['metadata'].update(uid='changed'),
            lambda d: d['pods'][0]['metadata']['ownerReferences'][0].update(uid='changed'),
            lambda d: d['pods'][0]['spec']['volumes'][0]['persistentVolumeClaim'].update(claimName='other'),
            lambda d: d['pods'][0]['spec']['containers'][0]['volumeMounts'][0].update(subPath='pgdata'),
            lambda d: d['pv'][0]['spec']['local'].update(path='/mnt/nas/postgres'),
            lambda d: d['pv'][0]['spec'].update(nfs={'server': 'PRIVATE-SERVER', 'path': '/volume'}),
            lambda d: d['pv'][0]['spec'].update(persistentVolumeReclaimPolicy='Delete'),
            lambda d: d['pv'][0]['spec']['claimRef'].update(uid='changed'),
            lambda d: d['pvc'][0]['spec'].update(volumeName='other'),
            lambda d: d['pv'][0]['status'].update(phase='Released'),
            lambda d: d['pods'].append(copy.deepcopy(d['pods'][0])),
        ]
        for number, change in enumerate(changes):
            with self.subTest(number=number):
                data = objects()
                change(data)
                self.refused(mount('pay'), data)
        self.paths.assert_not_called()

    def test_pay_fsroot_and_inode_cannot_alias_other_storage(self):
        self.refused(dict(mount('pay'), fsroot='/postgres'), reason='pay-bind-fsroot-mismatch')
        self.paths.side_effect = lambda path: info(True, inode=1 if path == bindings.PAY_PATH else 2)
        self.refused(mount('pay'), reason='bind-inode-mismatch')

    def test_es_requires_exact_configmap_and_readonly_subpath_at_index_two(self):
        changes = [
            lambda d: d['pods'][1]['spec']['volumes'][0].update(configMap={'name': 'another'}),
            lambda d: d['pods'][1]['spec']['volumes'][0].update(secret={'secretName': 'other'}),
            lambda d: d['pods'][1]['spec']['containers'][0]['volumeMounts'][2].update(readOnly=False),
            lambda d: d['pods'][1]['spec']['containers'][0]['volumeMounts'][2].update(subPath='credentials'),
            lambda d: d['pods'][1]['spec']['containers'][0]['volumeMounts'][2].update(subPathExpr='$(PRIVATE)'),
            lambda d: d['configmaps'].clear(),
        ]
        for number, change in enumerate(changes):
            with self.subTest(number=number):
                data = objects()
                change(data)
                self.refused(mount('es'), data)
        self.paths.assert_not_called()

    def test_es_requires_same_pod_atomic_generation_before_any_path_inspection(self):
        for root in ['/mnt/nas/config', mount('es')['fsroot'].replace(ES_UID, PAY_UID),
                     mount('es')['fsroot'].replace(GENERATION, '../escape'),
                     mount('es')['fsroot'].replace(GENERATION, '..data')]:
            self.refused(dict(mount('es'), fsroot=root), reason='es-bind-fsroot-mismatch')
        self.paths.assert_not_called()

    def test_es_link_escape_or_changed_generation_never_resolves_remote_target(self):
        for replacement in ['/mnt/nas/elasticsearch.yml', '../escape', '..data/credentials', '..2020_01_01_00_00_00.1']:
            self.links.side_effect = None
            self.links.return_value = replacement
            self.refused(mount('es'), reason='es-config-symlink-mismatch')
        self.realpath.assert_not_called()

    def test_es_inode_or_realpath_changes_are_refused(self):
        self.paths.side_effect = lambda path: path_info(path, inode=2 if path == mount('es')['target'] else 1)
        self.refused(mount('es'), reason='bind-inode-mismatch')
        self.paths.side_effect = path_info
        self.realpath.return_value = '/mnt/nas/elasticsearch.yml'
        self.refused(mount('es'), reason='es-config-realpath-mismatch')

    def test_path_error_does_not_expose_raw_data(self):
        self.paths.side_effect = OSError('PRIVATE-PATH-ERROR')
        self.refused(mount('pay'), reason='local-path-identity-unavailable')


class PluginPathTests(unittest.TestCase):
    def test_verified_binds_use_real_general_guard_and_plugin_adapter(self):
        # Keep canonical() and path_info() real: a blanket mock of either
        # would hide the general guard's intentional rejection of '~'.
        with mock.patch.object(Path, 'lstat', side_effect=lambda *args: info(True)):
            with mock.patch.object(bindings.os, 'lstat', side_effect=path_info):
                with mock.patch.object(bindings.os, 'readlink', side_effect=lambda path:
                                       GENERATION if path.endswith('/..data') else '..data/elasticsearch.yml'):
                    with mock.patch.object(bindings.os.path, 'realpath',
                                           return_value=ES_VOLUME + '/' + GENERATION + '/elasticsearch.yml'):
                        self.assertIsNone(bindings.verify(mount('pay'), objects(), SOURCE_UUID, KUBELET))
        with mock.patch.object(Path, 'lstat', autospec=True, side_effect=lambda path: path_info(str(path))):
            with mock.patch.object(bindings.os, 'lstat', side_effect=path_info):
                with mock.patch.object(bindings.os, 'readlink', side_effect=lambda path:
                                       GENERATION if path.endswith('/..data') else '..data/elasticsearch.yml'):
                    with mock.patch.object(bindings.os.path, 'realpath',
                                           return_value=ES_VOLUME + '/' + GENERATION + '/elasticsearch.yml'):
                        self.assertIsNone(bindings.verify(mount('es'), objects(), SOURCE_UUID, KUBELET))

    def test_general_guard_rejects_symlink_ancestor_before_plugin_access(self):
        with mock.patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)):
            with mock.patch.object(bindings.os, 'lstat') as lstat:
                with self.assertRaises(bindings.guard.StorageError):
                    bindings.path_info(ES_VOLUME)
        lstat.assert_not_called()

    def test_fixed_plugin_component_checks_parent_and_each_descendant_without_symlinks(self):
        path = ES_VOLUME + '/' + GENERATION + '/elasticsearch.yml'
        with mock.patch.object(bindings.guard, 'path_info', return_value=info(True)) as parent:
            with mock.patch.object(bindings.os, 'lstat', side_effect=lambda value: info(not value.endswith('/elasticsearch.yml'))) as lstat:
                self.assertTrue(stat.S_ISREG(bindings.path_info(path).st_mode))
        parent.assert_called_once_with('/var/lib/kubelet/pods/' + ES_UID + '/volumes', protected=False)
        self.assertEqual(len(lstat.call_args_list), 4)

    def test_symlink_below_plugin_is_rejected_without_following_it(self):
        link = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        with mock.patch.object(bindings.guard, 'path_info', return_value=info(True)):
            with mock.patch.object(bindings.os, 'lstat', return_value=link) as lstat:
                with self.assertRaises(bindings._Mismatch):
                    bindings.path_info(ES_VOLUME + '/' + GENERATION + '/elasticsearch.yml')
        self.assertEqual(lstat.call_count, 1)

    def test_other_plugin_or_traversal_is_refused_before_path_access(self):
        with mock.patch.object(bindings.guard, 'path_info') as parent:
            with mock.patch.object(bindings.os, 'lstat') as lstat:
                for path in [ES_VOLUME.replace('configmap', 'nfs'), ES_VOLUME + '/../escape', ES_VOLUME + '//file']:
                    with self.assertRaises(bindings._Mismatch):
                        bindings.path_info(path)
        parent.assert_not_called()
        lstat.assert_not_called()


if __name__ == '__main__':
    unittest.main()
