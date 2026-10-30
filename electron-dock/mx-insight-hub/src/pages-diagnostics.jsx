import { lazy, Suspense, useRef, useState } from 'react'
import { LoadingState, PageHeading } from './components.jsx'
import { diagnosticTabRequestId } from './diagnostics-navigation.js'
import './diagnostics-center.css'

const RequestDiagnostics = lazy(() => import('./request-diagnostics.jsx'))
const AdmissionLimits = lazy(() => import('./admission-limits.jsx'))
const PlatformDiagnostics = lazy(() => import('./platform-diagnostics.jsx'))

export function DiagnosticsPage({ token, query, setQuery, onUnauthorized, diagnosticComparisonSession }) {
  const view = ['limits', 'platforms'].includes(query?.get('view')) ? query.get('view') : 'requests'
  const [diagnosticSession, setDiagnosticSession] = useState(() => ({ token, identifier: query?.get('requestId') || '', data: null, error: null }))
  const localDiagnosticComparisonSessions = useRef(null)
  const diagnosticComparisonSessions = diagnosticComparisonSession || localDiagnosticComparisonSessions
  const requestId = diagnosticTabRequestId(view, query?.get('requestId') || '', diagnosticSession, token)
  return <div className="mih-diagnostics-center">
    <PageHeading eyebrow="OBSERVABILITY / DIAGNOSTICS" title="诊断中心" description="从请求证据定位问题，核对当前限制与恢复条件。默认查询只读取 Hub 已保存的记录。" />
    <nav className="mih-diagnostics-tabs" aria-label="诊断类型">
      {[['requests', '请求诊断'], ['limits', '限制与恢复'], ['platforms', '平台问题分类']].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => { if (key !== view) setQuery({ view: key, requestId: requestId || null }) }}>{label}</button>)}
    </nav>
    <Suspense fallback={<LoadingState label="正在加载诊断工具" />}>
      {view === 'platforms'
        ? <PlatformDiagnostics platform={query?.get('platform') || 'reddit'} requestId={requestId} onPlatformChange={platform => setQuery({ platform })}/>
        : view === 'limits'
        ? <AdmissionLimits key={token} token={token} onUnauthorized={onUnauthorized} requestId={query?.get('requestId') || ''} />
        : <RequestDiagnostics key={token} token={token} onUnauthorized={onUnauthorized} session={diagnosticSession} setSession={setDiagnosticSession} comparisonSessions={diagnosticComparisonSessions} autoIdentifier={query?.get('requestId') || ''} />}
    </Suspense>
  </div>
}
