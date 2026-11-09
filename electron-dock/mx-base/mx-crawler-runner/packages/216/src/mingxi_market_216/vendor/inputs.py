# Derived from halifox/app_market_crawler; local import paths adjusted 2026-09-12.
from __future__ import annotations

import argparse
from pathlib import Path

from .models import JobConfig


def load_lines(path: str) -> tuple[str, ...]:
    file_path = Path(path)
    if not file_path.exists():
        raise argparse.ArgumentTypeError(f"Input file does not exist: {file_path}")
    return tuple(line.strip() for line in file_path.read_text(encoding="utf-8").splitlines() if line.strip())


def parse_int_range(start: int, end: int, step: int) -> tuple[str, ...]:
    if step <= 0:
        raise argparse.ArgumentTypeError("--step must be a positive integer")
    if end < start:
        raise argparse.ArgumentTypeError("--end must be greater than or equal to --start")
    return tuple(str(value) for value in range(start, end + 1, step))


def parse_numeric_string_range(start: str, end: str, step: int) -> tuple[str, ...]:
    if not start or not end:
        raise argparse.ArgumentTypeError("--start and --end are required for range mode")
    if not start.isdigit() or not end.isdigit():
        raise argparse.ArgumentTypeError("--start and --end must be numeric strings")
    width = len(start)
    if len(end) != width:
        raise argparse.ArgumentTypeError("--start and --end must have the same width")
    int_start = int(start)
    int_end = int(end)
    parse_int_range(int_start, int_end, step)
    return tuple(str(value).zfill(width) for value in range(int_start, int_end + 1, step))


def add_id_mode_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--mode", required=True, choices=["id-range", "id-file", "id-list"])
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    parser.add_argument("--step", type=int, default=1)
    parser.add_argument("--id-file")
    parser.add_argument("--ids", nargs="+")


def add_package_mode_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--mode", required=True, choices=["package-file", "package-list"])
    parser.add_argument("--package-file")
    parser.add_argument("--packages", nargs="+")


def build_id_job(args: argparse.Namespace, *, extra: dict | None = None) -> JobConfig:
    if args.mode == "id-range":
        if args.start is None or args.end is None:
            raise argparse.ArgumentTypeError("--start and --end are required for --mode id-range")
        input_values = parse_int_range(args.start, args.end, args.step)
    elif args.mode == "id-file":
        if not args.id_file:
            raise argparse.ArgumentTypeError("--id-file is required for --mode id-file")
        input_values = load_lines(args.id_file)
    else:
        if not args.ids:
            raise argparse.ArgumentTypeError("--ids is required for --mode id-list")
        input_values = tuple(str(item) for item in args.ids)
    return JobConfig(mode=args.mode, input_values=input_values, extra=extra or {})


def build_package_job(args: argparse.Namespace, *, extra: dict | None = None) -> JobConfig:
    if args.mode == "package-file":
        if not args.package_file:
            raise argparse.ArgumentTypeError("--package-file is required for --mode package-file")
        input_values = load_lines(args.package_file)
    else:
        if not args.packages:
            raise argparse.ArgumentTypeError("--packages is required for --mode package-list")
        input_values = tuple(str(item) for item in args.packages)
    return JobConfig(mode=args.mode, input_values=input_values, extra=extra or {})


def build_file_or_list_job(
    args: argparse.Namespace,
    *,
    file_mode: str,
    list_mode: str,
    file_arg: str,
    list_arg: str,
    extra: dict | None = None,
) -> JobConfig:
    if args.mode == file_mode:
        file_path = getattr(args, file_arg, None)
        if not file_path:
            cli_name = file_arg.replace("_", "-")
            raise argparse.ArgumentTypeError(f"--{cli_name} is required for --mode {file_mode}")
        input_values = load_lines(file_path)
    elif args.mode == list_mode:
        values = getattr(args, list_arg, None)
        if not values:
            cli_name = list_arg.replace("_", "-")
            raise argparse.ArgumentTypeError(f"--{cli_name} is required for --mode {list_mode}")
        input_values = tuple(str(item) for item in values)
    else:
        raise argparse.ArgumentTypeError(f"Unsupported mode for this input builder: {args.mode}")
    return JobConfig(mode=args.mode, input_values=input_values, extra=extra or {})


def build_range_file_or_list_job(
    args: argparse.Namespace,
    *,
    range_mode: str,
    file_mode: str,
    list_mode: str,
    file_arg: str,
    list_arg: str,
    range_parser=parse_int_range,
    extra: dict | None = None,
) -> JobConfig:
    if args.mode == range_mode:
        if getattr(args, "start", None) is None or getattr(args, "end", None) is None:
            raise argparse.ArgumentTypeError(f"--start and --end are required for --mode {range_mode}")
        input_values = range_parser(args.start, args.end, args.step)
    elif args.mode == file_mode:
        file_path = getattr(args, file_arg, None)
        if not file_path:
            cli_name = file_arg.replace("_", "-")
            raise argparse.ArgumentTypeError(f"--{cli_name} is required for --mode {file_mode}")
        input_values = load_lines(file_path)
    elif args.mode == list_mode:
        values = getattr(args, list_arg, None)
        if not values:
            cli_name = list_arg.replace("_", "-")
            raise argparse.ArgumentTypeError(f"--{cli_name} is required for --mode {list_mode}")
        input_values = tuple(str(item) for item in values)
    else:
        raise argparse.ArgumentTypeError(f"Unsupported mode for this input builder: {args.mode}")
    return JobConfig(mode=args.mode, input_values=input_values, extra=extra or {})
