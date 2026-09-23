"""Discover reviewed, completed migrations for centralized boot recovery."""
import json
import os
from pathlib import Path
import subprocess

import catalog
from permissions import emit

ERRORS=(OSError,RuntimeError,ValueError,KeyError,subprocess.SubprocessError)


def normalize(value, tasks):
    if not isinstance(value,dict):raise RuntimeError('Invalid recovery policy object.')
    result=dict(value)
    result.setdefault('mode','explicit');result.setdefault('disabled_parts',[]);result.setdefault('suspended',False)
    if (result.get('schema')!=1 or result['mode'] not in ('explicit','migrated') or
            not isinstance(result['suspended'],bool)):
        raise RuntimeError('Invalid recovery policy.')
    for key in ('enabled_parts','disabled_parts'):
        parts=result.get(key)
        if not isinstance(parts,list) or any(not isinstance(p,str) for p in parts) or set(parts)-set(tasks):
            raise RuntimeError('Unknown/invalid recovery tasks: '+key)
    if set(result['enabled_parts']) & set(result['disabled_parts']):raise RuntimeError('Conflicting recovery task policy.')
    return result


def reviewed(project):
    # A future adapter must be explicitly implemented here, not inferred from JSON.
    return project['adapter']=='infra-v1' and 'recover' in project['capabilities']


def installed_current(manager):
    installed=Path(manager.RUNTIME)/'current'
    try:
        return all((installed/p.relative_to(manager.ROOT)).read_bytes()==p.read_bytes() for p in manager.runtime_sources())
    except OSError:return False


def requested(policy, task):
    return not policy.get('suspended',False) and task not in policy.get('disabled_parts',[]) and (policy.get('mode')=='migrated' or task in policy['enabled_parts'])


def inventory(manager, require_running=False):
    index,host,projects=catalog.load(manager.CONFIG);policy=manager.auto_config()
    containers=manager.precopy.inspect_containers();results=[]
    for name,project in sorted(projects.items()):
        for task in project['tasks']:
            profile=index['parts'][task]
            observed=bool(profile.get('nfs_volume')) and any(c.get('Config',{}).get('Labels',{}).get('com.docker.compose.project')==profile['project'] and
                         any(m.get('Name')==profile.get('nfs_volume') for m in c.get('Mounts',[])) for c in containers)
            row={'project':name,'task':task,'state':'not_migrated','coverage':'未纳入','reason':'尚无成功 NAS 切换记录',
                 'nas_expected':observed or project.get('data_policy',{}).get('nas_authoritative') is True}
            state=None
            try:
                if profile.get('recovery_mode') == 'media-v1':
                    if not reviewed(project):raise RuntimeError('Media recovery adapter not reviewed.')
                    rows=manager.infra_services.check(manager,profile,require_running=require_running)
                    row.update(state='eligible',reason='独立 NAS 登记、当前挂载和已有服务依赖已核对（不绑定历史应用配置/ID）',
                               stopped=[c['Id'][:12] for c in rows.values() if not c['State']['Running']],
                               unhealthy=[c['Id'][:12] for c in rows.values() if c['State'].get('Health',{}).get('Status')=='unhealthy'])
                    row['nas_expected']=True
                    results.append(row)
                    continue
                if profile.get('report'):
                    fd=manager.cutover.open_report(profile['report'])
                    try:
                        try:state=manager.cutover.read_json(fd,'execution.json')
                        except FileNotFoundError:pass
                    finally:os.close(fd)
                if state is not None and not isinstance(state,dict):raise RuntimeError('迁移报告格式错误')
                if state:
                    if state.get('report_directory')!=profile['report'] or state.get('volume')!=profile['volume'] or state.get('schema')!=1:
                        raise RuntimeError('迁移报告身份不符')
                    row['nas_expected']=row['nas_expected'] or state.get('nas_may_have_writes') is True
                complete=(state is not None and state.get('phase')=='running_on_nas' and state.get('final_sync_passed') is True and state.get('nas_may_have_writes') is True)
                if not complete:
                    if row['nas_expected'] or task in policy['enabled_parts']:raise RuntimeError('存在 NAS 声明/消费者/恢复登记，但缺少完整成功切换记录')
                elif not reviewed(project):raise RuntimeError('已切换，但本项目恢复适配尚未审核')
                else:
                    # Checks actual IDs, images, native NFS options and DB health; no NAS walk.
                    with manager.operation(profile,require_running=require_running) as (op,rows):
                        stopped=[n for n,c in rows.items() if not c['State'].get('Running')]
                        unhealthy=[n for n,c in rows.items() if c['State'].get('Health',{}).get('Status')=='unhealthy']
                    row.update(state='eligible',reason='成功记录、容器身份和挂载一致',stopped=stopped,unhealthy=unhealthy)
                    if stopped:row['reason']+='；已停止：'+','.join(stopped)
                    if unhealthy:row['reason']+='；不健康：'+','.join(unhealthy)
            except ERRORS as exc:row.update(state='blocked',reason=str(exc))
            results.append(row)
    # Apply selection to both media-only and legacy adapters.
    for row in results:
        task=row['task']
        if task in policy.get('disabled_parts',[]):row['coverage']='项目已暂停'
        elif policy.get('suspended',False):row['coverage']='全局已暂停'
        elif requested(policy,task):row['coverage']='已纳入' if row['state']=='eligible' else '等待迁移' if row['state']=='not_migrated' else '被检查阻止'
        elif row['state']=='eligible':row['coverage']='遗漏：未启用'
    return policy,results


def show(manager, require_running=False):
    emit('nas_recovery_inventory_start',note='逐项核对 NAS 登记、当前挂载和已有服务依赖；不绑定历史业务配置，不扫描 NAS 文件或数据库内容。')
    policy,rows=inventory(manager,require_running)
    emit('nas_recovery_inventory',policy=policy,tasks=rows,installed_current=installed_current(manager),systemd=manager.systemd_summary())
    return policy,rows


def save(manager,value):
    fd=manager.secure_directory(manager.AUTO_DIR)
    try:manager.cutover.atomic_json(fd,'auto.json',value)
    finally:os.close(fd)


def enable_migrated(manager):
    if not installed_current(manager):raise RuntimeError('请先 recovery install，安装当前代码和完整项目声明。')
    policy,rows=show(manager,require_running=True)
    blocked=[r for r in rows if r['state']=='blocked' and r['task'] not in policy.get('disabled_parts',[])]
    if blocked:raise RuntimeError('存在未通过检查的项目；策略未修改，先查看统一检查结果。')
    policy=dict(policy,mode='migrated',suspended=False)
    save(manager,policy)
    manager.enable_timer()
    emit('nas_recovery_policy',mode='migrated',disabled_parts=policy.get('disabled_parts',[]),
         note='已启用统一策略：每次开机核对已登记的成功迁移；保留项目暂停项，不启动未审核项目。')


def disable_all(manager):
    policy=dict(manager.auto_config(),suspended=True)
    save(manager,policy)
    manager.run(['systemctl','disable','--now',manager.UNIT+'.timer'])
    manager.run(['systemctl','stop',manager.UNIT+'.service'])
    emit('nas_recovery_policy',suspended=True,note='已暂停全部开机补启动，保留项目选择，不停止业务容器。')


def run_all(manager):
    policy,rows=inventory(manager);registry=manager.profiles();failures=[]
    for row in rows:
        task=row['task']
        latest=manager.auto_config()
        if latest.get('suspended',False) or task in latest.get('disabled_parts',[]):continue
        if not requested(policy,task):continue
        if row['state']=='not_migrated':continue
        if row['state']=='blocked':
            emit('nas_recovery_project_blocked',project=row['project'],task=task,error=row['reason'])
            failures.append(task);continue
        try:
            if registry[task].get('recovery_mode')=='media-v1':manager.recover(registry[task],automatic=True)
            else:manager.recover(registry[task])
        except ERRORS as exc:
            emit('nas_recovery_project_failed',project=row['project'],task=task,error=str(exc))
            failures.append(task)
    if failures:raise RuntimeError('部分项目恢复未完成（其余项目已继续检查）：'+', '.join(failures))
