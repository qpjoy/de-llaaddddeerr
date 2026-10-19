"""Offline tests only: every host command/mount is intercepted.

The transaction tests use real private temporary files for journals, generations,
manifest renames and fstab, with an in-memory mount/container model. No root,
Kubernetes, Docker, etcd or Linux mounts are required.
"""
import copy
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1]))
SPEC = importlib.util.spec_from_file_location('mx_move_etcd_tested', Path(__file__).parents[1] / 'move.py')
move = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(move)


def write_data(directory, revision, values):
    directory = Path(directory)
    (directory / 'member/snap').mkdir(parents=True, exist_ok=True)
    (directory / 'member/wal').mkdir(parents=True, exist_ok=True)
    raw = json.dumps({'revision': revision, 'values': values}, sort_keys=True).encode()
    (directory / 'member/snap/db').write_bytes(raw)
    (directory / 'member/wal/0000000000000000.wal').write_bytes(b'wal:' + raw)


def read_data(directory):
    return json.loads((Path(directory) / 'member/snap/db').read_text())


class CriCompatibilityTests(unittest.TestCase):
    # Exact labels/spacing printed by cri-tools v1.31.1 cmd/crictl/version.go.
    VERSION = b'Version:  0.1.0\nRuntimeName:  containerd\nRuntimeVersion:  1.7.22\nRuntimeApiVersion:  v1\n'

    def setUp(self):
        self.host = move.Host()
        self.host.endpoint = 'unix:///run/containerd/containerd.sock'

    def test_runtime_uses_text_version_and_the_actual_kubelet_socket(self):
        with tempfile.TemporaryDirectory(prefix='mx-move-cri-') as directory:
            proc = Path(directory) / 'proc/123'
            proc.mkdir(parents=True)
            config = Path(directory) / 'kubelet.yaml'
            config.write_text('staticPodPath: /etc/kubernetes/manifests\ncontainerRuntimeEndpoint: unix:///stale.sock\n')
            (proc / 'comm').write_text('kubelet\n')
            (proc / 'cmdline').write_bytes(('kubelet\0--config={}\0--container-runtime-endpoint={}\0'.format(
                config, self.host.endpoint)).encode())

            def crictl(args, **kwargs):
                # Reproduce the real CLI contract: -o json is NOT a version flag.
                if args[-1] != 'version':
                    return move.subprocess.CompletedProcess(args, 1, b'', b'flag provided but not defined: -o')
                return move.subprocess.CompletedProcess(args, 0, self.VERSION, b'')

            with mock.patch.object(move.Path, 'glob', return_value=[proc]), \
                    mock.patch.object(move.Path, 'is_socket', return_value=True), \
                    mock.patch.object(move, 'safe_path'), \
                    mock.patch.object(move.subprocess, 'run', side_effect=crictl) as execute:
                self.host.runtime()
            command = execute.call_args[0][0]
            self.assertEqual(command, ['crictl', '--runtime-endpoint=' + self.host.endpoint,
                                      '--image-endpoint=' + self.host.endpoint, '--timeout=10s', 'version'])
            self.assertNotIn('-o', command)

    def test_version_parses_text_spacing_and_crlf(self):
        parsed = move.parse_cri_version(self.VERSION.replace(b'\n', b'\r\n'))
        self.assertEqual(parsed['RuntimeName'], 'containerd')
        self.assertEqual(parsed['RuntimeVersion'], '1.7.22')
        self.assertEqual(parsed['RuntimeApiVersion'], 'v1')

    def test_version_rejects_missing_duplicate_or_empty_identity_without_echoing_output(self):
        for raw in [b'sensitive-token-value', self.VERSION.replace(b'RuntimeName:  containerd\n', b''),
                    self.VERSION + b'RuntimeName: containerd\n',
                    self.VERSION.replace(b'RuntimeName:  containerd', b'RuntimeName:  ')]:
            with self.subTest(raw=raw):
                with self.assertRaises(move.Refuse) as error:
                    move.parse_cri_version(raw)
                self.assertNotIn('sensitive-token-value', str(error.exception))

    def test_ps_pins_image_socket_and_keeps_supported_json_output(self):
        response = {'containers': [{'id': 'live-etcd', 'metadata': {'name': 'etcd'}, 'state': 'CONTAINER_RUNNING'}]}
        completed = move.subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b'')
        with mock.patch.object(move.subprocess, 'run', return_value=completed) as execute:
            self.assertEqual(self.host.etcd_containers(), response['containers'])
        self.assertEqual(execute.call_args[0][0][-4:], ['ps', '-a', '-o', 'json'])
        self.assertIn('--image-endpoint=' + self.host.endpoint, execute.call_args[0][0])

    def test_cri_failures_name_stage_socket_and_category_without_exposing_output(self):
        cases = [(b'flag provided but not defined: -o', '不支持所用参数'),
                 (b'dial unix socket: connection refused', '拒绝连接'),
                 (b'context deadline exceeded', '请求超时'),
                 (b'unknown service runtime.v1.RuntimeService', 'API 不兼容'),
                 (b'permission denied', '权限不足'),
                 (b'no such file or directory', '路径不存在'),
                 (b'other error', '运行时请求失败')]
        for stderr, reason in cases:
            with self.subTest(reason=reason):
                response = move.subprocess.CompletedProcess([], 1, b'sensitive-stdout', stderr + b' sensitive-stderr')
                with mock.patch.object(move.subprocess, 'run', return_value=response):
                    with self.assertRaises(move.Refuse) as error:
                        self.host.cri('inspect', '-o', 'json', 'etcd-id')
                message = str(error.exception)
                self.assertIn('crictl inspect', message)
                self.assertIn('退出码 1', message)
                self.assertIn(self.host.endpoint, message)
                self.assertIn(reason, message)
                self.assertIn('只读复查：crictl', message)
                self.assertNotIn('sensitive-', message)

    def test_process_timeout_and_execution_failure_remain_private(self):
        cases = [(move.subprocess.TimeoutExpired('crictl', 30, output=b'sensitive-token'), '执行超时'),
                 (OSError('sensitive-path'), '无法启动 crictl')]
        for failure, reason in cases:
            with self.subTest(reason=reason), mock.patch.object(move.subprocess, 'run', side_effect=failure):
                with self.assertRaises(move.Refuse) as error:
                    self.host.cri('version')
                self.assertIn(reason, str(error.exception))
                self.assertNotIn('sensitive-', str(error.exception))

    def test_invalid_inspect_json_is_not_echoed(self):
        for raw in [b'sensitive-not-json', b'[]', b'null']:
            with self.subTest(raw=raw), mock.patch.object(move.subprocess, 'run', return_value=
                    move.subprocess.CompletedProcess([], 0, raw, b'')):
                with self.assertRaises(move.Refuse) as error:
                    self.host.cri_json('inspect', '-o', 'json', 'etcd-id')
                self.assertIn('crictl inspect', str(error.exception))
                self.assertNotIn('sensitive-', str(error.exception))

    def test_non_cri_errors_still_hide_raw_output(self):
        with mock.patch.object(move.subprocess, 'run', return_value=
                move.subprocess.CompletedProcess([], 1, b'sensitive-secret', b'sensitive-stderr')):
            with self.assertRaises(move.Refuse) as error:
                move.run(['kubectl', 'get', 'secret'])
        self.assertEqual(str(error.exception), 'kubectl 返回失败（输出已隐藏）')


class PureFunctions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mx-move-pure-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_snapshot_requires_real_sha256_tail(self):
        path = self.root / 'snapshot.db'
        body = bytes(range(256)) * 8192
        path.write_bytes(body + hashlib.sha256(body).digest())
        self.assertEqual(move.verify_snapshot(path), hashlib.sha256(body).hexdigest())
        path.write_bytes(b'X' + body[1:] + hashlib.sha256(body).digest())
        with self.assertRaisesRegex(move.Refuse, 'SHA256'):
            move.verify_snapshot(path)

    def test_snapshot_rejects_plain_db_truncation_empty_and_invented_tail(self):
        path = self.root / 'snapshot.db'
        for raw in [b'', bytes(32), bytes(512), bytes(511) + hashlib.sha256(bytes(511)).digest(), bytes(512) + bytes(32)]:
            with self.subTest(length=len(raw)):
                path.write_bytes(raw)
                with self.assertRaises(move.Refuse):
                    move.verify_snapshot(path)

    def test_fstab_replaces_only_source_token_and_preserves_every_other_byte(self):
        raw = (b'# original root\nUUID=root / ext4 defaults 0 1\n\n'
               b'  /data/etcd\t/var/lib/etcd none bind,x-systemd.requires-mounts-for=/data 0 0 # keep this\n'
               b'/data/docker /var/lib/docker none bind 0 0\n'
               b'# trailing comment without newline')
        result = move.change_fstab(raw, '/new/etcd-generation')
        self.assertEqual(result, raw.replace(b'  /data/etcd\t', b'  /new/etcd-generation\t', 1))
        self.assertEqual(move.change_fstab(result, '/data/etcd'), raw)

    def test_fstab_rejects_missing_duplicate_or_non_required_bind(self):
        for raw in [b'', b'/data/etcd /var/lib/etcd none bind 0 0\n' * 2,
                    b'/data/etcd /var/lib/etcd none defaults 0 0\n'] + [
                        ('/data/etcd /var/lib/etcd none bind,{} 0 0\n'.format(option)).encode()
                        for option in ['nofail', 'noauto', 'ro']]:
            with self.subTest(raw=raw):
                with self.assertRaises(move.Refuse):
                    move.parse_fstab(raw)

    def test_physical_disks_distinguishes_partitions_from_physical_devices(self):
        tree = {'blockdevices': [
            {'name': '/dev/nvme0n1', 'type': 'disk', 'maj:min': '259:0', 'children': [
                {'name': '/dev/nvme0n1p1', 'type': 'part', 'maj:min': '259:1'},
                {'name': '/dev/nvme0n1p2', 'type': 'part', 'maj:min': '259:2'}]},
            {'name': '/dev/nvme1n1', 'type': 'disk', 'maj:min': '259:3', 'children': [
                {'name': '/dev/nvme1n1p1', 'type': 'part', 'maj:min': '259:4'}]}]}
        self.assertEqual(move.physical_disks(tree, '259:1'), ['/dev/nvme0n1'])
        self.assertEqual(move.physical_disks(tree, '259:1'), move.physical_disks(tree, '259:2'))
        self.assertNotEqual(move.physical_disks(tree, '259:1'), move.physical_disks(tree, '259:4'))
        with self.assertRaises(move.Refuse):
            move.physical_disks(tree, '9:999')

    def test_physical_disks_finds_every_underlying_disk_of_shared_mapper(self):
        mapper = {'name': '/dev/mapper/shared', 'type': 'lvm', 'maj:min': '253:0'}
        tree = {'blockdevices': [
            {'name': '/dev/a', 'type': 'disk', 'maj:min': '8:0', 'children': [mapper]},
            {'name': '/dev/b', 'type': 'disk', 'maj:min': '8:1', 'children': [mapper]}]}
        self.assertEqual(move.physical_disks(tree, '253:0'), ['/dev/a', '/dev/b'])

    def test_tree_bytes_requires_full_data_and_rejects_symlinks(self):
        source = self.root / 'source'
        write_data(source, 10, ['original'])
        expected = sum(p.stat().st_size for p in source.rglob('*') if p.is_file())
        self.assertEqual(move.tree_bytes(source), expected)
        (source / 'external').symlink_to(self.root)
        with self.assertRaises(move.Refuse):
            move.tree_bytes(source)
        (source / 'external').unlink()
        shutil.rmtree(str(source / 'member/wal'))
        with self.assertRaises(move.Refuse):
            move.tree_bytes(source)

    def test_flag_rejects_duplicates(self):
        self.assertEqual(move.flag(['--data-dir=/var/lib/etcd'], '--data-dir'), '/var/lib/etcd')
        self.assertEqual(move.flag(['--data-dir', '/var/lib/etcd'], '--data-dir'), '/var/lib/etcd')
        with self.assertRaises(move.Refuse):
            move.flag(['--data-dir=/var/lib/etcd', '--data-dir', '/other'], '--data-dir')

    @staticmethod
    def manifest():
        return {'kind': 'Pod', 'metadata': {'name': 'etcd', 'namespace': 'kube-system'},
                'spec': {'hostNetwork': True, 'containers': [{
                    'name': 'etcd', 'command': ['etcd', '--data-dir=/var/lib/etcd',
                                               '--listen-client-urls=https://127.0.0.1:2379'],
                    'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/etcd'},
                                     {'name': 'tls', 'mountPath': '/etc/kubernetes/pki/etcd'}]}],
                    'volumes': [{'name': 'data', 'hostPath': {'path': '/var/lib/etcd'}},
                                {'name': 'tls', 'hostPath': {'path': '/etc/kubernetes/pki/etcd'}}]}}

    def test_validate_manifest_accepts_original_kubeadm_layout(self):
        pod = self.manifest()
        self.assertEqual(move.validate_manifest(pod), pod['spec']['containers'][0]['command'])

    def test_validate_manifest_rejects_external_wal_and_config_file(self):
        for extra in [['--wal-dir=/other/wal'], ['--wal-dir', '/other/wal'],
                      ['--config-file=/etc/etcd/config.yaml'], ['--config-file', '/etc/etcd/config.yaml']]:
            with self.subTest(extra=extra):
                pod = self.manifest()
                pod['spec']['containers'][0]['args'] = extra
                with self.assertRaisesRegex(move.Refuse, 'WAL/config-file'):
                    move.validate_manifest(pod)

    def test_validate_manifest_rejects_envfrom_and_etcd_environment_overrides(self):
        for env in [{'envFrom': [{'secretRef': {'name': 'settings'}}]},
                    {'env': [{'name': 'ETCD_WAL_DIR', 'value': '/other'}]},
                    {'env': [{'name': 'ETCD_DATA_DIR', 'valueFrom': {'secretKeyRef': {'name': 'settings', 'key': 'dir'}}}]},
                    {'env': [{'name': 'ETCD_CONFIG_FILE', 'value': '/config.yaml'}]},
                    {'env': [{'name': 'ETCD_LISTEN_CLIENT_URLS', 'value': 'http://localhost:2379'}]}]:
            with self.subTest(env=env):
                pod = self.manifest()
                pod['spec']['containers'][0].update(env)
                with self.assertRaisesRegex(move.Refuse, '环境变量覆盖'):
                    move.validate_manifest(pod)

    def test_capacity_preserves_larger_of_twenty_gib_or_ten_percent(self):
        for total_gib, reserve_gib in [(100, 20), (1000, 100)]:
            with self.subTest(total_gib=total_gib):
                needed = 3 * move.GIB
                info = mock.Mock(f_bavail=reserve_gib * move.GIB + needed - 1,
                                 f_frsize=1, f_blocks=total_gib * move.GIB)
                with mock.patch.object(move.os, 'statvfs', return_value=info):
                    with self.assertRaisesRegex(move.Refuse, '空间不足'):
                        move.capacity(self.root, needed)
                    info.f_bavail += 1
                    result = move.capacity(self.root, needed)
                    self.assertEqual(result['reserve_gib'], reserve_gib)
                    self.assertEqual(result['required_gib'], 3)

    def test_capacity_explains_internal_root_volume_shortfall(self):
        # Server df -B1 values; du's apparent-size estimate includes directory
        # metadata, so the real file-only migration budget can be slightly less.
        info = mock.Mock(f_bavail=102774824960 // 4096,
                         f_frsize=4096, f_blocks=1098974756864 // 4096)
        with mock.patch.object(move.os, 'statvfs', return_value=info):
            with self.assertRaises(move.Refuse) as error:
                move.capacity(Path('/var/lib'), 3 * 400841731 + move.GIB)
        message = str(error.exception)
        for expected in ['/var/lib', '总容量 1023.50 GiB', '可用 95.72 GiB',
                         '预算 2.12 GiB', '预留 102.35 GiB', '需要 104.47 GiB',
                         '释放至少 9 GiB']:
            self.assertIn(expected, message)

    def test_capacity_never_rounds_a_positive_shortfall_to_zero(self):
        info = mock.Mock(f_bavail=21 * move.GIB - 1, f_frsize=1, f_blocks=100 * move.GIB)
        with mock.patch.object(move.os, 'statvfs', return_value=info):
            with self.assertRaisesRegex(move.Refuse, '释放至少 1 GiB'):
                move.capacity(self.root, move.GIB)


class FakeHandle:
    """Real directory fd with portable command paths for the offline runner.

    The production helper's ownership/no-follow and /proc FD behavior has its
    own tests. These transaction fixtures model identity changes and anchoring
    while allowing ordinary unprivileged temporary directories on macOS.
    """
    def __init__(self, path, fd):
        self.path, self.fd = Path(path), fd
        info = os.fstat(fd)
        self.identity = {'device': info.st_dev, 'inode': info.st_ino}
        self.proc_path = str(path)

    def assert_current(self):
        move.require(move.directory_identity(self.path) == self.identity,
                     'offline canonical directory identity differs')

    @contextlib.contextmanager
    def open_child(self, name):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            yield FakeHandle(self.path / name, fd)
        finally:
            os.close(fd)


class FakeHost:
    def __init__(self, fixture):
        self.fixture = fixture
        self.active = fixture.origin
        self.endpoint = 'unix:///offline/containerd.sock'
        self.etcdctl = str(fixture.tool)
        self.helper_calls = []
        self.lease_revision = 0

    def discover(self):
        self.same_mount(self.active)
        return {'node': 'original-node', 'cluster_uid': 'original-uid',
                'source': str(self.active), 'source_disk': self.disk(self.active),
                'source_identity': self.storage_identity(self.active),
                'source_parent_identity': self.storage_identity(self.active.parent),
                'size': move.tree_bytes(self.active), 'etcd': self.etcd_status(),
                'endpoint': self.endpoint}

    @contextlib.contextmanager
    def storage(self, path, expected=None):
        fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            handle = FakeHandle(path, fd)
            move.require(expected is None or handle.identity == expected,
                         'offline stored directory identity differs')
            handle.assert_current()
            yield handle
        finally:
            os.close(fd)

    def storage_identity(self, path):
        with self.storage(path) as handle:
            return handle.identity

    def active_identity(self, expected, disk):
        move.require(self.active is not None and self.disk(self.active) == disk and
                     move.directory_identity(move.DATA) == expected,
                     'offline active directory identity differs')

    def disk(self, path):
        path = Path(path)
        if path == self.fixture.disk_two or self.fixture.disk_two in path.parents:
            return {'uuid': 'disk-two-uuid', 'disks': ['/dev/offline-two']}
        return {'uuid': 'disk-one-uuid', 'disks': ['/dev/offline-one']}

    def mount(self, path):
        return {'target': str(move.DATA) if self.active is not None else '/', 'uuid': self.disk(self.active or '/')['uuid']}

    def same_mount(self, path):
        move.require(self.active is not None and os.path.samefile(str(path), str(self.active)),
                     'offline mount identity differs')

    def persistent_mount(self, source):
        _, fields = move.parse_fstab(move.FSTAB.read_bytes())
        move.require(fields[0] == str(source), 'offline persistent mount differs')

    def stopped(self):
        return not move.MANIFEST.exists()

    def helper(self, action, journal):
        self.helper_calls.append((action, str(self.active)))

    def no_child_mounts(self, paths):
        pass

    def leases(self):
        self.lease_revision += 1
        return {'controller': self.lease_revision, 'scheduler': self.lease_revision}

    def launcher_check(self):
        return {'namespace': 'mx-launcher', 'secrets': {'original': 'unchanged-fingerprint'}, 'login_config': {'enabled': True}}

    def ctl(self, *args):
        if args[:2] != ('snapshot', 'save'):
            raise AssertionError('unexpected offline etcdctl operation')
        body = (self.active / 'member/snap/db').read_bytes()
        body += bytes((-len(body)) % 512)
        Path(args[2]).write_bytes(body + hashlib.sha256(body).digest())
        return b''

    def etcd_status(self):
        return {'cluster_id': 'original-etcd-cluster', 'member_id': 'original-etcd-member',
                'revision': read_data(self.active)['revision'], 'version': '3.5.20'}

    def containers(self):
        items = [{'id': 'business-container-unchanged', 'metadata': {'name': 'launcher'}, 'state': 'CONTAINER_RUNNING'}]
        if move.MANIFEST.exists():
            items.append({'id': 'offline-etcd', 'metadata': {'name': 'etcd'}, 'state': 'CONTAINER_RUNNING'})
        return items

    def health(self, journal):
        self.same_mount(journal['target'] if journal['may_write'] else journal['source'])
        move.require(move.MANIFEST.exists(), 'offline etcd is stopped')
        status = self.etcd_status()
        move.require(status['revision'] >= journal['etcd']['revision'], 'offline revision went backwards')
        return status


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mx-move-transaction-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.disk_one, self.disk_two = self.root / 'one', self.root / 'two'
        self.disk_one.mkdir()
        self.disk_two.mkdir()
        self.origin = self.disk_two / 'original-etcd'
        write_data(self.origin, 10, ['before-migration'])
        self.state = self.disk_one / 'mx-move'
        self.target_root = self.state / 'etcd-data'
        self.tool = self.root / 'offline-etcdctl'
        self.tool.write_bytes(b'not executable: all subprocess calls are mocked')
        self.manifest = self.root / 'kubernetes/manifests/etcd.yaml'
        self.manifest.parent.mkdir(parents=True)
        self.manifest.write_bytes(b'kind: Pod\nmetadata:\n  name: etcd\n')
        self.fstab = self.root / 'fstab'
        self.data = self.root / 'var-lib-etcd'
        self.data.mkdir()
        self.fstab.write_text('# original\n{} {} none bind 0 0\n# unchanged\n'.format(self.origin, self.data))
        self.original_fstab = self.fstab.read_bytes()
        self.pki = self.root / 'original-pki'
        self.pki.mkdir()
        (self.pki / 'ca.crt').write_bytes(b'original-ca')
        self.host = FakeHost(self)
        self.commands = []
        self.fail_copy = False
        self.fail_verify = False

        self.patch('DATA', self.data)
        self.patch('MANIFEST', self.manifest)
        self.patch('FSTAB', self.fstab)
        self.patch('run', self.fake_run)
        self.patch('safe_path', lambda path, private=False: Path(path))
        self.patch('private_dir', lambda path: Path(path).mkdir(mode=0o700, parents=True, exist_ok=True))
        self.patch('capacity', lambda *args: {'free_gib': 300, 'required_gib': 1, 'reserve_gib': 100})
        self.patch('log', mock.Mock())
        self.patch('wait_for', self.wait_once)
        original_identity = move.directory_identity
        original_tree_bytes = move.tree_bytes

        def active_path(path):
            if Path(path) == self.data:
                move.require(self.host.active is not None, 'offline data is not mounted')
                return self.host.active
            return path

        self.patch('directory_identity', lambda path: original_identity(active_path(path)))
        self.patch('tree_bytes', lambda path: original_tree_bytes(active_path(path)))
        # SELinux metadata is a Linux production concern; fixtures have no xattrs.
        patcher = mock.patch.object(move.os, 'listxattr', return_value=[], create=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        original_copytree = shutil.copytree

        def copytree(source, target, *args, **kwargs):
            if str(source) == '/etc/kubernetes/pki':
                source = str(self.pki)
            return original_copytree(source, target, *args, **kwargs)
        patcher = mock.patch.object(move.shutil, 'copytree', side_effect=copytree)
        patcher.start()
        self.addCleanup(patcher.stop)
        original_samefile = os.path.samefile

        def samefile(left, right):
            if Path(left) == self.data:
                return self.host.active is not None and Path(right) == self.host.active
            if Path(right) == self.data:
                return self.host.active is not None and Path(left) == self.host.active
            return original_samefile(left, right)
        patcher = mock.patch.object(move.os.path, 'samefile', side_effect=samefile)
        patcher.start()
        self.addCleanup(patcher.stop)
        # boot_guard uses a fixed /etc/systemd path; never let it touch the host.
        patcher = mock.patch.object(move.Move, 'boot_guard')
        patcher.start()
        self.addCleanup(patcher.stop)
        # The installed guard and interpreter validation have separate tests;
        # this fixture only models its durable allowed-directory record.
        patcher = mock.patch.object(move.Move, 'check_boot_guard')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.transaction = move.Move(self.host, self.state)

    def patch(self, name, value):
        patcher = mock.patch.object(move, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def wait_once(test, seconds, message):
        value = test()
        move.require(bool(value), message)
        return value

    def fake_run(self, args, timeout=60):
        args = [str(arg) for arg in args]
        self.commands.append(args)
        if args[0] == 'rsync':
            source, target = Path(args[-2]), Path(args[-1])
            if source == self.data:
                source = self.host.active
            if args[1] == '-aHAX':
                if self.fail_copy:
                    raise move.Refuse('injected copy failure')
                for child in source.iterdir():
                    destination = target / child.name
                    if child.is_dir():
                        shutil.copytree(str(child), str(destination))
                    else:
                        shutil.copy2(str(child), str(destination))
                return b''
            if args[1] == '-aHAXnci':
                return b'changed file' if self.fail_verify else b''
            raise AssertionError('unexpected rsync operation')
        if args[0] == 'mount':
            self.assertEqual(args[1], '--bind')
            self.assertEqual(Path(args[3]), self.data)
            self.assertFalse(self.manifest.exists())
            self.host.active = Path(args[2])
            return b''
        if args[0] == 'umount':
            self.assertEqual(Path(args[1]), self.data)
            self.assertFalse(self.manifest.exists())
            self.host.active = None
            return b''
        if args[0] in ['sync', 'systemctl']:
            return b''
        if args[1:] == ['version'] and Path(args[0]).name == 'etcdctl':
            return b'etcdctl version: 3.5.20\n'
        raise AssertionError('unexpected host command: ' + args[0])

    def facts(self):
        return self.transaction.plan('migrate', str(self.target_root))

    def reload(self):
        transaction = move.Move(self.host, self.state)
        transaction.load()
        return transaction

    def test_plan_rejects_another_partition_on_same_physical_disk(self):
        original_disk = self.host.disk

        def shared_disk(path):
            disk = original_disk(path)
            return dict(disk, disks=['/dev/same-physical-disk'])
        with mock.patch.object(self.host, 'disk', side_effect=shared_disk):
            with self.assertRaisesRegex(move.Refuse, '同一物理盘'):
                self.facts()
        self.assertFalse(self.state.exists())
        self.assertFalse(self.commands)

    def test_prepare_rejects_target_parent_replaced_after_plan(self):
        self.target_root.mkdir(parents=True)
        facts = self.facts()
        original_parent = self.target_root.with_name('original-parent-retained')
        self.target_root.rename(original_parent)
        self.target_root.mkdir()
        with self.assertRaisesRegex(move.Refuse, 'directory identity differs'):
            self.transaction.prepare(facts)
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.host.active, self.origin)
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertFalse(self.commands)
        self.assertEqual(list(original_parent.iterdir()), [])

    def test_cold_copy_rejects_target_parent_replaced_after_prepare(self):
        self.transaction.prepare(self.facts())
        self.transaction.manifest_out()
        self.target_root.rename(self.target_root.with_name('original-parent-retained'))
        self.target_root.mkdir()
        before = len(self.commands)
        with self.assertRaisesRegex(move.Refuse, 'directory identity differs'):
            self.transaction.cold_copy()
        self.assertEqual(len(self.commands), before)
        self.assertEqual(list(self.target_root.iterdir()), [])
        self.assertEqual(self.host.active, self.origin)
        self.transaction.recover()
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.transaction.j['phase'], 'aborted')

    def test_source_path_rename_during_copy_cannot_substitute_replacement_data(self):
        self.transaction.prepare(self.facts())
        self.transaction.manifest_out()
        moved_source = self.origin.with_name('original-directory-renamed')
        real_run = self.fake_run
        renamed = [False]

        def rename_before_copy(args, timeout=60):
            if args[:2] == ['rsync', '-aHAX'] and not renamed[0]:
                renamed[0] = True
                self.assertEqual(Path(args[-2]), self.data)
                self.origin.rename(moved_source)
                # Model the established bind remaining attached to its inode.
                self.host.active = moved_source
                write_data(self.origin, 999, ['replacement-must-never-be-copied'])
            return real_run(args, timeout)

        with mock.patch.object(move, 'run', side_effect=rename_before_copy):
            with self.assertRaisesRegex(move.Refuse, 'mount identity differs'):
                self.transaction.cold_copy()
        copied = Path(self.transaction.j['target'])
        self.assertEqual(read_data(copied), read_data(moved_source))
        self.assertEqual(read_data(copied)['revision'], 10)
        self.assertEqual(read_data(self.origin)['revision'], 999)
        self.assertEqual(self.host.active, moved_source)
        self.assertFalse(self.manifest.exists())
        self.assertFalse([args for args in self.commands if args[0] in ['mount', 'umount']])
        # Recovery must refuse that same pathname now pointing at another inode.
        with self.assertRaisesRegex(move.Refuse, 'directory identity differs'):
            self.transaction.recover()
        self.assertFalse(self.manifest.exists())

    def test_source_replaced_after_snapshot_is_rejected_before_stopping_etcd(self):
        self.transaction.prepare(self.facts())
        before_manifest = self.manifest.read_bytes()
        moved_source = self.origin.with_name('original-running-directory')
        self.origin.rename(moved_source)
        # Existing bind and running etcd retain the original inode while the
        # canonical fstab source now names a replacement directory.
        self.host.active = moved_source
        write_data(self.origin, 999, ['replacement-after-online-snapshot'])
        before_commands = len(self.commands)
        with mock.patch.object(self.transaction, 'manifest_out', wraps=self.transaction.manifest_out) as stop:
            with self.assertRaisesRegex(move.Refuse, 'directory identity differs'):
                self.transaction.switch()
            stop.assert_not_called()
        self.assertEqual(self.manifest.read_bytes(), before_manifest)
        self.assertFalse(Path(self.transaction.j['held']).exists())
        self.assertFalse(Path(self.transaction.j['target']).exists())
        self.assertEqual(self.transaction.j['phase'], 'prepared')
        self.assertFalse(self.transaction.j['may_write'])
        self.assertEqual(len(self.commands), before_commands)
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertEqual(read_data(self.host.active)['revision'], 10)
        self.assertEqual(read_data(self.origin)['revision'], 999)
        self.assertTrue((Path(self.transaction.j['run']) / 'snapshot.db').is_file())

    def assert_guard_allows_only(self, side):
        journal = self.transaction.j
        record = move.read_json(self.state / 'active-etcd.json')
        self.assertEqual(record['data'], str(self.data))
        self.assertEqual(record['allowed'], [{'uuid': journal[side + '_disk']['uuid'],
                                             'inode': journal[side + '_identity']['inode']}])

    def test_manifest_start_has_only_target_authorized_by_boot_guard(self):
        real_manifest_in = self.transaction.manifest_in
        starts = []

        def guarded_start():
            self.assertTrue(self.transaction.j['may_write'])
            self.assert_guard_allows_only('target')
            self.assertFalse(self.manifest.exists())
            starts.append('target')
            real_manifest_in()

        with mock.patch.object(self.transaction, 'manifest_in', side_effect=guarded_start):
            self.transaction.execute(self.facts())
        self.assertEqual(starts, ['target'])
        self.assert_guard_allows_only('target')

    def test_abort_restores_only_source_in_boot_guard_before_manifest_start(self):
        self.fail_verify = True
        real_manifest_in = self.transaction.manifest_in
        starts = []

        def guarded_start():
            self.assertFalse(self.transaction.j['may_write'])
            self.assert_guard_allows_only('source')
            self.assertFalse(self.manifest.exists())
            starts.append('source')
            real_manifest_in()

        with mock.patch.object(self.transaction, 'manifest_in', side_effect=guarded_start):
            with self.assertRaises(move.Refuse):
                self.transaction.execute(self.facts())
        self.assertEqual(starts, ['source'])
        self.assertEqual(self.transaction.j['phase'], 'aborted')
        self.assert_guard_allows_only('source')

    def test_guard_write_failure_after_commit_does_not_start_or_revert_old_data(self):
        real_save = move.save_json
        failed = [False]

        def fail_target_guard(path, value):
            if (Path(path).name == 'active-etcd.json' and self.transaction.j.get('may_write')
                    and len(value['allowed']) == 1 and not failed[0]):
                failed[0] = True
                raise OSError('injected guard update failure')
            return real_save(path, value)

        with mock.patch.object(move, 'save_json', side_effect=fail_target_guard):
            with self.assertRaisesRegex(OSError, 'guard update failure'):
                self.transaction.execute(self.facts())
        target = self.host.active
        self.assertNotEqual(target, self.origin)
        self.assertTrue(self.transaction.j['may_write'])
        self.assertFalse(self.manifest.exists())
        resumed = self.reload()
        resumed.recover()
        self.assertEqual(self.host.active, target)
        self.assertEqual(resumed.j['phase'], 'complete')
        self.assertTrue(self.manifest.exists())
        self.assert_guard_allows_only('target')

    def test_mount_to_rejects_live_process_or_existing_manifest_before_any_command(self):
        self.transaction.prepare(self.facts())
        self.commands[:] = []
        for stopped, manifest_present in [(False, False), (True, True)]:
            with self.subTest(stopped=stopped, manifest_present=manifest_present):
                if manifest_present:
                    self.manifest.write_bytes(b'present')
                elif self.manifest.exists():
                    self.manifest.unlink()
                with mock.patch.object(self.host, 'stopped', return_value=stopped):
                    with self.assertRaisesRegex(move.Refuse, '禁止切换挂载'):
                        self.transaction.mount_to(self.origin, self.host.disk(self.origin))
                self.assertFalse(self.commands)

    def test_copy_failure_restores_manifest_without_switching_mount_or_data(self):
        self.fail_copy = True
        with self.assertRaisesRegex(move.Refuse, 'copy failure'):
            self.transaction.execute(self.facts())
        self.assertEqual(self.transaction.j['phase'], 'aborted')
        self.assertFalse(self.transaction.j['may_write'])
        self.assertEqual(self.host.active, self.origin)
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertTrue(self.manifest.exists())
        self.assertFalse([args for args in self.commands if args[0] in ['mount', 'umount']])
        self.assertEqual(read_data(self.origin)['revision'], 10)
        self.assertTrue(Path(self.transaction.j['target']).is_dir())
        self.assertTrue((Path(self.transaction.j['run']) / 'snapshot.db').exists())

    def test_snapshot_fetch_failure_leaves_manifest_running_and_never_starts_switch(self):
        with mock.patch.object(self.host, 'ctl', side_effect=move.Refuse('injected online snapshot failure')), \
                mock.patch.object(self.transaction, 'manifest_out') as stop:
            with self.assertRaisesRegex(move.Refuse, 'online snapshot failure'):
                self.transaction.execute(self.facts())
            stop.assert_not_called()
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.host.active, self.origin)
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertFalse([args for args in self.commands if args[0] in ['mount', 'umount', 'rsync']])

    def test_snapshot_integrity_failure_leaves_manifest_running_and_never_starts_switch(self):
        def corrupt_snapshot(*args):
            body = bytes(512)
            Path(args[2]).write_bytes(body + bytes(32))
            return b''

        with mock.patch.object(self.host, 'ctl', side_effect=corrupt_snapshot), \
                mock.patch.object(self.transaction, 'manifest_out') as stop:
            with self.assertRaisesRegex(move.Refuse, 'SHA256'):
                self.transaction.execute(self.facts())
            stop.assert_not_called()
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.host.active, self.origin)
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertFalse([args for args in self.commands if args[0] in ['mount', 'umount', 'rsync']])

    def test_copy_verification_failure_never_switches_mount(self):
        self.fail_verify = True
        with self.assertRaises(move.Refuse):
            self.transaction.execute(self.facts())
        self.assertEqual(self.host.active, self.origin)
        self.assertEqual(self.transaction.j['phase'], 'aborted')
        self.assertFalse([args for args in self.commands if args[0] in ['mount', 'umount']])

    def test_stop_timeout_restores_original_manifest_without_requiring_etcd_to_stop(self):
        with mock.patch.object(self.host, 'stopped', return_value=False):
            with self.assertRaisesRegex(move.Refuse, 'etcd 未停止'):
                self.transaction.execute(self.facts())
        self.assertEqual(self.transaction.j['phase'], 'aborted')
        self.assertFalse(self.transaction.j['may_write'])
        self.assertTrue(self.manifest.exists())
        self.assertFalse(Path(self.transaction.j['held']).exists())
        self.assertFalse(Path(self.transaction.j['target']).exists())
        self.assertEqual(self.host.active, self.origin)
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertFalse([args for args in self.commands if args[0] in ['mount', 'umount', 'rsync']])

    def test_bind_failure_after_unmount_recovers_source_before_starting_etcd(self):
        real_run = self.fake_run
        failed = [False]

        def fail_first_bind(args, timeout=60):
            if args[0] == 'mount' and not failed[0]:
                failed[0] = True
                self.assertIsNone(self.host.active)
                self.assertFalse(self.manifest.exists())
                raise move.Refuse('injected target bind failure')
            return real_run(args, timeout)

        with mock.patch.object(move, 'run', side_effect=fail_first_bind):
            with self.assertRaisesRegex(move.Refuse, 'target bind failure'):
                self.transaction.execute(self.facts())
        self.assertEqual(self.transaction.j['phase'], 'aborted')
        self.assertEqual(self.host.active, self.origin)
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)

    def test_identity_reconcile_failure_before_write_boundary_recovers_original_mount(self):
        real_helper = self.host.helper
        failed = [False]

        def fail_first_reconcile(action, journal):
            if action == 'reconcile' and not failed[0]:
                failed[0] = True
                self.assertNotEqual(self.host.active, self.origin)
                self.assertFalse(self.manifest.exists())
                raise move.Refuse('injected identity reconciliation failure')
            return real_helper(action, journal)

        with mock.patch.object(self.host, 'helper', side_effect=fail_first_reconcile):
            with self.assertRaisesRegex(move.Refuse, 'identity reconciliation failure'):
                self.transaction.execute(self.facts())
        self.assertEqual(self.transaction.j['phase'], 'aborted')
        self.assertFalse(self.transaction.j['may_write'])
        self.assertEqual(self.host.active, self.origin)
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)

    def test_before_durable_may_write_failure_resumes_old_authoritative_data(self):
        real_save = move.save_json
        failed = [False]

        def fail_before_run_journal(path, value):
            if Path(path).name == 'journal.json' and value.get('may_write') and not failed[0]:
                failed[0] = True
                raise OSError('injected before write-ahead commit')
            return real_save(path, value)

        with mock.patch.object(move, 'save_json', side_effect=fail_before_run_journal):
            with self.assertRaises(OSError):
                self.transaction.execute(self.facts())
        self.assertTrue(self.transaction.j['may_write'])  # memory is intentionally not the recovery authority
        self.assertFalse(self.manifest.exists())
        resumed = self.reload()
        self.assertFalse(resumed.j['may_write'])
        resumed.recover()
        self.assertEqual(resumed.j['phase'], 'aborted')
        self.assertEqual(self.host.active, self.origin)
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)

    def test_after_durable_may_write_but_before_pointer_update_resumes_new_generation(self):
        real_save = move.save_json
        failed = [False]

        def fail_pointer(path, value):
            if Path(path) == self.transaction.current_file and value.get('may_write') and not failed[0]:
                failed[0] = True
                raise OSError('injected after write-ahead commit')
            return real_save(path, value)

        with mock.patch.object(move, 'save_json', side_effect=fail_pointer):
            with self.assertRaises(OSError):
                self.transaction.execute(self.facts())
        self.assertFalse(move.read_json(self.transaction.current_file)['may_write'])
        self.assertTrue(move.read_json(Path(self.transaction.j['run']) / 'journal.json')['may_write'])
        self.assertFalse(self.manifest.exists())
        resumed = self.reload()
        self.assertTrue(resumed.j['may_write'])
        target = self.host.active
        with mock.patch.object(resumed, 'manifest_out', side_effect=AssertionError('must not stop authority')), \
                mock.patch.object(resumed, 'cold_copy', side_effect=AssertionError('must not copy stale source')), \
                mock.patch.object(resumed, 'mount_to', side_effect=AssertionError('must not replace authority')):
            resumed.recover()
        self.assertEqual(resumed.j['phase'], 'complete')
        self.assertEqual(self.host.active, target)
        self.assertNotEqual(target, self.origin)
        self.assertTrue(self.manifest.exists())

    def test_failure_after_start_keeps_new_writes_and_never_auto_rolls_back(self):
        def fail_finish():
            self.assertTrue(self.manifest.exists())
            write_data(self.host.active, 11, ['before-migration', 'committed-after-start'])
            raise move.Refuse('injected health check failure after commit')

        with mock.patch.object(self.transaction, 'finish', side_effect=fail_finish):
            with self.assertRaisesRegex(move.Refuse, 'health check failure'):
                self.transaction.execute(self.facts())
        target = self.host.active
        self.assertTrue(self.transaction.j['may_write'])
        self.assertEqual(read_data(self.origin)['revision'], 10)
        resumed = self.reload()
        resumed.recover()
        self.assertEqual(self.host.active, target)
        self.assertEqual(read_data(target)['revision'], 11)
        self.assertEqual(resumed.j['final_etcd']['revision'], 11)

    def test_launcher_acceptance_failure_keeps_target_until_baseline_is_verified(self):
        baseline = self.host.launcher_check()
        changed = dict(baseline, login_config={'enabled': False})
        with mock.patch.object(self.host, 'launcher_check', side_effect=[baseline, changed]):
            with self.assertRaisesRegex(move.Refuse, 'Launcher'):
                self.transaction.execute(self.facts())
        target = self.host.active
        self.assertNotEqual(target, self.origin)
        self.assertTrue(self.transaction.j['may_write'])
        self.assertNotEqual(self.transaction.j['phase'], 'complete')
        resumed = self.reload()
        resumed.recover()
        self.assertEqual(resumed.j['phase'], 'complete')
        self.assertEqual(self.host.active, target)

    def test_nonrenewing_leases_block_success_without_reverting_authoritative_data(self):
        with mock.patch.object(self.host, 'leases', return_value={'controller': 1, 'scheduler': 1}):
            with self.assertRaisesRegex(move.Refuse, 'lease'):
                self.transaction.execute(self.facts())
        target = self.host.active
        self.assertNotEqual(target, self.origin)
        self.assertTrue(self.transaction.j['may_write'])
        self.assertNotEqual(self.transaction.j['phase'], 'complete')
        self.host.lease_revision = 1
        resumed = self.reload()
        resumed.recover()
        self.assertEqual(resumed.j['phase'], 'complete')
        self.assertEqual(self.host.active, target)

    def test_migrate_then_new_data_then_rollback_copies_latest_to_fresh_old_disk_generation(self):
        self.transaction.execute(self.facts())
        first = copy.deepcopy(self.transaction.j)
        migrated = self.host.active
        self.assertEqual(first['phase'], 'complete')
        self.assertEqual(self.host.disk(migrated)['uuid'], 'disk-one-uuid')
        write_data(migrated, 18, ['before-migration', 'new-login-state', 'new-secret', 'new-service'])
        rollback = move.Move(self.host, self.state)
        rollback_facts = rollback.plan('rollback', str(self.target_root))
        self.assertEqual(rollback_facts['source'], str(migrated))
        rollback.execute(rollback_facts)
        rolled_back = self.host.active
        self.assertEqual(rollback.j['direction'], 'rollback')
        self.assertEqual(rollback.j['phase'], 'complete')
        self.assertEqual(self.host.disk(rolled_back)['uuid'], 'disk-two-uuid')
        self.assertNotEqual(rolled_back, self.origin)
        self.assertEqual(read_data(rolled_back), read_data(migrated))
        self.assertEqual(read_data(rolled_back)['revision'], 18)
        self.assertEqual(read_data(self.origin), {'revision': 10, 'values': ['before-migration']})
        self.assertTrue(migrated.exists())
        self.assertTrue(self.origin.exists())
        self.assertEqual(rollback.j['changed_business_containers'], [])
        self.assertIn(str(rolled_back).encode(), self.fstab.read_bytes())
        self.assertNotIn(str(self.origin).encode(), self.fstab.read_bytes())
        self.assertTrue((Path(first['run']) / 'snapshot.db').exists())
        self.assertTrue((Path(rollback.j['run']) / 'snapshot.db').exists())

    def assert_plan_preserves_discovered_tool(self, direction):
        live_tool = self.root / 'current-container-etcdctl'
        live_tool.write_bytes(b'new live matching version; must not use historical binary')
        real_discover = self.host.discover

        def discover_current_tool():
            facts = real_discover()
            self.host.etcdctl = str(live_tool)
            return facts

        next_move = move.Move(self.host, self.state)
        with mock.patch.object(self.host, 'discover', side_effect=discover_current_tool):
            facts = next_move.plan(direction, str(self.target_root))
        self.assertEqual(self.host.etcdctl, str(live_tool))
        next_move.prepare(facts)
        self.assertEqual((Path(next_move.j['run']) / 'etcdctl').read_bytes(), live_tool.read_bytes())

    def test_rollback_plan_keeps_current_discovered_etcdctl_after_loading_old_journal(self):
        self.transaction.execute(self.facts())
        self.assert_plan_preserves_discovered_tool('rollback')

    def test_retry_plan_keeps_current_discovered_etcdctl_after_loading_aborted_journal(self):
        self.fail_copy = True
        with self.assertRaises(move.Refuse):
            self.transaction.execute(self.facts())
        self.fail_copy = False
        self.assert_plan_preserves_discovered_tool('migrate')

    def test_failed_rollback_can_retry_latest_one_tb_data_without_overwriting_any_history(self):
        self.transaction.execute(self.facts())
        migrated = self.host.active
        write_data(migrated, 20, ['before-migration', 'committed-on-one-tb'])
        rollback = move.Move(self.host, self.state)
        self.fail_copy = True
        with self.assertRaisesRegex(move.Refuse, 'copy failure'):
            rollback.execute(rollback.plan('rollback', str(self.target_root)))
        self.fail_copy = False
        failed_generation = Path(rollback.j['target'])
        self.assertEqual(rollback.j['phase'], 'aborted')
        self.assertEqual(rollback.j['direction'], 'rollback')
        self.assertFalse(rollback.j['may_write'])
        self.assertEqual(self.host.active, migrated)
        self.assertTrue(failed_generation.is_dir())
        self.assertEqual(list(failed_generation.iterdir()), [])
        self.assertTrue(self.manifest.exists())
        # Service continues on the 1T copy after safe abort, so retries must copy
        # these subsequent writes too, not the failed rollback's snapshot.
        write_data(migrated, 24, ['before-migration', 'committed-on-one-tb', 'committed-after-rollback-abort'])
        retry = move.Move(self.host, self.state)
        with self.assertRaisesRegex(move.Refuse, '重试 rollback'):
            retry.plan('migrate', str(self.target_root))
        facts = retry.plan('rollback', str(self.target_root))
        self.assertEqual(facts['source'], str(migrated))
        self.assertEqual(facts['etcd']['revision'], 24)
        retry.execute(facts)
        active = self.host.active
        self.assertEqual(retry.j['phase'], 'complete')
        self.assertEqual(retry.j['direction'], 'rollback')
        self.assertEqual(self.host.disk(active)['uuid'], 'disk-two-uuid')
        self.assertNotIn(active, [self.origin, migrated, failed_generation])
        self.assertEqual(read_data(active), read_data(migrated))
        self.assertEqual(read_data(active)['revision'], 24)
        self.assertEqual(read_data(self.origin), {'revision': 10, 'values': ['before-migration']})
        self.assertEqual(list(failed_generation.iterdir()), [])
        self.assertTrue(migrated.exists())
        self.assertTrue((Path(rollback.j['run']) / 'snapshot.db').exists())
        self.assertTrue((Path(retry.j['run']) / 'snapshot.db').exists())

    def test_rollback_after_failed_switch_recopies_new_writes_into_a_fresh_generation(self):
        self.transaction.execute(self.facts())
        migrated = self.host.active
        write_data(migrated, 20, ['written-on-one-tb'])
        rollback = move.Move(self.host, self.state)
        real_helper = self.host.helper
        failed = [False]

        def fail_after_rollback_mount(action, journal):
            if (action == 'reconcile' and not failed[0] and
                    self.host.disk(self.host.active)['uuid'] == 'disk-two-uuid'):
                failed[0] = True
                raise move.Refuse('injected rollback acceptance before write')
            return real_helper(action, journal)

        with mock.patch.object(self.host, 'helper', side_effect=fail_after_rollback_mount):
            with self.assertRaisesRegex(move.Refuse, 'rollback acceptance before write'):
                rollback.execute(rollback.plan('rollback', str(self.target_root)))
        failed_generation = Path(rollback.j['target'])
        self.assertEqual(rollback.j['phase'], 'aborted')
        self.assertEqual(self.host.active, migrated)
        self.assertEqual(read_data(failed_generation)['revision'], 20)
        write_data(migrated, 27, ['written-on-one-tb', 'written-after-failed-switch'])
        retry = move.Move(self.host, self.state)
        retry.execute(retry.plan('rollback', str(self.target_root)))
        self.assertEqual(retry.j['phase'], 'complete')
        self.assertEqual(read_data(self.host.active)['revision'], 27)
        self.assertEqual(read_data(failed_generation)['revision'], 20)
        self.assertEqual(read_data(self.origin)['revision'], 10)
        self.assertNotIn(self.host.active, [failed_generation, self.origin, migrated])
        record = move.read_json(self.state / 'active-etcd.json')
        self.assertEqual(record['allowed'], [{'uuid': 'disk-two-uuid',
                                             'inode': retry.j['target_identity']['inode']}])

    def test_concurrent_fstab_edit_is_never_overwritten(self):
        self.transaction.prepare(self.facts())
        modified = self.fstab.read_bytes() + b'# unrelated new operator change\n'
        self.fstab.write_bytes(modified)
        with self.assertRaisesRegex(move.Refuse, '其他进程修改'):
            self.transaction.fstab_to(True)
        self.assertEqual(self.fstab.read_bytes(), modified)

    def test_mount_override_after_prepare_is_rejected_before_stopping_etcd(self):
        self.transaction.prepare(self.facts())
        before = len(self.commands)
        with mock.patch.object(self.host, 'persistent_mount', side_effect=move.Refuse('mount override')):
            with self.assertRaisesRegex(move.Refuse, 'mount override'):
                self.transaction.switch()
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.host.active, self.origin)
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertEqual(len(self.commands), before)

    def test_failed_generated_mount_update_restores_source_before_allowing_writes(self):
        real_check = self.host.persistent_mount

        def reject_target(source):
            real_check(source)
            if str(source) != str(self.origin):
                raise move.Refuse('generator retained old source')

        with mock.patch.object(self.host, 'persistent_mount', side_effect=reject_target):
            with self.assertRaisesRegex(move.Refuse, 'generator retained old source'):
                self.transaction.execute(self.facts())
        self.assertEqual(self.transaction.j['phase'], 'aborted')
        self.assertFalse(self.transaction.j['may_write'])
        self.assertEqual(self.host.active, self.origin)
        self.assertTrue(self.manifest.exists())
        self.assertEqual(self.fstab.read_bytes(), self.original_fstab)
        self.assertFalse(any(command[0] == 'umount' for command in self.commands))

    def test_mount_check_failure_after_write_boundary_never_returns_to_old_data(self):
        real_check = self.host.persistent_mount

        def reject_release(source):
            real_check(source)
            if self.transaction.j['may_write']:
                raise move.Refuse('new mount override before manifest release')

        with mock.patch.object(self.host, 'persistent_mount', side_effect=reject_release):
            with self.assertRaisesRegex(move.Refuse, 'new mount override'):
                self.transaction.execute(self.facts())
        target = Path(self.transaction.j['target'])
        self.assertEqual(self.host.active, target)
        self.assertTrue(self.transaction.j['may_write'])
        self.assertFalse(self.manifest.exists())
        write_data(target, 25, ['latest-target-state'])
        self.reload().recover()
        self.assertEqual(self.host.active, target)
        self.assertEqual(read_data(target)['revision'], 25)
        self.assertEqual(read_data(self.origin)['revision'], 10)
        self.assertTrue(self.manifest.exists())


if __name__ == '__main__':
    unittest.main()
