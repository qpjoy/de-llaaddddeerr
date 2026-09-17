import { AppError } from '../core/errors.mjs'

// A relay base is a place to send the request, not a proxy URL. The upstream
// path and query string are appended to it verbatim, so it carries no query and
// no fragment, and it never carries credentials.
export function normalizeRelayBase(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  let url
  try { url = new URL(text) } catch { return undefined }
  if (!['http:', 'https:'].includes(url.protocol)) return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

// A binary deployed ahead of migration 096 must keep serving, so a missing
// table falls back to the environment rather than failing every query.
function relayTableMissing(error) {
  return error?.code === '42P01'
}

export class ExternalPlatformEgressRelayStore {
  constructor(pool, { providerKey = 'qixin', environmentFallback = '' } = {}) {
    this.pool = pool
    this.providerKey = providerKey
    this.environmentFallback = normalizeRelayBase(environmentFallback) || ''
  }

  async #row() {
    const { rows } = await this.pool.query(
      `SELECT enabled, relay_base, revision, updated_at
         FROM control.external_platform_egress_relays WHERE provider_key = $1`,
      [this.providerKey],
    )
    return rows[0] || null
  }

  // Read on every dispatch so a save takes effect without a restart, the same
  // contract as the System Proxy binding. A stored row is authoritative: once
  // migration 096 is applied, the environment no longer decides anything.
  async relayBase() {
    let row
    try { row = await this.#row() } catch (error) {
      if (!relayTableMissing(error)) throw error
      return this.environmentFallback
    }
    if (!row) return this.environmentFallback
    return row.enabled && row.relay_base ? row.relay_base : ''
  }

  async describe() {
    let row = null
    try { row = await this.#row() } catch (error) { if (!relayTableMissing(error)) throw error }
    return {
      providerKey: this.providerKey,
      enabled: row?.enabled === true,
      relayBase: row?.relay_base || null,
      revision: Number(row?.revision ?? 0),
      updatedAt: row?.updated_at ?? null,
      environmentFallback: this.environmentFallback || null,
      effectiveBase: (await this.relayBase()) || null,
      migrated: Boolean(row),
    }
  }

  async update(input) {
    const { enabled, relayBase = null, expectedRevision, reason } = input || {}
    const normalized = enabled ? normalizeRelayBase(relayBase) : null
    if (typeof enabled !== 'boolean'
      || (enabled && !normalized)
      || (!enabled && relayBase !== null && String(relayBase).trim() !== '')
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
      throw new AppError(400, 'invalid_egress_relay',
        'Valid mode, an absolute relay base without query or credentials, revision and reason are required')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `UPDATE control.external_platform_egress_relays
            SET enabled=$1, relay_base=$2, revision=revision+1, reason=$3, updated_at=now()
          WHERE provider_key=$4 AND revision=$5 RETURNING revision`,
        [enabled, normalized, reason.trim(), this.providerKey, expectedRevision],
      )
      if (!result.rowCount) {
        throw new AppError(409, 'egress_relay_revision_conflict', 'Egress settings changed; refresh before saving')
      }
      await client.query(
        `INSERT INTO control.external_platform_egress_relay_events
           (provider_key,revision,enabled,relay_base,actor,reason)
         VALUES ($1,$2,$3,$4,'admin-token',$5)`,
        [this.providerKey, result.rows[0].revision, enabled, normalized, reason.trim()],
      )
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
    return this.describe()
  }
}
