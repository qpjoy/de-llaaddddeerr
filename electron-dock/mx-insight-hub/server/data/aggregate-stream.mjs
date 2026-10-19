// Transport only. Disconnecting stops delivery, never cancels or retries a paid
// operation. The committed parent response remains the idempotent replay source.
export function aggregateStream(response) {
  let opened = false, closed = false, timer = null
  const close = () => { closed = true; clearInterval(timer) }
  response.once('close', close)
  function ready() {
    if (closed || response.destroyed) return false
    // Also bound heartbeat writes while all sources are waiting on upstream.
    if (response.writableLength > 1024 * 1024) { response.destroy(); close(); return false }
    return true
  }
  function write(event, data) {
    if (!ready()) return
    if (!opened) {
      opened = true
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' })
      response.flushHeaders()
      timer = setInterval(() => { if (ready()) response.write(': heartbeat\n\n') }, 10_000)
      timer.unref?.()
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  return { write, get opened() { return opened },
    end() { clearInterval(timer); if (opened && !closed) response.end(); response.off('close', close) } }
}
