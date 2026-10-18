#!/usr/bin/env python3
"""Standalone, read-only Night-All-A catalog and source-file evidence.

Run: docker exec -i -e PYTHONDONTWRITEBYTECODE=1 \
  data-query-platform-platform-1 python -B - < night-all-a-runtime-audit.py
Use --files-only to omit the database connection. No app modules are imported.
The environment URL is a configuration candidate, not proof of the live process
DSN or of the database configured in Hub. No credentials or source text are output.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys

# Embedded from night-all-saved-records-source-audit.sql, except its final ROLLBACK.
# The same transaction also reads bounded Alembic migration metadata below.
SOURCE_AUDIT_SQL = r"""
-- Run against the source database with psql -X -v ON_ERROR_STOP=1 -f this-file.sql.
-- Add -A -t -q for a single JSON result without psql headings/command tags.
-- Catalog evidence only: no business rows, DDL, task activation or checkpoint changes.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '15s';

WITH
expected_columns(name, database_type, nullable, optional) AS (
  VALUES
    ('id', 'int4', false, false),
    ('source_type', 'varchar', false, false),
    ('connector_id', 'varchar', false, false),
    ('run_id', 'int4', true, false),
    ('source_family', 'varchar', true, false),
    ('collection_mode', 'varchar', true, false),
    ('evidence', 'jsonb', false, false),
    ('quality_status', 'varchar', false, false),
    ('record_type', 'varchar', false, false),
    ('source_id', 'varchar', false, false),
    ('record_key', 'varchar', false, false),
    ('source_url', 'text', false, false),
    ('title', 'varchar', false, false),
    ('text', 'text', false, false),
    ('author', 'jsonb', false, false),
    ('published_at', 'varchar', true, false),
    ('metrics', 'jsonb', false, false),
    ('media', 'jsonb', false, false),
    ('attributes', 'jsonb', false, false),
    ('raw', 'jsonb', true, false),
    ('first_seen_at', 'timestamptz', false, false),
    ('last_seen_at', 'timestamptz', false, false),
    ('created_at', 'timestamptz', false, false),
    ('tag', 'varchar', true, true),
    ('storage_schema_version', 'int4', false, true),
    ('source_key', 'text', true, true),
    ('source_name', 'text', true, true),
    ('publisher_name', 'text', true, true),
    ('content_kind', 'varchar', true, true),
    ('content_status', 'varchar', true, true),
    ('has_full_text', 'bool', true, true),
    ('summary', 'text', true, true),
    ('published_at_utc', 'timestamptz', true, true),
    ('published_date', 'date', true, true),
    ('published_at_precision', 'varchar', true, true),
    ('published_at_status', 'varchar', true, true),
    ('fetch_transport', 'varchar', true, true),
    ('standardization_warnings', 'jsonb', true, true)
),
parent AS MATERIALIZED (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name,
         c.relkind, c.relispartition, pg_get_partkeydef(c.oid) AS partition_key
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'saved_records'
),
children AS MATERIALIZED (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name,
         c.relkind, c.relispartition, pg_get_partkeydef(c.oid) AS partition_key,
         pg_get_expr(c.relpartbound, c.oid, true) AS partition_bound,
         NOT EXISTS (SELECT 1 FROM pg_inherits next_level WHERE next_level.inhparent = c.oid) AS is_leaf
    FROM parent p JOIN pg_inherits i ON i.inhparent = p.oid
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
),
selected_children AS MATERIALIZED (
  SELECT * FROM children ORDER BY schema_name, table_name, oid LIMIT 500
),
relations AS MATERIALIZED (
  SELECT p.*, NULL::text AS partition_bound,
         NOT EXISTS (SELECT 1 FROM children) AS is_leaf, true AS is_parent
    FROM parent p
  UNION ALL
  SELECT c.*, false AS is_parent FROM selected_children c
),
columns AS MATERIALIZED (
  SELECT r.oid AS relation_oid, a.attnum AS ordinal, a.attname AS name,
         t.typname AS database_type, tn.nspname AS type_schema,
         format_type(a.atttypid, a.atttypmod) AS declared_type, NOT a.attnotnull AS nullable
    FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace tn ON tn.oid = t.typnamespace
   WHERE a.attnum > 0 AND NOT a.attisdropped
),
indexes AS MATERIALIZED (
  SELECT r.oid AS relation_oid, i.indexrelid AS oid, ns.nspname AS schema_name,
         ic.relname AS name, am.amname AS access_method,
         i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
         i.indisunique AS is_unique, i.indexprs IS NULL AS no_expressions,
         i.indpred IS NULL AS no_predicate, i.indnkeyatts AS key_count,
         i.indnatts AS total_columns,
         pg_get_indexdef(i.indexrelid, 1, true) AS first_key,
         CASE WHEN i.indnatts >= 2 THEN pg_get_indexdef(i.indexrelid, 2, true) END AS second_key,
         i.indoption[0] AS first_option, i.indoption[1] AS second_option,
         COALESCE(i.indisvalid AND i.indisready AND i.indislive AND i.indisunique
           AND am.amname = 'btree' AND i.indexprs IS NULL AND i.indpred IS NULL
           AND i.indnkeyatts = 2 AND i.indnatts = 2
           AND a1.attname = 'last_seen_at' AND a2.attname = 'id'
           AND regexp_replace(pg_get_indexdef(i.indexrelid, 1, true), '[()[:space:]"]', '', 'g') = 'last_seen_at'
           AND regexp_replace(pg_get_indexdef(i.indexrelid, 2, true), '[()[:space:]"]', '', 'g') = 'id'
           AND i.indoption[0] = 0 AND i.indoption[1] = 0, false) AS cursor_contract_ready
    FROM relations r JOIN pg_index i ON i.indrelid = r.oid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace ns ON ns.oid = ic.relnamespace
    JOIN pg_am am ON am.oid = ic.relam
    LEFT JOIN pg_attribute a1 ON a1.attrelid = r.oid AND a1.attnum = i.indkey[0]
    LEFT JOIN pg_attribute a2 ON a2.attrelid = r.oid AND a2.attnum = i.indkey[1]
),
relation_reports AS (
  SELECT r.oid, r.schema_name, r.table_name, r.is_parent,
         jsonb_build_object(
           'oid', r.oid, 'schema', r.schema_name, 'table', r.table_name,
           'relationKind', r.relkind, 'isPartition', r.relispartition,
           'partitionKey', r.partition_key, 'partitionBound', r.partition_bound,
           'isLeaf', r.is_leaf,
           'tag', COALESCE((SELECT jsonb_build_object('present', true,
             'databaseType', c.database_type, 'typeSchema', c.type_schema,
             'declaredType', c.declared_type, 'nullable', c.nullable)
             FROM columns c WHERE c.relation_oid = r.oid AND c.name = 'tag'), '{"present":false}'::jsonb),
           'columnCount', (SELECT count(*) FROM columns c WHERE c.relation_oid = r.oid),
           'columnsComplete', (SELECT count(*) <= 500 FROM columns c WHERE c.relation_oid = r.oid),
           'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'name', c.name, 'databaseType', c.database_type, 'typeSchema', c.type_schema,
             'declaredType', c.declared_type, 'nullable', c.nullable, 'ordinal', c.ordinal)
             ORDER BY c.ordinal)
             FROM (SELECT * FROM columns c WHERE c.relation_oid = r.oid ORDER BY ordinal LIMIT 500) c), '[]'::jsonb),
           'missingColumns', COALESCE((SELECT jsonb_agg(e.name ORDER BY e.name)
             FROM expected_columns e WHERE NOT e.optional AND NOT EXISTS
               (SELECT 1 FROM columns c WHERE c.relation_oid = r.oid AND c.name = e.name)), '[]'::jsonb),
           'unexpectedColumns', COALESCE((SELECT jsonb_agg(c.name ORDER BY c.name)
             FROM (SELECT name FROM columns c WHERE c.relation_oid = r.oid
               AND NOT EXISTS (SELECT 1 FROM expected_columns e WHERE e.name = c.name)
               ORDER BY name LIMIT 500) c), '[]'::jsonb),
           'columnMismatches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'name', e.name, 'expectedType', e.database_type, 'actualType', c.database_type,
             'actualTypeSchema', c.type_schema, 'expectedNullable', e.nullable, 'actualNullable', c.nullable)
             ORDER BY e.name)
             FROM expected_columns e JOIN columns c ON c.name = e.name AND c.relation_oid = r.oid
             WHERE c.database_type <> e.database_type OR c.type_schema <> 'pg_catalog' OR c.nullable <> e.nullable), '[]'::jsonb),
           'cursorIndexReady', EXISTS (SELECT 1 FROM indexes i WHERE i.relation_oid = r.oid AND i.cursor_contract_ready),
           'indexCount', (SELECT count(*) FROM indexes i WHERE i.relation_oid = r.oid),
           'indexesComplete', (SELECT count(*) <= 500 FROM indexes i WHERE i.relation_oid = r.oid),
           'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'oid', i.oid, 'schema', i.schema_name, 'name', i.name,
             'valid', i.valid, 'ready', i.ready, 'live', i.live, 'unique', i.is_unique,
             'accessMethod', i.access_method, 'noExpressions', i.no_expressions,
             'noPredicate', i.no_predicate, 'keyCount', i.key_count, 'totalColumns', i.total_columns,
             'firstKey', i.first_key, 'secondKey', i.second_key,
             'firstOption', i.first_option, 'secondOption', i.second_option,
             'cursorContractReady', i.cursor_contract_ready) ORDER BY i.name, i.oid)
             FROM (SELECT * FROM indexes i WHERE i.relation_oid = r.oid ORDER BY name, oid LIMIT 500) i), '[]'::jsonb)
         ) AS report
    FROM relations r
)
SELECT jsonb_build_object(
  'version', 'night-all-saved-records.source-audit.v1',
  'scope', jsonb_build_object(
    'catalogOnly', true, 'businessRowsRead', false, 'readOnly', current_setting('transaction_read_only') = 'on',
    'limitations', jsonb_build_array('Does not prove writer commit ordering, identity retention or deletion behavior.',
      'Does not measure business data, collection coverage, freshness or successful Hub ingestion.',
      'Reports the parent and direct children only. Nested descendants are not audited.',
      'Does not authorize index creation, source activation or checkpoint changes.'),
    'directPartitionLimit', 500, 'perRelationColumnLimit', 500, 'perRelationIndexLimit', 500),
  'database', current_database(), 'serverVersion', current_setting('server_version'),
  'serverVersionNumber', current_setting('server_version_num')::integer,
  'observedAt', transaction_timestamp(),
  'parentFound', EXISTS (SELECT 1 FROM parent),
  'status', CASE WHEN NOT EXISTS (SELECT 1 FROM parent) THEN 'parent_missing'
    WHEN EXISTS (SELECT 1 FROM parent WHERE relkind = 'p') THEN 'catalog_observed'
    ELSE 'parent_not_partitioned' END,
  'parent', (SELECT report FROM relation_reports WHERE is_parent),
  'directPartitionCount', (SELECT count(*) FROM children),
  'returnedPartitionCount', (SELECT count(*) FROM selected_children),
  'partitionsComplete', (SELECT count(*) <= 500 FROM children),
  'expectedColumnContract', (SELECT jsonb_agg(jsonb_build_object(
    'name', name, 'databaseType', database_type, 'nullable', nullable, 'optional', optional) ORDER BY name)
    FROM expected_columns),
  'partitions', COALESCE((SELECT jsonb_agg(report ORDER BY schema_name, table_name, oid)
    FROM relation_reports WHERE NOT is_parent), '[]'::jsonb)
) AS source_audit;
"""


FILE_LIMIT = 4 * 1024 * 1024
MIGRATION_LIMIT = 500
MARKERS = {
    "mentions_tender": r"[\"']tender[\"']",
    "mentions_incremental": r"\bincremental\b",
    "mentions_max_listing_pages": r"\bmax_listing_pages\b",
    "mentions_homepage_snapshot": r"\bhomepage_snapshot\b",
    "mentions_edition_version": r"\bedition_version\b",
    "assigns_observed_at_utcnow": r"observed_at\s*=\s*utcnow\(",
    "assigns_last_seen_at": r"(?:\.last_seen_at|last_seen_at)\s*=",
    "uses_record_advisory_lock": r"pg_try_advisory_xact_lock",
    "mentions_news_insert_only": r"News is insert-only",
    "mentions_saved_records_partition_ddl": r"PARTITION\s+OF\s+saved_records",
    "mentions_metric_partition_ddl": r"PARTITION\s+OF\s+record_metric_snapshots",
    "mentions_cursor_index_columns": r"last_seen_at\s*,\s*id",
    "declares_nullable_tag": r"tag[^\n]*nullable\s*=\s*True",
    "adds_tag_column": r"sa\.Column\([\"']tag[\"']",
    "uses_wall_clock_utcnow": r"datetime\.now\(timezone\.utc\)",
    "mentions_platform_database_url": r"PLATFORM_DATABASE_URL",
    "mentions_os_environment_lookup": r"(?:os\.getenv|os\.environ)",
    "mentions_cdc_or_change_journal": r"\b(?:CDC|change_journal|commit_order)\b",
}


def error_evidence(exc, stage):
    # Exception messages/repr may contain a DSN, query or file contents.
    value = {"stage": stage, "exceptionType": type(exc).__name__}
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(sqlstate, str) and re.fullmatch(r"[A-Z0-9]{5}", sqlstate):
        value["sqlstate"] = sqlstate
    return value


def inspect_file(path):
    result = {"path": str(path)}
    try:
        if path.is_symlink():
            return {**result, "status": "symlink_not_read"}
        with path.open("rb") as handle:
            data = handle.read(FILE_LIMIT + 1)
        if len(data) > FILE_LIMIT:
            return {**result, "status": "size_limit_exceeded", "limitBytes": FILE_LIMIT}
        text = data.decode("utf-8", errors="replace")
        return {**result, "status": "observed", "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data), "featureMarkers": [name for name, pattern in MARKERS.items()
                                                         if re.search(pattern, text, re.I)]}
    except FileNotFoundError:
        return {**result, "status": "missing"}
    except Exception as exc:
        return {**result, "status": "unavailable", "error": error_evidence(exc, "source_file")}


def file_evidence():
    fixed = [Path("/app/app") / name for name in
             ("source_types.py", "record_service.py", "models.py", "config.py")]
    fixed.append(Path("/app/collectors/browser/organization-web/collector.py"))
    directory = Path("/app/migrations/versions")
    try:
        migrations = sorted(directory.glob("*.py")) if directory.is_dir() else []
        migration_scope = {"directory": str(directory), "exists": directory.is_dir(),
                           "count": len(migrations), "limit": MIGRATION_LIMIT,
                           "complete": len(migrations) <= MIGRATION_LIMIT}
    except Exception as exc:
        migrations = []
        migration_scope = {"directory": str(directory), "complete": False,
                           "error": error_evidence(exc, "migration_files")}
    return {"scope": "Fixed source paths only. Marker presence is not execution or deployment proof.",
            "migrations": migration_scope,
            "files": [inspect_file(path) for path in fixed + migrations[:MIGRATION_LIMIT]]}


def connection_parameters(raw_url):
    from sqlalchemy.engine import make_url
    url = make_url(raw_url)
    if url.get_backend_name() != "postgresql":
        raise ValueError("unsupported_database_backend")
    values = url.translate_connect_args(username="user", database="dbname")
    # Do not forward options/service/search_path or arbitrary libpq parameters.
    # Explicit connection bounds and read-only policy cannot be overridden by URL query fields.
    permitted = {"sslmode", "sslrootcert", "sslcert", "sslkey", "sslpassword", "sslcrl", "sslcrldir",
                 "ssl_min_protocol_version", "ssl_max_protocol_version", "channel_binding", "gssencmode"}
    ignored_overrides = {"connect_timeout", "options", "application_name"}
    for key, value in url.query.items():
        if key in ignored_overrides:
            continue
        if key not in permitted or not isinstance(value, str):
            raise ValueError("unsupported_database_query_parameter")
        values[key] = value
    values.update(connect_timeout=5, application_name="mx-insight-hub-night-all-a-runtime-audit",
                  options="-c default_transaction_read_only=on -c statement_timeout=10000 "
                          "-c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000")
    return values, {"host": url.host, "port": url.port, "database": url.database}


def read_alembic(cursor):
    cursor.execute("""SELECT c.oid, c.relkind, EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
        WHERE a.attrelid=c.oid AND a.attname='version_num' AND NOT a.attisdropped
          AND t.typname IN ('varchar','text') AND t.typnamespace='pg_catalog'::regnamespace
      ) AS version_column_supported
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='alembic_version'""")
    row = cursor.fetchone()
    if row is None:
        return {"status": "missing", "versions": [], "limit": 20}
    if row[1] not in ("r", "p") or row[2] is not True:
        return {"status": "unsupported_schema", "oid": row[0], "limit": 20}
    cursor.execute("SELECT version_num::text FROM public.alembic_version ORDER BY version_num LIMIT 21")
    rows = cursor.fetchall()
    return {"status": "observed", "oid": row[0], "versions": [value[0] for value in rows[:20]],
            "limit": 20, "complete": len(rows) <= 20}


def database_evidence():
    result = {"configurationSource": "PLATFORM_DATABASE_URL_environment_candidate",
              "liveProcessDatabaseVerified": False, "hubConfiguredDatabaseVerified": False}
    raw_url = os.environ.get("PLATFORM_DATABASE_URL")
    if not raw_url:
        return {**result, "status": "configuration_missing"}
    connection = None
    stage = "configuration"
    try:
        parameters, location = connection_parameters(raw_url)
        result["candidateLocation"] = location
        stage = "driver_import"
        import psycopg
        stage = "connection"
        connection = psycopg.connect(**parameters, autocommit=True)
        with connection.cursor() as cursor:
            stage = "catalog"
            cursor.execute(SOURCE_AUDIT_SQL)
            report = None
            while True:
                if cursor.description and [column.name for column in cursor.description] == ["source_audit"]:
                    row = cursor.fetchone()
                    report = row[0] if row else None
                if not cursor.nextset():
                    break
            if isinstance(report, str):
                report = json.loads(report)
            if not isinstance(report, dict):
                raise RuntimeError("catalog_result_missing")
            # Keep mismatches, tag and every index detail, omit the routine full column listings.
            for relation in [report.get("parent"), *report.get("partitions", [])]:
                if isinstance(relation, dict):
                    relation.pop("columns", None)
            report["scope"]["ordinaryColumnListingsOmitted"] = True
            result["catalog"] = report
            stage = "connection_metadata"
            cursor.execute("SELECT inet_server_addr()::text, inet_server_port(), current_database(), "
                           "current_setting('transaction_read_only')")
            address, port, database, read_only = cursor.fetchone()
            result["observedConnection"] = {"serverAddress": address, "serverPort": port,
                                            "database": database, "transactionReadOnly": read_only}
            if read_only != "on":
                raise RuntimeError("read_only_transaction_required")
            stage = "migration_metadata"
            result["alembic"] = read_alembic(cursor)
            result["status"] = "observed"
    except Exception as exc:
        result["status"] = "unavailable"
        result["error"] = error_evidence(exc, stage)
    finally:
        if connection is not None:
            try:
                connection.rollback()
            except Exception as exc:
                result["status"] = "unavailable"
                result["rollbackError"] = error_evidence(exc, "rollback")
            try:
                connection.close()
            except Exception as exc:
                result["status"] = "unavailable"
                result["closeError"] = error_evidence(exc, "close")
    return result


def main():
    if sys.argv[1:] not in ([], ["--files-only"]):
        print(json.dumps({"version": "night-all-a.runtime-audit.v1", "status": "invalid_arguments"}))
        return 2
    report = {"version": "night-all-a.runtime-audit.v1", "scope": {
        "sourceFilesReadOnly": True, "businessRowsRead": False, "migrationMetadataMayBeRead": True,
        "provesWriterCommitOrdering": False, "provesCollectionCoverage": False,
        "provesLiveProcessConfiguration": False, "changesTasksOrCheckpoints": False},
        "sourceFiles": file_evidence()}
    report["database"] = {"status": "skipped_files_only"} if sys.argv[1:] else database_evidence()
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":"), default=str))
    return 1 if report["database"]["status"] in {"unavailable", "configuration_missing"} else 0


if __name__ == "__main__":
    sys.exit(main())
