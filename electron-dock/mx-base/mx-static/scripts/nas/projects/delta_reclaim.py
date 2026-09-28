"""Delta retained-SSD review only. Never stop services, copy or delete media.

The successful delta switch and stopped inventory remain immutable. A new
private check pins the CURRENT runtime, independently of historic app settings.
This receipt is deliberately not consumable by the infra SSD deleter.
"""
import json
import os
import stat
import time
from types import SimpleNamespace

import cutover
import cutover_prepare as prep
import precopy
import reclaim
import reclaim_plan
import recovery
from permissions import emit
from projects import delta_copy as media
from projects import delta_runtime as runtime
from projects import infra_reclaim as files
from projects import infra_reclaim_runtime as evidence
from projects import infra_repair_switch, infra_services, infra_storage

POLICY = 'delta-retained-review-v1'


def aliases(manager, profile, containers, selected_ids):
    names = sorted({m['Name'] for c in containers for m in c.get('Mounts', []) if m.get('Type') == 'volume'})
    volumes = json.loads(manager.run(['docker', 'volume', 'inspect'] + names)) if names else []
    if len(volumes) != len(names) or {v['Name'] for v in volumes} != set(names):
        raise RuntimeError('Incomplete attached volume inspection.')
    nfs_root = '/data/docker/volumes/' + media.NFS_VOLUME + '/_data'
    roots = (media.SOURCE, media.TARGET, nfs_root)
    for v in volumes:
        if v['Name'] == media.NFS_VOLUME:
            infra_storage.validate_volume(profile, v)
            continue
        if v['Name'] == media.VOLUME and (v.get('Driver') != 'local' or v.get('Options')):
            raise RuntimeError('Delta SSD parent volume is no longer plain local storage.')
        device = (v.get('Options') or {}).get('device', '')
        remote = device.split(':', 1)[-1]
        if ((device.startswith('/') and any(media.overlaps(device, p) for p in roots))
                or (remote.startswith('/') and media.overlaps(remote, media.EXPORT_TARGET))):
            raise RuntimeError('An attached volume aliases delta media; retain SSD.')
    for c in containers:
        for m in c.get('Mounts', []):
            path = m.get('Source', '')
            if (m.get('Name') not in (media.VOLUME, media.NFS_VOLUME)
                    and not (path.startswith('/') and any(media.overlaps(path, p) for p in roots))):
                continue
            # Only a verified NAS child's hidden SSD parent and that NAS child
            # are permitted, even within an otherwise approved container.
            if c['Id'] in selected_ids and m.get('Type') == 'volume':
                if (m.get('Name'), path, m.get('Destination')) in (
                        (media.VOLUME, media.SSD_PARENT, '/app/media'),
                        (media.NFS_VOLUME, nfs_root, media.RAW)):
                    continue
            raise RuntimeError('An extra mount can access delta media; retain SSD: ' + c['Id'][:12])


def snapshot(manager, profile):
    policy = runtime.registered(manager, profile)
    runtime.maintenance_guard(manager)
    inspection = infra_storage.collect(manager, profile)
    mounted = runtime.inspect(manager, profile, require_running=True, inspection=inspection)
    rows = {}
    required = precopy.SERVICES | infra_services.DEPENDENCIES
    for c in inspection[0]:
        labels = c.get('Config', {}).get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') != media.PROJECT or name not in required:
            continue
        if name in rows or str(labels.get('com.docker.compose.oneoff', 'false')).lower() != 'false':
            raise RuntimeError('Ambiguous delta service: ' + name)
        state = c.get('State', {})
        if (state.get('Running') is not True or any(state.get(k) for k in ('Paused', 'Restarting', 'OOMKilled', 'Dead'))
                or state.get('Health', {}).get('Status') == 'unhealthy'):
            raise RuntimeError('Delta service is not stably running: ' + name)
        if name in {'web', 'chat-gateway', 'gateway', 'postgres', 'redis'} and state.get('Health', {}).get('Status') != 'healthy':
            raise RuntimeError('Delta service is not healthy: ' + name)
        rows[name] = c
    if set(rows) != required:
        raise RuntimeError('Delta media/database/queue service missing.')
    infra_services.order({n: infra_services.dependencies(n, c) for n, c in rows.items()}, policy)
    aliases(manager, profile, inspection[0], set(mounted))
    value = {'schema': 1, 'project': media.PROJECT, 'contract_sha256': runtime.contract(manager, profile)[2],
             'services': {n: evidence.fingerprint(c) for n, c in rows.items()}}
    return value, rows


def recovery_evidence(manager):
    installed = recovery.installed_current(manager)
    selected = recovery.requested(manager.auto_config(), 'part2')
    text = manager.run(['systemctl', 'show', manager.UNIT + '.timer',
                        '--property=LoadState,ActiveState,UnitFileState'])
    timer = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    return {'installed_current': installed, 'selected': selected, 'timer': timer,
            'verified': installed and selected and timer.get('LoadState') == 'loaded'
                        and timer.get('ActiveState') == 'active' and timer.get('UnitFileState') == 'enabled'}


def check(manager, profile, business_accepted=False):
    output = folder = None
    path = None
    try:
        runtime.registered(manager, profile)
        runtime.maintenance_guard(manager)
        record = runtime.read_record(manager)
        report = record['source_report']
        output = media.open_absolute(report, private=True)
        from projects.delta_cleanup import owner
        if owner(output) is not None:
            raise RuntimeError('Delta SSD reclaim has started/completed; keep its exact plan and journal, do not rebase the check.')
        state, state_sha = media.read_private(output, 'execution.json')
        baseline, baseline_sha = media.read_private(output, 'baseline.private.json')
        if (state.get('schema') != 1 or state.get('project') != media.PROJECT or state.get('volume') != media.VOLUME
                or state.get('report_directory') != report or state.get('phase') != 'running_on_nas'
                or state.get('final_sync_passed') is not True or state.get('nas_may_have_writes') is not True
                or state.get('source_deleted') is not False or state.get('ssd_reclaim')
                or set(state.get('new_ids', {})) != precopy.SERVICES):
            raise RuntimeError('A successful delta switch with retained SSD is required.')
        current, rows = snapshot(manager, profile)
        restored = recovery_evidence(manager)
        if not restored['verified']:
            raise RuntimeError('Delta recovery must be installed, current and enabled before SSD review.')
        if manager.run(['findmnt', '-rn', '-T', report, '-o', 'FSTYPE']).strip() not in ('xfs', 'ext4', 'btrfs'):
            raise RuntimeError('Delta check reports must stay on local storage.')
        space = os.fstatvfs(output)
        if space.f_bavail * space.f_frsize < 1024 ** 3:
            raise RuntimeError('Need 1 GiB local report space.')
        op = SimpleNamespace(path=report, output=output, state=state)
        frozen, frozen_sha = files.stopped_tree(op)
        with media.media() as view:
            original_identity = baseline['copy']['media_identity']
            if media.identity(view) != original_identity:
                raise RuntimeError('Delta SSD/NAS/marker identity changed since switch.')
            if {'device': frozen['']['dev'], 'inode': frozen['']['ino']} != view['source_identity']:
                raise RuntimeError('Stopped inventory belongs to another SSD directory.')

            def guard():
                if manager.profiles()['part2'] != profile or runtime.read_record(manager) != record:
                    raise RuntimeError('Delta registration changed during verification.')
                reopened = media.open_absolute(report, private=True)
                try:
                    if precopy.source_identity(reopened) != precopy.source_identity(output):
                        raise RuntimeError('Delta report directory changed during verification.')
                finally: os.close(reopened)
                if (media.read_private(output, 'execution.json')[1] != state_sha
                        or media.read_private(output, 'baseline.private.json')[1] != baseline_sha):
                    raise RuntimeError('Delta switch evidence changed during verification.')
                with media.media() as fresh_view:
                    if media.identity(fresh_view) != original_identity:
                        raise RuntimeError('Delta SSD/NAS path changed during verification.')
                fresh_runtime, live_rows = snapshot(manager, profile)
                evidence.require_same(current, fresh_runtime, 'delta_read_only_check',
                                      'Delta runtime changed during verification; SSD retained.')
                if recovery_evidence(manager) != restored:
                    raise RuntimeError('Delta recovery changed during verification.')
                return live_rows

            guard()
            name, folder = infra_repair_switch.new_directory(output, 'reclaim-check-')
            path = report + '/' + name
            emit('nas_delta_reclaim_check_started', check_directory=path, source_deleted=False)
            prep.private_write(folder, 'runtime.json', current)
            source = files.source_inventory(view['source'], 'delta_retained_ssd')
            if source != frozen:
                raise RuntimeError('Delta SSD differs from stopped-writer evidence; retain both copies.')
            totals = reclaim_plan.summarize_tree(source)
            if totals['regular_files'] > media.MAX_FILES or totals['logical_bytes'] > media.MAX_BYTES:
                raise RuntimeError('Delta review exceeds reviewed manifest bounds.')
            target = files.counterparts(view['target'], source)
            guard()
            comparison = files.verify_pairs(view['source'], view['target'], source, target, folder)
            source_sha = files.write_tree(folder, 'files.jsonl', source)
            target_sha = files.write_tree(folder, 'nas-files.jsonl', target)
            reclaim.check_nas_files(view['target'], source,
                sorted(p for p in source if stat.S_ISREG(source[p]['mode'])), nas_tree=target)
            if files.source_inventory(view['source'], 'delta_retained_ssd_recheck') != source:
                raise RuntimeError('Delta SSD changed during verification.')
            rows = guard()
            code = ('import json,os; p="/app/media/data_hub_raw_media"; '
                    'assert os.stat(p).st_ino == ' + str(view['target_identity']['inode']) + '; '
                    'assert any(x.split()[4]==p and " - nfs " in x for x in open("/proc/self/mountinfo")); '
                    'print(json.dumps({"nfs_identity_passed":True}))')
            probe = json.loads(manager.run(['docker', 'exec', rows['web']['Id'], 'python', '-c', code], timeout=None))
            if probe != {'nfs_identity_passed': True}:
                raise RuntimeError('Current delta web NAS identity probe failed.')
            cutover.Cutover.http_probe(op, rows)
            guard()
            # Re-read immutable stopped evidence too; never adopt a new baseline.
            if files.stopped_tree(op) != (frozen, frozen_sha):
                raise RuntimeError('Delta stopped-writer evidence changed.')
            result = dict(totals, schema=1, state='verification_complete', project=media.PROJECT,
                volume=media.VOLUME, report_directory=report, check_directory=path,
                source=media.SOURCE, target=media.TARGET, source_identity=view['source_identity'],
                target_identity=view['target_identity'], manifest_sha256=source_sha,
                target_manifest_sha256=target_sha, stopped_manifest_sha256=frozen_sha,
                cutover_execution_sha256=state_sha, baseline_sha256=baseline_sha,
                runtime_snapshot_sha256=evidence.digest(current), nas_verification=POLICY,
                comparison=comparison, files_verified=True, business_acceptance_recorded=business_accepted,
                recovery=restored, verification_ready=business_accepted and restored['verified'],
                preserve_source_root=True, preserve_other_media=True, reclaim_ready=False,
                deletion_supported=False, deletion_authorized=False, source_deleted=False, time_unix=time.time(),
                note='Read-only snapshot, not a deletion plan. No cleanup selection, migration record or NAS marker changed.')
            prep.private_write(folder, 'check.json', result)
            os.fsync(folder); os.fsync(output)
            emit('nas_delta_reclaim_check_complete', **result)
            return result
    except Exception as exc:
        emit('nas_delta_reclaim_check_failed', check_directory=path, error=str(exc),
             source_deleted=False, reclaim_ready=False)
        raise
    finally:
        if folder is not None: os.close(folder)
        if output is not None: os.close(output)
