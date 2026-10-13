import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { migrationArguments } from '../../scripts/migrate-web-search-credentials.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const providers = ['baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi']
const token = 'web-search-deploy-fixture-secret-at-least-32-bytes'

async function runHook(t, { failure = false, hasToken = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'web-search-deploy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const sourceUrl = 'postgresql://fixture:source-secret@127.0.0.1:5432/nightall'
  const sourceBindings = '{"exa":{"credentialProvider":"shared","credentialModule":"exa-search"}}'
  const scriptRoot = join(dir, 'Hub source with spaces')
  const result = spawnSync('bash', ['-c', `
    source "$1/scripts/manage.sh"
    ROOT_DIR="$WEB_SEARCH_TEST_ROOT"
    need() { [ "$1" = docker ]; }
    say() { printf '%s\\n' "$*"; }
    docker() {
      [ "$MX_INSIGHT_ADMIN_TOKEN" = "$WEB_SEARCH_TEST_TOKEN" ] || return 91
      printf '%s\\0' "$@" >> "$WEB_SEARCH_TEST_DIR/argv"
      printf '%s\\n' "$MX_INSIGHT_ADMIN_BASE_URL" "$NIGHT_ALL_DATABASE_URL" "$NIGHT_ALL_WEB_SEARCH_BINDINGS" > "$WEB_SEARCH_TEST_DIR/env"
      return "$WEB_SEARCH_TEST_EXIT"
    }
    curl() { return 92; }
    kubectl() { return 93; }
    node() { return 94; }
    ensure_web_search_supplier_credentials
    printf 'deploy-continues\\n'
  `, '_', root], {
    encoding: 'utf8', timeout: 10000,
    env: {
      ...process.env,
      WEB_SEARCH_TEST_DIR: dir, WEB_SEARCH_TEST_ROOT: scriptRoot,
      WEB_SEARCH_TEST_TOKEN: token, WEB_SEARCH_TEST_EXIT: failure ? '1' : '0',
      MX_INSIGHT_ADMIN_TOKEN: hasToken ? token : '',
      MX_INSIGHT_ADMIN_BASE_URL: 'https://unexpected-admin.example.test',
      MX_INSIGHT_IMAGE: 'mx-insight-hub:fixture',
      NIGHT_ALL_DATABASE_URL: sourceUrl,
      NIGHT_ALL_WEB_SEARCH_BINDINGS: sourceBindings,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token))
  assert.ok(!`${result.stdout}${result.stderr}`.includes(sourceUrl))
  assert.match(result.stdout, /deploy-continues/)
  const argv = await readFile(join(dir, 'argv'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  assert.ok(!argv.includes(token), 'Admin credential must travel only through the environment')
  assert.ok(!argv.includes(sourceUrl), 'Source database credential must travel only through the environment')
  return { result, argv: argv ? argv.split('\0').slice(0, -1) : [], dir, sourceUrl, sourceBindings, scriptRoot }
}

test('Web Search deploy hook pins loopback, reads SQL source and passes valid importer arguments without secrets', async t => {
  const { result, argv, dir, sourceUrl, sourceBindings, scriptRoot } = await runHook(t)
  assert.doesNotMatch(result.stdout, /WARNING/)
  assert.deepEqual(argv.slice(0, 9), ['run', '--rm', '--pull=never', '--network', 'host', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges'])
  assert.ok(argv.includes(`type=bind,source=${scriptRoot}/scripts,target=/app/scripts,readonly`))
  assert.ok(argv.includes('mx-insight-hub:fixture'))
  assert.ok(argv.includes('--entrypoint'))
  for (const variable of ['MX_INSIGHT_ADMIN_TOKEN', 'MX_INSIGHT_ADMIN_BASE_URL', 'NIGHT_ALL_DATABASE_URL', 'NIGHT_ALL_WEB_SEARCH_BINDINGS']) {
    assert.equal(argv[argv.indexOf(variable) - 1], '--env')
  }
  assert.equal(await readFile(join(dir, 'env'), 'utf8'), `http://127.0.0.1:18151\n${sourceUrl}\n${sourceBindings}\n`)
  const scriptIndex = argv.indexOf('/app/scripts/migrate-web-search-credentials.mjs')
  assert.ok(scriptIndex > 0)
  const options = migrationArguments(argv.slice(scriptIndex + 1))
  assert.deepEqual(options.providers, providers)
  assert.equal(options.dryRun, false)
  assert.equal(options.source, 'database')
  assert.equal(options.allowReadableConfig, false)
})

test('unavailable optional Web Search source warns once and does not block deployment', async t => {
  const { result, argv } = await runHook(t, { failure: true })
  assert.equal(argv.filter(arg => arg.endsWith('migrate-web-search-credentials.mjs')).length, 1, 'no automatic retry')
  assert.match(result.stdout, /WARNING: Web Search credential import incomplete/)
  assert.match(result.stdout, /Existing services remain available/)
})

test('Web Search deploy hook skips import without an Admin credential', async t => {
  const { result, argv } = await runHook(t, { hasToken: false })
  assert.deepEqual(argv, [])
  assert.doesNotMatch(result.stdout, /WARNING/)
})

test('internal deploy and apply import Web Search credentials after Facebook and before price seeding', async () => {
  const source = await readFile(join(root, 'scripts/manage.sh'), 'utf8')
  for (const action of ['deploy', 'apply']) {
    const branch = source.match(new RegExp(`^    ${action}\\)\\n([\\s\\S]*?)^      ;;`, 'm'))?.[1]
    assert.ok(branch, `${action} branch exists`)
    assert.match(branch, /ensure_facebook_supplier_credentials\s+ensure_web_search_supplier_credentials\s+seed_default_price_books/)
    assert.equal(branch.match(/ensure_web_search_supplier_credentials/g)?.length, 1)
  }
})
