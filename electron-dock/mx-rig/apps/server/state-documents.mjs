import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RigError } from '../../packages/contracts/index.mjs'

/**
 * Where a small control-plane document lives: a JSON file next to a single
 * process, or a row in PostgreSQL shared by every replica.
 *
 * Both answer the same three questions — what is stored, which version is it,
 * and "save this, but only if nobody saved since version N". The file backend
 * has one writer by construction, so its version is a local counter; the
 * database backend makes the check real, which is what lets two replicas edit
 * the same settings without one silently erasing the other.
 */

export class DocumentConflict extends RigError {
  constructor() {
    super('document_conflict', '内容已被其他人修改，请刷新后重试', 409)
  }
}

export class FileDocument {
  constructor(file) {
    this.file = file
    this.version = 0
    this.queue = Promise.resolve()
  }
  get shared() {
    return false
  }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      return { value, version: this.version }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { value: null, version: this.version }
    }
  }
  /** One process owns the file, so nothing else can have moved the version. */
  async latestVersion() {
    return this.version
  }
  async save(value, expectVersion = this.version) {
    if (expectVersion !== this.version) throw new DocumentConflict()
    const json = JSON.stringify(value, null, 2)
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, json, { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = operation.catch(() => {})
    await operation
    this.version += 1
    return this.version
  }
}

export class PgDocument {
  constructor(pool, key) {
    this.pool = pool
    this.key = key
  }
  get shared() {
    return true
  }
  async load() {
    const { rows } = await this.pool.query('SELECT doc, version FROM rig_state WHERE key = $1', [
      this.key
    ])
    return rows[0] ? { value: rows[0].doc, version: rows[0].version } : { value: null, version: 0 }
  }
  async latestVersion() {
    const { rows } = await this.pool.query('SELECT version FROM rig_state WHERE key = $1', [
      this.key
    ])
    return rows[0]?.version ?? 0
  }
  /**
   * Version 0 means "nothing stored yet": the insert only succeeds if that is
   * still true, so two replicas initialising the same document cannot both win.
   */
  async save(value, expectVersion) {
    const doc = JSON.stringify(value)
    const { rows } =
      expectVersion === 0
        ? await this.pool.query(
            `INSERT INTO rig_state (key, doc, version) VALUES ($1, $2::jsonb, 1)
             ON CONFLICT (key) DO NOTHING RETURNING version`,
            [this.key, doc]
          )
        : await this.pool.query(
            `UPDATE rig_state SET doc = $2::jsonb, version = version + 1, updated_at = now()
             WHERE key = $1 AND version = $3 RETURNING version`,
            [this.key, doc, expectVersion]
          )
    if (!rows[0]) throw new DocumentConflict()
    return rows[0].version
  }
}

/** A path keeps the old single-file behaviour; anything else is already a document. */
export function documentFor(source) {
  return typeof source === 'string' ? new FileDocument(source) : source
}
