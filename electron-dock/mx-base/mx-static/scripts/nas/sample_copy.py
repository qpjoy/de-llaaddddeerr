#!/usr/bin/env python3
"""Copy a bounded live sample into a new private directory, retaining originals."""
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid

from layout import HOST_ROOT, VOLUMES
from media import checked_root
from permissions import emit, open_parent

MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_FILES = 8
MAX_ENTRIES = 10000
CATEGORIES = ('video', 'image', 'audio', 'document', 'other')
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_uid, info.st_gid, info.st_mode, info.st_nlink)


def attributes(info):
    # rsync's ordinary -t comparison uses whole seconds, not an ns guarantee.
    return {'size': info.st_size, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': oct(stat.S_IMODE(info.st_mode)), 'mtime_seconds': int(info.st_mtime)}


def select_sample(root_fd):
    device = os.fstat(root_fd).st_dev
    candidates = {'formal': [], 'temp': []}
    examined = 0
    cutoff = time.time() - 86400
    for category in CATEGORIES:
        try:
            folder = os.open(category, DIR_FLAGS, dir_fd=root_fd)
        except FileNotFoundError:
            continue
        try:
            if os.fstat(folder).st_dev != device:
                raise RuntimeError('Refused source submount: ' + category)
            with os.scandir(folder) as entries:
                for entry in entries:
                    if examined >= MAX_ENTRIES:
                        break
                    examined += 1
                    name = entry.name
                    if re.fullmatch(r'[0-9a-f]{64}\.[A-Za-z0-9]{1,12}', name):
                        group = 'formal'
                    elif name.startswith('raw-media-') and name.endswith('.tmp'):
                        group = 'temp'
                    else:
                        continue
                    info = entry.stat(follow_symlinks=False)
                    if (not stat.S_ISREG(info.st_mode) or info.st_dev != device or info.st_nlink != 1
                            or not 0 < info.st_size <= MAX_FILE or info.st_mtime > cutoff):
                        continue
                    if len(candidates[group]) < MAX_FILES:
                        candidates[group].append((category, name, signature(info)))
                    if all(len(group) >= MAX_FILES for group in candidates.values()):
                        break
        finally:
            os.close(folder)
        if examined >= MAX_ENTRIES or all(len(group) >= MAX_FILES for group in candidates.values()):
            break
    selected, total = [], 0
    for index in range(MAX_FILES):
        for group in ('formal', 'temp'):
            if index >= len(candidates[group]):
                continue
            item = candidates[group][index]
            if len(selected) < MAX_FILES and total + item[2][2] <= MAX_TOTAL:
                selected.append(item)
                total += item[2][2]
    if not selected:
        raise RuntimeError('No suitable files in bounded scan; no NAS directory created. Do not widen automatically.')
    return selected, examined


def digest(fd, expected_size):
    os.lseek(fd, 0, os.SEEK_SET)
    value = hashlib.sha256()
    remaining = expected_size
    while remaining:
        chunk = os.read(fd, min(1024 * 1024, remaining))
        if not chunk:
            raise RuntimeError('File shortened during checksum.')
        value.update(chunk)
        remaining -= len(chunk)
    if os.read(fd, 1):
        raise RuntimeError('File grew during checksum.')
    return value.hexdigest()


def descriptor_path(fd):
    # The parent holds these descriptors until rsync exits. Neither input nor
    # output can fall through to a new filesystem if a mount is detached.
    return '/proc/{}/fd/{}'.format(os.getpid(), fd)


def rsync_file(source_fd, destination_fd, name, lock_fd):
    command = ['rsync', '-aL', '--numeric-ids', '--bwlimit=10240',
               '--max-size=' + str(MAX_FILE), '--', descriptor_path(source_fd),
               descriptor_path(destination_fd) + '/' + name]
    # -L dereferences only our already-opened, verified regular-file fd. No
    # business-directory symlinks or recursive source traversal are involved.
    result = subprocess.run(command, pass_fds=(source_fd, destination_fd, lock_fd),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if result.returncode:
        raise RuntimeError('rsync exit {}: {}'.format(result.returncode, result.stderr[-2000:]))


def copy_one(root_fd, destination_fd, item, index, lock_fd):
    category, name, baseline = item
    folder = os.open(category, DIR_FLAGS, dir_fd=root_fd)
    source_fd = target_fd = None
    target_name = '{:02d}-{}'.format(index, name)
    try:
        source_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        before = os.fstat(source_fd)
        if signature(before) != baseline or not stat.S_ISREG(before.st_mode):
            raise RuntimeError('Source changed after selection: ' + category + '/' + name)
        emit('sample_hash_source', relative_path=category + '/' + name, bytes=before.st_size)
        expected_hash = digest(source_fd, before.st_size)
        if re.fullmatch(r'[0-9a-f]{64}\.[A-Za-z0-9]{1,12}', name) and name.split('.')[0] != expected_hash:
            raise RuntimeError('Formal media content does not match its SHA256 filename.')
        if signature(os.fstat(source_fd)) != baseline:
            raise RuntimeError('Source changed while hashing.')
        try:
            os.stat(target_name, dir_fd=destination_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError('Sample destination unexpectedly exists; refusing overwrite.')
        emit('sample_rsync', relative_path=category + '/' + name, limit_mib_per_second=10)
        os.lseek(source_fd, 0, os.SEEK_SET)
        rsync_file(source_fd, destination_fd, target_name, lock_fd)
        target_fd = os.open(target_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=destination_fd)
        copied = os.fstat(target_fd)
        if not stat.S_ISREG(copied.st_mode) or copied.st_dev != os.fstat(destination_fd).st_dev:
            raise RuntimeError('Unexpected sample destination type/device.')
        if attributes(copied) != attributes(before):
            raise RuntimeError('Copied attributes differ: ' + json.dumps(attributes(copied)))
        os.fsync(target_fd)
        emit('sample_hash_destination', relative_path=category + '/' + name)
        if digest(target_fd, copied.st_size) != expected_hash:
            raise RuntimeError('Copied content checksum mismatch.')
        current = os.stat(name, dir_fd=folder, follow_symlinks=False)
        if signature(current) != baseline or signature(os.fstat(source_fd)) != baseline:
            raise RuntimeError('Source changed during copy; sample is not certified.')
        if signature(os.fstat(target_fd)) != signature(copied):
            raise RuntimeError('Destination changed during verification.')
        return {'source_relative_path': category + '/' + name, 'sample_name': target_name,
                'sha256': expected_hash, 'attributes': attributes(copied)}
    finally:
        for fd in (target_fd, source_fd, folder):
            if fd is not None:
                os.close(fd)


def copy_sample(volume, root_fd, parent_fd, selected, examined, lock_fd):
    name = '.mx-static-copy-check-' + volume + '-' + uuid.uuid4().hex
    emit('creating_sample_directory', path=HOST_ROOT + '/' + name)
    os.mkdir(name, 0o700, dir_fd=parent_fd)  # Never mkdir -p or reuse a target.
    directory_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    report = {'volume': volume, 'path': HOST_ROOT + '/' + name, 'passed': False,
              'examined_entries': examined, 'selected_files': len(selected),
              'selected_bytes': sum(item[2][2] for item in selected), 'files': [],
              'copy_readiness': 'sample-only; no full copy or cutover authorization'}
    started = time.monotonic()
    try:
        if os.fstat(directory_fd).st_dev != os.fstat(parent_fd).st_dev:
            raise RuntimeError('Unexpected sample directory device.')
        for index, item in enumerate(selected, 1):
            report['files'].append(copy_one(root_fd, directory_fd, item, index, lock_fd))
        report['passed'] = True
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        report['error'] = str(exc)
    finally:
        report['elapsed_seconds_including_checksums'] = round(time.monotonic() - started, 3)
        try:
            fd = os.open('result.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory_fd)
            with os.fdopen(fd, 'w') as stream:
                json.dump(report, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
        except OSError as exc:
            report['passed'] = False
            report['report_write_error'] = str(exc)
        finally:
            os.close(directory_fd)
            emit('sample_result', **report)
    return report


def main():
    if (len(sys.argv) != 3 or sys.argv[1] not in VOLUMES or sys.argv[2] != '--copy-test'
            or not sys.platform.startswith('linux') or os.geteuid() != 0):
        raise SystemExit('Use sudo bash scripts/nas-sample-copy.sh <known-volume> --copy-test on Linux.')
    descriptors = []
    try:
        lock_fd = os.open('/run/lock/mx-static-nas-sample.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        descriptors.append(lock_fd)
        info = os.fstat(lock_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe sample lock file.')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another sample copy holds the lock; do not start a second copy.')
        volume = sys.argv[1]
        root_fd = os.open(checked_root(volume), DIR_FLAGS)
        descriptors.append(root_fd)
        if os.fstat(root_fd).st_dev != os.stat('/dev/nvme0n1p1').st_rdev:
            raise RuntimeError('Opened source does not belong to the expected SSD device.')
        selected, examined = select_sample(root_fd)
        emit('sample_selected', volume=volume, examined_entries=examined,
             files=len(selected), logical_bytes=sum(item[2][2] for item in selected))
        parent_fd = open_parent()
        descriptors.append(parent_fd)
        report = copy_sample(volume, root_fd, parent_fd, selected, examined, lock_fd)
        return 0 if report['passed'] else 1
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        emit('sample_failed', error=str(exc), note='Original media untouched; keep any sample directory for review.')
        return 1
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
