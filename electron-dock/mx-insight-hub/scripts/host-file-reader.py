#!/usr/bin/env python3
"""Read operator-selected dataset files on the Internal host over a private Unix socket."""
import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import errno
from http.server import BaseHTTPRequestHandler
import json
import os
import re
import signal
import socket
import socketserver
import sqlite3
import stat
import sys
import threading
import uuid

ROOT_ID = '@internal-host'
EXTENSIONS = {'.zip', '.txt', '.json'}
MAX_RANGE = 4 * 1024 * 1024
MAX_BODY = 32 * 1024
MAX_INTEGER = 2**53 - 1
SYSTEM_PATHS = (
    '/proc', '/sys', '/dev', '/etc', '/boot', '/root', '/run', '/bin', '/sbin', '/lib', '/lib64', '/usr',
    '/var/lib', '/var/log', '/var/run', '/var/cache', '/var/spool', '/var/backups', '/var/db',
    '/private/etc', '/private/var/db', '/private/var/run', '/System', '/Library', '/Applications',
    # Internal keeps its container runtime, cluster state and recovery data on this disk.
    '/data/docker', '/data/k8s', '/data/mx-backup', '/data/mx-recovery', '/data/mx-runtime',
)
VIRTUAL_FS = {
    'proc', 'sysfs', 'devtmpfs', 'devfs', 'devpts', 'cgroup', 'cgroup2', 'debugfs', 'tracefs',
    'securityfs', 'configfs', 'bpf', 'pstore', 'fusectl', 'efivarfs', 'hugetlbfs', 'mqueue', 'nsfs',
}
MESSAGES = {
    'invalid_request': (400, 'Invalid host reader request'),
    'invalid_server_file_path': (400, 'Server file path is invalid'),
    'unsupported_file_type': (400, 'Server file type is not supported'),
    'server_file_symlink_rejected': (400, 'Symbolic links cannot be imported'),
    'server_file_not_regular': (400, 'Server file must be a regular file'),
    'server_file_empty': (400, 'Server file is empty'),
    'server_file_executable': (400, 'Executable files cannot be imported'),
    'server_file_path_not_allowed': (403, 'Server path is not eligible for dataset import'),
    'server_file_unreadable': (403, 'Server file is not readable by the host reader'),
    'server_file_not_found': (404, 'Server file was not found'),
    'source_changed': (409, 'Source changed since it was opened'),
    'server_file_too_large': (413, 'Server file exceeds the supported size'),
    'server_file_unavailable': (503, 'Host file reader is unavailable'),
}


class ReaderError(Exception):
    def __init__(self, code):
        self.code = code
        self.status, self.message = MESSAGES[code]
        super().__init__(self.message)


def fs_error(error):
    if error.errno in (errno.ENOENT, errno.ENOTDIR):
        return ReaderError('server_file_not_found')
    if error.errno in (errno.EPERM, errno.EACCES):
        return ReaderError('server_file_unreadable')
    if error.errno == errno.ELOOP:
        return ReaderError('server_file_symlink_rejected')
    if error.errno == errno.ENAMETOOLONG:
        return ReaderError('invalid_server_file_path')
    return ReaderError('server_file_unavailable')


def within(path, directory):
    return path == directory or path.startswith(directory.rstrip('/') + '/')


def protected_path(path, state_dir):
    return any(p.startswith('.') for p in path.split('/')) or any(
        within(path, directory) for directory in SYSTEM_PATHS + (state_dir,))


def source_path(value, state_dir):
    if (not isinstance(value, str) or not value.startswith('/') or not value or len(value) > 4096
            or any(ord(c) < 32 or c in '*?[]{}\\' for c in value)):
        raise ReaderError('invalid_server_file_path')
    parts = value[1:].split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ReaderError('invalid_server_file_path')
    if protected_path(value, state_dir):
        raise ReaderError('server_file_path_not_allowed')
    if os.path.splitext(parts[-1])[1].lower() not in EXTENSIONS:
        raise ReaderError('unsupported_file_type')
    try:
        value.encode('utf-8')
    except UnicodeError:
        raise ReaderError('invalid_server_file_path')
    return parts


def check_linux_mount(fd, path, state_dir):
    # A bind-mounted proc/sysfs/secret volume can also appear below a data path.
    # Inspect the pinned descriptor's mount, independent of the pasted pathname.
    if not sys.platform.startswith('linux'):
        return
    with open('/proc/self/fdinfo/{}'.format(fd), encoding='ascii') as info:
        mount = next((s.split()[1] for s in info if s.startswith('mnt_id:')), None)
    with open('/proc/self/mountinfo', 'rb') as mounts:
        rows = [raw.split() for raw in mounts]
    current = next((row for row in rows if mount and row[0] == mount.encode()), None)
    if current is None:
        raise ReaderError('server_file_unavailable')
    if current[current.index(b'-') + 1].decode('ascii') in VIRTUAL_FS:
        raise ReaderError('server_file_path_not_allowed')

    # Reconstruct every visible alias of this inode's path on the same volume.
    # A data disk's "/etc" is not necessarily the host's "/etc"; a bind mount
    # of the real /etc or /data/k8s can equally appear under an innocent name.
    def unescape(value):
        return os.fsdecode(re.sub(rb'\\([0-7]{3})', lambda m: bytes([int(m[1], 8)]), value))
    subroot, target = map(unescape, current[3:5])
    if not within(path, target):
        raise ReaderError('source_changed')
    original = os.path.normpath(os.path.join(subroot, os.path.relpath(path, target)))
    for row in rows:
        if row[2] == current[2]:
            root, target = map(unescape, row[3:5])
            if within(original, root):
                alias = os.path.normpath(os.path.join(target, os.path.relpath(original, root)))
                if protected_path(alias, state_dir):
                    raise ReaderError('server_file_path_not_allowed')


def check_regular(info):
    if stat.S_ISLNK(info.st_mode):
        raise ReaderError('server_file_symlink_rejected')
    if not stat.S_ISREG(info.st_mode):
        raise ReaderError('server_file_not_regular')
    if info.st_mode & 0o111:
        raise ReaderError('server_file_executable')
    if not info.st_size:
        raise ReaderError('server_file_empty')
    if info.st_size > MAX_INTEGER:
        raise ReaderError('server_file_too_large')


def snapshot(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode)


@contextmanager
def open_source(path, state_dir):
    parts = source_path(path, state_dir)
    directory_flags = getattr(os, 'O_PATH', os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open('/', directory_flags)
    pinned = data_fd = None
    try:
        for part in parts[:-1]:
            # lstat produces a distinct symlink error even on systems where
            # O_DIRECTORY|O_NOFOLLOW returns ENOTDIR. openat enforces it again.
            if stat.S_ISLNK(os.stat(part, dir_fd=parent, follow_symlinks=False).st_mode):
                raise ReaderError('server_file_symlink_rejected')
            child = os.open(part, directory_flags, dir_fd=parent)
            os.close(parent)
            parent = child
        name = parts[-1]
        initial = os.stat(name, dir_fd=parent, follow_symlinks=False)
        check_regular(initial)
        if initial.st_nlink > 1:
            # Do not expose the private on-disk path registry under a second name.
            registry = os.stat(os.path.join(state_dir, 'locators.sqlite3'))
            if os.path.samestat(initial, registry):
                raise ReaderError('server_file_path_not_allowed')
        if sys.platform.startswith('linux'):
            # O_PATH pins an inode without opening a device or waiting on a FIFO
            # even if another process replaces the name immediately before openat.
            pinned = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
            info = os.fstat(pinned)
            check_regular(info)
            if snapshot(initial) != snapshot(info):
                raise ReaderError('source_changed')
            check_linux_mount(pinned, path, state_dir)
            data_fd = os.open('/proc/self/fd/{}'.format(pinned), os.O_RDONLY | os.O_NONBLOCK)
        else:
            data_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        opened = os.fstat(data_fd)
        check_regular(opened)
        if snapshot(initial) != snapshot(opened):
            raise ReaderError('source_changed')
        yield data_fd, opened
    finally:
        if data_fd is not None:
            os.close(data_fd)
        if pinned is not None:
            os.close(pinned)
        os.close(parent)


class ArchiveReader:
    def __init__(self, state_dir):
        self.state = os.path.realpath(state_dir)
        os.makedirs(self.state, mode=0o700, exist_ok=True)
        info = os.stat(self.state)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('State directory must be private and owned by the reader')
        self.registry = os.path.join(self.state, 'locators.sqlite3')
        with closing(sqlite3.connect(self.registry)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL)')

    def resolve(self, body):
        path = body.get('path')
        with open_source(path, self.state):
            pass
        with closing(sqlite3.connect(self.registry)) as db, db:
            db.execute('INSERT OR IGNORE INTO sources (id, path) VALUES (?, ?)', (uuid.uuid4().hex, path))
            token = db.execute('SELECT id FROM sources WHERE path = ?', (path,)).fetchone()[0]
        return {'rootId': ROOT_ID, 'relativePath': token + '/' + os.path.basename(path)}

    def lookup(self, body):
        locator = body.get('relativePath')
        if not isinstance(locator, str) or not re.fullmatch(r'[0-9a-f]{32}/[^/]{1,255}', locator):
            raise ReaderError('invalid_server_file_path')
        token, name = locator.split('/')
        with closing(sqlite3.connect(self.registry)) as db:
            row = db.execute('SELECT path FROM sources WHERE id = ?', (token,)).fetchone()
        if not row or name != os.path.basename(row[0]):
            raise ReaderError('server_file_not_found')
        return row[0]

    def metadata(self, body):
        path = self.lookup(body)
        extensions = body.get('extensions')
        if not isinstance(extensions, list) or not all(isinstance(x, str) for x in extensions):
            raise ReaderError('invalid_request')
        if os.path.splitext(path)[1].lower() not in extensions:
            raise ReaderError('unsupported_file_type')
        with open_source(path, self.state) as (_, info):
            seconds, ns = divmod(info.st_mtime_ns, 10**9)
            mtime = datetime.fromtimestamp(seconds, timezone.utc).replace(microsecond=ns // 1000)
            return {'rootId': ROOT_ID, 'relativePath': body['relativePath'], 'filename': os.path.basename(path),
                    'identity': '{}:{}'.format(info.st_dev, info.st_ino), 'bytes': info.st_size,
                    'mtimeNs': str(info.st_mtime_ns), 'mtime': mtime.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}

    def read(self, body):
        path = self.lookup(body)
        position, length, size = (body.get(key) for key in ('position', 'length', 'bytes'))
        if (any(type(n) is not int or not 0 <= n <= MAX_INTEGER for n in (position, length, size))
                or length > MAX_RANGE or not isinstance(body.get('identity'), str)
                or not isinstance(body.get('mtimeNs'), str)):
            raise ReaderError('invalid_request')
        try:
            with open_source(path, self.state) as (fd, opened):
                if ('{}:{}'.format(opened.st_dev, opened.st_ino) != body['identity'] or opened.st_size != size
                        or str(opened.st_mtime_ns) != body['mtimeNs']):
                    raise ReaderError('source_changed')
                count = max(0, min(length, size - position))
                data = os.pread(fd, count, position)
                if len(data) != count or snapshot(opened) != snapshot(os.fstat(fd)):
                    raise ReaderError('source_changed')
                # A rename during pread does not change the open fd. Reopen the
                # requested path through the same no-follow checks before replying.
                with open_source(path, self.state) as (_, current):
                    if snapshot(opened) != snapshot(current):
                        raise ReaderError('source_changed')
                return data
        except (ReaderError, OSError) as error:
            cause = error if isinstance(error, ReaderError) else fs_error(error)
            if cause.code in ('server_file_not_found', 'server_file_not_regular', 'server_file_symlink_rejected',
                              'server_file_empty', 'server_file_executable'):
                raise ReaderError('source_changed')
            raise cause


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Neither URLs nor operator inputs belong in access/error logs.

    def send_error(self, code, *args):
        self.reply(code, {'code': 'invalid_request', 'message': 'Invalid host reader request'})

    def reply(self, status, data):
        binary = isinstance(data, bytes)
        body = data if binary else json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/octet-stream' if binary else 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def do_POST(self):
        try:
            reader = self.server.reader
            handlers = {'/resolve': reader.resolve, '/open': reader.metadata, '/read': reader.read}
            if self.path not in handlers:
                return self.send_error(404)
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,6}', lengths[0]):
                raise ReaderError('invalid_request')
            length = int(lengths[0])
            if length > MAX_BODY:
                return self.send_error(413)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ReaderError('invalid_request')
            body = json.loads(raw.decode('utf-8'))
            if not isinstance(body, dict):
                raise ReaderError('invalid_request')
            data = handlers[self.path](body)
        except ReaderError as error:
            return self.reply(error.status, {'code': error.code, 'message': error.message})
        except (ValueError, UnicodeError, RecursionError):
            return self.send_error(400)
        except (OSError, sqlite3.Error) as error:
            safe = fs_error(error) if isinstance(error, OSError) else ReaderError('server_file_unavailable')
            return self.reply(safe.status, {'code': safe.code, 'message': safe.message})
        self.reply(200, data)


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, reader, socket_path):
        self.reader = reader
        self.capacity = threading.BoundedSemaphore(8)
        if socket_path:
            super().__init__(socket_path, Handler)
        else:
            if os.getenv('LISTEN_PID') != str(os.getpid()) or os.getenv('LISTEN_FDS') != '1':
                raise ValueError('Expected one systemd Unix listening socket')
            # Python 3.6 does not infer the family/type for socket(fileno=...).
            inherited = socket.fromfd(3, socket.AF_UNIX, socket.SOCK_STREAM)
            socket_path = inherited.getsockname()
            if (inherited.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
                    or (hasattr(socket, 'SO_DOMAIN') and inherited.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) != socket.AF_UNIX)
                    or (sys.platform.startswith('linux') and not inherited.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN))
                    or not isinstance(socket_path, str) or not os.path.isabs(socket_path)
                    or os.stat(socket_path, follow_symlinks=False).st_mode & 0o007):
                inherited.close()
                raise ValueError('Expected a private listening Unix socket')
            super().__init__('', Handler, bind_and_activate=False)
            self.socket.close()
            self.socket = inherited

    def get_request(self):
        conn, address = super().get_request()
        conn.settimeout(10)
        return conn, address

    def process_request(self, request, client_address):
        self.capacity.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.capacity.release()

    def handle_error(self, request, client_address):
        pass  # Do not emit a raw exception (filesystem errors contain host paths).


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', help='private standalone Unix socket (default: systemd fd 3)')
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.exit(1, 'Host file reader must run as an unprivileged user\n')
    os.umask(0o077)
    try:
        reader = ArchiveReader(args.state_dir)
        with UnixServer(reader, args.socket) as server:
            if args.socket:
                os.chmod(args.socket, 0o600)
            def stop(signum, frame):
                raise SystemExit(0)
            signal.signal(signal.SIGTERM, stop)
            try:
                server.serve_forever()
            finally:
                if args.socket:
                    os.unlink(args.socket)
    except (OSError, sqlite3.Error, ValueError):
        parser.exit(1, 'Unable to start host file reader; check its private state directory and Unix socket\n')


if __name__ == '__main__':
    main()
