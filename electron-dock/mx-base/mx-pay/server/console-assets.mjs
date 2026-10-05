import { readFileSync } from 'node:fs'

// Bundle canonical design assets into the existing public paths; gateway rules stay stable.
const design = new URL('../../../mx-launcher/ui-design/src/', import.meta.url)
const local = new URL('../console/', import.meta.url)
const read = (root, name) => readFileSync(new URL(name, root), 'utf8')
export const consoleAssets = new Map([
  ['/', ['text/html; charset=utf-8', read(local, 'index.html')]],
  ['/console.js', ['text/javascript; charset=utf-8', `${read(design, 'select.js')}\n${read(local, 'console.js')}`]],
  ['/console.css', ['text/css; charset=utf-8', [read(design, 'tokens.css'),
    read(design, 'styles.css').replace(/^@import "\.\/tokens\.css";\s*/, ''),
    read(design, 'select.css'), read(local, 'console.css')].join('\n')]],
])
