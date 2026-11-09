from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional


@dataclass
class HttpResponse:
    url: str
    status_code: int
    headers: Dict[str, str]
    text: str


@dataclass
class ArticleParseResult:
    error: bool
    markdown: str
    title: Optional[str] = None
    message: Optional[str] = None

    @classmethod
    def success(cls, markdown: str, title: str) -> "ArticleParseResult":
        return cls(error=False, markdown=markdown, title=title)

    @classmethod
    def failure(cls, message: str) -> "ArticleParseResult":
        return cls(error=True, markdown=message, message=message) 