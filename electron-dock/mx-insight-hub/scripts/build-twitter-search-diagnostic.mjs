import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const BUILDER_REVISION = 'twitter-search-stdin-bundle.v1'
const PARSER_IMPORT = "await import(new URL('hub-social.mjs', contracts))"
const ERROR_IMPORT = "import { AppError } from '../core/errors.mjs'"
const IMPLEMENTATION = "const DIAGNOSTIC_IMPLEMENTATION = { projectionImplementation: 'installed_hub_contract', parserSha256: null } // TWITTER_DIAGNOSTIC_IMPLEMENTATION"
const sha256 = source => createHash('sha256').update(source).digest('hex')
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

function replaceOnce(source, expected, replacement, reason) {
  if (source.split(expected).length !== 2) throw new Error(reason)
  return source.replace(expected, replacement)
}

// Refuse dependency drift instead of recursively bundling runtime gateways,
// adapters or other application modules into an operator diagnostic.
function exactImports(source, allowed, reason, { meta = false } = {}) {
  let remainder = source
  for (const statement of allowed) remainder = replaceOnce(remainder, statement, '', reason)
  if (meta) remainder = remainder.replaceAll('import.meta.url', '')
  if (/\bimport\b/.test(remainder) || /\bexport\s*(?:\*|\{)[\s\S]*?\bfrom\s*['"]/.test(remainder)) throw new Error(reason)
}

export function buildTwitterSearchDiagnostic({ diagnosticSource, parserSource, errorsSource }) {
  if ([diagnosticSource, parserSource, errorsSource].some(source => typeof source !== 'string' || !source || Buffer.byteLength(source) > 1024 * 1024)) {
    throw new Error('invalid_source')
  }
  exactImports(errorsSource, [], 'errors_dependencies_changed')
  exactImports(parserSource, ["import { createHash } from 'node:crypto'", ERROR_IMPORT], 'parser_dependencies_changed')
  const diagnosticWithoutParser = replaceOnce(diagnosticSource, PARSER_IMPORT, '', 'diagnostic_parser_import_changed')
  exactImports(diagnosticWithoutParser, ["import { createHash } from 'node:crypto'", "import { pathToFileURL } from 'node:url'", "import pg from 'pg'"], 'diagnostic_dependencies_changed', { meta: true })
  const bundledParser = replaceOnce(parserSource, ERROR_IMPORT, `import { AppError } from ${JSON.stringify(moduleUrl(errorsSource))}`, 'parser_errors_import_changed')
  const metadata = { projectionImplementation: 'bundled_local_candidate', parserSha256: sha256(parserSource),
    errorsSha256: sha256(errorsSource), diagnosticSourceSha256: sha256(diagnosticSource),
    bundledParserSha256: sha256(bundledParser), bundleBuilderRevision: BUILDER_REVISION }
  const withParser = replaceOnce(diagnosticSource, PARSER_IMPORT, `await import(${JSON.stringify(moduleUrl(bundledParser))})`, 'diagnostic_parser_import_changed')
  const source = '// Local candidate diagnostic; no runtime deployment, gateway or adapter is bundled.\n'
    + replaceOnce(withParser, IMPLEMENTATION, `const DIAGNOSTIC_IMPLEMENTATION = ${JSON.stringify(metadata)} // TWITTER_DIAGNOSTIC_IMPLEMENTATION`, 'diagnostic_implementation_marker_changed')
  return { source, metadata, bundleSha256: sha256(source) }
}

export function buildLocalTwitterSearchDiagnostic() {
  return buildTwitterSearchDiagnostic({
    diagnosticSource: readFileSync(new URL('../server/ops/diagnose-twitter-search.mjs', import.meta.url), 'utf8'),
    parserSource: readFileSync(new URL('../server/contracts/hub-social.mjs', import.meta.url), 'utf8'),
    errorsSource: readFileSync(new URL('../server/core/errors.mjs', import.meta.url), 'utf8'),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('invalid_arguments')
    const result = buildLocalTwitterSearchDiagnostic()
    process.stderr.write(`${JSON.stringify({ ...result.metadata, bundleSha256: result.bundleSha256, bundleBytes: Buffer.byteLength(result.source) })}\n`)
    process.stdout.write(result.source)
  } catch (error) {
    const reasons = new Set(['invalid_arguments', 'invalid_source', 'errors_dependencies_changed', 'parser_dependencies_changed',
      'diagnostic_parser_import_changed', 'diagnostic_dependencies_changed', 'parser_errors_import_changed', 'diagnostic_implementation_marker_changed'])
    process.stderr.write(`${JSON.stringify({ error: reasons.has(error.message) ? error.message : 'diagnostic_build_failed' })}\n`)
    process.exitCode = 1
  }
}
