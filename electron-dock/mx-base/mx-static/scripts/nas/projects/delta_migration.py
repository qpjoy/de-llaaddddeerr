"""Read-only delta cutover preparation, based on an explicit successful copy.

Capture today's application model/launches privately and render a NAS candidate.
No cutover executor is exposed until delta release/recovery are implemented and
the server deployment evidence is reviewed. Never reuse infra execution state.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

import catalog
import cutover_prepare as prep
import precopy
import reclaim_plan
from permissions import emit
from projects import delta_copy as copying
from sample_copy import DIR_FLAGS
from verify import stamp

ROOT = '/var/lib/mx-static/nas-migration-prepare'
APP_ROOT = '/home/lcy/test/Delta/mx_data'
COMPOSE_FILES = ['docker-compose.ghcr.yml', 'docker-compose.local-build.yml', 'docker-compose.db-port.yml']
ENV_FILE = 'deploy/.env.delta-59202.ghcr'
RELEASE_SCRIPT = 'scripts/deploy_public_ghcr.sh'
SCRIPT_NAMES = {'scripts/run_web.sh', 'scripts/run_worker.sh', 'scripts/run_beat.sh', 'scripts/run_chat_gateway.sh'}
DEPENDENCIES = {'postgres': '/var/lib/postgresql/data', 'redis': '/data'}
# Observed on delta: a separate, mountless application service. It is recorded
# and preserved, never included in the media override or migration lifecycle.
AUXILIARIES = {'websearch'}


def definition(manager, profile):
    copying.reviewed(profile)
    if profile.get('deployment_file') != 'part2.deployment.json':
        raise RuntimeError('Delta deployment locator must be explicitly registered.')
    value = catalog.read_relative(manager.CONFIG.parent, profile['deployment_file'])
    if (value.get('schema') != 1 or value.get('project') != copying.PROJECT
            or value.get('directory') != APP_ROOT or value.get('env_file') != ENV_FILE
            or value.get('compose_files') != COMPOSE_FILES or value.get('release_script') != RELEASE_SCRIPT
            or set(value.get('startup_scripts_sha256', {})) != SCRIPT_NAMES
            or any(not re.fullmatch('[0-9a-f]{64}', str(v)) for v in value['startup_scripts_sha256'].values())):
        raise RuntimeError('Unreviewed delta deployment locator/script reference.')
    return value


def local_file(path):
    """Read fixed application inputs with no symlink traversal or evaluation."""
    parent = copying.open_absolute(str(Path(path).parent))
    try:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size > 8 * 1024 ** 2:
                raise RuntimeError('Unexpected deployment input type/size.')
            data = stream.read(8 * 1024 ** 2 + 1)
            if len(data) > 8 * 1024 ** 2 or stamp(os.fstat(stream.fileno())) != stamp(before):
                raise RuntimeError('Deployment input changed while reading.')
            return data
    finally: os.close(parent)


def inputs(deployment):
    names = deployment['compose_files'] + [deployment['env_file'], deployment['release_script']]
    return {name: hashlib.sha256(local_file(APP_ROOT + '/' + name)).hexdigest() for name in names}


def command():
    result = ['docker', 'compose', '--project-directory', APP_ROOT, '-p', copying.PROJECT,
              '--env-file', APP_ROOT + '/' + ENV_FILE]
    for name in COMPOSE_FILES: result += ['-f', APP_ROOT + '/' + name]
    return result


def completed_copy(path):
    parent, sep, leaf = path.rpartition('/')
    copying.validate_path(parent)
    if not sep or not re.fullmatch('copy-[0-9a-f]{32}', leaf):
        raise RuntimeError('Use the exact successful delta copy attempt directory.')
    report = copying.open_absolute(parent, private=True)
    attempt = None
    try:
        attempt = os.open(leaf, DIR_FLAGS, dir_fd=report)
        info = os.fstat(attempt)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('Copy attempt must be private.')
        plan, sha = copying.read_private(report, 'plan.json')
        result, result_sha = copying.read_private(attempt, 'result.json')
        started, _ = copying.read_private(attempt, 'started.json')
        if (plan.get('schema') != 1 or plan.get('project') != copying.PROJECT
                or plan.get('phase') != 'prepared' or plan.get('volume') != copying.VOLUME
                or plan.get('report_directory') != parent or started.get('plan_sha256') != sha
                or result.get('phase') != 'manifest_copy_complete' or result.get('volume') != copying.VOLUME
                or result.get('report_directory') != parent or result.get('attempt_directory') != path
                or any(result.get(k) is not False for k in ('marker_changed', 'source_deleted', 'production_restart', 'reclaim_ready'))
                or result.get('stopped_writer_recheck_required') is not True):
            raise RuntimeError('Copy success receipt does not match its original immutable plan.')
        tree, _, paths = copying.manifest(report, plan)
        if (any(type(result.get(k)) is not int or result[k] < 0 for k in ('copied', 'already_present', 'logical_bytes'))
                or result['copied'] + result['already_present'] != len(paths)
                or result['logical_bytes'] != sum(tree[p]['size'] for p in paths)):
            raise RuntimeError('Copy completion totals do not cover the prepared manifest.')
        return {'attempt_directory': path, 'plan_sha256': sha, 'result_sha256': result_sha,
                'result': result, 'media_identity': plan['media_identity']}
    finally:
        if attempt is not None: os.close(attempt)
        os.close(report)


def select(rows):
    selected = {}
    required = precopy.SERVICES | set(DEPENDENCIES)
    for c in rows:
        labels = c.get('Config', {}).get('Labels') or {}
        if labels.get('com.docker.compose.project') != copying.PROJECT: continue
        name = labels.get('com.docker.compose.service')
        reasons = []
        if name not in required | AUXILIARIES: reasons.append('unreviewed_service')
        if name in selected: reasons.append('duplicate_service')
        if str(labels.get('com.docker.compose.oneoff', 'false')).lower() != 'false': reasons.append('one_off')
        if reasons:
            raise RuntimeError('Delta service requires review: ' + json.dumps({
                'id': c.get('Id', '')[:12], 'name': c.get('Name'), 'service': name, 'reasons': reasons}))
        selected[name] = c
    if not required <= set(selected):
        raise RuntimeError('Missing required delta services: ' + ', '.join(sorted(required - set(selected))))
    for name in AUXILIARIES & set(selected):
        c = selected[name]; host = c.get('HostConfig') or {}
        if (c.get('Mounts') or host.get('Binds') or host.get('Mounts') or host.get('VolumesFrom')
                or host.get('Privileged') or host.get('Devices') or host.get('DeviceRequests')
                or host.get('PidMode') or host.get('CapAdd')):
            raise RuntimeError('Auxiliary delta service requires mount/access review: ' + name)
    # An unrelated auxiliary's availability is not a media-migration gate.
    reclaim_plan.health_guard({name: selected[name] for name in required})
    for name, target in DEPENDENCIES.items():
        c = selected[name]
        mounts = c.get('Mounts', [])
        volume = copying.PROJECT + '_' + name + '_data'
        if (c['State'].get('Health', {}).get('Status') != 'healthy' or len(mounts) != 1
                or mounts[0].get('Type') != 'volume' or mounts[0].get('Name') != volume
                or mounts[0].get('Source') != '/data/docker/volumes/' + volume + '/_data'
                or mounts[0].get('Destination') != target or mounts[0].get('RW') is not True):
            raise RuntimeError('Delta database/queue identity, health or existing data mount needs review: ' + name)
    return selected


def runtime_snapshot(rows):
    """Private immutable evidence, excluding volatile health-probe counters."""
    return {name: {'id': c['Id'], 'image': c['Image'], 'config': c['Config'],
                  'host_config': c.get('HostConfig'),
                  'mounts': sorted(c.get('Mounts', []), key=lambda m: json.dumps(m, sort_keys=True)),
                  'state': {k: c['State'].get(k) for k in ('Running', 'Pid', 'StartedAt', 'Paused', 'Restarting', 'OOMKilled')}}
            for name, c in rows.items()}


def model_review(model, rows, hashes):
    issues = []
    if model.get('name') != copying.PROJECT or set(model.get('services', {})) != set(rows):
        raise RuntimeError('Rendered delta project/service set differs from current deployment.')
    volumes = model.get('volumes', {})
    if volumes.get('media_data', {}).get('name') != copying.VOLUME:
        raise RuntimeError('Rendered media parent is not the registered delta SSD volume.')
    if 'mx_static_raw_media_nfs' in volumes:
        raise RuntimeError('Current model already declares a NAS child; review actual storage first.')
    for name, c in sorted(rows.items()):
        labels = c['Config'].get('Labels') or {}
        service = model['services'][name]
        expected = {'com.docker.compose.project.working_dir': APP_ROOT,
                    'com.docker.compose.project.config_files': ','.join(APP_ROOT + '/' + p for p in COMPOSE_FILES),
                    'com.docker.compose.project.environment_file': APP_ROOT + '/' + ENV_FILE}
        if any(labels.get(k) != v for k, v in expected.items()):
            issues.append({'service': name, 'reason': 'deployment_locator_differs'})
        if not hashes.get(name) or hashes[name] != labels.get('com.docker.compose.config-hash'):
            issues.append({'service': name, 'reason': 'compose_hash_differs_from_live'})
        # Keep secret values inside private reports. Emit only differing key names.
        live_env = dict(v.split('=', 1) for v in c['Config'].get('Env', []) if '=' in v)
        for key, value in (service.get('environment') or {}).items():
            if value is None or str(value) != live_env.get(key):
                issues.append({'service': name, 'reason': 'environment_differs', 'key': key})
        if service.get('volumes_from') or service.get('post_start') or service.get('pre_start'):
            issues.append({'service': name, 'reason': 'extra_mount_or_lifecycle_hook'})
        mounts = service.get('volumes', [])
        if name in precopy.SERVICES:
            parents = [m for m in mounts if m.get('target') == '/app/media']
            tmpfs = service.get('tmpfs', [])
            if isinstance(tmpfs, str): tmpfs = [tmpfs]
            if (len(parents) != 1 or parents[0].get('type') != 'volume'
                    or parents[0].get('source') != 'media_data'
                    or parents[0].get('read_only', False) != (name == 'gateway')
                    or parents[0].get('volume', {}).get('subpath')
                    or any(copying.overlaps(m.get('target', '/'), copying.RAW) for m in mounts if m not in parents)
                    or any(copying.overlaps(p.split(':')[0], copying.RAW) for p in tmpfs)):
                issues.append({'service': name, 'reason': 'media_mount_differs_or_hidden'})
        elif name in DEPENDENCIES:
            key = name + '_data'
            if (len(mounts) != 1 or mounts[0].get('type') != 'volume' or mounts[0].get('source') != key
                    or mounts[0].get('target') != DEPENDENCIES[name] or mounts[0].get('read_only', False)
                    or mounts[0].get('volume', {}).get('subpath')
                    or volumes.get(key, {}).get('name') != copying.PROJECT + '_' + key):
                issues.append({'service': name, 'reason': 'database_or_queue_volume_differs'})
        elif (mounts or service.get('tmpfs') or service.get('configs') or service.get('secrets')
                or service.get('privileged') or service.get('devices') or service.get('pid')
                or service.get('cap_add')):
            issues.append({'service': name, 'reason': 'auxiliary_mount_or_access_needs_review'})
    return issues


def script_probe(names):
    return ('import os,stat,hashlib,json; result={}\n'
            'for name in ' + repr(sorted(names)) + ':\n'
            ' fd=os.open("/app/"+name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)\n'
            ' with os.fdopen(fd,"rb") as f:\n'
            '  before=os.fstat(f.fileno()); assert stat.S_ISREG(before.st_mode) and before.st_size<=262144\n'
            '  data=f.read(262145); after=os.fstat(f.fileno())\n'
            '  assert len(data)<=262144 and all(getattr(before,k)==getattr(after,k) for k in ("st_dev","st_ino","st_size","st_mtime_ns","st_ctime_ns"))\n'
            '  result[name]=hashlib.sha256(data).hexdigest()\n'
            'print(json.dumps(result))')


def launch_review(manager, model, rows, deployment):
    summaries, issues = [], []
    images = {}
    for name in sorted(precopy.SERVICES):
        c = rows[name]; service = model['services'][name]
        image_name = service.get('image')
        if not image_name: raise RuntimeError('Media image name missing: ' + name)
        if image_name not in images:
            values = json.loads(manager.run(['docker', 'image', 'inspect', image_name]))
            if len(values) != 1: raise RuntimeError('Expected one existing media image.')
            images[image_name] = values[0]
        image = images[image_name]
        summary = {'service': name, 'id': c['Id'][:12], 'image': c['Image'],
                   'image_matches_live': image['Id'] == c['Image'], 'startup_scripts_match_reviewed': None}
        if not summary['image_matches_live']: issues.append({'service': name, 'reason': 'image_tag_moved_since_deploy'})
        if name == 'gateway':
            if (c['Config'].get('Entrypoint') != ['/docker-entrypoint.sh']
                    or c['Config'].get('Cmd') != ['nginx', '-g', 'daemon off;']):
                issues.append({'service': name, 'reason': 'gateway_launch_needs_review'})
        else:
            script = '/app/scripts/' + ('run_worker.sh' if name.startswith('worker') else 'run_' + name.replace('-', '_') + '.sh')
            if (c['Config'].get('Cmd') != [script] or c['Config'].get('Entrypoint')
                    or image.get('Config', {}).get('Entrypoint') or service.get('entrypoint')
                    or c['Config'].get('WorkingDir') != '/app'):
                issues.append({'service': name, 'reason': 'application_launch_needs_review'})
            actual = json.loads(manager.run(['docker', 'exec', c['Id'], 'python', '-B', '-c', script_probe(SCRIPT_NAMES)]))
            summary['startup_scripts_sha256'] = actual
            summary['startup_scripts_match_reviewed'] = actual == deployment['startup_scripts_sha256']
            if not summary['startup_scripts_match_reviewed']:
                issues.append({'service': name, 'reason': 'startup_scripts_changed'})
            changed = [line for line in manager.run(['docker', 'diff', c['Id']]).splitlines()
                       if line[2:].startswith('/app/') and line.endswith(('.py', '.sh', '.conf', '.json', '.yaml', '.yml'))
                       and not line[2:].startswith(('/app/media/', '/app/staticfiles/'))]
            summary['changed_app_code'] = changed[:50]
            if changed: issues.append({'service': name, 'reason': 'writable_application_code_changed'})
        summaries.append(summary); emit('nas_delta_migration_service', **summary)
    return summaries, issues


def prepare(manager, profile, attempt_path):
    deployment = definition(manager, profile)
    copy_receipt = completed_copy(attempt_path)
    current = copying.current(manager)
    with copying.media() as view:
        if copying.identity(view) != copy_receipt['media_identity']:
            raise RuntimeError('Media identities/legacy marker changed since successful continuation.')
    rows = select(precopy.inspect_containers())
    if precopy.check_consumers(copying.VOLUME, list(rows.values())) != current['consumer_fingerprint']:
        raise RuntimeError('Delta containers changed during inspection.')
    before = inputs(deployment)
    parent = manager.secure_directory(ROOT)
    output = None
    path = ROOT + '/delta-' + uuid.uuid4().hex
    try:
        if manager.run(['findmnt', '-rn', '-T', ROOT, '-o', 'FSTYPE']).strip() not in ('xfs', 'ext4', 'btrfs'):
            raise RuntimeError('Migration preparation requires local private reports.')
        os.mkdir(path.rsplit('/', 1)[-1], 0o700, dir_fd=parent)
        output = os.open(path.rsplit('/', 1)[-1], DIR_FLAGS, dir_fd=parent); os.fsync(parent)
        emit('nas_delta_migration_prepare_started', report_directory=path, production_changed=False, nas_walk=False)
        prep.private_write(output, 'copy-receipt.json', copy_receipt)
        prep.private_write(output, 'containers.private.json', rows)
        model = json.loads(manager.run(command() + ['config', '--format', 'json']))
        prep.private_write(output, 'compose.current.private.json', model)
        hashes = dict(line.split() for line in manager.run(command() + ['config', '--hash', '*']).splitlines() if line.strip())
        issues = model_review(model, rows, hashes)
        services, launch_issues = launch_review(manager, model, rows, deployment)
        issues.extend(launch_issues)
        overlay = prep.candidate({n: rows[n] for n in precopy.SERVICES}, copying.NFS_VOLUME)
        prep.private_write(output, 'compose.nas.candidate.json', overlay)
        merged = json.loads(manager.run(command() + ['-f', path + '/compose.nas.candidate.json', 'config', '--format', 'json']))
        prep.private_write(output, 'compose.nas.candidate.private.json', merged)
        prep.validate_merged(model, merged, overlay, copying.NFS_VOLUME)
        # Static observations are evidence for review, not proof of admission.
        release = local_file(APP_ROOT + '/' + RELEASE_SCRIPT).decode('utf-8')
        hook = {'installed_entry_referenced': '/usr/local/lib/mx-static-nas/current/scripts/nas/release.py' in release,
                'storage_mode_check_present': 'compose mx-nas-mode' in release,
                'post_release_check_present': 'compose mx-nas-check' in release,
                'nas_permission_prune_present': 'find /app/media -path /app/media/data_hub_raw_media -prune' in release,
                'static_observations_only': True, 'delta_nas_release_adapter_available': False}
        after = select(precopy.inspect_containers())
        if (inputs(deployment) != before or definition(manager, profile) != deployment
                or runtime_snapshot(after) != runtime_snapshot(rows) or copying.current(manager) != current
                or completed_copy(attempt_path) != copy_receipt):
            raise RuntimeError('Deployment/receipt changed while preparing; no switch allowed.')
        with copying.media() as view:
            if copying.identity(view) != copy_receipt['media_identity']:
                raise RuntimeError('Source/NAS changed while preparing; no switch allowed.')
        result = {'schema': 1, 'phase': 'deployment_review_complete', 'project': copying.PROJECT,
                  'volume': copying.VOLUME, 'report_directory': path, 'copy_attempt': attempt_path,
                  'deployment_files_sha256': before, 'services': services,
                  'databases': {n: {'id': rows[n]['Id'], 'health': rows[n]['State']['Health']['Status'],
                                    'volume': copying.PROJECT + '_' + n + '_data'} for n in DEPENDENCIES},
                  'auxiliary_services': [{'service': n, 'id': rows[n]['Id'][:12],
                                          'mounts': [], 'preserved': True}
                                         for n in sorted(AUXILIARIES & set(rows))],
                  'review_items': issues, 'deployment_review_passed': not issues,
                  'candidate_merge_verified': True, 'release_hook': hook,
                  'production_changed': False, 'source_deleted': False, 'nas_walk': False,
                  'execution_allowed': False, 'reclaim_ready': False, 'time_unix': time.time(),
                  'pending': ['delta_release_and_recovery_adapter', 'stopped_writer_final_sync',
                              'application_identity_io_probe', 'business_acceptance']}
        prep.private_write(output, 'review.json', result); os.fsync(output)
        emit('nas_delta_migration_prepared', **{k: v for k, v in result.items() if k not in ('deployment_files_sha256', 'services')})
        return result
    except BaseException as exc:
        if output is not None:
            prep.private_write(output, 'failed.json', {'error': str(exc), 'production_changed': False, 'execution_allowed': False})
            os.fsync(output)
        emit('nas_delta_migration_prepare_failed', report_directory=path if output is not None else None, error=str(exc))
        raise
    finally:
        if output is not None: os.close(output)
        os.close(parent)
