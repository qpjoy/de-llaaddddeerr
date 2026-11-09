from __future__ import annotations

import hashlib
import json
from typing import Mapping, Optional, Any

from ..models import HttpResponse
from .base import RequestSender
from .cache_backend import SQLiteCacheBackend, default_cache_path


def _stable_key(method: str, url: str, headers: Optional[Mapping[str, str]], json_body: Optional[Any], data_body: Optional[Any]) -> str:
    base = {
        "method": method.upper(),
        "url": url,
        # do not include volatile headers; only key on method+url+body
        "json": json_body,
        "data": data_body.decode("utf-8", errors="ignore") if isinstance(data_body, (bytes, bytearray)) else data_body,
    }
    raw = json.dumps(base, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CachedRequestSender(RequestSender):
    """A RequestSender that adds persistent caching on top of another sender (async)."""

    def __init__(self, inner: RequestSender, *, db_path: Optional[str] = None, default_ttl_seconds: Optional[float] = None) -> None:
        self.inner = inner
        self.cache = SQLiteCacheBackend(db_path or default_cache_path())
        self.default_ttl_seconds = default_ttl_seconds

    async def request(
        self,
        method: str,
        url: str,
        *,
        timeout: Optional[float] = None,
        headers: Optional[Mapping[str, str]] = None,
        json: Optional[Any] = None,
        data: Optional[Any] = None,
        ttl_seconds: Optional[float] = None,
        bypass_cache: bool = False,
    ) -> HttpResponse:
        cache_key = _stable_key(method, url, headers, json, data)
        if not bypass_cache:
            cached = self.cache.get(cache_key)
            if cached is not None:
                return cached
        resp = await self.inner.request(method, url, timeout=timeout, headers=headers, json=json, data=data)
        try:
            if resp.status_code == 200:
                self.cache.set(cache_key, resp, ttl_seconds=ttl_seconds if ttl_seconds is not None else self.default_ttl_seconds)
        except Exception:
            pass
        return resp 