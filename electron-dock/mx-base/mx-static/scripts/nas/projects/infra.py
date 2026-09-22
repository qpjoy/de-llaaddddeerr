"""Infra-specific deployment and application permission checks; no business edits."""
import json
import os
from pathlib import Path
import re
import stat

from permissions import emit


def deployment_audit(manager, profile):
    if profile['project']!='mx_data' or profile['volume']!=manager.prep.VOLUME:
        raise RuntimeError('Deployment audit adapter is only reviewed for infra/mx_data.')
    rules={
      'recursive_media_chmod':r'find\s+/app/media.*chmod|chmod\s+[^\n]*(?:-R|--recursive)[^\n]*/app/media',
      'database_migration':r'manage\.py\s+migrate',
      'bootstrap_admin':r'manage\.py\s+bootstrap_admin',
      'task_recovery':r'recover_agent_runs_after_deploy|MX_RECOVER_STALE_AGENT_RUNS',
      'unreviewed_compose_up':r'compose\s+up',
    }
    files=[]
    for name in ('scripts/deploy_public_ghcr.sh','scripts/run_web.sh','scripts/run_worker.sh'):
        path=Path(manager.prep.DEPLOY)/name
        if path.resolve()!=path.absolute():raise RuntimeError('Deployment audit refuses symlinks: '+name)
        fd=os.open(str(path),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd) as stream:
            st=os.fstat(stream.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size>1024**2:raise RuntimeError('Unexpected deployment script.')
            lines=stream.read().splitlines()
        files.append({'file':name,'signals':[{'rule':rule,'lines':[i for i,line in enumerate(lines,1) if re.search(pattern,line)]}
                  for rule,pattern in rules.items() if any(re.search(pattern,line) for line in lines)]})
    emit('nas_infra_deployment_audit',project=profile['project'],files=files,
         note='Heuristic static review; no script is executed. Use registered same-version redeploy. No recursive NAS permission repair.')


def permissions(manager, profile, write_test=False):
    code=(Path(__file__).parent/'infra_probe.py').read_text()
    with manager.operation(profile,require_running=True) as (op,rows):
        inode=op.saved['precopy_state']['target_inode']
        for name in sorted(rows):
            if name=='gateway':continue  # Its actual reader is checked through HTTP.
            command=['docker','exec',rows[name]['Id'],'python','-c',code,'probe' if write_test else 'check',str(inode)]
            value=json.loads(op.command(command,timeout=None))
            emit('nas_application_permissions',service=name,**value)
            if not all(value.get(k) is True for k in ('effective_read','effective_write','effective_search')):
                raise RuntimeError('Application access check failed: '+name)
            if write_test and not all(value.get(k) is True for k in ('write_read_rename_passed','cleanup_passed')):
                raise RuntimeError('Application permission probe did not pass: '+name)
        op.http_probe(rows)
        emit('nas_application_permissions_complete',writers=9,gateway_existing_media_http=True,write_test=write_test,
             note='Uses docker exec default user/groups, not an operator --user override. PID 1/child privilege changes and new-media business acceptance still need review.')
