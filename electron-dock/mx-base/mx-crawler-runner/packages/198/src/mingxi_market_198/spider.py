# Derived from halifox/app_market_crawler; modified 2026-09-12; see UPSTREAM.md.
from __future__ import annotations

import argparse
import json

from .vendor.base import MarketSpider
from .vendor.inputs import add_package_mode_arguments, build_package_job
from .vendor.models import MarketDefinition
from .vendor.utils import find_nested_key


def configure_parser(parser: argparse.ArgumentParser) -> None:
    add_package_mode_arguments(parser)


def build_job(args):
    return build_package_job(args)


class Spider(MarketSpider):
    name = "market_yingyongbao"
    market_name = "yingyongbao"
    collection_name = "yingyongbao"
    unique_index_fields = ("pkg_name", "version_name")
    user_agent = (
        "Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36"
    )

    def build_start_requests(self):
        for input_value in self.job_config.input_values:
            yield self.make_request(
                f"https://sj.qq.com/appdetail/{input_value}",
                callback=self.parse_detail,
                input_value=input_value,
                headers={"User-Agent": self.user_agent},
            )

    def parse_detail(self, response):
        input_value = response.meta["input_value"]
        json_text = response.css("#__NEXT_DATA__::text").get()
        payload = json.loads(json_text) if json_text else {}
        item_data = find_nested_key(payload, "itemData") or []
        record = item_data[0] if item_data else {}
        yield from self.emit_record(record, record_type="detail", input_value=input_value)
        yield from self.emit_result(input_value=input_value, success=True)


MARKET = MarketDefinition(
    name="yingyongbao",
    description="应用宝",
    spider_cls=Spider,
    configure_parser=configure_parser,
    build_job=build_job,
)
