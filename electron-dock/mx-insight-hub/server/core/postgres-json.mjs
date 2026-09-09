function wellFormedUtf16(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false
    }
  }
  return true
}

function jsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasJsonSerializationHook(value) {
  let owner = value
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'toJSON')
    if (descriptor) {
      // JSON.stringify reads accessors and invokes callable values before it
      // walks the JSON shape. Neither behavior is a lossless projection of the
      // value inspected below, so fail closed. A data property containing a
      // non-function (for example provider data named "toJSON") is ordinary.
      return !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value === 'function'
    }
    owner = Object.getPrototypeOf(owner)
  }
  return false
}

export function isPostgresSafeText(value) {
  return typeof value === 'string'
    && !value.includes('\0')
    && wellFormedUtf16(value)
}

/**
 * PostgreSQL jsonb cannot represent U+0000 or lone UTF-16 surrogates. JS also
 * silently rewrites non-finite numbers to null and -0 to 0 during JSON
 * serialization. Treat those parsed projections as optional and retain exact
 * response bytes instead of corrupting or losing post-dispatch evidence.
 */
export function isPostgresSafeJsonValue(value) {
  const pending = [value]
  const visited = new WeakSet()
  try {
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === null || typeof current === 'boolean') continue
      if (typeof current === 'string') {
        if (!isPostgresSafeText(current)) return false
        continue
      }
      if (typeof current === 'number') {
        if (!Number.isFinite(current) || Object.is(current, -0)) return false
        continue
      }
      if (!Array.isArray(current) && !jsonObject(current)) return false
      if (visited.has(current)) return false
      visited.add(current)
      if (hasJsonSerializationHook(current)) return false

      const keys = Object.keys(current)
      if (Array.isArray(current)) {
        // JSON.stringify changes holes to null and ignores named array fields.
        // Provider JSON produced by JSON.parse is always dense and has only
        // canonical decimal indices, so reject either lossy shape here.
        if (keys.length !== current.length) return false
        for (let index = 0; index < current.length; index += 1) {
          if (keys[index] !== String(index)) return false
          const descriptor = Object.getOwnPropertyDescriptor(current, keys[index])
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
          pending.push(descriptor.value)
        }
        continue
      }

      for (const key of keys) {
        if (!isPostgresSafeText(key)) return false
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
        pending.push(descriptor.value)
      }
    }
  } catch {
    // Proxies and exotic accessors are not JSON values. This predicate is used
    // on an untrusted upstream projection and must fail closed rather than
    // throwing after a paid dispatch.
    return false
  }
  return true
}
