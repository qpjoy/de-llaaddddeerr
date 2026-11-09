# Derived from halifox/app_market_crawler; local import paths adjusted 2026-09-12.
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class RunOptions:
    mongo_uri: str
    concurrency: int
    download_timeout: int
    log_level: str
    history: bool = False


@dataclass(frozen=True)
class JobConfig:
    mode: str
    input_values: tuple[str, ...]
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MarketDefinition:
    name: str
    description: str
    spider_cls: type
    configure_parser: Any
    build_job: Any
    supports_history: bool = False

