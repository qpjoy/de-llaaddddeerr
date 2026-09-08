import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import ts from 'typescript'

const PAGE_ENTRY = fileURLToPath(new URL('../../src/pages.jsx', import.meta.url))

test('shared JSX pages do not reference undeclared runtime bindings', () => {
  const program = ts.createProgram([PAGE_ENTRY], {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noImplicitAny: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
  })
  const unresolved = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.code === 2304 && diagnostic.file?.fileName === PAGE_ENTRY)
    .map((diagnostic) => {
      const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      return `${diagnostic.file.fileName}:${location.line + 1}:${location.character + 1} ${message}`
    })

  assert.deepEqual(unresolved, [])
})
