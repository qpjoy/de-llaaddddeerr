import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyText, TOKENIZE_CURL_TEMPLATE } from '../../src/open-capabilities.js'

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
  assert.match(pages, /未来客户费率通过版本化订阅 \/ price book 生效/)
  assert.match(pages, /查看该身份 API Key/)
  assert.match(pages, /ROUTING BOUNDARY[\s\S]*?Hub 内部路由/)
  assert.match(pages, /当前运行时只有 JustOne 单候选，没有多供应商故障转移/)
  assert.match(pages, /第二家通过合同验证后[\s\S]*?派发前确定性选路/)
  assert.match(pages, /启用即允许该调用身份请求电商数据/)
  assert.match(pages, /可归一化的商品检索统一授权[\s\S]*?ecommerce/)
  assert.match(pages, /平台身份本身就是接口语义/)
  assert.match(pages, /内部可聚合多个供应方/)
  const providerNeutralAuthorization = pages.match(/const PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION = \{[\s\S]*?\n\}/u)?.[0] || ''
  assert.match(providerNeutralAuthorization, /ecommerce/u)
  assert.doesNotMatch(providerNeutralAuthorization, /JustOne/u)
  const apiKeysPage = pages.match(/export function ApiKeysPage[\s\S]*?\nexport function PlatformsPage/u)?.[0] || ''
  assert.match(apiKeysPage, /先选择调用者，再从其当前授权中勾选这把 Key 的不可变范围/u)
  assert.match(apiKeysPage, /Test · 兼容标签/u)
  assert.match(apiKeysPage, /key\.prefix\?\.startsWith\('mih_test_'\)/u)
  assert.match(apiKeysPage, /非沙箱；外部电商接口拒绝使用/u)
  assert.doesNotMatch(apiKeysPage, /<DropdownField label="环境"/u)
  assert.doesNotMatch(apiKeysPage, /value: 'test', label: 'Test'/u)
  const platformsPage = pages.match(/export function PlatformsPage[\s\S]*?\nexport function UsagePage/u)?.[0] || ''
  assert.match(platformsPage, /session\?\.platformAdmin && session\?\.kind === 'admin-token'[\s\S]*?管理内部上游/u)
  assert.doesNotMatch(platformsPage, /provider=justone/u)
  assert.match(pages, /'source_catalog'/)
  assert.match(pages, /'mobile_commerce'/)
  assert.match(pages, /'virtual_supermarket'/)

  const components = await readFile(
    fileURLToPath(new URL('../../src/components.jsx', import.meta.url)),
    'utf8',
  )
  assert.match(components, /source_catalog:\s*'数据源目录'/)
  assert.match(components, /mobile_commerce:\s*'手机电商采集'/)
  assert.match(components, /virtual_supermarket:\s*'虚拟超市'/)
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
