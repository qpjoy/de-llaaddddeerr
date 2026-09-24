"""Git project/host declarations and compatible nested CLI routing."""
import json
from pathlib import Path
import re


def read_relative(base, name):
    if not isinstance(name,str) or not name or name.startswith('/') or any(p in ('','.','..') for p in name.split('/')):
        raise RuntimeError('Unsafe catalog path.')
    path=base/name
    if path.resolve()!=path.absolute() or path.suffix!='.json':raise RuntimeError('Catalog files must be JSON without symlinks.')
    return json.loads(path.read_text())


def load(config):
    index=json.loads(config.read_text());base=config.parent
    if index.get('schema')!=1 or index.get('host')!='mx-internal-server':raise RuntimeError('Unexpected registry host/schema.')
    host=read_relative(base,index['host_policy'])
    if host.get('schema')!=1 or host.get('host')!=index['host'] or host.get('mountpoint')!='/mnt/nas' or host.get('nas_ip')!='192.168.1.3':
        raise RuntimeError('Unreviewed host policy.')
    projects={};claimed=set()
    allowed={'infra-v1':{'status','locate','logs','copy','plan','reclaim','recover','redeploy','permissions','deployment-audit'},
             'precopy-only':{'status','locate','logs','copy'},'manual-review':{'status','locate','logs'}}
    for name,filename in index['project_catalog'].items():
        p=read_relative(base,filename)
        if (not re.fullmatch('[a-z][a-z0-9-]*',name) or p.get('schema')!=1 or p.get('id')!=name or
                p.get('adapter') not in ('infra-v1','precopy-only','manual-review') or not p.get('tasks')):
            raise RuntimeError('Invalid project registration: '+name)
        if not isinstance(p.get('capabilities'),list) or set(p['capabilities'])-allowed[p['adapter']]:
            raise RuntimeError('Unreviewed adapter capability: '+name)
        if p['adapter']=='infra-v1' and (p['compose_project']!='mx_data' or p['tasks']!=['part1']):
            raise RuntimeError('The infra-v1 execution adapter is bound to the reviewed mx_data instance.')
        for task in p['tasks']:
            if task not in index['parts'] or task in claimed:raise RuntimeError('Missing/duplicate migration task: '+task)
            if p['compose_project']!=index['parts'][task]['project']:raise RuntimeError('Project/task deployment mismatch.')
            profile=index['parts'][task]
            if profile.get('recovery_mode') not in (None,'media-v1'):
                raise RuntimeError('Unknown recovery mode; refusing legacy fallback.')
            if profile.get('recovery_mode')=='media-v1' and (p['adapter']!='infra-v1' or not profile.get('runtime_file')):
                raise RuntimeError('Media recovery needs the reviewed adapter and independent storage contract.')
            claimed.add(task)
        projects[name]=p
    if claimed!=set(index['parts']):raise RuntimeError('Every task needs exactly one registered project.')
    volumes=[p['volume'] for p in index['parts'].values()]
    if len(set(volumes))!=len(volumes):raise RuntimeError('Projects cannot share a source volume implicitly.')
    return index,host,projects


def installed_files(config):
    index,host,projects=load(config)
    names={'profiles.json',index['host_policy']}
    names.update(index['project_catalog'].values())
    names.update(p['storage_file'] for p in index['parts'].values() if p.get('storage_file'))
    names.update(p['runtime_file'] for p in index['parts'].values() if p.get('runtime_file'))
    names.update(p['deployment_file'] for p in index['parts'].values() if p.get('deployment_file'))
    for name in names:read_relative(config.parent,name)
    return [config.parent/name for name in sorted(names)]


def route(argv, config):
    """Translate project/task syntax to the existing guarded commands."""
    index,host,projects=load(config)
    args=list(argv)
    if not args:return args
    if args[0] in projects:args=['project']+args
    if args[:2]==['project','list']:return ['catalog-list']+args[2:]
    if args[0]=='host':
        if len(args)!=2 or args[1] not in ('status','processes','mount-check','network'):
            raise RuntimeError('Use: nas host status|processes|mount-check|network. No force-unmount/reboot command exists.')
        return ['host-'+args[1]]
    if args[0]=='recovery':
        if args[1:]==['install']:return ['auto-install']
        if args[1:] in (['check'],['status']):return ['recovery-check-all']
        if args[1:]==['enable','--migrated']:return ['recovery-enable-migrated']
        if args[1:]==['disable']:return ['recovery-disable-all']
        if len(args)!=3 or args[2] not in projects:raise RuntimeError('Use nas recovery install or check|run|enable|disable|status <project>.')
        actions={'check':'boot-check','run':'recover','enable':'auto-enable','disable':'auto-disable','status':'status'}
        if args[1] not in actions:raise RuntimeError('Unknown recovery action.')
        p=projects[args[2]]
        if p['adapter']!='infra-v1':raise RuntimeError('Recovery adapter has not been reviewed for this project.')
        return [actions[args[1]],p['tasks'][0]]
    if args[0]!='project':return args  # Preserve old part1/part2 commands.
    if len(args)<3 or args[1] not in projects:raise RuntimeError('Use nas project list or nas project <registered-project> <action>.')
    p=projects[args[1]];tail=args[2:];task=p['tasks'][0]
    if tail[0]=='task':
        if len(tail)<3 or tail[1] not in p['tasks']:raise RuntimeError('Migration task does not belong to this project.')
        task=tail[1];action={'cleanup':'reclaim','recovery':'recover'}.get(tail[2],tail[2])
        if action not in ('status','locate','logs','copy','plan','reclaim','cutover','prepare'):raise RuntimeError('Unknown migration action.')
        if action not in p['capabilities']:raise RuntimeError('This project has no reviewed '+action+' capability.')
        return [action,task]+tail[3:]
    if tail[0]=='permissions':
        if p['adapter']!='infra-v1':raise RuntimeError('Permission adapter not reviewed for this project.')
        if tail==['permissions','check']:return ['permissions-check',task]
        if tail==['permissions','probe','--write-test']:return ['permissions-probe',task,'--write-test']
        raise RuntimeError('Use permissions check, or permissions probe --write-test.')
    if tail==['deployment','audit']:
        if 'deployment-audit' not in p['capabilities']:raise RuntimeError('Deployment adapter not reviewed.')
        return ['deployment-audit',task]
    if tail[:2] in (['deployment','check'], ['deployment','recreate']):
        if p['adapter']!='infra-v1':raise RuntimeError('Media deployment adapter only reviewed for infra.')
        return ['media-deploy-'+tail[1],task]+tail[2:]
    if tail==['storage','check']:
        if p['adapter']!='infra-v1':raise RuntimeError('Storage check adapter not reviewed for this project.')
        return ['storage-check',task]
    if tail==['storage','register']:
        if p['adapter']!='infra-v1':raise RuntimeError('Media recovery registration only reviewed for infra.')
        return ['storage-register',task]
    if tail[:2]==['cleanup','check']:
        if p['adapter']!='infra-v1':raise RuntimeError('UNION reclaim check only reviewed for infra.')
        return ['reclaim-check',task]+tail[2:]
    if tail==['repair','prepare']:
        if p['adapter']!='infra-v1':raise RuntimeError('Repair preparation only reviewed for infra.')
        return ['repair-prepare',task]
    if tail==['repair','inspect']:
        if p['adapter']!='infra-v1':raise RuntimeError('Deployment drift inspection only reviewed for infra.')
        return ['repair-inspect',task]
    if len(tail)==3 and tail[:2]==['repair','copy']:
        if p['adapter']!='infra-v1':raise RuntimeError('Repair copy only reviewed for infra.')
        return ['repair-copy',task,tail[2]]
    if len(tail)>=3 and tail[0]=='repair' and tail[1] in ('switch','resume'):
        if p['adapter']!='infra-v1':raise RuntimeError('Repair switch only reviewed for infra.')
        return ['repair-'+tail[1],task]+tail[2:]
    action={'start':'recover','recovery':'recover','cleanup':'reclaim'}.get(tail[0],tail[0])
    if action=='compose' and p['adapter']=='infra-v1':return ['compose',task]+tail[1:]
    if action not in p['capabilities']:raise RuntimeError('Unsupported project action: '+action)
    return [action,task]+tail[1:]
