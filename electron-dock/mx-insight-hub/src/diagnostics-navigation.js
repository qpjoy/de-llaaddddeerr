export function diagnosticHref(requestId = '', view = 'requests') {
  const query = new URLSearchParams({ view: view === 'limits' ? 'limits' : 'requests' })
  if (requestId) query.set('requestId', requestId)
  return `#/diagnostics?${query}`
}

// Preserve shared/bookmarked links from before diagnostics moved out of browsing.
export function legacyDiagnosticRedirect(path, query) {
  if (path !== '/data-browser' || !['diagnostics', 'limits'].includes(query.get('view'))) return null
  return { path: '/diagnostics', view: query.get('view') === 'limits' ? 'limits' : 'requests' }
}

export function diagnosticTabRequestId(view, requestId, session, token) {
  if (view === 'limits') return requestId || ''
  // Limits need one resolved Hub request, not the upstream ID used for lookup.
  // A new deep link must not reuse the previous lookup's still-visible result.
  if (session?.token !== token || session.routeIdentifier !== requestId
    || session.data?.identifier !== session.identifier?.trim() || session.data?.runs?.length !== 1) return ''
  return session.data.runs[0].requestId
}
