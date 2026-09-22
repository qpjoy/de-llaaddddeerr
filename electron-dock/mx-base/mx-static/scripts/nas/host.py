"""Local NFS diagnostics. Never stat a remote directory or kill an NFS process."""
import json
from pathlib import Path
import subprocess

from permissions import emit


def command(args, limit=32000):
    try:
        p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True,timeout=15)
        return {'exit':p.returncode,'stdout':p.stdout if limit is None else p.stdout[:limit]}
    except (OSError,subprocess.TimeoutExpired) as exc:return {'available':False,'error_type':type(exc).__name__}


def mounts(policy, text):
    selected=[]
    for line in text.splitlines():
        fields=line.split()
        if ' - ' not in line:continue
        left,right=line.split(' - ',1);a=left.split();b=right.split()
        if len(a)<6 or len(b)<3:continue
        if b[0] in ('nfs','nfs4','autofs') or a[4]==policy['mountpoint']:
            selected.append({'target':a[4],'type':b[0],'source':b[1],'options':a[5],
                             'expected_host_mount':a[4]==policy['mountpoint'] and b[0] in ('nfs','nfs4') and b[1] in policy['exports']})
    return selected


def processes(text):
    found=[];blocked=0
    for line in text.splitlines():
        a=line.split(None,4)
        if len(a)!=5 or not a[0].isdigit():continue
        state=a[2];name=a[3]
        if state.startswith('D'):blocked+=1
        if state.startswith('D') or any(token in name.lower() for token in ('nfs','rpc','lockd','rpciod')):
            if len(found)<80:found.append({'pid':int(a[0]),'ppid':int(a[1]),'state':state,'comm':name,'wait_channel':a[4]})
    return {'sample':found,'all_d_state_count':blocked,'limit':80,'note':'D state does not by itself prove NFS is the cause; no command lines or credentials are collected.'}


def inspect(action,policy):
    if action in ('status','mount-check'):
        rows=mounts(policy,Path('/proc/self/mountinfo').read_text())
        emit('nas_host_mounts',host=policy['host'],mounts=rows,nas_walk=False,
             host_mount_verified=any(r['expected_host_mount'] for r in rows),
             note='Kernel mount metadata only; Docker native NFS volumes are separate from the host mount.')
        emit('nas_host_units',**command(['systemctl','show']+policy['managed_units']+['--property=Id,LoadState,ActiveState,SubState,UnitFileState,Result']))
    if action in ('status','processes'):
        result=command(['ps','-eo','pid=,ppid=,stat=,comm=,wchan:32='],limit=None)
        if result.get('exit')==0:emit('nas_host_processes',**processes(result['stdout']))
        else:emit('nas_host_processes_unavailable',**result)
    if action=='network':
        emit('nas_host_route',**command(['ip','route','get',policy['nas_ip']]))
