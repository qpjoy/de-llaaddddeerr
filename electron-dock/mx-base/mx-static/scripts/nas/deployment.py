#!/usr/bin/env python3
import json
import socket
import subprocess

VOLUMES = {'delta_59202_media_data', 'po_infra_media_data'}
ROOT = '/home/lcy/test/Delta/mx_data'

def run(args, required=False):
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=45)
    except (OSError, subprocess.TimeoutExpired) as exc:
        if required:
            raise SystemExit('Required command failed: ' + args[0])
        return {'available': False, 'error_type': type(exc).__name__}
    if p.returncode:
        if required:
            raise SystemExit('Required command failed: ' + args[0] + ', exit=' + str(p.returncode))
        return {'available': False, 'exit': p.returncode}
    return p.stdout.strip()

def emit(title, value):
    print('\n### ' + title)
    print(json.dumps(value, ensure_ascii=False, indent=2))

emit('Versions and SELinux (no changes)', {
    'host': socket.gethostname(),
    'docker_context': run(['docker', 'context', 'show']),
    'docker_root': run(['docker', 'info', '--format', '{{.DockerRootDir}}']),
    'docker': run(['docker', 'version', '--format', '{{.Server.Version}}']),
    'compose_v2': run(['docker', 'compose', 'version']),
    'compose_v1': run(['docker-compose', 'version', '--short']),
    'systemd': run(['systemctl', '--version']),
    'rsync': run(['rsync', '--version']),
    'selinux': run(['getenforce']),
    'container_use_nfs': run(['getsebool', 'container_use_nfs']),
    'virt_use_nfs': run(['getsebool', 'virt_use_nfs']),
})
emit('Server checkout; checkout is not proof of running image revision', {
    'root': run(['git', '-C', ROOT, 'rev-parse', '--show-toplevel']),
    'head': run(['git', '-C', ROOT, 'rev-parse', 'HEAD']),
    'branch': run(['git', '-C', ROOT, 'branch', '--show-current']),
    'status': run(['git', '--no-optional-locks', '-C', ROOT, 'status', '--short']),
    'media_source_files': run(['git', '-C', ROOT, 'grep', '-l', '-E',
                              'data_hub_raw_media|MEDIA_ROOT|RAW_MEDIA_ROOT', '--', '*.py']),
})
ids = run(['docker', 'ps', '-aq'], required=True).split()
containers = json.loads(run(['docker', 'inspect'] + ids, required=True)) if ids else []
selected = [c for c in containers if any(m.get('Name') in VOLUMES for m in c.get('Mounts', []))]
if not selected:
    raise SystemExit('No containers reference the expected volumes; verify Docker context.')
related_binds = []
sources = ['/data/docker/volumes/' + v + '/_data' for v in sorted(VOLUMES)]
for c in containers:
    for mount in c.get('Mounts', []):
        source = mount.get('Source', '').rstrip('/') or '/'
        if mount.get('Type') == 'bind' and any(
                source == p or p.startswith(source.rstrip('/') + '/')
                or source.startswith(p + '/') for p in sources):
            related_binds.append({'name': c['Name'], 'mount': mount,
                                  'note': 'Potential additional consumer; verify actual usage.'})
emit('Bind mounts at, inside or above the source volume paths', related_binds)
labels_to_keep = [
    'com.docker.compose.project', 'com.docker.compose.service',
    'com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files',
    'com.docker.compose.project.environment_file', 'com.docker.compose.version',
]
safe_path_keys = {'MEDIA_ROOT', 'MX_MEDIA_ROOT', 'RAW_MEDIA_ROOT',
                  'MX_RAW_MEDIA_ROOT', 'TMPDIR', 'TEMP', 'TMP', 'FILE_UPLOAD_TEMP_DIR',
                  'GIT_COMMIT', 'GIT_BRANCH', 'BUILD_DATE', 'IMAGE_TAG',
                  'DATA_HUB_DOWNLOAD_MEDIA', 'DATA_HUB_MEDIA_MAX_BYTES',
                  'DATA_HUB_MEDIA_DOWNLOAD_TIMEOUT', 'MX_RECOVER_STALE_AGENT_RUNS'}
for c in selected:
    config = c.get('Config') or {}
    labels = config.get('Labels') or {}
    path_env = {}
    for item in config.get('Env') or []:
        key, _, value = item.partition('=')
        if key in safe_path_keys:
            path_env[key] = value
    emit('Media consumer', {
        'name': c['Name'].lstrip('/'), 'state': c.get('State', {}).get('Status'),
        'image_reference': config.get('Image'), 'image_id': c.get('Image'),
        'configured_user': config.get('User'),
        'restart': c.get('HostConfig', {}).get('RestartPolicy'),
        'compose': {key: labels.get(key) for key in labels_to_keep},
        'allowlisted_nonsecret_environment': path_env, 'mounts': c.get('Mounts'),
    })
for image_id in sorted({c['Image'] for c in selected}):
    image = json.loads(run(['docker', 'image', 'inspect', image_id], required=True))[0]
    labels = (image.get('Config') or {}).get('Labels') or {}
    emit('Running image identity', {
        'id': image['Id'], 'repo_digests': image.get('RepoDigests'),
        'revision': labels.get('org.opencontainers.image.revision'),
        'version': labels.get('org.opencontainers.image.version'),
    })
for c in selected:
    name = c['Name'].lstrip('/')
    if name.endswith('-web-1') or name.endswith('-worker-agent-data-hub-1'):
        emit('Actual process UID/GID: ' + name,
             run(['docker', 'top', name, '-eo', 'pid,uid,gid,comm']))
        code = '''import hashlib,json,pathlib
paths=['data_hub/media_storage.py','data_hub/tasks.py','data_hub/services.py','mx_data/settings.py','scripts/run_web.sh','scripts/run_worker.sh']
root=pathlib.Path('/app')
print(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() if (root/p).is_file() else 'missing' for p in paths},sort_keys=True))
'''
        emit('Running code SHA256 (reads files without importing app): ' + name,
             run(['docker', 'exec', name, 'python', '-c', code]))
emit('Kubernetes context (read only; unavailable is not proof of no consumers)',
     run(['kubectl', 'config', 'current-context']))
emit('Kubernetes hostPath paths; no Secret or environment values', run([
    'kubectl', '--request-timeout=15s', 'get', 'pods', '-A', '-o',
    'jsonpath={range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\\t"}'
    '{range .spec.volumes[*]}{.hostPath.path}{" "}{end}{"\\n"}{end}',
]))
emit('Kubernetes volume storage locations', run([
    'kubectl', '--request-timeout=15s', 'get', 'pv', '-o',
    'custom-columns=NAME:.metadata.name,PHASE:.status.phase,HOSTPATH:.spec.hostPath.path,'
    'LOCAL:.spec.local.path,NFS_SERVER:.spec.nfs.server,NFS_PATH:.spec.nfs.path',
]))
