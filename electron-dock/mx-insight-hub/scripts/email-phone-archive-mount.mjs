import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parseServerFileRoots } from '../server/ingest/external/server-files.mjs'

const rootId = 'email-phone-archive'

function checkArchive(file) {
  if (realpathSync(file) !== file) throw new Error('the file and its parents must not use symbolic links')
  const stat = lstatSync(file)
  if (!stat.isFile() || !stat.size || (stat.mode & 0o111)) {
    throw new Error('email-phone.zip must be a non-empty, non-executable regular file')
  }
  // Both Pods run with uid/gid 1000 and supplementary group 10.
  const readBit = stat.uid === 1000 ? 0o400 : [1000, 10].includes(stat.gid) ? 0o040 : 0o004
  if (stat.mode & readBit) return
  // On Linux the group bits also encode a POSIX ACL mask. A named uid or
  // group may have read access even when the file belongs to another group.
  if (stat.uid !== 1000 && (stat.mode & 0o040)) {
    console.warn('[mx-insight-hub] Archive readability depends on an ACL; verify with test -r in the Admin and dictionary Pods.')
    return
  }
  throw new Error('email-phone.zip must be readable by the Hub Pod (uid 1000, groups 1000/10)')
}

try {
  const roots = parseServerFileRoots(process.env.MX_INSIGHT_SERVER_FILE_ROOTS)
  const archive = roots.find(root => root.rootId === rootId)
  if (archive && (archive.path === '/' || roots.some(root => root !== archive && root.path === archive.path))) {
    throw new Error('configure a distinct directory for the archive root')
  }
  const file = archive && join(archive.path, 'email-phone.zip')
  if (process.argv[2] === 'preflight') {
    if (archive) checkArchive(file)
  } else if (process.argv[2] === 'render') {
    const template = readFileSync(0, 'utf8')
    // JSON flow entries are YAML-safe even when a path contains quotes or '#'.
    process.stdout.write(template.replace(/^( +)# email-phone-archive:(mount|volume)$/gm, (_, indent, kind) => {
      if (!archive) return ''
      const entry = kind === 'mount'
        ? { name: rootId, mountPath: file, readOnly: true }
        : { name: rootId, hostPath: { path: file, type: 'File' } }
      return indent + '- ' + JSON.stringify(entry)
    }))
  } else {
    throw new Error('expected preflight or render')
  }
} catch (error) {
  console.error('[mx-insight-hub] email-phone-archive: ' + error.message)
  process.exitCode = 1
}
