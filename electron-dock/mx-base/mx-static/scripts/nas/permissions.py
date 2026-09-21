#!/usr/bin/env python3
"""An explicit, bounded write probe. Never reads or changes business files."""
import hashlib
import json
import os
import stat
import subprocess
import sys
import uuid

from layout import HOST_ROOT, NAS_MOUNT, expected_mount


def emit(event, **values):
    print(json.dumps(dict(event=event, **values), ensure_ascii=False), flush=True)


def identity(info):
    return info.st_dev, info.st_ino


def metadata(info):
    return {'uid': info.st_uid, 'gid': info.st_gid,
            'mode': oct(stat.S_IMODE(info.st_mode))}


def open_parent():
    result = subprocess.run(['findmnt', '-rn', '-M', NAS_MOUNT, '-t', 'nfs,nfs4',
                             '-o', 'TARGET,SOURCE,FSTYPE,MAJ:MIN'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, timeout=15)
    fields = result.stdout.split()
    if result.returncode or len(fields) != 4 or not expected_mount(' '.join(fields[:3])):
        raise RuntimeError('Refused: expected NFS export is not mounted.')
    major, minor = (int(part) for part in fields[3].split(':'))
    device = os.makedev(major, minor)
    emit('mount_verified', mount=result.stdout.strip(), next='Open existing host directory; hard NFS may wait.')
    # Pin the existing directory by fd. Writes stay on this NFS filesystem even
    # if its mount is detached later; they cannot fall back to a local pathname.
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    cursor = ''
    try:
        for part in HOST_ROOT.strip('/').split('/'):
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            cursor += '/' + part
            if cursor in (NAS_MOUNT, HOST_ROOT) and os.fstat(fd).st_dev != device:
                raise RuntimeError('Refused: opened path device differs from verified NFS mount.')
        emit('parent_opened', path=HOST_ROOT, **metadata(os.fstat(fd)))
        return fd
    except BaseException:
        os.close(fd)
        raise


def probe(parent_fd):
    name = '.mx-static-probe-' + uuid.uuid4().hex
    path = HOST_ROOT + '/' + name
    directory_fd = file_fd = None
    directory_id = file_id = None
    directory_created = False
    result = {'path': path, 'io_passed': False, 'metadata_passed': False,
              'root_owner_preservation': False, 'cleanup_passed': False,
              'copy_readiness': 'not-established'}
    phase = 'mkdir'
    try:
        emit('creating_private_probe', path=path, bytes=4096)
        os.mkdir(name, 0o700, dir_fd=parent_fd)  # Exclusive; no parents or reuse.
        directory_created = True
        directory_id = identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False))
        directory_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=parent_fd)
        if identity(os.fstat(directory_fd)) != directory_id:
            raise RuntimeError('Probe directory identity changed.')
        phase = 'create_write_fsync'
        file_fd = os.open('payload.tmp', os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW,
                          0o600, dir_fd=directory_fd)
        file_id = identity(os.fstat(file_fd))
        result['created_file'] = metadata(os.fstat(file_fd))
        payload = os.urandom(4096)
        remaining = memoryview(payload)
        while remaining:
            written = os.write(file_fd, remaining)
            if written <= 0:
                raise OSError('Short write made no progress.')
            remaining = remaining[written:]
        os.fsync(file_fd)
        phase = 'rename_readback'
        emit('testing_rename_readback', path=path)
        os.rename('payload.tmp', 'payload.final', src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.close(file_fd)
        file_fd = None
        file_fd = os.open('payload.final', os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory_fd)
        if identity(os.fstat(file_fd)) != file_id:
            raise RuntimeError('Renamed file identity changed.')
        with os.fdopen(os.dup(file_fd), 'rb') as stream:
            actual = stream.read(4097)
        if actual != payload:
            raise RuntimeError('Readback differs from the 4 KiB written.')
        result['io_passed'] = True
        result['sha256'] = hashlib.sha256(actual).hexdigest()
        phase = 'chmod_mtime'
        emit('testing_metadata', path=path)
        os.fchmod(file_fd, 0o644)
        os.utime(file_fd, (1600000000, 1600000000))
        info = os.fstat(file_fd)
        result['after_mode_mtime'] = dict(metadata(info), mtime=info.st_mtime)
        result['metadata_passed'] = stat.S_IMODE(info.st_mode) == 0o644 and int(info.st_mtime) == 1600000000
        phase = 'chown_0_0'
        emit('testing_chown', path=path, uid=0, gid=0)
        os.fchown(file_fd, 0, 0)
        info = os.fstat(file_fd)
        result['after_chown'] = metadata(info)
        result['root_owner_preservation'] = (info.st_uid, info.st_gid) == (0, 0)
    except OSError as exc:
        result['error'] = {'phase': phase, 'errno': exc.errno, 'message': str(exc)}
    except RuntimeError as exc:
        result['error'] = {'phase': phase, 'message': str(exc)}
    finally:
        # No recursive deletion or globbing. A replaced name is never removed.
        emit('cleanup_own_probe', path=path)
        cleanup_errors = []
        if directory_created and directory_id is None:
            cleanup_errors.append('Created directory identity could not be read; left for review: ' + path)
        if file_fd is not None:
            os.close(file_fd)  # Close before unlink to avoid NFS .nfs handles.
        if directory_fd is not None:
            for leaf in ('payload.tmp', 'payload.final'):
                try:
                    info = os.stat(leaf, dir_fd=directory_fd, follow_symlinks=False)
                    if file_id is None or identity(info) != file_id or not stat.S_ISREG(info.st_mode):
                        raise RuntimeError('Unexpected probe entry; left in place: ' + leaf)
                    os.unlink(leaf, dir_fd=directory_fd)
                except FileNotFoundError:
                    pass
                except (OSError, RuntimeError) as exc:
                    cleanup_errors.append(str(exc))
            os.close(directory_fd)
        if directory_id is not None:
            try:
                info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if identity(info) != directory_id or not stat.S_ISDIR(info.st_mode):
                    raise RuntimeError('Probe directory replaced; left in place.')
                os.rmdir(name, dir_fd=parent_fd)  # Only succeeds when empty.
            except (OSError, RuntimeError) as exc:
                cleanup_errors.append(str(exc))
        result['cleanup_passed'] = not cleanup_errors
        if cleanup_errors:
            result['cleanup_errors'] = cleanup_errors
    emit('probe_result', **result)
    return result


def main():
    if sys.argv[1:] != ['--write-test'] or not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise SystemExit('Use sudo bash scripts/nas-probe.sh permissions --write-test on the Linux host.')
    parent_fd = None
    try:
        parent_fd = open_parent()
        result = probe(parent_fd)
        return 0 if all(result[key] for key in ('io_passed', 'metadata_passed',
                                               'root_owner_preservation', 'cleanup_passed')) else 1
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        emit('probe_refused_or_failed', error=str(exc), copy_readiness='not-established')
        return 1
    finally:
        if parent_fd is not None:
            os.close(parent_fd)


if __name__ == '__main__':
    sys.exit(main())
