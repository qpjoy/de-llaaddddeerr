import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyText, TOKENIZE_CURL_TEMPLATE } from '../../src/open-capabilities.js'
import { selectVisibleTenantId } from '../../src/tenant-scope.js'
import { CRAWLER_SOURCES } from '../../server/ingest/crawler/source-contract.mjs'

test('tenant deep links accept only visible tenant IDs and preserve intentional aggregate views', () => {
  const tenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }]
  assert.equal(selectVisibleTenantId(tenants, 'tenant-b'), 'tenant-b')
  assert.equal(selectVisibleTenantId(tenants, 'tenant-hidden'), 'tenant-a')
  assert.equal(selectVisibleTenantId(tenants, ''), 'tenant-a')
  assert.equal(selectVisibleTenantId(tenants, '', { aggregateWhenEmpty: true }), '')
  assert.equal(selectVisibleTenantId([], 'tenant-hidden'), '')
})

test('tokenize curl is paste-ready without putting an API key in history or argv', async () => {
  assert.match(TOKENIZE_CURL_TEMPLATE, /^\(\n/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /exec 3<\/dev\/tty \|\| exit \$\?/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /printf 'API Key: ' >&2/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /IFS= read -r -s -u 3 MX_INSIGHT_API_KEY/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /exec 3<&-/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /https:\/\/hub\.minsight-ai\.com/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /MX_INSIGHT_HUB_URL:-https:/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /curl --config -/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /unset MX_INSIGHT_API_KEY/)
  assert.match(TOKENIZE_CURL_TEMPLATE, /exit "\$MX_INSIGHT_CURL_STATUS"\n\)$/)
  assert.doesNotMatch(TOKENIZE_CURL_TEMPLATE, /mih_(?:live|test)_/)
  assert.doesNotMatch(TOKENIZE_CURL_TEMPLATE, /curl[^\n]*\$MX_INSIGHT_API_KEY/)

  const pages = await readFile(
    fileURLToPath(new URL('../../src/pages.jsx', import.meta.url)),
    'utf8',
  )
  assert.match(pages, /中文分词/)
  assert.match(pages, /复制 curl/)
  assert.match(pages, /滑动窗口内请求上限/)
  assert.match(pages, /现有 Key 只会被这里的变更收窄，不会因新增授权而静默扩权/)
  assert.match(pages, /调用者授权是上限，API Key 在签发时选择其中的平台与能力/)
  assert.match(pages, /新增能力需重新签发并显式勾选/)
  assert.match(pages, /配置开放能力/)
  assert.match(pages, /我已保存，配置开放能力/)
  assert.match(pages, /该 Key 只能调用签发时勾选、且调用者当前仍允许的范围/)
  assert.match(pages, /tenantId: issuedSecret\.tenantId, consumerId: issuedSecret\.consumerId/)
  assert.match(pages, /扩大范围请签发新 Key/)
  assert.match(pages, /套餐总额、调用者策略与 API Key 签发额度同时生效/)
  assert.match(pages, /上游连接器、供应商选择、健康、采购成本与游标绑定均由 Admin 内部治理/)
  assert.match(pages, /租户只看数据域、业务操作、兼容合同、费率与交付结果/)
  assert.match(pages, /查看该身份 API Key/)
  assert.match(pages, /ROUTING BOUNDARY[\s\S]*?Hub 内部路由/)
  assert.match(pages, /启用即允许该调用身份请求电商数据/)
  assert.match(pages, /PUBLIC GRANT[\s\S]*?ecommerce[\s\S]*?HUB OPERATION[\s\S]*?products\.search/)
  assert.match(pages, /平台身份属于合同语义/)
  assert.match(pages, /内部可聚合多个供应方/)
  const plansQuotasPage = pages.match(/export function PlansQuotasPage[\s\S]*?\nexport function PlatformsPage/u)?.[0] || ''
  assert.match(plansQuotasPage, /尚未配置费率/u)
  assert.match(plansQuotasPage, /当前不计费/u)
  assert.match(plansQuotasPage, /配置费率并发布/u)
  assert.match(plansQuotasPage, /下游费率尚未确定/u)
  assert.match(plansQuotasPage, /待运营定价/u)
  assert.match(plansQuotasPage, /计费单位是一次被 Hub 接受的逻辑请求，不按实际上游调用次数累加/u)
  assert.match(plansQuotasPage, /social\.posts\.search/u)
  assert.match(plansQuotasPage, /social\.posts\.resolve/u)
  assert.match(plansQuotasPage, /social\.users\.resolve/u)
  assert.match(plansQuotasPage, /social\.users\.posts/u)
  assert.match(plansQuotasPage, /正文补全和上游调用不另计/u)
  assert.match(plansQuotasPage, /账号解析、资料与笔记抓取等上游调用不另计/u)
  assert.match(plansQuotasPage, /entries: \[\{ meterKey: '', price: '' \}\]/u)
  assert.match(plansQuotasPage, /placeholder="输入合同价格"/u)
  assert.match(plansQuotasPage, /未知成本不能当作 0/u)
  assert.doesNotMatch(plansQuotasPage, /¥3\.20|¥0\.20|上游公开表价/u)
  const providerNeutralAuthorization = pages.match(/const PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION = \{[\s\S]*?\n\}/u)?.[0] || ''
  assert.match(providerNeutralAuthorization, /ecommerce/u)
  assert.doesNotMatch(providerNeutralAuthorization, /JustOne/u)
  const apiKeysPage = pages.match(/export function ApiKeysPage[\s\S]*?\nexport function PlatformsPage/u)?.[0] || ''
  assert.match(apiKeysPage, /每把 Key 在签发时固化平台与能力范围/u)
  assert.match(apiKeysPage, /Test · 兼容标签/u)
  assert.match(apiKeysPage, /key\.prefix\?\.startsWith\('mih_test_'\)/u)
  assert.match(apiKeysPage, /非沙箱；外部电商接口拒绝使用/u)
  assert.doesNotMatch(apiKeysPage, /<DropdownField label="环境"/u)
  assert.doesNotMatch(apiKeysPage, /value: 'test', label: 'Test'/u)
  assert.match(apiKeysPage, /签发替代 Key/u)
  assert.match(apiKeysPage, /environment: key\.environment === 'test' \|\| key\.prefix\?\.startsWith\('mih_test_'\) \? 'test' : 'live'/u)
  assert.match(apiKeysPage, /旧 Key 保持有效[\s\S]*?再撤销旧 Key/u)
  assert.match(apiKeysPage, /requestedScopes[\s\S]*?scopes\.platforms\.filter[\s\S]*?requestedScopes\.platforms/u)
  assert.match(apiKeysPage, /requestedScopes === 'legacy_all' \? scopes/u)
  assert.match(apiKeysPage, /\} : \{ platforms: \[\], capabilities: \[\] \}/u)
  assert.match(apiKeysPage, /新 Key 默认不包含任何平台或能力，也可保持零权限/u)
  assert.match(apiKeysPage, /disabled=\{saving \|\| scopeLoading\}/u)
  assert.doesNotMatch(apiKeysPage, /form\.platforms\.length === 0 && form\.capabilities\.length === 0/u)
  assert.match(apiKeysPage, /Field label="数据域 \/ 来源范围"/u)
  assert.match(apiKeysPage, /Field label="业务操作"/u)
  assert.match(apiKeysPage, /Field label="兼容接口合同"/u)
  assert.match(apiKeysPage, /compatibilityScopeOptions\.map/u)
  assert.match(apiKeysPage, /operationScopeOptions\.map/u)
  assert.match(apiKeysPage, /scopeMode !== 'legacy_dynamic'[\s\S]*?!rotationSource\.platforms\?\.includes/u)
  assert.match(apiKeysPage, /已切换并验证，撤销旧 Key/u)
  const platformsPage = pages.match(/export function PlatformsPage[\s\S]*?\nexport function UsagePage/u)?.[0] || ''
  assert.match(platformsPage, /session\?\.platformAdmin && session\?\.kind === 'admin-token'[\s\S]*?管理内部上游/u)
  assert.match(platformsPage, /title: '业务操作'/u)
  assert.match(platformsPage, /title: '兼容接口合同'/u)
  assert.match(platformsPage, /数据产品只是“数据域 \+ 业务操作”的权限组合/u)
  assert.match(platformsPage, /上游连接器[\s\S]*?Admin 内部治理/u)
  assert.match(platformsPage, /metadata\.group !== 'compatibility'/u)
  assert.match(platformsPage, /metadata\.group === 'compatibility'/u)
  assert.doesNotMatch(platformsPage, /provider=justone/u)
  assert.match(pages, /'source_catalog'/)
  assert.match(pages, /'mobile_commerce'/)
  assert.match(pages, /'virtual_supermarket'/)
  assert.match(pages, /'compat\.xiaohongshu\.app_v2'/)
  assert.match(pages, /'ecommerce\.products\.search'/)
  assert.match(pages, /'social\.posts\.search'/)
  assert.match(pages, /'social\.users\.resolve'/)
  assert.match(pages, /'social\.users\.posts'/)

  const components = await readFile(
    fileURLToPath(new URL('../../src/components.jsx', import.meta.url)),
    'utf8',
  )
  assert.match(components, /source_catalog:\s*'数据源目录'/)
  assert.match(components, /mobile_commerce:\s*'手机电商采集'/)
  assert.match(components, /virtual_supermarket:\s*'虚拟超市'/)
  for (const source of CRAWLER_SOURCES) {
    assert.ok(pages.includes(`'${source.platform}'`), `${source.platform} is selectable`)
    assert.match(
      components,
      new RegExp(`${source.platform}:\\s*'数据中心`, 'u'),
      `${source.platform} has an operator label`,
    )
  }
})

test('scoped tenant navigation exposes provider-neutral self-service and capability read/write by membership', async () => {
  const appSource = await readFile(
    fileURLToPath(new URL('../../src/App.jsx', import.meta.url)),
    'utf8',
  )
  const route = (path) => appSource.match(new RegExp(`\\{ path: '${path.replaceAll('/', '\\/')}',[^\\n]+\\}`, 'u'))?.[0] || ''

  assert.match(appSource, /\(!route\.platformAdmin \|\| session\.platformAdmin\)/u)

  for (const [path, capability] of [
    ['/consumers', 'consumer.read'],
    ['/api-keys', 'apikey.read'],
    ['/plans', 'consumer.read'],
    ['/platforms', 'consumer.read'],
    ['/usage', 'usage.read'],
    ['/data-products/xiaohongshu-note', 'apikey.read'],
  ]) {
    const entry = route(path)
    assert.ok(entry.includes(`capability: '${capability}'`), `${path} keeps ${capability}`)
    assert.doesNotMatch(entry, /platformAdmin: true|adminTokenOnly: true/u)
  }

  const externalRoute = route('/external-platforms')
  assert.match(externalRoute, /platformAdmin: true/u)
  assert.match(externalRoute, /adminTokenOnly: true/u)

  const pages = await readFile(
    fileURLToPath(new URL('../../src/pages.jsx', import.meta.url)),
    'utf8',
  )
  const consumersPage = pages.match(/export function ConsumersPage[\s\S]*?\nexport function ApiKeysPage/u)?.[0] || ''
  assert.match(consumersPage, /filter\(\(tenant\) => \([\s\S]*?tenantAllows\(session, tenant\.id, 'consumer\.read'\)/u)
  assert.match(consumersPage, /selectVisibleTenantId\(tenants, tenantId, \{ aggregateWhenEmpty: true \}\)/u)
  assert.match(consumersPage, /tenantId !== state\.data\.selectedTenantId[\s\S]*?setQuery\(\{ tenantId: state\.data\.selectedTenantId \|\| null \}\)/u)
  assert.match(consumersPage, /session\?\.platformAdmin \? <th>兼容业务 ID<\/th> : null/u)
  assert.match(consumersPage, /session\?\.platformAdmin && form\.businessId\.trim\(\)/u)

  const platformsPage = pages.match(/export function PlatformsPage[\s\S]*?\nexport function UsagePage/u)?.[0] || ''
  assert.match(platformsPage, /const hasPlatformWrite = tenantAllows\(session, selectedConsumer\?\.tenantId, 'platform\.write'\)/u)
  assert.match(platformsPage, /hasPlatformWrite \? \(/u)
  assert.match(platformsPage, /调用方只持有同一把 Hub API Key，不会看到或指定供应方/u)
  assert.match(pages, /const tenantId = selectVisibleTenantId\(safeTenants, requestedTenantId\)/u)
  assert.equal([...pages.matchAll(/tenantMismatch \|\| consumerMismatch/gu)].length, 2)
})

test('a whole-block paste works in bash and zsh without exposing its key', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'mx-tokenize-curl-'))
  const curlPath = join(fixtureDir, 'curl')
  await writeFile(curlPath, [
    '#!/bin/sh',
    'cat > "$MX_MOCK_CURL_CONFIG"',
    'printf \'%s\\n\' "$@" > "$MX_MOCK_CURL_ARGS"',
    "printf '__MOCK_CURL_RAN__\\n'",
    'exit 37',
    '',
  ].join('\n'), { mode: 0o700 })

  try {
    for (const shellName of ['bash', 'zsh']) {
      const shellPath = `/bin/${shellName}`
      const configPath = join(fixtureDir, `${shellName}-curl-config.txt`)
      const argsPath = join(fixtureDir, `${shellName}-curl-args.txt`)
      const secret = `mih_live_${shellName}_pty_secret_sentinel`
      const result = spawnSync('python3', [
        fileURLToPath(new URL('../helpers/pty-paste.py', import.meta.url)),
      ], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${fixtureDir}:${process.env.PATH}`,
          MX_PTY_SHELL: shellPath,
          MX_PTY_COMMAND_B64: Buffer.from(TOKENIZE_CURL_TEMPLATE).toString('base64'),
          MX_PTY_SECRET: secret,
          MX_MOCK_CURL_CONFIG: configPath,
          MX_MOCK_CURL_ARGS: argsPath,
        },
      })
      assert.equal(result.status, 0, `${shellName}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /__CURL_STATUS:37__/, shellName)
      assert.match(result.stdout, /__PARENT_KEY:unset__/, shellName)
      assert.match(result.stdout, /__PARENT_SHELL_ALIVE__/, shellName)
      assert.doesNotMatch(result.stdout, new RegExp(secret), shellName)

      const [config, args] = await Promise.all([
        readFile(configPath, 'utf8'),
        readFile(argsPath, 'utf8'),
      ])
      assert.equal(config, `header = "Authorization: Bearer ${secret}"\n`, shellName)
      assert.doesNotMatch(args, new RegExp(secret), shellName)
      assert.match(args, /https:\/\/hub\.minsight-ai\.com\/api\/v1\/tools\/tokenize/, shellName)
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('copyText falls back to execCommand on the HTTP-hosted Internal console', async () => {
  let appended = null
  let removed = false
  let selected = false
  const textarea = {
    value: '',
    style: {},
    setAttribute(name, value) {
      assert.equal(name, 'readonly')
      assert.equal(value, '')
    },
    select() { selected = true },
    remove() { removed = true },
  }
  const documentRef = {
    body: { appendChild(node) { appended = node } },
    createElement(tag) {
      assert.equal(tag, 'textarea')
      return textarea
    },
    execCommand(command) {
      assert.equal(command, 'copy')
      return true
    },
  }

  assert.equal(await copyText(TOKENIZE_CURL_TEMPLATE, {
    clipboard: { writeText: async () => { throw new Error('insecure context') } },
    documentRef,
  }), true)
  assert.equal(appended, textarea)
  assert.equal(textarea.value, TOKENIZE_CURL_TEMPLATE)
  assert.equal(selected, true)
  assert.equal(removed, true)
})
