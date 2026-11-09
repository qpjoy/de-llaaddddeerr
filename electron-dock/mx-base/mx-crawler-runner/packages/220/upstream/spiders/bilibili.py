# Copyright (c) 2026 Hao Yin. All rights reserved.

"""B站爬虫 — 提取视频中的音频流（有声书、评书、相声、演讲等）

策略：
1. 搜索 API 按关键词翻页找语音类长视频（max_search_pages）
2. 搜到一页后立刻解析该页视频的分P音频流（边搜边解析）
3. 每个视频解析完立刻通过 on_batch 增量入库（合集分P多时更安全）
4. 解析当前页时预取下一页搜索结果（asyncio 流水线，共用限速器）

注意：B站音频流 URL 有时效性，需要带 Referer 下载。
"""

import asyncio
import re
from collections.abc import Callable

import aiohttp

from anti_crawler import random_delay, RateLimiter
from config import SPIDER_CONFIGS
from spiders.base import BaseSpider
from storage import AudioRecord

# 默认关键词兜底；实际以 config.py → bilibili.search_keywords 为准
SEARCH_KEYWORDS = [
    "有声书 合集", "有声书 全集", "听书 合集",
    "评书 单田芳", "评书 袁阔成", "评书 田连元",
    "相声 郭德纲", "相声 德云社", "相声 合集",
    "演讲 TED 中文", "脱口秀 合集",
    "广播剧 全集", "朗读 名著", "百家讲坛",
]

BILIBILI_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://www.bilibili.com",
}

SEARCH_URL = "https://api.bilibili.com/x/web-interface/search/all/v2"
PAGELIST_URL = "https://api.bilibili.com/x/player/pagelist"
PLAYURL_URL = "https://api.bilibili.com/x/player/playurl"


class BilibiliSpider(BaseSpider):
    name = "bilibili"

    def __init__(self):
        super().__init__()
        cfg = SPIDER_CONFIGS.get(self.name, {})
        self.keywords = cfg.get("search_keywords", SEARCH_KEYWORDS)
        self.max_videos_per_keyword = cfg.get("max_videos_per_keyword", 10)
        self.max_pages_per_video = cfg.get("max_pages_per_video", 20)
        # 搜索结果翻页数：每页约 20 个视频，翻页越多每个关键词覆盖越广
        self.max_search_pages = cfg.get("max_search_pages", 1)
        self.limiter = RateLimiter(rate=0.5, burst=3)

    async def crawl(self, on_batch: Callable[[list[AudioRecord]], None] | None = None) -> list[AudioRecord]:
        """边搜索边解析；解析完一页后立刻 on_batch 入库；同时预取下一页搜索。"""
        self.logger.info(
            f"开始爬取B站, 关键词: {len(self.keywords)} 个"
            f"（最多翻 {self.max_search_pages} 页/词，解析前 {self.max_videos_per_keyword} 个/词）"
        )
        records: list[AudioRecord] = []
        seen_urls: set[str] = set()
        seen_bvids: set[str] = set()

        async with aiohttp.ClientSession(headers=BILIBILI_HEADERS) as session:
            # 先访问首页获取 cookie
            await session.get("https://www.bilibili.com", timeout=aiohttp.ClientTimeout(total=10))

            for keyword in self.keywords:
                parsed_for_keyword = 0
                keyword_records = 0
                prefetch: asyncio.Task | None = None

                try:
                    for page in range(1, self.max_search_pages + 1):
                        if parsed_for_keyword >= self.max_videos_per_keyword:
                            break

                        if prefetch is not None:
                            videos = await prefetch
                            prefetch = None
                        else:
                            videos = await self._search_page(session, keyword, page)

                        if not videos:
                            self.logger.info(f"搜索 \"{keyword}\" 第 {page} 页无结果，停止翻页")
                            break

                        # 过滤跨页/跨关键词已见过的 bvid
                        fresh = []
                        for bvid, title, duration_str in videos:
                            if bvid in seen_bvids:
                                continue
                            seen_bvids.add(bvid)
                            fresh.append((bvid, title, duration_str))

                        remain = self.max_videos_per_keyword - parsed_for_keyword
                        fresh = fresh[:remain]
                        self.logger.info(
                            f"搜索 \"{keyword}\" 第 {page} 页: "
                            f"{len(videos)} 个结果, 新视频 {len(fresh)} 个，开始解析"
                        )

                        # 解析当前页时预取下一页搜索（与解析重叠，共用限速器）
                        if (
                            fresh
                            and page < self.max_search_pages
                            and parsed_for_keyword + len(fresh) < self.max_videos_per_keyword
                        ):
                            prefetch = asyncio.create_task(
                                self._search_page(session, keyword, page + 1)
                            )

                        if not fresh:
                            await random_delay(1.0, 2.0)
                            continue

                        for idx, (bvid, title, duration_str) in enumerate(fresh, 1):
                            self.logger.info(
                                f"解析视频 [{idx}/{len(fresh)}] {bvid} "
                                f"{title[:40]}..."
                            )
                            await self.limiter.acquire()
                            page_records = await self._extract_audio(
                                session, bvid, title, keyword
                            )
                            video_batch: list[AudioRecord] = []
                            for r in page_records:
                                if r.url not in seen_urls:
                                    seen_urls.add(r.url)
                                    records.append(r)
                                    video_batch.append(r)
                                    keyword_records += 1
                            parsed_for_keyword += 1

                            # 每个视频解析完立刻入库（合集分P多，不能等搜完整页）
                            if video_batch and on_batch is not None:
                                try:
                                    on_batch(video_batch)
                                    self.logger.info(
                                        f"视频 {bvid} 已入库 {len(video_batch)} 条 "
                                        f"（累计发现 {len(records)}）"
                                    )
                                except Exception as e:
                                    self.logger.error(
                                        f"增量入库失败 {bvid}: {e}",
                                        exc_info=True,
                                    )
                            else:
                                self.logger.info(
                                    f"视频 {bvid} 解析完成: {len(page_records)} 条"
                                    f"（无新增可入库）"
                                )
                            await random_delay(1.0, 2.0)

                        await random_delay(1.0, 2.0)
                finally:
                    if prefetch is not None and not prefetch.done():
                        prefetch.cancel()
                        try:
                            await prefetch
                        except asyncio.CancelledError:
                            pass

                self.logger.info(
                    f"关键词 \"{keyword}\" 完成: 解析 {parsed_for_keyword} 个视频, "
                    f"发现 {keyword_records} 个音频"
                )
                await random_delay(2.0, 4.0)

        self.logger.info(f"B站 共发现 {len(records)} 个音频")
        return records

    async def _search_page(self, session: aiohttp.ClientSession,
                           keyword: str, page: int) -> list[tuple[str, str, str]]:
        """搜索单页视频，返回 [(bvid, title, duration), ...]"""
        results = []
        try:
            await self.limiter.acquire()
            params = {"keyword": keyword, "page": page, "duration": 4}
            async with session.get(SEARCH_URL, params=params,
                                   timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json(content_type=None)
                for rt in data.get("data", {}).get("result", []):
                    if rt.get("result_type") != "video":
                        continue
                    for v in rt.get("data", []):
                        bvid = v.get("bvid", "")
                        if not bvid:
                            continue
                        title = re.sub(r"<[^>]+>", "", v.get("title", ""))
                        duration = v.get("duration", "")
                        results.append((bvid, title, str(duration)))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.logger.warning(f"B站搜索失败 \"{keyword}\" 第 {page} 页: {e}")
        return results

    async def _extract_audio(self, session: aiohttp.ClientSession,
                              bvid: str, video_title: str,
                              keyword: str) -> list[AudioRecord]:
        """从视频的每个分P提取音频流"""
        records = []
        try:
            async with session.get(PAGELIST_URL, params={"bvid": bvid},
                                   timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json(content_type=None)
                pages = data.get("data", [])

            total_parts = min(len(pages), self.max_pages_per_video)
            if total_parts >= 50:
                self.logger.info(
                    f"{bvid} 共 {len(pages)} 个分P，将解析前 {total_parts} 个"
                    f"（约需 {total_parts * 2.5 / 60:.0f} 分钟，限速中请耐心等待）"
                )

            for i, page in enumerate(pages[:self.max_pages_per_video], 1):
                cid = page.get("cid")
                part_title = page.get("part", "")
                page_num = page.get("page", 1)
                duration = page.get("duration", 0)

                if not cid:
                    continue

                await self.limiter.acquire()
                audio_url = await self._get_audio_url(session, bvid, cid)
                if not audio_url:
                    continue

                title = f"{video_title} P{page_num}" if not part_title else part_title
                category = self._guess_category(keyword)

                record = self._make_record(url=audio_url, title=title, file_format="m4a")
                record.duration = duration
                record.category = category
                record.language = "zh"
                record.speaker = video_title[:30]
                record.source_id = f"{bvid}_p{page_num}"
                records.append(record)

                # 大合集每隔 20P 打一次进度，避免看起来像卡住
                if total_parts >= 50 and (i % 20 == 0 or i == total_parts):
                    self.logger.info(
                        f"{bvid} 分P进度 {i}/{total_parts}，已取到 {len(records)} 条音频"
                    )

                await random_delay(0.5, 1.0)

        except Exception as e:
            self.logger.warning(f"B站视频解析失败 {bvid}: {e}")
        return records

    async def _get_audio_url(self, session: aiohttp.ClientSession,
                              bvid: str, cid: int) -> str:
        """获取单个分P的最高品质音频流 URL"""
        try:
            params = {"bvid": bvid, "cid": cid, "fnval": 16}
            async with session.get(PLAYURL_URL, params=params,
                                   timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return ""
                data = await resp.json(content_type=None)
                audios = data.get("data", {}).get("dash", {}).get("audio", [])
                if not audios:
                    return ""
                best = max(audios, key=lambda a: a.get("bandwidth", 0))
                return best.get("baseUrl", "") or best.get("base_url", "")
        except Exception as e:
            self.logger.debug(f"获取音频流失败 {bvid} cid={cid}: {e}")
            return ""

    @staticmethod
    def _guess_category(keyword: str) -> str:
        if "有声书" in keyword:
            return "有声书"
        if "评书" in keyword:
            return "评书"
        if "相声" in keyword:
            return "相声"
        if "演讲" in keyword or "TED" in keyword:
            return "演讲"
        if "脱口秀" in keyword:
            return "脱口秀"
        if "广播剧" in keyword:
            return "广播剧"
        if "朗读" in keyword:
            return "朗读"
        return "播客"
