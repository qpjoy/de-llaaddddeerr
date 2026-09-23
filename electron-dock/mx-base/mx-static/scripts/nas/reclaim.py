#!/usr/bin/env python3
"""Reclaim only manifested SSD files after explicit business acceptance."""
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import time

import cutover
import cutover_prepare as prep
import precopy
import reclaim_plan as planning
from permissions import emit
from sample_copy import DIR_FLAGS
from verify import STAT_FIELDS, inventory, stamp, preserved_attributes

SOURCE = '/data/docker/volumes/' + prep.VOLUME + '/_data/data_hub_raw_media'
BATCH = 1000


def private_file(parent, name, flags):
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        os.close(fd)
        raise RuntimeError('Unsafe private file: ' + name)
    return fd


def read_manifest(plan_fd, plan):
    tree = {}; digest = hashlib.sha256()
    fd = private_file(plan_fd, 'files.jsonl', os.O_RDONLY)
    with os.fdopen(fd, 'rb') as stream:
        if os.fstat(stream.fileno()).st_size > 512 * 1024 ** 2:
            raise RuntimeError('Manifest too large for this Part 1 operation.')
        for line in stream:
            digest.update(line); entry = json.loads(line)
            path = entry.get('path'); value = entry.get('metadata', {})
            if (entry.get('kind') != 'entry' or not isinstance(path, str) or path in tree or
                    (path and any(part in ('', '.', '..') for part in path.split('/'))) or '\0' in path or
                    set(value) != set(STAT_FIELDS) or any(type(v) is not int for v in value.values())):
                raise RuntimeError('Invalid manifest entry.')
            mode = value['mode']
            if not (stat.S_ISDIR(mode) or (stat.S_ISREG(mode) and value['nlink'] == 1)):
                raise RuntimeError('Manifest contains unsupported entries.')
            tree[path] = value
    if digest.hexdigest() != plan['manifest_sha256'] or '' not in tree or not stat.S_ISDIR(tree['']['mode']):
        raise RuntimeError('Manifest checksum/root mismatch.')
    for path, value in tree.items():
        parent = path.rpartition('/')[0]
        if value['dev'] != tree['']['dev'] or parent not in tree or not stat.S_ISDIR(tree[parent]['mode']):
            raise RuntimeError('Manifest parent/device mismatch.')
    if planning.summarize_tree(tree) != {k: plan[k] for k in planning.summarize_tree(tree)}:
        raise RuntimeError('Manifest totals mismatch.')
    if {'device': tree['']['dev'], 'inode': tree['']['ino']} != plan['source_identity']:
        raise RuntimeError('Manifest source identity mismatch.')
    return tree


def read_intents(fd, tree):
    permitted = set()
    with os.fdopen(os.dup(fd), 'rb') as stream:
        stream.seek(0)
        for line in stream:
            if not line.endswith(b'\n'): raise RuntimeError('Incomplete reclaim journal; preserve it for review.')
            entry = json.loads(line)
            paths = entry.get('paths')
            if entry.get('kind') != 'unlink_intent' or not isinstance(paths, list) or not 0 < len(paths) <= BATCH:
                raise RuntimeError('Invalid reclaim journal.')
            for path in paths:
                if not isinstance(path, str) or path not in tree or not stat.S_ISREG(tree[path]['mode']):
                    raise RuntimeError('Journal refers outside manifest.')
                permitted.add(path)
    return permitted


def same_directory(actual, expected):
    # Unlink changes directory size/timestamps, but not its identity/permissions.
    return all(actual[k] == expected[k] for k in ('dev', 'ino', 'mode', 'uid', 'gid'))


def remaining_files(root, tree, permitted):
    report = planning.PlanReport(io.BytesIO())
    actual = inventory(root, 'ssd_before_reclaim', report)
    if report.counts['issues'] or set(actual) - set(tree):
        raise RuntimeError('SSD has unexpected entries/links/submounts; nothing further is removed.')
    remaining = []
    for path, expected in tree.items():
        current = actual.get(path)
        if stat.S_ISDIR(expected['mode']):
            if current is None or not same_directory(current, expected):
                raise RuntimeError('SSD directory changed: ' + path)
            if not permitted and current != expected:
                raise RuntimeError('SSD directory changed since the plan: ' + path)
        elif current is None:
            if path not in permitted: raise RuntimeError('Unjournaled missing SSD file: ' + path)
        elif current != expected:
            raise RuntimeError('SSD file changed since the plan: ' + path)
        else:
            remaining.append(path)
    return sorted(remaining)


def open_directories(root, tree, local):
    dirs = {'': os.dup(root)}
    try:
        if local and not same_directory(stamp(os.fstat(root)), tree['']):
            raise RuntimeError('Manifest root identity/permissions changed.')
        for path in sorted(tree, key=lambda p: (p.count('/'), p)):
            if not path or not stat.S_ISDIR(tree[path]['mode']): continue
            parent, _, name = path.rpartition('/')
            fd = os.open(name, DIR_FLAGS, dir_fd=dirs[parent]); dirs[path] = fd
            if os.fstat(fd).st_dev != os.fstat(root).st_dev:
                raise RuntimeError('Unexpected directory submount: ' + path)
            if local and not same_directory(stamp(os.fstat(fd)), tree[path]):
                raise RuntimeError('SSD parent identity changed: ' + path)
        return dirs
    except BaseException:
        for fd in dirs.values(): os.close(fd)
        raise


def check_nas_file(dirs, tree, path, strict=False):
    parent, _, name = path.rpartition('/')
    info = os.stat(name, dir_fd=dirs[parent], follow_symlinks=False)
    if (not stat.S_ISREG(info.st_mode) or info.st_dev != os.fstat(dirs['']).st_dev or
            (stamp(info) != tree[path] if strict else preserved_attributes(stamp(info)) != preserved_attributes(tree[path]))):
        raise RuntimeError('NAS file missing/changed; retain SSD for review: ' + path)


def check_nas_files(target, tree, paths, nas_tree=None):
    expected = tree if nas_tree is None else nas_tree
    dirs = open_directories(target, expected, nas_tree is not None)
    try:
        last = time.monotonic()
        for index, path in enumerate(paths, 1):
            check_nas_file(dirs, expected, path, strict=nas_tree is not None)
            if time.monotonic() - last >= 10:
                emit('reclaim_nas_metadata_progress', checked=index, total=len(paths), content_hashing=False)
                last = time.monotonic()
    finally:
        for fd in dirs.values(): os.close(fd)


def delete_files(source, target, tree, paths, journal, guard, nas_tree=None):
    local = open_directories(source, tree, True)
    nas = None; removed = 0; logical = 0
    try:
        for start in range(0, len(paths), BATCH):
            guard()  # Deployment/mount identity and health checked before every batch.
            if nas is not None:
                for fd in nas.values(): os.close(fd)
                nas = None
            expected = tree if nas_tree is None else nas_tree
            nas = open_directories(target, expected, nas_tree is not None)
            batch = paths[start:start+BATCH]
            # A durable intent permits reconciliation if SSH, process or host exits.
            data = (json.dumps({'kind': 'unlink_intent', 'paths': batch}, ensure_ascii=True) + '\n').encode()
            with os.fdopen(os.dup(journal), 'ab') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            touched = set()
            for path in batch:
                parent, _, name = path.rpartition('/')
                # Verify the registered parent is still attached at its expected path.
                fd, leaf = cutover.parent_fd(source, path, tree)
                try:
                    if precopy.source_identity(fd) != precopy.source_identity(local[parent]):
                        raise RuntimeError('SSD parent detached: ' + path)
                    if nas_tree is not None:
                        target_parent, _ = cutover.parent_fd(target, path, nas_tree)
                        try:
                            if precopy.source_identity(target_parent) != precopy.source_identity(nas[parent]):
                                raise RuntimeError('NAS parent detached: ' + path)
                        finally: os.close(target_parent)
                    check_nas_file(nas, expected, path, strict=nas_tree is not None)
                    if stamp(os.stat(leaf, dir_fd=fd, follow_symlinks=False)) != tree[path]:
                        raise RuntimeError('SSD file changed immediately before unlink: ' + path)
                    os.unlink(leaf, dir_fd=fd)
                    touched.add(parent); removed += 1; logical += tree[path]['size']
                finally: os.close(fd)
            for parent in touched: os.fsync(local[parent])
            emit('reclaim_progress', removed_this_run=removed, remaining_this_run=len(paths)-removed,
                 logical_bytes_this_run=logical, source_root_retained=True)
        return removed, logical
    finally:
        for fd in local.values(): os.close(fd)
        if nas is not None:
            for fd in nas.values(): os.close(fd)


def main():
    if (len(sys.argv) != 3 or sys.argv[1] != '--business-accepted' or
            not sys.platform.startswith('linux') or os.geteuid() != 0):
        raise SystemExit('Use nas-reclaim.sh --business-accepted <successful-reclaim-plan-directory>.')
    held = []; operation = None; plan_path = sys.argv[2]
    try:
        precopy.check_host()
        report_path, _, plan_name = plan_path.rpartition('/')
        if not re.fullmatch('reclaim-plan-[0-9a-f]{32}', plan_name): raise RuntimeError('Use an exact reclaim plan path.')
        lock_parent = os.open('/run/lock', DIR_FLAGS); held.append(lock_parent)
        lock = private_file(lock_parent, 'mx-static-nas-sample.lock', os.O_RDWR | os.O_CREAT)
        held.append(lock); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        output = cutover.open_report(report_path); held.append(output)
        plan_fd = os.open(plan_name, DIR_FLAGS, dir_fd=output); held.append(plan_fd)
        info = os.fstat(plan_fd)
        if info.st_uid != 0 or info.st_mode & 0o077: raise RuntimeError('Unsafe plan directory.')
        plan = cutover.read_json(plan_fd, 'plan.json')
        if (plan.get('schema') != 1 or plan.get('volume') != prep.VOLUME or plan.get('source') != SOURCE or
                plan.get('report_directory') != report_path or plan.get('plan_directory') != plan_path or
                plan.get('state') != 'inventory_complete' or plan.get('preserve_source_root') is not True or
                plan.get('preserve_other_media') is not True): raise RuntimeError('Unexpected plan scope.')
        tree = read_manifest(plan_fd, plan)
        operation = cutover.Cutover(report_path, output)
        state = cutover.read_json(output, 'execution.json'); operation.state = state
        nas_tree = None
        if state.get('repair_of') or plan.get('nas_verification'):
            from projects import infra_reclaim
            nas_tree = infra_reclaim.read_verified_target(plan_fd, plan, tree, state)
            # Even a direct legacy wrapper cannot use stale recovery registration.
            import manage
            registered = manage.profiles()['part1']
            if registered['report'] != report_path or registered.get('plan') != plan_path:
                raise RuntimeError('This UNION plan must be explicitly registered before later deletion.')
            if not infra_reclaim.recovery_evidence(manage)['verified']:
                raise RuntimeError('Current recovery installation/policy is not verified.')
        if state.get('ssd_reclaim', {}).get('plan_directory', plan_path) != plan_path:
            raise RuntimeError('Another reclaim plan already completed; review its receipt.')
        def guard():
            planning.guard(operation, state)
            operation.open_media(sealed=True)
            if precopy.read_state(operation.job).get('phase') != 'cutover_running_on_nas':
                raise RuntimeError('NAS marker no longer running.')
            # open_media holds descriptors; retain just the initial set for the run.
        guard()
        pinned_source, pinned_target, pinned_job = operation.source, operation.target, operation.job
        held_count = len(operation.held)
        def batch_guard():
            try:
                guard()
                if (precopy.source_identity(operation.source) != precopy.source_identity(pinned_source) or
                        precopy.source_identity(operation.target) != precopy.source_identity(pinned_target)):
                    raise RuntimeError('Registered media path changed.')
            finally:
                for fd in operation.held[held_count:]: os.close(fd)
                del operation.held[held_count:]
                operation.source, operation.target, operation.job = pinned_source, pinned_target, pinned_job
        # Existing cutover records cannot be used to claim source reclamation before these checks.
        if plan['source_identity'] != precopy.source_identity(pinned_source): raise RuntimeError('Source plan mismatch.')
        journal = private_file(plan_fd, 'unlink-intents.jsonl', os.O_RDWR | os.O_CREAT | os.O_APPEND); held.append(journal)
        os.fsync(plan_fd)
        permitted = read_intents(journal, tree)
        remaining = remaining_files(pinned_source, tree, permitted)
        emit('reclaim_preflight', plan_directory=plan_path, files_remaining=len(remaining),
             business_accepted=True, note='NAS metadata checks only; keep deployments and external SSD writers frozen.')
        check_nas_files(pinned_target, tree, remaining, nas_tree=nas_tree)
        operation.identity_probe()
        operation.http_probe(operation.mounted_services(True, expected_ids=state['new_ids']))
        if remaining_files(pinned_source, tree, permitted) != remaining: raise RuntimeError('SSD changed during preflight.')
        batch_guard()
        cutover.atomic_json(plan_fd, 'acceptance.json', {'schema': 1, 'business_accepted': True,
            'time_unix': time.time(), 'plan_directory': plan_path, 'manifest_sha256': plan['manifest_sha256']})
        before = os.fstatvfs(pinned_source)
        removed, logical = delete_files(pinned_source, pinned_target, tree, remaining, journal, batch_guard, nas_tree=nas_tree)
        permitted = read_intents(journal, tree)
        if remaining_files(pinned_source, tree, permitted): raise RuntimeError('SSD still has manifested files.')
        batch_guard()
        after = os.fstatvfs(pinned_source)
        result = {'schema': 1, 'phase': 'ssd_files_reclaimed', 'volume': prep.VOLUME,
            'plan_directory': plan_path, 'manifest_sha256': plan['manifest_sha256'], 'business_accepted': True,
            'removed_this_run': removed, 'logical_bytes_this_run': logical,
            'manifest_files_total': plan['regular_files'], 'source_root_retained': True,
            'source_identity': precopy.source_identity(pinned_source), 'other_media_retained': True,
            'data_available_before_bytes': before.f_bavail * before.f_frsize,
            'data_available_after_bytes': after.f_bavail * after.f_frsize,
            'time_unix': time.time(), 'note': 'NAS is authoritative; SSD files are gone. No SSD rollback or old pre-copy.'}
        cutover.atomic_json(plan_fd, 'reclaim-result.json', result)
        state.update(business_acceptance_pending=False, ssd_reclaim={
            'plan_directory': plan_path, 'completed_at_unix': result['time_unix'], 'manifest_files_total': plan['regular_files']})
        cutover.atomic_json(output, 'execution.json', state)
        emit('reclaim_result', **result)
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        emit('reclaim_failed', error=str(exc), plan_directory=plan_path,
             note='May be partially reclaimed. Preserve manifest/journal; NAS remains authoritative. No automatic rollback.')
        return 1
    finally:
        if operation is not None: operation.close()
        for fd in reversed(held): os.close(fd)


if __name__ == '__main__': sys.exit(main())
