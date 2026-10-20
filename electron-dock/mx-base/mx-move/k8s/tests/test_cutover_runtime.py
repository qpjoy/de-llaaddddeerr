import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
import cutover_runtime as runtime
import storage_guard


class PGTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / 'global').mkdir()
        (self.root / 'pg_tblspc').mkdir()
        (self.root / 'pg_wal').mkdir()

    def fixture(self, version='16', state=1, control_version=None, size=8192):
        (self.root / 'PG_VERSION').write_text(version + '\n')
        control_version = control_version if control_version is not None else {'16': 1300, '17': 1700}[version]
        prefix = struct.pack('<QIII', 7653890798239166499, control_version, 202307071, state)
        raw = (prefix + b'\0' * 8192)[:size]
        (self.root / 'global/pg_control').write_bytes(raw)
        return {'version': version, 'control_first8_hex': prefix[:8].hex()}, raw

    def test_clean_pg16_and_pg17_return_full_control_digest(self):
        for version in ('16', '17'):
            with self.subTest(version=version):
                expected, raw = self.fixture(version)
                self.assertEqual(runtime.pg_shutdown(self.root, expected), hashlib.sha256(raw).hexdigest())

    def test_running_recovery_shutdowning_or_unknown_state_refuse(self):
        for state in (0, 2, 3, 4, 5, 6, 99):
            with self.subTest(state=state):
                expected, _ = self.fixture(state=state)
                with self.assertRaises(runtime.prep.Refuse): runtime.pg_shutdown(self.root, expected)

    def test_wrong_control_version_and_truncated_file_refuse(self):
        for kwargs in ({'control_version': 1700}, {'version': '17', 'control_version': 1300}, {'size': 20}, {'size': 8191}):
            with self.subTest(kwargs=kwargs):
                expected, _ = self.fixture(**kwargs)
                with self.assertRaises(runtime.prep.Refuse): runtime.pg_shutdown(self.root, expected)

    def test_postmaster_pid_even_dangling_symlink_refuses(self):
        expected, _ = self.fixture()
        pid = self.root / 'postmaster.pid'
        pid.write_text('123')
        with self.assertRaises(runtime.prep.Refuse): runtime.pg_shutdown(self.root, expected)
        pid.unlink(); pid.symlink_to(self.root / 'missing')
        with self.assertRaises(runtime.prep.Refuse): runtime.pg_shutdown(self.root, expected)

    def test_identifier_and_architecture_mismatch_refuse(self):
        expected, _ = self.fixture()
        with self.assertRaises(runtime.prep.Refuse): runtime.pg_shutdown(self.root, dict(expected, control_first8_hex='f' * 16))
        with mock.patch.object(runtime.sys, 'byteorder', 'big'):
            with self.assertRaises(runtime.prep.Refuse): runtime.pg_shutdown(self.root, expected)

    def test_external_wal_and_tablespaces_refuse(self):
        expected, _ = self.fixture()
        (self.root / 'pg_wal').rmdir(); (self.root / 'pg_wal').symlink_to('/other/wal')
        with self.assertRaises(storage_guard.StorageError): runtime.pg_shutdown(self.root, expected)
        (self.root / 'pg_wal').unlink(); (self.root / 'pg_wal').mkdir()
        (self.root / 'pg_tblspc/1').symlink_to('/other/table')
        with self.assertRaises(storage_guard.StorageError): runtime.pg_shutdown(self.root, expected)


class FakeHost:
    def __init__(self):
        self.calls = []
        self.pods = []
        self.containers = []
        self.pod_containers = {}
        self.leftovers = {}
        self.tasks = {}

    def run(self, args, timeout=60):
        self.calls.append(args)
        if args[0] == 'systemctl':
            assert args == ['systemctl', 'stop', 'kubelet.service']
            return b''
        if args[0] == 'ctr':
            return self.tasks.get(args[2], b'TASK PID STATUS\n')
        assert args[0] == 'crictl'
        address = args[1].split('unix://', 1)[1]
        assert args[2] == '--image-endpoint=unix://' + address
        assert args[3] == '--timeout=120s'
        command = args[4:]
        if command == ['pods', '-o', 'json']:
            return json.dumps({'items': self.pods}).encode()
        if command == ['ps', '-a', '-o', 'json']:
            return json.dumps({'containers': self.containers}).encode()
        if len(command) == 6 and command[:3] == ['ps', '-a', '--pod'] and command[4:] == ['-o', 'json']:
            return json.dumps({'containers': self.pod_containers.get(command[3], [])}).encode()
        if command[0] == 'stop':
            assert address == runtime.OLD
            assert len(command) == 3 and command[1] == '--timeout=60'
            return b''
        if command[0] in ('stopp', 'rmp', 'rm'):
            assert address == runtime.OLD
            assert len(command) == 2
            return b''
        return self.leftovers.get((address, command[0]), b'')

    def wait(self, predicate, seconds, label):
        predicate()


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.host = FakeHost()
        self.runtime = runtime.Runtime(self.host)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.proc = Path(self.tmp.name)
        self.patch = mock.patch.object(runtime, 'PROC', self.proc)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.services = {'kubelet': {'ActiveState': 'inactive', 'MainPID': '0'},
                         'mx-k8s-containerd': {'ActiveState': 'active', 'MainPID': '10'}}
        self.service = mock.patch.object(runtime.probe.RuntimeInspector, 'service', side_effect=lambda name: self.services[name])
        self.service.start(); self.addCleanup(self.service.stop)

    def process(self, pid='1234', argv=b'', fd_name=None, flags='0100000', maps='', cwd='/safe', root='/'):
        proc = self.proc / pid; proc.mkdir()
        (proc / 'cmdline').write_bytes(argv)
        (proc / 'fd').mkdir(); (proc / 'fdinfo').mkdir()
        (proc / 'cwd').symlink_to(cwd); (proc / 'root').symlink_to(root)
        (proc / 'maps').write_text(maps)
        if fd_name:
            (proc / 'fd/7').symlink_to(fd_name)
            (proc / 'fdinfo/7').write_text('pos:\t0\nflags:\t' + flags + '\nmnt_id:\t1\n')
        return proc

    def test_assert_stopped_checks_both_cri_namespaces_and_task_sets(self):
        self.runtime.assert_stopped()
        commands = [tuple(a[1:]) for a in self.host.calls if a[0] == 'crictl']
        for address in (runtime.OLD, runtime.NEW):
            prefix = ('--runtime-endpoint=unix://' + address, '--image-endpoint=unix://' + address, '--timeout=120s')
            self.assertIn(prefix + ('pods', '-q'), commands)
            self.assertIn(prefix + ('ps', '-a', '-q'), commands)

    def test_new_or_old_stopped_container_sandbox_and_task_refuse(self):
        for address in (runtime.OLD, runtime.NEW):
            for kind in ('pods', 'ps', 'tasks'):
                with self.subTest(address=address, kind=kind):
                    self.host.leftovers.clear(); self.host.tasks.clear()
                    if kind == 'tasks': self.host.tasks[address] = b'TASK PID STATUS\nid 10 STOPPED\n'
                    else: self.host.leftovers[(address, kind)] = b'remaining-id\n'
                    with self.assertRaises(runtime.prep.Refuse): self.runtime.assert_stopped()

    def test_task_identity_and_state_survive_pid_change_but_not_container_change(self):
        self.host.tasks[runtime.OLD] = b'TASK    PID STATUS\nsecond 42 RUNNING\nfirst 12 PAUSED\n'
        before = self.runtime.tasks(runtime.OLD, 'moby')
        self.host.tasks[runtime.OLD] = b'\nTASK PID STATUS\nfirst 100 PAUSED\nsecond 999 RUNNING\n'
        self.assertEqual(before, self.runtime.tasks(runtime.OLD, 'moby'))
        self.assertEqual(before, ['first PAUSED', 'second RUNNING'])
        for raw in (b'TASK PID STATUS\nfirst 100 RUNNING\nsecond 999 RUNNING\n',
                    b'TASK PID STATUS\nfirst 100 PAUSED\nthird 999 RUNNING\n'):
            self.host.tasks[runtime.OLD] = raw
            self.assertNotEqual(before, self.runtime.tasks(runtime.OLD, 'moby'))

    def test_malformed_or_duplicate_task_tables_refuse(self):
        for raw in (b'TASK STATUS PID\n', b'TASK PID STATUS\nid bad RUNNING\n',
                    b'TASK PID STATUS\nid 12 INVALID\n', b'TASK PID STATUS\nid 12 RUNNING extra\n',
                    b'TASK PID STATUS\nid 12 RUNNING\nid 13 RUNNING\n'):
            self.host.tasks[runtime.OLD] = raw
            with self.subTest(raw=raw):
                with self.assertRaises((ValueError, runtime.prep.Refuse)): self.runtime.tasks(runtime.OLD)

    def test_reboot_blocked_candidate_without_socket_skips_only_new_rpc(self):
        for state in ('inactive', 'failed'):
            self.services['mx-k8s-containerd'] = {'ActiveState': state, 'MainPID': '0'}
            self.host.calls.clear()
            with mock.patch.object(runtime.os, 'lstat', side_effect=FileNotFoundError()):
                self.runtime.assert_stopped()
            calls = [a for a in self.host.calls if a[0] in ('ctr', 'crictl')]
            self.assertEqual(len(calls), 3)
            self.assertTrue(all(runtime.NEW not in ' '.join(a) for a in calls))
            self.assertTrue(all(runtime.OLD in ' '.join(a) for a in calls))

    def test_offline_candidate_still_refuses_orphan_shim_and_host_writer(self):
        self.services['mx-k8s-containerd'] = {'ActiveState': 'failed', 'MainPID': '0'}
        proc = self.process(argv=b'/usr/bin/containerd-shim-runc-v2\0-namespace\0k8s.io\0', fd_name='/selected/file', flags='0100002')
        with mock.patch.object(runtime.os, 'lstat', side_effect=FileNotFoundError()):
            with self.assertRaises(runtime.prep.Refuse): self.runtime.assert_stopped()
            (proc / 'cmdline').write_bytes(b'/usr/bin/postgres\0')
            with self.assertRaises(runtime.prep.Refuse):
                self.runtime.check_cold([{'logical': '/selected', 'source': '/source', 'key': 'other'}])

    def test_active_transitional_or_pid_nonzero_candidate_cannot_skip_rpc(self):
        for state, pid in (('active', '10'), ('activating', '0'), ('deactivating', '0'), ('failed', '22'), ('unknown', '0')):
            self.services['mx-k8s-containerd'] = {'ActiveState': state, 'MainPID': pid}
            self.host.leftovers[(runtime.NEW, 'pods')] = b'orphan\n'
            with self.subTest(state=state, pid=pid):
                with mock.patch.object(runtime.os, 'lstat', side_effect=FileNotFoundError()):
                    with self.assertRaises(runtime.prep.Refuse): self.runtime.assert_stopped()

    def test_stale_socket_or_permission_failure_cannot_skip_rpc(self):
        self.services['mx-k8s-containerd'] = {'ActiveState': 'inactive', 'MainPID': '0'}
        self.host.leftovers[(runtime.NEW, 'pods')] = b'orphan\n'
        with mock.patch.object(runtime.os, 'lstat', return_value=object()):
            with self.assertRaises(runtime.prep.Refuse): self.runtime.assert_stopped()
        with mock.patch.object(runtime.os, 'lstat', side_effect=PermissionError()):
            with self.assertRaises(PermissionError): self.runtime.assert_stopped()

    def test_offline_candidate_never_skips_unreachable_old_runtime(self):
        self.services['mx-k8s-containerd'] = {'ActiveState': 'failed', 'MainPID': '0'}
        with mock.patch.object(self.host, 'run', side_effect=runtime.prep.Refuse('unreachable old runtime')):
            with self.assertRaises(runtime.prep.Refuse): self.runtime.assert_stopped()

    def test_running_kubelet_refuses_before_runtime_calls(self):
        with mock.patch.object(runtime.probe.RuntimeInspector, 'service', return_value={'ActiveState': 'active', 'MainPID': '42'}):
            with self.assertRaises(runtime.prep.Refuse): self.runtime.assert_stopped()
        self.assertEqual(self.host.calls, [])

    def test_shim_equal_flags_debug_flags_missing_address_still_refuse(self):
        examples = [b'/usr/bin/containerd-shim-runc-v2\0-debug\0-namespace\0k8s.io\0-address\0' + runtime.OLD.encode(),
                    b'/usr/bin/containerd-shim-runc-v2\0--namespace=k8s.io\0-address=' + runtime.NEW.encode(),
                    b'/usr/bin/containerd-shim-runc-v2\0-namespace\0k8s.io\0',
                    b'/usr/bin/containerd-shim-runc-v2\0-namespace\0',
                    b'/usr/bin/containerd-shim-runc-v2\0-namespace\0moby\0--namespace=k8s.io\0']
        proc = self.process()
        for argv in examples:
            with self.subTest(argv=argv):
                (proc / 'cmdline').write_bytes(argv)
                with self.assertRaises(runtime.prep.Refuse): self.runtime.assert_stopped()

    def test_moby_shim_and_non_utf8_other_process_are_not_stopped(self):
        self.process(argv=b'/usr/bin/containerd-shim-runc-v2\0-debug\0-namespace=moby\0')
        self.process(pid='2345', argv=b'/usr/bin/app\0\xff\0')
        self.runtime.assert_stopped()
        self.assertFalse(any('stop' in a or 'kill' in a for a in self.host.calls))

    def test_stop_order_apps_network_controllers_apiserver_etcd(self):
        names = [('etcd-node', 'kube-system'), ('kube-apiserver-node', 'kube-system'),
                 ('kube-scheduler-node', 'kube-system'), ('kube-controller-manager-node', 'kube-system'),
                 ('kube-proxy-x', 'kube-system'), ('flannel-x', 'kube-flannel'), ('application', 'app')]
        self.host.pods = [{'id': format(i + 1, '064x'), 'metadata': {'name': n, 'namespace': ns}} for i, (n, ns) in enumerate(names)]
        self.host.containers = [{'id': 'a' * 64, 'state': 'CONTAINER_EXITED'}]
        self.runtime.stop_old()
        stops = [a[5] for a in self.host.calls if a[0] == 'crictl' and a[4] == 'stopp']
        self.assertEqual(stops, [i['id'] for i in sorted(self.host.pods, key=runtime.sandbox_order)])
        self.assertEqual(self.host.calls[0], ['systemctl', 'stop', 'kubelet.service'])
        self.assertTrue(all(len(a) == 6 and a[1].endswith(runtime.OLD) for a in self.host.calls if a[0] == 'crictl' and a[4] in ('stopp', 'rmp', 'rm')))

    def test_running_orphan_is_not_force_removed(self):
        self.host.containers = [{'id': 'a' * 64, 'state': 'CONTAINER_RUNNING'}]
        with self.assertRaises(runtime.prep.Refuse): self.runtime.stop_old()
        self.assertFalse(any(a[0] == 'crictl' and a[4] == 'rm' for a in self.host.calls))

    def test_sandbox_containers_stop_gracefully_before_stopp_etcd_last(self):
        self.host.pods = [{'id': 'a' * 64, 'metadata': {'name': 'etcd-node', 'namespace': 'kube-system'}},
                          {'id': 'b' * 64, 'metadata': {'name': 'application', 'namespace': 'app'}}]
        for pod in self.host.pods:
            self.host.pod_containers[pod['id']] = [
                {'id': pod['id'][0] * 63 + '1', 'podSandboxId': pod['id'], 'state': 'CONTAINER_RUNNING'},
                {'id': pod['id'][0] * 63 + '2', 'podSandboxId': pod['id'], 'state': 'CONTAINER_EXITED'},
                {'id': pod['id'][0] * 63 + '3', 'podSandboxId': pod['id'], 'state': 'CONTAINER_CREATED'}]
        self.runtime.stop_old()
        stops = [a[4:] for a in self.host.calls if a[0] == 'crictl' and a[4] in ('stop', 'stopp', 'rmp')]
        self.assertEqual(stops, [['stop', '--timeout=60', 'b' * 63 + '1'], ['stopp', 'b' * 64], ['rmp', 'b' * 64],
                                ['stop', '--timeout=60', 'a' * 63 + '1'], ['stopp', 'a' * 64], ['rmp', 'a' * 64]])

    def test_unrecognized_pod_container_refuses_before_sandbox_teardown(self):
        self.host.pods = [{'id': 'a' * 64, 'metadata': {'name': 'etcd-node', 'namespace': 'kube-system'}}]
        valid = {'id': 'b' * 64, 'podSandboxId': 'a' * 64, 'state': 'CONTAINER_RUNNING'}
        for container in (dict(valid, podSandboxId='c' * 64), dict(valid, id='not-an-id'),
                          dict(valid, state='CONTAINER_UNKNOWN')):
            self.host.calls.clear()
            self.host.pod_containers['a' * 64] = [container]
            with self.subTest(container=container):
                with self.assertRaises(runtime.prep.Refuse): self.runtime.stop_old()
            self.assertFalse(any(a[0] == 'crictl' and a[4] in ('stop', 'stopp', 'rmp') for a in self.host.calls))

    def test_graceful_stop_failure_does_not_fall_through_to_force_sandbox_stop(self):
        self.host.pods = [{'id': 'a' * 64, 'metadata': {'name': 'etcd-node', 'namespace': 'kube-system'}}]
        self.host.pod_containers['a' * 64] = [{'id': 'b' * 64, 'podSandboxId': 'a' * 64, 'state': 'CONTAINER_RUNNING'}]
        original = self.host.run
        def run(args, timeout=60):
            if args[0] == 'crictl' and args[4] == 'stop':
                raise runtime.prep.Refuse('graceful stop failed')
            return original(args, timeout)
        with mock.patch.object(self.host, 'run', side_effect=run):
            with self.assertRaises(runtime.prep.Refuse): self.runtime.stop_old()
        self.assertFalse(any(a[0] == 'crictl' and a[4] == 'stopp' for a in self.host.calls))

    def test_writable_fd_deleted_fd_and_malformed_flags_refuse(self):
        entries = [{'logical': '/selected', 'source': '/source'}]
        proc = self.process(fd_name='/selected/file')
        for flags in ('0100001', '0100002', 'not-octal', '0100000\nflags: 0100002'):
            with self.subTest(flags=flags):
                (proc / 'fdinfo/7').write_text('flags:\t' + flags + '\n')
                with self.assertRaises(runtime.prep.Refuse): self.runtime.no_host_writers(entries)
        (proc / 'fd/7').unlink(); (proc / 'fd/7').symlink_to('/source/file (deleted)')
        (proc / 'fdinfo/7').write_text('flags:\t0100002\n')
        with self.assertRaises(runtime.prep.Refuse): self.runtime.no_host_writers(entries)

    def test_read_only_fd_and_private_mapping_pass(self):
        self.process(fd_name='/selected/file', maps='1000-2000 rw-p 0000 00:01 42 /selected/file\n')
        self.runtime.no_host_writers([{'logical': '/selected', 'source': '/source'}])

    def test_shared_writable_mapping_with_closed_fd_refuses(self):
        self.process(maps='1000-2000 rw-s 0000 00:01 42 /source/file (deleted)\n')
        with self.assertRaises(runtime.prep.Refuse): self.runtime.no_host_writers([{'logical': '/selected', 'source': '/source'}])

    def test_selected_cwd_and_chroot_refuse(self):
        entries = [{'logical': '/selected', 'source': '/source'}]
        proc = self.process(cwd='/selected/directory')
        with self.assertRaises(runtime.prep.Refuse): self.runtime.no_host_writers(entries)
        (proc / 'cwd').unlink(); (proc / 'cwd').symlink_to('/safe')
        (proc / 'root').unlink(); (proc / 'root').symlink_to('/source')
        with self.assertRaises(runtime.prep.Refuse): self.runtime.no_host_writers(entries)

    def test_permission_denied_is_not_treated_as_process_exit(self):
        self.process()
        with mock.patch.object(Path, 'read_bytes', side_effect=PermissionError()):
            with self.assertRaises(PermissionError): self.runtime.assert_stopped()
        with mock.patch.object(Path, 'read_text', side_effect=PermissionError()):
            with self.assertRaises(PermissionError): self.runtime.no_host_writers([{'logical': '/selected', 'source': '/source'}])

    def test_endpoint_only_changes_single_original_field(self):
        raw = b'kind: KubeletConfiguration\ncontainerRuntimeEndpoint: unix://' + runtime.OLD.encode() + b'\nother: retained\n'
        updated = runtime.replace_endpoint(raw)
        self.assertIn(b'other: retained', updated)
        self.assertEqual(runtime.probe.yaml_endpoint(updated.decode()), runtime.NEW)
        with self.assertRaises(runtime.prep.Refuse): runtime.replace_endpoint(updated)


if __name__ == '__main__': unittest.main()
