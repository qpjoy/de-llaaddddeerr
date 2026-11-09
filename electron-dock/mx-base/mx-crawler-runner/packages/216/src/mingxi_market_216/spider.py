# Derived from halifox/app_market_crawler; modified 2026-09-12; see UPSTREAM.md.
from __future__ import annotations

import argparse
import re

import json5

from .vendor.base import MarketSpider
from .vendor.inputs import build_file_or_list_job, build_range_file_or_list_job
from .vendor.models import MarketDefinition
from .vendor.utils import find_nested_key


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--mode",
        required=True,
        choices=[
            "pid-range",
            "docid-range",
            "history-pid-file",
            "history-pid-list",
            "package-file",
            "package-list",
            "pid-file",
            "pid-list",
            "docid-file",
            "docid-list",
        ],
    )
    parser.add_argument("--package-file")
    parser.add_argument("--packages", nargs="+")
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    parser.add_argument("--step", type=int, default=1)
    parser.add_argument("--pid-file")
    parser.add_argument("--pids", nargs="+")
    parser.add_argument("--docid-file")
    parser.add_argument("--docids", nargs="+")


def build_job(args):
    if args.mode == "pid-range":
        return build_range_file_or_list_job(
            args,
            range_mode="pid-range",
            file_mode="pid-file",
            list_mode="pid-list",
            file_arg="pid_file",
            list_arg="pids",
        )
    if args.mode in {"history-pid-file", "history-pid-list", "pid-file", "pid-list"}:
        return build_file_or_list_job(
            args,
            file_mode="history-pid-file" if args.mode.startswith("history-") else "pid-file",
            list_mode="history-pid-list" if args.mode.startswith("history-") else "pid-list",
            file_arg="pid_file",
            list_arg="pids",
        )
    if args.mode in {"package-file", "package-list"}:
        return build_file_or_list_job(
            args,
            file_mode="package-file",
            list_mode="package-list",
            file_arg="package_file",
            list_arg="packages",
        )
    if args.mode == "docid-range":
        return build_range_file_or_list_job(
            args,
            range_mode="docid-range",
            file_mode="docid-file",
            list_mode="docid-list",
            file_arg="docid_file",
            list_arg="docids",
        )
    return build_file_or_list_job(
        args,
        file_mode="docid-file",
        list_mode="docid-list",
        file_arg="docid_file",
        list_arg="docids",
    )


class Spider(MarketSpider):
    name = "market_baidu"
    market_name = "baidu"
    collection_name = "baidu"
    unique_index_fields = ("package", "versioncode")
    supports_history = True

    def build_start_requests(self):
        for input_value in self.job_config.input_values:
            if self.job_config.mode.startswith("history-pid-"):
                yield self.make_request(
                    f"https://mobile.baidu.com/appitemp/{input_value}",
                    callback=self.parse_entry,
                    input_value=input_value,
                )
                continue
            if self.job_config.mode.startswith("package-"):
                detail_url = f"https://appc.baidu.com/uiserver?part=main&action=detail&pname={input_value}"
            elif self.job_config.mode.startswith("pid-"):
                detail_url = f"https://appc.baidu.com/uiserver?part=main&action=detail&pid={input_value}"
            else:
                detail_url = f"https://appc.baidu.com/uiserver?part=main&action=detail&docid={input_value}"
            yield self.make_request(detail_url, callback=self.parse_detail, input_value=input_value)

    def parse_entry(self, response):
        input_value = response.meta["input_value"]
        script_text = response.xpath('//script[contains(text(), "window.__INITIAL_STATE__")]/text()').get()
        pattern = re.compile(r"window\.__INITIAL_STATE__\s*=\s*({.*?});?\s*$", re.S)
        match = pattern.search(script_text or "")
        if not match:
            yield from self.emit_result(input_value=input_value, success=False, error="detail: missing initial state")
            return
        payload = json5.loads(match.group(1))
        history_list = find_nested_key(payload, "fullHistoryList") or []
        if not history_list:
            yield from self.emit_result(input_value=input_value, success=False, error="detail: missing history list")
            return

        latest, *rest = history_list
        yield self.make_request(
            f"https://appc.baidu.com/uiserver?part=main&action=detail&docid={latest['docid']}",
            callback=self.parse_detail,
            input_value=input_value,
            meta={"docid": latest["docid"]},
        )
        if self.run_options.history:
            for item in rest:
                yield self.make_request(
                    f"https://appc.baidu.com/uiserver?part=main&action=detail&docid={item['docid']}",
                    callback=self.parse_history,
                    input_value=input_value,
                    request_kind="history",
                    priority=100,
                    meta={"docid": item["docid"]},
                )

    def parse_detail(self, response):
        input_value = response.meta["input_value"]
        payload = response.json()["result"]["data"]["data"]["appinfo"]
        yield from self.emit_record(payload, record_type="detail", input_value=input_value)
        yield from self.emit_result(input_value=input_value, success=True)

    def parse_history(self, response):
        input_value = response.meta["input_value"]
        payload = response.json()["result"]["data"]["data"]["appinfo"]
        yield from self.emit_record(payload, record_type="history", input_value=input_value)


MARKET = MarketDefinition(
    name="baidu",
    description="百度手机助手",
    spider_cls=Spider,
    configure_parser=configure_parser,
    build_job=build_job,
    supports_history=True,
)
