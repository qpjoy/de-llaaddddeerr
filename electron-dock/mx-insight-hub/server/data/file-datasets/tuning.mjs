// Built-in import tuning shared by every file dataset (no env keys).
// Measured on the shared Internal PostgreSQL; see
// docs/architecture/file-datasets.md.
export const IMPORT_BATCH_PAIRS = 50_000
export const IMPORT_READ_CHUNK_BYTES = 8 * 1024 * 1024
// Pacing keeps the shared disk and WAL calm while Hub serves traffic.
export const IMPORT_TARGET_ROWS_PER_SECOND = 25_000
export const IMPORT_SLOW_COMMIT_MS = 3_000
export const SHA_MAX_BYTES_PER_SECOND = 200 * 1024 * 1024
