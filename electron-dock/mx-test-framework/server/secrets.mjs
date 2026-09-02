import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

import { AppError } from './core/errors.mjs'

// The credentials a suite needs to sign into the application under test.
//
// Two design questions were open here, and the specs disagreed with each other.
//
// **How are they delivered?** ADR-0005 said environment variables; 13 §1.3
// item 13 said environment variables are unsafe and proposed mounted files.
// Environment variables win, for two reasons:
//
//   1. Every test framework already reads env — `Cypress.env()`,
//      `process.env`, `os.environ`. Requiring a file read means every suite
//      writes platform-specific code, which destroys the property that makes
//      this a platform at all.
//   2. For a local runner the file argument is backwards. A file *persists* on
//      someone's personal laptop after a crash; an environment dies with the
//      process that held it.
//
// The concern behind item 13 is real, so it is answered by the four things that
// actually matter rather than by the delivery mechanism:
//
//   · Secrets never appear in the Kubernetes Job manifest. Anyone who can run
//     `kubectl get job -o yaml` would otherwise read them. The container
//     fetches them at runtime using its run-scoped token instead.
//   · Secrets never enter the *shell's* environment inside the container —
//     only the test process's. See the exec wrapper in dispatcher.mjs.
//   · Values are redacted from results on ingest by exact match, which is far
//     stronger than the pattern matching in core/redact.mjs.
//   · Encrypted at rest, because the nightly pg_dump goes to object storage.

const ALGORITHM = 'aes-256-gcm'
const NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u

/**
 * The encryption key, or null when the platform is not configured to hold
 * secrets at all.
 *
 * Deliberately not derived from something convenient like the admin token: a
 * key that changes when an operator rotates their login makes every stored
 * secret unreadable, and the failure would surface as tests mysteriously
 * failing to log in.
 */
export function loadSecretKey(environment = process.env) {
  const raw = environment.MXT_SECRET_KEY?.trim()
  if (!raw) return null
  if (!/^[0-9a-f]{64}$/iu.test(raw)) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MXT_SECRET_KEY 必须是 64 位十六进制（32 字节）。生成：openssl rand -hex 32',
    )
  }
  return Buffer.from(raw, 'hex')
}

export function requireSecretKey(key) {
  if (!key) {
    // Fail closed. Storing a test account's password in plaintext because a
    // variable was missing is worse than refusing the request, and refusing is
    // visible at the moment someone sets it up rather than months later.
    throw new AppError(400, 'secrets_not_configured', '平台未配置 MXT_SECRET_KEY，无法保存密钥', {
      hint: '生成一个：openssl rand -hex 32，写入 .env.internal 的 MXT_SECRET_KEY 后重新部署。',
    })
  }
  return key
}

export function secretName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!NAME_PATTERN.test(name)) {
    throw new AppError(400, 'invalid_request', '密钥名只能是大写字母、数字和下划线，且以字母开头', {
      hint: '例如 LUOPAN_TEST_PASSWORD。它会作为环境变量名注入被测进程。',
    })
  }
  return name
}

export function encryptSecret(key, plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, requireSecretKey(key), iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptSecret(key, record) {
  const decipher = createDecipheriv(
    ALGORITHM,
    requireSecretKey(key),
    Buffer.from(record.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  // GCM authenticates: a wrong key or a tampered row throws here rather than
  // producing plausible-looking garbage that would be injected into a test.
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * The secrets a suite declared, as an environment map.
 *
 * A suite gets exactly what its `secretRefs` names and nothing else. A missing
 * one is an error rather than an omission: a run that silently starts without
 * the password it asked for fails somewhere inside a login form, and the
 * report says "element not found" instead of "the secret is not configured".
 */
export async function resolveSuiteSecrets({ store, key, suite, appId }) {
  const refs = Array.isArray(suite?.secretRefs) ? suite.secretRefs : []
  if (refs.length === 0) return {}

  const stored = await store.listSecrets(appId)
  const byName = new Map(stored.map((entry) => [entry.name, entry]))
  const resolved = {}
  const missing = []

  for (const ref of refs) {
    const record = byName.get(ref)
    if (!record) {
      missing.push(ref)
      continue
    }
    resolved[ref] = decryptSecret(key, record)
  }
  if (missing.length > 0) {
    throw new AppError(400, 'secret_missing', `缺少密钥：${missing.join('、')}`, {
      hint: `在应用的密钥库里设置它们，或从 suite 的 secretRefs 里去掉。`,
    })
  }
  return resolved
}

/**
 * Remove issued secret values from text, by exact match.
 *
 * This is the redaction that actually works. `core/redact.mjs` guesses from
 * shape — `Bearer ...`, `password=...` — and cannot catch a password that a
 * framework prints on its own terms ("login failed for user qa with hunter2").
 * Here the platform knows the exact strings it handed out, so it can remove
 * them wherever they turn up.
 *
 * Short values are skipped: redacting every occurrence of a three-character
 * password would corrupt unrelated text and make the report unreadable, which
 * is its own kind of failure.
 */
export function redactValues(text, values) {
  if (typeof text !== 'string' || !text) return text
  let output = text
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 6) continue
    output = output.split(value).join('[REDACTED_SECRET]')
  }
  return output
}

/** Constant-time compare, for anywhere a secret is checked rather than used. */
export function secretEquals(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
