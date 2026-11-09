# Derived from halifox/app_market_crawler; modified 2026-09-12; see UPSTREAM.md.
from __future__ import annotations

import argparse

from .vendor.base import MarketSpider
from .vendor.inputs import add_id_mode_arguments, build_id_job
from .vendor.models import MarketDefinition


def configure_parser(parser: argparse.ArgumentParser) -> None:
    add_id_mode_arguments(parser)


def build_job(args):
    return build_id_job(args)


class Spider(MarketSpider):
    name = "market_xiaomi"
    market_name = "xiaomi"
    collection_name = "xiaomi"
    unique_index_fields = ("appMap.packageName", "vcode")

    def build_start_requests(self):
        for input_value in self.job_config.input_values:
            yield self.make_request(
                f"https://m.app.mi.com/detailapi/{input_value}",
                callback=self.parse_detail,
                input_value=input_value,
            )

    def parse_detail(self, response):
        input_value = response.meta["input_value"]
        payload = response.json()
        app_map = payload.get("appMap", {})
        app_map_id = app_map.get("id")
        if app_map_id is not None:
            payload["id"] = app_map_id
            payload["vcode"] = app_map.get("vcode")
            payload["download"] = f"https://m.app.mi.com/download/{app_map_id}"
        yield from self.emit_record(payload, record_type="detail", input_value=input_value)
        yield from self.emit_result(input_value=input_value, success=True)


MARKET = MarketDefinition(
    name="xiaomi",
    description="小米应用商店",
    spider_cls=Spider,
    configure_parser=configure_parser,
    build_job=build_job,
)

