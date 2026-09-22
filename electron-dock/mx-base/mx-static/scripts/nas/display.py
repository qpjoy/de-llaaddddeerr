#!/usr/bin/env python3
"""Human CLI view over unchanged JSON events; background jobs keep JSON logs."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import unicodedata


def clean(value):
    return ''.join(c if c=='\n' or not unicodedata.category(c).startswith('C') else '?' for c in str(value))


def cell(value):return clean(value).replace('\n',' / ')
def yes(value):return '是' if value is True else '否' if value is False else '未确认'
def size(value):return '{:.2f} GiB'.format(value/1024**3) if isinstance(value,(int,float)) else '未知'


def table(headers, rows):
    rows=[[cell(v) for v in r] for r in [headers]+rows]
    def width(s):return sum(2 if unicodedata.east_asian_width(c) in ('W','F') else 1 for c in s)
    widths=[max(width(r[i]) for r in rows) for i in range(len(headers))]
    return '\n'.join('  '.join(v+' '*(widths[i]-width(v)) for i,v in enumerate(row)).rstrip() for row in rows)


def units(text):
    rows=[]
    for chunk in text.strip().split('\n\n'):
        values=dict(l.split('=',1) for l in chunk.splitlines() if '=' in l)
        if not values:continue
        load=values.get('LoadState')
        state={'not-found':'未安装','bad-setting':'配置错误 (bad-setting)','error':'加载失败','masked':'已屏蔽'}.get(load)
        if state is None:state=values.get('ActiveState','?')+'/'+values.get('SubState','?')
        rows.append([values.get('Id','?'),state,values.get('UnitFileState') or '—'])
    return table(['系统服务','状态','开机设置'],rows)


def render(value):
    event=value.get('event')
    if event=='nas_projects':
        rows=[]
        for name,p in value['projects'].items():
            tasks=p['tasks'];declared=p.get('data_policy',{}).get('nas_authoritative')
            rows.append([name,p['compose_project'],','.join(tasks),'NAS（登记）' if declared else '待迁移',
                         '已提供' if 'recover' in p['capabilities'] else '尚未审核'])
        return 'NAS 项目登记 · '+value['host']+'\n'+table(['项目','Compose 项目','任务','存储声明','恢复适配'],rows)+'\n登记不是现场检查；统一核对：bash scripts/manage.sh nas recovery check'
    if event=='nas_locations':
        fields=[('git_registry','Git 登记'),('git_storage','NAS 挂载声明'),('runtime_override','运行时 Compose 覆盖'),
                ('report','迁移报告'),('reclaim_plan','清理清单'),('ssd','旧 SSD 目录'),('nas','NAS 目录'),
                ('docker_nfs_volume','Docker NFS 卷'),('auto_config','恢复设置'),('installed_runtime','安装快照')]
        return '任务路径 · '+value['part']+'\n'+'\n'.join('  {}：{}'.format(label,cell(value.get(key) or '未登记')) for key,label in fields)
    if event=='nas_status':
        rows=[]
        for c in value['containers']:
            mounts=c['raw_media_mounts']
            rows.append([c['service'],c['status'],c['health'] or '未配置健康检查',
                         ', '.join((m.get('Name') or m['Type'])+(' [读写]' if m.get('RW') else ' [只读]') for m in mounts) or '无 raw-media 子挂载'])
        cfg=value['auto']
        return ('业务状态 · '+value['part']+'\n'+table(['服务','状态','健康检查','媒体挂载'],rows)+
                '\n/data 可用：'+size(value['data_available_bytes'])+'\n恢复策略：'+('已迁移项目统一管理' if cfg.get('mode')=='migrated' else '逐项目登记')+
                '；全局暂停：'+yes(cfg.get('suspended',False))+'；显式列表：'+(', '.join(cfg['enabled_parts']) or '无')+
                '\n'+units(value['systemd']['units']))
    if event=='nas_migration_state':
        phase={'running_on_nas':'已切换到 NAS'}.get(value['phase'],value['phase'])
        reclaim=value.get('ssd_reclaim')
        detail=json.dumps(reclaim,ensure_ascii=False,indent=2) if reclaim else '尚无完成记录'
        return '迁移：{}；业务验收待完成：{}\nSSD 回收：{}'.format(phase,yes(value.get('business_acceptance_pending')),detail)
    if event=='nas_host_mounts':
        rows=['  {} [{}]\n    来源：{}\n    选项：{}'.format(cell(r['target']),cell(r['type']),cell(r['source']),cell(r['options'])) for r in value['mounts']]
        return '宿主机 NAS 挂载核对：'+('匹配' if value['host_mount_verified'] else '未匹配，请检查')+'\n'+'\n'.join(rows)+'\n仅检查本机挂载表，不代表 NAS 磁盘/存储池健康。'
    if event=='nas_host_units':return units(value.get('stdout',''))+'\n查询退出码：'+str(value.get('exit','不可用'))
    if event=='nas_host_processes':
        return 'NFS/RPC 与阻塞进程 · D 状态总数：{}\n{}'.format(value['all_d_state_count'],table(
            ['PID','父 PID','状态','进程','等待位置'],[[r['pid'],r['ppid'],r['state'],r['comm'],r['wait_channel']] for r in value['sample']]))+'\nD 状态本身不能证明 NFS 故障；最多显示 '+str(value['limit'])+' 项。'
    if event=='nas_infra_deployment_audit':
        labels={'recursive_media_chmod':'递归修改媒体权限','database_migration':'数据库迁移','bootstrap_admin':'初始化管理员','task_recovery':'任务恢复','unreviewed_compose_up':'直接 Compose 启动'}
        rows=[[f['file'],labels.get(s['rule'],s['rule']),','.join(map(str,s['lines']))] for f in value['files'] for s in f['signals']]
        return 'infra 发布脚本静态检查\n'+(table(['文件','匹配行为','行号'],rows) if rows else '未匹配已知规则。')+'\n只读规则检查，未执行发布；未匹配不代表脚本无副作用。'
    if event=='nas_application_permissions':
        d=value['directory']
        return ('应用权限 · {}\n  进程 UID:GID={}:{}，补充组={}\n  目录 UID:GID={}:{}，mode={}\n  可读={} 可写={} 可进入={}\n  写入测试={} 自身清理={}').format(
            value['service'],value['uid'],value['gid'],value['groups'],d['uid'],d['gid'],d['mode'],yes(value['effective_read']),yes(value['effective_write']),yes(value['effective_search']),
            yes(value.get('write_read_rename_passed')) if value['write_test'] else '未执行',yes(value.get('cleanup_passed')) if value['write_test'] else '无需清理')
    if event=='nas_recovery_inventory_start':return value['note']
    if event=='nas_recovery_inventory':
        labels={'eligible':'已核对','not_migrated':'未迁移','blocked':'需处理'}
        rows=[[r['project'],r['task'],labels[r['state']],r['coverage'],r['reason']] for r in value['tasks']]
        return ('NAS 恢复统一检查\n策略：'+('已迁移项目统一管理' if value['policy'].get('mode')=='migrated' else '逐项目登记')+
                '；全局暂停：'+yes(value['policy'].get('suspended',False))+'\n'+table(['项目','任务','迁移/配置核对','恢复覆盖','说明'],rows)+
                '\n安装快照与当前代码/声明一致：'+yes(value['installed_current'])+'\n'+units(value['systemd']['units'])+
                '\n检查不启动容器，也不遍历 NAS。覆盖表示策略已选择；开机生效还需要安装并启用 timer。')
    if event=='nas_auto_installed':
        return '持久恢复工具已安装/更新\n  代码快照：'+value['runtime']+'\n保留已有启用设置；安装本身不启用 timer、不启动业务容器。'
    if event=='nas_recovery_policy':return value['note']+'\n'+json.dumps({k:v for k,v in value.items() if k not in ('event','note')},ensure_ascii=False,indent=2)
    if event=='nas_auto_policy':
        return '项目恢复设置已保存\n  策略：{}\n  全局暂停：{}\n  显式启用：{}\n  项目暂停：{}'.format(value.get('mode','explicit'),yes(value.get('suspended',False)),','.join(value['enabled_parts']) or '无',','.join(value.get('disabled_parts',[])) or '无')
    if event=='nas_recovery_result':return '本轮补启动：'+(', '.join(value['started']) or '无需补启动，已登记容器正常')+'\n未重建、复制或删除数据。'
    if event in ('nas_recovery_project_failed','nas_recovery_project_blocked'):
        return '恢复需处理 · {} / {}\n  {}'.format(value['project'],value['task'],value['error'])
    if event=='nas_job_started':
        return '后台任务已提交 · {} / {}\n  服务：{}\n  查看：{}\n提交不代表执行完成；主机重启后不会自动续跑迁移/删除。'.format(value['part'],value['action'],value['unit'],value['logs'])
    if event=='nas_manager_failed':return '操作失败 · {}\n  {}\n未自动回滚；重试前查看该任务日志。'.format(value['action'],value['error'])
    # Preserve unfamiliar/new fields instead of silently dropping them.
    return json.dumps(value,ensure_ascii=False,indent=2)


def format_line(line, mode='human', compact=False):
    try:value=json.loads(line)
    except ValueError:return clean(line.rstrip('\n'))
    if mode=='pretty' or not isinstance(value,dict):return clean(json.dumps(value,ensure_ascii=False,indent=2))
    if compact and value.get('event')=='nas_locations':return '任务 '+cell(value['part'])+' · 完整路径查看：bash scripts/manage.sh nas locate '+cell(value['part'])
    try:return clean(render(value))
    except (KeyError,TypeError,ValueError):return clean(json.dumps(value,ensure_ascii=False,indent=2))


def main():
    flags=[a for a in sys.argv[1:] if a in ('--json','--pretty','--human')]
    if len(flags)>1:
        print('只选择一种输出格式：--human、--json 或 --pretty',file=sys.stderr);return 2
    mode=flags[0][2:] if flags else 'human'
    args=[a for a in sys.argv[1:] if a not in flags]
    command=[sys.executable,'-u','-B',str(Path(__file__).with_name('manage.py'))]+args
    if mode=='json':os.execv(sys.executable,command)
    env=dict(os.environ,PYTHONIOENCODING='utf-8')
    child=subprocess.Popen(command,stdout=subprocess.PIPE,universal_newlines=True,encoding='utf-8',env=env)
    try:
        for line in child.stdout:print(format_line(line,mode,compact='status' in args),flush=True)
        code=child.wait();return code if code>=0 else 128-code
    except KeyboardInterrupt:
        if child.poll() is None:child.send_signal(signal.SIGINT)
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:pass
        return 130
    except BrokenPipeError:
        # No forced termination of a manager operation due to a closed display pipe.
        child.stdout.close()
        return 1


if __name__=='__main__':sys.exit(main())
