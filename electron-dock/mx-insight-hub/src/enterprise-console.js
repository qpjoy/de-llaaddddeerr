// Forms and examples share the authenticated, scope-filtered OpenAPI contract.
export function enterpriseConsoleEndpoints(document) {
  return Object.entries(document?.paths || {}).flatMap(([path, item]) => {
    const match = /^\/data\/enterprise\/(\d+\.\d+)\/query$/.exec(path)
    const operation = item.post
    if (!match || !operation?.requestBody?.content?.['application/json']) return []
    const request = operation.requestBody.content['application/json']
    return [{ id: match[1], path: `/api/v1${path}`, label: operation.summary,
      category: operation['x-mx-category'] || '企业数据', callable: operation['x-mx-callable'] === true,
      schema: request.schema, example: request.example }]
  })
}

export function enterpriseAccessIssues(access) {
  if (access === undefined) return ['正在读取当前调用身份…']
  if (access === null) return [] // Admin manual keys are still checked by the Public API.
  return [
    ['platforms', 'consumerPlatforms', 'enterprise', '企业数据域'],
    ['capabilities', 'consumerCapabilities', 'enterprise.query', '企业查询能力'],
  ].flatMap(([field, consumerField, scope, label]) => access[field]?.includes(scope) ? [] : [
    access[consumerField]?.includes(scope)
      ? `当前业务已开通${label}，但所选 Key 未包含该权限，请调整原 Key 权限后重新检查。`
      : `当前业务尚未开通${label}，请联系管理员授权。`,
  ])
}

export function enterpriseConsoleFields(endpoint, section) {
  const schema = endpoint?.schema.properties[section]
  return Object.entries(schema?.properties || {}).map(([name, field]) => ({
    name, section, key: `${section}.${name}`, description: field.description,
    numeric: field.type === 'number' || field.anyOf?.some(type => type.type === 'number'),
    required: schema.required?.includes(name),
  }))
}

export function enterpriseConsoleBody(endpoint, values) {
  if (!endpoint) throw new Error('请选择企业接口')
  const method = values.method || endpoint.schema.properties.method.default
  if (!endpoint.schema.properties.method.enum.includes(method)) throw new Error('不支持此请求方式')
  const deliveryMode = values.deliveryMode || 'live_only'
  if (!endpoint.schema.properties.deliveryMode.enum.includes(deliveryMode)) throw new Error('请选择交付方式')
  const body = { query: {}, method, deliveryMode }
  for (const section of ['query', 'body']) {
    const fields = enterpriseConsoleFields(endpoint, section)
    if (section === 'body' && !fields.length) continue
    const entries = []
    for (const field of fields) {
      const value = String(values[field.key] ?? '').trim()
      if (!value) { if (field.required) throw new Error(`请填写 ${field.key}`); continue }
      if (value.length > 16000 || /[\u0000]/u.test(value)) throw new Error(`${field.key} 内容无效或过长`)
      if (field.numeric && !Number.isFinite(Number(value))) throw new Error(`${field.key} 必须为有效数字`)
      // Numeric strings are accepted by Hub; preserve large IDs without JS rounding.
      entries.push([field.name, value])
    }
    body[section] = Object.fromEntries(entries)
    const alternatives = endpoint.schema.properties[section]?.anyOf
    if (alternatives && !alternatives.some(rule => rule.required.every(name => Object.hasOwn(body[section], name)))) {
      throw new Error(`请至少填写一项：${alternatives.flatMap(rule => rule.required).map(name => `${section}.${name}`).join(' / ')}`)
    }
  }
  if (method === 'GET' && body.body) throw new Error('此请求方式不接受 body 参数')
  return body
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
export const enterpriseRequestIdentity = (endpoint, body) => JSON.stringify([endpoint.id, stable(body)])
