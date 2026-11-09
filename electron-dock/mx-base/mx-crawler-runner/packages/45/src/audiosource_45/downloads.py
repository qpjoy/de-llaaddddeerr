"""Bounded AudioSpider downloads with validated resume and optional Opus conversion."""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import re
import shutil
from typing import Any

import aiofiles

from .runtime import Network, SourceError, Store, now


def file_hash(path: Path) -> str:
    """Compute SHA-256 without reading the whole audio into memory."""
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()


def _number_header(value: str | None) -> int | None:
    if value is None:return None
    if not value.isdigit():raise SourceError('DOWNLOAD_PROTOCOL','Invalid Content-Length')
    return int(value)


async def transfer(net: Network, url: str, part: Path, max_bytes: int) -> int:
    """Resume only on an exact Content-Range match; verify 416 and body length."""
    existing = part.stat().st_size if part.exists() else 0
    resume_file = part.with_suffix(part.suffix+'.resume.json')
    saved: dict[str,Any] = {}
    if resume_file.exists():
        try:saved=json.loads(resume_file.read_text(encoding='utf-8'))
        except (ValueError,OSError):saved={}
        if saved.get('url')!=url:existing=0
    if existing > max_bytes:raise SourceError('FILE_TOO_LARGE','Existing partial file exceeds byte limit')
    # Force identity encoding: byte ranges apply to the stored representation.
    headers = {'Accept-Encoding':'identity'}
    if existing:
        headers['Range'] = f'bytes={existing}-'
        if saved.get('validator'):headers['If-Range']=saved['validator']
    async with net.open(url,headers=headers) as response:
        status = response.status
        length = _number_header(response.headers.get('Content-Length'))
        content_range = response.headers.get('Content-Range','')
        if response.headers.get('Content-Encoding','identity').lower() not in {'','identity'}:
            raise SourceError('DOWNLOAD_PROTOCOL','Compressed transfer cannot be resumed safely')
        if status == 416:
            match = re.fullmatch(r'bytes \*/(\d+)',content_range)
            if existing > 0 and match and int(match[1]) == existing:
                return existing
            raise SourceError('DOWNLOAD_PROTOCOL','416 did not confirm that the local partial is complete')
        if status not in {200,206}:raise SourceError('UPSTREAM_HTTP',f'Audio HTTP {status}')
        if status == 206:
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',content_range)
            if not match or int(match[1]) != existing or int(match[2]) < existing:
                raise SourceError('DOWNLOAD_PROTOCOL','Range response does not match the local offset')
            total, end = int(match[3]), int(match[2])
            if end != total-1 or (length is not None and length != end-existing+1):
                raise SourceError('DOWNLOAD_PROTOCOL','Incomplete or inconsistent range response')
            mode, written = 'ab', existing
        else:
            total = length
            mode, written = 'wb', 0  # Server ignored Range; restart, do not append.
        if total is not None and total > max_bytes:
            raise SourceError('FILE_TOO_LARGE','Audio exceeds configured max_file_bytes')
        content_type = response.headers.get('Content-Type','').lower()
        if any(x in content_type for x in ['text/html','application/json','text/xml']):
            raise SourceError('NOT_AUDIO','Audio URL returned an HTML/JSON/XML response')
        validator = response.headers.get('ETag') or response.headers.get('Last-Modified')
        resume_file.write_text(json.dumps({'url':url,'validator':validator}),encoding='utf-8')
        async with aiofiles.open(part,mode) as stream:
            async for chunk in response.content.iter_chunked(65536):
                if written+len(chunk) > max_bytes:
                    raise SourceError('FILE_TOO_LARGE','Audio exceeded byte limit while streaming')
                await stream.write(chunk)
                written += len(chunk)
        if written == 0 or (total is not None and written != total):
            raise SourceError('INCOMPLETE_DOWNLOAD','Received bytes do not match expected length')
        return written


async def ffmpeg_info(path: str | None) -> dict[str, str]:
    """Resolve a caller-provided tool and record exact version and binary hash."""
    binary = path or shutil.which('ffmpeg')
    if not binary or not Path(binary).is_file():
        raise SourceError('DEPENDENCY_MISSING','Configure ffmpeg_path or install FFmpeg to use format=opus')
    binary = str(Path(binary).resolve())
    process = await asyncio.create_subprocess_exec(binary,'-version',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    try:
        out,_ = await asyncio.wait_for(process.communicate(),10)
    except (TimeoutError,asyncio.CancelledError):
        if process.returncode is None:process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise SourceError('DEPENDENCY_INVALID','FFmpeg version probe failed')
    return {'path':binary,'version':out.decode(errors='replace').splitlines()[0], 'sha256':await asyncio.to_thread(file_hash,Path(binary))}


async def convert(original: Path, info: dict[str, str], timeout: float) -> Path:
    """Convert to a new Opus file; preserve the original on success and failure."""
    target = original.with_name(original.stem+'.converted.opus')
    temporary = target.with_name(target.stem+'.part.opus')
    process = await asyncio.create_subprocess_exec(info['path'],'-nostdin','-y','-i',str(original),
        '-vn','-ar','24000','-ac','1','-c:a','libopus','-b:a','32k',str(temporary),
        stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
    try:
        await asyncio.wait_for(process.wait(),timeout)
        if process.returncode or not temporary.exists() or temporary.stat().st_size==0:
            raise SourceError('CONVERSION_FAILED','FFmpeg conversion failed; original audio retained')
        temporary.replace(target)
        return target
    finally:
        if process.returncode is None:
            process.kill();await process.wait()
        if temporary.exists():temporary.unlink()


async def download_one(net: Network, store: Store, item: dict[str, Any], run_dir: Path,
                       max_bytes: int, ffmpeg: dict[str,str] | None, conversion_timeout: float) -> dict[str, Any]:
    """Download one stored record and checkpoint state without discarding partial bytes."""
    directory = run_dir/'downloads';directory.mkdir(exist_ok=True)
    ext = item['file_format'] if item['file_format'] in {'mp3','m4a','aac','ogg','opus','wav','flac'} else 'audio'
    target = directory/(item['id']+'.'+ext)
    part = target.with_suffix(target.suffix+'.part')
    if item.get('file_size',0)>max_bytes:
        raise SourceError('FILE_TOO_LARGE','Enclosure size exceeds max_file_bytes')
    store.status(item['id'],'downloading')
    try:
        verified_existing = target.exists() and item.get('sha256') and await asyncio.to_thread(file_hash,target)==item['sha256']
        if verified_existing and target.stat().st_size > max_bytes:
            raise SourceError('FILE_TOO_LARGE','Existing verified file exceeds max_file_bytes')
        if not verified_existing:
            if target.exists() and not part.exists():target.replace(part)
            await transfer(net,item['url'],part,max_bytes)
            part.replace(target)
            resume_file=part.with_suffix(part.suffix+'.resume.json')
            if resume_file.exists():resume_file.unlink()
        digest = await asyncio.to_thread(file_hash,target)
        # Same content may be referenced under different URLs; reuse the verified
        # stored path while retaining existing original files (no destructive dedup).
        duplicate = store.db.execute("SELECT id,local_path FROM records WHERE sha256=? AND status='done' AND id!=? LIMIT 1",(digest,item['id'])).fetchone()
        duplicate_of = duplicate['id'] if duplicate else None
        output = {'id':item['id'],'status':'done','local_path':str(target),'bytes':target.stat().st_size,
                  'sha256':digest,'duplicate_of':duplicate_of,'conversion':None}
        store.status(item['id'],'done',path=str(target),sha=digest)
        if ffmpeg:
            try:
                converted = await convert(target,ffmpeg,conversion_timeout)
                output['conversion']={'status':'success','path':str(converted),'sha256':await asyncio.to_thread(file_hash,converted),'tool':ffmpeg}
            except (SourceError,TimeoutError) as exc:
                output['conversion']={'status':'error','code':getattr(exc,'code','CONVERSION_TIMEOUT'),'message':'Original audio retained'}
        meta = {'observed_at':now(),'record':item,'download':output}
        target.with_suffix(target.suffix+'.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
        return output
    except asyncio.CancelledError:
        store.status(item['id'],'pending',error='INTERRUPTED')
        raise
    except (SourceError,OSError) as exc:
        store.status(item['id'],'failed',error=getattr(exc,'code','FILESYSTEM_ERROR'))
        raise
