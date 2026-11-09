"""Typed JSON SDK and CLI for one independently installable audio source."""
from __future__ import annotations

import asyncio
from contextlib import ExitStack
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any

from . import providers
from .downloads import download_one, ffmpeg_info
from .runtime import Network, SourceError, Store, WriterLock, now

CONFIG = json.loads(Path(__file__).with_name('platform.json').read_text(encoding='utf-8'))
OPS = {'discover','collect','list_records','download','stats'}


def number(params: dict[str,Any], key: str, default: float, low: float, high: float, integer: bool = False) -> float:
    """Validate a bounded finite numeric configuration value."""
    value = params.get(key,default)
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high or (integer and not isinstance(value,int)):
        raise SourceError('INVALID_INPUT',f'{key} must be {"an integer" if integer else "a number"} in {low}..{high}')
    return value


def identifiers(value: Any, limit: int) -> list[str] | None:
    """Only accept stable IDs returned by this project; no arbitrary download URL."""
    if value is None:return None
    if not isinstance(value,list) or not 1<=len(value)<=limit or len(set(str(x) for x in value))!=len(value):
        raise SourceError('INVALID_INPUT','IDs must be a bounded nonempty list without duplicates')
    if any(not isinstance(x,str) or not re.fullmatch('[a-f0-9]{24}',x) for x in value):
        raise SourceError('INVALID_INPUT','Use the IDs returned by discover/list_records')
    return value


def validate(request: Any) -> tuple[str,dict[str,Any],Path]:
    """Validate operation-specific inputs before creating runtime state."""
    if not isinstance(request,dict) or set(request)-{'operation','params'} or not isinstance(request.get('operation'),str) or request['operation'] not in OPS:
        raise SourceError('INVALID_INPUT','Expected {operation,params}; see manifest.yaml')
    operation, params = request['operation'],request.get('params')
    common = {'run_dir','request_timeout','total_timeout','concurrency','request_interval'}
    fields = {
        'discover':({'podcast_ids','episode_ids','limit'} if CONFIG['source']=='xiaoyuzhou' else {'track_ids','limit'}),
        'collect':{'collection_ids','feed_limit','episodes_per_feed','refresh'} | ({'probe_range','max_track_requests'} if CONFIG['source']=='ximalaya' else set()),
        'list_records':{'limit','offset','record_ids','status'},
        'download':{'record_ids','limit','retry_failed','format','max_file_bytes','ffmpeg_path','conversion_timeout'},
        'stats':set(),
    }
    if not isinstance(params,dict) or set(params)-(common|fields[operation]):
        raise SourceError('INVALID_INPUT','Unknown operation parameter')
    try:
        if len(json.dumps(request,allow_nan=False).encode())>1024*1024:raise ValueError()
    except (ValueError,TypeError,RecursionError):
        raise SourceError('INVALID_INPUT','Request must be finite JSON no larger than 1 MiB') from None
    run_dir = params.get('run_dir')
    if not isinstance(run_dir,str) or not run_dir.strip():raise SourceError('INVALID_INPUT','run_dir is required')
    directory = Path(run_dir).expanduser().resolve()
    if directory.is_relative_to(Path(__file__).resolve().parent):
        raise SourceError('INVALID_INPUT','run_dir must be outside the installed package directory')
    number(params,'request_timeout',30,1,120)
    number(params,'total_timeout',600 if operation=='download' else 180,1,3600)
    number(params,'concurrency',2,1,4,True)
    number(params,'request_interval',2,0.5,30)
    for key in ['refresh','retry_failed']:
        if key in params and not isinstance(params[key],bool):raise SourceError('INVALID_INPUT',f'{key} must be boolean')
    if operation=='discover':
        limit = number(params,'limit',10,1,20,True)
        if 'podcast_ids' in params and 'episode_ids' in params:
            raise SourceError('INVALID_INPUT','Use podcast_ids or episode_ids, not both')
        for key in ['podcast_ids','episode_ids','track_ids']:
            if key in params:
                values = params[key]
                pattern = '[1-9][0-9]{0,14}' if key=='track_ids' else '[a-f0-9]{24}'
                if not isinstance(values,list) or not 1<=len(values)<=limit or any(not isinstance(v,str) or not re.fullmatch(pattern,v) for v in values) or len(set(values))!=len(values):
                    raise SourceError('INVALID_INPUT',f'{key} must be unique valid string IDs; length <= limit')
    elif operation=='collect':
        limit = number(params,'feed_limit',5,1,50,True)
        identifiers(params.get('collection_ids'),limit)
        number(params,'episodes_per_feed',10,1,50,True)
        if CONFIG['source']=='ximalaya':
            number(params,'probe_range',0,0,5,True)
            number(params,'max_track_requests',10,1,50,True)
    elif operation in {'list_records','download'}:
        limit = number(params,'limit',1 if operation=='download' else 20,1,100 if operation=='download' else 1000,True)
        identifiers(params.get('record_ids'),limit)
        if operation=='list_records':
            number(params,'offset',0,0,10000000,True)
            if params.get('status') not in {None,'pending','downloading','done','failed'}:raise SourceError('INVALID_INPUT','Invalid record status')
        else:
            if params.get('format','original') not in {'original','opus'}:raise SourceError('INVALID_INPUT','format must be original or opus')
            number(params,'max_file_bytes',100*1024*1024,1,2*1024**3,True)
            number(params,'conversion_timeout',120,1,600)
            if 'ffmpeg_path' in params and not isinstance(params['ffmpeg_path'],str):raise SourceError('INVALID_INPUT','ffmpeg_path must be a path string')
    return operation,params,directory


async def invoke_async(request: dict[str,Any]) -> dict[str,Any]:
    """Execute a bounded source operation; results are JSON serializable."""
    observed = now()
    operation = request.get('operation') if isinstance(request,dict) and isinstance(request.get('operation'),str) else None
    output: dict[str,Any] = {'source_id':CONFIG['source_id'],'platform':CONFIG['platform'],
        'observed_at':observed,'items':[],'errors':[],'warnings':[], 'stats':None,'pagination':None}
    status, error = 'error',None
    store = None
    try:
        operation,params,directory = validate(request)
        tool = None
        directory.mkdir(parents=True,exist_ok=True)
        # All operations serialize briefly on the same runtime, including schema
        # checks. No writer can reset another active writer's download states.
        with WriterLock(directory):
            store = Store(directory,CONFIG['source_id'])
            try:
                store.recover()
                timeout = params.get('total_timeout',600 if operation=='download' else 180)
                async with asyncio.timeout(timeout):
                    if operation=='download' and params.get('format','original')=='opus':
                        tool = await ffmpeg_info(params.get('ffmpeg_path'))
                    if operation=='stats':
                        output['stats'] = store.stats();status='success'
                    elif operation=='list_records':
                        limit,offset = params.get('limit',20),params.get('offset',0)
                        output['items'],total = store.records(limit,offset,params.get('record_ids'),params.get('status'))
                        output['pagination']={'offset':offset,'limit':limit,'total':total,
                            'next_offset':offset+len(output['items']),'has_more':offset+len(output['items'])<total}
                        status='success' if output['items'] else 'no_data'
                    else:
                        async with Network(params.get('request_timeout',30),params.get('concurrency',2)) as net:
                            if operation=='discover':
                                output['items'],output['errors'] = await providers.discover(net,CONFIG['source'],params)
                                for item in output['items']:store.add_collection(item)
                                output['warnings'].append('Discovery is bounded; collection count is not proof of complete platform coverage')
                            elif operation=='collect':
                                collections = store.collections(params.get('feed_limit',5),params.get('collection_ids'),params.get('refresh',False))
                                semaphore = asyncio.Semaphore(params.get('concurrency',2))
                                output['new_records'] = 0
                                async def collect_one(collection: dict[str,Any]) -> None:
                                    async with semaphore:
                                        try:
                                            records,errors,warnings = await providers.collect(net,CONFIG['source'],collection,params)
                                            output['warnings'].extend(warnings)
                                            output['new_records'] += store.add_records(records)
                                            output['items'].extend(records)
                                            output['errors'].extend(dict(e,collection_id=collection['id']) for e in errors)
                                            store.collection_result(collection['id'], 'PARTIAL_FEED' if errors else None)
                                        except SourceError as exc:
                                            store.collection_result(collection['id'],exc.code)
                                            output['errors'].append({'collection_id':collection['id'],'code':exc.code,'message':str(exc)})
                                async with asyncio.TaskGroup() as group:
                                    for collection in collections:group.create_task(collect_one(collection))
                            else:
                                ids = params.get('record_ids')
                                chosen,_ = store.records(params.get('limit',1),ids=ids,status=None if ids else ('failed' if params.get('retry_failed') else 'pending'))
                                if ids and len(chosen)!=len(ids):raise SourceError('NOT_FOUND','One or more record IDs do not exist')
                                semaphore=asyncio.Semaphore(params.get('concurrency',2))
                                async def fetch_one(item: dict[str,Any]) -> None:
                                    async with semaphore:
                                        try:
                                            downloaded=await download_one(net,store,item,directory,params.get('max_file_bytes',100*1024*1024),tool,params.get('conversion_timeout',120))
                                            output['items'].append(downloaded)
                                            if downloaded.get('conversion',{} ) and downloaded['conversion']['status']=='error':
                                                output['errors'].append({'id':item['id'],**downloaded['conversion']})
                                        except (SourceError,OSError) as exc:
                                            code=getattr(exc,'code','FILESYSTEM_ERROR')
                                            store.status(item['id'],'failed',error=code)
                                            output['errors'].append({'id':item['id'],'code':code,'message':str(exc) if isinstance(exc,SourceError) else 'Cannot write audio file'})
                                async with asyncio.TaskGroup() as group:
                                    for item in chosen:group.create_task(fetch_one(item))
                            status=('partial' if output['items'] else 'error') if output['errors'] else ('success' if output['items'] else 'no_data')
                    output['stats'] = store.stats()
            finally:
                store.close();store=None
    except SourceError as exc:
        error={'code':exc.code,'message':str(exc)}
        status='partial' if output['items'] else 'error'
    except TimeoutError:
        error={'code':'TOTAL_TIMEOUT','message':'Overall deadline reached; committed records and partial downloads remain in run_dir'}
        status='partial' if output['items'] else 'unknown'
    except (OSError,sqlite3.Error):
        error={'code':'RUNTIME_ERROR','message':'Runtime directory, database or external executable is unavailable'}
        status='partial' if output['items'] else 'error'
    except (ValueError,TypeError,KeyError,AttributeError,ExceptionGroup):
        error={'code':'INVALID_INPUT_OR_RESPONSE','message':'Unexpected input or upstream structure; no success claim was made'}
        status='partial' if output['items'] else 'error'
    if error is None and output['errors']:
        error={'code':'PARTIAL_FAILURE' if output['items'] else 'SOURCE_FAILED','message':'See result.errors for individual failures'}
    return {'schema_version':'1.0','project_id':CONFIG['source_id'],'source_id':CONFIG['source_id'],
            'operation':operation,'observed_at':observed,'status':status,'result':output,'error':error}


def invoke(request: dict[str,Any]) -> dict[str,Any]:
    """Synchronous entry; async callers should await invoke_async(request)."""
    return asyncio.run(invoke_async(request))


def cli() -> int:
    """Read exactly one UTF-8 JSON document and emit one JSON result to stdout."""
    try:
        raw=sys.stdin.buffer.read(1024*1024+1)
        request=json.loads(raw.decode('utf-8-sig')) if len(raw)<=1024*1024 else None
    except (ValueError,UnicodeError,RecursionError):request=None
    response=invoke(request)
    sys.stdout.buffer.write((json.dumps(response,ensure_ascii=False,allow_nan=False)+'\n').encode('utf-8'))
    return 0 if response['status'] in {'success','no_data','stopped'} else 1
