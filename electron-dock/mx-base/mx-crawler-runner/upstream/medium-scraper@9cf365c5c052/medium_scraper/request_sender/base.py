from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Mapping, Optional, Any
from urllib.parse import urlparse

from ..models import HttpResponse


class RequestSender(ABC):
    @abstractmethod
    async def request(
        self,
        method: str,
        url: str,
        *,
        timeout: Optional[float] = None,
        headers: Optional[Mapping[str, str]] = None,
        json: Optional[Any] = None,
        data: Optional[Any] = None,
        **kwargs: Any,
    ) -> HttpResponse:
        """Perform an HTTP request and return an HttpResponse.

        Implementations can use direct requests, proxies, headless browsers, etc.
        """
        raise NotImplementedError

    async def is_safe_url(self, url: str) -> bool:
        """Check if the url is safe to scrape.
    
        Conditions:
        - All the urls should be starting with https://
        - All the urls should be ending with medium.com (or any other domain that is safe to scrape)
        """
        # prevent SSRF attacks
        parsed_url = urlparse(url)
        return parsed_url.scheme == "https" and parsed_url.netloc.endswith("medium.com")


    async def fetch(
        self,
        url: str,
        *,
        timeout: Optional[float] = None,
        headers: Optional[Mapping[str, str]] = None,
        **kwargs: Any,
    ) -> HttpResponse:
        return await self.request("GET", url, timeout=timeout, headers=headers, **kwargs)