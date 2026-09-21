#!/usr/bin/env python3
"""Guarded online rsync pre-copy. No stop, cutover, deletion or reclamation."""
import fcntl
import hashlib
import itertools
import math
import json
import os
import re
import socket
import stat
import subprocess
import sys
import time
import uuid

from layout import MEDIA_ROOT, VOLUMES
from media import checked_root
from permissions import emit, open_parent
from sample_copy import DIR_FLAGS, descriptor_path

MARKER = '.mx-static-precopy.json'
PROJECTS = {'po_infra_media_data': 'mx_data', 'delta_59202_media_data': 'delta_59202'}
SERVICES = {'web', 'worker', 'beat', 'worker-agent-short', 'worker-agent-long',
            'worker-agent-interactive', 'worker-agent-data-hub', 'worker-strategy-draft',
            'chat-gateway', 'gateway'}


def check_host():
    if socket.gethostname().split('.')[0] != 'mx-internal-server':
        raise RuntimeError('This migration is registered only for mx-internal-server.')
    if not stat.S_ISSOCK(os.stat('/var/run/docker.sock').st_mode):
        raise RuntimeError('Expected local Docker socket is unavailable.')
    # Restrict this process and its children to the local daemon. No CLI config changes.
    os.environ.pop('DOCKER_CONTEXT', None)
    os.environ.pop('DOCKER_TLS_VERIFY', None)
    os.environ.pop('DOCKER_CERT_PATH', None)
    os.environ['DOCKER_HOST'] = 'unix:///var/run/docker.sock'
    identity = subprocess.check_output(
        ['docker', 'info', '--format', '{{.Name}} {{.DockerRootDir}}'],
        universal_newlines=True, timeout=30).split()
    if identity != ['mx-internal-server', '/data/docker']:
        raise RuntimeError('Unexpected local Docker daemon identity or data root.')


def source_identity(fd):
    info = os.fstat(fd)
    return {'device': info.st_dev, 'inode': info.st_ino}


def inspect_containers():
    ids = subprocess.check_output(['docker', 'ps', '-aq'], universal_newlines=True, timeout=30).split()
    return json.loads(subprocess.check_output(['docker', 'inspect'] + ids, timeout=30)) if ids else []


def records_digest(records):
    return hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()


def check_consumers(volume, containers=None, with_records=False):
    if containers is None:
        containers = inspect_containers()
    selected = []
    destination = MEDIA_ROOT + '/' + volume + '/data_hub_raw_media'
    nas_volume = PROJECTS[volume] + '_raw_media_nfs_v1'
    for container in containers:
        mounts = container.get('Mounts', [])
        for mount in mounts:
            path = mount.get('Source', '').rstrip('/')
            if mount.get('Name') == nas_volume or path == destination or path.startswith(destination + '/'):
                raise RuntimeError('NAS destination already attached to a container; refuse pre-copy over live data.')
        if not any(m.get('Name') == volume for m in mounts):
            continue
        labels = (container.get('Config') or {}).get('Labels') or {}
        service = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') != PROJECTS[volume] or service not in SERVICES:
            raise RuntimeError('Unexpected source volume consumer: ' + container.get('Name', '?'))
        parents = [m for m in mounts if m.get('Name') == volume and m.get('Destination') == '/app/media']
        if len(parents) != 1 or any(m.get('Destination', '').startswith('/app/media/data_hub_raw_media') for m in mounts):
            raise RuntimeError('Source consumer has changed media mounts; refuse pre-copy.')
        selected.append({'id': container['Id'], 'service': service, 'image': container['Image'],
                         'mounts': sorted(mounts, key=lambda m: json.dumps(m, sort_keys=True))})
    if len(selected) != len(SERVICES) or {c['service'] for c in selected} != SERVICES:
        raise RuntimeError('Expected exactly ten consumers for this instance; inspect deployment first.')
    selected.sort(key=lambda c: c['service'])
    fingerprint = records_digest(selected)
    return (fingerprint, selected) if with_records else fingerprint


def matches_fingerprint(expected, fingerprint, records=None):
    if expected == fingerprint:
        return True
    if (records is None or records_digest(records) != fingerprint
            or not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected)):
        return False
    # Schema 1 markers recorded unsorted Docker Mounts arrays. Prove an exact
    # old hash match by varying ONLY array order; never replace/rebase a marker.
    # This deployment normally has 2!*3! = 12 variants. Bound work before
    # materializing permutations; unexpected complexity needs manual review.
    count = 1
    for record in records:
        size = len(record['mounts'])
        if size > 6:
            raise RuntimeError('Legacy mount-order matching exceeds its limit; review deployment.')
        count *= math.factorial(size)
        if count > 4096:
            raise RuntimeError('Legacy mount-order matching exceeds its limit; review deployment.')
    choices = [itertools.permutations(record['mounts']) for record in records]
    for ordering in itertools.product(*choices):
        variant = [dict(record, mounts=list(mounts)) for record, mounts in zip(records, ordering)]
        if records_digest(variant) == expected:
            emit('consumer_fingerprint_legacy_match',
                 note='Exact old marker hash matched after Mounts order normalization; marker unchanged.')
            return True
    return False


def child_directory(parent, name, create=False):
    created = False
    if create:
        try:
            os.mkdir(name, 0o750, dir_fd=parent)
            created = True
        except FileExistsError:
            pass
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if info.st_dev != os.fstat(parent).st_dev:
            raise RuntimeError('Destination has an unexpected submount.')
        if created:
            os.fchmod(fd, 0o750)
        elif info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise RuntimeError('Existing migration directory is not private to its owner: ' + name)
        return fd, created
    except BaseException:
        os.close(fd)
        raise


def read_state(job_fd):
    fd = os.open(MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=job_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('Unsafe migration marker.')
        with os.fdopen(os.dup(fd)) as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise RuntimeError('Migration marker too large.')
        return json.loads(raw)
    finally:
        os.close(fd)


def write_state(job_fd, state):
    name = '.state-' + uuid.uuid4().hex + '.tmp'
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=job_fd)
    with os.fdopen(fd, 'w') as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.rename(name, MARKER, src_dir_fd=job_fd, dst_dir_fd=job_fd)
    os.fsync(job_fd)


def open_job(parent_fd, volume, source_fd, fingerprint, create, records=None):
    opened = []
    try:
        current = parent_fd
        for part in ('data', 'docker', 'media-volumes'):
            current, _ = child_directory(current, part, create=create)
            opened.append(current)
        job_fd, created = child_directory(current, volume, create=create)
        opened.append(job_fd)
        if created:
            target_fd, _ = child_directory(job_fd, 'data_hub_raw_media', create=True)
            opened.append(target_fd)
            state = {'schema': 1, 'job_id': uuid.uuid4().hex, 'volume': volume,
                     'source_identity': source_identity(source_fd), 'consumer_fingerprint': fingerprint,
                     'target_inode': os.fstat(target_fd).st_ino, 'phase': 'prepared',
                     'target': MEDIA_ROOT + '/' + volume + '/data_hub_raw_media',
                     'cutover_ready': False, 'reclaim_ready': False}
            write_state(job_fd, state)
        else:
            state = read_state(job_fd)  # No marker: refuse, even if the directory looks empty.
            if (state.get('schema') != 1 or state.get('volume') != volume
                    or state.get('source_identity') != source_identity(source_fd)
                    or not matches_fingerprint(state.get('consumer_fingerprint'), fingerprint, records)
                    or state.get('target') != MEDIA_ROOT + '/' + volume + '/data_hub_raw_media'
                    or state.get('phase') not in ('prepared', 'precopy_running', 'precopy_pass_complete', 'precopy_failed')
                    or state.get('cutover_ready') is not False or state.get('reclaim_ready') is not False):
                raise RuntimeError('Migration marker/deployment changed or copy is sealed; review before resuming.')
            if not isinstance(state.get('job_id'), str) or len(state['job_id']) != 32:
                raise RuntimeError('Invalid job identity.')
            int(state['job_id'], 16)
            target_fd, _ = child_directory(job_fd, 'data_hub_raw_media')
            opened.append(target_fd)
            if os.fstat(target_fd).st_ino != state.get('target_inode'):
                raise RuntimeError('Destination directory replaced; refusing to reuse it.')
        # Keep only the descriptors needed for copying/state writes.
        for fd in opened[:-2]:
            os.close(fd)
        return job_fd, target_fd, state
    except BaseException:
        for fd in reversed(opened):
            os.close(fd)
        raise


def copy_command(source_fd, target_fd, state, unlimited=False):
    return ['rsync', '-a', '--numeric-ids', '--one-file-system', '--info=progress2', '--stats', '--outbuf=N',
            '--bwlimit=0' if unlimited else '--bwlimit=61440',
            '--partial-dir=.mx-static-partial-' + state['job_id'], '--',
            descriptor_path(source_fd) + '/', descriptor_path(target_fd) + '/']


def run_rsync(command, pass_fds):
    # rsync progress uses carriage returns. Decode them as lines, then emit JSON
    # so journald does not collect giant non-printable "blob data" records.
    environment = dict(os.environ, LC_ALL='C')
    progress = re.compile(r'^\s*[0-9,]+\s+[0-9]+%\s+\S+/s\s+')
    last_progress = float('-inf')
    pending = None
    with subprocess.Popen(command, pass_fds=pass_fds, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, universal_newlines=True,
                          encoding='utf-8', errors='replace', bufsize=1,
                          env=environment) as process:
        for raw in iter(lambda: process.stdout.readline(16384), ''):
            line = raw.strip()
            if not line:
                continue
            if progress.match(line):
                pending = line
                now = time.monotonic()
                if now - last_progress >= 5:
                    emit('rsync_progress', text=pending)
                    pending = None
                    last_progress = now
            else:
                # Never suppress errors or the final --stats output.
                emit('rsync_output', text=line)
        if pending is not None:
            emit('rsync_progress', text=pending)
        return process.wait()


def main():
    if (len(sys.argv) not in (3, 4) or sys.argv[1] not in VOLUMES or sys.argv[2] not in ('--copy', '--status')
            or (len(sys.argv) == 4 and (sys.argv[2] != '--copy' or sys.argv[3] != '--unlimited'))
            or not sys.platform.startswith('linux') or os.geteuid() != 0):
        raise SystemExit('Use sudo bash scripts/nas-precopy.sh <known-volume> --copy [--unlimited] or --status on Linux.')
    volume, mode = sys.argv[1:3]
    unlimited = len(sys.argv) == 4
    held = []
    try:
        check_host()
        # Same lock as sample_copy; never compete with the other volume/test.
        lock = os.open('/run/lock/mx-static-nas-sample.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        held.append(lock)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe migration lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source = os.open(checked_root(volume), DIR_FLAGS)
        held.append(source)
        if os.fstat(source).st_dev != os.stat('/dev/nvme0n1p1').st_rdev:
            raise RuntimeError('Source descriptor is not on the expected SSD.')
        if os.fstat(source).st_uid != 0 or os.fstat(source).st_mode & 0o022:
            raise RuntimeError('Source root ownership/mode needs review before creating a resumable target.')
        fingerprint, records = check_consumers(volume, with_records=True)
        parent = open_parent()
        held.append(parent)
        if mode == '--copy':
            capacity = os.fstatvfs(parent)
            if capacity.f_bavail * capacity.f_frsize < 2 * 1024 ** 4:
                raise RuntimeError('Less than 2 TiB NAS free space; review capacity/quota before copying.')
        job, target, state = open_job(parent, volume, source, fingerprint, create=mode == '--copy', records=records)
        held.extend((job, target))
        if mode == '--status':
            emit('precopy_state', **state)
            return 0
        state.update(phase='precopy_running', started_at_unix=time.time(), last_exit_code=None,
                     bandwidth_limit_mib_per_second=0 if unlimited else 60)
        write_state(job, state)
        emit('precopy_start', target=state['target'], bandwidth_limit_mib_per_second=0 if unlimited else 60,
             bandwidth_unlimited=unlimited,
             note='Online pre-copy only. No stop, cutover or deletion. Keep all original files.')
        exit_code = run_rsync(copy_command(source, target, state, unlimited=unlimited), (source, target, lock))
        state.update(last_exit_code=exit_code, finished_at_unix=time.time(),
                     phase='precopy_pass_complete' if exit_code == 0 else 'precopy_failed')
        write_state(job, state)
        emit('precopy_result', **state)
        return 0 if exit_code == 0 else 1
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        emit('precopy_refused_or_failed', error=str(exc),
             note='Keep source and target. No cutover/reclamation. An interrupted marker is not completion.')
        return 1
    finally:
        for fd in reversed(held):
            os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
