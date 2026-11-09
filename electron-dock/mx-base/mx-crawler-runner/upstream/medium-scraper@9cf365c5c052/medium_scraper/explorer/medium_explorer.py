from __future__ import annotations
"""Utilities to explore Medium tag archives via GraphQL and paginate by month."""
import time
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Dict, Any, Iterable
from urllib.parse import urljoin
import json as _json

from ..request_sender.base import RequestSender


@dataclass
class Article:
    """Lightweight article model returned by the explorer.

    - post_id: Medium internal post id
    - title: Post title
    - author: Author display name
    - date: First published date in YYYY-MM-DD
    - category: Tag slug used for the query
    - url: Canonical Medium URL
    - content: Placeholder for downstream enrichment
    """
    post_id: str
    title: str
    author: str
    date: str
    category: str
    url: str
    content: str = ""


TAG_GRAPHQL_PATH = "/_/graphql"
TAG_ARCHIVE_QUERY = """
query TagArchiveFeedQuery($tagSlug: String!, $timeRange: TagPostsTimeRange!, $sortOrder: TagPostsSortOrder!, $first: Int!, $after: String) {
  tagFromSlug(tagSlug: $tagSlug) {
    id
    sortedFeed: posts(
      timeRange: $timeRange
      sortOrder: $sortOrder
      first: $first
      after: $after
    ) {
      edges { cursor node { id title creator { name id } firstPublishedAt mediumUrl } }
      pageInfo { hasNextPage endCursor }
      __typename
    }
    __typename
  }
}
"""


class MediumExplorer:
    """Explore Medium tag archives and return structured articles.

    Uses the provided RequestSender to call Medium's GraphQL endpoint and paginates
    through a tag's monthly archive using cursors.
    """
    def __init__(self, sender: RequestSender, *, base_url: str = "https://medium.com", max_retries: int = 3, retry_backoff_sec: float = 0.75) -> None:
        """Initialize the explorer.

        - sender: Backend used to perform HTTP requests
        - base_url: Base Medium origin (default https://medium.com)
        - max_retries: Attempts per network call before giving up
        - retry_backoff_sec: Linear backoff factor (seconds) between attempts
        """
        self.sender = sender
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self.retry_backoff_sec = retry_backoff_sec

    async def _post_graphql(self, operations: Any) -> Dict[str, Any]:
        """POST a list of GraphQL operations to Medium and return the decoded JSON.

        Retries on transport errors up to max_retries with linear backoff.
        Raises the last exception if all attempts fail.
        """
        url = urljoin(self.base_url + "/", TAG_GRAPHQL_PATH.lstrip("/"))
        last_error: Optional[Exception] = None
        for attempt in range(1, self.max_retries + 1):
            try:
                resp = await self.sender.request("POST", url, json=operations)
                # Medium's graphql returns a JSON-encoded list
                
                data = _json.loads(resp.text)
                return data
            except Exception as exc:
                last_error = exc
                if attempt < self.max_retries:
                    time.sleep(self.retry_backoff_sec * attempt)
                else:
                    raise
        # Should not reach here
        raise RuntimeError(str(last_error) if last_error else "Unknown error")

    async def get_articles_by_category(self, category: str, *, year: int = 0, month: int = 0, page_size: int = 50) -> List[Article]:
        """Return all articles for a tag and month, newest-first.

        - category: Tag slug (e.g., "tryhackme")
        - year, month: Target archive window
        - page_size: Number of items per request

        Continues fetching pages until the feed has no more edges or the
        expected response structure is missing.
        """
        cursor: str = ""
        results: List[Article] = []
        while True:
            operations = [
                {
                    "operationName": "TagArchiveFeedQuery",
                    "query": TAG_ARCHIVE_QUERY,
                    "variables": {
                        "after": cursor,
                        "first": page_size,
                        "sortOrder": "NEWEST",
                        "tagSlug": category,
                        "timeRange": {
                            "inMonth": {"month": month, "year": year},
                            "kind": "IN_MONTH",
                        },
                    },
                }
            ]
            data = await self._post_graphql(operations)
            try:
                edges = data[0]["data"]["tagFromSlug"]["sortedFeed"]["edges"]
                if not edges:
                    break
                cursor = edges[-1]["cursor"] or ""
            except Exception:
                # End of page or unexpected structure
                cursor = ""
                break

            try:
                for item in edges:
                    node = item["node"]
                    results.append(
                        Article(
                            post_id=node["id"],
                            title=node.get("title", ""),
                            author=(node.get("creator") or {}).get("name", ""),
                            date=timestamp_to_date(int(node.get("firstPublishedAt", 0)) // 1000 if node.get("firstPublishedAt") else 0),
                            category=category,
                            url=node.get("mediumUrl", ""),
                            content="",
                        )
                    )
            except Exception:
                # Skip malformed items, continue pagination
                pass
        return results


def timestamp_to_date(timestamp: int) -> str:
    """Convert a unix timestamp (seconds) to YYYY-MM-DD; empty if falsy."""
    if not timestamp:
        return ""
    return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d") 