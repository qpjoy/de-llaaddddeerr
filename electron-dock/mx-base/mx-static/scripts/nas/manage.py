#!/usr/bin/env python3
"""Central NAS operations; never infer a destructive action from status."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid

import catalog
import recovery as recovery_control
import host as host_control
import action_log
from projects import infra as infra_adapter
from projects import infra_storage
import cutover
import cutover_prepare as prep
import precopy
import reclaim_plan
from permissions import emit
from sample_copy import DIR_FLAGS

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / 'deploy/nas/profiles.json'
AUTO_DIR = '/etc/mx-static/nas'
RUNTIME = '/usr/local/lib/mx-static-nas'
UNIT = 'mx-static-nas-boot'


def run(args, timeout=45):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, timeout=timeout)
    if result.returncode:
        # Keep complete systemd diagnostics private; previously stderr was lost.
        message='{} failed (exit {})'.format(args[0],result.returncode)
        if args[0] in ('systemctl','systemd-analyze'):
            fd=secure_directory('/var/log/mx-static-nas')
            name='systemd-error-'+uuid.uuid4().hex+'.json'
            try:
                prep.private_write(fd,name,{'command':args,'exit':result.returncode,
                    'stdout':result.stdout[-32768:],'stderr':result.stderr[-32768:],
                    'truncated':len(result.stdout)>32768 or len(result.stderr)>32768})
                os.fsync(fd)
            finally:os.close(fd)
            message+='；完整诊断（最多各 32 KiB）：/var/log/mx-static-nas/'+name
        else:message+='; inspect its journal locally.'  # Docker/Compose can quote secrets.
        raise RuntimeError(message)
    return result.stdout


def profiles():
    return catalog.load(CONFIG)[0]['parts']


def storage_guard(operation, profile):
    policy = json.loads((CONFIG.parent/profile['storage_file']).read_text())
    actual = {'services': {n: {'volumes': v['volumes']} for n,v in operation.overlay['services'].items()},
              'volumes': operation.overlay['volumes']}
    if policy != actual: raise RuntimeError('Git storage declaration differs from the successful migration; review before use.')


@contextlib.contextmanager
def migration_lock():
    fd = os.open('/run/lock/mx-static-nas-sample.lock', os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise RuntimeError('Unsafe migration lock.')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield
    finally:os.close(fd)


@contextlib.contextmanager
def operation(profile, require_running=False):
    if profile['volume'] != prep.VOLUME or not profile.get('report'):
        raise RuntimeError('Part 2 currently supports audit and pre-copy only; no reviewed cutover registration exists.')
    fd=cutover.open_report(profile['report']); op=None
    try:
        op=cutover.Cutover(profile['report'],fd)
        op.state=cutover.read_json(fd,'execution.json')
        state=op.state
        if (state.get('report_directory') != op.path or state.get('volume') != prep.VOLUME or
                state.get('final_sync_passed') is not True or state.get('nas_may_have_writes') is not True or
                set(state.get('new_ids',{})) != prep.SERVICES):
            raise RuntimeError('Successful NAS cutover and exact container registration required.')
        storage_guard(op,profile)
        op.config_guard()
        consumers=op.mounted_services(True,expected_ids=state['new_ids'])
        if require_running:reclaim_plan.health_guard(consumers)
        yield op,consumers
    finally:
        if op is not None:op.close()
        os.close(fd)


def summary(rows, profile):
    selected=[]
    for c in rows:
        labels=c.get('Config',{}).get('Labels') or {}
        if labels.get('com.docker.compose.project') != profile['project']:continue
        s=c.get('State',{})
        selected.append({'service':labels.get('com.docker.compose.service'),'id':c['Id'][:12],
            'status':s.get('Status'),'health':s.get('Health',{}).get('Status'),
            'restart':c.get('HostConfig',{}).get('RestartPolicy',{}).get('Name'),
            'raw_media_mounts':[{k:m.get(k) for k in ('Type','Name','Destination','RW')}
                               for m in c.get('Mounts',[]) if m.get('Destination')==cutover.RAW]})
    return sorted(selected,key=lambda c:c['service'] or '')


def locate(part, profile):
    emit('nas_locations',part=part,git_registry=str(CONFIG),git_storage=(str(CONFIG.parent/profile['storage_file']) if profile['storage_file'] else None),
        report=profile['report'],runtime_override=(profile['report']+'/compose.nas.override.json' if profile['report'] else None),
        reclaim_plan=profile['plan'],ssd='/data/docker/volumes/'+profile['volume']+'/_data/data_hub_raw_media',
        nas='/mnt/nas/mx-internal-server/data/docker/media-volumes/'+profile['volume']+'/data_hub_raw_media',
        docker_nfs_volume=profile['nfs_volume'],auto_config=AUTO_DIR+'/auto.json',
        installed_runtime=RUNTIME+'/current',boot_service=UNIT+'.service',boot_timer=UNIT+'.timer')


def auto_config():
    try:fd=os.open(AUTO_DIR,DIR_FLAGS)
    except FileNotFoundError:return recovery_control.normalize({'schema':1,'enabled_parts':[]},profiles())
    try:value=cutover.read_json(fd,'auto.json')
    except FileNotFoundError:value={'schema':1,'enabled_parts':[]}
    finally:os.close(fd)
    return recovery_control.normalize(value,profiles())


def systemd_summary():
    keys='Id,LoadState,ActiveState,SubState,UnitFileState,Result'
    result=subprocess.run(['systemctl','show',UNIT+'.service',UNIT+'.timer','--property='+keys],
                          stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True,timeout=15)
    return {'exit':result.returncode,'units':result.stdout}


def status(part, profile):
    locate(part,profile)
    rows=precopy.inspect_containers()
    capacity=os.statvfs('/data')
    emit('nas_status',part=part,containers=summary(rows,profile),data_available_bytes=capacity.f_bavail*capacity.f_frsize,
         auto=auto_config(),systemd=systemd_summary(),nas_walk=False)
    if profile['storage_file']:
        infra_storage.check(sys.modules[__name__],profile,rows)
    if profile['report']:
        fd=cutover.open_report(profile['report'])
        try:
            state=cutover.read_json(fd,'execution.json')
            emit('nas_migration_state',part=part,phase=state.get('phase'),business_acceptance_pending=state.get('business_acceptance_pending'),ssd_reclaim=state.get('ssd_reclaim'))
        finally:os.close(fd)


def boot_check(part,profile):
    with operation(profile) as (op,rows):
        emit('nas_boot_check',part=part,registered_mounts=True,databases_healthy=True,
             stopped=[n for n,c in rows.items() if not c['State']['Running']],
             unhealthy=[n for n,c in rows.items() if c['State'].get('Health',{}).get('Status')=='unhealthy'],
             auto_enabled=part in auto_config()['enabled_parts'],host_nas_mount_required=False,
             note='Metadata/configuration only; does not prove an actual reboot or NFS outage recovery.')


def recover(profile):
    # This boot path deliberately avoids /mnt/nas and the SSD old-media tree.
    # Docker owns its native NFS mount; host fstab can be absent/late independently.
    with operation(profile) as (op,rows):
        if all(c['State'].get('Running') and not c['State'].get('Restarting') for c in rows.values()):
            reclaim_plan.health_guard(rows)
            emit('nas_recovery_result',started=[],note='Registered containers already healthy; no restart performed.')
            return
        if any(c['State'].get('Paused') or c['State'].get('OOMKilled') for c in rows.values()):
            raise RuntimeError('Paused/OOM container needs review; no automatic restart.')
        with socket.create_connection(('192.168.1.3',2049),timeout=5):pass
        started=[]
        for group,healthy in ((('web','chat-gateway'),True),(tuple(cutover.WORKERS),False),(('gateway',),True),(('beat',),False)):
            rows=op.mounted_services(True,expected_ids=op.state['new_ids'])
            for name in group:
                s=rows[name]['State']
                if s.get('Restarting') or s.get('Paused'):raise RuntimeError('Docker is already restarting or container is paused: '+name)
                if not s['Running']:
                    emit('nas_recovery_starting',service=name,container=rows[name]['Id'][:12])
                    # A stalled mount may wait. Keep a single service/lock, no repeated starts.
                    op.command(['docker','start',rows[name]['Id']],timeout=None)
                    started.append(name)
            op.wait_running([rows[n]['Id'] for n in group],healthy)
        reclaim_plan.health_guard(op.mounted_services(True,expected_ids=op.state['new_ids']))
        emit('nas_recovery_result',started=started,note='Same containers only. No recreation, rsync, deletion or database restart.')


def task_command(action, profile, args):
    py='/usr/bin/python3'; scripts=ROOT/'scripts/nas'
    if action=='copy':
        return [py,'-B',str(scripts/'precopy.py'),profile['volume'],'--copy']+(['--unlimited'] if args.unlimited else [])
    if not profile.get('report') or profile['volume']!=prep.VOLUME:
        raise RuntimeError('No reviewed Part 2 cutover/reclaim implementation; use copy part2 first.')
    if action=='prepare':return [py,'-B',str(scripts/'cutover_prepare.py'),profile['volume'],'--prepare']
    if action=='cutover':
        if not args.maintenance:raise RuntimeError('cutover requires --maintenance in the agreed window.')
        return [py,'-B',str(scripts/'cutover.py'),'--cutover',profile['report']]
    if action=='plan':return [py,'-B',str(scripts/'reclaim_plan.py'),profile['report']]
    if action=='reclaim':
        if not args.business_accepted:raise RuntimeError('reclaim requires --business-accepted after actual acceptance.')
        return [py,'-B',str(scripts/'reclaim.py'),'--business-accepted',profile['plan']]
    if action=='permissions-probe':
        if not args.write_test:raise RuntimeError('Permission probe requires --write-test.')
        return [py,'-B',str(Path(__file__).resolve()),'_execute-permissions',args.part,'--write-test']
    if action in ('recover','redeploy'):
        if action=='redeploy' and not args.maintenance:raise RuntimeError('redeploy requires --maintenance.')
        return [py,'-B',str(Path(__file__).resolve()),'_execute-'+action,args.part]+(['--maintenance'] if action=='redeploy' else [])
    raise RuntimeError('Unsupported task.')


def launch(action,profile,args):
    command=task_command(action,profile,args)
    # Refuse repeating an already completed cutover before starting a transient unit.
    if action in ('copy','prepare','cutover') and profile.get('report'):
        fd=cutover.open_report(profile['report'])
        try:
            try:state=cutover.read_json(fd,'execution.json')
            except FileNotFoundError:state={}
            if state.get('nas_may_have_writes'):raise RuntimeError('Already switched to NAS; old copy/prepare/cutover is forbidden.')
        finally:os.close(fd)
    unit='mx-nas-{}-{}-{}'.format(args.part,action,uuid.uuid4().hex[:10])
    cmd=['systemd-run','--unit='+unit,'--property=RuntimeMaxSec=infinity',
         '--property=TimeoutStopSec='+('infinity' if action in ('cutover','redeploy') else '90s')]
    if action in ('copy','prepare','cutover','plan','permissions-probe'):cmd+=['--property=ReadOnlyPaths=/data']
    if action=='reclaim':cmd+=['--property=ReadOnlyPaths=/mnt/nas']
    if action=='copy':cmd+=['--property=Nice=19']
    print(run(cmd+command),end='')
    emit('nas_job_started',part=args.part,action=action,unit=unit+'.service',
         logs='sudo bash scripts/manage.sh nas logs '+args.part,
         transient=True,reboot_auto_resume=False)


def redeploy(profile):
    # Recreate the SAME pinned images, preserving safe launch overrides.
    with operation(profile,require_running=True) as (op,rows):
        op.open_media(sealed=True)
        op.stop(rows)
        cutover.require_stopped(op.mounted_services(True,expected_ids=op.state['new_ids']))
        op.config_guard()
        op.command(cutover.create_command(op.path,'compose.nas.override.json'),timeout=None)
        created=op.mounted_services(True)
        cutover.require_stopped(created)
        op.state.update(new_ids={n:c['Id'] for n,c in created.items()})
        op.checkpoint('nas_containers_created')
        running=op.start(created,True)
        op.http_probe(running)
        op.seal('cutover_running_on_nas')
        op.checkpoint('running_on_nas',business_acceptance_pending=True)
        emit('nas_redeploy_result',phase='running_on_nas',same_images=True,business_acceptance_pending=True)


def secure_directory(path):
    fd=os.open('/',DIR_FLAGS)
    try:
        for name in path.strip('/').split('/'):
            try:os.mkdir(name,0o755,dir_fd=fd)
            except FileExistsError:pass
            child=os.open(name,DIR_FLAGS,dir_fd=fd); os.close(fd);fd=child
            s=os.fstat(fd)
            if s.st_uid!=0 or s.st_mode & 0o022:raise RuntimeError('Unsafe system directory: '+path)
        return fd
    except BaseException:os.close(fd);raise


def unit_files():
    return {name:(CONFIG.parent/name).read_text() for name in (UNIT+'.service',UNIT+'.timer')}


def runtime_sources():
    return sorted(list((ROOT/'scripts/nas').rglob('*.py'))+catalog.installed_files(CONFIG)+
                  [CONFIG.parent/name for name in unit_files()])


def install_auto():
    if not Path('/usr/bin/python3').is_file():raise RuntimeError('Persistent runtime requires /usr/bin/python3.')
    # Install implementation/policy, no .env, secrets or private reports.
    files={str(p.relative_to(ROOT)):p.read_bytes() for p in runtime_sources()}
    digest=hashlib.sha256()
    for name,data in sorted(files.items()):digest.update(name.encode()+b'\0'+data)
    version=digest.hexdigest()[:20]
    rootfd=secure_directory(RUNTIME); configfd=secure_directory(AUTO_DIR); unitfd=secure_directory('/etc/systemd/system')
    try:
        release=Path(RUNTIME)/version
        if release.exists():
            for name,data in files.items():
                if (release/name).is_symlink() or (release/name).read_bytes()!=data:raise RuntimeError('Installed runtime differs.')
        else:
            temporary=Path(RUNTIME)/('.install-'+uuid.uuid4().hex);temporary.mkdir(mode=0o755)
            for name,data in files.items():
                p=temporary/name;p.parent.mkdir(parents=True,exist_ok=True)
                with p.open('wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
                p.chmod(0o644)
            for directory in sorted([temporary]+[p for p in temporary.rglob('*') if p.is_dir()],key=lambda p:len(p.parts),reverse=True):
                fd=os.open(str(directory),DIR_FLAGS)
                try:os.fsync(fd)
                finally:os.close(fd)
            os.rename(str(temporary),str(release))
        run(['systemd-analyze','--man=no','verify']+
            [str(release/'deploy/nas'/name) for name in unit_files()])
        for name,content in unit_files().items():
            try:
                old=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=unitfd)
            except FileNotFoundError:old=None
            if old is not None:
                with os.fdopen(old) as f:
                    if not f.read().startswith('# Managed by mx-static scripts/manage.sh nas auto-install\n'):
                        raise RuntimeError('Unmanaged systemd unit exists: '+name)
            temp='.'+name+'.'+uuid.uuid4().hex
            fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644,dir_fd=unitfd)
            with os.fdopen(fd,'w') as f:f.write(content);f.flush();os.fsync(f.fileno())
            os.rename(temp,name,src_dir_fd=unitfd,dst_dir_fd=unitfd)
        temp='.current-'+uuid.uuid4().hex
        os.symlink(version,temp,dir_fd=rootfd);os.rename(temp,'current',src_dir_fd=rootfd,dst_dir_fd=rootfd);os.fsync(rootfd)
        try:cutover.read_json(configfd,'auto.json')
        except FileNotFoundError:prep.private_write(configfd,'auto.json',{'schema':1,'enabled_parts':[]})
        os.fsync(unitfd);os.fsync(configfd)
        run(['systemctl','daemon-reload'])
        emit('nas_auto_installed',runtime=str(release),auto_enabled=auto_config()['enabled_parts'],
             note='Units installed/updated; no container started and timer not enabled by installation.')
    finally:
        for fd in (rootfd,configfd,unitfd):os.close(fd)


def enable_timer():
    try:run(['systemctl','enable','--now',UNIT+'.timer'])
    except (OSError,RuntimeError,subprocess.SubprocessError) as exc:
        raise RuntimeError('恢复策略已保存，但 timer 启用/启动未完成，尚不能确认恢复生效。'+str(exc))


def set_auto(part,profile,enabled):
    if part!='part1':raise RuntimeError('Automatic recovery is currently registered only for Part 1.')
    if enabled:
        if not recovery_control.installed_current(sys.modules[__name__]):raise RuntimeError('Run recovery install first; installed runtime must match current code/policy.')
        # Do not enable against drifted/stopped production; recover it explicitly first.
        with operation(profile,require_running=True):pass
        installed=json.loads((Path(RUNTIME)/'current/deploy/nas/profiles.json').read_text())
        if installed['parts'][part]!=profile:raise RuntimeError('Installed policy is stale; run auto-install again.')
    value=auto_config(); parts=set(value['enabled_parts']);disabled=set(value.get('disabled_parts',[]))
    if enabled:
        parts.add(part);disabled.discard(part)
    else:
        parts.discard(part);disabled.add(part)
    value['enabled_parts']=sorted(parts);value['disabled_parts']=sorted(disabled)
    fd=secure_directory(AUTO_DIR)
    try:cutover.atomic_json(fd,'auto.json',value)
    finally:os.close(fd)
    if enabled and not value.get('suspended',False):
        enable_timer()
    elif not parts and value.get('mode','explicit')=='explicit':
        run(['systemctl','disable','--now',UNIT+'.timer'])
        run(['systemctl','stop',UNIT+'.service'])
    emit('nas_auto_policy',**value,note='Boot recovery only; disabling does not stop business containers.')


def parser():
    p=argparse.ArgumentParser(description='mx-static NAS operations (no Node/static-server dependency).')
    sub=p.add_subparsers(dest='action');sub.required=True
    for action in ('status','locate','boot-check','copy','prepare','cutover','plan','reclaim','recover','redeploy','compose','logs','auto-enable','auto-disable','permissions-check','permissions-probe','deployment-audit','storage-check','_execute-permissions','_execute-recover','_execute-redeploy'):
        s=sub.add_parser(action);s.add_argument('part',choices=tuple(profiles()))
        if action in ('permissions-probe','_execute-permissions'):s.add_argument('--write-test',action='store_true')
        if action=='copy':s.add_argument('--unlimited',action='store_true')
        if action in ('cutover','redeploy','_execute-redeploy'):s.add_argument('--maintenance',action='store_true')
        if action=='reclaim':s.add_argument('--business-accepted',action='store_true')
        if action=='compose':s.add_argument('view',choices=('ps','config-check'))
    for name in ('auto-install','_auto-recover','catalog-list','host-status','host-processes','host-mount-check','host-network','recovery-check-all','recovery-enable-migrated','recovery-disable-all'):sub.add_parser(name)
    return p


HELP = """推荐二级入口（root 可省略 sudo）：
  bash scripts/manage.sh nas project list
  bash scripts/manage.sh nas host status|processes|mount-check|network
  bash scripts/manage.sh nas infra status|locate|logs|recovery
  bash scripts/manage.sh nas infra permissions check
  bash scripts/manage.sh nas infra permissions probe --write-test
  bash scripts/manage.sh nas infra deployment audit
  bash scripts/manage.sh nas infra storage check     # 当前挂载核对；不符/未确认退出 1
  bash scripts/manage.sh nas infra task part1 plan
  bash scripts/manage.sh nas infra task part1 cleanup --business-accepted
  bash scripts/manage.sh nas delta task part2 copy --unlimited
  bash scripts/manage.sh nas recovery check          # 统一检查所有登记项目
  bash scripts/manage.sh nas recovery install
  bash scripts/manage.sh nas recovery enable --migrated
  bash scripts/manage.sh nas recovery disable        # 暂停全部开机补启动
  bash scripts/manage.sh nas recovery check|enable|disable|run|status infra

默认中文易读显示；任意位置加 --json 保留原始 JSON，--pretty 格式化 JSON。
后台任务日志、审计文件继续保存原始结构化事件。

上述 infra/delta 也可写为 project infra / project delta。新项目需在 Git 登记
目录、身份与执行能力；不扫描全盘自动迁移，不将未审核项目当成 infra。

兼容旧用法: sudo bash scripts/manage.sh nas <操作> [part1|part2] [选项]

  status part1|part2        容器、历史迁移记录、当前挂载、SSD 空间、开机恢复配置
  locate part1|part2        定位 Git 声明、覆盖文件、报告、源/目标、系统服务
  logs part1|part2          跟随迁移日志（part1 包含开机恢复日志）
  boot-check part1          只读检查容器登记、挂载声明和数据库健康
  compose part1 ps          携带 NAS 覆盖查询 Compose 状态
  compose part1 config-check  检查合并配置，不打印密钥
  recover part1            补启动现有 NAS 容器；不重建或复制
  redeploy part1 --maintenance  维护窗口内同版本重建媒体服务，保留 NAS
  plan part1               生成新的只读 SSD 清单，不自动改选清理清单
  reclaim part1 --business-accepted  业务验收后按已登记清单回收旧 SSD
  copy part2 [--unlimited]  第二卷在线预复制；不自动切换或删除
  auto-install             安装/更新 Git 中的恢复工具和 systemd 单元，默认不启用
  auto-enable part1        登记希望开机运行，并启用持久 timer
  auto-disable part1       暂停开机恢复；不停止业务容器

part1 有历史切换记录，当前挂载需另行核对；重复 copy/prepare/cutover 会拒绝。
part2 尚仅支持预复制。storage check 不拦截外部发布，也不授权清理或重置迁移记录。
没有服务器 reboot、数据库重启或自动删除命令。迁移任务是临时单元；
开机恢复在安装和启用后生效，成功后不持续重启/监控容器。
"""


def audit(action, part, outcome):
    fd=secure_directory('/var/log/mx-static-nas')
    try:action_log.append(fd,action,part,outcome);os.fsync(fd)
    finally:os.close(fd)


def main():
    if sys.argv[1:] in ([], ['help'], ['--help'], ['-h']):
        print(HELP);return 0
    audit_started=False;action='route';args=None
    try:
        args=parser().parse_args(catalog.route(sys.argv[1:],CONFIG)); action=args.action
        if action=='catalog-list':
            index,policy,projects=catalog.load(CONFIG)
            emit('nas_projects',host=policy['host'],projects=projects,tasks=index['parts'])
            return 0
        if not sys.platform.startswith('linux') or os.geteuid()!=0:raise RuntimeError('Run with sudo on the registered Linux Docker host.')
        if socket.gethostname().split('.')[0]!='mx-internal-server':raise RuntimeError('This registry belongs to mx-internal-server.')
        if action not in ('locate','logs','auto-install','auto-disable','host-status','host-processes','host-mount-check','host-network','deployment-audit','recovery-disable-all'):
            precopy.check_host()
        registry=profiles()
        profile=registry.get(getattr(args,'part',None))
        mutations={'copy','prepare','cutover','reclaim','recover','redeploy','auto-install','auto-enable','auto-disable','permissions-probe','_execute-permissions','_execute-recover','_execute-redeploy','_auto-recover','recovery-enable-migrated','recovery-disable-all'}
        if action in mutations:
            audit(action,getattr(args,'part',None),'requested');audit_started=True
        if action.startswith('host-'):
            host_control.inspect(action[5:],catalog.load(CONFIG)[1])
        elif action=='deployment-audit':infra_adapter.deployment_audit(sys.modules[__name__],profile)
        elif action=='storage-check':return 0 if infra_storage.check(sys.modules[__name__],profile) else 1
        elif action=='permissions-check':
            with migration_lock():infra_adapter.permissions(sys.modules[__name__],profile)
        elif action=='_execute-permissions':
            if not args.write_test:raise RuntimeError('Explicit --write-test required.')
            with migration_lock():infra_adapter.permissions(sys.modules[__name__],profile,True)
        elif action=='status':status(args.part,profile)
        elif action=='locate':locate(args.part,profile)
        elif action=='boot-check':boot_check(args.part,profile)
        elif action=='logs':
            cmd=['journalctl','-f','-n','40','-o','cat','-u','mx-nas-'+args.part+'-*']
            if args.part=='part1':
                for name in ('mx-nas-part1-po','mx-nas-cutover-po-*','mx-nas-reclaim-po-*',UNIT+'.service'):cmd+=['-u',name]
            os.execvp(cmd[0],cmd)
        elif action=='compose':
            with operation(profile) as (op,rows):
                cmd=prep.compose_command()+['-f',op.path+'/compose.nas.override.json']
                cmd+=['config','--quiet'] if args.view=='config-check' else ['ps']
                print(run(cmd),end='')
                emit('nas_compose_view',view=args.view,storage_override_included=True)
        elif action=='recovery-check-all':
            with migration_lock():recovery_control.show(sys.modules[__name__])
        elif action=='recovery-enable-migrated':
            with migration_lock():recovery_control.enable_migrated(sys.modules[__name__])
        elif action=='recovery-disable-all':
            # Pause must remain available while a recovery helper holds the migration lock.
            recovery_control.disable_all(sys.modules[__name__])
        elif action=='auto-install':install_auto()
        elif action in ('auto-enable','auto-disable'):
            with migration_lock():set_auto(args.part,profile,action=='auto-enable')
        elif action=='_auto-recover':
            with migration_lock():
                recovery_control.run_all(sys.modules[__name__])
        elif action in ('_execute-recover','_execute-redeploy'):
            if action=='_execute-redeploy' and not args.maintenance:raise RuntimeError('redeploy requires --maintenance.')
            with migration_lock():
                (recover if action=='_execute-recover' else redeploy)(profile)
        else:launch(action,profile,args)
        if audit_started:audit(action,getattr(args,'part',None),'command_completed')
        return 0
    except (OSError,RuntimeError,ValueError,KeyError,subprocess.SubprocessError) as exc:
        if audit_started:
            try:audit(action,getattr(args,'part',None),'failed_or_partial')
            except (OSError,RuntimeError):pass
        emit('nas_manager_failed',action=action,error=str(exc),note='No automatic rollback. Read the action journal before retrying.')
        return 1


if __name__=='__main__':sys.exit(main())
