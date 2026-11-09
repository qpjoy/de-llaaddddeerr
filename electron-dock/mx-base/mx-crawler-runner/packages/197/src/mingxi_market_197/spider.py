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
    name = "market_vivo"
    market_name = "vivo"
    collection_name = "vivo"
    unique_index_fields = ("package_name", "version_code")

    def build_start_requests(self):
        for input_value in self.job_config.input_values:
            yield self.make_request(
                f"https://h5-api.appstore.vivo.com.cn/detail/{input_value}?frompage=messageh5",
                callback=self.parse_detail,
                input_value=input_value,
            )

    def parse_detail(self, response):
        input_value = response.meta["input_value"]
        yield from self.emit_record(response.json(), record_type="detail", input_value=input_value)
        yield from self.emit_result(input_value=input_value, success=True)


MARKET = MarketDefinition(
    name="vivo",
    description="VIVO应用商店",
    spider_cls=Spider,
    configure_parser=configure_parser,
    build_job=build_job,
)

