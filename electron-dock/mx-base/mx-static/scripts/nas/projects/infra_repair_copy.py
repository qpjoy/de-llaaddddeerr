"""Add only SSD-only files from a reviewed repair manifest. Never switch storage.

Stage and verify in a private NAS directory, then link without replacement.
No original file, NAS marker, deployment or historical report is rewritten.
"""
import hashlib
import json
import os
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
from reclaim import private_file, same_directory
from sample_copy import DIR_FLAGS, digest
from verify import STAT_FIELDS, open_file, preserved_attributes, stamp

MAX_FILES = 10000
MAX_BYTES = 16 * 1024 ** 3


def validate_path(path):
    if not re.fullmatch(re.escape(planning.REPORT_ROOT) + r'/infra-[0-9a-f]{32}', path):
        raise RuntimeError('Use the exact infra repair report directory, not a cutover/reclaim report.')


def open_report(path):
    validate_path(path)
    fd = os.open('/', DIR_FLAGS)
    try:
        for name in path.strip('/').split('/'):
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('Unsafe repair report directory.')
        if os.fstat(fd).st_mode & 0o077:
            raise RuntimeError('Repair report must be root-private.')
        return fd
    except BaseException:
        os.close(fd)
        raise


def metadata(value, directory=False):
    if (not isinstance(value, dict) or set(value) != set(STAT_FIELDS)
            or any(type(v) is not int for v in value.values())
            or not (stat.S_ISDIR(value['mode']) if directory else stat.S_ISREG(value['mode']) and value['nlink'] == 1)):
        raise RuntimeError('Invalid repair manifest metadata.')
    return value


def read_manifest(fd, plan):
    source, target_dirs, seen = {}, {}, set()
    files = []
    sha = hashlib.sha256()
    leaf = private_file(fd, 'union-manifest.jsonl', os.O_RDONLY)
    with os.fdopen(leaf, 'rb') as stream:
        if os.fstat(stream.fileno()).st_size > 32 * 1024 ** 2:
            raise RuntimeError('Unexpected repair manifest size.')
        for line in stream:
            sha.update(line); entry = json.loads(line)
            path, kind = entry.get('path'), entry.get('kind')
            if (not isinstance(path, str) or path in seen or '\0' in path
                    or (path and any(p in ('', '.', '..') for p in path.split('/')))):
                raise RuntimeError('Unsafe/duplicate repair manifest path.')
            seen.add(path)
            a, b = entry.get('source'), entry.get('target')
            if kind == 'directory':
                if a is not None: source[path] = metadata(a, True)
                if b is not None: target_dirs[path] = metadata(b, True)
            elif kind == 'ssd_only':
                if not path or b is not None: raise RuntimeError('Invalid SSD-only entry.')
                source[path] = metadata(a); files.append(path)
            elif kind not in ('nas_only', 'permissions_only', 'shared_hash'):
                raise RuntimeError('Unexpected repair manifest record; no copy allowed.')
    if sha.hexdigest() != plan.get('manifest_sha256'):
        raise RuntimeError('Repair manifest checksum differs.')
    for tree, key in ((source, 'source_identity'), (target_dirs, 'target_identity')):
        if '' not in tree or not stat.S_ISDIR(tree['']['mode']): raise RuntimeError('Manifest root missing.')
        if {'device': tree['']['dev'], 'inode': tree['']['ino']} != plan[key]:
            raise RuntimeError('Manifest root identity differs.')
        for path, item in tree.items():
            parent = path.rpartition('/')[0]
            if (item['dev'] != tree['']['dev'] or parent not in tree or not stat.S_ISDIR(tree[parent]['mode'])):
                raise RuntimeError('Manifest parent/device differs.')
    totals = {'files': len(files), 'logical_bytes': sum(source[p]['size'] for p in files),
              'tmp_files': sum(p.endswith('.tmp') for p in files)}
    if totals != plan['groups'].get('ssd_only', {'files': 0, 'logical_bytes': 0, 'tmp_files': 0}):
        raise RuntimeError('SSD-only totals differ from prepared plan.')
    if len(files) > MAX_FILES or totals['logical_bytes'] > MAX_BYTES:
        raise RuntimeError('Online addition budget exceeded; do not widen automatically.')
    # This repair has existing avatar/video/etc parents. Do not invent new
    # directory ownership or permission policy for unreviewed paths.
    if any(p.rpartition('/')[0] not in target_dirs for p in files):
        raise RuntimeError('A required NAS parent directory was absent in the plan; review before copying.')
    return source, target_dirs, sorted(files)


def target_parent(root, path, dirs):
    fd = os.dup(root)
    try:
        current = ''
        if not same_directory(stamp(os.fstat(fd)), dirs['']):
            raise RuntimeError('NAS root identity/permissions changed.')
        for name in path.split('/')[:-1]:
            current = current + '/' + name if current else name
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
            if current not in dirs or not same_directory(stamp(os.fstat(fd)), dirs[current]):
                raise RuntimeError('NAS parent identity/permissions changed.')
        return fd
    except BaseException:
        os.close(fd)
        raise


def named_hash(path, value):
    name = path.rsplit('/', 1)[-1]
    if re.fullmatch(r'[0-9a-f]{64}\.[A-Za-z0-9]{1,12}', name) and value != name.split('.')[0]:
        raise RuntimeError('SSD content differs from its hash filename: ' + path)


def source_metadata(root, path, tree):
    """Observe a candidate without following links or accepting replaced parents."""
    parts = path.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise RuntimeError('Unsafe relative source path.')
    fd = os.dup(root)
    try:
        current = ''
        for name in parts[:-1]:
            actual = stamp(os.fstat(fd))
            if any(actual[k] != tree[current][k] for k in ('dev', 'ino')):
                raise RuntimeError('SSD root/parent directory was replaced.')
            current = current + '/' + name if current else name
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
        actual = stamp(os.fstat(fd))
        if any(actual[k] != tree[current][k] for k in ('dev', 'ino')):
            raise RuntimeError('SSD parent directory was replaced.')
        return stamp(os.stat(parts[-1], dir_fd=fd, follow_symlinks=False))
    finally:
        os.close(fd)


def recheck_sources(source, tree, paths, emit_summary=True):
    """Hash only ctime-only drift with a trusted digest in the original filename.

    The original manifest is immutable. Return a per-attempt snapshot for strict
    checks during copying; all other metadata changes and temp files still fail.
    Read scope remains bounded by the already validated SSD-only manifest.
    """
    reviewed, changes = dict(tree), []
    hashed_bytes = 0
    last_progress = time.monotonic()
    for index, path in enumerate(paths, 1):
        try:
            expected = tree[path]
            actual = source_metadata(source, path, tree)
            fields = [k for k in STAT_FIELDS if actual[k] != expected[k]]
            if fields:
                if fields != ['ctime_ns']:
                    raise RuntimeError('SSD metadata changed: ' + ', '.join(fields))
                if not re.fullmatch(r'[0-9a-f]{64}\.[A-Za-z0-9]{1,12}', path.rsplit('/', 1)[-1]):
                    raise RuntimeError('Ctime changed without a SHA256 filename; a fresh review is required.')
                reviewed[path] = actual
            fd = open_file(source, path, reviewed)
            try:
                if fields:
                    sha = digest(fd, actual['size']); named_hash(path, sha)
                    if stamp(os.fstat(fd)) != actual or source_metadata(source, path, tree) != actual:
                        raise RuntimeError('SSD file/path changed during ctime content recheck.')
                    changes.append({'path': path, 'prepared': expected, 'observed': actual,
                                    'sha256': sha, 'validation': 'ctime-only-and-sha256-matches-filename'})
                    hashed_bytes += actual['size']
            finally:
                os.close(fd)
        except (OSError, RuntimeError) as exc:
            raise RuntimeError('Candidate cannot be copied: ' + path + '; ' + str(exc))
        if time.monotonic() - last_progress >= 10:
            emit('nas_repair_source_recheck_progress', checked=index, candidates=len(paths),
                 ctime_revalidated=len(changes), hashed_source_bytes=hashed_bytes)
            last_progress = time.monotonic()
    if emit_summary:
        emit('nas_repair_source_rechecked', checked=len(paths), ctime_revalidated=len(changes),
             hashed_source_bytes=hashed_bytes, original_manifest_unchanged=True)
    return reviewed, changes


def check_existing(parent, name, size, sha):
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError: return False
    try:
        before = stamp(os.fstat(fd))
        if (not stat.S_ISREG(before['mode']) or before['nlink'] != 1 or before['size'] != size
                or before['dev'] != os.fstat(parent).st_dev):
            raise RuntimeError('Existing NAS target needs review; retained untouched: ' + name)
        if digest(fd, size) != sha or stamp(os.fstat(fd)) != before:
            raise RuntimeError('Existing NAS target differs or changed; retained untouched: ' + name)
        if stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) != before:
            raise RuntimeError('Existing NAS target path changed.')
        return True
    finally:
        os.close(fd)


def append(fd, event, **values):
    data = (json.dumps(dict(event=event, **values), ensure_ascii=True, sort_keys=True) + '\n').encode()
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        if n <= 0: raise OSError('Journal write made no progress.')
        view = view[n:]
    os.fsync(fd)


def open_copy_source(source, path, tree, journal):
    """Revalidate eligible drift once, BEFORE copying this file, with a durable record.

    A long online queue may outlive the batch preflight. Never retry a file that
    changes during hashing, staging or publication, and never mutate the plan.
    """
    try:
        return open_file(source, path, tree), tree[path]
    except RuntimeError:
        reviewed, changes = recheck_sources(source, tree, [path], emit_summary=False)
        if not changes:
            raise  # No proven ctime-only change; preserve the original refusal.
        fd = open_file(source, path, reviewed)
        try:
            change = changes[0]
            append(journal, 'source_ctime_revalidated_before_copy', path=path,
                   previously_checked=change['prepared'], observed=change['observed'],
                   sha256=change['sha256'], validation=change['validation'])
            emit('nas_repair_copy_source_revalidated', path=path, content_matches_filename=True,
                 original_manifest_unchanged=True)
            return fd, reviewed[path]
        except BaseException:
            os.close(fd)
            raise


def copy_one(source, target, stage, path, tree, dirs, journal):
    source_fd, expected = open_copy_source(source, path, tree, journal)
    parent = None
    temp_fd = None
    temp_name = 'file-' + uuid.uuid4().hex
    try:
        parent = target_parent(target, path, dirs)
        name = path.rsplit('/', 1)[-1]
        try: os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError: exists = False
        else: exists = True
        if exists:
            sha = digest(source_fd, expected['size']); named_hash(path, sha)
            if stamp(os.fstat(source_fd)) != expected: raise RuntimeError('SSD file changed: ' + path)
            if not check_existing(parent, name, expected['size'], sha):
                raise RuntimeError('NAS target disappeared; retry only after review.')
            append(journal, 'already_present_same', path=path, sha256=sha, size=expected['size'])
            return 'already_present', sha

        temp_fd = os.open(temp_name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                          0o600, dir_fd=stage)
        temp_identity = precopy.source_identity(temp_fd)
        append(journal, 'stage_created', path=path, temporary=temp_name, identity=temp_identity)
        sha = hashlib.sha256(); remaining = expected['size']
        while remaining:
            block = os.read(source_fd, min(1024 ** 2, remaining))
            if not block: raise RuntimeError('SSD file shortened: ' + path)
            sha.update(block); remaining -= len(block)
            view = memoryview(block)
            while view:
                n = os.write(temp_fd, view)
                if n <= 0: raise OSError('NAS write made no progress.')
                view = view[n:]
        if os.read(source_fd, 1) or stamp(os.fstat(source_fd)) != expected:
            raise RuntimeError('SSD file changed while copying: ' + path)
        sha = sha.hexdigest(); named_hash(path, sha)
        os.fchown(temp_fd, expected['uid'], expected['gid'])
        os.fchmod(temp_fd, stat.S_IMODE(expected['mode']))
        os.utime(temp_fd, ns=(expected['mtime_ns'], expected['mtime_ns']))
        os.fsync(temp_fd)
        staged = stamp(os.fstat(temp_fd))
        if preserved_attributes(staged) != preserved_attributes(expected) or staged['nlink'] != 1:
            raise RuntimeError('New NAS file attributes were not preserved.')
        if digest(temp_fd, expected['size']) != sha or stamp(os.fstat(temp_fd)) != staged:
            raise RuntimeError('NAS staged readback failed.')
        # Reopen the named parent before publishing; no mkdir or changed perms.
        refreshed = target_parent(target, path, dirs)
        try:
            if precopy.source_identity(refreshed) != precopy.source_identity(parent):
                raise RuntimeError('NAS parent replaced during staging.')
        finally: os.close(refreshed)
        if (stamp(os.fstat(source_fd)) != expected
                or stamp(os.stat(temp_name, dir_fd=stage, follow_symlinks=False)) != staged):
            raise RuntimeError('Source or private staged path changed before publication.')
        append(journal, 'publish_intent', path=path, temporary=temp_name, identity=temp_identity,
               sha256=sha, source=expected, parent=precopy.source_identity(parent))
        outcome = 'copied'
        try:
            os.link(temp_name, name, src_dir_fd=stage, dst_dir_fd=parent, follow_symlinks=False)
        except OSError as link_error:
            # NFS can commit LINK but lose the reply. Recognize only our exact
            # inode; an independently created destination is NEVER replaced.
            try: actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError: raise link_error
            if {'device': actual.st_dev, 'inode': actual.st_ino} != temp_identity:
                if not check_existing(parent, name, expected['size'], sha): raise
                outcome = 'already_present'
        if outcome == 'copied':
            actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if {'device': actual.st_dev, 'inode': actual.st_ino} != temp_identity:
                raise RuntimeError('Published target identity differs; preserve for review.')
            if preserved_attributes(stamp(actual)) != preserved_attributes(expected):
                raise RuntimeError('Published target attributes changed.')
        os.fsync(parent)
        if stamp(os.fstat(source_fd)) != expected:
            raise RuntimeError('SSD changed around publication; both sides retained for final review.')
        append(journal, 'published_verified', path=path, outcome=outcome, sha256=sha, size=expected['size'])
        return outcome, sha
    finally:
        # Only our own private temporary name is removable. A power loss may
        # bypass this block; preserve its journal/staging directory for review.
        try:
            if temp_fd is not None:
                identity = precopy.source_identity(temp_fd)
                # Close before unlink to avoid NFSv3 open-file silly-renames.
                os.close(temp_fd); temp_fd = None
                actual = os.stat(temp_name, dir_fd=stage, follow_symlinks=False)
                if {'device': actual.st_dev, 'inode': actual.st_ino} != identity:
                    raise RuntimeError('Private staged name replaced; retained for review.')
                os.unlink(temp_name, dir_fd=stage)
                os.fsync(stage)
        finally:
            if temp_fd is not None: os.close(temp_fd)
            if parent is not None: os.close(parent)
            os.close(source_fd)


def root_guard(op, plan):
    saved, start = (op.source, op.target, op.job), len(op.held)
    try:
        op.open_media(sealed=True)
        if (precopy.source_identity(op.source) != plan['source_identity']
                or precopy.source_identity(op.target) != plan['target_identity']
                or precopy.read_state(op.job) != plan['nas_marker']):
            raise RuntimeError('Prepared SSD/NAS identity or marker differs.')
    finally:
        for fd in reversed(op.held[start:]): os.close(fd)
        del op.held[start:]
        op.source, op.target, op.job = saved


def deployment_guard(manager, op, plan, baseline, report_fd):
    if (prep.file_hashes() != baseline['config_files_sha256']
            or cutover.read_json(op.output, 'execution.json') != plan['historical_execution']
            or cutover.read_json(report_fd, 'repair-plan.json') != plan):
        raise RuntimeError('Deployment files or reports changed; stop additions.')
    rows = precopy.inspect_containers()
    if precopy.check_consumers(prep.VOLUME, rows) != baseline['consumer_fingerprint']:
        raise RuntimeError('Prepared SSD consumer set changed; stop additions.')
    consumers = cutover.select_services(rows)
    reclaim_plan.health_guard(consumers)
    op.databases(rows)
    if reclaim_plan.extra_source_consumers(rows, {c['Id'] for c in consumers.values()}):
        raise RuntimeError('Unreviewed source consumer appeared.')
    prep.validate_volume(json.loads(manager.run(['docker', 'volume', 'inspect', prep.NFS_VOLUME]))[0])
    root_guard(op, plan)


def execute(manager, profile, report_path):
    planning.reviewed(profile)
    report_fd = open_report(report_path)
    historical_fd = attempt_fd = journal = stage = None
    op = None
    attempt_path = None
    try:
        plan = cutover.read_json(report_fd, 'repair-plan.json')
        if (plan.get('schema') != 1 or plan.get('phase') != 'prepared' or plan.get('report_directory') != report_path
                or plan.get('historical_report') != profile['report'] or plan.get('volume') != prep.VOLUME
                or plan.get('nfs_volume') != prep.NFS_VOLUME or plan.get('application_image') != planning.APP_IMAGE
                or plan.get('gateway_image') != planning.GATEWAY_IMAGE or plan.get('execution_allowed') is not False
                or plan.get('reclaim_ready') is not False or plan.get('nas_marker', {}).get('phase') != 'cutover_running_on_nas'):
            raise RuntimeError('Not a reviewed, non-executable repair plan.')
        tree, dirs, paths = read_manifest(report_fd, plan)
        baseline = cutover.read_json(report_fd, 'deployment-baseline.private.json')
        historical_fd = cutover.open_report(profile['report'])
        op = cutover.Cutover(profile['report'], historical_fd)
        op.state = cutover.read_json(historical_fd, 'execution.json')
        reclaim_plan.require_completed(op.state, op.path)
        op.open_media(sealed=True)
        deployment_guard(manager, op, plan, baseline, report_fd)
        tree, revalidated = recheck_sources(op.source, tree, paths)
        # Prove every source and target parent before the first NAS write.
        for path in paths:
            try:
                fd = open_file(op.source, path, tree); os.close(fd)
                fd = target_parent(op.target, path, dirs); os.close(fd)
            except (OSError, RuntimeError) as exc:
                raise RuntimeError('Candidate cannot be copied: ' + path + '; ' + str(exc))
        capacity = os.fstatvfs(op.target)
        if capacity.f_bavail * capacity.f_frsize < sum(tree[p]['size'] for p in paths) + 1024 ** 3:
            raise RuntimeError('NAS available space is below candidate bytes plus 1 GiB reserve.')
        token = uuid.uuid4().hex
        attempt_name = 'copy-' + token
        os.mkdir(attempt_name, 0o700, dir_fd=report_fd)
        attempt_fd = os.open(attempt_name, DIR_FLAGS, dir_fd=report_fd)
        attempt_path = report_path + '/' + attempt_name
        stage_name = '.mx-static-repair-copy-' + token
        prep.private_write(attempt_fd, 'started.json', {'report': report_path, 'manifest_sha256': plan['manifest_sha256'],
                           'stage_name': stage_name, 'candidates': len(paths), 'reclaim_ready': False})
        if revalidated:
            prep.private_write(attempt_fd, 'source-revalidation.json', {'schema': 1,
                               'manifest_sha256': plan['manifest_sha256'], 'entries': revalidated,
                               'original_manifest_unchanged': True, 'reclaim_ready': False})
        os.fsync(attempt_fd); os.fsync(report_fd)
        os.mkdir(stage_name, 0o700, dir_fd=op.job)
        stage = os.open(stage_name, DIR_FLAGS, dir_fd=op.job)
        if os.fstat(stage).st_dev != os.fstat(op.target).st_dev or os.fstat(stage).st_mode & 0o077:
            raise RuntimeError('Private staging must be on the same NAS filesystem.')
        journal = private_file(attempt_fd, 'copy.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND)
        os.fsync(attempt_fd)  # Persist the journal name before any file publication.
        append(journal, 'stage_directory', name=stage_name, identity=precopy.source_identity(stage))
        copied = present = total = 0
        emit('nas_repair_copy_started', report_directory=report_path, attempt_directory=attempt_path,
             files=len(paths), logical_bytes=sum(tree[p]['size'] for p in paths), production_restart=False,
             write_bytes_per_second=0, bandwidth_unlimited=True, source_ctime_revalidated=len(revalidated))
        last_progress = last_guard = time.monotonic()
        for index, path in enumerate(paths, 1):
            try:
                outcome, sha = copy_one(op.source, op.target, stage, path, tree, dirs, journal)
            except (OSError, RuntimeError) as exc:
                raise RuntimeError('Copy stopped at: ' + path + '; ' + str(exc))
            copied += int(outcome == 'copied'); present += int(outcome == 'already_present')
            total += tree[path]['size']
            if index % 250 == 0 or time.monotonic() - last_guard >= 10:
                deployment_guard(manager, op, plan, baseline, report_fd)
                last_guard = time.monotonic()
            if index % 100 == 0 or time.monotonic() - last_progress >= 10:
                emit('nas_repair_copy_progress', processed=index, candidates=len(paths), copied=copied,
                     already_present=present, logical_bytes=total)
                last_progress = time.monotonic()
        deployment_guard(manager, op, plan, baseline, report_fd)
        actual_stage = os.stat(stage_name, dir_fd=op.job, follow_symlinks=False)
        if {'device': actual_stage.st_dev, 'inode': actual_stage.st_ino} != precopy.source_identity(stage):
            raise RuntimeError('Private staging directory replaced; not removed.')
        os.rmdir(stage_name, dir_fd=op.job); os.fsync(op.job)
        result = {'phase': 'manifest_copy_complete', 'report_directory': report_path,
                  'attempt_directory': attempt_path, 'copied': copied, 'already_present': present,
                  'logical_bytes': total, 'production_restart': False, 'source_deleted': False,
                  'source_ctime_revalidated': len(revalidated),
                  'live_snapshot': True, 'stopped_writer_recheck_required': True, 'reclaim_ready': False}
        prep.private_write(attempt_fd, 'result.json', result); os.fsync(attempt_fd)
        emit('nas_repair_copy_complete', **result)
        return result
    except Exception as exc:
        if attempt_fd is not None:
            prep.private_write(attempt_fd, 'failed.json', {'phase': 'failed_or_partial', 'error': str(exc),
                               'production_restart': False, 'source_deleted': False, 'reclaim_ready': False})
            os.fsync(attempt_fd)
        emit('nas_repair_copy_failed', report_directory=report_path, attempt_directory=attempt_path, error=str(exc))
        raise
    finally:
        for fd in (journal, stage, attempt_fd):
            if fd is not None: os.close(fd)
        if op is not None: op.close()
        if historical_fd is not None: os.close(historical_fd)
        os.close(report_fd)
