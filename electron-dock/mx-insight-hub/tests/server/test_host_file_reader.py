import concurrent.futures
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'host-file-reader.py'
spec = importlib.util.spec_from_file_location('host_file_reader', str(SCRIPT))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class HostReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.state = self.base / 'state'
        self.service = reader.ArchiveReader(str(self.state))
        self.source = self.base / 'data.zip'
        self.source.write_bytes(b'test archive bytes')

    def resolve(self, source=None):
        return self.service.resolve({'path': str(source or self.source)})

    def test_concurrent_resolve_is_idempotent_and_restart_preserves_locator(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            locators = list(pool.map(lambda _: self.resolve(), range(10)))
        self.assertTrue(all(item == locators[0] for item in locators))
        self.assertEqual(locators[0]['rootId'], '@internal-host')
        self.assertRegex(locators[0]['relativePath'], r'^[0-9a-f]{32}/data\.zip$')
        self.service = reader.ArchiveReader(str(self.state))
        self.assertEqual(self.resolve(), locators[0])
        with self.assertRaises(reader.ReaderError) as raised:
            self.service.metadata(dict(locators[0], relativePath=locators[0]['relativePath'].replace('data.zip', 'other.txt'), extensions=['.txt']))
        self.assertEqual(raised.exception.code, 'server_file_not_found')

    def test_rejects_unsafe_paths_sensitive_paths_special_files_and_registry_alias(self):
        (self.base / 'link.zip').symlink_to(self.source)
        (self.base / 'alias').symlink_to(self.base)
        fifo = self.base / 'fifo.txt'
        os.mkfifo(str(fifo))
        executable = self.base / 'run.json'
        executable.write_bytes(b'{}')
        executable.chmod(0o755)
        protected = self.state / 'internal.json'
        protected.write_bytes(b'{}')
        alias = self.base / 'registry.json'
        os.link(str(self.state / 'locators.sqlite3'), str(alias))
        cases = [
            ('relative.zip', 'invalid_server_file_path'), ('/bad/../file.txt', 'invalid_server_file_path'),
            ('/data/x*.json', 'invalid_server_file_path'), ('/bad\x00.txt', 'invalid_server_file_path'),
            ('/data/file.csv', 'unsupported_file_type'), ('/proc/files.txt', 'server_file_path_not_allowed'),
            ('/etc/keys.json', 'server_file_path_not_allowed'), ('/var/lib/app/credentials.json', 'server_file_path_not_allowed'),
            ('/data/k8s/control-plane.json', 'server_file_path_not_allowed'),
            ('/data/user/.ssh/config.json', 'server_file_path_not_allowed'),
            (protected, 'server_file_path_not_allowed'), (alias, 'server_file_path_not_allowed'),
            (self.base / 'link.zip', 'server_file_symlink_rejected'), (self.base / 'alias' / 'data.zip', 'server_file_symlink_rejected'),
            (fifo, 'server_file_not_regular'), (executable, 'server_file_executable'),
        ]
        for path, code in cases:
            with self.subTest(path=path):
                with self.assertRaises(reader.ReaderError) as raised:
                    self.resolve(path)
                self.assertEqual(raised.exception.code, code)
                self.assertNotIn(str(self.base), raised.exception.message)

    def test_read_checks_open_fd_and_current_path_before_returning(self):
        locator = self.resolve()
        body = dict(self.service.metadata(dict(locator, extensions=['.zip'])), position=0, length=4)
        original_pread = os.pread
        replacement = self.base / 'next.zip'
        replacement.write_bytes(b'other bytes')
        def replace_during_read(fd, size, offset):
            result = original_pread(fd, size, offset)
            os.replace(str(replacement), str(self.source))
            return result
        with mock.patch.object(reader.os, 'pread', replace_during_read):
            with self.assertRaises(reader.ReaderError) as changed:
                self.service.read(body)
        self.assertEqual(changed.exception.code, 'source_changed')
        with self.assertRaises(reader.ReaderError) as changed:
            self.service.read(body)
        self.assertEqual(changed.exception.code, 'source_changed')

    def test_private_state_required(self):
        os.chmod(str(self.state), 0o755)
        with self.assertRaises(ValueError):
            reader.ArchiveReader(str(self.state))

    def test_linux_mount_check_allows_data_volumes_and_rejects_virtual_or_sensitive_aliases(self):
        mounts = [
            (b'proc', b'/', b'/', False), (b'sysfs', b'/', b'/', False), (b'ext4', b'/etc', b'/', False),
            (b'ext4', b'/home/test/.docker', b'/', False), (b'tmpfs', b'/', b'/scratch', True),
            (b'nfs4', b'/archives', b'/data', True), (b'ext4', b'/k8s', b'/data', False),
            (b'ext4', b'/etc', b'/data', True),
        ]
        for filesystem, subroot, disk, allowed in mounts:
            with self.subTest(filesystem=filesystem, subroot=subroot):
                # mountinfo encodes the space in the socket caller's data directory.
                line = b'12 1 8:1 / ' + disk + b' rw - ' + filesystem + b' src rw\n'
                line += b'30 12 8:1 ' + subroot + b' /mnt/data\\040volume ro - ' + filesystem + b' src ro\n'
                fake_files = [io.StringIO('mnt_id:\t30\n'), io.BytesIO(line)]
                with mock.patch.object(reader.sys, 'platform', 'linux'), mock.patch('builtins.open', side_effect=fake_files):
                    if allowed:
                        reader.check_linux_mount(9, '/mnt/data volume/rows.txt', str(self.state))
                    else:
                        with self.assertRaises(reader.ReaderError) as raised:
                            reader.check_linux_mount(9, '/mnt/data volume/rows.txt', str(self.state))
                        self.assertEqual(raised.exception.code, 'server_file_path_not_allowed')


class UnixSocketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.sock = self.base / 'reader.sock'
        self.script = self.base / 'reader.py'
        shutil.copyfile(str(SCRIPT), str(self.script))
        self.user = None
        if os.geteuid() == 0:
            self.user = pwd.getpwnam('nobody')
            os.chown(str(self.base), self.user.pw_uid, self.user.pw_gid)
        self.process = None
        self.addCleanup(self.stop)

    def drop_root(self):
        if self.user:
            os.setgroups([])
            os.setgid(self.user.pw_gid)
            os.setuid(self.user.pw_uid)

    def spawn(self, systemd=False, socket_mode=0o660):
        args = [sys.executable, '-I', str(self.script), '--state-dir', str(self.base / 'state')]
        if systemd:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(self.sock))
                os.chmod(str(self.sock), socket_mode)
                listener.listen(16)
                bootstrap = ("import os,sys; fd=int(sys.argv[1]); os.dup2(fd,3,inheritable=True); "
                             "os.set_inheritable(3,True); os.environ.update(LISTEN_PID=str(os.getpid()),LISTEN_FDS='1'); "
                             "os.execv(sys.argv[2],sys.argv[2:])")
                self.process = subprocess.Popen([sys.executable, '-c', bootstrap, str(listener.fileno())] + args,
                                                pass_fds=(listener.fileno(),), preexec_fn=self.drop_root,
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        else:
            self.process = subprocess.Popen(args + ['--socket', str(self.sock)], preexec_fn=self.drop_root,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def start(self, systemd=False):
        self.spawn(systemd)
        for _ in range(100):
            if self.process.poll() is not None:
                self.fail('reader exited at startup: ' + self.process.communicate()[1].decode())
            if self.sock.exists() and (self.base / 'state' / 'locators.sqlite3').exists():
                return
            time.sleep(0.02)
        self.fail('reader did not become ready')

    def stop(self):
        if self.process:
            self.process.terminate()
            stdout, stderr = self.process.communicate(timeout=4)
            self.process = None
            self.assertEqual((stdout, stderr), (b'', b''))

    def test_world_accessible_inherited_socket_is_refused(self):
        self.spawn(systemd=True, socket_mode=0o666)
        _, error = self.process.communicate(timeout=4)
        self.assertEqual(self.process.returncode, 1)
        self.process = None
        self.assertIn(b'Unable to start host file reader', error)
        self.assertNotIn(str(self.base).encode(), error)

    def post(self, route, body):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(2)
            client.connect(str(self.sock))
            payload = json.dumps(body).encode()
            client.sendall(b'POST ' + route.encode() + b' HTTP/1.0\r\nContent-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload)
            with http.client.HTTPResponse(client) as response:
                response.begin()
                data = response.read()
                self.assertNotIn(str(self.base).encode(), data)
                if response.getheader('Content-Type') == 'application/json':
                    data = json.loads(data)
                return response.status, data

    def test_socket_protocol_opaque_locator_restart_ranges_and_replacement(self):
        source = self.base / 'input.txt'
        source.write_bytes(b'example data')
        source.chmod(0o644)
        self.start()
        self.assertEqual(stat.S_IMODE(self.sock.stat().st_mode), 0o600)
        code, locator = self.post('/resolve', {'path': str(source)})
        self.assertEqual(code, 200)
        self.assertEqual(locator['rootId'], '@internal-host')
        self.stop()
        self.start(systemd=True)
        self.assertEqual(self.post('/resolve', {'path': str(source)}), (200, locator))
        code, metadata = self.post('/open', {**locator, 'extensions': ['.txt']})
        self.assertEqual(code, 200)
        self.assertEqual(metadata['bytes'], 12)
        self.assertIsInstance(metadata['mtimeNs'], str)
        self.assertRegex(metadata['identity'], r'^\d+:\d+$')
        self.assertRegex(metadata['mtime'], r'\.\d{3}Z$')
        self.assertEqual(self.post('/read', dict(metadata, position=2, length=3)), (200, b'amp'))
        self.assertEqual(self.post('/read', dict(metadata, position=10, length=64)), (200, b'ta'))
        self.assertEqual(self.post('/read', dict(metadata, position=12, length=5)), (200, b''))
        self.assertEqual(self.post('/read', dict(metadata, position=0, length=reader.MAX_RANGE + 1))[0], 400)
        self.assertEqual(self.post('/open', {**locator, 'extensions': ['.zip']})[1]['code'], 'unsupported_file_type')
        replacement = self.base / 'new.txt'
        replacement.write_bytes(b'updated data')
        replacement.chmod(0o644)
        os.replace(str(replacement), str(source))
        code, failure = self.post('/read', dict(metadata, position=0, length=2))
        self.assertEqual((code, failure['code']), (409, 'source_changed'))


if __name__ == '__main__':
    unittest.main()
