#!/usr/bin/env python3
"""Prepare a reviewed Part 1 cutover; never stop/recreate production containers."""
import fcntl
import copy
import hashlib
import json
import os
import stat
import subprocess
import sys
import time
import uuid

from permissions import emit, open_parent
from precopy import check_host, check_consumers, child_directory, open_job, inspect_containers, SERVICES
from media import checked_root
from sample_copy import DIR_FLAGS

VOLUME = 'po_infra_media_data'
NFS_VOLUME = 'mx_data_raw_media_nfs_v1'
DEPLOY = '/home/lcy/test/Delta/mx_data'
FILES = [DEPLOY + '/docker-compose.ghcr.yml', DEPLOY + '/docker-compose.local-build.yml']
ENV_FILE = DEPLOY + '/deploy/.env.ghcr'
OPTIONS = {'type': 'nfs',
           'o': 'addr=192.168.1.3,vers=3,proto=tcp,rw,hard,rsize=524288,wsize=524288,timeo=600,retrans=2,sec=sys',
           'device': ':/volume1/data1/mx-internal-server/data/docker/media-volumes/po_infra_media_data/data_hub_raw_media'}
SCRIPT_HASHES = {'scripts/run_web.sh': 'f68d58be0ead560c3b06eac4b7c79dfc845fb218fc48f1c704492783f07fa91b',
                 'scripts/run_worker.sh': 'fd211830a63045583a8c4917ba86d457a116f2d513872ae0552736a2041f4573'}


def run(args, timeout=45):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, timeout=timeout)
    if result.returncode:
        # Compose/Docker errors can quote secret values. Do not print full output.
        message = '{} failed (exit {}); no production changes performed.'.format(' '.join(args[:2]), result.returncode)
        if args[:2] == ['docker', 'run']:
            message += ' Isolated probe error: ' + result.stderr[-2000:]
        raise RuntimeError(message)
    return result.stdout


def compose_command():
    return ['docker', 'compose', '--project-directory', DEPLOY, '-p', 'mx_data',
            '--env-file', ENV_FILE, '-f', FILES[0], '-f', FILES[1]]


def file_hashes():
    result = {}
    for path in FILES + [ENV_FILE]:
        with open(path, 'rb') as stream:
            result[path] = hashlib.sha256(stream.read()).hexdigest()
    return result


def validate_volume(meta):
    if meta.get('Name') != NFS_VOLUME or meta.get('Driver') != 'local' or meta.get('Options') != OPTIONS:
        raise RuntimeError('Existing NFS volume differs from the registered definition; never recreate it blindly.')


def validate_config(config, consumers):
    differences = []
    if config.get('name') != 'mx_data':
        raise RuntimeError('Unexpected rendered Compose project.')
    for service in sorted(SERVICES):
        desired = config['services'][service]
        container = consumers[service]
        labels = container['Config'].get('Labels') or {}
        if (labels.get('com.docker.compose.project.working_dir') != DEPLOY
                or labels.get('com.docker.compose.project.config_files', '').split(',') != FILES
                or labels.get('com.docker.compose.project.environment_file') != ENV_FILE):
            raise RuntimeError('Original deployment file labels changed: ' + service)
        mounts = desired.get('volumes', [])
        parent = [m for m in mounts if m.get('target') == '/app/media']
        if (len(parent) != 1 or parent[0].get('type') != 'volume'
                or config.get('volumes', {}).get(parent[0].get('source'), {}).get('name') != VOLUME
                or any(m.get('target', '').startswith('/app/media/data_hub_raw_media') for m in mounts)):
            raise RuntimeError('Rendered Compose media mount changed: ' + service)
        live_env = dict(item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item)
        for key, value in (desired.get('environment') or {}).items():
            if value is None or str(value) != live_env.get(key):
                differences.append({'service': service, 'environment_key': key})
        # Full service hashes cover command, ports, mounts and other config drift.
        if not container.get('State', {}).get('Running'):
            differences.append({'service': service, 'reason': 'not_running'})
    return differences


def candidate(consumers):
    services = {}
    for name, container in consumers.items():
        services[name] = {'image': container['Image'], 'volumes': [{
            'type': 'volume', 'source': 'mx_static_raw_media_nfs',
            'target': '/app/media/data_hub_raw_media', 'read_only': name == 'gateway',
            'volume': {'nocopy': True}}]}
        if name.startswith('worker'):
            services[name]['environment'] = {'MX_RECOVER_STALE_AGENT_RUNS': '0'}
    env = dict(item.split('=', 1) for item in consumers['web']['Config'].get('Env', []) if '=' in item)
    services['web']['command'] = ['gunicorn', 'mx_data.wsgi:application', '--bind',
        (env.get('MX_HOST') or '0.0.0.0') + ':' + (env.get('MX_PORT') or '8000'),
        '--workers', env.get('MX_WEB_WORKERS') or '2', '--timeout', env.get('MX_WEB_TIMEOUT') or '600']
    return {'services': services, 'volumes': {'mx_static_raw_media_nfs': {'external': True, 'name': NFS_VOLUME}}}


def validate_merged(original, merged, overlay):
    # Normalize only the intended changes back to the original model. Any other
    # change (including DB/Redis/env/ports/parent volumes) is a refusal.
    restored = copy.deepcopy(merged)
    new_volume = restored['volumes'].pop('mx_static_raw_media_nfs')
    if new_volume.get('name') != NFS_VOLUME or new_volume.get('external') is not True:
        raise RuntimeError('Merged external NFS volume differs.')
    for name in SERVICES:
        service = restored['services'][name]
        planned = overlay['services'][name]
        child = [m for m in service['volumes'] if m.get('target') == '/app/media/data_hub_raw_media']
        if (len(child) != 1 or child[0].get('type') != 'volume'
                or child[0].get('source') != 'mx_static_raw_media_nfs'
                or bool(child[0].get('read_only')) != (name == 'gateway')
                or child[0].get('volume', {}).get('nocopy') is not True
                or service.get('image') != planned['image']):
            raise RuntimeError('Merged child mount/image differs: ' + name)
        service['volumes'].remove(child[0])
        service['image'] = original['services'][name]['image']
        if name == 'web':
            if service.get('command') != planned['command']:
                raise RuntimeError('Unexpected web launch command.')
            if 'command' in original['services'][name]:
                service['command'] = original['services'][name]['command']
            else:
                service.pop('command')
        if name.startswith('worker'):
            if service['environment'].get('MX_RECOVER_STALE_AGENT_RUNS') != '0':
                raise RuntimeError('Worker startup recovery override was not applied.')
            old = original['services'][name].get('environment', {})
            if 'MX_RECOVER_STALE_AGENT_RUNS' in old:
                service['environment']['MX_RECOVER_STALE_AGENT_RUNS'] = old['MX_RECOVER_STALE_AGENT_RUNS']
            else:
                service['environment'].pop('MX_RECOVER_STALE_AGENT_RUNS')
    if restored != original:
        raise RuntimeError('Compose merge changed unrelated fields; inspect private rendered files.')


PROBE = r'''
import hashlib,json,os,stat,sys,uuid
root='/nas'
info=os.stat(root)
assert info.st_ino == int(sys.argv[1]), 'Unexpected NFS directory identity'
assert any(line.split()[4] == root and ' - nfs' in line for line in open('/proc/self/mountinfo')), 'Not an NFS mount'
name=root+'/.mx-static-cutover-probe-'+uuid.uuid4().hex
payload=os.urandom(4096)
fd=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
file_identity=None
try:
    before=os.fstat(fd); file_identity=(before.st_dev,before.st_ino)
    with os.fdopen(fd,'wb') as stream:
        stream.write(payload); stream.flush(); os.fsync(stream.fileno())
    with open(name,'rb') as stream: assert stream.read() == payload, 'Probe readback mismatch'
    print(json.dumps({'docker_nfs_mount':True,'same_target_inode':True,'root_4k_write_read':True,'uid':os.getuid(),'gid':os.getgid()}))
finally:
    current=os.lstat(name)
    if (current.st_dev,current.st_ino) != file_identity: raise RuntimeError('Probe replaced; left in place')
    os.unlink(name)
'''


def private_write(fd, name, value):
    leaf = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    with os.fdopen(leaf, 'w') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=True)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def deployment_changes(starting_files, current_files, before, after):
    old = {record['service']: record for record in before}
    new = {record['service']: record for record in after}
    changes = []
    for name in sorted(set(old) | set(new)):
        fields = [key for key in ('id', 'image', 'mounts')
                  if old.get(name, {}).get(key) != new.get(name, {}).get(key)]
        if fields:
            changes.append({'service': name, 'fields': fields})
    return {'config_files_changed': sorted(path for path in set(starting_files) | set(current_files)
                                          if starting_files.get(path) != current_files.get(path)),
            'consumers_changed': changes}


def main():
    if sys.argv[1:] != [VOLUME, '--prepare'] or not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise SystemExit('Use sudo bash scripts/nas-cutover-prepare.sh po_infra_media_data --prepare on Linux.')
    held = []
    report_path = None
    try:
        check_host()
        lock = os.open('/run/lock/mx-static-nas-sample.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        held.append(lock)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe copy/verification lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source = os.open(checked_root(VOLUME), DIR_FLAGS); held.append(source)
        if os.fstat(source).st_dev != os.stat('/dev/nvme0n1p1').st_rdev:
            raise RuntimeError('Source is not the expected SSD.')
        containers = inspect_containers()
        fingerprint, records = check_consumers(VOLUME, containers=containers, with_records=True)
        parent = open_parent(); held.append(parent)
        job, target, state = open_job(parent, VOLUME, source, fingerprint, create=False, records=records); held.extend((job, target))
        if state.get('phase') != 'precopy_pass_complete' or state.get('last_exit_code') != 0:
            raise RuntimeError('Successful pre-copy required; full SHA256 is NOT required.')
        consumers = {c['Config']['Labels']['com.docker.compose.service']: c for c in containers
                     if any(m.get('Name') == VOLUME for m in c.get('Mounts', []))}
        starting_files = file_hashes()
        config = json.loads(run(compose_command() + ['config', '--format', 'json']))
        differences = validate_config(config, consumers)
        hashes = dict(line.split() for line in run(compose_command() + ['config', '--hash', '*']).splitlines() if line.strip())
        for name, c in consumers.items():
            if hashes.get(name) != c['Config']['Labels'].get('com.docker.compose.config-hash'):
                differences.append({'service': name, 'reason': 'compose_config_hash_differs'})
        base = os.open('/', DIR_FLAGS); held.append(base)
        for part in ('var', 'lib', 'mx-static', 'nas-cutover'):
            base, _ = child_directory(base, part, create=part in ('mx-static', 'nas-cutover')); held.append(base)
        name = VOLUME + '-' + uuid.uuid4().hex
        output, _ = child_directory(base, name, create=True); held.append(output)
        os.fchmod(output, 0o700)
        report_path = '/var/lib/mx-static/nas-cutover/' + name
        private_write(output, 'containers.private.json', consumers)
        private_write(output, 'compose.rendered.private.json', config)
        private_write(output, 'deployment-before.private.json',
                      {'config_files_sha256': starting_files, 'consumers': records})
        code_changes = {}
        for name, c in consumers.items():
            if name != 'gateway':
                diff = run(['docker', 'diff', c['Id']]).splitlines()
                code_changes[name] = [line for line in diff if len(line) > 2 and
                                      line[2:].startswith('/app/') and
                                      line[2:].endswith(('.py', '.sh', '.toml', '.yaml', '.yml', '.json')) and
                                      not line[2:].startswith(('/app/media/', '/app/staticfiles/'))]
                paths = list(SCRIPT_HASHES)
                code = 'import hashlib,json; print(json.dumps({p:hashlib.sha256(open("/app/"+p,"rb").read()).hexdigest() for p in ' + repr(paths) + '}))'
                actual = json.loads(run(['docker', 'exec', c['Id'], 'python', '-c', code]))
                if actual != SCRIPT_HASHES:
                    differences.append({'service': name, 'reason': 'startup_script_changed'})
        if any(code_changes.values()):
            differences.append({'reason': 'writable_app_code_requires_review'})
        private_write(output, 'review-items.json',
                      {'review_items': differences, 'writable_app_code': code_changes})
        existing = run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines()
        if NFS_VOLUME not in existing:
            args = ['docker', 'volume', 'create', '--driver', 'local']
            for key, value in OPTIONS.items(): args.extend(['--opt', key + '=' + value])
            run(args + [NFS_VOLUME])
        validate_volume(json.loads(run(['docker', 'volume', 'inspect', NFS_VOLUME]))[0])
        emit('cutover_probe_start', volume=NFS_VOLUME, report_directory=report_path,
             note='Isolated existing-image probe; hard NFS may wait. No production service is stopped.')
        probe = json.loads(run(['docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
            '--no-healthcheck', '--user', '0:0', '--entrypoint', 'python',
            '--mount', 'type=volume,src=' + NFS_VOLUME + ',dst=/nas,volume-nocopy',
            consumers['web']['Image'], '-c', PROBE, str(state['target_inode'])], timeout=None))
        private_write(output, 'docker-nfs-probe.json', probe)
        emit('cutover_probe_result', **probe)
        overlay = candidate(consumers)
        private_write(output, 'compose.nas.override.json', overlay)
        merged = json.loads(run(compose_command() + ['-f', report_path + '/compose.nas.override.json', 'config', '--format', 'json']))
        private_write(output, 'compose.nas.rendered.private.json', merged)
        validate_merged(config, merged, overlay)
        files = file_hashes()
        _, current_records = check_consumers(VOLUME, with_records=True)
        drift = deployment_changes(starting_files, files, records, current_records)
        private_write(output, 'deployment-check.json', drift)
        if drift['config_files_changed'] or drift['consumers_changed']:
            emit('cutover_deployment_changed', **drift)
            raise RuntimeError('Deployment changed during preparation; see cutover_deployment_changed fields.')
        result = {'schema': 1, 'time_unix': time.time(), 'volume': VOLUME, 'precopy_state': state,
                  'verification_policy': 'rsync-transfer-checksum-and-final-offline-quick-check',
                  'full_sha256_required': False, 'report_directory': report_path,
                  'docker_nfs_probe': probe, 'review_items': differences, 'writable_app_code': code_changes,
                  'config_files_sha256': files, 'consumer_fingerprint_normalized': fingerprint,
                  'production_stopped': False, 'cutover_ready': False,
                  'reclaim_ready': False, 'media_services': sorted(consumers),
                  'note': 'Preparation only. Final stopped-writer sync, consumer recreation and acceptance still required.'}
        private_write(output, 'prepare-result.json', result); os.fsync(output)
        emit('cutover_prepare_result', **result)
        return 0 if not differences else 2
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        emit('cutover_prepare_failed', error=str(exc), report_directory=report_path,
             note='Keep source, target, lock and marker. No production stop or cutover performed.')
        return 1
    finally:
        for fd in reversed(held): os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
