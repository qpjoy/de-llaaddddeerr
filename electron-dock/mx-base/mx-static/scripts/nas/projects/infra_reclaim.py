"""Read-only UNION reclaim review. No business stop, NAS writes or SSD deletion."""
import hashlib
import io
import json
import os
import re
import stat
import time

import cutover
import cutover_prepare as prep
import precopy
import reclaim
import reclaim_plan
import recovery
from permissions import emit
from projects import infra_repair, infra_repair_switch, infra_storage
from projects.infra_repair_copy import named_hash
from sample_copy import DIR_FLAGS, digest
from verify import Report, STAT_FIELDS, inventory, open_file, stamp

POLICY = 'retained-union-v1'


def state_digest(state):
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()


def source_inventory(fd, phase):
    report = Report(io.BytesIO())
    tree = inventory(fd, phase, report)
    if report.counts['issues']: raise RuntimeError('SSD inventory has unsupported entries or read errors.')
    return tree


def read_tree(folder, name, expected_sha):
    tree = {}; sha = hashlib.sha256()
    leaf = reclaim.private_file(folder, name, os.O_RDONLY)
    with os.fdopen(leaf, 'rb') as stream:
        if os.fstat(stream.fileno()).st_size > 512 * 1024 ** 2: raise RuntimeError('Metadata manifest too large.')
        for line in stream:
            sha.update(line); entry = json.loads(line)
            path, value = entry.get('path'), entry.get('metadata')
            if (entry.get('kind') != 'entry' or not isinstance(path, str) or '\0' in path or path in tree
                    or (path and any(p in ('', '.', '..') for p in path.split('/')))
                    or not isinstance(value, dict) or set(value) != set(STAT_FIELDS)
                    or any(type(v) is not int for v in value.values())
                    or not (stat.S_ISDIR(value['mode']) or stat.S_ISREG(value['mode']) and value['nlink'] == 1)):
                raise RuntimeError('Invalid metadata manifest entry.')
            tree[path] = value
    if sha.hexdigest() != expected_sha or '' not in tree or not stat.S_ISDIR(tree['']['mode']):
        raise RuntimeError('Metadata manifest checksum/root differs.')
    for path, value in tree.items():
        parent = path.rpartition('/')[0]
        if value['dev'] != tree['']['dev'] or parent not in tree or not stat.S_ISDIR(tree[parent]['mode']):
            raise RuntimeError('Metadata manifest parent/device differs.')
    return tree


def write_tree(folder, name, tree):
    leaf = reclaim.private_file(folder, name, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    with os.fdopen(leaf, 'wb') as stream:
        report = Report(stream)
        for path in sorted(tree): report.record('entry', path=path, metadata=tree[path])
        stream.flush(); os.fsync(stream.fileno())
        return report.sha256.hexdigest()


def stopped_tree(op):
    parent, _, name = op.state.get('final_review', '').rpartition('/')
    if parent != op.path or not re.fullmatch('repair-final-[0-9a-f]{32}', name):
        raise RuntimeError('The repaired cutover final review is required.')
    fd = os.open(name, DIR_FLAGS, dir_fd=op.output)
    try:
        if os.fstat(fd).st_uid != os.geteuid() or os.fstat(fd).st_mode & 0o077:
            raise RuntimeError('Final review must be root-private.')
        result = cutover.read_json(fd, 'result.json')
        if (result.get('final_sync_passed') is not True or result.get('live_snapshot') is not False
                or result.get('stopped_writer_recheck_required') is not False):
            raise RuntimeError('Stopped-writer verification did not complete.')
        return read_tree(fd, 'files.jsonl', result['source_manifest_sha256']), result['source_manifest_sha256']
    finally: os.close(fd)


def counterparts(target, source):
    """Stat ONLY manifested SSD paths on NAS; leave live NAS-only namespaces alone."""
    dirs = reclaim.open_directories(target, source, False)
    try:
        tree = {path: stamp(os.fstat(fd)) for path, fd in dirs.items()}
        last = time.monotonic(); checked = 0
        for path in sorted(source):
            if stat.S_ISDIR(source[path]['mode']): continue
            parent, _, name = path.rpartition('/')
            value = stamp(os.stat(name, dir_fd=dirs[parent], follow_symlinks=False))
            if not stat.S_ISREG(value['mode']) or value['nlink'] != 1 or value['dev'] != tree['']['dev']:
                raise RuntimeError('Unsupported NAS counterpart: ' + path)
            tree[path] = value; checked += 1
            if time.monotonic() - last >= 10:
                emit('nas_reclaim_check_progress', checked=checked, metadata_only=True)
                last = time.monotonic()
        return tree
    finally:
        for fd in dirs.values(): os.close(fd)


def verify_pairs(source_fd, target_fd, source, target, folder):
    selected = []; counts = {'quick_match': 0, 'nas_attributes_retained': 0, 'hashed_equal': 0}
    for path, a in source.items():
        b = target[path]
        if stat.S_IFMT(a['mode']) != stat.S_IFMT(b['mode']): raise RuntimeError('NAS type conflict: ' + path)
        if stat.S_ISDIR(a['mode']): continue
        if a['size'] != b['size']: raise RuntimeError('NAS size differs; retain SSD: ' + path)
        if a['mtime_ns'] // 1000000000 != b['mtime_ns'] // 1000000000: selected.append(path)
        else: counts['quick_match'] += 1
        if any(a[k] != b[k] for k in ('mode', 'uid', 'gid')): counts['nas_attributes_retained'] += 1
    planned = sum(source[p]['size'] + target[p]['size'] for p in selected)
    if len(selected) > infra_repair.MAX_HASH_PAIRS or planned > infra_repair.MAX_HASH_BYTES:
        raise RuntimeError('Bounded conflict hash budget exceeded; do not broaden automatically.')
    emit('nas_repair_hash_plan', selected_files=len(selected), planned_read_bytes=planned, full_sha256=False)
    leaf = reclaim.private_file(folder, 'hashes.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    with os.fdopen(leaf, 'wb') as stream:
        report = Report(stream)
        for path in sorted(selected):
            held = []
            try:
                a = open_file(source_fd, path, source); held.append(a)
                b = open_file(target_fd, path, target); held.append(b)
                sha, nas_sha = digest(a, source[path]['size']), digest(b, target[path]['size'])
                if sha != nas_sha or stamp(os.fstat(a)) != source[path] or stamp(os.fstat(b)) != target[path]:
                    raise RuntimeError('Content differs or changed during hash: ' + path)
                named_hash(path, sha)
                report.record('verified_hash', path=path, sha256=sha)
                counts['hashed_equal'] += 1
            finally:
                for fd in held: os.close(fd)
        stream.flush(); os.fsync(stream.fileno())
    return dict(counts, hashed_bytes=planned)


def recovery_evidence(manager):
    installed = recovery.installed_current(manager)
    selected = recovery.requested(manager.auto_config(), 'part1')
    text = manager.run(['systemctl', 'show', manager.UNIT + '.timer',
                        '--property=LoadState,ActiveState,UnitFileState'])
    timer = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    good = installed and selected and timer.get('LoadState') == 'loaded' and timer.get('ActiveState') == 'active' and timer.get('UnitFileState') == 'enabled'
    return {'verified': good, 'installed_current': installed, 'selected': selected, 'timer': timer}


def read_verified_target(folder, plan, source, state):
    """Used again by the separately authorized deleter; never widen old plans."""
    if (plan.get('nas_verification') != POLICY or plan.get('reclaim_ready') is not True
            or plan.get('business_acceptance_recorded') is not True
            or plan.get('recovery', {}).get('verified') is not True
            or plan.get('cutover_execution_sha256') != state_digest(state)):
        raise RuntimeError('A current accepted UNION verification plan is required.')
    tree = read_tree(folder, 'nas-files.jsonl', plan['target_manifest_sha256'])
    if set(tree) != set(source) or {'device': tree['']['dev'], 'inode': tree['']['ino']} != plan['target_identity']:
        raise RuntimeError('NAS manifest coverage/identity differs.')
    if any(stat.S_IFMT(v['mode']) != stat.S_IFMT(tree[p]['mode']) or
           (stat.S_ISREG(v['mode']) and v['size'] != tree[p]['size']) for p, v in source.items()):
        raise RuntimeError('NAS manifest types/sizes differ.')
    return tree


def check(manager, profile, business_accepted=False):
    infra_storage.reviewed(profile)
    folder = None; path = None
    try:
        with manager.operation(profile, require_running=True) as (op, rows):
            reclaim_plan.guard(op, op.state)
            if not op.state.get('repair_of') or op.state.get('ssd_reclaim'):
                raise RuntimeError('Completed repaired cutover with retained SSD required.')
            op.open_media(sealed=True)
            if precopy.read_state(op.job).get('phase') != 'cutover_running_on_nas': raise RuntimeError('NAS marker is not running.')
            if not infra_storage.check(manager, profile): raise RuntimeError('Actual NAS mounts do not match.')
            fs = os.fstatvfs(op.output)
            if fs.f_bavail * fs.f_frsize < 1024 ** 3: raise RuntimeError('Need 1 GiB local report space.')
            frozen, frozen_sha = stopped_tree(op)
            name, folder = infra_repair_switch.new_directory(op.output, 'reclaim-plan-')
            path = op.path + '/' + name
            emit('nas_reclaim_check_started', plan_directory=path, source_deleted=False)
            fresh = source_inventory(op.source, 'retained_ssd')
            if fresh != frozen: raise RuntimeError('Retained SSD differs from stopped-writer evidence; review before reclaim.')
            target = counterparts(op.target, fresh)
            comparison = verify_pairs(op.source, op.target, fresh, target, folder)
            source_sha = write_tree(folder, 'files.jsonl', fresh)
            target_sha = write_tree(folder, 'nas-files.jsonl', target)
            # A changed NAS counterpart invalidates the captured proof; concurrent
            # NAS-only additions may change directory times but not identities.
            reclaim.check_nas_files(op.target, fresh, sorted(p for p in fresh if stat.S_ISREG(fresh[p]['mode'])), nas_tree=target)
            if source_inventory(op.source, 'retained_ssd_recheck') != fresh:
                raise RuntimeError('SSD changed during verification.')
            reclaim_plan.guard(op, op.state); infra_repair_switch.media_guard(op)
            op.identity_probe(); op.http_probe(rows)
            if not infra_storage.check(manager, profile): raise RuntimeError('NAS mounts changed during verification.')
            restored = recovery_evidence(manager)
            result = dict(reclaim_plan.summarize_tree(fresh), schema=1, state='inventory_complete',
                volume=prep.VOLUME, report_directory=op.path, plan_directory=path, source=reclaim.SOURCE,
                source_identity=precopy.source_identity(op.source), target_identity=precopy.source_identity(op.target),
                manifest_sha256=source_sha, target_manifest_sha256=target_sha, stopped_manifest_sha256=frozen_sha,
                cutover_execution_sha256=state_digest(op.state), nas_verification=POLICY, comparison=comparison,
                preserve_source_root=True, preserve_other_media=True, files_verified=True,
                business_acceptance_recorded=business_accepted, recovery=restored,
                reclaim_ready=business_accepted and restored['verified'], deletion_supported=True,
                deletion_authorized=False, source_deleted=False, time_unix=time.time(),
                note='Snapshot only; SSD retained. Revalidate exact source/NAS manifests and deployment before later deletion.')
            reclaim_plan.guard(op, op.state)
            prep.private_write(folder, 'plan.json', result); os.fsync(folder); os.fsync(op.output)
            emit('nas_reclaim_check_complete', **result)
            return result
    except Exception as exc:
        emit('nas_reclaim_check_failed', plan_directory=path, error=str(exc), source_deleted=False, reclaim_ready=False)
        raise
    finally:
        if folder is not None: os.close(folder)
