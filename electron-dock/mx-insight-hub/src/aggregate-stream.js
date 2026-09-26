// fetch streaming works with POST + Authorization; EventSource cannot supply
// those headers. Never reconnect automatically: a retry must keep body and key.
export async function readAggregateEvents(response, onEvent) {
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', completed = null
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const lines = frame.split('\n')
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!event || !data) continue
        const payload = JSON.parse(data)
        if (event === 'search.error') throw Object.assign(new Error(payload.error?.message || '搜索未完成'), { code: payload.error?.code, requestId: payload.requestId })
        onEvent?.(event, payload)
        if (event === 'search.completed') completed = payload
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error('搜索事件超过接收上限')
      if (done) break
    }
  } finally { reader.releaseLock() }
  if (!completed) throw Object.assign(new Error('连接已中断，已返回的来源仍保留；请使用原请求标识重试。'), { code: 'aggregate_stream_interrupted' })
  return completed
}
