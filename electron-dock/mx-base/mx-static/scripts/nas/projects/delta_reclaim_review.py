"""Explicit current-runtime evidence for an already owned delta cleanup plan.

No original plan/runtime/intent edits. This record is not auto-selected, and
cannot authorize missing files without the same durable journal or skip hashes.
"""
from contextlib import contextmanager
import hashlib
import os
import re
import shlex
import time

import cutover_prepare as prep
import precopy
from projects import delta_copy as media
from projects import infra_reclaim_runtime as evidence
from projects import infra_repair_switch
from verify import stamp

POLICY = 'delta-partial-reclaim-runtime-v1'


def binding(plan, plan_sha):
    return dict(plan_directory=plan['plan_directory'], plan_sha256=plan_sha,
        check_sha256=plan['check_sha256'], manifest_sha256=plan['manifest_sha256'],
        target_manifest_sha256=plan['target_manifest_sha256'],
        original_runtime_sha256=plan['runtime_snapshot_sha256'])


def prefix_digest(fd, length):
    os.lseek(fd, 0, os.SEEK_SET)
    sha = hashlib.sha256()
    while length:
        data = os.read(fd, min(length, 1024 ** 2))
        if not data: raise RuntimeError('Runtime review intent journal was truncated.')
        sha.update(data); length -= len(data)
    return sha.hexdigest()


def journal_snapshot(fd):
    before = stamp(os.fstat(fd))
    sha = prefix_digest(fd, before['size'])
    if stamp(os.fstat(fd)) != before: raise RuntimeError('Intent journal changed during runtime review.')
    return {'dev': before['dev'], 'ino': before['ino'], 'size': before['size'], 'sha256': sha}


def save(folder, op, plan, plan_sha, owner, journal, statistics, guard):
    if not owner or owner['phase'] != 'deleting' or journal is None:
        raise RuntimeError('Runtime review requires the existing partial cleanup owner and intent journal.')
    guard()
    before_journal = journal_snapshot(journal)
    changes = evidence.differences(op.original_runtime, op.active_runtime)
    if changes['changed_fields']:
        raise RuntimeError('Runtime review cannot change the registered storage contract/schema/project.')
    name, output = infra_repair_switch.new_directory(folder, 'runtime-review-')
    path = plan['plan_directory'] + '/' + name
    try:
        result = dict(binding(plan, plan_sha), schema=1, policy=POLICY, project=media.PROJECT, volume=media.VOLUME,
            review_directory=path, owner_sha256=evidence.digest(owner), journal=before_journal,
            runtime=op.active_runtime, runtime_sha256=evidence.digest(op.active_runtime),
            source_identity=precopy.source_identity(op.source), target_identity=precopy.source_identity(op.target),
            statistics=statistics, changes=changes, review_passed=True, business_acceptance_recorded=False,
            source_deleted=False, deletion_authorized=False, created_unix=time.time())
        prep.private_write(output, 'review.json', result); os.fsync(output); os.fsync(folder)
        guard()
        if journal_snapshot(journal) != before_journal:
            raise RuntimeError('Intent journal changed before runtime review completion.')
        sha = media.read_private(output, 'review.json')[1]
        # A failed/incomplete review must never be selectable for deletion.
        prep.private_write(output, 'complete.json', dict(schema=1, review_directory=path, review_sha256=sha))
        os.fsync(output); os.fsync(folder)
        # This is only an explicit future command, never execute it here.
        command = ['bash', 'scripts/manage.sh', 'nas', 'delta', 'cleanup', plan['plan_directory'],
            '--runtime-review', path, '--business-accepted', '--ctime-proof-read-mib', str(statistics['recommended_read_mib']),
            '--ctime-proof-pairs', str(statistics['recommended_pairs'])]
        return dict(event='nas_delta_reclaim_runtime_review_complete', plan_directory=plan['plan_directory'],
            review_directory=path, review_sha256=sha, runtime_sha256=result['runtime_sha256'],
            changes=changes, statistics=statistics, resume_command=' '.join(shlex.quote(x) for x in command),
            source_deleted=False, deletion_authorized=False, business_acceptance_pending=True,
            note='Review only. Keep original plan/intents. Explicit selection and current business acceptance required; runtime/files are rechecked before deletion.')
    finally: os.close(output)


@contextmanager
def load(path, plan, plan_sha):
    if not re.fullmatch(re.escape(plan['plan_directory']) + r'/runtime-review-[0-9a-f]{32}', path):
        raise RuntimeError('Runtime review must be an exact child of this same reclaim plan.')
    fd = media.open_absolute(path, private=True)
    try:
        value, sha = media.read_private(fd, 'review.json')
        complete, _ = media.read_private(fd, 'complete.json')
        pinned = {name: stamp(os.stat(name, dir_fd=fd, follow_symlinks=False))
                  for name in ('review.json', 'complete.json')}
        if (value.get('schema') != 1 or value.get('policy') != POLICY or value.get('project') != media.PROJECT
                or value.get('volume') != media.VOLUME or value.get('review_directory') != path
                or value.get('review_passed') is not True or value.get('deletion_authorized') is not False
                or value.get('source_deleted') is not False or value.get('statistics', {}).get('issues') != 0
                or any(value.get(k) != v for k, v in binding(plan, plan_sha).items())
                or value.get('runtime_sha256') != evidence.digest(value.get('runtime'))
                or complete != dict(schema=1, review_directory=path, review_sha256=sha)):
            raise RuntimeError('Runtime review scope/checksum differs; retain the original plan and journal.')

        def guard():
            reopened = media.open_absolute(path, private=True)
            try:
                if (precopy.source_identity(reopened) != precopy.source_identity(fd)
                        or any(stamp(os.stat(name, dir_fd=reopened, follow_symlinks=False)) != info
                               for name, info in pinned.items())):
                    raise RuntimeError('Selected runtime review changed; stop deletion.')
            finally: os.close(reopened)

        guard()
        yield {'path': path, 'sha256': sha, 'value': value, 'guard': guard}
    finally: os.close(fd)


def validate_owner(selection, op, owner, journal):
    value = selection['value']
    if (not owner or owner.get('phase') != 'deleting' or evidence.digest(owner) != value['owner_sha256']
            or journal is None or precopy.source_identity(op.source) != value['source_identity']
            or precopy.source_identity(op.target) != value['target_identity']):
        raise RuntimeError('Runtime review no longer matches the cleanup owner/media identity.')
    expected = value['journal']; before = stamp(os.fstat(journal))
    if (before['dev'] != expected['dev'] or before['ino'] != expected['ino'] or before['size'] < expected['size']
            or prefix_digest(journal, expected['size']) != expected['sha256'] or stamp(os.fstat(journal)) != before):
        raise RuntimeError('Original intent journal prefix differs from runtime review; do not reset it.')
    selection['guard']()
