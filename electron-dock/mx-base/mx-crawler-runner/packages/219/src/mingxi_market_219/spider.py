# Derived from halifox/app_market_crawler; modified 2026-09-12; see UPSTREAM.md.
from __future__ import annotations

import argparse
import re

from .vendor.base import MarketSpider
from .vendor.inputs import add_id_mode_arguments, build_id_job
from .vendor.models import MarketDefinition


def configure_parser(parser: argparse.ArgumentParser) -> None:
    add_id_mode_arguments(parser)


def build_job(args):
    return build_id_job(args)


class Spider(MarketSpider):
    name = "market_wandoujia"
    market_name = "wandoujia"
    collection_name = "wandoujia"
    unique_index_fields = ("data_pn", "version")
    supports_history = True

    def build_start_requests(self):
        for input_value in self.job_config.input_values:
            yield self.make_request(
                f"https://www.wandoujia.com/apps/{input_value}",
                callback=self.parse_detail,
                input_value=input_value,
            )
            if self.run_options.history:
                yield self.make_request(
                    f"https://www.wandoujia.com/apps/{input_value}/history",
                    callback=self.parse_history_index,
                    input_value=input_value,
                    request_kind="history",
                )

    def parse_history_index(self, response):
        input_value = response.meta["input_value"]
        pattern = rf"https://www\.wandoujia\.com/apps/{re.escape(str(input_value))}/history_v\d+"
        urls = response.xpath('//a[@href]/@href').re(pattern)
        for url in urls:
            yield self.make_request(
                url,
                callback=self.parse_history_detail,
                input_value=input_value,
                request_kind="history",
                priority=100,
            )

    def parse_detail(self, response):
        input_value = response.meta["input_value"]
        yield from self.emit_record(self.extract_payload(response), record_type="detail", input_value=input_value)
        yield from self.emit_result(input_value=input_value, success=True)

    def parse_history_detail(self, response):
        input_value = response.meta["input_value"]
        yield from self.emit_record(self.extract_payload(response), record_type="history", input_value=input_value)

    @staticmethod
    def extract_payload(response):
        body = response.xpath("//body")
        return {
            "data_pn": body.xpath("@data-pn").get(),
            "app_id": body.xpath("@data-app-id").get(),
            "apk_id": body.xpath("@data-app-vid").get(),
            "name": response.xpath("//p[@class='app-name']/span[@class='title']/text()").get(),
            "version": response.css("[data-app-vname]::attr(data-app-vname)").get(),
            "versionCode": response.css("[data-app-vcode]::attr(data-app-vcode)").get(),
            "updateTime": response.xpath("normalize-space(//dt[contains(., '更新')]/following-sibling::dd[1])").get(),
            "iconUrl": response.xpath("//div[@class='app-icon']/img/@src").get(),
            "downloads": response.xpath("//a[contains(@class, 'normal-dl-btn')]/@data-href").get(),
            "screenshots": response.xpath("//img[@class='screenshot-img']/@src").getall(),
            "updateNotes": (response.xpath("string(//div[@itemprop='description']/div[2])").get() or "").strip(),
            "introduction": (response.xpath("string(//div[@itemprop='description']/div[1])").get() or "").strip(),
            "size": response.xpath("//meta[@itemprop='fileSize']/@content").get(),
            "categories": response.xpath("//dd[@class='tag-box']/a/text()").getall(),
            "osRequirement": response.xpath("normalize-space(//dd[@itemprop='operatingSystems']/text()[1])").get(),
            "developer": response.xpath("//span[@class='dev-sites' and @itemprop='name']/text()").get(),
            "privacyPolicyUrl": response.xpath("//a[@class='privacy-link']/@href").get(),
        }


MARKET = MarketDefinition(
    name="wandoujia",
    description="豌豆荚",
    spider_cls=Spider,
    configure_parser=configure_parser,
    build_job=build_job,
    supports_history=True,
)
