#!/usr/bin/env python3
"""Read-only media comparison with a local SHA256 ledger. Never authorizes cutover."""
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

from layout import VOLUMES
from media import checked_root
from permissions import emit, open_parent
from precopy import check_host, check_consumers, open_job, read_state
from sample_copy import DIR_FLAGS, descriptor_path, digest

REPORT_ROOT = '/var/lib/mx-static/nas-verification'
STAT_FIELDS = ('dev', 'ino', 'size', 'mtime_ns', 'ctime_ns', 'mode', 'uid', 'gid', 'nlink')


def stamp(info):
    return {key: getattr(info, 'st_' + key) for key in STAT_FIELDS}


def directory_names(fd):
    # os.scandir(fd) was added in Python 3.7; EL8 uses 3.6.
    path = fd if os.scandir in os.supports_fd else descriptor_path(fd)
    with os.scandir(path) as entries:
        return sorted(entry.name for entry in entries)


class Report:
    def __init__(self, stream):
        self.stream = stream
        self.sha256 = hashlib.sha256()
        self.counts = {'matched_files': 0, 'matched_bytes': 0, 'hashed_pairs': 0,
                       'hashed_source_bytes': 0, 'hashed_target_bytes': 0, 'issues': 0}
        self.first_issues = []
        self.last_progress = time.monotonic()

    def record(self, kind, **values):
        # ASCII escaping also preserves undecodable Unix filename bytes.
        data = (json.dumps(dict(kind=kind, **values), sort_keys=True, ensure_ascii=True) + '\n').encode()
        self.stream.write(data)
        self.sha256.update(data)

    def issue(self, reason, path, **values):
        item = dict(reason=reason, path=path, **values)
        self.counts['issues'] += 1
        self.record('issue', **item)
        if len(self.first_issues) < 20:
            self.first_issues.append(item)
            emit('verify_issue', **item)

    def progress(self, phase, **values):
        if time.monotonic() - self.last_progress >= 10:
            self.stream.flush()
            emit('verify_progress', phase=phase, **self.counts, **values)
            self.last_progress = time.monotonic()


def inventory(root_fd, side, report):
    device = os.fstat(root_fd).st_dev
    result = {}

    def visit(fd, relative, depth):
        result[relative] = stamp(os.fstat(fd))
        if depth > 64:
            raise RuntimeError('Unexpected directory depth; stop: ' + relative)
        for name in directory_names(fd):
            path = relative + '/' + name if relative else name
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                result[path] = stamp(info)
                if info.st_dev != device:
                    report.issue('submount', path, side=side)
                elif stat.S_ISDIR(info.st_mode):
                    child = os.open(name, DIR_FLAGS, dir_fd=fd)
                    try:
                        if stamp(os.fstat(child)) != result[path]:
                            raise RuntimeError('Directory changed during enumeration.')
                        visit(child, path, depth + 1)
                    finally:
                        os.close(child)
                elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    report.issue('unsupported_file_type_or_hardlink', path, side=side)
            except (OSError, RuntimeError) as exc:
                report.issue('inventory_error', path, side=side, error=str(exc))
            report.progress('inventory_' + side, entries=len(result))
    visit(root_fd, '', 0)
    return result


def open_file(root_fd, path, baseline):
    """Open each component without following links or replaced directories."""
    parts = path.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise RuntimeError('Unsafe relative path.')
    fd = os.dup(root_fd)
    relative = ''
    try:
        for name in parts[:-1]:
            relative = relative + '/' + name if relative else name
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            actual = stamp(os.fstat(fd))
            if any(actual[k] != baseline[relative][k] for k in ('dev', 'ino')):
                raise RuntimeError('Parent directory was replaced.')
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            actual = stamp(os.fstat(leaf))
            if (actual != baseline[path] or not stat.S_ISREG(actual['mode']) or actual['nlink'] != 1
                    or actual['dev'] != baseline['']['dev']):
                raise RuntimeError('File changed or is not a single-link regular file on expected filesystem.')
            return leaf
        except BaseException:
            os.close(leaf)
            raise
    finally:
        os.close(fd)


def preserved_attributes(value, directory=False):
    keys = ('uid', 'gid', 'mode') if directory else ('uid', 'gid', 'mode', 'size')
    result = {key: value[key] for key in keys}
    result['mtime_seconds'] = value['mtime_ns'] // 1000000000
    return result


def verify_trees(source_fd, target_fd, report):
    emit('verify_inventory_start', note='Full metadata inventory, then full SHA256 reads of both trees.')
    source = inventory(source_fd, 'source', report)
    target = inventory(target_fd, 'target', report)
    emit('verify_inventory_complete', source_entries=len(source), target_entries=len(target), **report.counts)
    for path in sorted(set(source) | set(target)):
        a, b = source.get(path), target.get(path)
        if a is None or b is None:
            report.issue('extra_on_nas' if a is None else 'missing_on_nas', path,
                         source=a, target=b)
            continue
        is_directory = stat.S_ISDIR(a['mode']) and stat.S_ISDIR(b['mode'])
        if is_directory:
            report.record('directory', path=path, source=a, target=b)
            if preserved_attributes(a, True) != preserved_attributes(b, True):
                report.issue('directory_attributes_differ', path)
            continue
        if not (stat.S_ISREG(a['mode']) and stat.S_ISREG(b['mode'])):
            report.issue('file_types_differ_or_unsupported', path)
            continue
        opened = []
        try:
            source_file = open_file(source_fd, path, source)
            opened.append(source_file)
            target_file = open_file(target_fd, path, target)
            opened.append(target_file)
            source_hash = digest(source_file, a['size'])
            target_hash = digest(target_file, b['size'])
            report.counts['hashed_pairs'] += 1
            report.counts['hashed_source_bytes'] += a['size']
            report.counts['hashed_target_bytes'] += b['size']
            stable = stamp(os.fstat(source_file)) == a and stamp(os.fstat(target_file)) == b
            content_matches = source_hash == target_hash
            attrs_match = preserved_attributes(a) == preserved_attributes(b)
            basename = path.rsplit('/', 1)[-1]
            named_hash = basename.split('.')[0] if re.fullmatch(r'[0-9a-f]{64}\.[A-Za-z0-9]{1,12}', basename) else None
            name_matches = named_hash is None or source_hash == named_hash
            report.record('file', path=path, source=a, target=b, source_sha256=source_hash,
                          target_sha256=target_hash, stable_during_read=stable,
                          content_matches=content_matches, attributes_match=attrs_match,
                          source_hash_name_matches=name_matches)
            if not stable:
                report.issue('changed_during_hash', path)
            if not content_matches:
                report.issue('content_differs', path)
            if not attrs_match:
                report.issue('file_attributes_differ', path)
            if not name_matches:
                report.issue('source_hash_filename_differs', path)
            if stable and content_matches and attrs_match and name_matches:
                report.counts['matched_files'] += 1
                report.counts['matched_bytes'] += a['size']
        except (OSError, RuntimeError) as exc:
            report.issue('file_read_error_or_change', path, error=str(exc))
        finally:
            for fd in reversed(opened):
                os.close(fd)
        report.progress('sha256')
    # A file successfully read hours ago can change before this scan finishes.
    # Re-enumerate both complete namespaces, including empty directories/extras.
    emit('verify_recheck_start', **report.counts)
    for side, fd, before in (('source', source_fd, source), ('target', target_fd, target)):
        after = inventory(fd, side + '_after', report)
        for path in sorted(set(before) | set(after)):
            if before.get(path) != after.get(path):
                report.issue('changed_since_inventory', path, side=side,
                             before=before.get(path), after=after.get(path))


def open_reports():
    fd = os.open('/', DIR_FLAGS)
    try:
        for index, name in enumerate(REPORT_ROOT.strip('/').split('/')):
            if index >= 2:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('Unsafe local report parent: ' + name)
        fs_type = subprocess.check_output(['findmnt', '-rn', '-T', REPORT_ROOT, '-o', 'FSTYPE'],
                                         universal_newlines=True, timeout=15).strip()
        if fs_type not in ('xfs', 'ext4', 'btrfs'):
            raise RuntimeError('Reports require a local xfs/ext4/btrfs filesystem.')
        capacity = os.fstatvfs(fd)
        if capacity.f_bavail * capacity.f_frsize < 1024 ** 3:
            raise RuntimeError('Less than 1 GiB free on local report filesystem.')
        return fd
    except BaseException:
        os.close(fd)
        raise


def require_complete(state):
    if state.get('phase') != 'precopy_pass_complete' or state.get('last_exit_code') != 0:
        raise RuntimeError('A successful pre-copy pass is required first; do not change the marker manually.')


def main():
    if (len(sys.argv) != 3 or sys.argv[1] not in VOLUMES or sys.argv[2] != '--verify'
            or not sys.platform.startswith('linux') or os.geteuid() != 0):
        raise SystemExit('Use sudo bash scripts/nas-verify.sh <known-volume> --verify on Linux.')
    volume = sys.argv[1]
    held = []
    report_path = None
    try:
        check_host()
        lock = os.open('/run/lock/mx-static-nas-sample.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        held.append(lock)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe migration lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source_path = checked_root(volume)
        source = os.open(source_path, DIR_FLAGS)
        held.append(source)
        info = os.fstat(source)
        if info.st_dev != os.stat('/dev/nvme0n1p1').st_rdev or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unexpected SSD source identity or unsafe root ownership/mode.')
        fingerprint, records = check_consumers(volume, with_records=True)
        parent = open_parent()
        held.append(parent)
        job, target, state = open_job(parent, volume, source, fingerprint, create=False, records=records)
        held.extend((job, target))
        require_complete(state)
        reports = open_reports()
        held.append(reports)
        name = volume + '-' + uuid.uuid4().hex
        os.mkdir(name, 0o700, dir_fd=reports)
        output = os.open(name, DIR_FLAGS, dir_fd=reports)
        held.append(output)
        os.fsync(reports)
        report_path = REPORT_ROOT + '/' + name
        metadata = dict(schema=1, tool='mx-static-nas-verify', volume=volume,
                        precopy_state=state, source=source_path, target=state['target'],
                        started_at_unix=time.time(), report_directory=report_path)
        emit('verify_start', **metadata)
        ledger_fd = os.open('files.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output)
        with os.fdopen(ledger_fd, 'wb') as stream:
            report = Report(stream)
            report.record('header', **metadata)
            verify_trees(source, target, report)
            if check_consumers(volume) != fingerprint or read_state(job) != state:
                report.issue('deployment_or_precopy_marker_changed', '')
            # Reopen the complete registered paths to detect rename/remount of roots.
            fresh_source = os.open(checked_root(volume), DIR_FLAGS)
            held.append(fresh_source)
            fresh_parent = open_parent()
            held.append(fresh_parent)
            fresh_job, fresh_target, fresh_state = open_job(fresh_parent, volume, fresh_source, fingerprint, create=False, records=records)
            held.extend((fresh_job, fresh_target))
            if (fresh_state != state or
                    (os.fstat(fresh_target).st_dev, os.fstat(fresh_target).st_ino) !=
                    (os.fstat(target).st_dev, os.fstat(target).st_ino)):
                report.issue('registered_target_changed', '')
            stream.flush()
            os.fsync(stream.fileno())
        result = dict(metadata, finished_at_unix=time.time(), phase='online_verification_complete',
                      observed_match=report.counts['issues'] == 0, counts=report.counts,
                      issues_first_20=report.first_issues, ledger_sha256=report.sha256.hexdigest(),
                      consistent_snapshot=False, cutover_ready=False, reclaim_ready=False)
        result_fd = os.open('result.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output)
        with os.fdopen(result_fd, 'w') as stream:
            json.dump(result, stream, ensure_ascii=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(output)
        emit('verify_result', **result)
        return 0 if result['observed_match'] else 2
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        emit('verify_failed', error=str(exc), report_directory=report_path,
             cutover_ready=False, reclaim_ready=False,
             note='Keep both media trees. Missing/incomplete result is not a completed verification.')
        return 1
    finally:
        for fd in reversed(held):
            os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
