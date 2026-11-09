from __future__ import annotations
"""Async RequestSender using curl_cffi.requests.AsyncSession with Chrome impersonation.

Generates realistic Chrome headers via ua_generator and supports random proxy
selection from a list per request.
"""
from typing import Mapping, Optional, Dict, Any, List, Union

import random
import ua_generator
from curl_cffi.requests import AsyncSession

from ..models import HttpResponse
from .base import RequestSender


def _build_ua_headers() -> Dict[str, str]:
    ua = ua_generator.generate(device="desktop", browser=("chrome", "edge"))
    return ua.headers.get()


def _proxy_to_mapping(p: str) -> Dict[str, str]:
    return {"http": p, "https": p}


class RequestsRequestSender(RequestSender):
    """Async RequestSender built on curl_cffi AsyncSession.

    - proxies can be a single proxy URL string or a list of proxy URL strings;
      if a list is provided, a random entry is selected per request.
    - default headers are realistic Chrome headers from ua_generator; you can
      add/override via default_headers and per-request headers.
    - Keeps an AsyncSession; supports async context manager usage.
    """

    def __init__(
        self,
        *,
        proxies: Optional[Union[str, List[str]]] = None,
        default_headers: Optional[Mapping[str, str]] = None,
        timeout: float = 30.0,
        max_clients: int = 10,
    ) -> None:
        self.proxies = proxies
        self.default_headers = dict(_build_ua_headers())
        self.default_headers.setdefault("accept-language", "en-US,en;q=0.9")
        self.default_headers.setdefault(
            "accept",
            "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        )
        self.default_headers.setdefault("referer", "https://medium.com/")
        if default_headers:
            self.default_headers.update(default_headers)
        self.timeout = timeout
        self.max_clients = max_clients
        self._session: Optional[AsyncSession] = None

    async def __aenter__(self) -> "RequestsRequestSender":
        self._session = AsyncSession(max_clients=self.max_clients, timeout=self.timeout)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session is not None:
            await self._session.aclose()
            self._session = None

    def _choose_proxies(self) -> Optional[Dict[str, str]]:
        if not self.proxies:
            return None
        p = self.proxies
        if isinstance(p, list):
            if not p:
                return None
            choice = random.choice(p)
            return _proxy_to_mapping(choice)
        # single value
        return _proxy_to_mapping(p)

    async def _ensure_session(self) -> AsyncSession:
        if self._session is None:
            self._session = AsyncSession(max_clients=self.max_clients, timeout=self.timeout)
        return self._session

    async def request(
        self,
        method: str,
        url: str,
        *,
        timeout: Optional[float] = None,
        headers: Optional[Mapping[str, str]] = None,
        json: Optional[Any] = None,
        data: Optional[Any] = None,
    ) -> HttpResponse:
        # Fresh UA headers per request for variability
        merged_headers = dict(_build_ua_headers())
        for k, v in self.default_headers.items():
            merged_headers.setdefault(k.lower(), v)
        if headers:
            for k, v in headers.items():
                merged_headers[k.lower()] = v

        proxies = self._choose_proxies()
        session = await self._ensure_session()
        resp = await session.request(
            method,
            url,
            headers=merged_headers,
            timeout=timeout or self.timeout,
            proxies=proxies,
            json=json,
            data=data,
            impersonate="chrome",
            verify=False,
        )
        resp.raise_for_status()
        return HttpResponse(url=str(resp.url), status_code=resp.status_code, headers=dict(resp.headers), text=resp.text) 