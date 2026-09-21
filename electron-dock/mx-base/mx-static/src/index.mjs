import { readFileSync } from 'node:fs'
import { createStaticService } from './service.mjs'
import { planCapacity } from './capacity.mjs'
import { resolveConfig } from './config.mjs'
import { Settings } from './settings.mjs'

const readSecret = (name) => process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : process.env[name]
const fatal = (message) => { console.error(`mx-static cannot start: ${message}`); process.exit(1) }

const stateDir = process.env.MX_STATIC_STATE_DIR || '/state'
const readOnly = process.env.MX_STATIC_READ_ONLY === 'true'

// Credentials are the only genuinely fatal configuration: without them nothing
// can be authorised. Every tunable degrades to a default instead.
let projects, signingKey
try { projects = JSON.parse(readSecret('MX_STATIC_PROJECTS') || '{}') } catch { fatal('MX_STATIC_PROJECTS is not valid JSON') }
try { signingKey = readSecret('MX_STATIC_SIGNING_KEY') } catch (error) { fatal(`the signing key could not be read (${error.code || error.message})`) }
if (!signingKey || signingKey.length < 32) fatal('a signing key of at least 32 characters is required')
if (!projects || !Object.keys(projects).length) fatal('at least one project credential is required')
let adminToken = ''
try { adminToken = readSecret('MX_STATIC_ADMIN_TOKEN') || '' } catch { console.error('admin token unreadable; the settings console stays disabled') }
if (adminToken && adminToken.length < 32) { console.error('admin token is shorter than 32 characters; the settings console stays disabled'); adminToken = '' }

// The reader opens the settings store read-only. If the writer has not created
// it yet the service still starts; it simply has no runtime overrides.
let settings = null
try { settings = new Settings(stateDir, { readOnly }) }
catch (error) { console.error(`settings store unavailable (${error.code || error.message}); using .env only`) }

const { values, warnings } = resolveConfig(process.env, settings ? settings.read() : {})
for (const warning of warnings) console.error(`config warning: ${warning}`)
const capacity = planCapacity({
  assetQps: values.assetQps, assetP95Ms: values.assetP95Ms, assetSizeKb: values.assetSizeKb,
  videoViewers: values.videoViewers, videoBitrateKbps: values.videoBitrateKbps, burst: values.burst,
  linkMbps: values.linkMbps, diskReadMbps: values.diskReadMbps, utilisation: values.utilisation / 100,
})
console.log(JSON.stringify({ capacity: { slo: capacity.slo, limits: capacity.limits, budget: capacity.budget }, settingsConsole: Boolean(adminToken) }))
for (const warning of capacity.warnings) console.error(`capacity warning: ${warning}`)
if (!capacity.feasible && values.capacityStrict) fatal('the declared service level does not fit the declared hardware (MX_STATIC_CAPACITY_STRICT is on)')

const server = createStaticService({
  root: process.env.MX_STATIC_DATA_DIR || '/data',
  stateDir, settings, readOnly, adminToken, projects, signingKey,
  env: process.env,
  writerUrl: process.env.MX_STATIC_WRITER_URL || '',
})
server.listen(Number(process.env.PORT || 18200), '0.0.0.0', () => console.log('mx-static ready'))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  setTimeout(() => process.exit(1), 35_000).unref()
  const drained = new Promise(resolve => server.close(resolve))
  await server.shutdown()
  await drained
  settings?.close()
  process.exit(0)
})
