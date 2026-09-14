import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RigError, TOOL_NAMES, text } from '../../packages/contracts/index.mjs'

export class Settings {
  constructor(file) {
    this.file = file
    this.value = {
      revision: randomUUID(),
      maxTurns: 12,
      allowedTools: ['tests_list', 'tests_runs', 'tests_run', 'tests_result'],
      browserOrigins: [],
      model: { baseUrl: '', name: '', apiKeyEnv: 'MX_RIG_MODEL_API_KEY' }
    }
    this.queue = Promise.resolve()
  }
  async init() {
    try {
      this.value = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    return this
  }
  public() {
    const { model, ...policy } = this.value
    return { policy, model: { name: model.name, configured: Boolean(model.baseUrl && model.name) } }
  }
  async update(input) {
    if (
      !Array.isArray(input.allowedTools) ||
      input.allowedTools.some((name) => !TOOL_NAMES.includes(name))
    )
      throw new RigError('invalid_tools', '工具列表无效')
    if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 30)
      throw new RigError('invalid_budget', '任务步数必须为 1–30')
    if (!Array.isArray(input.browserOrigins) || input.browserOrigins.length > 30)
      throw new RigError('invalid_origins', '浏览器 origin 列表无效')
    const origins = input.browserOrigins.map((raw) => {
      const url = new URL(raw)
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.origin !== raw ||
        url.username ||
        url.password
      )
        throw new RigError('invalid_origin', '请填写完整 origin，例如 https://test.example.com')
      return raw
    })
    const model = input.model
    if (
      !model ||
      typeof model.baseUrl !== 'string' ||
      typeof model.name !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,100}$/.test(model.apiKeyEnv)
    )
      throw new RigError('invalid_model', '模型配置无效')
    if (model.baseUrl) {
      const url = new URL(model.baseUrl)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      )
        throw new RigError('invalid_model_url', '模型地址需要 HTTPS，本地网关可用 HTTP')
      text(model.name, '模型名称', 200)
    }
    const value = {
      revision: randomUUID(),
      maxTurns: input.maxTurns,
      allowedTools: [...new Set(input.allowedTools)],
      browserOrigins: [...new Set(origins)],
      model: {
        baseUrl: model.baseUrl.replace(/\/+$/, ''),
        name: model.name,
        apiKeyEnv: model.apiKeyEnv
      }
    }
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
      await rename(temp, this.file)
      this.value = value
    })
    this.queue = operation.catch(() => {})
    await operation
    return this.public()
  }
}
