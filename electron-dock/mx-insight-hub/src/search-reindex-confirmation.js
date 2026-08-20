export function canConfirmSearchReindex({
  confirmation,
  requiresBackendAcknowledgement = false,
  backendAcknowledged = false,
}) {
  return confirmation === 'REINDEX'
    && (!requiresBackendAcknowledgement || backendAcknowledged === true)
}
