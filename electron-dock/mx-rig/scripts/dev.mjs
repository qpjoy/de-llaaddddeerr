import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { start } from '../apps/server/index.mjs'
const dir = fileURLToPath(new URL('../.runtime/', import.meta.url))
await mkdir(dir, { recursive: true })
const path = dir + 'dev-token'
let token
try {
  token = await readFile(path, 'utf8')
} catch (e) {
  if (e.code !== 'ENOENT') throw e
  token = randomBytes(32).toString('base64url')
  await writeFile(path, token, { mode: 0o600 })
}
const server = await start({
  ...process.env,
  MX_RIG_HOST: '127.0.0.1',
  MX_RIG_STORE: 'memory',
  MX_RIG_ADMIN_TOKEN: token,
  MX_RIG_INSECURE_COOKIES: 'true'
})
console.log(
  `MX Rig: ${server.origin}/rig/\n本地开发账号：admin\n登录密码保存在 ${path}\n测试目录为内存模式，重启后重置；Mission 与策略持久化。`
)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close())
