# Derived from halifox/app_market_crawler; local import paths adjusted 2026-09-12.
from __future__ import annotations

from typing import Iterable

import scrapy

from .items import AppRecordItem, CrawlResultItem


class MarketSpider(scrapy.Spider):
    market_name = ""
    collection_name = ""
    unique_index_fields: tuple[str, ...] = ()
    supports_history = False

    def __init__(self, job_config, run_options, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.job_config = job_config
        self.run_options = run_options
        self._reported_inputs: set[str] = set()

    def start_requests(self):
        yield from self.build_start_requests()

    def build_start_requests(self) -> Iterable[scrapy.Request]:
        raise NotImplementedError

    def make_request(
        self,
        url: str,
        *,
        callback,
        input_value: str,
        request_kind: str = "detail",
        method: str = "GET",
        headers: dict | None = None,
        body: str | bytes | None = None,
        formdata: dict | None = None,
        meta: dict | None = None,
        priority: int = 0,
    ) -> scrapy.Request:
        request_meta = dict(meta or {})
        request_meta.update({"input_value": str(input_value), "request_kind": request_kind})
        request_cls = scrapy.FormRequest if formdata is not None else scrapy.Request
        kwargs = {
            "url": url,
            "callback": callback,
            "errback": self.errback,
            "headers": headers,
            "meta": request_meta,
            "priority": priority,
            "dont_filter": True,
        }
        if formdata is not None:
            kwargs["formdata"] = formdata
            return request_cls(**kwargs)
        kwargs["method"] = method
        if body is not None:
            kwargs["body"] = body
        return request_cls(**kwargs)

    def emit_record(self, payload, *, record_type: str, input_value: str):
        if isinstance(payload, list):
            for item in payload:
                yield from self.emit_record(item, record_type=record_type, input_value=input_value)
            return
        if not isinstance(payload, dict):
            return
        enriched_payload = dict(payload)
        enriched_payload.setdefault("_meta", {})
        enriched_payload["_meta"].update(
            {
                "market": self.market_name,
                "mode": self.job_config.mode,
                "input_value": str(input_value),
                "record_type": record_type,
            }
        )
        yield AppRecordItem(
            collection=self.collection_name,
            unique_fields=tuple(self.unique_index_fields),
            payload=enriched_payload,
        )

    def emit_result(self, *, input_value: str, success: bool, error: str | None = None):
        key = str(input_value)
        if success and key in self._reported_inputs:
            return
        if success:
            self._reported_inputs.add(key)
        yield CrawlResultItem(
            market=self.market_name,
            mode=self.job_config.mode,
            input_value=key,
            success=1 if success else 0,
            error=error,
        )

    def errback(self, failure):
        input_value = failure.request.meta.get("input_value", "")
        request_kind = failure.request.meta.get("request_kind", "detail")
        error = f"{request_kind}: {failure.value}"
        yield from self.emit_result(input_value=str(input_value), success=False, error=error)

