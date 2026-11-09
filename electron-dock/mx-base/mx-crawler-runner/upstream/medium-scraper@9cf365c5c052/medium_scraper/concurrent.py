from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict, List, Mapping, Optional

from .request_sender.base import RequestSender
from .parser.medium_parser import MediumMarkdownParser

ProgressCallback = Callable[[int, int, float, Dict[str, Any]], None]

async def fetch_all(
    urls: List[str],
    sender: RequestSender,
    *,
    concurrency: int = 10,
    timeout: Optional[float] = None,
    headers: Optional[Mapping[str, str]] = None,
    request_kwargs: Optional[Dict[str, Any]] = None,
    progress_callback: Optional[ProgressCallback] = None,
) -> List[Dict[str, Any]]:
    """Fetch a list of URLs concurrently using the provided sender.

    Returns a list of JSON-serializable dicts in the same order as input URLs.

    - concurrency: maximum number of in-flight requests
    - timeout, headers: passed to sender.fetch
    - request_kwargs: additional kwargs (e.g., ttl_seconds, bypass_cache) forwarded to sender
    - progress_callback: optional callback function(completed, total, percentage, stats)
    """
    sem = asyncio.Semaphore(concurrency)
    req_kwargs = request_kwargs or {}
    
    completed = 0
    total = len(urls)
    stats = {"success": 0, "failed": 0, "current_url": ""}
    
    if progress_callback:
        progress_callback(0, total, 0.0, stats.copy())

    async def _one(url: str) -> Dict[str, Any]:
        nonlocal completed, stats
        async with sem:
            if progress_callback:
                stats["current_url"] = url
            try:
                resp = await sender.fetch(url, timeout=timeout, headers=headers, **req_kwargs)
                result = {
                    "url": resp.url,
                    "ok": True,
                    "status_code": resp.status_code,
                    "headers": resp.headers,
                    "text": resp.text,
                }
                stats["success"] += 1
            except Exception as exc:
                result = {
                    "url": url,
                    "ok": False,
                    "error": str(exc),
                }
                stats["failed"] += 1
            
            completed += 1
            if progress_callback:
                percentage = (completed / total) * 100
                progress_callback(completed, total, percentage, stats.copy())
            
            return result

    tasks = [asyncio.create_task(_one(u)) for u in urls]
    return await asyncio.gather(*tasks)


async def scrape_markdown_all(
    urls: List[str],
    sender: RequestSender,
    *,
    concurrency: int = 10,
    timeout: Optional[float] = None,
    headers: Optional[Mapping[str, str]] = None,
    request_kwargs: Optional[Dict[str, Any]] = None,
    progress_callback: Optional[ProgressCallback] = None,
) -> List[Dict[str, Any]]:
    """Fetch and parse Medium articles to Markdown concurrently.

    Returns a list of JSON-serializable dicts with keys:
    - url: final URL
    - ok: bool
    - title: article title (when ok)
    - markdown: article markdown (when ok)
    - error: error message (when not ok)
    
    - progress_callback: optional callback function(completed, total, percentage, stats)
    """
    sem = asyncio.Semaphore(concurrency)
    req_kwargs = request_kwargs or {}
    
    completed = 0
    total = len(urls)
    stats = {"success": 0, "failed": 0, "parse_failed": 0, "current_url": ""}
    
    if progress_callback:
        progress_callback(0, total, 0.0, stats.copy())

    async def _one(url: str) -> Dict[str, Any]:
        nonlocal completed, stats
        async with sem:
            if progress_callback:
                stats["current_url"] = url
            try:
                resp = await sender.fetch(url, timeout=timeout, headers=headers, **req_kwargs)
                parser = MediumMarkdownParser()
                parsed = parser.parse_html(resp.text, source_url=resp.url)
                if parsed.error:
                    result = {"url": resp.url, "ok": False, "error": parsed.message or "parse failed"}
                    stats["parse_failed"] += 1
                else:
                    result = {"url": resp.url, "ok": True, "title": parsed.title, "markdown": parsed.markdown}
                    stats["success"] += 1
            except Exception as exc:
                result = {"url": url, "ok": False, "error": str(exc)}
                stats["failed"] += 1
            
            completed += 1
            if progress_callback:
                percentage = (completed / total) * 100
                progress_callback(completed, total, percentage, stats.copy())
            
            return result

    tasks = [asyncio.create_task(_one(u)) for u in urls]
    return await asyncio.gather(*tasks) 