"""Explicit media maintenance using TODAY's application Compose/build inputs.

Never used by boot recovery. Never call the app release script, compose down,
database upgrades, bootstrap_admin, recursive chmod, or create data volumes.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import uuid

import catalog
from permissions import emit
from projects import infra_runtime as runtime
from projects import infra_storage as storage
from projects import infra_services

ROOT = '/var/lib/mx-static/nas-deployment'


def run_logged(command, output, filename):
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output)
    with os.fdopen(fd, 'wb') as stream:
        result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
        stream.flush(); os.fsync(stream.fileno())
    if result.returncode:
        raise RuntimeError('维护命令失败；完整输出保存在本次私有报告的 ' + filename + '，不要公开其中的配置内容。')


def definition(manager, profile):
    runtime.contract(manager, profile)
    value = catalog.read_relative(manager.CONFIG.parent, profile['deployment_file'])
    root = Path(value['directory'])
    if value.get('schema') != 1 or not root.is_absolute() or root.resolve() != root.absolute():
        raise RuntimeError('Invalid deployment directory.')
    for p in value['compose_files'] + [value['env_file']]:
        if p.startswith('/') or any(s in ('', '.', '..') for s in p.split('/')) or (root / p).resolve() != root / p:
            raise RuntimeError('Deployment files must be registered relative paths without symlinks.')
    return value


def command(manager, profile, deployment):
    root = Path(deployment['directory'])
    result = ['docker', 'compose', '--project-directory', str(root), '-p', profile['project'],
              '--env-file', str(root / deployment['env_file'])]
    for name in deployment['compose_files']: result += ['-f', str(root / name)]
    return result + ['-f', str(manager.CONFIG.parent / profile['storage_file'])]


def model_guard(manager, profile, model):
    policy, declared, digest = runtime.contract(manager, profile)
    if model.get('name') != profile['project']: raise RuntimeError('Rendered project differs.')
    volumes = model.get('volumes', {})
    nfs = volumes.get('mx_static_raw_media_nfs', {})
    if nfs.get('external') is not True or nfs.get('name') != profile['nfs_volume']:
        raise RuntimeError('The NAS volume must remain external with the exact name.')
    if set(declared['services']) - set(model.get('services', {})):
        raise RuntimeError('A media service is missing; review the media role declaration.')
    for name, service in model['services'].items():
        mounts = service.get('volumes', [])
        if any(not isinstance(m, dict) for m in mounts): raise RuntimeError('Expected normalized Compose mounts.')
        if name not in declared['services']:
            if any(volumes.get(m.get('source'), {}).get('name') in (profile['volume'], profile['nfs_volume']) for m in mounts):
                raise RuntimeError('Unregistered media consumer: ' + name)
            continue
        child = [m for m in mounts if m.get('target') == storage.RAW]
        parent = [m for m in mounts if m.get('target') == '/app/media']
        if (len(child) != 1 or child[0].get('type') != 'volume' or child[0].get('source') != 'mx_static_raw_media_nfs'
                or child[0].get('read_only', False) != (name == 'gateway')
                or child[0].get('volume', {}).get('nocopy') is not True or child[0].get('volume', {}).get('subpath')):
            raise RuntimeError('Wrong NAS child mount: ' + name)
        if (len(parent) != 1 or parent[0].get('type') != 'volume'
                or volumes.get(parent[0].get('source'), {}).get('name') != profile['volume']):
            raise RuntimeError('Media parent volume changed: ' + name)
        tmpfs = service.get('tmpfs', [])
        if isinstance(tmpfs, str): tmpfs = [tmpfs]
        if any(m.get('target', '').startswith(storage.RAW + '/') for m in mounts) or any(
                p.split(':', 1)[0] == storage.RAW or p.split(':', 1)[0].startswith(storage.RAW + '/') for p in tmpfs):
            raise RuntimeError('A nested mount/tmpfs can hide NAS media: ' + name)
        if service.get('volumes_from') or service.get('post_start') or service.get('pre_start'):
            raise RuntimeError('Extra mount/lifecycle behavior needs review: ' + name)
        if any(m.get('type') == 'volume' and not m.get('source') for m in mounts):
            raise RuntimeError('Anonymous media-service volume requires explicit ownership: ' + name)


def data_volumes(manager, profile, model):
    names = sorted({v['name'] for v in model.get('volumes', {}).values()})
    existing = set(manager.run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines())
    missing = set(names) - existing
    if missing:
        raise RuntimeError('数据卷缺失，禁止创建空卷替代（可能执行过 down -v）：' + ', '.join(sorted(missing)))
    nfs = json.loads(manager.run(['docker', 'volume', 'inspect', profile['nfs_volume']]))
    if len(nfs) != 1: raise RuntimeError('Expected one NAS volume.')
    manager.prep.validate_volume(nfs[0])


def current(manager, profile):
    containers, volume, mountinfo = storage.collect(manager, profile)
    result = storage.evaluate(profile, containers, volume, mountinfo, allow_stopped=True, allow_replicas=True)
    # Missing media containers can be recreated explicitly. Existing wrong mounts
    # still require repair; never accept SSD-only writers as a deployment baseline.
    if result['issues'] or any(s['issues'] for s in result['services'] if s.get('id')):
        raise RuntimeError('现存媒体消费者的挂载不符；先处理存储差异，不直接重建覆盖。')
    selected = runtime.selected(profile, containers)
    if any(any(c.get('State', {}).get(k) for k in ('Paused', 'OOMKilled', 'Restarting', 'Dead')) for c in selected.values()):
        raise RuntimeError('Existing media container needs review; no forced stop/restart.')
    databases = {}
    for c in containers:
        labels = c.get('Config', {}).get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') == profile['project'] and name in ('postgres', 'redis'):
            if name in databases or not c['State'].get('Running'):
                raise RuntimeError('业务数据库/队列未就绪；由业务部署先恢复，本命令不创建或启动它们。')
            databases[name] = c['Id']
    if set(databases) != {'postgres', 'redis'}:
        raise RuntimeError('数据库/队列容器缺失；先由业务恢复原数据与服务，不自动初始化。')
    return selected, databases


def launch_policy(model):
    """Preserve the already-established storage-maintenance startup semantics."""
    result = copy.deepcopy(model)
    services = result['services']
    web = services['web']; env = web.get('environment', {})
    if web.get('command') not in (None, ['/app/scripts/run_web.sh']) and not (
            isinstance(web.get('command'), list) and web['command'][:2] == ['gunicorn', 'mx_data.wsgi:application']):
        raise RuntimeError('Custom web startup needs maintenance review; do not run unknown account initialization.')
    web['command'] = ['gunicorn', 'mx_data.wsgi:application', '--bind',
                      (env.get('MX_HOST') or '0.0.0.0') + ':' + (env.get('MX_PORT') or '8000'),
                      '--workers', str(env.get('MX_WEB_WORKERS') or '2'), '--timeout', str(env.get('MX_WEB_TIMEOUT') or '600')]
    for name in storage.prep.SERVICES - {'web', 'gateway'}:
        service = services[name]
        script = '/app/scripts/' + ('run_worker.sh' if name.startswith('worker') else 'run_beat.sh' if name == 'beat' else 'run_chat_gateway.sh')
        if service.get('command') != [script]: raise RuntimeError('Custom media startup needs review: ' + name)
        if name.startswith('worker'): service.setdefault('environment', {})['MX_RECOVER_STALE_AGENT_RUNS'] = '0'
    for name in storage.prep.SERVICES - {'gateway'}:
        if services[name].get('entrypoint') not in (None, [], ''):
            raise RuntimeError('Custom application entrypoint requires review: ' + name)
    # Resolved environment values are already in the model. Do not reread env
    # files at execution, and do not allow Compose to create any empty data volume.
    for service in services.values(): service.pop('env_file', None)
    for key, volume in list(result.get('volumes', {}).items()):
        result['volumes'][key] = {'name': volume['name'], 'external': True}
    return result


def prepare(manager, profile):
    runtime.registered(manager, profile)
    deployment = definition(manager, profile)
    model = json.loads(manager.run(command(manager, profile, deployment) + ['config', '--format', 'json']))
    model_guard(manager, profile, model)
    data_volumes(manager, profile, model)
    rows, databases = current(manager, profile)
    return deployment, launch_policy(model), rows, databases


def check(manager, profile):
    deployment, model, rows, databases = prepare(manager, profile)
    emit('nas_media_deployment_check', project=profile['project'], current_media_containers=len(rows),
         missing_services=sorted(set(storage.prep.SERVICES) - {c['Config']['Labels']['com.docker.compose.service'] for c in rows.values()}),
         data_volumes_present=True, production_changed=False,
         note='只读配置核对；未构建、未重建。维护启动跳过数据库迁移/账号初始化，执行前仍核对新镜像启动脚本。')


def resolve_images(manager, deployment, model):
    images = {}
    for name in sorted(storage.prep.SERVICES):
        tag = model['services'][name].get('image')
        if not tag: raise RuntimeError('Media services require explicit image names for controlled builds.')
        if tag not in images:
            value = json.loads(manager.run(['docker', 'image', 'inspect', tag]))
            if len(value) != 1: raise RuntimeError('Expected a local image; build/pull it explicitly before maintenance.')
            images[tag] = value[0]
        image = images[tag]
        if name != 'gateway' and image.get('Config', {}).get('Entrypoint'):
            raise RuntimeError('Application image entrypoint changed; review before starting it.')
        model['services'][name]['image'] = image['Id']
    # Inspect startup files without application initialization, network, media,
    # database access or image-default ENTRYPOINT/CMD.
    wanted = deployment['startup_scripts_sha256']
    probe = 'import hashlib,json; print(json.dumps({p:hashlib.sha256(open("/app/"+p,"rb").read()).hexdigest() for p in ' + repr(sorted(wanted)) + '}))'
    for image in sorted({model['services'][n]['image'] for n in storage.prep.SERVICES - {'gateway'}}):
        actual = json.loads(manager.run(['docker', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', 'python', image, '-c', probe]))
        if actual != wanted: raise RuntimeError('New image startup scripts changed; review maintenance startup before stopping production.')


def recreate(manager, profile, build=False):
    if not manager.recovery_control.installed_current(manager):
        raise RuntimeError('先 recovery install，确保开机工具与当前媒体声明一致，再安排重建。')
    if not manager.recovery_control.requested(manager.auto_config(), 'part1'):
        raise RuntimeError('媒体恢复策略已暂停或未选择 infra；先明确启用，再安排维护重建。')
    deployment, model, before, databases = prepare(manager, profile)
    prepared_model = copy.deepcopy(model)
    folder = manager.secure_directory(ROOT)
    name = 'infra-' + uuid.uuid4().hex
    try:
        os.mkdir(name, 0o700, dir_fd=folder)
        output = os.open(name, manager.DIR_FLAGS, dir_fd=folder); os.fsync(folder)
    finally: os.close(folder)
    path = ROOT + '/' + name
    prefix = ['docker', 'compose', '--project-directory', deployment['directory'], '-p', profile['project'],
              '-f', path + '/compose.private.json']
    state = {'schema': 1, 'project': profile['project'], 'phase': 'prepared', 'report_directory': path,
             'source_deleted': False, 'business_acceptance_pending': True, 'build_requested': build}
    try:
        # `compose config` already escapes literal dollars for reloading. Keep
        # that representation: escaping again changes secrets and shell commands.
        manager.prep.private_write(output, 'compose.private.json', model)
        manager.cutover.atomic_json(output, 'execution.json', state)
        emit('nas_media_deployment_prepared', report_directory=path, build=build,
             note='当前配置的私有快照；所有数据卷 external，维护启动不执行账号初始化。')
        if build:
            emit('nas_media_deployment_building', report_directory=path, private_log=path+'/build.log')
            run_logged(prefix + ['build'] + sorted(storage.prep.SERVICES), output, 'build.log')
        resolve_images(manager, deployment, model)
        manager.cutover.atomic_json(output, 'compose.private.json', model)
        data_volumes(manager, profile, model)
        now, db_now = current(manager, profile)
        if set(now) != set(before) or db_now != databases:
            raise RuntimeError('Containers changed during preparation/build; no production stop performed.')
        # Do not race an application edit after the private model was prepared.
        latest = json.loads(manager.run(command(manager, profile, deployment) + ['config', '--format', 'json']))
        model_guard(manager, profile, latest)
        if launch_policy(latest) != prepared_model: raise RuntimeError('Application configuration changed during build/preparation; retry before stopping services.')
        state['supersedes_pending_maintenance'] = runtime.read_record(manager).get('maintenance_report')
        state['phase'] = 'stopping_media'; manager.cutover.atomic_json(output, 'execution.json', state)
        runtime.maintenance_state(manager, profile, path)
        for group in manager.cutover.STOP_GROUPS:
            ids = [c['Id'] for c in now.values() if c['Config']['Labels']['com.docker.compose.service'] in group and c['State']['Running']]
            if ids: manager.run(['docker', 'stop', '-t', '-1'] + ids, timeout=None)
        stopped, db_now = current(manager, profile)
        if set(stopped) != set(before) or db_now != databases or any(c['State']['Running'] for c in stopped.values()):
            raise RuntimeError('Media did not stop cleanly or deployment changed; no create/start performed.')
        data_volumes(manager, profile, model)
        state['phase'] = 'creating_media'; manager.cutover.atomic_json(output, 'execution.json', state)
        run_logged(prefix + ['up', '--no-start', '--no-deps', '--no-build', '--pull', 'never',
            '--force-recreate', '--remove-orphans=false'] + sorted(storage.prep.SERVICES), output, 'create.log')
        created = runtime.inspect(manager, profile)
        if any(c['State']['Running'] for c in created.values()): raise RuntimeError('Created media unexpectedly running; inspect the private receipt.')
        state.update(phase='media_created', current_ids=sorted(created))
        manager.cutover.atomic_json(output, 'execution.json', state)
        if current(manager, profile)[1] != databases:
            raise RuntimeError('Database/queue changed during creation; not starting media.')
        # Explicit maintenance startup uses the same media checks as recovery,
        # while respecting a global/project pause before every start.
        infra_services.recover(manager, profile, automatic=True, maintenance_report=path)
        after, db_now = current(manager, profile)
        if set(after) != set(created) or db_now != databases: raise RuntimeError('Deployment changed during maintenance startup.')
        state['phase'] = 'running_on_nas'; manager.cutover.atomic_json(output, 'execution.json', state)
        runtime.maintenance_state(manager, profile, path, complete=True)
        emit('nas_media_deployment_complete', **state,
             note='仅重建媒体服务；原迁移报告/清单未改，业务验收另行完成。')
    except BaseException:
        state['failed_phase'] = state['phase']; state['phase'] = 'failed_or_partial'
        manager.cutover.atomic_json(output, 'execution.json', state)
        emit('nas_media_deployment_failed', report_directory=path, failed_phase=state['failed_phase'],
             note='未自动 SSD 回滚或恢复旧镜像；停止重试，先查看私有执行记录。')
        raise
    finally: os.close(output)
