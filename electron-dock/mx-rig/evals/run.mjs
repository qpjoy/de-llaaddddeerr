#!/usr/bin/env node
// npm run eval -- [--live [--settings <settings.json> | --database-url <url>]] [--repeat N]
//                  [--only id,id] [--out file.json] [--min-success 0.8]
//
// Scripted (default): each scenario's own script plays the model. It checks
// the runtime, the tools and the scoring — the numbers say nothing about any
// model. Live: the Provider chain from a settings file (the server's own
// `<state dir>/settings.json` works; it is copied, never written) with the API
// keys from this shell's environment.

import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  liveModel,
  loadScenarios,
  renderMarkdown,
  runOnce,
  scriptedModel,
  summarize
} from './harness.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    settings: { type: 'string' },
    'database-url': { type: 'string' },
    repeat: { type: 'string' },
    only: { type: 'string', default: '' },
    out: { type: 'string' },
    'min-success': { type: 'string' },
    timeout: { type: 'string', default: '180' }
  }
})

const scenarios = await loadScenarios(join(here, 'scenarios'), {
  only: values.only.split(',').filter(Boolean)
})
if (!scenarios.length) {
  console.error('没有匹配的场景')
  process.exit(2)
}
const repeat = Math.max(1, Number(values.repeat ?? (values.live ? 5 : 1)))

const { Settings } = await import('../apps/server/settings.mjs')
let settings
if (values.live) {
  const copy = join(await mkdtemp(join(tmpdir(), 'mx-rig-eval-settings-')), 'settings.json')
  const databaseUrl =
    values['database-url'] ?? (values.settings ? null : process.env.MX_RIG_DATABASE_URL)
  if (databaseUrl) {
    // A shared deployment keeps settings in PostgreSQL. Read once, never write.
    const { default: pg } = await import('pg')
    const { PgDocument } = await import('../apps/server/state-documents.mjs')
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
    const { value } = await new PgDocument(pool, 'settings').load().finally(() => pool.end())
    if (!value) {
      console.error('数据库里还没有设置')
      process.exit(2)
    }
    await writeFile(copy, JSON.stringify(value))
  } else {
    const source = values.settings ?? join(process.env.MX_RIG_STATE_DIR ?? '', 'settings.json')
    await copyFile(source, copy).catch(() => {
      console.error(`读不到 ${source}；用 --settings 指向 settings.json，或用 --database-url`)
      process.exit(2)
    })
  }
  settings = await new Settings(copy).init()
  if (!settings.chain().length) {
    console.error('这份设置里没有可用的 Provider')
    process.exit(2)
  }
} else
  settings = await new Settings(
    join(await mkdtemp(join(tmpdir(), 'mx-rig-eval-')), 's.json')
  ).init()
const { ModelGateway } = values.live ? await import('../apps/server/model.mjs') : {}

let browserFactory = null
if (scenarios.some((scenario) => scenario.site)) {
  const { chromium } = await import('playwright')
  const { BrowserTools } = await import('../packages/runtime/browser.mjs')
  const launcher = {
    launch: (options) => chromium.launch({ ...options, headless: true, channel: 'chromium' })
  }
  const probe = await launcher.launch({}).catch(() => null)
  if (probe) {
    await probe.close()
    browserFactory = (root) => new BrowserTools(root, launcher, { headless: true })
  } else console.error('Chromium 未安装（npm run browser:install），页面场景将记为失败')
}

const runs = []
for (const scenario of scenarios)
  for (let i = 0; i < repeat; i += 1) {
    const result = await runOnce(scenario, {
      modelFor: (bound) =>
        values.live
          ? liveModel(settings, (view) => new ModelGateway(view), bound.policy?.allowedTools ?? [])
          : scriptedModel(bound.script),
      browserFactory,
      agents: settings.value.agents.filter((agent) => agent.enabled !== false),
      timeoutMs: Number(values.timeout) * 1000
    })
    runs.push(result)
    const failed = result.checks.filter((entry) => !entry.ok).map((entry) => entry.name)
    console.error(
      `${result.ok ? '✓' : '✗'} ${scenario.id} #${i + 1} ${result.status} ${result.turns} 轮 ${
        result.tokens
      } tokens${result.error ? ` 异常：${result.error}` : ''}${failed.length ? ` 失分：${failed.join('，')}` : ''}`
    )
  }

const summary = summarize(runs)
const model = values.live ? `live · ${settings.chain()[0].model}` : 'scripted'
console.log(renderMarkdown(summary, { model }))
if (values.out)
  await writeFile(values.out, `${JSON.stringify({ model, summary, runs }, null, 2)}\n`)
const floor = Number(values['min-success'] ?? (values.live ? 0 : 1))
process.exit(summary.successRate >= floor ? 0 : 1)
