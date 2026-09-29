"""Explicit delta SSD-only reclamation, separate from ordinary NAS recovery.

Prepare records acceptance and revalidates an exact immutable check. Execution
requires the resulting plan and acceptance flag, revalidates again, and journals
each bounded batch before unlink. No Docker lifecycle, NAS writes or rmdir.
"""
from contextlib import ExitStack, contextmanager
import json
import os
import shlex
import re
import stat
import time
from types import SimpleNamespace

import cutover
import cutover_prepare as prep
import precopy
import reclaim
import reclaim_plan
from permissions import emit
from projects import delta_copy as media
from projects import delta_reclaim as review
from projects import delta_reclaim_files as proof_files
from projects import delta_reclaim_review as runtime_reviews
from projects.delta_reclaim_files import CtimeRevalidator
from projects import delta_runtime as runtime
from projects import infra_reclaim as files
from projects import infra_reclaim_runtime as evidence
from projects import infra_repair_switch
from verify import stamp

POLICY = 'delta-retained-reclaim-v1'
OWNER = 'ssd-reclaim.json'


def split_path(path, kind):
    match = re.fullmatch('(' + re.escape(runtime.REPORT_ROOT) + r'/delta-[0-9a-f]{32})/(reclaim-' + kind + '-[0-9a-f]{32})', path)
    if not match: raise RuntimeError('Use the exact delta reclaim ' + kind + ' directory.')
    return match.group(1), match.group(2)


def owner(output):
    try: value = media.read_private(output, OWNER)[0]
    except FileNotFoundError: return None
    if (value.get('schema') != 1 or value.get('project') != media.PROJECT or value.get('volume') != media.VOLUME
            or value.get('phase') not in ('deleting', 'ssd_files_reclaimed')):
        raise RuntimeError('Invalid delta SSD reclaim ownership; retain the record for review.')
    return value


def status(manager, profile):
    record = runtime.read_record(manager, optional=True)
    if record is None: return None
    runtime.registered(manager, profile)
    output = media.open_absolute(record['source_report'], private=True)
    try: return owner(output)
    finally: os.close(output)


@contextmanager
def context(manager, profile, check_path, reviewing_runtime=False, selection=None):
    report, _ = split_path(check_path, 'check')
    runtime.registered(manager, profile); runtime.maintenance_guard(manager)
    record = runtime.read_record(manager)
    if record['source_report'] != report: raise RuntimeError('Check is not from the registered delta switch.')
    with ExitStack() as stack:
        def open_directory(path):
            fd = media.open_absolute(path, private=True); stack.callback(os.close, fd)
            return fd
        output, folder = open_directory(report), open_directory(check_path)
        check, check_sha = media.read_private(folder, 'check.json')
        state, state_sha = media.read_private(output, 'execution.json')
        baseline, baseline_sha = media.read_private(output, 'baseline.private.json')
        saved_runtime, _ = media.read_private(folder, 'runtime.json')
        if (check.get('schema') != 1 or check.get('nas_verification') != review.POLICY
                or check.get('state') != 'verification_complete' or check.get('project') != media.PROJECT
                or check.get('volume') != media.VOLUME or check.get('source') != media.SOURCE
                or check.get('target') != media.TARGET or check.get('report_directory') != report
                or check.get('check_directory') != check_path or check.get('files_verified') is not True
                or check.get('source_deleted') is not False or check.get('preserve_source_root') is not True
                or check.get('preserve_other_media') is not True or check.get('recovery', {}).get('verified') is not True
                or check.get('cutover_execution_sha256') != state_sha or check.get('baseline_sha256') != baseline_sha
                or check.get('runtime_snapshot_sha256') != evidence.digest(saved_runtime)):
            raise RuntimeError('Delta check scope/evidence differs; never use an infra plan.')
        if (state.get('schema') != 1 or state.get('project') != media.PROJECT or state.get('volume') != media.VOLUME
                or state.get('phase') != 'running_on_nas' or state.get('report_directory') != report
                or state.get('final_sync_passed') is not True or state.get('nas_may_have_writes') is not True
                or state.get('source_deleted') is not False or state.get('ssd_reclaim')
                or set(state.get('new_ids', {})) != precopy.SERVICES):
            raise RuntimeError('Successful delta cutover evidence required.')
        op = SimpleNamespace(path=report, output=output, state=state)
        tree = files.read_tree(folder, 'files.jsonl', check['manifest_sha256'])
        nas_tree = files.read_tree(folder, 'nas-files.jsonl', check['target_manifest_sha256'])
        frozen, frozen_sha = files.stopped_tree(op)
        totals = reclaim_plan.summarize_tree(tree)
        if (tree != frozen or check.get('stopped_manifest_sha256') != frozen_sha
                or any(check.get(k) != v for k, v in totals.items())
                or totals['regular_files'] > media.MAX_FILES or totals['logical_bytes'] > media.MAX_BYTES
                or set(tree) != set(nas_tree)
                or any(stat.S_IFMT(a['mode']) != stat.S_IFMT(nas_tree[p]['mode']) or
                       (stat.S_ISREG(a['mode']) and a['size'] != nas_tree[p]['size']) for p, a in tree.items())):
            raise RuntimeError('Delta manifests no longer cover the exact stopped inventory.')
        view = stack.enter_context(media.media())
        identity = media.identity(view)
        if (identity != baseline['copy']['media_identity']
                or view['source_identity'] != check['source_identity'] or view['target_identity'] != check['target_identity']
                or {'device': tree['']['dev'], 'inode': tree['']['ino']} != view['source_identity']
                or {'device': nas_tree['']['dev'], 'inode': nas_tree['']['ino']} != view['target_identity']):
            raise RuntimeError('Delta media identity differs from the verified check.')
        final_fd = open_directory(state['final_review'])
        pinned_dirs = [(report, output), (check_path, folder), (state['final_review'], final_fd)]
        pinned_files = [(fd, name, stamp(os.stat(name, dir_fd=fd, follow_symlinks=False))) for fd, names in (
            (output, ('execution.json', 'baseline.private.json')),
            (folder, ('check.json', 'files.jsonl', 'nas-files.jsonl', 'runtime.json', 'hashes.jsonl')),
            (final_fd, ('result.json', 'files.jsonl'))) for name in names]
        if manager.run(['findmnt', '-rn', '-T', report, '-o', 'FSTYPE']).strip() not in ('xfs', 'ext4', 'btrfs'):
            raise RuntimeError('Reclaim evidence must reside on local storage.')
        capacity = os.fstatvfs(output)
        if capacity.f_bavail * capacity.f_frsize < 1024 ** 3: raise RuntimeError('Need 1 GiB local journal space.')
        active_runtime = saved_runtime
        if reviewing_runtime:
            if selection is not None: raise RuntimeError('Review and selection must be separate operations.')
            active_runtime, _ = review.snapshot(manager, profile)
        elif selection is not None:
            active_runtime = selection['value']['runtime']
        if evidence.differences(saved_runtime, active_runtime)['changed_fields']:
            raise RuntimeError('Runtime review cannot change the registered storage contract/schema/project.')

        def guard():
            if selection is not None: selection['guard']()
            if manager.profiles()['part2'] != profile or runtime.read_record(manager) != record:
                raise RuntimeError('Delta registration changed; stop reclaim.')
            for path, fd in pinned_dirs:
                reopened = media.open_absolute(path, private=True)
                try:
                    if precopy.source_identity(reopened) != precopy.source_identity(fd):
                        raise RuntimeError('Delta evidence directory replaced; stop reclaim.')
                finally: os.close(reopened)
            for fd, name, expected in pinned_files:
                if stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)) != expected:
                    raise RuntimeError('Delta immutable evidence changed; stop reclaim: ' + name)
            with media.media() as current:
                if media.identity(current) != identity: raise RuntimeError('Delta source/NAS path changed; stop reclaim.')
            actual, rows = review.snapshot(manager, profile)
            evidence.require_same(active_runtime, actual, 'delta_reclaim_runtime_review' if reviewing_runtime else 'delta_reclaim',
                                  'Delta runtime changed since check; retain SSD and review before continuing.')
            if not review.recovery_evidence(manager)['verified']:
                raise RuntimeError('Delta recovery is not current/enabled; stop reclaim.')
            return rows

        def probes():
            rows = guard()
            code = ('import os,json; p="/app/media/data_hub_raw_media"; '
                    'assert os.stat(p).st_ino==' + str(view['target_identity']['inode']) + '; '
                    'assert any(x.split()[4]==p and " - nfs " in x for x in open("/proc/self/mountinfo")); '
                    'print(json.dumps({"nfs_identity_passed":True}))')
            result = json.loads(manager.run(['docker', 'exec', rows['web']['Id'], 'python', '-c', code], timeout=None))
            if result != {'nfs_identity_passed': True}: raise RuntimeError('Delta current NAS identity probe failed.')
            cutover.Cutover.http_probe(op, rows)
            guard()

        guard()
        yield SimpleNamespace(output=output, report=report, check=check, check_sha=check_sha,
            source=view['source'], target=view['target'], tree=tree, nas_tree=nas_tree,
            totals=totals, guard=guard, probes=probes, original_runtime=saved_runtime, active_runtime=active_runtime,
            runtime_selection=selection)


def prepare(manager, profile, check_path, business_accepted=False):
    if not business_accepted: raise RuntimeError('Actual business acceptance and --business-accepted required.')
    folder = None; path = None
    try:
        with context(manager, profile, check_path) as op:
            if owner(op.output) is not None: raise RuntimeError('SSD reclaim already owns a plan; do not replace it.')
            remaining = reclaim.remaining_files(op.source, op.tree, set())
            reclaim.check_nas_files(op.target, op.tree, remaining, nas_tree=op.nas_tree)
            op.probes()
            if reclaim.remaining_files(op.source, op.tree, set()) != remaining:
                raise RuntimeError('Delta SSD changed during preparation.')
            op.guard()
            name, folder = infra_repair_switch.new_directory(op.output, 'reclaim-plan-')
            path = op.report + '/' + name
            plan = dict(op.totals, schema=1, policy=POLICY, project=media.PROJECT, volume=media.VOLUME,
                report_directory=op.report, plan_directory=path, check_directory=check_path, check_sha256=op.check_sha,
                manifest_sha256=op.check['manifest_sha256'], target_manifest_sha256=op.check['target_manifest_sha256'],
                runtime_snapshot_sha256=op.check['runtime_snapshot_sha256'], business_acceptance_recorded=True,
                reclaim_ready=True, deletion_supported=True, deletion_authorized=False, source_deleted=False,
                time_unix=time.time())
            prep.private_write(folder, 'plan.json', plan); os.fsync(folder); os.fsync(op.output)
            emit('nas_delta_reclaim_prepare_complete', **plan)
            return plan
    except Exception as exc:
        emit('nas_delta_reclaim_prepare_failed', plan_directory=path, error=str(exc), source_deleted=False)
        raise
    finally:
        if folder is not None: os.close(folder)


def execute(manager, profile, plan_path, business_accepted=False, inspect_ctime=False,
            ctime_proof_read_mib=None, ctime_proof_pairs=None, review_runtime=False, runtime_review=None):
    if review_runtime and (inspect_ctime or runtime_review): raise RuntimeError('Runtime review and selection/inspection must be separate operations.')
    readonly = inspect_ctime or review_runtime
    if not readonly and not business_accepted: raise RuntimeError('Explicit --business-accepted required for SSD deletion.')
    budget = proof_files.limits(ctime_proof_read_mib, ctime_proof_pairs)
    report, _ = split_path(plan_path, 'plan')
    folder = journal = None; started = False; owner_checked = False
    selections = ExitStack()
    try:
        folder = media.open_absolute(plan_path, private=True)
        plan, plan_sha = media.read_private(folder, 'plan.json')
        if (plan.get('schema') != 1 or plan.get('policy') != POLICY or plan.get('project') != media.PROJECT
                or plan.get('volume') != media.VOLUME or plan.get('report_directory') != report
                or plan.get('plan_directory') != plan_path or plan.get('business_acceptance_recorded') is not True
                or plan.get('reclaim_ready') is not True or plan.get('deletion_supported') is not True
                or plan.get('deletion_authorized') is not False or plan.get('source_deleted') is not False):
            raise RuntimeError('An accepted delta reclaim plan is required; checks are not deletion plans.')
        selection = selections.enter_context(runtime_reviews.load(runtime_review, plan, plan_sha)) if runtime_review else None
        with context(manager, profile, plan['check_directory'], reviewing_runtime=review_runtime, selection=selection) as op:
            if (op.report != report or op.check_sha != plan['check_sha256']
                    or any(plan.get(k) != v for k, v in op.totals.items())
                    or any(plan.get(k) != op.check[k] for k in ('manifest_sha256', 'target_manifest_sha256', 'runtime_snapshot_sha256'))):
                raise RuntimeError('Delta plan no longer matches its check.')
            identity = {'schema': 1, 'project': media.PROJECT, 'volume': media.VOLUME,
                        'plan_directory': plan_path, 'plan_sha256': plan_sha, 'manifest_sha256': plan['manifest_sha256']}
            saved = owner(op.output)
            owner_checked = True
            started = saved is not None and saved['phase'] == 'deleting'
            if saved is not None and any(saved.get(k) != v for k, v in identity.items()):
                raise RuntimeError('Another delta reclaim plan owns the deletion journal; do not replace it.')
            if saved is not None and saved['phase'] == 'ssd_files_reclaimed':
                result = media.read_private(folder, 'reclaim-result.json')[0]
                if result != saved: raise RuntimeError('Delta completion receipts differ; preserve them for review.')
                emit('nas_delta_reclaim_already_complete', **result)
                return result
            # Never adopt an orphan journal as permission for pre-existing holes.
            if saved is None:
                if review_runtime or selection is not None:
                    raise RuntimeError('Runtime review requires the existing partial cleanup owner; use a fresh check before deletion starts.')
                for name in ('unlink-intents.jsonl', 'reclaim-result.json'):
                    try: os.stat(name, dir_fd=folder, follow_symlinks=False)
                    except FileNotFoundError: continue
                    raise RuntimeError('Unowned delta reclaim journal/receipt; review before deleting.')
            else:
                started = True
                journal = reclaim.private_file(folder, 'unlink-intents.jsonl',
                    os.O_RDONLY if readonly else os.O_RDWR | os.O_APPEND)
                if os.fstat(journal).st_nlink != 1: raise RuntimeError('Unsafe reclaim journal hardlink.')
                if not readonly: os.fsync(folder)
            if selection is not None: runtime_reviews.validate_owner(selection, op, saved, journal)

            def guard():
                op.guard()
                opened = media.open_absolute(plan_path, private=True)
                try:
                    if (precopy.source_identity(opened) != precopy.source_identity(folder)
                            or media.read_private(opened, 'plan.json')[1] != plan_sha
                            or owner(op.output) != saved):
                        raise RuntimeError('Delta cleanup plan/ownership changed; stop deletion.')
                finally: os.close(opened)
                if journal is not None:
                    info = os.stat('unlink-intents.jsonl', dir_fd=folder, follow_symlinks=False)
                    if info.st_nlink != 1 or (info.st_dev, info.st_ino) != (os.fstat(journal).st_dev, os.fstat(journal).st_ino):
                        raise RuntimeError('Delta cleanup journal replaced; stop deletion.')

            guard()
            permitted = reclaim.read_intents(journal, op.tree) if journal is not None else set()
            remaining = reclaim.remaining_files(op.source, op.tree, permitted)
            if readonly:
                before_journal = stamp(os.fstat(journal)) if journal is not None else None
                result = proof_files.inspect_remaining(op, remaining, plan, guard)
                if (reclaim.remaining_files(op.source, op.tree, permitted) != remaining or
                        (journal is not None and stamp(os.fstat(journal)) != before_journal)):
                    raise RuntimeError('SSD/intent journal changed during ctime inspection.')
                guard()
                if review_runtime:
                    # Do not publish a command without explicit runtime selection.
                    result['resume_command'] = None
                    if result['issues']:
                        emit('nas_delta_reclaim_ctime_inspect_complete', **result)
                        raise RuntimeError('Non-ctime NAS differences require review; SSD retained.')
                    op.probes()
                    guard()
                    if (reclaim.remaining_files(op.source, op.tree, permitted) != remaining or
                            stamp(os.fstat(journal)) != before_journal):
                        raise RuntimeError('SSD/intent journal changed during runtime review probes.')
                    result = runtime_reviews.save(folder, op, plan, plan_sha, saved, journal, result, guard)
                    emit(result.pop('event'), **result)
                    return result
                if selection is not None and result['resume_command']:
                    result['resume_command'] += ' --runtime-review ' + shlex.quote(selection['path'])
                emit('nas_delta_reclaim_ctime_inspect_complete', **result)
                if result['issues']: raise RuntimeError('Non-ctime NAS differences require review; SSD retained.')
                return result
            revalidate = CtimeRevalidator(op, folder, plan, plan_sha, guard, budget=budget)
            reclaim.check_nas_files(op.target, op.tree, remaining, nas_tree=op.nas_tree, revalidate=revalidate)
            op.probes()
            if reclaim.remaining_files(op.source, op.tree, permitted) != remaining:
                raise RuntimeError('Delta SSD changed during deletion preflight.')
            guard()
            if saved is None:
                saved = dict(identity, phase='deleting', business_accepted=True, started_unix=time.time())
                prep.private_write(op.output, OWNER, saved); os.fsync(op.output)
                started = True
                journal = reclaim.private_file(folder, 'unlink-intents.jsonl', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_APPEND)
                os.fsync(folder)
            guard()
            emit('nas_delta_reclaim_started', plan_directory=plan_path, files_remaining=len(remaining),
                 business_accepted=True, nas_deleted=False, source_root_retained=True)
            before = os.fstatvfs(op.source)
            revalidate.phase = 'deleting'
            removed, logical = reclaim.delete_files(op.source, op.target, op.tree, remaining, journal, guard,
                                                    nas_tree=op.nas_tree, revalidate=revalidate)
            if reclaim.remaining_files(op.source, op.tree, reclaim.read_intents(journal, op.tree)):
                raise RuntimeError('Delta SSD still contains manifested files.')
            guard()
            after = os.fstatvfs(op.source)
            result = dict(identity, phase='ssd_files_reclaimed', business_accepted=True,
                source_deleted=True, nas_deleted=False, source_root_retained=True, other_media_retained=True,
                manifest_files_total=plan['regular_files'], manifest_logical_bytes=plan['logical_bytes'],
                removed_this_run=removed, logical_bytes_this_run=logical,
                data_available_before_bytes=before.f_bavail * before.f_frsize,
                data_available_after_bytes=after.f_bavail * after.f_frsize, completed_unix=time.time())
            if selection is not None:
                result.update(runtime_review_directory=selection['path'], runtime_review_sha256=selection['sha256'],
                              active_runtime_sha256=evidence.digest(op.active_runtime))
            cutover.atomic_json(folder, 'reclaim-result.json', result)
            cutover.atomic_json(op.output, OWNER, result)
            emit('nas_delta_reclaim_complete', **result)
            return result
    except Exception as exc:
        emit('nas_delta_reclaim_failed', plan_directory=plan_path, error=str(exc),
             may_be_partially_reclaimed=started if owner_checked else None, prior_ownership_checked=owner_checked,
             inspect_only=readonly,
             note='Keep exact plan and intent journal. No rollback. Retry only this same plan after reviewing the failure.')
        raise
    finally:
        selections.close()
        if journal is not None: os.close(journal)
        if folder is not None: os.close(folder)
