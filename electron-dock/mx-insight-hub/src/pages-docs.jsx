import { useEffect, useState } from 'react'
import { adminApi, publicDocsHref } from './api.js'
import { ErrorState } from './components.jsx'
import { productForDocs } from '../shared/product-workbenches.mjs'

export function DocsPage({ token, query, onUnauthorized, theme = 'light', embedded = false }) {
  const path = query.get('path') || '/docs'
  const product = productForDocs(path)
  const productHref = product ? `#${product.path}${path.includes('/native/') ? `?endpoint=${encodeURIComponent(path.split('/').at(-1))}` : product.docs === 'enterprise' && /^\/docs\/enterprise\/\d+\.\d+$/.test(path) ? `?apiId=${encodeURIComponent(path.split('/').at(-1))}` : ''}` : null
  const [content, setContent] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    setContent(null); setError(null)
    adminApi.documentation(token, path).then(data => {
      if (!active) return
      if (data.schema) { setContent({ schema: data.schema }); return }
      const doc = new DOMParser().parseFromString(data.html, 'text/html')
      if (embedded) {
        doc.querySelector('.layout > aside')?.remove()
        const style = doc.createElement('style')
        style.textContent = '.layout { display:block; } main { margin:0; width:100%; max-width:none; padding:24px; } @media(max-width:640px) { main { padding:16px; } }'
        doc.head.append(style)
      }
      for (const link of doc.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href')
        if (href.startsWith('/docs')) {
          link.href = window.location.href.split('#')[0] + publicDocsHref(href)
          link.target = '_top'
        } else if (href.startsWith('/#/')) {
          link.href = window.location.href.split('#')[0] + href.slice(1)
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
  }, [token, path, onUnauthorized, embedded])
  if (error) return <ErrorState error={error} />
  if (!content) return <p role="status">正在读取文档…</p>
  return <>{embedded ? <div className="mih-page-actions"><a className="qp-button qp-button--outline" href={publicDocsHref(path)}>在全部接口文档中查看 ↗</a></div> : product ? <div className="mih-page-actions"><a className="qp-button qp-button--outline" href={productHref}>打开 {product.label} · 接口调试 ↗</a></div> : null}{content.schema ? <pre>{JSON.stringify(content.schema, null, 2)}</pre> : <iframe title={embedded ? '当前产品接口文档' : '接口文档'} srcDoc={content.html.replace('<html', `<html data-theme="${theme === 'dark' ? 'dark' : 'light'}"`)} sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation" style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }} />}</>
}
