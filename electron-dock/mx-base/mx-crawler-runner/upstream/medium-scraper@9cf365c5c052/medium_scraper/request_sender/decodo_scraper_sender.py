from __future__ import annotations
"""RequestSender that proxies all requests through Decodo Scraper API.

This class posts a JSON instruction to the Decodo endpoint with the target URL,
HTTP method and optional payload, then returns the Decodo response as an
HttpResponse suitable for the rest of the pipeline.
"""
from typing import Mapping, Optional, Any, Dict
import json as _json
import base64
from curl_cffi.requests import AsyncSession

from ..models import HttpResponse
from .base import RequestSender


class DecodoScraperRequestSender(RequestSender):
    """Send HTTP requests via Decodo Scraper API (async)."""

    def __init__(
        self,
        *,
        api_key: str,
        endpoint_url: str = "https://scraper-api.decodo.com/v2/scrape",
        timeout: float = 30.0,
        advanced: bool = False,
        max_clients: int = 10,
    ) -> None:
        if not api_key:
            raise ValueError("DecodoScraperRequestSender requires a non-empty api_key.")
        if not api_key.startswith("Basic "):
            api_key = f"Basic {api_key}"
        self.api_key = api_key
        self.endpoint_url = endpoint_url
        self.timeout = timeout
        self.advanced = advanced
        self.max_clients = max_clients
        self._session: Optional[AsyncSession] = None

    async def __aenter__(self) -> "DecodoScraperRequestSender":
        self._session = AsyncSession(timeout=self.timeout, max_clients=self.max_clients)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session is not None:
            await self._session.aclose()
            self._session = None

    async def _ensure_session(self) -> AsyncSession:
        if self._session is None:
            self._session = AsyncSession(timeout=self.timeout, max_clients=self.max_clients)
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
        payload: Dict[str, Any] = {
            "url": url,
            "http_method": method.upper(),
 
        }
        if self.advanced:
            payload["headless"] = "html"
        if json is not None:
            payload["payload"] = base64.b64encode(_json.dumps(json).encode("utf-8")).decode("utf-8")
        elif data is not None:
            if isinstance(data, (bytes, bytearray)):
                payload["payload"] = data.decode("utf-8", errors="ignore")
            else:
                payload["payload"] = str(data)

        api_headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": self.api_key,
        }

        session = await self._ensure_session()
        resp = await session.post(
            self.endpoint_url,
            json=payload,
            headers=api_headers,
            timeout=timeout or self.timeout,
        )
        resp.raise_for_status()
        return HttpResponse(url=url, status_code=resp.status_code, headers=dict(resp.headers), text=resp.text) 