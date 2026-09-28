"""Explicit additive continuation of a completed delta pre-copy after redeploy.

The legacy marker is immutable. A new local report binds today's SSD consumers
and a union manifest. Only missing NAS files can be published, with no replace.
This is NOT a cutover adapter. No Compose, service, database or queue mutations.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

import cutover_prepare as private_reports
import precopy
import reclaim_plan
from media import checked_root
from permissions import emit, open_parent
from projects.infra_storage import kernel_mounts
# Only project-independent file primitives; never call infra operation/execute.
from projects.infra_repair import compare
from projects import infra_repair_copy as files
from reclaim import private_file
from sample_copy import DIR_FLAGS
from verify import Report, open_file, stamp

PROJECT = 'delta_59202'
VOLUME = PROJECT + '_media_data'
NFS_VOLUME = PROJECT + '_raw_media_nfs_v1'
RAW = '/app/media/data_hub_raw_media'
SSD_PARENT = '/data/docker/volumes/' + VOLUME + '/_data'
SOURCE = SSD_PARENT + '/data_hub_raw_media'
TARGET = precopy.MEDIA_ROOT + '/' + VOLUME + '/data_hub_raw_media'
EXPORT_TARGET = '/volume1/data1' + TARGET[len('/mnt/nas'):]
REPORT_ROOT = '/var/lib/mx-static/nas-precopy-continuation'
# Scope ceilings, not rate limits. Independent of infra's small repair budget.
MAX_FILES = 400000
MAX_BYTES = 2 * 1024 ** 4
MAX_MANIFEST_BYTES = 512 * 1024 ** 2


def reviewed(profile):
    if ((profile.get('project'), profile.get('volume'), profile.get('nfs_volume')) !=
            (PROJECT, VOLUME, NFS_VOLUME) or profile.get('report') or profile.get('plan')):
        raise RuntimeError('Continuation requires the unmigrated delta / part2 registration.')
    planned = {'storage_file': 'part2.storage.json', 'recovery_mode': 'delta-media-v1',
               'runtime_file': 'part2.runtime.json', 'release_file': 'part2.release.json'}
    if any(profile.get(k) for k in planned) and any(profile.get(k) != v for k, v in planned.items()):
        raise RuntimeError('Unreviewed delta planned storage contract.')


def overlaps(a, b):
    a, b = os.path.normpath(a), os.path.normpath(b)
    return a == b or a.startswith(b.rstrip('/') + '/') or b.startswith(a.rstrip('/') + '/')


def current(manager):
    """Prove the current ten readers/writers are still on the local SSD."""
    rows = precopy.inspect_containers()
    fingerprint, records = precopy.check_consumers(VOLUME, rows, True)
    ids = {r['id'] for r in records}
    consumers = {c['Config']['Labels']['com.docker.compose.service']: c for c in rows if c['Id'] in ids}
    reclaim_plan.health_guard(consumers)
    # Bind mounts and alternate volume definitions must not hide another writer.
    names = sorted({m['Name'] for c in rows for m in c.get('Mounts', []) if m.get('Type') == 'volume'})
    definitions = json.loads(manager.run(['docker', 'volume', 'inspect'] + names)) if names else []
    if {v['Name'] for v in definitions} != set(names):
        raise RuntimeError('Incomplete Docker volume inspection.')
    for v in definitions:
        options = v.get('Options') or {}
        device = options.get('device', '')
        remote_path = device.split(':', 1)[-1]
        if ((device.startswith('/') and any(overlaps(device, p) for p in (SOURCE, TARGET)))
                or (remote_path.startswith('/') and overlaps(remote_path, EXPORT_TARGET))):
            raise RuntimeError('An attached volume aliases delta source/NAS media: ' + v['Name'])
    for c in rows:
        for m in c.get('Mounts', []):
            path = m.get('Source', '')
            if path.startswith('/') and any(overlaps(path, p) for p in
                    (SOURCE, TARGET, '/data/docker/volumes/' + NFS_VOLUME + '/_data')):
                if not (c['Id'] in ids and m.get('Type') == 'volume' and m.get('Name') == VOLUME
                        and m.get('Destination') == '/app/media' and path == SSD_PARENT):
                    raise RuntimeError('An extra Docker mount can access delta media: ' + c['Id'][:12])
    kernels = {}
    for name, c in sorted(consumers.items()):
        mounts = c['Mounts']
        parents = [m for m in mounts if m.get('Destination') == '/app/media']
        if (len(parents) != 1 or parents[0].get('Type') != 'volume'
                or parents[0].get('Name') != VOLUME or parents[0].get('Source') != SSD_PARENT
                or parents[0].get('RW') is not (name != 'gateway')
                or any(m.get('Destination', '').startswith(RAW + '/') for m in mounts)):
            raise RuntimeError('Unexpected delta SSD mount: ' + name)
        state = c['State']
        pid = state.get('Pid')
        if type(pid) is not int or pid <= 0:
            raise RuntimeError('Missing running PID: ' + name)
        table = kernel_mounts(Path('/proc/{}/mountinfo'.format(pid)).read_text())
        covering = [m for m in table if overlaps(m['target'], RAW)]
        best = max((m for m in covering if RAW == m['target'] or RAW.startswith(m['target'].rstrip('/') + '/')),
                   key=lambda m: len(m['target']))
        expected_mode = 'ro' if name == 'gateway' else 'rw'
        if (best['target'] != '/app/media' or best['root'] != SSD_PARENT[len('/data'):]
                or best['type'] != 'xfs' or best['source'] != '/dev/nvme0n1p1'
                or expected_mode not in best['options']
                or any(m['target'] == RAW or m['target'].startswith(RAW + '/') for m in covering)):
            raise RuntimeError('Kernel does not confirm delta SSD media: ' + name)
        kernels[name] = {'pid': pid, 'started_at': state.get('StartedAt'), 'mount': best}
    return {'consumer_fingerprint': fingerprint, 'consumers': records, 'kernel_sources': kernels}


def read_private(fd, name, limit=32 * 1024 ** 2):
    leaf = private_file(fd, name, os.O_RDONLY)
    with os.fdopen(leaf, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if before.st_nlink != 1 or before.st_size > limit:
            raise RuntimeError('Invalid private receipt: ' + name)
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        if len(raw) > limit or stamp(before) != stamp(after):
            raise RuntimeError('Private receipt changed while reading: ' + name)
        return json.loads(raw.decode('utf-8')), hashlib.sha256(raw).hexdigest()


def open_absolute(path, private=False):
    fd = os.open('/', DIR_FLAGS)
    try:
        for part in path.strip('/').split('/'):
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            if private and (info.st_uid != 0 or info.st_mode & 0o022):
                raise RuntimeError('Unsafe continuation report path.')
        if private and os.fstat(fd).st_mode & 0o077:
            raise RuntimeError('Continuation report must be root-private.')
        return fd
    except BaseException:
        os.close(fd)
        raise


def validate_path(path):
    if not re.fullmatch(re.escape(REPORT_ROOT) + r'/delta-[0-9a-f]{32}', path):
        raise RuntimeError('Use the exact delta copy prepare report directory.')


def marker_check(marker, source, target):
    expected = {'schema': 1, 'volume': VOLUME, 'source_identity': precopy.source_identity(source),
                'target': TARGET, 'target_inode': os.fstat(target).st_ino,
                'phase': 'precopy_pass_complete', 'last_exit_code': 0,
                'cutover_ready': False, 'reclaim_ready': False}
    if (any(marker.get(k) != v or type(marker.get(k)) is not type(v) for k, v in expected.items())
            or not re.fullmatch('[0-9a-f]{32}', str(marker.get('job_id', '')))
            or not re.fullmatch('[0-9a-f]{64}', str(marker.get('consumer_fingerprint', '')))
            or marker.get('nas_may_have_writes') or marker.get('report_directory')):
        raise RuntimeError('Legacy marker identity/phase is not a completed, unsealed delta pre-copy.')


@contextlib.contextmanager
def media():
    held = []
    try:
        if checked_root(VOLUME) != SOURCE:
            raise RuntimeError('Unexpected delta source path.')
        source = open_absolute(SOURCE); held.append(source)
        info = os.fstat(source)
        if (info.st_dev != os.stat('/dev/nvme0n1p1').st_rdev
                or info.st_uid != 0 or info.st_mode & 0o022):
            raise RuntimeError('Delta SSD root identity/ownership requires review.')
        parent = open_parent(); held.append(parent)
        for part in ('data', 'docker', 'media-volumes', VOLUME):
            parent, _ = precopy.child_directory(parent, part); held.append(parent)
        job = parent
        target, _ = precopy.child_directory(job, 'data_hub_raw_media'); held.append(target)
        marker, sha = read_private(job, precopy.MARKER, 65536)
        marker_check(marker, source, target)
        yield {'source': source, 'target': target, 'job': job, 'marker': marker, 'marker_sha256': sha,
               'source_identity': precopy.source_identity(source), 'target_identity': precopy.source_identity(target),
               'job_identity': precopy.source_identity(job)}
    finally:
        for fd in reversed(held): os.close(fd)


def identity(view):
    return {k: v for k, v in view.items() if k not in ('source', 'target', 'job')}


def guard(manager, profile, baseline, expected, report_fd=None, plan=None):
    reviewed(profile)
    if manager.profiles()['part2'] != profile or current(manager) != baseline:
        raise RuntimeError('Delta registration/consumers changed; prepare a new continuation report.')
    with media() as observed:
        if identity(observed) != expected:
            raise RuntimeError('Delta source/NAS identity or legacy marker changed; stop additions.')
    if report_fd is not None:
        reopened = open_absolute(plan['report_directory'], private=True)
        try:
            if (precopy.source_identity(reopened) != precopy.source_identity(report_fd)
                    or read_private(reopened, 'plan.json')[0] != plan):
                raise RuntimeError('Continuation report changed; stop additions.')
        finally: os.close(reopened)


def new_report(manager):
    parent = manager.secure_directory(REPORT_ROOT)
    try:
        if manager.run(['findmnt', '-rn', '-T', REPORT_ROOT, '-o', 'FSTYPE']).strip() not in ('xfs', 'ext4', 'btrfs'):
            raise RuntimeError('Continuation reports require a local filesystem.')
        space = os.fstatvfs(parent)
        if space.f_bavail * space.f_frsize < 1024 ** 3:
            raise RuntimeError('Less than 1 GiB available for continuation reports.')
        name = 'delta-' + uuid.uuid4().hex
        os.mkdir(name, 0o700, dir_fd=parent)
        fd = os.open(name, DIR_FLAGS, dir_fd=parent); os.fsync(parent)
        return REPORT_ROOT + '/' + name, fd
    finally: os.close(parent)


def manifest(fd, plan):
    return files.read_manifest(fd, plan, MAX_FILES, MAX_BYTES, MAX_MANIFEST_BYTES)


def prepare(manager, profile):
    reviewed(profile)
    path, output = new_report(manager)
    emit('nas_delta_copy_prepare_started', report_directory=path, media_write=False)
    try:
        baseline = current(manager)
        with media() as view:
            expected = identity(view)
            private_reports.private_write(output, 'baseline.private.json', baseline)
            private_reports.private_write(output, 'legacy-marker.json', view['marker'])
            leaf = private_file(output, 'union-manifest.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            with os.fdopen(leaf, 'wb') as stream:
                report = Report(stream)
                plan = compare(view['source'], view['target'], report)
                stream.flush(); os.fsync(stream.fileno())
                plan['manifest_sha256'] = report.sha256.hexdigest()
            manifest(output, plan)  # Validate executable scope before publishing a ready plan.
            guard(manager, profile, baseline, expected)
            plan.update(schema=1, phase='prepared', project=PROJECT, volume=VOLUME, report_directory=path,
                        media_identity=expected, baseline=baseline, time_unix=time.time(), marker_changed=False,
                        production_restart=False, source_deleted=False, reclaim_ready=False)
            private_reports.private_write(output, 'plan.json', plan); os.fsync(output)
            emit('nas_delta_copy_prepared', report_directory=path, groups=plan['groups'],
                 legacy_consumer_fingerprint=view['marker']['consumer_fingerprint'],
                 current_consumer_fingerprint=baseline['consumer_fingerprint'],
                 marker_changed=False, media_write=False, reclaim_ready=False)
            return path
    except BaseException as exc:
        private_reports.private_write(output, 'failed.json', {'error': str(exc), 'media_write': False})
        emit('nas_delta_copy_prepare_failed', report_directory=path, error=str(exc))
        raise
    finally: os.close(output)


def execute(manager, profile, path):
    reviewed(profile); validate_path(path)
    output = open_absolute(path, private=True)
    attempt = stage = journal = None
    attempt_path = None
    try:
        plan = read_private(output, 'plan.json')[0]
        if (plan.get('schema') != 1 or plan.get('phase') != 'prepared' or plan.get('project') != PROJECT
                or plan.get('volume') != VOLUME or plan.get('report_directory') != path
                or plan.get('reclaim_ready') is not False or plan.get('source_deleted') is not False):
            raise RuntimeError('Invalid delta continuation plan.')
        tree, dirs, paths = manifest(output, plan)
        baseline, expected = plan['baseline'], plan['media_identity']
        guard(manager, profile, baseline, expected, output, plan)
        with media() as view:
            if identity(view) != expected:
                raise RuntimeError('Delta media changed before opening copy descriptors.')
            source, target, job = view['source'], view['target'], view['job']
            tree, changes = files.recheck_sources(source, tree, paths)
            for name in paths:
                fd = open_file(source, name, tree); os.close(fd)
                fd = files.target_parent(target, name, dirs); os.close(fd)
            space = os.fstatvfs(target)
            if space.f_bavail * space.f_frsize < sum(tree[p]['size'] for p in paths) + 1024 ** 3:
                raise RuntimeError('NAS capacity is below candidate bytes plus 1 GiB reserve.')
            guard(manager, profile, baseline, expected, output, plan)
            token = uuid.uuid4().hex
            attempt_name = 'copy-' + token
            os.mkdir(attempt_name, 0o700, dir_fd=output)
            attempt = os.open(attempt_name, DIR_FLAGS, dir_fd=output)
            attempt_path = path + '/' + attempt_name
            stage_name = '.mx-static-delta-copy-' + token
            private_reports.private_write(attempt, 'started.json', {'plan_sha256': read_private(output, 'plan.json')[1],
                'stage_name': stage_name, 'source_revalidation': changes, 'bandwidth_unlimited': True})
            os.fsync(attempt); os.fsync(output)
            os.mkdir(stage_name, 0o700, dir_fd=job)
            stage = os.open(stage_name, DIR_FLAGS, dir_fd=job)
            if (os.fstat(stage).st_dev != os.fstat(target).st_dev or os.fstat(stage).st_mode & 0o077
                    or os.fstat(stage).st_uid != os.geteuid()):
                raise RuntimeError('Staging is not private on the expected NAS filesystem.')
            os.fsync(job)
            journal = private_file(attempt, 'copy.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND)
            os.fsync(attempt)
            files.append(journal, 'stage_directory', name=stage_name, identity=precopy.source_identity(stage))
            copied = present = total = 0
            emit('nas_delta_copy_started', report_directory=path, attempt_directory=attempt_path,
                 candidates=len(paths), bandwidth_unlimited=True, production_restart=False)
            last_guard = last_progress = time.monotonic()
            for index, name in enumerate(paths, 1):
                try:
                    outcome, _ = files.copy_one(source, target, stage, name, tree, dirs, journal)
                except (OSError, RuntimeError) as exc:
                    raise RuntimeError('Copy stopped at: ' + name + '; ' + str(exc))
                copied += int(outcome == 'copied'); present += int(outcome == 'already_present')
                total += tree[name]['size']
                if index % 250 == 0 or time.monotonic() - last_guard >= 10:
                    guard(manager, profile, baseline, expected, output, plan); last_guard = time.monotonic()
                if index % 100 == 0 or time.monotonic() - last_progress >= 10:
                    emit('nas_delta_copy_progress', processed=index, candidates=len(paths), copied=copied,
                         already_present=present, logical_bytes=total)
                    last_progress = time.monotonic()
            guard(manager, profile, baseline, expected, output, plan)
            stage_stat = os.stat(stage_name, dir_fd=job, follow_symlinks=False)
            if {'device': stage_stat.st_dev, 'inode': stage_stat.st_ino} != precopy.source_identity(stage):
                raise RuntimeError('Staging directory changed; retained for review.')
            os.rmdir(stage_name, dir_fd=job); os.fsync(job)  # Only this attempt's empty staging directory.
            result = {'phase': 'manifest_copy_complete', 'volume': VOLUME, 'report_directory': path,
                      'attempt_directory': attempt_path, 'copied': copied, 'already_present': present,
                      'logical_bytes': total, 'bandwidth_unlimited': True, 'marker_changed': False,
                      'production_restart': False, 'source_deleted': False, 'reclaim_ready': False,
                      'source_ctime_revalidated': len(changes), 'live_snapshot': True,
                      'stopped_writer_recheck_required': True}
            private_reports.private_write(attempt, 'result.json', result); os.fsync(attempt)
            emit('nas_delta_copy_complete', **result)
            return result
    except BaseException as exc:
        if attempt is not None:
            private_reports.private_write(attempt, 'failed.json', {'phase': 'failed_or_partial', 'error': str(exc),
                'source_deleted': False, 'marker_changed': False, 'reclaim_ready': False})
            os.fsync(attempt)
        emit('nas_delta_copy_failed', report_directory=path, attempt_directory=attempt_path, error=str(exc))
        raise
    finally:
        for fd in (journal, stage, attempt, output):
            if fd is not None: os.close(fd)
