"""Incident-only Delta Django shell inspection; no tasks, HTTP, writes or recovery."""
import json
import hashlib
from datetime import datetime
from uuid import UUID

STEP_ID = "e09fc550-e30d-4098-aa6e-512e89042579"
PLAN_ID = "bb9721db-95e5-44c1-abe4-6b031dfb19be"
HUB_REQUEST_ID = "274d119a-27df-48de-a193-56211e926137"
LIMIT = 20
STATUSES = {"pending", "running", "succeeded", "failed", "canceled", "deferred"}
STEP_FIELDS = (
    "public_key", "run_id", "status", "order", "started_at", "finished_at", "collected_count",
    "params__platform", "params__startTime", "params__endTime", "params___collector__page_number", "params___collector__pages_done",
    "params___collector__failed_request_id", "params___collector__request_ids",
    "run__public_key", "run__plan_id", "run__plan__public_key", "run__plan__enabled",
    "run__status", "run__trigger_source", "run__celery_task_id", "run__collected_count",
    "run__started_at", "run__finished_at", "run__updated_at", "run__platform_scope__platform",
    "run__platform_scope__cold_start_group_key", "run__platform_scope__cold_start_paging",
    "run__platform_scope__cold_start_window",
)


def uuid_value(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        return None


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def flag(value):
    return value if isinstance(value, bool) else None


def status(value):
    return value if value in STATUSES else "other"


def timestamp(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
        except ValueError:
            pass
    return None


def mapping(value):
    return value if isinstance(value, dict) else {}


def inspect_delta(connection, models, environment_label=None):
    if connection.vendor != "postgresql":
        raise ValueError("postgresql_required")
    if connection.in_atomic_block or not connection.get_autocommit():
        raise ValueError("dedicated_connection_required")
    alias = connection.alias
    with connection.cursor() as cursor:
        try:
            cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cursor.execute("SET LOCAL statement_timeout = '5s'")
            cursor.execute("SET LOCAL lock_timeout = '1s'")
            cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '10s'")
            cursor.execute("SELECT current_database(), inet_server_addr()::text, inet_server_port(), now()")
            database_name, server_address, server_port, checked_at = cursor.fetchone()
            database_identity = hashlib.sha256(json.dumps(
                [database_name, server_address, server_port], separators=(",", ":")
            ).encode("utf-8")).hexdigest()
            row = models.CollectionRunSpiderStep.objects.using(alias).filter(public_key=STEP_ID).values(*STEP_FIELDS).first()
            safe_label = environment_label if (isinstance(environment_label, str) and 0 < len(environment_label) <= 64
                and all(char.isascii() and (char.isalnum() or char in "_.-") for char in environment_label)) else None
            result = {"diagnosticRevision": "delta-facebook-empty-page.v2", "readOnly": True,
                      "checkedAt": timestamp(checked_at), "configuredEnvironmentLabel": safe_label,
                      "databaseIdentitySha256": database_identity,
                      "databaseIdentityNote": "Hash of current database name/server address/port, not an environment attestation or unique cluster ID.",
                      "currentStateOnly": True, "expectedStepId": STEP_ID, "expectedPlanId": PLAN_ID,
                      "expectedHubRequestId": HUB_REQUEST_ID, "found": row is not None,
                      "brokerStateChecked": False, "hubDateWindowChecked": False,
                      "windowCoverageVerified": False, "providerCalls": 0}
            if row is None:
                plan = models.CollectionPlan.objects.using(alias).filter(public_key=PLAN_ID).values("id").first()
                result["missingStepContext"] = {
                    "expectedPlanFound": plan is not None,
                    "planRunCount": models.CollectionRun.objects.using(alias).filter(plan_id=plan["id"]).count() if plan else None,
                    "planStepCount": models.CollectionRunSpiderStep.objects.using(alias).filter(run__plan_id=plan["id"]).count() if plan else None,
                    "deletionHistoryChecked": False,
                    "interpretation": "Absent in this database snapshot. Wrong environment, removal or another original caller remain possible; absence does not prove deletion.",
                }
                return result
            plan_matches = uuid_value(row["run__plan__public_key"]) == PLAN_ID
            result["association"] = {
                "stepId": uuid_value(row["public_key"]), "runId": uuid_value(row["run__public_key"]),
                "planId": uuid_value(row["run__plan__public_key"]), "expectedPlanMatches": plan_matches,
                "coldStart": row["run__trigger_source"] == "cold_start",
                "stepFacebook": row["params__platform"] == "facebook",
                "runFacebook": row["run__platform_scope__platform"] == "facebook",
            }
            # A wrong-plan match must not expand into unrelated runs or state.
            if not plan_matches:
                return result
            paging = mapping(row["run__platform_scope__cold_start_paging"])
            pagination = mapping(paging.get("pagination"))
            window = mapping(row["run__platform_scope__cold_start_window"])
            request_ids = row["params___collector__request_ids"]
            recorded = isinstance(request_ids, list) and HUB_REQUEST_ID in request_ids
            recorded = recorded or row["params___collector__failed_request_id"] == HUB_REQUEST_ID
            result["originalStep"] = {
                "status": status(row["status"]), "order": count(row["order"]),
                "pageNumber": count(row["params___collector__page_number"]),
                "pagesDone": count(row["params___collector__pages_done"]),
                "collectedCount": count(row["collected_count"]), "hubRequestIdRecorded": bool(recorded),
                "windowStart": timestamp(row["params__startTime"]), "windowEnd": timestamp(row["params__endTime"]),
                "startedAt": timestamp(row["started_at"]), "finishedAt": timestamp(row["finished_at"]),
            }
            result["run"] = {
                "status": status(row["run__status"]), "planEnabled": flag(row["run__plan__enabled"]),
                "collectedCount": count(row["run__collected_count"]),
                "celeryTaskId": uuid_value(row["run__celery_task_id"]),
                "celeryTaskIdPresent": bool(row["run__celery_task_id"]),
                "startedAt": timestamp(row["run__started_at"]), "finishedAt": timestamp(row["run__finished_at"]),
                "updatedAt": timestamp(row["run__updated_at"]),
                "window": {"start": timestamp(window.get("start")), "end": timestamp(window.get("end"))},
                "paging": {"present": isinstance(row["run__platform_scope__cold_start_paging"], dict),
                           "pageNumber": count(paging.get("page_number")), "pagesCompleted": count(paging.get("pages_completed")),
                           "hasMore": flag(paging.get("has_more")), "exhausted": flag(paging.get("exhausted")),
                           "nextCursorPresent": bool(pagination.get("next_cursor")),
                           "nextParamsPresent": bool(pagination.get("next_params")),
                           "heartbeatAt": timestamp(paging.get("heartbeat_at"))},
            }
            group = row["run__platform_scope__cold_start_group_key"]
            state = models.CollectionPlanColdStartState.objects.using(alias).filter(
                plan_id=row["run__plan_id"], platform="facebook").values(
                    "status", "group_key", "attempt_count", "retained_content_count", "completed_at", "updated_at").first()
            result["coldStartGroup"] = {
                "groupId": uuid_value(group), "groupPresent": bool(group), "stateFound": state is not None,
                "stateGroupMatches": state is not None and bool(group) and state["group_key"] == group,
                "status": status(state["status"]) if state else None,
                "attemptCount": count(state["attempt_count"]) if state else None,
                "retainedContentCount": count(state["retained_content_count"]) if state else None,
                "completedAt": timestamp(state["completed_at"]) if state else None,
            }
            attempts = models.CollectionRunSpiderStep.objects.using(alias).filter(
                run_id=row["run_id"], params___collector__page_number=1)
            recent = list(attempts.order_by("-created_at", "-id").values(
                "public_key", "status", "created_at", "finished_at")[:LIMIT + 1])
            result["sameRunPage1StepCount"] = attempts.count()
            result["sameRunPage1Steps"] = [{"stepId": uuid_value(item["public_key"]), "status": status(item["status"]),
                                           "createdAt": timestamp(item["created_at"]), "finishedAt": timestamp(item["finished_at"])}
                                          for item in recent[:LIMIT]]
            result["sameRunPage1StepsTruncated"] = len(recent) > LIMIT
            result["groupRuns"] = []
            result["groupRunsTruncated"] = False
            if group:
                siblings = list(models.CollectionRun.objects.using(alias).filter(
                    plan_id=row["run__plan_id"], trigger_source="cold_start", platform_scope__cold_start_group_key=group
                ).order_by("id").values("public_key", "status", "collected_count")[:LIMIT + 1])
                result["groupRuns"] = [{"runId": uuid_value(item["public_key"]), "status": status(item["status"]),
                                        "collectedCount": count(item["collected_count"])} for item in siblings[:LIMIT]]
                result["groupRunsTruncated"] = len(siblings) > LIMIT
            result["limitations"] = (
                "Database snapshot only. Task ID and step count do not prove worker or delayed-retry inactivity. "
                "Older failed steps may not record the Hub request ID. No retry counter or cursor-restart counter is persisted here. "
                "Step/Run windows are Delta metadata, not proof of Hub coverage. Omitted Hub Facebook dates default to yesterday/today "
                "in UTC+8 calendar days; compare the original Hub request before treating an empty page as the whole requested window. "
                "No query, cursor, content, key, task dispatch or recovery is output or performed."
            )
            return result
        finally:
            cursor.execute("ROLLBACK")


def main():
    try:
        from django.db import connection
        from django.conf import settings
        from data_hub import models
        print(json.dumps(inspect_delta(connection, models, getattr(settings, "MX_ENVIRONMENT_NAME", None)), ensure_ascii=False, indent=2))
    except Exception as error:
        known = {"postgresql_required", "dedicated_connection_required"}
        print(json.dumps({"error": str(error) if str(error) in known else "diagnostic_read_failed"}))
        raise SystemExit(1) from None


if __name__ in {"__main__", "django.core.management.commands.shell"}:
    main()
