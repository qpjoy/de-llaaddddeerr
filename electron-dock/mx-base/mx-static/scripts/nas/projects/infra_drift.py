"""Read-only deployment evidence after SSD fallback; never adopt a new baseline."""
import json
import os
import re
import stat

import cutover
import cutover_prepare as prep
import precopy
from permissions import emit
from projects import infra_repair, infra_storage
from sample_copy import DIR_FLAGS


def receipt_snapshot(profile):
    """Read local migration receipts, including partial deletion intent evidence."""
    root = cutover.open_report(profile['report'])
    try:
        execution = cutover.read_json(root, 'execution.json')
        original = cutover.read_json(root, 'containers.private.json')
        plans = sorted(n for n in os.listdir(root) if re.fullmatch('reclaim-plan-[0-9a-f]{32}', n))
        if len(plans) > 1000:
            raise RuntimeError('Too many local reclaim plans for bounded inspection.')
        evidence = []
        for name in plans:
            fd = os.open(name, DIR_FLAGS, dir_fd=root)
            try:
                info = os.fstat(fd)
                if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                    raise RuntimeError('Unsafe reclaim plan directory.')
                try:
                    result = cutover.read_json(fd, 'reclaim-result.json')
                except FileNotFoundError:
                    result = None
                try:
                    info = os.stat('unlink-intents.jsonl', dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise RuntimeError('Unsafe reclaim intent journal.')
                    intent_bytes = info.st_size
                except FileNotFoundError:
                    intent_bytes = 0
                if result is not None or intent_bytes:
                    evidence.append({'plan': name, 'intent_bytes': intent_bytes,
                        'completion_recorded': bool(result and result.get('phase') == 'ssd_files_reclaimed'),
                        'removed_this_run': result.get('removed_this_run') if result else None})
            finally:
                os.close(fd)
        return execution, original, evidence
    finally:
        os.close(root)


def project_snapshot(containers):
    result = {}
    for c in containers:
        labels = c.get('Config', {}).get('Labels') or {}
        if labels.get('com.docker.compose.project') != 'mx_data':
            continue
        result[c['Id']] = {key: c.get(key) for key in ('Image', 'Config', 'HostConfig')}
        result[c['Id']]['Mounts'] = sorted(c.get('Mounts', []), key=lambda m: json.dumps(m, sort_keys=True))
        result[c['Id']]['State'] = {key: c.get('State', {}).get(key)
                                  for key in ('Running', 'Pid', 'Paused', 'Restarting')}
    return result


def inspect(manager, profile):
    infra_storage.reviewed(profile)
    # No Cutover operation, candidate generation, media traversal or report writes.
    history, original, reclaim = receipt_snapshot(profile)
    before = precopy.inspect_containers()
    consumers = cutover.select_services(before)
    precopy.check_consumers(prep.VOLUME, before)
    files = prep.file_hashes()
    config = json.loads(manager.run(prep.compose_command() + ['config', '--format', 'json']))
    issues = prep.validate_config(config, consumers)  # Only key names, never environment values.
    hashes = dict(line.split() for line in manager.run(
        prep.compose_command() + ['config', '--hash', '*']).splitlines() if line.strip())
    probe = ('import hashlib,json; print(json.dumps({p:hashlib.sha256(open("/app/"+p,"rb").read()).hexdigest() '
             'for p in ' + repr(sorted(prep.SCRIPT_HASHES)) + '}))')
    services = []
    for name, c in sorted(consumers.items()):
        label = c['Config'].get('Labels') or {}
        launch = {key: c['Config'].get(key) == original[name]['Config'].get(key)
                  for key in ('Entrypoint', 'Cmd', 'User', 'WorkingDir')}
        row = {'service': name, 'id': c['Id'][:12], 'image': c['Image'],
               'running': c.get('State', {}).get('Running') is True,
               'compose_matches_live': hashes.get(name) is not None and hashes[name] == label.get('com.docker.compose.config-hash'),
               'launch_matches_previous': launch,
               'image_reviewed_for_existing_repair': c['Image'] == (
                   infra_repair.GATEWAY_IMAGE if name == 'gateway' else infra_repair.APP_IMAGE)}
        if not row['compose_matches_live'] or not all(launch.values()):
            issues.append({'service': name, 'reason': 'deployment_or_launch_differs'})
        if name != 'gateway':
            actual = json.loads(manager.run(['docker', 'exec', c['Id'], 'python', '-B', '-c', probe]))
            row['startup_scripts_match_reviewed'] = actual == prep.SCRIPT_HASHES
            row['startup_script_sha256'] = actual
            changes = [line for line in manager.run(['docker', 'diff', c['Id']]).splitlines()
                       if line[2:].startswith('/app/') and line.endswith(('.py', '.sh', '.toml', '.yaml', '.yml', '.json'))
                       and not line[2:].startswith(('/app/media/', '/app/staticfiles/'))]
            row['changed_app_code_count'] = len(changes)
            row['changed_app_code_first_50'] = changes[:50]
            if not row['startup_scripts_match_reviewed'] or changes:
                issues.append({'service': name, 'reason': 'startup_scripts_or_writable_app_code_changed'})
        services.append(row)
        emit('nas_repair_inspect_service', **row)
    databases = []
    for name in ('postgres', 'redis'):
        selected = [c for c in before if (c.get('Config', {}).get('Labels') or {}).get('com.docker.compose.project') == 'mx_data'
                    and (c.get('Config', {}).get('Labels') or {}).get('com.docker.compose.service') == name]
        row = {'service': name, 'count': len(selected), 'same_container_as_cutover': False}
        if len(selected) == 1:
            c = selected[0]; state = c.get('State', {})
            row.update(id=c['Id'][:12], same_container_as_cutover=c['Id'] == history.get('databases', {}).get(name),
                       status=state.get('Status'), health=state.get('Health', {}).get('Status'))
        databases.append(row)
        if not row['same_container_as_cutover'] or row.get('status') != 'running' or row.get('health') != 'healthy':
            issues.append({'service': name, 'reason': 'database_identity_or_health_needs_review'})
    after = precopy.inspect_containers()
    after_history, after_original, after_reclaim = receipt_snapshot(profile)
    stable = (files == prep.file_hashes() and project_snapshot(before) == project_snapshot(after)
              and (history, original, reclaim) == (after_history, after_original, after_reclaim))
    if not stable:
        issues.append({'reason': 'deployment_or_receipts_changed_during_inspection'})
    result = {'project': profile['project'], 'snapshot_stable': stable, 'review_items': issues,
        'databases': databases, 'services': services,
        'historical_report': profile['report'], 'selected_reclaim_plan': profile.get('plan'),
        'execution_records_ssd_reclaim': bool(history.get('ssd_reclaim')), 'reclaim_evidence': reclaim,
        'existing_repair_images_match': all(r['image_reviewed_for_existing_repair'] for r in services),
        'production_changed': False, 'execution_allowed': False, 'reclaim_ready': False,
        'note': 'Read-only deployment/receipt snapshot. No NAS walk, repair adoption or deletion. Missing receipts do not rule out manual deletion.'}
    emit('nas_repair_inspect_complete', **result)
    return not issues
