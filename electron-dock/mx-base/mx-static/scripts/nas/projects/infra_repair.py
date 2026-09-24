"""Prepare an append-only review of the Sep 24 infra storage drift.

Reads media; writes a NEW private local report only. No copy, container creation,
baseline adoption, marker update or cleanup is implemented by this command.
"""
import json
import os
import re
import stat
import subprocess
import time
from types import SimpleNamespace
import uuid

import cutover
import cutover_prepare as prep
import precopy
import reclaim_plan
from permissions import emit
from projects.infra_storage import reviewed
from sample_copy import DIR_FLAGS, digest
from verify import Report, inventory, open_file, preserved_attributes, stamp

REPORT_ROOT = '/var/lib/mx-static/nas-repair'
MAX_HASH_PAIRS = 1000
MAX_HASH_BYTES = 512 * 1024 ** 2  # Both sides combined; never widen automatically.
# Reviewed by the Sep 24 second-fallback inspect receipt; see its incident runbook.
# Recheck scripts, launch fields, live Compose and database identities on every prepare.
APP_IMAGE = 'sha256:f0b13dc7f35c2d317a48be2ff3b6ef97e62b8f007d32c0c8af422377d7b07446'
GATEWAY_IMAGE = 'sha256:6769dc3a703c719c1d2756bda113659be28ae16cf0da58dd5fd823d6b9a050ea'


def new_report(manager):
    parent = manager.secure_directory(REPORT_ROOT)
    try:
        fs = manager.run(['findmnt', '-rn', '-T', REPORT_ROOT, '-o', 'FSTYPE']).strip()
        if fs not in ('xfs', 'ext4', 'btrfs'):
            raise RuntimeError('Repair reports require a local filesystem.')
        capacity = os.fstatvfs(parent)
        if capacity.f_bavail * capacity.f_frsize < 1024 ** 3:
            raise RuntimeError('Less than 1 GiB free for private repair reports.')
        name = 'infra-' + uuid.uuid4().hex
        os.mkdir(name, 0o700, dir_fd=parent)
        fd = os.open(name, DIR_FLAGS, dir_fd=parent)
        os.fsync(parent)
        return REPORT_ROOT + '/' + name, fd
    finally:
        os.close(parent)


def deployment(manager, op, output, report_path):
    """Recheck the reviewed NEW deployment; retain all private values locally."""
    files = prep.file_hashes()
    containers = precopy.inspect_containers()
    fingerprint, records = precopy.check_consumers(prep.VOLUME, containers, True)
    consumers = cutover.select_services(containers)
    reclaim_plan.health_guard(consumers)
    op.databases(containers)  # Keep the original Postgres/Redis identities.
    if reclaim_plan.extra_source_consumers(containers, {c['Id'] for c in consumers.values()}):
        raise RuntimeError('Other Docker consumers can access the source media.')
    config = json.loads(manager.run(prep.compose_command() + ['config', '--format', 'json']))
    prep.private_write(output, 'containers.private.json', consumers)
    prep.private_write(output, 'compose.current.private.json', config)
    issues = prep.validate_config(config, consumers)
    hashes = dict(line.split() for line in manager.run(
        prep.compose_command() + ['config', '--hash', '*']).splitlines() if line.strip())
    probe = ('import hashlib,json; print(json.dumps({p:hashlib.sha256(open("/app/"+p,"rb").read()).hexdigest() '
             'for p in ' + repr(sorted(prep.SCRIPT_HASHES)) + '}))')
    for name, c in sorted(consumers.items()):
        if c['Image'] != (GATEWAY_IMAGE if name == 'gateway' else APP_IMAGE):
            issues.append({'service': name, 'reason': 'unreviewed_image'})
        labels = c['Config'].get('Labels') or {}
        if hashes.get(name) != labels.get('com.docker.compose.config-hash'):
            issues.append({'service': name, 'reason': 'compose_hash_differs'})
        for key in ('Entrypoint', 'Cmd', 'User', 'WorkingDir'):
            if c['Config'].get(key) != op.old[name]['Config'].get(key):
                issues.append({'service': name, 'reason': 'launch_field_changed', 'field': key})
        if name != 'gateway':
            actual = json.loads(manager.run(['docker', 'exec', c['Id'], 'python', '-c', probe]))
            if actual != prep.SCRIPT_HASHES:
                issues.append({'service': name, 'reason': 'startup_script_changed'})
            changes = [line for line in manager.run(['docker', 'diff', c['Id']]).splitlines()
                       if line[2:].startswith('/app/') and line.endswith(('.py', '.sh', '.toml', '.yaml', '.yml', '.json'))
                       and not line[2:].startswith(('/app/media/', '/app/staticfiles/'))]
            if changes:
                issues.append({'service': name, 'reason': 'writable_app_code', 'paths': changes})
        emit('nas_repair_progress', phase='deployment', service=name)
    prep.private_write(output, 'deployment-review.json', {'issues': issues})
    if issues:
        raise RuntimeError('Current deployment review failed; see private deployment-review.json.')
    # This is a NEW candidate pinned to today's images, never the old overlay.
    overlay = prep.candidate(consumers)
    manager.storage_guard(SimpleNamespace(overlay=overlay), manager.profiles()['part1'])
    prep.private_write(output, 'compose.nas.candidate.json', overlay)
    merged = json.loads(manager.run(prep.compose_command() + [
        '-f', report_path + '/compose.nas.candidate.json', 'config', '--format', 'json']))
    prep.validate_merged(config, merged, overlay)
    prep.private_write(output, 'compose.nas.candidate.private.json', merged)
    return {'config_files_sha256': files, 'consumer_fingerprint': fingerprint,
            'consumers': records, 'databases': dict(op.state['databases'])}


def add_count(counts, kind, value):
    item = counts.setdefault(kind, {'files': 0, 'logical_bytes': 0, 'tmp_files': 0})
    item['files'] += 1
    item['logical_bytes'] += value['metadata']['size']
    item['tmp_files'] += int(value['path'].endswith('.tmp'))


def compare(source_fd, target_fd, report):
    """Union plan: NAS-only entries and existing NAS attributes are retained."""
    source = inventory(source_fd, 'ssd', report)
    target = inventory(target_fd, 'nas', report)
    if report.counts['issues']:
        raise RuntimeError('Inventory contains links, submounts or errors; no valid repair plan.')
    counts = {}
    selected = []
    for path in sorted(set(source) | set(target)):
        a, b = source.get(path), target.get(path)
        if a is not None and b is not None and stat.S_IFMT(a['mode']) != stat.S_IFMT(b['mode']):
            report.issue('type_conflict', path)
            continue
        if stat.S_ISDIR((a if a is not None else b)['mode']):
            report.record('directory', path=path, source=a, target=b,
                          policy='preserve_existing_nas_directory')
            continue
        if a is None or b is None:
            kind = 'nas_only' if a is None else 'ssd_only'
            metadata = b if a is None else a
            add_count(counts, kind, {'path': path, 'metadata': metadata})
            report.record(kind, path=path, source=a, target=b,
                          policy='keep_on_nas' if a is None else 'candidate_add_only_after_recheck')
        elif a['size'] != b['size']:
            report.issue('shared_size_conflict', path, source=a, target=b)
        elif a['mtime_ns'] // 1000000000 != b['mtime_ns'] // 1000000000:
            selected.append(path)
        elif preserved_attributes(a) != preserved_attributes(b):
            add_count(counts, 'permissions_only', {'path': path, 'metadata': a})
            report.record('permissions_only', path=path, source=a, target=b, policy='keep_nas_attributes')
        else:
            add_count(counts, 'shared_quick_match', {'path': path, 'metadata': a})
    planned = sum(source[path]['size'] + target[path]['size'] for path in selected)
    emit('nas_repair_hash_plan', selected_files=len(selected), planned_read_bytes=planned,
         max_read_bytes=MAX_HASH_BYTES, full_sha256=False)
    if len(selected) > MAX_HASH_PAIRS or planned > MAX_HASH_BYTES:
        raise RuntimeError('Conflict hash budget exceeded; no full-tree reread or automatic budget increase.')
    for index, path in enumerate(selected, 1):
        a, b = source[path], target[path]
        fds = []
        try:
            sfd = open_file(source_fd, path, source); fds.append(sfd)
            tfd = open_file(target_fd, path, target); fds.append(tfd)
            sha, target_sha = digest(sfd, a['size']), digest(tfd, b['size'])
            if stamp(os.fstat(sfd)) != a or stamp(os.fstat(tfd)) != b:
                raise RuntimeError('File changed during bounded hash.')
            base = path.rsplit('/', 1)[-1]
            if re.fullmatch(r'[0-9a-f]{64}\.[A-Za-z0-9]{1,12}', base) and sha != base.split('.')[0]:
                raise RuntimeError('Content differs from its SHA256 filename.')
            report.record('shared_hash', path=path, source=a, target=b, source_sha256=sha,
                          target_sha256=target_sha, policy='keep_nas_file_and_attributes')
            report.counts['hashed_pairs'] += 1
            report.counts['hashed_source_bytes'] += a['size']
            report.counts['hashed_target_bytes'] += b['size']
            if sha != target_sha:
                report.issue('shared_content_conflict', path)
            else:
                add_count(counts, 'shared_hash_same', {'path': path, 'metadata': a})
        except (OSError, RuntimeError) as exc:
            report.issue('conflict_hash_error', path, error=str(exc))
        finally:
            for fd in reversed(fds):
                os.close(fd)
        report.progress('repair_conflict_hash', completed=index, total=len(selected))
    if report.counts['issues']:
        raise RuntimeError('Media conflicts or live changes require review; neither side was modified.')
    return {'groups': counts, 'hash_counts': dict(report.counts),
            'source_identity': precopy.source_identity(source_fd),
            'target_identity': precopy.source_identity(target_fd),
            'comparison_policy': 'size-and-whole-second-mtime; bounded-SHA256-for-mtime-differences',
            'live_snapshot': True, 'stopped_writer_recheck_required': True}


def prepare(manager, profile):
    reviewed(profile)
    path, output = new_report(manager)
    emit('nas_repair_started', report_directory=path, media_write=False, production_restart=False)
    previous = None
    op = None
    try:
        previous = cutover.open_report(profile['report'])
        op = cutover.Cutover(profile['report'], previous)
        op.state = cutover.read_json(previous, 'execution.json')
        reclaim_plan.require_completed(op.state, op.path)
        if op.state.get('ssd_reclaim'):
            raise RuntimeError('An SSD reclaim record exists; this retained-data repair needs separate review.')
        history = dict(op.state)
        baseline = deployment(manager, op, output, path)
        prep.validate_volume(json.loads(manager.run(['docker', 'volume', 'inspect', prep.NFS_VOLUME]))[0])
        # Deliberately no old config_guard: this read-only NEW review diagnoses
        # drift; it does not replace manager.operation or adopt a new baseline.
        op.open_media(sealed=True)
        marker = precopy.read_state(op.job)
        if marker.get('phase') != 'cutover_running_on_nas':
            raise RuntimeError('NAS marker is not the completed historical cutover; review before repair.')
        manifest_fd = os.open('union-manifest.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                              0o600, dir_fd=output)
        with os.fdopen(manifest_fd, 'wb') as stream:
            report = Report(stream)
            result = compare(op.source, op.target, report)
            stream.flush(); os.fsync(stream.fileno())
            result['manifest_sha256'] = report.sha256.hexdigest()
        # Docker/file identities must remain stable throughout the metadata walk.
        after = precopy.inspect_containers()
        if (prep.file_hashes() != baseline['config_files_sha256']
                or precopy.check_consumers(prep.VOLUME, after) != baseline['consumer_fingerprint']):
            raise RuntimeError('Deployment changed during repair planning.')
        reclaim_plan.health_guard(cutover.select_services(after))
        op.databases(after)
        if (cutover.read_json(previous, 'execution.json') != history
                or precopy.read_state(op.job) != marker):
            raise RuntimeError('Historical receipt or NAS marker changed during planning.')
        old_source, old_target = op.source, op.target
        op.open_media(sealed=True)
        if (precopy.source_identity(old_source) != precopy.source_identity(op.source)
                or precopy.source_identity(old_target) != precopy.source_identity(op.target)):
            raise RuntimeError('Media path identity changed during planning.')
        prep.private_write(output, 'deployment-baseline.private.json', baseline)
        result.update(schema=1, phase='prepared', time_unix=time.time(), report_directory=path,
                      historical_report=profile['report'], historical_execution=history,
                      nas_marker=marker, volume=prep.VOLUME, nfs_volume=prep.NFS_VOLUME,
                      application_image=APP_IMAGE, gateway_image=GATEWAY_IMAGE,
                      media_write=False, production_restart=False, execution_allowed=False,
                      reclaim_ready=False, existing_nas_files_and_permissions='retain')
        prep.private_write(output, 'repair-plan.json', result)
        os.fsync(output)
        emit('nas_repair_prepared', report_directory=path, groups=result['groups'],
             hashed_pairs=result['hash_counts']['hashed_pairs'], live_snapshot=True,
             execution_allowed=False, reclaim_ready=False,
             note='New private plan only; preserve this report. No copy, stop, recreate, adoption or cleanup performed.')
        return path
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        prep.private_write(output, 'failed.json', {'phase': 'failed', 'error': str(exc),
                           'media_write': False, 'production_restart': False})
        emit('nas_repair_failed', report_directory=path, error=str(exc))
        raise
    finally:
        if op is not None:
            op.close()
        if previous is not None:
            os.close(previous)
        os.close(output)
