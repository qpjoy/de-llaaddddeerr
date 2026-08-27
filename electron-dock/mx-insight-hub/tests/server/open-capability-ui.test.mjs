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
  assert.match(pages, /同一调用者的所有 API Key 共享请求上限/)
  assert.match(pages, /'source_catalog'/)

  const components = await readFile(
    fileURLToPath(new URL('../../src/components.jsx', import.meta.url)),
    'utf8',
  )
  assert.match(components, /source_catalog:\s*'数据源目录'/)
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
