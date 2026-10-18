// Publish an MX Rig desktop build through Launcher's Release Center (docs/25 P2).
//
//   node scripts/release-publish.mjs status
//   node scripts/release-publish.mjs publish <installer> --install-id <id> [--install-id …] [--user-id <id> …]
//                                    [--notes <file>] [--from <version>]
//   node scripts/release-publish.mjs approve <planId> --smoke passed [--message <text>]
//   node scripts/release-publish.mjs reject  <planId> [--message <text>]
//   node scripts/release-publish.mjs promote <planId> [--notes <file>]
//
// The order Release Center expects, and the only one offered here:
//   1. publish   — upload one platform's installer (with its manifest) and
//                  create a plan for named installs only; its gate starts
//                  blocked, so nobody receives it yet;
//   2. approve   — after installing that file on a test machine yourself;
//                  the named installs then update through the app;
//   3. promote   — the same artifact for everyone, as a new plan (blocked);
//   4. approve   — that plan, once the targeted update went through.
//
// Runs where Launcher Internal is reachable from the inside (the Internal
// node), through scripts/manage.sh release, which passes the URL and the two
// credentials from the Secret mx-rig/mx-rig-release. Secrets are read from the
// environment only, never printed, never sent across a redirect.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { MANIFEST } from './launcher-plan.mjs'
import { readInstallerManifest } from './release-artifact.mjs'

const RELEASE = MANIFEST.release
const PRODUCT_ID = RELEASE.componentId

const args = process.argv.slice(2)
const command = args[0]
const subject = args[1] && !args[1].startsWith('--') ? args[1] : null
const option = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const options = (name) => args.flatMap((value, index) => (value === `--${name}` && args[index + 1] ? [args[index + 1]] : []))
const fail = (message) => {
  console.error(`[release] ${message}`)
  process.exit(2)
}
if (args.some((value) => /secret|token/i.test(value) && value.startsWith('--')))
  fail('credentials come from the environment only (MX_RIG_RELEASE_*_CLIENT_SECRET), never from arguments')
const base = (option('url') ?? process.env.MX_LAUNCHER_URL ?? '').replace(/\/+$/, '')
if (!['status', 'publish', 'approve', 'reject', 'promote'].includes(command) || !base)
  fail('usage: release-publish.mjs status | publish <installer> --install-id <id> | approve <planId> --smoke passed | reject <planId> | promote <planId>   (MX_LAUNCHER_URL or --url)')

const short = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)

async function call(method, path, { token, body, headers = {}, timeoutMs = 30_000 } = {}) {
  const answer = await fetch(`${base}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof ReadableStream) ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body instanceof ReadableStream ? body : body ? JSON.stringify(body) : undefined,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {})
  })
  const text = await answer.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {}
  if (!answer.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${answer.status} ${String(payload?.message ?? text).slice(0, 300)}`)
  return payload
}

/** A short-lived token for one role; the secret goes in the body, once. */
async function tokenFor(role) {
  const publisher = role === 'publisher'
  const prefix = publisher ? 'MX_RIG_RELEASE' : 'MX_RIG_RELEASE_APPROVER'
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim() || (publisher ? RELEASE.publisher : RELEASE.approver)
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim()
  if (!clientSecret)
    fail(`no ${role} credential (${prefix}_CLIENT_SECRET); scripts/manage.sh launcher apply keeps it in Secret mx-rig/mx-rig-release`)
  const payload = await call('POST', '/internal/v1/sdk/oauth/token', {
    body: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: 'mx-sdk',
      scope: publisher ? 'sdk.release.read sdk.release.publish' : 'sdk.release.read sdk.release.approve'
    }
  })
  const token = payload?.token?.access_token ?? payload?.access_token
  if (!token) throw new Error(`Launcher issued no ${role} token`)
  return token
}

const readPlan = async (token, planId) => {
  const payload = await call('GET', `/internal/v1/sdk/releases/${encodeURIComponent(planId)}`, { token })
  return payload?.plan ?? payload?.release
}
const describe = (plan) => {
  const artifact = plan.artifacts?.find((entry) => entry.kind === 'app-installer') ?? plan.artifacts?.[0] ?? {}
  const audience = plan.rollout?.audience ?? {}
  const named = [...(audience.installIds ?? []).map((id) => `install ${id}`), ...(audience.userIds ?? []).map((id) => `user ${id}`)]
  return {
    version: plan.components?.launcher?.targetVersion ?? artifact.version ?? '?',
    target: `${artifact.platform ?? '?'}-${artifact.arch ?? '?'}`,
    audience: named.length ? named.join(', ') : `everyone (${plan.rollout?.percentage ?? 100}%)`,
    gate: plan.test?.gate?.verdict ?? '?',
    artifact
  }
}
const notes = async () => {
  const file = option('notes')
  return file ? (await readFile(file, 'utf8')).trim() || null : null
}

if (command === 'status') {
  const token = await tokenFor('publisher')
  const resolved = await call('GET', `/internal/v1/releases/products/resolve?${new URLSearchParams({ packageName: RELEASE.packageName, channel: RELEASE.channel })}`).catch((error) => ({ error }))
  console.log(`MX Rig in Release Center at ${base}`)
  console.log(`  identity: ${resolved.error ? `not resolvable (${resolved.error.message})` : `${RELEASE.packageName} → ${resolved.identity?.productId} / ${resolved.identity?.channel}`}`)
  const plans = ((await call('GET', `/internal/v1/sdk/releases?productId=${PRODUCT_ID}`, { token }))?.plans ?? [])
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 12)
  if (!plans.length) console.log('  no plans yet')
  for (const plan of plans) {
    const seen = describe(plan)
    console.log(`  ${plan.planId}  ${seen.version}  ${seen.target}  gate ${seen.gate}  → ${seen.audience}  (${plan.createdAt})`)
  }
  process.exit(0)
}

if (command === 'publish') {
  if (!subject) fail('publish needs the installer path')
  const installIds = options('install-id')
  const userIds = options('user-id')
  // Everyone only through promote, after a targeted plan went through.
  if (!installIds.length && !userIds.length)
    fail('a new build goes to named installs first: --install-id <id> (shown under 检查更新 in the desktop) or --user-id <id>; then approve and promote')
  const manifest = await readInstallerManifest(subject)
  const sha = manifest.digest.slice('sha256:'.length)
  const releaseId = `${PRODUCT_ID}-${manifest.platform}-${manifest.arch}-${manifest.version}-${sha.slice(0, 12)}`
  const token = await tokenFor('publisher')
  const query = new URLSearchParams({
    productId: PRODUCT_ID,
    releaseId,
    kind: 'app-installer',
    version: manifest.version,
    componentId: PRODUCT_ID,
    fileName: manifest.fileName,
    digest: manifest.digest,
    platform: manifest.platform,
    arch: manifest.arch,
    channel: RELEASE.channel
  })
  console.log(`[release] uploading ${manifest.fileName} (${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MiB, ${manifest.platform}-${manifest.arch} ${manifest.version})`)
  const uploaded = await call('POST', `/internal/v1/sdk/releases/artifacts?${query}`, {
    token,
    body: Readable.toWeb(createReadStream(subject)),
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(manifest.sizeBytes) },
    timeoutMs: 30 * 60_000
  })
  const artifactId = uploaded?.artifact?.artifactId
  if (!artifactId) throw new Error('Release Center returned no artifactId')
  const releaseNotes = await notes()
  const from = option('from') ?? '0.0.0'
  // The same request again is the same plan (Release Center replays it); a
  // different audience or notes is a new one.
  const request = { installIds: [...installIds].sort(), userIds: [...userIds].sort(), releaseNotes, from }
  const created = await call('POST', '/internal/v1/sdk/releases', {
    token,
    body: {
      artifactId,
      currentVersion: from,
      deliveryMode: 'prompt-download-restart',
      releaseNotes,
      targetInstallIds: installIds,
      targetUserIds: userIds,
      rolloutStrategy: 'manual-ring',
      rolloutPercentage: 0,
      suiteId: 'mx-rig-installer',
      topology: `mx-rig-${manifest.platform}-${manifest.arch}`,
      sites: ['internal-main'],
      requestId: `${releaseId}-targeted-${short(JSON.stringify(request))}`
    }
  })
  const plan = created?.plan ?? created?.release
  console.log(`[release] plan ${plan.planId} for ${describe(plan).audience}${created?.idempotent ? ' (already there)' : ''}; gate blocked until approved`)
  console.log(`[release] next: install ${manifest.fileName} on a test machine yourself, then`)
  console.log(`          scripts/manage.sh release approve ${plan.planId} --smoke passed`)
  process.exit(0)
}

if (command === 'approve' || command === 'reject') {
  if (!subject) fail(`${command} needs a plan ID`)
  if (command === 'approve' && option('smoke') !== 'passed')
    fail('approve only after installing and starting that build yourself: --smoke passed')
  const token = await tokenFor('approver')
  const plan = await readPlan(token, subject)
  const seen = describe(plan)
  const targeted = /-full-after-(.+)$/.exec(plan.requestId ?? '')?.[1] ?? null
  const status = command === 'approve' ? 'passed' : 'failed'
  const updated = await call('POST', `/internal/v1/sdk/releases/${encodeURIComponent(subject)}/gate`, {
    token,
    body: {
      status,
      message: option('message') ?? `MX Rig ${seen.version} ${seen.target}: ${command === 'approve' ? 'installed and started on a test machine' : 'rejected'}`,
      evidence: {
        artifactId: seen.artifact.artifactId ?? null,
        artifactDigest: seen.artifact.digest ?? null,
        installSmoke: command === 'approve' ? 'passed' : 'failed',
        ...(targeted ? { targetedPlanId: targeted } : {}),
        recordedBy: 'mx-rig-manage'
      },
      requestId: `${subject}-gate-${status}`
    }
  })
  const after = updated?.plan ?? updated?.release ?? plan
  console.log(`[release] ${subject}: gate ${describe(after).gate} → ${seen.audience}`)
  const named = plan.rollout?.audience?.installIds?.length || plan.rollout?.audience?.userIds?.length
  if (command === 'approve' && named)
    console.log(`[release] next: let the named installs update through 检查更新, then scripts/manage.sh release promote ${subject}`)
  process.exit(0)
}

if (command === 'promote') {
  if (!subject) fail('promote needs the targeted plan ID')
  const token = await tokenFor('publisher')
  const plan = await readPlan(token, subject)
  const seen = describe(plan)
  const audience = plan.rollout?.audience ?? {}
  if (!(audience.installIds?.length || audience.userIds?.length)) fail(`${subject} is already for everyone`)
  if (seen.gate !== 'passed') fail(`${subject} is not approved yet (gate ${seen.gate})`)
  if (!seen.artifact.artifactId) throw new Error(`${subject} has no artifact`)
  const created = await call('POST', '/internal/v1/sdk/releases', {
    token,
    body: {
      artifactId: seen.artifact.artifactId,
      currentVersion: plan.components?.launcher?.currentVersion ?? '0.0.0',
      deliveryMode: 'prompt-download-restart',
      releaseNotes: (await notes()) ?? plan.releaseNotes ?? null,
      rolloutStrategy: 'all',
      rolloutPercentage: 100,
      suiteId: plan.test?.suiteId ?? 'mx-rig-installer',
      topology: plan.test?.topology ?? `mx-rig-${seen.target}`,
      sites: plan.test?.sites?.length ? plan.test.sites : ['internal-main'],
      requestId: `${PRODUCT_ID}-${seen.version}-${seen.target}-full-after-${subject}`
    }
  })
  const full = created?.plan ?? created?.release
  console.log(`[release] plan ${full.planId} for everyone${created?.idempotent ? ' (already there)' : ''}; gate blocked until approved`)
  console.log(`[release] next: scripts/manage.sh release approve ${full.planId} --smoke passed`)
  process.exit(0)
}
