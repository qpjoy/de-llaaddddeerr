export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export class UpstreamRejectedError extends Error {
  constructor(status, body, correlation = {}) {
    super(`Night-All rejected the request with HTTP ${status}`)
    this.name = 'UpstreamRejectedError'
    this.status = status
    this.body = body
    this.upstreamRequestId = correlation.requestId || null
    this.upstreamTraceId = correlation.traceId || null
    if (correlation.rateLimit) this.rateLimit = correlation.rateLimit
  }
}

export class UpstreamAmbiguousError extends Error {
  constructor(message, cause, correlation = {}) {
    super(message, { cause })
    this.name = 'UpstreamAmbiguousError'
    // These are observed response headers, never the correlation ID we sent.
    const identifier = value => typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) ? value : null
    this.upstreamRequestId = identifier(correlation.requestId)
    this.upstreamTraceId = identifier(correlation.traceId)
    // An observed HTTP status does not make the incomplete body a known outcome.
    this.upstreamHttpStatus = Number.isInteger(correlation.httpStatus)
      && correlation.httpStatus >= 100 && correlation.httpStatus <= 599 ? correlation.httpStatus : null
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new AppError(status, code, message, details)
}
