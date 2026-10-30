import { DIAGNOSTIC_PLATFORMS, GENERIC_DIAGNOSTIC_STEPS, REDDIT_DIAGNOSTIC_ISSUES,
  REDDIT_DIAGNOSTIC_VERIFICATION } from '../shared/platform-diagnostic-catalog.mjs'
import { diagnosticHref } from './diagnostics-navigation.js'

export function PlatformDiagnosticGuidance({ analysis, requestId }) {
  if (analysis?.platform !== 'reddit') return null
  const issues = analysis.issueIds.map(id => REDDIT_DIAGNOSTIC_ISSUES.find(issue => issue.id === id)).filter(Boolean)
  return <section className="mih-diagnostic-analysis" aria-label="Reddit 优先排查">
    <h4>Reddit 问题分析归类</h4><p>{analysis.summary}</p>
    {issues.length ? <ol>{issues.map(issue => <li key={issue.id}><strong>{issue.title}</strong> · 待核对<p>{issue.check}</p></li>)}</ol> : null}
    <p><a href={diagnosticHref(requestId, 'platforms', 'reddit')}>查看 Reddit 分类、修复边界与验证方法 →</a></p>
    <p className="mih-diagnostic-note">匹配依据仅为已保存错误码与调用状态；未检查原始响应，不表示已确认卡片类型或唯一根因。</p>
  </section>
}

export default function PlatformDiagnostics({ platform = 'reddit', onPlatformChange, requestId = '' }) {
  const selected = DIAGNOSTIC_PLATFORMS.find(item => item.id === platform) || DIAGNOSTIC_PLATFORMS.at(-1)
  return <section className="qp-card mih-platform-diagnostics" aria-labelledby="platform-diagnostics-title">
    <header><h2 id="platform-diagnostics-title">平台问题分类</h2><p>先按本次证据定位故障层，再参考平台已知问题。历史案例用于排查，不替代本次证据。</p></header>
    <label className="mih-platform-selector" htmlFor="diagnostic-platform">选择平台
      <select className="qp-input" id="diagnostic-platform" value={selected.id} onChange={event => onPlatformChange(event.target.value)}>
        {DIAGNOSTIC_PLATFORMS.map(item => <option value={item.id} key={item.id}>{item.label} · {item.specialized ? '专项分类' : '通用排查'}</option>)}
      </select>
    </label>
    <nav className="mih-platform-links" aria-label="平台诊断入口">
      <a href={diagnosticHref(requestId)}>查询请求证据</a><a href={diagnosticHref(requestId, 'limits')}>查看限制与恢复</a>
    </nav>
    {selected.specialized ? <>
      <h3>Reddit 问题分析归类</h3>
      <p>解析失败时优先核对纠错与提示卡片，再核对帖子结构、分页及提示语义；409 隔离与上游 429 分别检查。</p>
      <div className="mih-platform-issues">{REDDIT_DIAGNOSTIC_ISSUES.map((issue, index) => <details key={issue.id}>
        <summary>{index + 1}. {issue.title}</summary>
        <dl><dt>识别信号</dt><dd>{issue.signal}</dd><dt>历史经验</dt><dd>{issue.explanation}</dd>
          <dt>只读核对</dt><dd>{issue.check}</dd><dt>处理边界</dt><dd>{issue.resolution}</dd></dl>
      </details>)}</div>
      <aside className="mih-diagnostic-note"><h4>版本与归档验证</h4><p>{REDDIT_DIAGNOSTIC_VERIFICATION}</p></aside>
    </> : <section aria-label={`${selected.label}通用排查`}>
      <h3>{selected.label} 诊断入口</h3><p>已提供请求证据和限制查询入口，平台专属分类待补充。当前不会套用 Reddit 规则。</p>
      <ol>{GENERIC_DIAGNOSTIC_STEPS.map(step => <li key={step}>{step}</li>)}</ol>
    </section>}
  </section>
}
