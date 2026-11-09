"""Standalone JSON adapter. Original SDK results are retained in result.

This synchronous entry redirects process output while executing. Use a separate
process per concurrent request; it must not run concurrently in one interpreter.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timezone
import importlib
import json
import math
import os
from pathlib import Path
import sys
from typing import Any

# Generated from the same operation declarations as manifest.yaml.
SPEC = {'project_id': '105',
 'source_id': '105',
 'operations': {'collect': {'kind': 'function',
                            'module': 'mingxi_source_105',
                            'function': 'collect',
                            'input_schema': {'type': 'object',
                                             'properties': {'target': {'type': 'string',
                                                                       'description': '原 SDK 类型：str'},
                                                            'work_dir': {'type': 'string',
                                                                         'description': '原 SDK 类型：str | Path',
                                                                         'default': 'data'},
                                                            'timeout': {'type': 'number',
                                                                        'description': '原 SDK 类型：float',
                                                                        'default': 110}},
                                             'required': ['target'],
                                             'additionalProperties': False}}}}
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
STATUSES = {"success", "no_data", "partial", "unknown", "error", "stopped"}


class AdapterError(Exception):
    """Adapter-owned error whose code is safe to expose."""

    def __init__(self, code: str):
        self.code = code


def _validate(value: Any, schema: dict) -> None:
    """Validate the JSON boundary; the existing SDK validates domain rules."""
    kinds = schema.get("type", [])
    kinds = [kinds] if isinstance(kinds, str) else kinds
    actual = ("null" if value is None else "boolean" if type(value) is bool else
              "integer" if type(value) is int else "number" if type(value) is float else
              "string" if isinstance(value, str) else "array" if isinstance(value, list) else
              "object" if isinstance(value, dict) else "invalid")
    if actual == "invalid" or (kinds and actual not in kinds and not (actual == "integer" and "number" in kinds)):
        raise AdapterError("INVALID_PARAMS")
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        try:
            if not math.isfinite(value):
                raise AdapterError("INVALID_PARAMS")
        except OverflowError:
            raise AdapterError("INVALID_PARAMS") from None
    if "enum" in schema and value not in schema["enum"]:
        raise AdapterError("INVALID_PARAMS")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        if any(not isinstance(key, str) for key in value):
            raise AdapterError("INVALID_PARAMS")
        if schema.get("additionalProperties") is False and set(value) - set(props):
            raise AdapterError("INVALID_PARAMS")
        if set(schema.get("required", [])) - set(value):
            raise AdapterError("INVALID_PARAMS")
        for key, item in value.items():
            _validate(item, props.get(key, {}))
    elif isinstance(value, list):
        for item in value:
            _validate(item, schema.get("items", {}))


@contextlib.contextmanager
def _stderr_only():
    """Redirect Python prints, bound loggers and inherited native stdout."""
    saved = None
    try:
        try:
            if sys.stdout.fileno() == 1:
                sys.stdout.flush()
                sys.stderr.flush()
                saved = os.dup(1)
                os.dup2(sys.stderr.fileno(), 1)
        except (AttributeError, OSError, ValueError):
            pass
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        if saved is not None:
            try:
                sys.stderr.flush()
            finally:
                os.dup2(saved, 1)
                os.close(saved)


def _call(operation: str, params: dict) -> Any:
    """Dispatch only operations explicitly listed in this project."""
    spec = SPEC["operations"][operation]
    module = importlib.import_module(spec["module"])
    if spec["kind"] == "shodan":
        options = dict(params.pop("client", {}))
        key_file = options.pop("key_file", None)
        if key_file is not None:
            options["api_key"] = Path(key_file).read_text(encoding="utf-8-sig").strip()
        with module.ShodanClient(**options) as client:
            if operation in ("search_pages", "hosts"):
                return getattr(client, operation)(**params)
            return client.execute(operation, **params)
    function = getattr(module, spec["function"])
    if spec.get("preset_operation"):
        return function(operation=operation, **params)
    return function(**params)


def _status(result: Any, operation: str) -> str:
    if isinstance(result, list):
        if not result:
            return "no_data"
        states = {_status(item, operation) for item in result}
        return states.pop() if len(states) == 1 else "partial"
    if not isinstance(result, dict):
        return "unknown"
    if operation == "read_certificate_events" and "status" not in result:
        return "success" if result.get("items") else "no_data"
    status = result.get("status")
    if status == "failed":
        return "error"
    return status if isinstance(status, str) and status in STATUSES else "unknown"


def _envelope(operation: str | None = None, *, status: str = "error",
              result: Any = None, code: str | None = None) -> dict[str, Any]:
    return {"schema_version": "1.0", "project_id": SPEC["project_id"],
            "source_id": SPEC["source_id"], "operation": operation,
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "status": status, "result": result,
            "error": {"code": code} if code else None}


def invoke(request: dict[str, Any]) -> dict[str, Any]:
    """Execute one JSON request; preserve source data, cursors and status details.

    The caller owns runtime/state directories. No credentials are echoed in
    adapter exceptions. Call synchronously, outside an active asyncio loop.
    """
    operation = None
    try:
        if not isinstance(request, dict) or set(request) - {"operation", "params"}:
            raise AdapterError("INVALID_REQUEST")
        candidate = request.get("operation")
        if not isinstance(candidate, str) or candidate not in SPEC["operations"]:
            raise AdapterError("UNKNOWN_OPERATION")
        operation = candidate
        params = request.get("params", {})
        _validate(params, SPEC["operations"][operation]["input_schema"])
        if operation == "monitor_certificates":
            duration = params.get("duration_seconds")
            if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration <= 0:
                raise AdapterError("FINITE_DURATION_REQUIRED")
        # Copy all JSON containers so the original SDK cannot modify caller input.
        params = json.loads(json.dumps(params, allow_nan=False))
        with _stderr_only():
            result = _call(operation, params)
        if not isinstance(result, (dict, list)):
            raise AdapterError("INVALID_RESULT")
        try:
            json.dumps(result, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError, OverflowError, RecursionError):
            raise AdapterError("INVALID_RESULT") from None
        status = _status(result, operation)
        return _envelope(operation, status=status, result=result,
                         code="SOURCE_ERROR" if status == "error" else None)
    except AdapterError as exc:
        return _envelope(operation, code=exc.code)
    except (ModuleNotFoundError, ImportError):
        return _envelope(operation, code="DEPENDENCY_MISSING")
    except FileNotFoundError:
        return _envelope(operation, code="REQUIRED_FILE_MISSING")
    except (ValueError, TypeError):
        return _envelope(operation, code="INVALID_PARAMS")
    except Exception:
        return _envelope(operation, code="EXECUTION_ERROR")
    except SystemExit:
        return _envelope(operation, code="EXECUTION_ERROR")


def _reject_constant(value: str) -> None:
    raise ValueError("Non-finite JSON number")


def main() -> int:
    """Read one UTF-8 JSON request from stdin and emit one JSON response."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    if sys.argv[1:] in (["--help"], ["-h"]):
        print('Usage: python adapter.py < request.json\nInput: {"operation": "...", "params": {...}}')
        return 0
    if sys.argv[1:]:
        result = _envelope(code="INVALID_ARGUMENTS")
    else:
        try:
            stream = getattr(sys.stdin, "buffer", sys.stdin)
            content = stream.read(1_048_577)
            if len(content) > 1_048_576:
                raise ValueError("Input too large")
            if isinstance(content, bytes):
                content = content.decode("utf-8-sig")
            request = json.loads(content, parse_constant=_reject_constant)
        except (ValueError, UnicodeError, RecursionError):
            result = _envelope(code="INVALID_JSON")
        else:
            result = invoke(request)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if result["status"] in ("success", "no_data", "stopped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
