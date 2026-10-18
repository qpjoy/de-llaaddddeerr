"""One incident-scoped Twitter syntax comparison, run in Delta's Django shell.

Dry-run by default; the already-rejected production candidate cannot execute.
Only an explicitly selected control can send one first-page search through
Delta's configured Hub authentication and first network route. This MAY CONSUME
Hub/supplier quota. It never writes Delta business state, resumes a collector,
follows a cursor, clears unknown, or retries after a transport failure.
MX_TWITTER_QUERY_VERIFY=1 plus MX_TWITTER_QUERY_VERIFY_CASE=control selects OpenAI
with explicit stable retention. The revision-checked shell wrapper may instead
call main(case="control", execute=True), avoiding an omitted container env var.
This is not the production query and cannot establish cold-start recovery.
"""
import ast
import copy
import hashlib
import json
import os
import re
from unittest.mock import patch

REVISION = "twitter-query-compat-check.v2"
# Preserve the previous candidate's diagnostic identity for read-only comparison.
KEY_REVISION = "twitter-query-compat-check.v1"
RUN_KEY = "8a61e985-ece8-4127-a97e-b80e73499337"
REQUEST_ID = "b5906846-8564-4791-8b83-ef3ce97789bc"
QUERY_SHA256 = "f8f3da5a20307fa43713d737199766faa376498fe825ea69889b171f72a37386"
# Reviewed equivalent of the incident expression. No caller-controlled candidate.
CANDIDATE = (
    '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" '
    'OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") '
    '-"广告" -"营销" -"重复搬运" '
    '("diplomacy" OR "foreign policy" OR "diplomatic relations") '
    '("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost'
)
LEDGER_KEY = "_facebook_page_requests"
BLOCK_KEY = "cold_start_redispatch_block"
CONTROL_QUERY = "OpenAI"


class VerificationRefused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise VerificationRefused(code)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def saved_rejection(message):
    prefix = (f"data_query.hub_standard_request_failed status=502 request_id={REQUEST_ID} "
              "operation=raw platform=twitter message=")
    require(isinstance(message, str) and message.startswith(prefix) and len(message) < 16384,
            "saved_rejection_missing")
    try:
        body = ast.literal_eval(message[len(prefix):])
    except (ValueError, SyntaxError, RecursionError):
        raise VerificationRefused("saved_rejection_invalid") from None
    error = body.get("error") if isinstance(body, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    require(isinstance(details, dict) and error.get("code") == "social_upstream_rejected"
            and details.get("upstreamStatus") == 400 and details.get("outcome") == "rejected"
            and details.get("retryable") is False and details.get("requestId") == REQUEST_ID
            and body.get("requestId") == REQUEST_ID, "saved_outcome_not_rejected_400")


def scope_blocks_twitter(scope):
    scope = scope if isinstance(scope, dict) else {}
    ledger = scope.get(LEDGER_KEY) or {}
    streams = ledger.get("streams", {}) if isinstance(ledger, dict) else {}
    unknown = [entry for entry in streams.values() if isinstance(entry, dict)
               and entry.get("state") == "unknown"] if isinstance(streams, dict) else []
    block = scope.get(BLOCK_KEY) or {}
    if not unknown and not (isinstance(block, dict) and block.get("code") == "request_outcome_unknown"):
        return False
    affected = {str(scope.get("platform") or "").lower()}
    if isinstance(scope.get("platforms"), list):
        affected.update(value.lower() for value in scope["platforms"] if isinstance(value, str))
    for entry in unknown:
        payload = entry.get("payload") or {}
        platform = payload.get("platform") if isinstance(payload, dict) else None
        if not isinstance(platform, str) or not platform:
            return True
        affected.add(platform.lower())
    affected.discard("")
    return not affected or bool(affected & {"twitter", "x"})


def page_payload(step):
    params = step.params if isinstance(step.params, dict) else {}
    state = params.get("_collector") or {}
    require(step.status == "failed" and isinstance(state, dict)
            and state.get("failed_request_id") == REQUEST_ID
            and state.get("request_dispatched") is True
            and state.get("pages_done") == 0 and state.get("page_number") == 1
            and not state.get("pagination") and not state.get("unique_rows")
            and not any(getattr(step, field, 0) for field in
                        ("collected_count", "new_content_count", "duplicate_count", "actor_count")),
            "first_failed_page_required")
    saved_rejection(step.error_message)
    return copy.deepcopy({key: value for key, value in params.items()
                          if key not in {"_collector", "_facebook_page_request_version"}})


def load_snapshot():
    """Read-only snapshot; do not call model helpers that create settings rows."""
    from django.db import connection, transaction
    from django.utils import timezone
    from data_hub.models import CollectionRun

    with transaction.atomic():
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
        run = CollectionRun.objects.select_related("plan").get(public_key=RUN_KEY)
        require(run.status == "failed" and run.trigger_source == "cold_start"
                and run.run_kind == "plan_collection" and run.plan.monitor_target_type == "content"
                and run.plan.enabled and not (run.plan.expire_time and run.plan.expire_time <= timezone.now())
                and not run.collected_count, "failed_active_cold_start_required")
        require(not scope_blocks_twitter(run.platform_scope), "unknown_is_not_retry_permission")
        for scope in run.plan.runs.filter(run_kind="plan_collection").values_list("platform_scope", flat=True):
            require(not scope_blocks_twitter(scope), "plan_twitter_unknown_requires_reconciliation")
        steps = list(run.spider_steps.filter(status="failed",
            params___collector__failed_request_id=REQUEST_ID).order_by("-id")[:21])
        require(0 < len(steps) <= 20, "original_failed_step_not_unique_or_missing")
        payload = page_payload(steps[0])
        require(all(page_payload(step) == payload for step in steps), "original_steps_disagree")
        scope = run.platform_scope if isinstance(run.platform_scope, dict) else {}
        ledger = scope.get(LEDGER_KEY)
        evidence = {"hasV2Contract": "_search_contract" in payload, "hasDurablePageLedger": ledger is not None,
                    "originalKeySource": "not_persisted", "originalIdempotencyKeySha256": None}
        if ledger is not None:
            require(isinstance(ledger, dict) and ledger.get("version") == 1
                    and isinstance(ledger.get("streams"), dict), "invalid_page_ledger")
            matches = [entry for entry in ledger["streams"].values()
                       if isinstance(entry, dict) and entry.get("payload") == payload]
            require(len(matches) == 1 and matches[0].get("state") == "pending"
                    and matches[0].get("page_number") == 1
                    and matches[0].get("request_id", "") in {"", REQUEST_ID}
                    and isinstance(matches[0].get("idempotency_key"), str)
                    and bool(matches[0]["idempotency_key"]), "original_page_ledger_mismatch")
            evidence.update(originalKeySource="saved_page_ledger",
                            originalIdempotencyKeySha256=digest(matches[0]["idempotency_key"]))
        else:
            require("_search_contract" not in payload, "v2_original_page_ledger_missing")
        return payload, evidence


def prepare(payload, data_query, *, case="candidate"):
    require(case in {"candidate", "control"}, "invalid_verification_case")
    selected_query = CONTROL_QUERY if case == "control" else CANDIDATE
    before = data_query.hub_search_request_payload("raw", payload)
    path = data_query.hub_search_request_path("raw", payload)
    query = before.get("query")
    require(isinstance(query, str) and digest(query) == QUERY_SHA256, "original_query_digest_mismatch")
    require(path in {"/api/v1/data/search", "/api/v2/data/search"}
            and before.get("platform") == "twitter" and before.get("pageSize") == 20
            and not before.get("cursor") and payload.get("page", 1) in (1, "1"),
            "original_first_page_contract_mismatch")
    candidate = copy.deepcopy(payload)
    # Mirror the builder's query precedence; ambiguous aliases must not be hidden.
    fields = [key for key in ("query", "keyword", "keywords", "queries") if candidate.get(key)]
    require(fields and all(candidate[key] == query for key in fields), "ambiguous_query_aliases")
    for key in fields:
        candidate[key] = selected_query
    after = data_query.hub_search_request_payload("raw", candidate)
    require(data_query.hub_search_request_path("raw", candidate) == path
            and after == {**before, "query": selected_query}, "candidate_changed_business_conditions")
    if case == "control":
        # v1 fresh may re-acquire after its two-minute replay window. Stable
        # keeps the same key permanently owned, including rejected outcomes.
        # It does not change Twitter's Top/category or count parameters.
        after = {**after, "type": "stable"}
    encoded = json.dumps([KEY_REVISION, RUN_KEY, REQUEST_ID, path, after], ensure_ascii=False, sort_keys=True)
    key = "delta-twitter-compat-" + digest(encoded)[:40]
    return candidate, after, path, key


def safe_identifier(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value) else None


def coverage_summary(data):
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    effective = meta.get("effectiveWindow") if isinstance(meta.get("effectiveWindow"), dict) else {}
    capabilities = meta.get("capabilities") if isinstance(meta.get("capabilities"), dict) else {}
    known_warnings = {"TWITTER_PAGE_FILL_STOPPED", "TWITTER_ITEMS_DISCARDED", "TWITTER_PAGE_LIMIT_REACHED",
                      "PUBLISHED_TIME_UNAVAILABLE", "PAGE_SIZE_CAPPED"}
    known_limitations = {"source_coverage_not_guaranteed", "upstream_time_filter_unsupported",
                        "upstream_date_boundary_unverified", "published_time_unavailable", "source_traversal_incomplete"}

    def codes(values, known):
        return sorted({item["code"] if item.get("code") in known else "other" for item in values[:30]
                       if isinstance(item, dict) and isinstance(item.get("code"), str)}) if isinstance(values, list) else []

    def choice(value, allowed):
        return value if isinstance(value, str) and value in allowed else None

    return {"dataStatus": choice(data.get("status"), {"ok", "partial"}),
            "warningCodes": codes(data.get("warnings"), known_warnings),
            "limitationCodes": codes(meta.get("limitations"), known_limitations),
            "capability": choice(meta.get("capability"), {"search_posts"}),
            "effectiveWindow": {"present": bool(effective),
                "upstreamFiltering": choice(effective.get("upstreamFiltering"), {"unsupported", "calendar_date"}),
                "deliveryFiltering": choice(effective.get("deliveryFiltering"), {"exact"})},
            "coverageComplete": capabilities.get("coverageComplete") if type(capabilities.get("coverageComplete")) is bool else None,
            "providerCalls": meta.get("providerCalls") if type(meta.get("providerCalls")) is int else None,
            "interpretation": "A delivered first page, including HTTP 200 with zero items, does not establish full-window coverage."}


def verify(payload, data_query, *, execute=False, case="candidate"):
    require(not execute or case == "control", "candidate_already_rejected_no_more_dispatch")
    candidate, wire, path, key = prepare(payload, data_query, case=case)
    result = {"diagnosticRevision": REVISION, "runKey": RUN_KEY, "originalRequestId": REQUEST_ID,
              "mode": "execute" if execute else "dry_run", "path": path, "pageSize": wire["pageSize"],
              "originalQuerySha256": QUERY_SHA256, "candidateQuerySha256": digest(wire["query"]),
              "case": case, "isProductionQuery": case != "control",
              "queryPurpose": "supplier_availability_control" if case == "control" else "production_syntax_candidate",
              "requestType": wire.get("type", "fresh"),
              "retentionModeOverride": "stable" if case == "control" else None,
              "idempotencyKey": key, "httpAttempts": 0, "deltaBusinessWrites": 0,
              "mayConsumeQuota": bool(execute), "coldStartResumed": False,
              "supplierCalls": "not_bounded_by_http_count; Hub may fill one page using multiple supplier calls"}
    if not execute:
        return result

    original_builder = data_query.hub_search_request_payload
    expected_builder_payload = original_builder("raw", candidate)

    def stable_builder(operation, source):
        built = original_builder(operation, source)
        require(operation == "raw" and source == candidate and built == expected_builder_payload,
                "changed_builder_request_refused")
        return copy.deepcopy(wire)

    def first_route(operation, **kwargs):
        routes = data_query.model_network_routes(target_url=kwargs.get("target_url", ""))
        require(bool(routes), "network_route_unavailable")
        return operation(routes[0])

    def one_post(url, *, payload, headers, timeout, proxy_url):
        require(result["httpAttempts"] == 0 and payload == wire and headers.get("Idempotency-Key") == key,
                "second_or_changed_http_attempt_refused")
        result["httpAttempts"] += 1
        session = data_query.requests.Session()
        session.trust_env = False
        if proxy_url:
            session.proxies.update({"http": proxy_url, "https": proxy_url})
        try:
            response = session.post(url, json=payload, headers=headers, timeout=timeout, allow_redirects=False)
            result["httpStatus"] = response.status_code
            return response
        finally:
            session.close()

    try:
        with patch.object(data_query, "run_with_model_network_routes", first_route), \
                patch.object(data_query, "hub_search_request_payload", stable_builder), \
                patch.object(data_query, "_hub_http_post", one_post):
            body = data_query.hub_legacy_search_data("raw", candidate, idempotency_key=key)
        data = body.get("data") if isinstance(body, dict) else None
        require(isinstance(data, dict) and isinstance(data.get("items"), list), "unexpected_search_response")
        page = data.get("pageInfo") or {}
        result.update(requestId=safe_identifier(body.get("requestId")), resultCount=len(data["items"]),
                      hasMore=page.get("hasMore") if isinstance(page.get("hasMore"), bool) else None,
                      outcome="delivered")
        result.update(coverage_summary(data))
    except Exception as error:
        body = getattr(error, "body", None)
        public_error = body.get("error") if isinstance(body, dict) else None
        details = public_error.get("details") if isinstance(public_error, dict) else None
        result.update(outcome="error", requestId=safe_identifier(getattr(error, "request_id", None)),
            errorCode=safe_identifier(public_error.get("code")) if isinstance(public_error, dict)
            else str(error) if isinstance(error, VerificationRefused) else "transport_or_response_error")
        if isinstance(details, dict) and type(details.get("upstreamStatus")) is int:
            result["upstreamStatus"] = details["upstreamStatus"]
        if isinstance(details, dict):
            result["detailsRequestId"] = safe_identifier(details.get("requestId"))
        result["automaticRetryAllowed"] = False
    return result


def main(*, case=None, execute=None):
    try:
        from llm import data_query
        payload, evidence = load_snapshot()
        result = verify(payload, data_query,
                        execute=os.environ.get("MX_TWITTER_QUERY_VERIFY") == "1" if execute is None else execute,
                        case=os.environ.get("MX_TWITTER_QUERY_VERIFY_CASE", "candidate") if case is None else case)
        result["originalPageIdentity"] = evidence
    except Exception as error:
        result = {"diagnosticRevision": REVISION, "mode": "refused", "httpAttempts": 0,
                  "errorCode": str(error) if isinstance(error, VerificationRefused) else "snapshot_validation_failed"}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ in {"__main__", "django.core.management.commands.shell"}:
    main()
