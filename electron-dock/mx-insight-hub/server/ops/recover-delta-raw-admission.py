"""One incident only: preview by default; explicitly resume the original Delta Run.

Stream into a Delta Django shell. No Hub HTTP or supplier probe is performed.
DB commit and broker publish are not atomic. A durable hold prevents scheduler
redispatch after process death; only the original assigned task may claim it.
Unclaimed dispatch_prepared still requires manual inspection, never re-publish.
"""
import ast
import copy
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from uuid import UUID, uuid4

PLAN = "6905bd48-7324-4602-9c06-4b77994f93d9"
RUN = "65a9f174-e611-4032-a759-fb64efcb540e"
STEP = "5df2ee9a-ec1c-4163-92aa-7f55499716e5"
GROUP = "9216a18c-0f33-449a-8b46-b27656d8c19e"
BLOCKER = "8ebd9f58-f6b6-4f8a-b8fe-db94c1068c09"
STREAM_SHA = "de921845eb613631546a441aed80f0fd04022542a0f5e901c692472e0e0edbe5"
PAYLOAD_SHA = "40ba477e6e7b6bbb5c58bdf40c978daa6d03d9bd3931a5637c78f7d2ad5ff43b"
KEY_SHA = "c7ef520abe008e7c8ba0555bdddd496a0b055e37bc37dd97bd0323884afa1c00"
STORE_SHA = "439490f908a1caf65211cd7e1562c719e05cbe667141cc1d83c164923389713b"
DATABASE_SHA = "57ed6a3674a80aa9538e1b96d76fe2c4257cbb0a096eca53286c50c8e02114d6"
REVISION = "delta-raw-admission-recovery.v1"
AUDIT = "_raw_admission_recovery_20261018"
LEDGER = "_facebook_page_requests"
BLOCK = "cold_start_redispatch_block"
MARKER = "_facebook_page_request_version"
MESSAGE = "A search outcome is unresolved; changing API version, key, window or cursor cannot authorize another acquisition"
COUNTERS = ("collected_count", "new_content_count", "duplicate_count", "actor_count")
# Pin both the claim implementation and its scheduler/worker entry integration.
RUNTIME_SHA256 = {
    "raw_admission_recovery.py": "725daeb98044678551806048a0318c81f615ad4b35afd068fd219b7203b3a99d",
    "tasks.py": "4c0afece78b080202eca0eb05f9ef5f79fddd2035362e5f8f4122b5534026d0a",
}


class RecoveryBlocked(Exception):
    pass


def require(condition, code):
    if not condition:
        raise RecoveryBlocked(code)


def encoded(value):
    def dates(item):
        if isinstance(item, datetime):
            return item.isoformat()
        if isinstance(item, UUID):
            return str(item)
        raise TypeError("unsupported_snapshot_value")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False, default=dates).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def text_digest(value):
    return hashlib.sha256(value.encode()).hexdigest() if isinstance(value, str) else None


def mapping(value):
    return value if isinstance(value, dict) else {}


def timestamp(value):
    require(isinstance(value, str), "invalid_receipt_time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise RecoveryBlocked("invalid_receipt_time") from None
    require(parsed.tzinfo is not None and parsed.utcoffset() is not None, "invalid_receipt_time")
    return parsed


def validate_receipt(receipt, now):
    expected = {"revision": REVISION, "planKey": PLAN, "runKey": RUN, "blockerRequestId": BLOCKER,
                "idempotencyKeySha256": KEY_SHA, "payloadSha256": PAYLOAD_SHA, "protocolStoreSha256": STORE_SHA,
                "legacyRawVerified": True, "pageIdentityAbsent": True, "ready": True}
    require(isinstance(receipt, dict) and set(receipt) == {*expected, "checkedAt"}, "invalid_hub_receipt")
    require(all(type(receipt[key]) is type(value) and receipt[key] == value for key, value in expected.items()), "invalid_hub_receipt")
    age = (now - timestamp(receipt["checkedAt"])).total_seconds()
    require(0 <= age <= 1800, "stale_or_future_hub_receipt")


def load_receipt(path):
    require(bool(path), "hub_receipt_required")
    try:
        content = Path(path).read_bytes()
        require(len(content) <= 16384, "invalid_hub_receipt")
        return json.loads(content)
    except (OSError, ValueError):
        raise RecoveryBlocked("invalid_hub_receipt") from None


def verify_runtime_source(models):
    try:
        directory = Path(models.__file__).resolve().parent
        actual = {}
        for name, expected in RUNTIME_SHA256.items():
            path = directory / name
            require(path.stat().st_size <= 2000000, "runtime_recovery_build_required")
            actual[name] = hashlib.sha256(path.read_bytes()).hexdigest()
            require(actual[name] == expected, "runtime_recovery_build_required")
        return actual
    except (AttributeError, OSError):
        raise RecoveryBlocked("runtime_recovery_build_required") from None


def validate_error(text):
    require(isinstance(text, str) and len(text) <= 65536, "step_error_changed")
    match = re.fullmatch(r"data_query\.hub_standard_request_failed status=409 request_id=([^ ]+) operation=raw platform=twitter message=(\{.*\})", text, re.DOTALL)
    require(match is not None and match[1] == BLOCKER, "step_error_changed")
    try:
        body = ast.literal_eval(match[2])
    except (ValueError, SyntaxError, RecursionError, MemoryError):
        raise RecoveryBlocked("step_error_changed") from None
    error = mapping(mapping(body).get("error"))
    details = mapping(error.get("details"))
    require(mapping(body).get("requestId") == BLOCKER and error.get("code") == "request_outcome_unknown" and error.get("message") == MESSAGE
            and details.get("requestId") == BLOCKER and details.get("automaticRetryAllowed") is False, "step_error_changed")
    def check_ids(value, depth=0):
        require(depth < 12, "step_error_changed")
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {"requestId", "request_id"}:
                    require(item == BLOCKER, "step_error_changed")
                check_ids(item, depth + 1)
        elif isinstance(value, (list, tuple)):
            for item in value:
                check_ids(item, depth + 1)
    check_ids(body)


def fields(obj, names):
    return {name: getattr(obj, name) for name in names}


@contextmanager
def database_scope(connection, transaction, apply):
    require(connection.vendor == "postgresql" and not connection.in_atomic_block and connection.get_autocommit(), "dedicated_postgresql_required")
    if apply:
        with transaction.atomic(using=connection.alias):
            with connection.cursor() as cursor:
                for sql in ("SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '1s'", "SET LOCAL idle_in_transaction_session_timeout = '10s'"):
                    cursor.execute(sql)
            yield
    else:
        with connection.cursor() as cursor:
            try:
                cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                for sql in ("SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '1s'", "SET LOCAL idle_in_transaction_session_timeout = '10s'"):
                    cursor.execute(sql)
                yield
            finally:
                cursor.execute("ROLLBACK")


def load_records(connection, models, apply):
    def query(model):
        rows = model.objects.using(connection.alias)
        return rows.select_for_update(nowait=True) if apply else rows
    plan = query(models.CollectionPlan).filter(public_key=PLAN).first()
    require(plan is not None, "plan_missing")
    cold = query(models.CollectionPlanColdStartState).filter(plan_id=plan.pk, platform="twitter").first()
    require(cold is not None, "cold_start_state_missing")
    run = query(models.CollectionRun).filter(public_key=RUN, plan_id=plan.pk).first()
    require(run is not None, "run_missing_or_wrong_plan")
    steps = list(query(models.CollectionRunSpiderStep).filter(run_id=run.pk).order_by("id")[:2])
    require(len(steps) == 1 and str(steps[0].public_key) == STEP, "step_set_changed")
    runtime = query(models.DataHubRuntimeState).filter(pk=1).first()
    require(runtime is not None, "runtime_pause_state_missing")
    scope = mapping(run.platform_scope)
    group_id, group_key = run.query_group_id, None
    if not group_id:
        group_key = scope.get("query_group_key") or None
        group_id = None if group_key else scope.get("query_group_id")
    group = None
    if group_id or group_key:
        group = query(models.CollectionQueryGroup).filter(**({"pk": group_id} if group_id else {"public_key": group_key})).first()
        require(group is not None and group.plan_id == plan.pk and group.platform in {"", "twitter"}
                and group.status == "active", "query_group_changed")
    require(steps[0].query_group_id == (group.pk if group else None), "query_group_changed")
    return plan, cold, run, steps[0], runtime, group


def validate_records(connection, models, records, receipt, now, runtime_source):
    plan, cold, run, step, runtime, group = records
    require(plan.enabled is True and (plan.expire_time is None or plan.expire_time > now)
            and plan.monitor_target_type == "content", "plan_not_executable")
    config = mapping(plan.spider_config)
    require(str(config.get("collector") or config.get("backend") or "data_query").strip().lower()
            not in {"legacy", "legacy_spider", "spider"}, "collector_changed")
    rules = [rule for rule in (plan.platform_rules or []) if isinstance(rule, dict) and str(rule.get("platform") or "").strip()]
    platforms = [str(rule.get("platform") or "").strip() for rule in rules if rule.get("enabled", True)] if rules else [str(item or "").strip() for item in (plan.platforms or [])]
    require("twitter" in platforms, "plan_platform_disabled")
    require(runtime.collection_paused is False and isinstance(runtime.collection_platform_pauses, dict)
            and "twitter" not in runtime.collection_platform_pauses, "collection_paused")
    scope = mapping(run.platform_scope)
    require(run.status == "failed" and run.trigger_source == "cold_start" and run.run_kind == "plan_collection", "run_state_changed")
    require(scope.get("platform") == "twitter" and scope.get("platforms", ["twitter"]) == ["twitter"]
            and scope.get("cold_start_group_key") == GROUP, "run_scope_changed")
    require(cold.group_key == GROUP and cold.status == "failed", "cold_start_state_changed")
    require(all(type(getattr(obj, field)) is int and getattr(obj, field) == 0 for obj in (run, step) for field in COUNTERS), "nonzero_collection_evidence")
    require(not models.CollectionItem.objects.using(connection.alias).filter(run_id=run.pk).exists(), "stored_items_present")
    require(step.status == "failed" and step.spider_name == "data_query.raw" and step.spider_type == "正文", "step_state_changed")
    validate_error(step.error_message)
    block = mapping(scope.get(BLOCK))
    require(type(block.get("version")) is int and block["version"] == 1 and block.get("code") == "request_outcome_unknown"
            and block.get("request_id") == BLOCKER, "block_changed")
    ledger = mapping(scope.get(LEDGER)); streams = mapping(ledger.get("streams"))
    require(type(ledger.get("version")) is int and ledger["version"] == 1 and len(streams) == 1, "ledger_changed")
    stream, entry = next(iter(streams.items())); entry = mapping(entry); payload = mapping(entry.get("payload"))
    require(text_digest(stream) == STREAM_SHA and digest(payload) == PAYLOAD_SHA
            and text_digest(entry.get("idempotency_key")) == KEY_SHA, "page_identity_changed")
    require(entry.get("state") == "unknown" and type(entry.get("page_number")) is int and entry["page_number"] == 1
            and entry.get("request_id") == BLOCKER and not entry.get("next_cursor") and not payload.get("cursor"), "page_state_changed")
    require(payload.get("platform") == "twitter" and type(payload.get(MARKER)) is int and payload[MARKER] == 1, "page_marker_changed")
    contract = mapping(scope.get("_search_contract")); window = mapping(contract.get("timeWindow"))
    require(type(contract.get("version")) is int and contract["version"] == 2 and contract == payload.get("_search_contract")
            and window.get("boundary") == "[from,to)" and window.get("timezone") == "Asia/Shanghai"
            and timestamp(window.get("from")) < timestamp(window.get("to")), "search_contract_changed")
    local_window = mapping(scope.get("cold_start_window"))
    # Contract freezing serializes millisecond precision; the original cold
    # start window retains Python microseconds (e.g. .006149 becomes .006).
    def contract_precision(value):
        parsed = timestamp(value)
        return parsed.replace(microsecond=(parsed.microsecond // 1000) * 1000)
    require(contract_precision(local_window.get("start")) == timestamp(window["from"])
            and contract_precision(local_window.get("end")) == timestamp(window["to"]), "local_window_changed")
    params = mapping(step.params); collector = mapping(params.get("_collector"))
    require({key: value for key, value in params.items() if key != "_collector"} == payload, "step_payload_changed")
    require(collector.get("request_dispatched") is True and collector.get("failed_request_id") == BLOCKER
            and collector.get("request_ids") == [BLOCKER] and collector.get("endpoint") == "/api/v1/search/raw"
            and type(collector.get("page_number")) is int and collector["page_number"] == 1, "collector_identity_changed")
    require(all(type(collector.get(field)) is int and collector[field] == 0 for field in ("pages_done", "unique_rows", "raw_row_count"))
            and collector.get("pagination") == {}, "collector_progress_changed")
    paging = mapping(scope.get("cold_start_paging"))
    require(type(paging.get("page_number")) is int and paging["page_number"] == 1
            and type(paging.get("pages_completed")) is int and paging["pages_completed"] == 0
            and paging.get("pagination") == {} and paging.get("exhausted") is False, "paging_changed")
    if "queries_by_platform" in scope:
        expressions = mapping(mapping(scope["queries_by_platform"]).get("twitter")).get("queries")
    else:
        expressions = scope.get("queries", scope.get("query_expressions"))
    if isinstance(expressions, str):
        expressions = [expressions]
    require(isinstance(expressions, list) and len(expressions) == 1 and isinstance(expressions[0], str) and expressions[0].strip(), "query_snapshot_changed")
    identity = ["/api/v1/search/raw", "twitter", expressions[0], group.pk if group else None, "正文"]
    require(hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:24] == stream, "stream_changed")
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database(), inet_server_addr()::text, inet_server_port()")
        database = hashlib.sha256(json.dumps(cursor.fetchone()).encode()).hexdigest()
    require(database == DATABASE_SHA, "database_identity_changed")
    snapshot = {"database": database, "receipt": receipt, "runtime_source": runtime_source,
        "plan": fields(plan, ("id", "public_key", "enabled", "expire_time", "monitor_target_type", "platform_rules", "platforms", "spider_config", "updated_at")),
        "cold": fields(cold, ("id", "status", "reason", "group_key", "collection_policy_snapshot", "retained_content_count", "attempt_count", "error_message", "started_at", "deferred_at", "completed_at", "updated_at")),
        "run": fields(run, ("id", "public_key", "status", "platform_scope", "celery_task_id", "error_message", "finished_at", "updated_at", "query_group_id", "collection_policy_snapshot", *COUNTERS)),
        "step": fields(step, ("id", "public_key", "status", "params", "error_message", "query_group_id", "updated_at", *COUNTERS)),
        "runtime": fields(runtime, ("collection_paused", "collection_platform_pauses", "updated_at")),
        "group": fields(group, ("id", "public_key", "plan_id", "platform", "status", "updated_at")) if group else None}
    followups = scope.get("followup_run_ids", [])
    require(isinstance(followups, list) and all(type(item) is int and item > 0 for item in followups), "followups_changed")
    return digest(snapshot), stream, len(set(followups))


def finalize_dispatch(connection, transaction, models, task_id, outcome, now):
    with database_scope(connection, transaction, True):
        run = models.CollectionRun.objects.using(connection.alias).select_for_update(nowait=True).filter(public_key=RUN).first()
        require(run is not None, "run_missing_or_wrong_plan")
        scope = copy.deepcopy(mapping(run.platform_scope)); audit = mapping(scope.get(AUDIT))
        require(audit.get("task_id") == task_id, "recovery_audit_changed")
        claimed = (audit.get("execution_state") == "claimed" and audit.get("claimed_task_id") == task_id
                   and isinstance(audit.get("claimed_at"), str) and bool(audit["claimed_at"]))
        # The runtime preserves ordinary retries/pages after a valid claim even
        # when the publisher's observation is ambiguous.
        audit["dispatch_state"] = outcome
        audit["dispatch_checked_at"] = now.isoformat()
        if outcome == "dispatch_unknown" and not claimed:
            entries = list(mapping(mapping(scope.get(LEDGER)).get("streams")).values())
            complete = run.status == "succeeded" and entries and all(mapping(item).get("state") == "delivered" for item in entries)
            if not complete:
                existing = mapping(scope.get(BLOCK))
                if not (type(existing.get("version")) is int and existing["version"] == 1
                        and existing.get("code") == "request_outcome_unknown"
                        and existing.get("reason") != "raw_admission_dispatch_prepared"):
                    audit["block_before_dispatch_unknown"] = copy.deepcopy(scope.get(BLOCK))
                    scope[BLOCK] = {"version": 1, "code": "request_outcome_unknown", "request_id": None,
                        "reason": "dispatch_unknown", "recovery_audit": AUDIT, "task_id": task_id}
                if run.status == "pending" and run.celery_task_id == task_id:
                    run.status = "failed"; run.finished_at = now
        scope[AUDIT] = audit; run.platform_scope = scope
        run.save(update_fields=["platform_scope", "status", "finished_at", "updated_at"])


def recover(connection, transaction, models, *, receipt, action="preview", expected_preview=None, guard_check=None, publisher=None, now=None):
    now = now or datetime.now(timezone.utc)
    require(action in {"preview", "apply-and-resume"}, "invalid_action")
    validate_receipt(receipt, now)
    apply = action == "apply-and-resume"
    if apply:
        require(isinstance(expected_preview, str) and re.fullmatch(r"[0-9a-f]{64}", expected_preview), "preview_sha256_required")
        require(callable(guard_check) and callable(publisher), "apply_dependencies_required")
    runtime_source = verify_runtime_source(models)
    result = {"revision": REVISION, "action": action, "planKey": PLAN, "runKey": RUN, "providerCallsByScript": 0}
    with database_scope(connection, transaction, apply):
        records = load_records(connection, models, apply)
        plan, cold, run, step, runtime, group = records
        if AUDIT in mapping(run.platform_scope):
            return {**result, "status": "already_recorded_no_publish", "manualReconcileRequired": True}
        preview, stream, followup_count = validate_records(connection, models, records, receipt, now, runtime_source)
        result.update(previewSha256=preview, followupCount=followup_count, runtimeSourceSha256=runtime_source,
                      followupMeaning="Only this Run is initially queued; the worker may acquire data and its existing paging, analysis and followups may proceed normally.")
        if not apply:
            return {**result, "status": "preview_ready", "readOnly": True}
        require(preview == expected_preview, "preview_snapshot_changed")
        original = copy.deepcopy(run.platform_scope); scope = copy.deepcopy(original)
        task_id = str(uuid4())
        scope[AUDIT] = {"revision": REVISION, "created_at": now.isoformat(), "preview_sha256": preview,
            "receipt": copy.deepcopy(receipt), "original_scope": original, "step_key": STEP,
            "step_error_sha256": text_digest(step.error_message), "original_task_id": run.celery_task_id,
            "original_run_error": run.error_message, "original_finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "task_id": task_id, "dispatch_state": "dispatch_prepared"}
        scope[LEDGER]["streams"][stream]["state"] = "pending"
        scope[LEDGER]["streams"][stream]["request_id"] = ""
        del scope[BLOCK]
        run.platform_scope = scope
        run.save(update_fields=["platform_scope", "updated_at"])
        require(not guard_check(plan, cold), "other_unresolved_request")
        scope[BLOCK] = {"version": 1, "code": "request_outcome_unknown", "request_id": None,
            "reason": "raw_admission_dispatch_prepared", "recovery_audit": AUDIT, "task_id": task_id}
        run.platform_scope = scope
        run.status = "pending"; run.finished_at = None; run.error_message = ""; run.celery_task_id = task_id
        run.save(update_fields=["platform_scope", "status", "finished_at", "error_message", "celery_task_id", "updated_at"])
        cold.status = "running"; cold.reason = "raw_admission_incident_recovery"; cold.attempt_count += 1
        cold.error_message = ""; cold.deferred_at = None; cold.completed_at = None
        cold.save(update_fields=["status", "reason", "attempt_count", "error_message", "deferred_at", "completed_at", "updated_at"])
        run_id = run.pk
    result["taskId"] = task_id
    try:
        publisher(run_id, task_id)
    except Exception:
        try:
            finalize_dispatch(connection, transaction, models, task_id, "dispatch_unknown", now)
            persisted = True
        except Exception:
            persisted = False
        return {**result, "status": "dispatch_unknown", "manualReconcileRequired": True,
                "ambiguityGuardPersisted": persisted, "mayAlreadyBeQueued": True}
    try:
        finalize_dispatch(connection, transaction, models, task_id, "published", now)
        recorded = True
    except Exception:
        recorded = False
    return {**result, "status": "published", "dispatchAuditRecorded": recorded, "manualReconcileRequired": not recorded}


def main():
    try:
        receipt = load_receipt(os.environ.get("MX_RECOVERY_HUB_RECEIPT"))
        action = os.environ.get("MX_RECOVERY_ACTION", "preview")
        from django.db import connection, transaction
        from data_hub import models
        guard_check = publisher = None
        if action == "apply-and-resume":
            from data_hub.facebook_collection import standard_search_plan_redispatch_blocked
            from data_hub.cold_start import cold_start_group_redispatch_blocked
            guard_check = lambda plan, cold: (standard_search_plan_redispatch_blocked(plan, "twitter")
                or cold_start_group_redispatch_blocked(plan, "twitter", state=cold))
            def publisher(run_id, task_id):
                from data_hub.tasks import run_collection_plan, cold_start_task_options
                run_collection_plan.apply_async(args=[run_id], task_id=task_id, retry=False, **cold_start_task_options("collection"))
        result = recover(connection, transaction, models, receipt=receipt, action=action,
            expected_preview=os.environ.get("MX_RECOVERY_PREVIEW_SHA256"), guard_check=guard_check, publisher=publisher)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result.get("manualReconcileRequired"):
            raise SystemExit(2)
    except RecoveryBlocked as error:
        print(json.dumps({"revision": REVISION, "status": "blocked", "code": str(error)}))
        raise SystemExit(1) from None
    except Exception:
        print(json.dumps({"revision": REVISION, "status": "blocked", "code": "recovery_failed_inspect_before_retry"}))
        raise SystemExit(1) from None


if __name__ in {"__main__", "django.core.management.commands.shell"}:
    main()
