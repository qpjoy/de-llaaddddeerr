#!/usr/bin/env node
// Remove third-party credentials that upstream projects hard-code in their
// extractors (yt-dlp's Shahid AWS keys, public Google API keys, ...). None of
// the reviewed packages calls those extractors; the values only trip secret
// scanning (GitHub push protection) and have no place in this repository.
// Each literal is emptied in place and the line is marked; the file list is
// recorded in the upstream's SOURCE.json. vendor-upstream.mjs runs this after
// every extraction, so a refreshed upstream is scrubbed the same way.
//
//   node scripts/scrub-upstream.mjs [--check] upstream/<name>@<commit> ...
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCRUB_MARK = '# credential removed by mx-crawler-runner scrub-upstream'
const RULES = [
  { kind: 'aws_access_key_id', literal: /(['"])((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16})\1/g },
  { kind: 'google_api_key', literal: /(['"])(AIza[0-9A-Za-z_-]{35})\1/g },
  // 40-character AWS secret / API Gateway key, only on lines that say so.
  { kind: 'aws_secret', literal: /(['"])((?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40})\1/g, line: /aws|secret/i },
]

function pythonFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== '__pycache__') out.push(...pythonFiles(full)) } else if (entry.name.endsWith('.py')) out.push(full)
  }
  return out
}

// Returns [{ file, line, kind }]; rewrites files unless check is set.
export function scrubDirectory(dir, { check = false } = {}) {
  const hits = []
  for (const file of pythonFiles(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let changed = false
    lines.forEach((text, index) => {
      let next = text
      for (const rule of RULES) {
        if (rule.line && !rule.line.test(next)) continue
        next = next.replace(rule.literal, (_, quote) => {
          hits.push({ file: relative(dir, file), line: index + 1, kind: rule.kind })
          return `${quote}${quote}`
        })
      }
      if (next !== text) {
        lines[index] = next.includes(SCRUB_MARK) ? next : `${next}  ${SCRUB_MARK}`
        changed = true
      }
    })
    if (changed && !check) writeFileSync(file, lines.join('\n'))
  }
  if (!check) {
    const sourceFile = join(dir, 'SOURCE.json')
    let source = null
    try { source = JSON.parse(readFileSync(sourceFile, 'utf8')) } catch { source = null }
    if (source) {
      const previous = Array.isArray(source.scrubbed) ? source.scrubbed : []
      const merged = [...new Map([...previous, ...hits].map(hit => [`${hit.file}:${hit.line}:${hit.kind}`, hit])).values()]
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      source.scrubbed = merged
      writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`)
    }
  }
  return hits
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const dirs = args.filter(arg => arg !== '--check')
  if (!dirs.length) { console.error('usage: scrub-upstream.mjs [--check] <upstream dir>...'); process.exit(2) }
  let total = 0
  for (const dir of dirs) {
    const hits = scrubDirectory(dir, { check })
    total += hits.length
    for (const hit of hits) console.log(`${check ? 'found   ' : 'scrubbed'} ${dir}/${hit.file}:${hit.line} ${hit.kind}`)
  }
  console.log(`${total} credential literal(s) ${check ? 'found' : 'removed'}`)
  if (check && total) process.exitCode = 1
}
