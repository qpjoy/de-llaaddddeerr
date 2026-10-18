"""Read-only Delta Django shell diagnostic; no HTTP, task dispatch or recovery.

Run against each candidate Delta container with MX_DIAGNOSTIC_PLAN_KEY set.
Output deliberately omits queries, cursors, payloads, credentials and raw errors.
"""
import ast
import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from uuid import UUID

LIMIT = 20
LEDGER_KEY = "_facebook_page_requests"
STEP_NAMES = ("data_query.raw", "data_query.crawl", "data_query.search")
PROTOCOL_BLOCK_MESSAGE = "A search outcome is unresolved; changing API version, key, window or cursor cannot authorize another acquisition"
STATUSES = {"pending", "running", "succeeded", "failed", "canceled", "deferred", "unknown", "delivered"}
PLATFORMS = {"facebook", "twitter", "instagram", "reddit", "telegram", "bilibili", "wechat", "weixin", "youtube", "tiktok", "douyin", "xiaohongshu", "weibo"}
COUNTER_FIELDS = ("collected_count", "new_content_count", "duplicate_count", "actor_count")
RUN_FIELDS = ("id", "public_key", "status", "trigger_source", "platform_scope", "created_at", *COUNTER_FIELDS)
STEP_FIELDS = ("public_key", "run_id", "status", "params", "error_message", "created_at", *COUNTER_FIELDS)


def mapping(value):
    return value if isinstance(value, dict) else {}


def uuid_value(value):
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        return None


def optional_uuid(value, error):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value):
        raise ValueError(error)
    parsed = uuid_value(value)
    if not parsed:
        raise ValueError(error)
    return parsed


def text_sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest() if isinstance(value, str) and value else None


def payload_sha256(value):
    if not isinstance(value, dict):
        return None
    try:
        return text_sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False))
    except (TypeError, ValueError):
        return None


def counters(row):
    return {"collectedCount": count(row.get("collected_count")), "newContentCount": count(row.get("new_content_count")),
            "duplicateCount": count(row.get("duplicate_count")), "actorCount": count(row.get("actor_count"))}


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


def summarize_step(row, blocker_request_id=None):
    params = mapping(row.get("params"))
    collector = mapping(params.get("_collector"))
    error = str(row.get("error_message") or "")
    ids = collector.get("request_ids")
    ids = ids if isinstance(ids, list) else []
    request_ids = [value for raw in ids[:LIMIT] if (value := uuid_value(raw))]
    message_match = PROTOCOL_BLOCK_MESSAGE in error
    status_match = re.search(r"\bstatus=409\b", error) is not None
    unknown_match = re.search(r"\brequest_outcome_unknown\b", error) is not None
    blocker_match = (re.search(r"(?<![0-9a-fA-F-])" + re.escape(blocker_request_id) + r"(?![0-9a-fA-F-])", error, re.IGNORECASE) is not None
                     if blocker_request_id else None)
    return {"stepKey": uuid_value(row.get("public_key")), "status": state(row.get("status")),
            "platform": platform(params.get("platform")), "createdAt": timestamp(row.get("created_at")),
            "modernPageMarker": type(params.get("_facebook_page_request_version")) is int and params["_facebook_page_request_version"] == 1,
            "collectorPresent": "_collector" in params,
            "requestDispatched": collector.get("request_dispatched") if type(collector.get("request_dispatched")) is bool else None,
            "pageNumber": count(collector.get("page_number")), "pagesDone": count(collector.get("pages_done")),
            **counters(row), "uniqueRows": count(collector.get("unique_rows")), "rawRowCount": count(collector.get("raw_row_count")),
            "failedRequestId": uuid_value(collector.get("failed_request_id")), "requestIds": request_ids,
            "requestIdsTruncated": len(ids) > LIMIT,
            "errorPresent": bool(error), "mentionsUnknown": unknown_match,
            "protocolBlockEvidence": {"exactMessagePresent": message_match, "mentions409": status_match,
                "specifiedBlockerIdPresent": blocker_match,
                "allRequiredTextPresent": message_match and status_match and unknown_match and blocker_match is True},
            "mentionsLegacyGuard": "历史 Facebook 请求尚未核对" in error or "legacy_facebook_request_requires_reconciliation" in error,
            "mentions404": "status=404" in error}


def summarize_run(row, steps, blocker_request_id=None):
    scope = mapping(row.get("platform_scope"))
    ledger = mapping(scope.get(LEDGER_KEY))
    streams = mapping(ledger.get("streams"))
    blocked = mapping(scope.get("cold_start_redispatch_block"))
    contract = mapping(scope.get("_search_contract"))
    source = row.get("trigger_source")
    entries = []
    for stream, entry in list(streams.items())[:LIMIT]:
        entry = mapping(entry)
        payload = mapping(entry.get("payload"))
        entries.append({"streamSha256": text_sha256(stream), "payloadSha256": payload_sha256(entry.get("payload")),
                        "idempotencyKeySha256": text_sha256(entry.get("idempotency_key")),
                        "state": state(entry.get("state")), "platform": platform(payload.get("platform")),
                        "pageNumber": count(entry.get("page_number")), "requestId": uuid_value(entry.get("request_id")),
                        "idempotencyKeyPresent": bool(entry.get("idempotency_key")), "cursorPresent": bool(entry.get("next_cursor"))})
    projected_steps = [summarize_step(step, blocker_request_id) for step in steps[:LIMIT]]
    paging = mapping(scope.get("cold_start_paging"))
    return {"runKey": uuid_value(row.get("public_key")), "status": state(row.get("status")),
            "triggerSource": source if source in {"cold_start", "daily_report", "manual", "scheduled", "retry", "manual_retry"} else "other",
            "createdAt": timestamp(row.get("created_at")), "platform": platform(scope.get("platform")),
            **counters(row),
            "coldStartGroupKey": uuid_value(scope.get("cold_start_group_key")),
            "searchContractPresent": bool(contract), "ledgerPresent": LEDGER_KEY in scope,
            "ledgerVersion": count(ledger.get("version")), "unknownBlockPresent": blocked.get("code") == "request_outcome_unknown",
            "unknownRequestId": uuid_value(blocked.get("request_id")), "streams": entries, "streamsTruncated": len(streams) > LIMIT,
            "stepEvidenceCounts": {"scope": "returned_search_steps_only", "complete": len(steps) <= LIMIT,
                "modernPageMarker": sum(step["modernPageMarker"] for step in projected_steps),
                "legacyOrMissingPageMarker": sum(not step["modernPageMarker"] for step in projected_steps),
                "succeeded": sum(step["status"] == "succeeded" for step in projected_steps),
                "positivePagesDone": sum((step["pagesDone"] or 0) > 0 for step in projected_steps),
                "positiveCollectedCount": sum((step["collectedCount"] or 0) > 0 for step in projected_steps)},
            "pageEvidence": {"completedPages": count(paging.get("pages_completed")), "pageNumber": count(paging.get("page_number")),
                "returnedDeliveredStreams": sum(entry["state"] == "delivered" for entry in entries),
                "returnedUnknownStreams": sum(entry["state"] == "unknown" for entry in entries),
                "streamCountsComplete": len(streams) <= LIMIT},
            "steps": projected_steps, "stepsTruncated": len(steps) > LIMIT}


def inspect_delta(connection, models, plan_key, run_key=None, blocker_request_id=None):
    plan_key = uuid_value(plan_key)
    if not plan_key:
        raise ValueError("valid_plan_key_required")
    run_key = optional_uuid(run_key, "valid_run_key_required")
    blocker_request_id = optional_uuid(blocker_request_id, "valid_blocker_request_id_required")
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
            result = {"diagnosticRevision": "delta-search-v2.2", "readOnly": True, "providerCalls": 0,
                      "planKey": plan_key, "planFound": plan is not None, "checkedAt": timestamp(identity[3]),
                      "selectedRunKey": run_key, "selectedRunFound": False if run_key else None,
                      "specifiedBlockerRequestId": blocker_request_id,
                      "databaseIdentitySha256": hashlib.sha256(json.dumps(identity[:3]).encode()).hexdigest(),
                      "digestFormat": "SHA256 UTF-8; payload uses JSON sorted keys, compact separators, ensure_ascii=false. Diagnostic comparison only, not Hub wire fingerprint.",
                      "limitations": "Database snapshot only; environment names and database hashes are not environment attestations. Error text matches do not prove no supplier dispatch. requestDispatched describes Delta-to-Hub HTTP, not supplier execution. Truncated lists cannot establish zero successful pages. Candidate lists are evidence, not permission to clear a guard or restart a task. No broker, Hub result, or supplier coverage verification."}
            if not plan:
                return result
            result["planEnabled"] = plan["enabled"]
            runs = models.CollectionRun.objects.using(connection.alias).filter(plan_id=plan["id"], run_kind="plan_collection")
            if run_key:
                runs = runs.filter(public_key=run_key)
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
                if run_key and name == "recentRuns":
                    result["selectedRunFound"] = bool(rows)
                for row in rows[:LIMIT]:
                    steps = list(models.CollectionRunSpiderStep.objects.using(connection.alias).filter(run_id=row["id"],
                        spider_name__in=STEP_NAMES).order_by("-created_at", "-id").values(*STEP_FIELDS)[:LIMIT + 1])
                    summary = summarize_run(row, steps, blocker_request_id)
                    items = models.CollectionItem.objects.using(connection.alias).filter(run_id=row["id"])
                    summary["storedItemEvidence"] = {"itemCount": items.count(), "newContentItemCount": items.filter(is_new_content=True).count()}
                    result[name].append(summary)
            return result
        finally:
            cursor.execute("ROLLBACK")


def main():
    try:
        from django.conf import settings
        from django.db import connection
        from data_hub import models
        result = inspect_delta(connection, models, os.environ.get("MX_DIAGNOSTIC_PLAN_KEY"),
                               os.environ.get("MX_DIAGNOSTIC_RUN_KEY"), os.environ.get("MX_DIAGNOSTIC_BLOCKER_REQUEST_ID"))
        result["hubUrls"] = safe_hub_urls(getattr(settings, "DATA_QUERY_HUB_API_BASE_URL", None))
        result["code"] = code_metadata(Path(models.__file__).resolve().parents[1])
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        known = {"valid_plan_key_required", "valid_run_key_required", "valid_blocker_request_id_required", "postgresql_required", "dedicated_connection_required"}
        print(json.dumps({"error": str(error) if str(error) in known else "diagnostic_read_failed"}))
        raise SystemExit(1) from None


if __name__ in {"__main__", "django.core.management.commands.shell"}:
    main()
