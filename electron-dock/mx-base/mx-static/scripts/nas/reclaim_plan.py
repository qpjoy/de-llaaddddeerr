#!/usr/bin/env python3
"""Inventory retained SSD media after cutover. No deletion or readiness approval."""
import fcntl
import os
import stat
import subprocess
import sys
import time
import uuid

import cutover
import cutover_prepare as prep
import precopy
from permissions import emit
from sample_copy import DIR_FLAGS, descriptor_path
from verify import Report, inventory


class PlanReport(Report):
    def progress(self, phase, **values):
        if time.monotonic() - self.last_progress >= 10:
            emit('reclaim_plan_progress', phase=phase, issues=self.counts['issues'], metadata_only=True, **values)
            self.last_progress = time.monotonic()


def require_completed(state, path):
    if (state.get('schema') != 1 or state.get('volume') != prep.VOLUME or state.get('report_directory') != path
            or state.get('phase') != 'running_on_nas' or state.get('final_sync_passed') is not True
            or state.get('nas_may_have_writes') is not True or state.get('reclaim_ready') is not False
            or set(state.get('new_ids', {})) != prep.SERVICES):
        raise RuntimeError('Completed Part 1 cutover with retained SSD required.')


def health_guard(consumers):
    for name, c in consumers.items():
        s = c.get('State', {})
        if not s.get('Running') or s.get('Restarting') or s.get('Paused') or s.get('OOMKilled'):
            raise RuntimeError('Media consumer is not stably running: ' + name)
        if name in ('web', 'chat-gateway', 'gateway') and s.get('Health', {}).get('Status') != 'healthy':
            raise RuntimeError('Media HTTP service not healthy: ' + name)


def extra_source_consumers(containers, expected_ids):
    # Inspect Docker metadata only; do not traverse unrelated host/NFS paths.
    source = '/data/docker/volumes/' + prep.VOLUME + '/_data/data_hub_raw_media'
    unexpected = []
    for c in containers:
        if c['Id'] in expected_ids: continue
        for m in c.get('Mounts', []):
            path = m.get('Source', '').rstrip('/') or '/'
            overlaps = m.get('Type') == 'bind' and (path == '/' or path == source or
                         source.startswith(path + '/') or path.startswith(source + '/'))
            if m.get('Name') == prep.VOLUME or overlaps:
                unexpected.append({'id': c['Id'], 'name': c.get('Name'), 'mount_target': m.get('Destination')})
                break
    return unexpected


def guard(operation, state):
    require_completed(state, operation.path)
    if cutover.read_json(operation.output, 'execution.json') != state:
        raise RuntimeError('Execution record changed.')
    operation.config_guard()
    health_guard(operation.mounted_services(True, expected_ids=state['new_ids']))
    unexpected = extra_source_consumers(precopy.inspect_containers(), set(state['new_ids'].values()))
    if unexpected:
        emit('reclaim_plan_unreviewed_consumers', consumers=unexpected)
        raise RuntimeError('Other Docker mounts can access retained SSD; review before planning reclamation.')


def summarize_tree(tree):
    files = [value for value in tree.values() if stat.S_ISREG(value['mode'])]
    return {'regular_files': len(files), 'logical_bytes': sum(value['size'] for value in files),
            'directories_including_retained_root': sum(stat.S_ISDIR(value['mode']) for value in tree.values())}


def write_plan(source, output, allocated_bytes):
    leaf = os.open('files.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output)
    with os.fdopen(leaf, 'wb') as stream:
        report = PlanReport(stream)
        before = inventory(source, 'ssd_retained', report)
        if report.counts['issues']:
            raise RuntimeError('SSD inventory has links/submounts/errors; no valid plan produced.')
        for path in sorted(before): report.record('entry', path=path, metadata=before[path])
        after = inventory(source, 'ssd_retained_recheck', report)
        if report.counts['issues'] or before != after:
            raise RuntimeError('Retained SSD media changed during inventory; investigate possible writers.')
        stream.flush(); os.fsync(stream.fileno())
        result = summarize_tree(before)
        result.update(manifest_sha256=report.sha256.hexdigest(), du_allocated_bytes=allocated_bytes,
                      preserve_source_root=True, preserve_other_media=True,
                      deletion_supported=False, reclaim_ready=False)
        return result


def main():
    if len(sys.argv) != 2 or not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise SystemExit('Use sudo bash scripts/nas-reclaim-plan.sh <successful-Part-1-report-directory>.')
    held = []; operation = None; plan_path = None
    try:
        precopy.check_host()
        lock = os.open('/run/lock/mx-static-nas-sample.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600); held.append(lock)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe migration lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        output = cutover.open_report(sys.argv[1]); held.append(output)
        operation = cutover.Cutover(sys.argv[1], output)
        state = cutover.read_json(output, 'execution.json')
        operation.state = state
        guard(operation, state)
        operation.open_media(sealed=True)
        marker = precopy.read_state(operation.job)
        if marker.get('phase') != 'cutover_running_on_nas': raise RuntimeError('NAS cutover marker is not sealed as running.')
        capacity = os.fstatvfs(output)
        if capacity.f_bavail * capacity.f_frsize < 512 * 1024 ** 2:
            raise RuntimeError('Less than 512 MiB free for a private metadata manifest.')
        name = 'reclaim-plan-' + uuid.uuid4().hex
        os.mkdir(name, 0o700, dir_fd=output)
        plan = os.open(name, DIR_FLAGS, dir_fd=output); held.append(plan)
        plan_path = operation.path + '/' + name
        emit('reclaim_plan_start', plan_directory=plan_path, metadata_only=True,
             note='Reads retained SSD metadata and bounded NAS identity; no stop, copy, deletion or full-media hashing.')
        # Pinned source fd cannot resolve onto a replacement mount/path.
        du = subprocess.check_output(['du', '-sx', '--block-size=1', '--', descriptor_path(operation.source) + '/'],
                                     universal_newlines=True, pass_fds=(operation.source,))
        allocated = int(du.split()[0])
        result = write_plan(operation.source, plan, allocated)
        guard(operation, state)
        old_source, old_target = operation.source, operation.target
        operation.open_media(sealed=True)
        if (precopy.source_identity(old_source) != precopy.source_identity(operation.source)
                or precopy.source_identity(old_target) != precopy.source_identity(operation.target)
                or precopy.read_state(operation.job) != marker):
            raise RuntimeError('Registered media identities or marker changed.')
        capacity = os.fstatvfs(operation.source)
        result.update(schema=1, volume=prep.VOLUME, report_directory=operation.path, plan_directory=plan_path,
                      time_unix=time.time(), source_identity=precopy.source_identity(operation.source),
                      source='/data/docker/volumes/' + prep.VOLUME + '/_data/data_hub_raw_media',
                      data_available_bytes=capacity.f_bavail * capacity.f_frsize,
                      state='inventory_complete', business_acceptance_recorded=False,
                      note='Planning only. Allocated/logical sizes do not guarantee the later df increase. Keep SSD until business acceptance.')
        prep.private_write(plan, 'plan.json', result); os.fsync(plan); os.fsync(output)
        emit('reclaim_plan_result', **result)
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as exc:
        emit('reclaim_plan_failed', error=str(exc), plan_directory=plan_path, reclaim_ready=False,
             note='No deletion or business stop performed; keep both media copies.')
        return 1
    finally:
        if operation is not None: operation.close()
        for fd in reversed(held): os.close(fd)


if __name__ == '__main__': sys.exit(main())
