"""Read-only Delta Django shell diagnostic; no HTTP, task dispatch or recovery.

Run against each candidate Delta container with MX_DIAGNOSTIC_PLAN_KEY set.
Output deliberately omits queries, cursors, payloads, credentials and raw errors.
"""
import ast
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from uuid import UUID

LIMIT = 20
LEDGER_KEY = "_facebook_page_requests"
STEP_NAMES = ("data_query.raw", "data_query.crawl", "data_query.search")
STATUSES = {"pending", "running", "succeeded", "failed", "canceled", "deferred", "unknown", "delivered"}
PLATFORMS = {"facebook", "twitter", "instagram", "reddit", "telegram", "bilibili", "wechat", "weixin", "youtube", "tiktok", "douyin", "xiaohongshu", "weibo"}
RUN_FIELDS = ("id", "public_key", "status", "trigger_source", "platform_scope", "created_at", "collected_count")
STEP_FIELDS = ("public_key", "run_id", "status", "params", "error_message", "collected_count", "created_at")


def mapping(value):
    return value if isinstance(value, dict) else {}


def uuid_value(value):
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        return None


def timestamp(value):
    if isinstance(value, datetime):
        return value.isoformat()
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
    except (TypeError, ValueError):
        return None


def count(value):
    return value if type(value) is int and value >= 0 else None


def platform(value):
    return value if isinstance(value, str) and value in PLATFORMS else "other_or_missing"


def state(value):
    return value if isinstance(value, str) and value in STATUSES else "other_or_missing"


def safe_hub_urls(base):
    """Show the actual join layout, without URL credentials/query/fragment."""
    try:
        parsed = urlsplit(str(base or "https://hub.minsight-ai.com").strip().rstrip("/") + "/")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return {"error": "invalid_hub_base_url"}
        host = parsed.hostname
        if ":" in host:
            host = "[" + host + "]"
        if parsed.port:
            host += ":" + str(parsed.port)
        # Only known path components can appear in output; unusual paths may contain secrets.
        path_known = parsed.path in {"/", "/api/", "/api/v1/", "/api/v2/"}
        safe = urlunsplit((parsed.scheme, host, parsed.path if path_known else "/[redacted]/", "", ""))
        return {"base": safe, "baseHasPathPrefix": parsed.path != "/",
                "v1": urljoin(safe, "api/v1/data/search"), "v2": urljoin(safe, "api/v2/data/search")}
    except ValueError:
        return {"error": "invalid_hub_base_url"}


def code_metadata(root):
    """Read code files without importing optional modules from older images."""
    result = {}
    for name, relative in (("facebookPageRequests", "data_hub/facebook_page_requests.py"), ("dataQuery", "llm/data_query.py")):
        try:
            source = (Path(root) / relative).read_bytes()
            tree = ast.parse(source)
            result[name] = {"available": True, "sha256": hashlib.sha256(source).hexdigest()}
            if name == "facebookPageRequests":
                result[name]["modernStepGuardPresent"] = any(isinstance(node, ast.FunctionDef)
                    and node.name == "facebook_step_requires_reconciliation" for node in tree.body)
        except (OSError, SyntaxError, ValueError):
            result[name] = {"available": False}
    return result


def summarize_step(row):
    params = mapping(row.get("params"))
    collector = mapping(params.get("_collector"))
    error = str(row.get("error_message") or "")
    ids = collector.get("request_ids")
    ids = ids if isinstance(ids, list) else []
    request_ids = [value for raw in ids[:LIMIT] if (value := uuid_value(raw))]
    return {"stepKey": uuid_value(row.get("public_key")), "status": state(row.get("status")),
            "platform": platform(params.get("platform")), "createdAt": timestamp(row.get("created_at")),
            "modernPageMarker": type(params.get("_facebook_page_request_version")) is int and params["_facebook_page_request_version"] == 1,
            "collectorPresent": "_collector" in params,
            "requestDispatched": collector.get("request_dispatched") if type(collector.get("request_dispatched")) is bool else None,
            "pageNumber": count(collector.get("page_number")), "pagesDone": count(collector.get("pages_done")),
            "collectedCount": count(row.get("collected_count")),
            "failedRequestId": uuid_value(collector.get("failed_request_id")), "requestIds": request_ids,
            "requestIdsTruncated": len(ids) > LIMIT,
            "errorPresent": bool(error), "mentionsUnknown": "request_outcome_unknown" in error,
            "mentionsLegacyGuard": "历史 Facebook 请求尚未核对" in error or "legacy_facebook_request_requires_reconciliation" in error,
            "mentions404": "status=404" in error}


def summarize_run(row, steps):
    scope = mapping(row.get("platform_scope"))
    ledger = mapping(scope.get(LEDGER_KEY))
    streams = mapping(ledger.get("streams"))
    blocked = mapping(scope.get("cold_start_redispatch_block"))
    contract = mapping(scope.get("_search_contract"))
    source = row.get("trigger_source")
    entries = []
    for entry in list(streams.values())[:LIMIT]:
        entry = mapping(entry)
        payload = mapping(entry.get("payload"))
        entries.append({"state": state(entry.get("state")), "platform": platform(payload.get("platform")),
                        "pageNumber": count(entry.get("page_number")), "requestId": uuid_value(entry.get("request_id")),
                        "idempotencyKeyPresent": bool(entry.get("idempotency_key")), "cursorPresent": bool(entry.get("next_cursor"))})
    return {"runKey": uuid_value(row.get("public_key")), "status": state(row.get("status")),
            "triggerSource": source if source in {"cold_start", "daily_report", "manual", "scheduled", "retry", "manual_retry"} else "other",
            "createdAt": timestamp(row.get("created_at")), "platform": platform(scope.get("platform")),
            "collectedCount": count(row.get("collected_count")),
            "coldStartGroupKey": uuid_value(scope.get("cold_start_group_key")),
            "searchContractPresent": bool(contract), "ledgerPresent": LEDGER_KEY in scope,
            "ledgerVersion": count(ledger.get("version")), "unknownBlockPresent": blocked.get("code") == "request_outcome_unknown",
            "unknownRequestId": uuid_value(blocked.get("request_id")), "streams": entries, "streamsTruncated": len(streams) > LIMIT,
            "steps": [summarize_step(step) for step in steps[:LIMIT]], "stepsTruncated": len(steps) > LIMIT}


def inspect_delta(connection, models, plan_key):
    plan_key = uuid_value(plan_key)
    if not plan_key:
        raise ValueError("valid_plan_key_required")
    if connection.vendor != "postgresql":
        raise ValueError("postgresql_required")
    if connection.in_atomic_block or not connection.get_autocommit():
        raise ValueError("dedicated_connection_required")
    with connection.cursor() as cursor:
        try:
            cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cursor.execute("SET LOCAL statement_timeout = '5s'")
            cursor.execute("SET LOCAL lock_timeout = '1s'")
            cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '10s'")
            cursor.execute("SELECT current_database(), inet_server_addr()::text, inet_server_port(), now()")
            identity = cursor.fetchone()
            plan = models.CollectionPlan.objects.using(connection.alias).filter(public_key=plan_key).values("id", "enabled").first()
            result = {"diagnosticRevision": "delta-search-v2.1", "readOnly": True, "providerCalls": 0,
                      "planKey": plan_key, "planFound": plan is not None, "checkedAt": timestamp(identity[3]),
                      "databaseIdentitySha256": hashlib.sha256(json.dumps(identity[:3]).encode()).hexdigest(),
                      "limitations": "Database snapshot only; environment names and database hashes are not environment attestations. Candidate lists are evidence, not permission to clear a guard or restart a task. No broker, Hub result, or supplier coverage verification."}
            if not plan:
                return result
            result["planEnabled"] = plan["enabled"]
            runs = models.CollectionRun.objects.using(connection.alias).filter(plan_id=plan["id"], run_kind="plan_collection")
            candidates = {
                "recentRuns": runs,
                "legacyFacebookCandidates": runs.filter(status__in=["pending", "running", "failed", "canceled"],
                    spider_steps__spider_name__in=STEP_NAMES, spider_steps__params__platform="facebook",
                    spider_steps__status__in=["running", "failed", "canceled"]).exclude(platform_scope__has_key=LEDGER_KEY).distinct(),
                "unknownRuns": runs.filter(platform_scope__cold_start_redispatch_block__code="request_outcome_unknown"),
            }
            for name, query in candidates.items():
                rows = list(query.order_by("-created_at", "-id").values(*RUN_FIELDS)[:LIMIT + 1])
                result[name] = []
                result[name + "Truncated"] = len(rows) > LIMIT
                for row in rows[:LIMIT]:
                    steps = list(models.CollectionRunSpiderStep.objects.using(connection.alias).filter(run_id=row["id"],
                        spider_name__in=STEP_NAMES).order_by("-created_at", "-id").values(*STEP_FIELDS)[:LIMIT + 1])
                    result[name].append(summarize_run(row, steps))
            return result
        finally:
            cursor.execute("ROLLBACK")


def main():
    try:
        from django.conf import settings
        from django.db import connection
        from data_hub import models
        result = inspect_delta(connection, models, os.environ.get("MX_DIAGNOSTIC_PLAN_KEY"))
        result["hubUrls"] = safe_hub_urls(getattr(settings, "DATA_QUERY_HUB_API_BASE_URL", None))
        result["code"] = code_metadata(Path(models.__file__).resolve().parents[1])
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        known = {"valid_plan_key_required", "postgresql_required", "dedicated_connection_required"}
        print(json.dumps({"error": str(error) if str(error) in known else "diagnostic_read_failed"}))
        raise SystemExit(1) from None


if __name__ in {"__main__", "django.core.management.commands.shell"}:
    main()
