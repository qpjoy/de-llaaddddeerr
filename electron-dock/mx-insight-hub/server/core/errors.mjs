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
  constructor(status, body) {
    super(`Night-All rejected the request with HTTP ${status}`)
    this.name = 'UpstreamRejectedError'
    this.status = status
    this.body = body
  }
}

export class UpstreamAmbiguousError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'UpstreamAmbiguousError'
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new AppError(status, code, message, details)
}
