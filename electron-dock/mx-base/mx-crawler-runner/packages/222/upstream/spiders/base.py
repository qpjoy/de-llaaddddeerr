# Copyright (c) 2026 Hao Yin. All rights reserved.

"""爬虫基类"""

import logging
from abc import ABC, abstractmethod

from storage import AudioRecord

logger = logging.getLogger(__name__)


class BaseSpider(ABC):
    name: str = "base"

    def __init__(self):
        self.logger = logging.getLogger(f"spider.{self.name}")
        self.collected: list[AudioRecord] = []

    @abstractmethod
    async def crawl(self, on_batch=None) -> list[AudioRecord]:
        """执行爬取，返回发现的音频记录列表。

        on_batch: 可选回调 ``(records: list[AudioRecord]) -> None``，
        用于增量入库（例如每解析完一页就调用一次）。
        """
        ...

    def _make_record(self, url: str, title: str = "", file_format: str = "") -> AudioRecord:
        return AudioRecord(url=url, source=self.name, title=title, file_format=file_format)
