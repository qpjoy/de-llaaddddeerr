function formEncode(value) {
  const query = new URLSearchParams()
  query.set('credential', value)
  return query.toString().slice('credential='.length)
}

function strictUriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => (
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  ))
}

function encodedCredentialVariants(secret) {
  const variants = new Set([secret])
  const transmitted = new URLSearchParams(`credential=${formEncode(secret)}`).get('credential')
  if (transmitted) variants.add(transmitted)
  let frontier = [...variants]
  for (let depth = 0; depth < 2; depth += 1) {
    const next = []
    for (const candidate of frontier) {
      for (const encode of [encodeURIComponent, formEncode, strictUriEncode]) {
        try {
          const encoded = encode(candidate)
          if (!variants.has(encoded)) next.push(encoded)
          variants.add(encoded)
        } catch {
          // formEncode still records the adapter's wire representation when a
          // component encoder rejects unusual Unicode.
        }
      }
    }
    frontier = next
  }
  return variants
}

function percentHexCaseIndexes(value) {
  const insensitive = new Set()
  let tokens = Array.from({ length: value.length }, (_, sourceIndex) => ({
    character: value[sourceIndex],
    sourceIndexes: [sourceIndex],
  }))
  // Two encoding rounds plus a percent escape that was already part of the
  // credential. Iterating is bounded and never expands attacker-controlled data.
  for (let depth = 0; depth < 3; depth += 1) {
    const decoded = []
    let changed = false
    for (let index = 0; index < tokens.length; index += 1) {
      const current = tokens[index]
      const high = tokens[index + 1]
      const low = tokens[index + 2]
      if (current?.character === '%'
        && /^[0-9a-f]$/iu.test(high?.character || '')
        && /^[0-9a-f]$/iu.test(low?.character || '')) {
        for (const token of [high, low]) {
          for (const sourceIndex of token.sourceIndexes) {
            if (/^[a-f]$/iu.test(value[sourceIndex])) insensitive.add(sourceIndex)
          }
        }
        decoded.push({
          character: String.fromCharCode(Number.parseInt(`${high.character}${low.character}`, 16)),
          sourceIndexes: [
            ...current.sourceIndexes,
            ...high.sourceIndexes,
            ...low.sourceIndexes,
          ],
        })
        index += 2
        changed = true
      } else {
        decoded.push(current)
      }
    }
    tokens = decoded
    if (!changed) break
  }
  return insensitive
}

function regexEscapeCharacter(character) {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character
}

function equivalentEncodingPattern(variant) {
  const insensitive = percentHexCaseIndexes(variant)
  let pattern = ''
  for (let index = 0; index < variant.length; index += 1) {
    const character = variant[index]
    if (insensitive.has(index) && /^[a-f]$/iu.test(character)) {
      pattern += `[${character.toLowerCase()}${character.toUpperCase()}]`
    } else {
      pattern += regexEscapeCharacter(character)
    }
  }
  return pattern
}

export function createCredentialEchoRedactor(secret) {
  if (typeof secret !== 'string' || !secret) return (value) => value
  const patterns = [...encodedCredentialVariants(secret)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((candidate) => new RegExp(equivalentEncodingPattern(candidate), 'gu'))
  return (value) => {
    if (typeof value !== 'string') return value
    let redacted = value
    for (const pattern of patterns) redacted = redacted.replace(pattern, '[REDACTED]')
    return redacted
  }
}

export function redactCredentialEcho(value, secret) {
  return createCredentialEchoRedactor(secret)(value)
}
