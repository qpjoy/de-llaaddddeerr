"""Bounded, fresh content proof for NAS-only ctime drift during delta cleanup.

Never alter the plan/manifests or trust a previous proof. Both preflight and the
last per-file deletion check hash again when the frozen NAS stamp differs.
"""
from collections import ChainMap
from contextlib import ExitStack
import os
import re
import stat
import time
import uuid

import cutover
import cutover_prepare as prep
from permissions import emit
from sample_copy import digest
from verify import open_file, stamp

MAX_FILE_BYTES = 16 * 1024 ** 2
MAX_READ_BYTES = 64 * 1024 ** 2
MAX_PAIRS = 64


class CtimeRevalidator:
    def __init__(self, operation, folder, plan, plan_sha, guard):
        self.op, self.folder, self.plan, self.plan_sha = operation, folder, plan, plan_sha
        self.guard = guard
        self.pairs = self.read_bytes = 0

    def __call__(self, path):
        op = self.op
        self.guard()
        parent, leaf = cutover.parent_fd(op.target, path, op.nas_tree)
        try: current = stamp(os.stat(leaf, dir_fd=parent, follow_symlinks=False))
        finally: os.close(parent)
        expected = op.nas_tree[path]
        changed = sorted(k for k in expected if current[k] != expected[k])
        match = re.fullmatch(r'([0-9a-f]{64})\.([A-Za-z0-9]+)', leaf)
        if (changed != ['ctime_ns'] or match is None or match.group(2).lower() == 'tmp'
                or not stat.S_ISREG(current['mode'])
                or current['nlink'] != 1 or current['dev'] != op.nas_tree['']['dev']
                or current['size'] != op.tree[path]['size']):
            raise RuntimeError('NAS file missing/changed; not eligible for ctime-only content proof: ' + path)
        size = current['size']
        if (size > MAX_FILE_BYTES or self.pairs >= MAX_PAIRS or self.read_bytes + 2 * size > MAX_READ_BYTES):
            raise RuntimeError('NAS ctime proof read budget exceeded; retain SSD for review: ' + path)
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
            if source_sha != target_sha or source_sha != match.group(1):
                raise RuntimeError('NAS ctime proof content/filename hash differs; retain SSD: ' + path)
            self.guard()
            name = 'ctime-proof-' + uuid.uuid4().hex + '.json'
            proof = dict(schema=1, policy='delta-nas-ctime-content-v1', path=path,
                plan_directory=self.plan['plan_directory'], plan_sha256=self.plan_sha,
                check_sha256=self.plan['check_sha256'], manifest_sha256=self.plan['manifest_sha256'],
                target_manifest_sha256=self.plan['target_manifest_sha256'],
                runtime_snapshot_sha256=self.plan['runtime_snapshot_sha256'],
                source_metadata=op.tree[path], recorded_nas_metadata=expected, current_nas_metadata=current,
                source_sha256=source_sha, nas_sha256=target_sha, hashed_bytes=2 * size, time_unix=time.time())
            prep.private_write(self.folder, name, proof); os.fsync(self.folder)
            self.guard()
            stable()  # Including changes during proof write/fsync or the final runtime check.
            emit('nas_delta_reclaim_ctime_revalidated', path=path, sha256=source_sha, hashed_bytes=2 * size,
                 proof_file=self.plan['plan_directory'] + '/' + name, manifests_unchanged=True, nas_written=False)
