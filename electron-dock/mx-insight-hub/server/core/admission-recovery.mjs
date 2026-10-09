// All SQL inputs here are source-owned identifiers/parameter placeholders.
// Resets change admission windows only; accounting never uses this predicate.
export function quotaRecoverySql(kind, target, scopeType = "''", scopeKey = "''") {
  return `AND request.reserved_at > coalesce((SELECT max(recovery.created_at)
    FROM control.admission_recoveries recovery WHERE recovery.kind = '${kind}'
      AND recovery.target = ${target}::uuid::text AND recovery.scope_type = ${scopeType}
      AND recovery.scope_key = ${scopeKey}), '-infinity'::timestamptz)`
}

export function quarantineRecoverySql(alias = 'call') {
  return `AND NOT EXISTS (SELECT 1 FROM control.admission_recoveries recovery
    WHERE recovery.kind = 'response_quarantine' AND recovery.target = ${alias}.id::text)`
}

