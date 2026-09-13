import { useEffect, useState } from 'react'
import { adminApi, publicDocsHref } from './api.js'
import { ErrorState } from './components.jsx'

export function DocsPage({ token, query, onUnauthorized }) {
  const path = query.get('path') || '/docs'
  const [content, setContent] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    setContent(null); setError(null)
    adminApi.documentation(token, path).then(data => {
      if (!active) return
      if (data.schema) { setContent({ schema: data.schema }); return }
      const doc = new DOMParser().parseFromString(data.html, 'text/html')
      for (const link of doc.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href')
        if (href.startsWith('/docs')) {
          link.href = window.location.href.split('#')[0] + publicDocsHref(href)
          link.target = '_top'
        } else if (!href.startsWith('#')) { link.target = '_blank'; link.rel = 'noreferrer' }
      }
      setContent({ html: '<!doctype html>' + doc.documentElement.outerHTML })
    }).catch(failure => {
      if (!active) return
      if (failure.status === 401) onUnauthorized(failure)
      setError(failure)
    })
    return () => { active = false }
  }, [token, path, onUnauthorized])
  if (error) return <ErrorState error={error} />
  if (!content) return <p role="status">正在读取文档…</p>
  return content.schema ? <pre>{JSON.stringify(content.schema, null, 2)}</pre> : <iframe title="接口文档" srcDoc={content.html} sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation" style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }} />
}
