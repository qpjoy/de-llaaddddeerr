"""Bounded, fresh content proof for NAS-only ctime drift during delta cleanup.

Never alter the plan/manifests or trust a previous proof. Both preflight and the
last per-file deletion check hash again when the frozen NAS stamp differs.
"""
from collections import ChainMap
from contextlib import ExitStack
import os
import re
import shlex
import stat
import time
import uuid

import cutover
import cutover_prepare as prep
import reclaim
from permissions import emit
from sample_copy import digest
from verify import open_file, stamp

MAX_FILE_BYTES = 16 * 1024 ** 2
MAX_READ_BYTES = 64 * 1024 ** 2
MAX_PAIRS = 64


def limits(read_mib=None, pairs=None):
    # Finite explicit I/O budgets; ceilings cover two reads of both copies of
    # the registered delta maximum (2 TiB / 400,000 files), never unlimited.
    if read_mib is not None and (type(read_mib) is not int or not 1 <= read_mib <= 8 * 1024 ** 2):
        raise RuntimeError('ctime-proof-read-mib must be an integer from 1 to 8388608.')
    if pairs is not None and (type(pairs) is not int or not 1 <= pairs <= 800000):
        raise RuntimeError('ctime-proof-pairs must be an integer from 1 to 800000.')
    read_bytes = MAX_READ_BYTES if read_mib is None else read_mib * 1024 ** 2
    return {'max_file_bytes': MAX_FILE_BYTES if read_mib is None else read_bytes // 4,
            'max_read_bytes': read_bytes, 'max_pairs': MAX_PAIRS if pairs is None else pairs}


def candidate(op, path, current):
    expected = op.nas_tree[path]
    changed = sorted(k for k in expected if current[k] != expected[k])
    match = re.fullmatch(r'([0-9a-f]{64})\.([A-Za-z0-9]+)', path.rpartition('/')[2])
    eligible = (changed == ['ctime_ns'] and match is not None and match.group(2).lower() != 'tmp'
                and stat.S_ISREG(current['mode']) and current['nlink'] == 1
                and current['dev'] == op.nas_tree['']['dev'] and current['size'] == op.tree[path]['size'])
    return (match.group(1) if eligible else None), changed


def inspect_remaining(op, paths, plan, guard):
    """Read metadata only, including partially reclaimed plans. Not content proof."""
    guard()
    dirs = reclaim.open_directories(op.target, op.nas_tree, True)
    count = total = largest = issues = 0
    examples = []; errors = []; last = time.monotonic()
    try:
        for index, path in enumerate(paths, 1):
            parent, _, leaf = path.rpartition('/')
            try:
                current = stamp(os.stat(leaf, dir_fd=dirs[parent], follow_symlinks=False))
                if current != op.nas_tree[path]:
                    digest_name, changed = candidate(op, path, current)
                    if digest_name:
                        count += 1; total += current['size']; largest = max(largest, current['size'])
                        if len(examples) < 20: examples.append({'path': path, 'size': current['size']})
                    else:
                        issues += 1
                        if len(errors) < 20: errors.append({'path': path, 'changed_fields': changed})
            except OSError as exc:
                issues += 1
                if len(errors) < 20: errors.append({'path': path, 'error': str(exc)})
            if time.monotonic() - last >= 10:
                emit('nas_delta_reclaim_ctime_inspect_progress', checked=index, total=len(paths), metadata_only=True)
                guard(); last = time.monotonic()
        guard()
    finally:
        for fd in dirs.values(): os.close(fd)
    # Each candidate is rehashed on both sides at preflight AND before unlink.
    read_mib = max(64, (4 * total + 1024 ** 2 - 1) // 1024 ** 2)
    pairs = max(64, 2 * count)
    limits(read_mib, pairs)
    command = ['bash', 'scripts/manage.sh', 'nas', 'delta', 'cleanup', plan['plan_directory'],
               '--business-accepted', '--ctime-proof-read-mib', str(read_mib), '--ctime-proof-pairs', str(pairs)]
    return dict(plan_directory=plan['plan_directory'], remaining_files=len(paths),
        missing_with_intent=plan['regular_files']-len(paths), ctime_only_candidates=count,
        candidate_logical_bytes=total, largest_candidate_bytes=largest, planned_read_bytes=4*total,
        planned_hash_pairs=2*count, issues=issues, examples=examples, errors=errors,
        recommended_read_mib=read_mib, recommended_pairs=pairs,
        resume_command=' '.join(shlex.quote(x) for x in command) if not issues else None,
        metadata_only=True, live_snapshot=True, content_verified=False, source_deleted=False,
        deletion_authorized=False, manifests_unchanged=True,
        note='Cost estimate only; existing plan/intents retained. Execution must freshly prove every exception; later drift can exceed this budget.')


class CtimeRevalidator:
    def __init__(self, operation, folder, plan, plan_sha, guard, budget=None):
        self.op, self.folder, self.plan, self.plan_sha = operation, folder, plan, plan_sha
        self.guard = guard
        self.budget = budget
        self.phase = 'preflight'
        self.pairs = self.read_bytes = 0

    def __call__(self, path):
        op = self.op
        self.guard()
        parent, leaf = cutover.parent_fd(op.target, path, op.nas_tree)
        try: current = stamp(os.stat(leaf, dir_fd=parent, follow_symlinks=False))
        finally: os.close(parent)
        expected = op.nas_tree[path]
        digest_name, _ = candidate(op, path, current)
        if digest_name is None:
            raise RuntimeError('NAS file missing/changed; not eligible for ctime-only content proof: ' + path)
        size = current['size']
        budget = self.budget if self.budget is not None else limits()
        exceeded = [key for key, needed in (('max_file_bytes', size), ('max_pairs', self.pairs+1),
                    ('max_read_bytes', self.read_bytes+2*size)) if needed > budget[key]]
        if exceeded:
            emit('nas_delta_reclaim_ctime_budget_exceeded', path=path, phase=self.phase, exceeded=exceeded,
                 file_bytes=size, pairs_used=self.pairs, read_bytes_used=self.read_bytes,
                 next_pair_read_bytes=2*size, limits=budget, plan_directory=self.plan['plan_directory'])
            raise RuntimeError('NAS ctime proof read budget exceeded (' + ', '.join(exceeded) +
                               '); inspect the same plan with --inspect-ctime before changing budgets: ' + path)
        self.pairs += 1; self.read_bytes += 2 * size
        # Overlay one expected stat in memory, never refresh the immutable NAS manifest.
        target_tree = ChainMap({path: current}, op.nas_tree)
        with ExitStack() as stack:
            source = open_file(op.source, path, op.tree); stack.callback(os.close, source)
            target = open_file(op.target, path, target_tree); stack.callback(os.close, target)

            def stable():
                for root, fd, tree in ((op.source, source, op.tree), (op.target, target, target_tree)):
                    if stamp(os.fstat(fd)) != tree[path]:
                        raise RuntimeError('File changed during NAS ctime proof: ' + path)
                    # Reopen from the pinned root: a detached/replaced name is not proof.
                    reopened = open_file(root, path, tree)
                    os.close(reopened)

            source_sha, target_sha = digest(source, size), digest(target, size)
            stable()
            if source_sha != target_sha or source_sha != digest_name:
                raise RuntimeError('NAS ctime proof content/filename hash differs; retain SSD: ' + path)
            self.guard()
            name = 'ctime-proof-' + uuid.uuid4().hex + '.json'
            proof = dict(schema=1, policy='delta-nas-ctime-content-v1', path=path,
                plan_directory=self.plan['plan_directory'], plan_sha256=self.plan_sha,
                check_sha256=self.plan['check_sha256'], manifest_sha256=self.plan['manifest_sha256'],
                target_manifest_sha256=self.plan['target_manifest_sha256'],
                runtime_snapshot_sha256=self.plan['runtime_snapshot_sha256'],
                source_metadata=op.tree[path], recorded_nas_metadata=expected, current_nas_metadata=current,
                source_sha256=source_sha, nas_sha256=target_sha, hashed_bytes=2 * size, time_unix=time.time(),
                phase=self.phase, limits=budget)
            selection = getattr(op, 'runtime_selection', None)
            if selection is not None:
                proof.update(runtime_review_directory=selection['path'], runtime_review_sha256=selection['sha256'],
                             active_runtime_sha256=selection['value']['runtime_sha256'])
            prep.private_write(self.folder, name, proof); os.fsync(self.folder)
            self.guard()
            stable()  # Including changes during proof write/fsync or the final runtime check.
            emit('nas_delta_reclaim_ctime_revalidated', path=path, sha256=source_sha, hashed_bytes=2 * size,
                 proof_file=self.plan['plan_directory'] + '/' + name, manifests_unchanged=True, nas_written=False)
