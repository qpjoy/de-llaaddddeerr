#!/usr/bin/env node
// npm run pack:cli [-- --out <dir>]
//
// `mx-rig` as a package of its own: the terminal Agent and the station, with
// only what they import. An engineer installs it with
//
//   npm install -g ./qpjoy-mx-rig-cli-<version>.tgz
//
// and never needs this repository, Electron or the server. The file list is
// not written down anywhere: it is the import graph of the entry points, so a
// module the CLI starts using is packed without anyone remembering to.

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const ENTRIES = ['bin/mx-rig.mjs', 'apps/terminal/cli.mjs', 'apps/terminal/station.mjs']
// What the packed code may import from npm; anything else is a packing error.
const RUNTIME_DEPENDENCIES = ['playwright', 'zod']

/**
 * Every module reachable from the entries, the packages they import, and the
 * files they read beside themselves (`new URL('./x', import.meta.url)`) —
 * the replay player and its stylesheet, for one.
 */
export async function importGraph(base = root, entries = ENTRIES) {
  const files = new Set()
  const packages = new Set()
  const assets = new Set()
  const beside = /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g
  // Real import statements only: at the start of a line, or a dynamic import
  // of a literal. A spec template that *contains* an import line is a string.
  // Between the keyword and `from` there can only be names, braces, commas,
  // `*` and whitespace — which also keeps a match from running into a string.
  const statement =
    /^\s*(?:import|export)\s+(?:type\s+)?[\w$*{},\s]*?\s*\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
  const dynamic = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  const visit = async (file) => {
    if (files.has(file)) return
    files.add(file)
    const text = await readFile(join(base, file), 'utf8')
    const specifiers = [
      ...[...text.matchAll(statement)].map((match) => match[1] ?? match[2]),
      ...[...text.matchAll(dynamic)].map((match) => match[1])
    ]
    for (const [, path] of text.matchAll(beside)) {
      const asset = relative(base, resolve(base, dirname(file), path))
      if ((await stat(join(base, asset)).catch(() => null))?.isFile()) assets.add(asset)
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('.'))
        await visit(relative(base, resolve(base, dirname(file), specifier)))
      else packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
    }
  }
  for (const entry of entries) await visit(entry)
  return {
    files: [...files].sort(),
    packages: [...packages].sort(),
    assets: [...assets].filter((asset) => !files.has(asset)).sort()
  }
}

async function pack({ out }) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const { files, packages, assets } = await importGraph()
  const unexpected = packages.filter((name) => !RUNTIME_DEPENDENCIES.includes(name))
  if (unexpected.length) throw new Error(`CLI 引用了未声明的依赖：${unexpected.join('、')}`)
  const stage = join(root, '.runtime', 'pack-cli', 'package')
  await rm(stage, { recursive: true, force: true })
  for (const file of [...files, ...assets]) {
    await mkdir(dirname(join(stage, file)), { recursive: true })
    await cp(join(root, file), join(stage, file))
  }
  await cp(join(root, 'docs', '14-terminal-agent.md'), join(stage, 'README.md'))
  await writeFile(
    join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name: '@qpjoy/mx-rig-cli',
        version: manifest.version,
        description: 'MX Rig 终端：项目目录里的测试工程师（mx-rig），以及重放试验规程回归的工位（mx-rig station）。',
        author: manifest.author,
        type: 'module',
        bin: { 'mx-rig': 'bin/mx-rig.mjs' },
        engines: manifest.engines,
        dependencies: Object.fromEntries(packages.map((name) => [name, manifest.dependencies[name]])),
        files: [...new Set([...files, ...assets].map((file) => file.split('/')[0]))]
      },
      null,
      2
    )}\n`
  )
  await mkdir(out, { recursive: true })
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: stage, encoding: 'utf8' })
    .trim()
    .split('\n')
    .at(-1)
  return { tarball: join(out, packed), files, packages, assets, stage }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: join(root, 'dist') } } })
  const result = await pack({ out: resolve(values.out) })
  const shown = result.tarball.startsWith(process.cwd()) ? relative(process.cwd(), result.tarball) : result.tarball
  console.log(`${shown}：${result.files.length} 个模块，依赖 ${result.packages.join('、')}`)
  console.log(`安装：npm install -g ${shown}（需要 Node 22；用浏览器前运行 npx playwright install chromium）`)
}

export { pack }
