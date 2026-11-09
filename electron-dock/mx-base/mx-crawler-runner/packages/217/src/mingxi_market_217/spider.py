# Derived from halifox/app_market_crawler; modified 2026-09-12; see UPSTREAM.md.
from __future__ import annotations

import argparse
import json
import re

from .vendor.base import MarketSpider
from .vendor.inputs import add_package_mode_arguments, build_package_job
from .vendor.models import MarketDefinition


def configure_parser(parser: argparse.ArgumentParser) -> None:
    add_package_mode_arguments(parser)


def build_job(args):
    return build_package_job(args)


class Spider(MarketSpider):
    name = "market_lenovo"
    market_name = "lenovo"
    collection_name = "lenovo"
    unique_index_fields = ("packageName", "versioncode")

    def build_start_requests(self):
        for input_value in self.job_config.input_values:
            yield self.make_request(
                f"https://www.lenovomm.com/appdetail/{input_value}/0",
                callback=self.parse_detail,
                input_value=input_value,
            )

    def parse_detail(self, response):
        input_value = response.meta["input_value"]
        payload = {}
        scripts = response.xpath("//script/text()").getall()
        for script in scripts:
            match = re.search(r"__NEXT_DATA__\s*=\s*(\{.*?\})\s*;", script, re.DOTALL)
            if match:
                payload = json.loads(match.group(1))["props"]["pageProps"]["appInfo"]
                break
        yield from self.emit_record(payload, record_type="detail", input_value=input_value)
        yield from self.emit_result(input_value=input_value, success=True)


MARKET = MarketDefinition(
    name="lenovo",
    description="联想应用商店",
    spider_cls=Spider,
    configure_parser=configure_parser,
    build_job=build_job,
)

