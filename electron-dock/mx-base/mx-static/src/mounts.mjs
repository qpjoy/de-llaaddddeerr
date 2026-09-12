import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const decode = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
export function filesystemAt(path, mountInfo) {
  path = resolve(path)
  return mountInfo.split('\n').map(line => {
    const [left, right] = line.split(' - ')
    return right ? { path: decode(left.split(' ')[4]), type: right.split(' ')[0] } : null
  }).filter(m => m && (path === m.path || path.startsWith(m.path === '/' ? '/' : m.path + '/')))
    .sort((a,b) => b.path.length - a.path.length)[0]?.type
}
export function assertLocalStorage(paths, {controlPaths=[]} = {}) {
  if (process.platform !== 'linux') return
  const info = readFileSync('/proc/self/mountinfo', 'utf8') // No stat/access on a potentially hung NFS path.
  for (const path of paths) {
    const type=filesystemAt(path,info)||''
    if (/^(nfs|nfs4|cifs|smb3|fuse\.)/.test(type)) throw new Error('Core data/state must use local disk; attach NAS only to archive worker')
    if(controlPaths.includes(path) && ['virtiofs','9p'].includes(type)) throw new Error('SQLite control storage requires native local filesystem; use a Docker VM local volume instead of Desktop shared folders')
  }
}
