"""Explicit maintenance repair: retain the UNION, recreate reviewed NAS consumers.

Never call the legacy sync/quarantine/SSD-restore paths. New deployment evidence
lives in a new cutover report; registration and business acceptance stay pending.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

import cutover
import cutover_prepare as prep
import precopy
import reclaim_plan
from permissions import emit
from projects import infra_repair as planning
from projects import infra_repair_copy as copying
from projects import infra_storage
from sample_copy import DIR_FLAGS
from verify import Report, inventory, open_file


def split_attempt(path):
    report, _, name = path.rpartition('/')
    copying.validate_path(report)
    if not re.fullmatch('copy-[0-9a-f]{32}', name):
        raise RuntimeError('Use the exact successful repair copy attempt directory.')
    return report, name


def completed_copy(fd, name, path, plan):
    attempt = os.open(name, DIR_FLAGS, dir_fd=fd)
    try:
        info = os.fstat(attempt)
        if info.st_uid != 0 or info.st_mode & 0o077:
            raise RuntimeError('Copy attempt must be root-private.')
        result = cutover.read_json(attempt, 'result.json')
        started = cutover.read_json(attempt, 'started.json')
        try: os.stat('failed.json', dir_fd=attempt, follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise RuntimeError('Copy attempt also has a failure receipt; review it before switching.')
        totals = plan['groups'].get('ssd_only', {'files': 0, 'logical_bytes': 0})
        if (result.get('phase') != 'manifest_copy_complete' or result.get('attempt_directory') != path
                or result.get('report_directory') != plan['report_directory']
                or any(type(result.get(k)) is not int or result[k] < 0 for k in ('copied', 'already_present', 'logical_bytes'))
                or result['copied'] + result['already_present'] != totals['files']
                or result['logical_bytes'] != totals['logical_bytes']
                or any(result.get(k) is not False for k in ('production_restart', 'source_deleted', 'reclaim_ready'))
                or started.get('manifest_sha256') != plan['manifest_sha256']
                or started.get('report') != plan['report_directory'] or started.get('candidates') != totals['files']):
            raise RuntimeError('Copy completion receipt does not cover the prepared candidate manifest.')
        return result
    finally:
        os.close(attempt)


def new_directory(parent, prefix):
    name = prefix + uuid.uuid4().hex
    os.mkdir(name, 0o700, dir_fd=parent)
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    os.fsync(parent)
    return name, fd


def union_plan(source, target, folder):
    leaf = os.open('union-manifest.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                   0o600, dir_fd=folder)
    with os.fdopen(leaf, 'wb') as stream:
        report = Report(stream)
        plan = planning.compare(source, target, report)
        plan['manifest_sha256'] = report.sha256.hexdigest()
        stream.flush(); os.fsync(stream.fileno())
    prep.private_write(folder, 'union-plan.json', plan); os.fsync(folder)
    tree, dirs, paths = copying.read_manifest(folder, plan)
    return plan, tree, dirs, paths


def media_guard(op):
    saved, count = (op.source, op.target, op.job), len(op.held)
    try:
        op.open_media(sealed=True)
        if any(precopy.source_identity(a) != precopy.source_identity(b)
               for a, b in zip(saved, (op.source, op.target, op.job))):
            raise RuntimeError('Registered media path changed during repair.')
    finally:
        for fd in reversed(op.held[count:]): os.close(fd)
        del op.held[count:]
        op.source, op.target, op.job = saved


def writer_guard(op, stopped=False):
    rows = op.originals(stopped=stopped)
    all_containers = precopy.inspect_containers()
    ids = {c['Id'] for c in rows.values()}
    nas_paths = (precopy.MEDIA_ROOT + '/' + prep.VOLUME + '/data_hub_raw_media',
                 '/data/docker/volumes/' + prep.NFS_VOLUME + '/_data')
    def touches_nas(mount):
        path = mount.get('Source', '').rstrip('/') or '/'
        return mount.get('Name') == prep.NFS_VOLUME or (mount.get('Type') == 'bind' and any(
            path == '/' or path == root or path.startswith(root + '/') or root.startswith(path + '/')
            for root in nas_paths))
    if reclaim_plan.extra_source_consumers(all_containers, ids) or any(
            c['Id'] not in ids and any(touches_nas(m) for m in c.get('Mounts', []))
            for c in all_containers):
        raise RuntimeError('An unreviewed media consumer appeared; do not stop or recreate it.')
    return rows


def make_operation(manager, profile, attempt_path):
    report_path, name = split_attempt(attempt_path)
    parent = copying.open_report(report_path)
    previous = output = root = None
    old = current = None
    try:
        plan = cutover.read_json(parent, 'repair-plan.json')
        if (plan.get('schema') != 1 or plan.get('phase') != 'prepared' or plan.get('report_directory') != report_path
                or plan.get('historical_report') != profile['report'] or plan.get('volume') != prep.VOLUME
                or plan.get('nfs_volume') != prep.NFS_VOLUME or plan.get('nas_marker', {}).get('phase') != 'cutover_running_on_nas'
                or plan.get('application_image') != planning.APP_IMAGE or plan.get('gateway_image') != planning.GATEWAY_IMAGE
                or plan.get('execution_allowed') is not False or plan.get('reclaim_ready') is not False):
            raise RuntimeError('Unexpected reviewed repair plan.')
        copying.read_manifest(parent, plan)
        receipt = completed_copy(parent, name, attempt_path, plan)
        baseline = cutover.read_json(parent, 'deployment-baseline.private.json')
        previous = cutover.open_report(profile['report'])
        old = cutover.Cutover(profile['report'], previous)
        old.state = cutover.read_json(previous, 'execution.json')
        reclaim_plan.require_completed(old.state, old.path)
        old.open_media(sealed=True)
        copying.deployment_guard(manager, old, plan, baseline, parent)
        root = manager.secure_directory(cutover.ROOT)
        fs = os.fstatvfs(root)
        if (manager.run(['findmnt', '-rn', '-T', cutover.ROOT, '-o', 'FSTYPE']).strip() not in ('xfs', 'ext4', 'btrfs')
                or fs.f_bavail * fs.f_frsize < 1024 ** 3):
            raise RuntimeError('A local filesystem with 1 GiB free is required for repair evidence.')
        report_name, output = new_directory(root, prep.VOLUME + '-')
        path = cutover.ROOT + '/' + report_name
        emit('nas_repair_switch_preparing', report_directory=path, production_stopped=False)
        reviewed = planning.deployment(manager, old, output, path)
        if reviewed != baseline:
            raise RuntimeError('Current deployment differs from the completed copy baseline.')
        consumers = cutover.read_json(output, 'containers.private.json')
        for service, container in consumers.items():
            if container.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') != 'unless-stopped':
                raise RuntimeError('Expected unless-stopped restart policy: ' + service)
            if service.startswith('worker') and container['Config'].get('StopSignal', 'SIGTERM') not in ('', 'SIGTERM', '15'):
                raise RuntimeError('Unexpected worker stop signal: ' + service)
        for old_name, new_name in (('compose.current.private.json', 'compose.rendered.private.json'),
                                   ('compose.nas.candidate.json', 'compose.nas.override.json'),
                                   ('compose.nas.candidate.private.json', 'compose.nas.rendered.private.json')):
            prep.private_write(output, new_name, cutover.read_json(output, old_name))
        # An isolated, reviewed image probes its native NFS volume; no app
        # entrypoint, database migration or production container is started.
        probe = json.loads(manager.run(['docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
            '--no-healthcheck', '--user', '0:0', '--entrypoint', 'python', '--mount',
            'type=volume,src=' + prep.NFS_VOLUME + ',dst=/nas,volume-nocopy',
            consumers['web']['Image'], '-c', prep.PROBE, str(plan['nas_marker']['target_inode'])], timeout=None))
        saved = {'schema': 1, 'volume': prep.VOLUME, 'report_directory': path,
                 'precopy_state': plan['nas_marker'], 'review_items': [], 'writable_app_code': {},
                 'production_stopped': False, 'docker_nfs_probe': probe,
                 'config_files_sha256': reviewed['config_files_sha256'],
                 'consumer_fingerprint_normalized': reviewed['consumer_fingerprint'],
                 'verification_policy': 'retained-union-and-stopped-source-metadata; bounded-conflict-hashes',
                 'full_sha256_required': False, 'reclaim_ready': False, 'repair_copy': receipt}
        prep.private_write(output, 'prepare-result.json', saved)
        prep.private_write(output, 'repair-lineage.json', {'schema': 1, 'repair_report': report_path,
            'previous_cutover_report': profile['report'], 'previous_execution': plan['historical_execution'],
            'previous_nas_marker': plan['nas_marker'], 'copy_attempt': attempt_path,
            'original_manifest_sha256': plan['manifest_sha256']})
        os.fsync(output)
        current = cutover.Cutover(path, output)  # Validates candidate, probe, images and all unrelated fields.
        current.state = {'schema': 1, 'volume': prep.VOLUME, 'report_directory': path,
            'databases': dict(old.state['databases']), 'nas_may_have_writes': True,
            'final_sync_passed': False, 'reclaim_ready': False, 'started_at_unix': time.time(),
            'repair_of': profile['report'], 'business_acceptance_pending': True,
            'recovery_registration_pending': True}
        for field in ('source', 'target', 'job'):
            fd = os.dup(getattr(old, field)); current.held.append(fd); setattr(current, field, fd)
        # Reject large/unhandled deltas BEFORE stopping production.
        _, preflight = new_directory(output, 'online-review-')
        try:
            summary, _, _, _ = union_plan(current.source, current.target, preflight)
            emit('nas_repair_switch_delta', groups=summary['groups'], live_snapshot=True)
        finally:
            os.close(preflight)
        copying.deployment_guard(manager, old, plan, baseline, parent)
        current.config_guard(); writer_guard(current)
        current.checkpoint('repair_prepared')  # Also prevents accidental legacy --cutover use.
        current.seal('cutover_in_progress')  # Explicit handover; old marker is retained in lineage.
        result = current, output
        current = None; output = None
        return result
    finally:
        if current is not None: current.close()
        if old is not None: old.close()
        for fd in (root, output, previous, parent):
            if fd is not None: os.close(fd)


def final_union(op):
    """Called only after every reviewed SSD writer has stopped gracefully."""
    writer_guard(op, stopped=True); op.config_guard(); media_guard(op)
    name, folder = new_directory(op.output, 'repair-final-')
    stage = journal = None
    try:
        # Keep the full stopped SSD metadata separately for later reclaim review.
        leaf = os.open('files.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
        with os.fdopen(leaf, 'wb') as stream:
            report = cutover.MetadataReport(stream)
            before = inventory(op.source, 'stopped_ssd', report)
            if report.counts['issues']: raise RuntimeError('Stopped SSD inventory contains unsupported entries.')
            for path in sorted(before): report.record('entry', path=path, metadata=before[path])
            stream.flush(); os.fsync(stream.fileno())
            source_manifest_sha256 = report.sha256.hexdigest()
        _, tree, dirs, paths = union_plan(op.source, op.target, folder)
        fs = os.fstatvfs(op.target)
        if fs.f_bavail * fs.f_frsize < sum(tree[p]['size'] for p in paths) + 1024 ** 3:
            raise RuntimeError('NAS needs remaining candidate bytes plus 1 GiB reserve.')
        stage_name = '.mx-static-repair-final-' + uuid.uuid4().hex
        prep.private_write(folder, 'staging.json', {'name': stage_name, 'candidates': len(paths)})
        os.fsync(folder)
        os.mkdir(stage_name, 0o700, dir_fd=op.job)
        stage = os.open(stage_name, DIR_FLAGS, dir_fd=op.job)
        if os.fstat(stage).st_dev != os.fstat(op.target).st_dev or os.fstat(stage).st_mode & 0o077:
            raise RuntimeError('Unexpected NAS staging filesystem/permissions.')
        journal = copying.private_file(folder, 'copy.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND)
        os.fsync(folder)
        copying.append(journal, 'stage_directory', name=stage_name, identity=precopy.source_identity(stage))
        for index, path in enumerate(paths, 1):
            copying.copy_one(op.source, op.target, stage, path, tree, dirs, journal)
            if index % 100 == 0:
                emit('nas_repair_final_copy_progress', processed=index, candidates=len(paths))
                writer_guard(op, stopped=True); op.config_guard()
        # Retain every NAS-only file and its attributes. No rsync mirror,
        # quarantine, chmod/chown of existing files, or deletion is permitted.
        _, verification = new_directory(folder, 'verify-')
        try:
            result, _, _, missing = union_plan(op.source, op.target, verification)
            if missing: raise RuntimeError('SSD-only files remain after the stopped-writer addition.')
        finally:
            os.close(verification)
        leaf = os.open('source-recheck.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
        with os.fdopen(leaf, 'wb') as stream:
            report = cutover.MetadataReport(stream)
            after = inventory(op.source, 'stopped_ssd_recheck', report)
            if report.counts['issues'] or before != after:
                raise RuntimeError('SSD changed while writers were stopped; no recreation allowed.')
            stream.flush(); os.fsync(stream.fileno())
        choices = [p for p, v in before.items() if stat.S_ISREG(v['mode']) and v['size'] > 1024 and not p.endswith('.tmp')]
        if not choices: raise RuntimeError('No existing media sample for HTTP verification.')
        sample = sorted(choices, key=lambda p: (not p.endswith('.mp4'), p))[0]
        fd = open_file(op.source, sample, before)
        try: sha = hashlib.sha256(os.read(fd, 1024)).hexdigest()
        finally: os.close(fd)
        op.state['sample'] = {'relative': sample, 'size': before[sample]['size'], 'prefix_sha256': sha}
        writer_guard(op, stopped=True); op.config_guard(); media_guard(op); op.identity_probe()
        actual = os.stat(stage_name, dir_fd=op.job, follow_symlinks=False)
        if {'device': actual.st_dev, 'inode': actual.st_ino} != precopy.source_identity(stage):
            raise RuntimeError('Private NAS staging replaced; retained for review.')
        os.rmdir(stage_name, dir_fd=op.job); os.fsync(op.job)
        result.update(source_manifest_sha256=source_manifest_sha256, final_sync_passed=True,
                      live_snapshot=False, stopped_writer_recheck_required=False, reclaim_ready=False)
        prep.private_write(folder, 'result.json', result); os.fsync(folder)
        op.checkpoint('repair_final_passed', final_sync_passed=True, final_review=op.path + '/' + name)
    finally:
        for fd in (journal, stage, folder):
            if fd is not None: os.close(fd)


def finish(manager, profile, op, rows):
    op.http_probe(rows)
    if not infra_storage.check(manager, profile):
        raise RuntimeError('Actual kernel NAS placement check failed after startup.')
    # Probe only exact owned temporary names using each container's default user.
    code = (Path(__file__).parent / 'infra_probe.py').read_text()
    for name, container in sorted(rows.items()):
        if name == 'gateway': continue
        result = json.loads(op.command(['docker', 'exec', container['Id'], 'python', '-c', code,
                                       'probe', str(op.saved['precopy_state']['target_inode'])], timeout=None))
        if not all(result.get(k) is True for k in ('effective_read', 'effective_write', 'effective_search',
                                                 'write_read_rename_passed', 'cleanup_passed')):
            raise RuntimeError('Application NAS access failed: ' + name)
        emit('nas_application_permissions', service=name, **result)
    op.config_guard(); media_guard(op)
    reclaim_plan.health_guard(op.mounted_services(True, expected_ids={n: c['Id'] for n, c in rows.items()}))
    op.seal('cutover_running_on_nas')
    op.checkpoint('running_on_nas', business_acceptance_pending=True, recovery_registration_pending=True)
    emit('nas_repair_switch_complete', **op.state)


def continue_switch(manager, profile, op):
    phase = op.state['phase']
    if op.state.get('new_ids'):
        if not op.state.get('final_sync_passed'): raise RuntimeError('Incomplete final comparison.')
        rows = op.mounted_services(True, expected_ids=op.state['new_ids'])
        if any(c.get('State', {}).get('Restarting') or c.get('State', {}).get('Paused') for c in rows.values()):
            raise RuntimeError('A container is already restarting/paused; do not issue repeated starts.')
        rows = op.start(rows, True)
        return finish(manager, profile, op, rows)
    if phase not in ('repair_prepared', 'repair_stopping', 'repair_finalizing', 'repair_final_passed'):
        raise RuntimeError('Container creation may be partial; inspect identities before resuming.')
    rows = writer_guard(op); op.config_guard(); media_guard(op)
    op.checkpoint('repair_stopping')
    op.stop(rows)
    writer_guard(op, stopped=True)
    op.checkpoint('repair_finalizing', final_sync_passed=False)
    final_union(op)
    op.checkpoint('creating_nas_containers')
    op.command(cutover.create_command(op.path, 'compose.nas.override.json'), timeout=None)
    created = op.mounted_services(True)
    if any(c['State'].get('StartedAt') not in (None, '', '0001-01-01T00:00:00Z') for c in created.values()):
        raise RuntimeError('A recreated NAS container started unexpectedly; do not recopy or restore SSD.')
    cutover.require_stopped(created)
    op.checkpoint('nas_containers_created', new_ids={n: c['Id'] for n, c in created.items()})
    finish(manager, profile, op, op.start(created, True))


def execute(manager, profile, path, resume=False):
    planning.reviewed(profile)
    op = None
    output = None
    try:
        if resume:
            output = cutover.open_report(path)
            lineage = cutover.read_json(output, 'repair-lineage.json')
            if lineage.get('previous_cutover_report') != profile['report']:
                raise RuntimeError('Repair lineage differs from the still-registered historical report.')
            op = cutover.Cutover(path, output)
            op.state = cutover.read_json(output, 'execution.json')
            if (op.state.get('schema') != 1 or op.state.get('volume') != prep.VOLUME
                    or op.state.get('repair_of') != profile['report'] or op.state.get('nas_may_have_writes') is not True
                    or op.state.get('report_directory') != path or op.state.get('reclaim_ready') is not False):
                raise RuntimeError('Invalid repair execution state.')
            op.config_guard(); op.open_media(sealed=True)
        else:
            op, output = make_operation(manager, profile, path)
        continue_switch(manager, profile, op)
    except Exception as exc:
        emit('nas_repair_switch_failed', report_directory=op.path if op else None,
             phase=op.state.get('phase') if op and op.state else 'preflight', error=str(exc),
             reclaim_ready=False, note='May be stopped/partially recreated. No SSD fallback or automatic rollback.')
        raise
    finally:
        if op is not None: op.close()
        if output is not None: os.close(output)
