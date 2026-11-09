"""Independent app-market SDK; crawler runs in a fresh process per call."""
from __future__ import annotations
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from typing import Any
from .config import MARKET, SOURCE_ID, INPUT_KINDS, HISTORY_KINDS


def validate(inputs, input_kind, history, history_limit, concurrency, timeout, request_timeout, delay, max_requests):
    if input_kind not in INPUT_KINDS:
        raise ValueError('Unsupported input_kind for this platform')
    if not isinstance(inputs, (list, tuple)) or not 1 <= len(inputs) <= 50:
        raise ValueError('inputs must be a list/tuple with 1..50 identifiers')
    pattern = r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+' if input_kind=='package' else r'[0-9]{1,20}'
    if not all(isinstance(x,str) and re.fullmatch(pattern,x) for x in inputs):
        raise ValueError('Invalid package name or numeric identifier; URLs are not accepted')
    if type(history) is not bool or (history and input_kind not in HISTORY_KINDS):
        raise ValueError('History is unsupported for this input kind')
    for name,value,lo,hi in [('history_limit',history_limit,1,20),('concurrency',concurrency,1,5),('max_requests',max_requests,1,200)]:
        if type(value) is not int or not lo<=value<=hi:raise ValueError(f'{name} must be an integer in {lo}..{hi}')
    for name,value,lo in [('timeout',timeout,.1),('request_timeout',request_timeout,.1),('delay',delay,0)]:
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<lo:
            raise ValueError(f'{name} must be a finite number >= {lo}')


def collect(inputs: list[str], *, input_kind: str=INPUT_KINDS[0], history: bool=False,
            history_limit: int=3, concurrency: int=2, timeout: float=90,
            request_timeout: float=15, delay: float=.5, max_requests: int=50,
            work_dir: str | Path='data') -> dict[str, Any]:
    """Collect application metadata; downloads are links, never APK transfers.

    Input kinds are platform specific. History is bounded per input. Network and
    parser failures remain explicit; an empty native success is unknown.
    A unique run directory avoids collisions and preserves completed records on timeout.
    """
    validate(inputs,input_kind,history,history_limit,concurrency,timeout,request_timeout,delay,max_requests)
    directory=Path(work_dir).resolve()/('run-'+uuid.uuid4().hex)
    directory.mkdir(parents=True)
    config={'inputs':list(inputs),'input_kind':input_kind,'history':history,'history_limit':history_limit,
            'concurrency':concurrency,'timeout':timeout,'request_timeout':request_timeout,'delay':delay,
            'max_requests':max_requests,'work_dir':str(directory)}
    timed_out=False
    with (directory/'process.log').open('w',encoding='utf-8') as log:
        try:
            process=subprocess.run([sys.executable,'-m',__package__+'.worker'],input=json.dumps(config),
                stdout=log,stderr=log,text=True,encoding='utf-8',timeout=timeout,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),env={**os.environ,'PYTHONUTF8':'1'})
            returncode=process.returncode
        except subprocess.TimeoutExpired:
            timed_out=True;returncode=None
    summary_path=directory/'summary.json'
    if summary_path.exists():
        result=json.loads(summary_path.read_text(encoding='utf-8'))
    else:
        result={'source_row_id':SOURCE_ID,'provider':'halifox/app_market_crawler','platform':MARKET,
                'observed_at':datetime.now(timezone.utc).isoformat(),'status':'error','data':{'items':[],'outcomes':[]},
                'warnings':[],'error':{'code':'WORKER_FAILED','message':'No completed worker summary'}}
        records=directory/'records.jsonl'
        if records.exists():
            for line in records.read_text(encoding='utf-8').splitlines():
                try:result['data']['items'].append(json.loads(line))
                except ValueError:break
    if timed_out:
        result['status']='partial' if result['data']['items'] else 'error'
        result['error']={'code':'TIMEOUT','message':'Total timeout reached; completed records retained'}
    elif returncode and not result.get('error'):
        result['status']='partial' if result['data']['items'] else 'error'
        result['error']={'code':'WORKER_FAILED','message':'Crawler process failed; inspect process.log'}
    result['execution']={'run_dir':str(directory),'returncode':returncode,'timed_out':timed_out}
    return result
