// Treat display names and scope identifiers as equivalent search spellings.
export const normalizeAccessSearch = value => String(value ?? '').toLowerCase().replace(/[\s._-]+/g, '')
export const matchesAccessSearch = (query, ...values) => values.some(value => normalizeAccessSearch(value).includes(normalizeAccessSearch(query)))
