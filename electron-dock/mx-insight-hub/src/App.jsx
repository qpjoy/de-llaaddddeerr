import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Brain,
  Books,
  Database,
  DownloadSimple,
  MagnifyingGlass,
  Pulse,
  ChartLine,
  Coins,
  Globe,
  House,
  Key,
  List,
  LockKey,
  ShieldCheck,
  SidebarSimple,
  SignOut,
  Users,
  Stack,
  X,
} from '@phosphor-icons/react'
import { adminApi, signInWithLauncher } from './api.js'
import { ErrorState, Field, ToastStack } from './components.jsx'
import {
  ApiKeysPage,
  ConsumersPage,
  DashboardPage,
  PlansQuotasPage,
  PlatformsPage,
  RuntimePage,
  UsagePage,
} from './pages.jsx'
import { AgentPage, BackfillPage, RetrievalPage, SourcesPage } from './pages-data.jsx'
import { DataCenterPage } from './pages-catalog.jsx'
import { SourceCatalogPage } from './pages-source-catalog.jsx'

const SESSION_KEY = 'mx-insight-hub.admin-token'

// `capability` gates the route against what the session actually grants. The
// console renders itself from the server's answer rather than from a local role
// guess, so a scoped user never sees a control that would 403.
const ROUTES = [
  { path: '/dashboard', label: '仪表盘', description: '网关运营总览', icon: House, group: '业务治理', component: DashboardPage, capability: 'usage.read' },
  { path: '/consumers', label: '调用者', description: '租户与业务身份', icon: Users, group: '业务治理', component: ConsumersPage, capability: 'consumer.read' },
  { path: '/api-keys', label: 'API Keys', description: '签发、轮换与撤销', icon: Key, group: '业务治理', component: ApiKeysPage, capability: 'apikey.read' },
  { path: '/plans', label: '套餐与配额', description: '窗口、分页与额度', icon: Coins, group: '策略控制', component: PlansQuotasPage, capability: 'consumer.read' },
  { path: '/platforms', label: '开放能力', description: '数据平台与通用 API', icon: Globe, group: '策略控制', component: PlatformsPage, capability: 'consumer.read' },
  { path: '/data-center', label: '数据中心', description: '数据集、记录与存储现状', icon: Stack, group: '数据平面', component: DataCenterPage, platformAdmin: true, adminTokenOnly: true },
  { path: '/source-catalog', label: '数据源目录', description: '覆盖、分类与实施状态', icon: Books, group: '数据平面', component: SourceCatalogPage, capability: 'membership.write', platformAdmin: true, adminTokenOnly: true },
  { path: '/sources', label: '数据清洗计划', description: '接入、映射与清洗执行', icon: Database, group: '数据平面', component: SourcesPage, capability: 'membership.write', platformAdmin: true, adminTokenOnly: true },
  { path: '/backfill', label: '历史回填', description: 'Night-All 存量拉取', icon: DownloadSimple, group: '数据平面', component: BackfillPage, capability: 'membership.write', platformAdmin: true },
  { path: '/retrieval', label: '检索管线', description: '切分、向量与混合检索', icon: MagnifyingGlass, group: '数据平面', component: RetrievalPage, capability: 'usage.read', platformAdmin: true },
  { path: '/agent', label: '中心 Agent', description: '模型链路与降级', icon: Brain, group: '数据平面', component: AgentPage, capability: 'membership.write', platformAdmin: true },
  { path: '/usage', label: '使用记录', description: '计量与对账证据', icon: ChartLine, group: '可观测性', component: UsagePage, capability: 'usage.read' },
  { path: '/runtime', label: '运行状态', description: '健康、依赖与恢复', icon: Pulse, group: '可观测性', component: RuntimePage, capability: 'usage.read' },
]

const ROUTE_MAP = new Map(ROUTES.map((route) => [route.path, route]))

function visibleRoutes(session) {
  // An older server may omit capabilities, but platform-wide pages still stay
  // hidden unless the session explicitly identifies a platform administrator.
  if (!session?.capabilities) {
    return ROUTES.filter((route) => (
      (!route.platformAdmin || session?.platformAdmin) && (!route.adminTokenOnly || session?.kind === 'admin-token')
    ))
  }
  const granted = new Set(session.capabilities)
  return ROUTES.filter((route) => (
    (!route.platformAdmin || session.platformAdmin)
      && (!route.adminTokenOnly || session.kind === 'admin-token')
      && (!route.capability || granted.has(route.capability))
  ))
}

function readSessionToken() {
  try {
    return sessionStorage.getItem(SESSION_KEY) || ''
  } catch {
    return ''
  }
}

function writeSessionToken(token) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token)
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // A valid in-memory session still works when browser storage is unavailable.
  }
}

function readLocation() {
  const raw = window.location.hash.replace(/^#/, '') || '/dashboard?range=24h'
  const separator = raw.indexOf('?')
  const candidatePath = separator === -1 ? raw : raw.slice(0, separator)
  const path = ROUTE_MAP.has(candidatePath) ? candidatePath : '/dashboard'
  const search = separator === -1 ? '' : raw.slice(separator + 1)
  return { path, query: new URLSearchParams(search) }
}

function SessionGate({ checking, message, onAuthenticate }) {
  const [candidate, setCandidate] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [mode, setMode] = useState('token')
  const [options, setOptions] = useState(null)
  const [account, setAccount] = useState({ username: '', password: '' })

  useEffect(() => {
    // Which sign-in methods exist is a server-side fact; asking avoids showing
    // a Launcher form in a deployment that has no Launcher.
    adminApi.signInOptions().then(setOptions)
  }, [])

  const submitLauncher = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      // Forwarded through the Hub, which is the only path that works when
      // Launcher answers on the internal network and the browser does not sit
      // on it.
      const token = await signInWithLauncher({
        username: account.username.trim(),
        password: account.password,
      })
      await onAuthenticate(token)
    } catch (requestError) {
      setError(requestError)
    } finally {
      setSubmitting(false)
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await onAuthenticate(candidate.trim())
    } catch (requestError) {
      setError(requestError)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="qp-app qp-theme-neon-void qp-density--medium mih-auth">
      <section className="qp-panel qp-panel--elevated mih-auth-card" aria-labelledby="mih-auth-title">
        <div className="mih-auth-brand">
          <img src="assets/mx-insight-logo-mark.png" alt="" />
          <div>
            <span>MX DATA CONTROL PLANE</span>
            <strong>MX Insight Hub</strong>
          </div>
        </div>
        <div className="mih-auth-copy">
          <p className="qp-kicker">ADMIN SESSION</p>
          <h1 id="mih-auth-title">进入数据网关管理台</h1>
          <p>使用 MX Launcher 提供的 Admin Token。凭证只保存在当前浏览器会话中，关闭会话后自动清除。</p>
        </div>
        {message ? <div className="mih-auth-notice"><ShieldCheck size={18} weight="duotone" aria-hidden="true" /><span>{message}</span></div> : null}
        {checking ? (
          <div className="mih-auth-checking" role="status">
            <span className="qp-spinner" aria-hidden="true" />
            正在验证已有会话
          </div>
        ) : (
          <>
            {options && !options.launcher && options.launcherUnavailableReason ? (
              // Shown rather than hidden: an operator who configured Launcher
              // and sees no tab needs to know which half is missing.
              <p className="mih-auth-hint">
                Launcher 账号登录未启用：{options.launcherUnavailableReason}
              </p>
            ) : null}
            {options?.launcher ? (
              <div className="mih-signin-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={mode === 'launcher'}
                  className={`qp-button qp-button--ghost${mode === 'launcher' ? ' is-active' : ''}`}
                  onClick={() => { setMode('launcher'); setError(null) }}>Launcher 账号</button>
                <button type="button" role="tab" aria-selected={mode === 'token'}
                  className={`qp-button qp-button--ghost${mode === 'token' ? ' is-active' : ''}`}
                  onClick={() => { setMode('token'); setError(null) }}>Admin Token</button>
              </div>
            ) : null}

            {options?.launcher && mode === 'launcher' ? (
              <form className="mih-auth-form" onSubmit={submitLauncher}>
                <Field label="账号" hint="使用 MX Launcher 的账号密码；由 Hub 转发给 Launcher 校验。">
                  <input className="qp-input" value={account.username} autoComplete="username" autoFocus required
                    onChange={(event) => setAccount({ ...account, username: event.target.value })} />
                </Field>
                <Field label="密码">
                  <span className="qp-input-group">
                    <span className="qp-input-group__prefix"><LockKey size={17} aria-hidden="true" /></span>
                    <input className="qp-input" type="password" value={account.password}
                      autoComplete="current-password" required
                      onChange={(event) => setAccount({ ...account, password: event.target.value })} />
                  </span>
                </Field>
                {error ? <ErrorState error={error} /> : null}
                <button className="qp-button qp-button--primary qp-button--lg qp-button--block" type="submit"
                  disabled={submitting || !account.username.trim() || !account.password}>
                  {submitting ? <span className="qp-spinner" aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
                  {submitting ? '正在验证' : '使用 Launcher 账号登录'}
                </button>
              </form>
            ) : (
              <form className="mih-auth-form" onSubmit={submit}>
                <Field label="Admin Token" hint="请求时通过 x-mx-insight-admin-token 发送，不写入 URL。">
                  <span className="qp-input-group">
                    <span className="qp-input-group__prefix"><LockKey size={17} aria-hidden="true" /></span>
                    <input
                      className="qp-input mih-mono"
                      type="password"
                      value={candidate}
                      onChange={(event) => setCandidate(event.target.value)}
                      placeholder="输入管理凭证或 Launcher token"
                      autoComplete="off"
                      autoFocus
                      required
                    />
                  </span>
                </Field>
                {error ? <ErrorState error={error} /> : null}
                <button className="qp-button qp-button--primary qp-button--lg qp-button--block" type="submit" disabled={submitting || !candidate.trim()}>
                  {submitting ? <span className="qp-spinner" aria-hidden="true" /> : <ShieldCheck size={18} aria-hidden="true" />}
                  {submitting ? '正在验证' : '验证并进入'}
                </button>
              </form>
            )}
          </>
        )}
        <footer className="mih-auth-footer">
          <LockKey size={15} aria-hidden="true" />
          <span>管理面与公共 Data API 严格分离</span>
        </footer>
      </section>
    </div>
  )
}

function Navigation({ activePath, onNavigate, routes = ROUTES }) {
  const groups = [...new Set(routes.map((route) => route.group))]
  return (
    <nav className="mih-nav" aria-label="管理台导航">
      {groups.map((group) => (
        <section className="mih-nav__group" key={group}>
          <h2>{group}</h2>
          {routes.filter((route) => route.group === group).map((route) => {
            const Icon = route.icon
            const active = route.path === activePath
            return (
              <a
                className={`mih-nav__item${active ? ' is-active' : ''}`}
                href={`#${route.path}`}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                key={route.path}
              >
                <Icon size={18} weight={active ? 'duotone' : 'regular'} aria-hidden="true" />
                <span><strong>{route.label}</strong><small>{route.description}</small></span>
              </a>
            )
          })}
        </section>
      ))}
    </nav>
  )
}

export function App() {
  const initialToken = useMemo(readSessionToken, [])
  const [token, setToken] = useState(initialToken)
  const [authState, setAuthState] = useState(initialToken ? 'checking' : 'signed-out')
  const [authMessage, setAuthMessage] = useState('')
  const [location, setLocation] = useState(readLocation)
  const [menuOpen, setMenuOpen] = useState(false)
  const [toasts, setToasts] = useState([])
  const [session, setSession] = useState(null)

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/dashboard?range=24h`)
    }
    const update = () => {
      setLocation(readLocation())
      setMenuOpen(false)
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  useEffect(() => {
    if (authState !== 'checking' || !token) return undefined
    let active = true
    // `session` rather than `dashboard`: it is the endpoint that reports who
    // the caller is and what they may do, and it is reachable by every valid
    // principal including one with no tenant membership yet.
    adminApi.session(token)
      .then((data) => {
        if (!active) return
        setSession(data)
        setAuthState('signed-in')
      })
      .catch((error) => {
        if (!active) return
        writeSessionToken('')
        setToken('')
        setAuthState('signed-out')
        setAuthMessage(error?.status === 401 ? '管理会话已失效，请重新验证。' : '无法恢复管理会话，请检查服务状态后重试。')
      })
    return () => {
      active = false
    }
  }, [authState, token])

  const authenticate = useCallback(async (candidate) => {
    // Accepts an admin token or a Launcher session token; the server decides
    // which it is and answers with the capabilities that follow.
    const data = await adminApi.session(candidate)
    writeSessionToken(candidate)
    setToken(candidate)
    setSession(data)
    setAuthMessage('')
    setAuthState('signed-in')
  }, [])

  const signOut = useCallback((message = '') => {
    writeSessionToken('')
    setToken('')
    setAuthState('signed-out')
    setAuthMessage(message)
    setSession(null)
    setMenuOpen(false)
  }, [])

  const handleUnauthorized = useCallback(() => {
    signOut('管理会话已失效，请重新验证。')
  }, [signOut])

  const notify = useCallback((message, tone = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    setToasts((current) => [...current, { id, message, tone }].slice(-4))
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200)
  }, [])

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const setQuery = useCallback((updates) => {
    const params = new URLSearchParams(location.query)
    for (const [name, value] of Object.entries(updates)) {
      if (value === null || value === undefined || value === '') params.delete(name)
      else params.set(name, String(value))
    }
    const search = params.toString()
    window.location.hash = `${location.path}${search ? `?${search}` : ''}`
  }, [location.path, location.query])

  if (authState !== 'signed-in') {
    return <SessionGate checking={authState === 'checking'} message={authMessage} onAuthenticate={authenticate} />
  }

  const routes = visibleRoutes(session)
  const requested = ROUTE_MAP.get(location.path)
  // Falling back to the first permitted route rather than the dashboard: a user
  // scoped out of the dashboard would otherwise land on a permanent 403.
  const route = routes.includes(requested) ? requested : routes[0] || ROUTE_MAP.get('/runtime')
  const Page = route.component
  const pageProps = {
    token,
    session,
    query: location.query,
    setQuery,
    onUnauthorized: handleUnauthorized,
    notify,
  }

  return (
    <div className={`qp-app qp-theme-neon-void qp-density--medium qp-shell mih-shell${menuOpen ? ' is-nav-open' : ''}`}>
      <a className="mih-skip-link" href="#mih-main-content">跳到主要内容</a>
      <button className="mih-nav-backdrop" type="button" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />
      <aside className="qp-sidebar qp-scrollbar mih-sidebar" aria-label="MX Insight Hub">
        <a className="mih-brand" href="#/dashboard" onClick={() => setMenuOpen(false)}>
          <img src="assets/mx-insight-logo-mark.png" alt="" />
          <span><strong>MX Insight Hub</strong><small>Data gateway control plane</small></span>
        </a>
        <Navigation activePath={route.path} onNavigate={() => setMenuOpen(false)} routes={routes} />
        <section className="mih-sidebar-session">
          <ShieldCheck size={20} weight="duotone" aria-hidden="true" />
          <span>
            <strong>{session?.displayName || 'Admin session'}</strong>
            <small>
              {session?.kind === 'launcher-user'
                ? (session.platformAdmin ? '平台管理员' : `${session.memberships?.length || 0} 个租户`)
                : '仅当前浏览器会话'}
            </small>
          </span>
          <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="退出管理会话" onClick={() => signOut()}>
            <SignOut size={17} aria-hidden="true" />
          </button>
        </section>
      </aside>

      <div className="mih-workspace">
        <header className="qp-appbar mih-topbar">
          <button className="qp-button qp-button--ghost qp-icon-button mih-menu-button" type="button" aria-label="打开导航" onClick={() => setMenuOpen(true)}>
            <SidebarSimple size={20} aria-hidden="true" />
          </button>
          <div className="mih-topbar-title">
            <List size={16} aria-hidden="true" />
            <span>MX Insight Hub</span>
            <small>/</small>
            <strong>{route.label}</strong>
          </div>
          <div className="mih-topbar-actions">
            <span className="qp-tag qp-tag--success mih-session-tag"><ShieldCheck size={14} weight="fill" aria-hidden="true" />受保护的管理会话</span>
            <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="退出管理会话" onClick={() => signOut()}>
              <SignOut size={17} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className={`qp-main qp-scrollbar mih-content${route.path === '/dashboard' || route.path === '/source-catalog' ? ' mih-content--dashboard' : ''}`} id="mih-main-content" tabIndex="-1">
          <Page {...pageProps} />
        </main>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {menuOpen ? (
        <button className="qp-button qp-button--ghost qp-icon-button mih-mobile-close" type="button" aria-label="关闭导航" onClick={() => setMenuOpen(false)}>
          <X size={19} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
