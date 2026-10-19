"""Pin validated storage directories without trusting later path resolution.

The caller must verify that shared_mount is an actual filesystem mount root.
Only that exact ancestor may have a non-root owner; its mode and every other
component remain checked. No permissions or files are changed here.
"""
import contextlib
import os
from pathlib import Path
import stat


class StoragePathError(RuntimeError):
    pass


def _absolute(path):
    path = Path(path)
    if path.anchor != '/' or '..' in path.parts:
        raise StoragePathError('存储路径必须为不含 .. 的绝对路径: ' + str(path))
    return path


def _identity(status):
    return {'device': status.st_dev, 'inode': status.st_ino}


def _validate_directory(fd, path, shared_mount, owner_uid):
    status = os.fstat(fd)
    if not stat.S_ISDIR(status.st_mode):
        raise StoragePathError('存储路径必须为目录: ' + str(path))
    if status.st_mode & 0o022:
        raise StoragePathError('存储目录不能被组/其他用户写入: ' + str(path))
    if path != shared_mount and status.st_uid != owner_uid:
        raise StoragePathError('存储目录必须由 root 持有: ' + str(path))
    return status


def _flags():
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)


def _open_path(path, shared_mount, owner_uid):
    """Open one component at a time; never resolve through a symlink."""
    fd = None
    current = Path('/')
    try:
        fd = os.open('/', _flags())
        _validate_directory(fd, current, shared_mount, owner_uid)
        for component in path.parts[1:]:
            current = current / component
            next_fd = os.open(component, _flags(), dir_fd=fd)
            os.close(fd)
            fd = next_fd
            _validate_directory(fd, current, shared_mount, owner_uid)
        return fd
    except OSError as error:
        if fd is not None:
            os.close(fd)
        raise StoragePathError('无法安全打开存储目录（禁止符号链接）: {}: {}'.format(current, error.strerror)) from None
    except Exception:
        if fd is not None:
            os.close(fd)
        raise


class PinnedDirectory:
    def __init__(self, fd, path, shared_mount, owner_uid):
        self.fd = fd
        self.path = path
        self.identity = _identity(os.fstat(fd))
        self._shared_mount = shared_mount
        self._owner_uid = owner_uid

    @property
    def proc_path(self):
        # An explicit parent PID also works for child commands whose own file
        # descriptor table excludes our O_CLOEXEC descriptor.
        return '/proc/{}/fd/{}'.format(os.getpid(), self.fd)

    def assert_current(self):
        """Reject renamed/replaced canonical paths while retaining the old fd."""
        fd = _open_path(self.path, self._shared_mount, self._owner_uid)
        try:
            if _identity(os.fstat(fd)) != self.identity:
                raise StoragePathError('存储目录在检查后被替换或重新挂载: ' + str(self.path))
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def open_child(self, name):
        """Pin an existing direct child relative to this already-pinned fd."""
        if not isinstance(name, str) or name in ('', '.', '..') or '/' in name or '\x00' in name:
            raise StoragePathError('子目录必须是单个目录名')
        path = self.path / name
        fd = None
        try:
            fd = os.open(name, _flags(), dir_fd=self.fd)
            _validate_directory(fd, path, self._shared_mount, self._owner_uid)
        except OSError as error:
            if fd is not None:
                os.close(fd)
            raise StoragePathError('无法安全打开存储子目录: {}: {}'.format(path, error.strerror)) from None
        except Exception:
            if fd is not None:
                os.close(fd)
            raise
        try:
            yield PinnedDirectory(fd, path, self._shared_mount, self._owner_uid)
        finally:
            os.close(fd)


@contextlib.contextmanager
def pinned_directory(path, shared_mount=None, expected=None, owner_uid=0):
    path = _absolute(path)
    shared_mount = _absolute(shared_mount) if shared_mount is not None else None
    if shared_mount is not None and shared_mount not in path.parents:
        raise StoragePathError('共享挂载点必须是存储目录的严格上级目录')
    fd = _open_path(path, shared_mount, owner_uid)
    try:
        pinned = PinnedDirectory(fd, path, shared_mount, owner_uid)
        if expected is not None and pinned.identity != expected:
            raise StoragePathError('存储目录与记录的设备/inode 不一致: ' + str(path))
        yield pinned
    finally:
        os.close(fd)
