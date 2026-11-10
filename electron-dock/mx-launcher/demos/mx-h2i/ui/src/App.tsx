import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { view, type CatalogApp, type Snapshot, type UpdateState } from './bridge';
import Icon from './Icon';
import Devices from './Devices';
import LegacyPanel from './LegacyPanel';
import { categoryLabel, connectionLabel, formatTransfer, updateStage } from './model';
import snake from './assets/snake.svg';
import { workplaceApps } from './workplaceApps';
import Modal from './Modal';
import AdminConsole from './AdminConsole';
import { adminPages, type AdminPage } from './admin';
import UpdateNotifications, { hasUpdateNotification } from './UpdateNotifications';

type Page = 'home' | 'devices' | 'settings' | 'updates' | 'advanced' | 'apps';

function WindowControls() {
  return (
    <div className="mincave-window-bar" data-window-drag="true">
      <div className="mincave-window-controls">
        <button data-window-control="close" aria-label="关闭窗口">
          <span>×</span>
        </button>
        <button data-window-control="minimize" aria-label="最小化窗口">
          <span>−</span>
        </button>
        <button data-window-control="zoom" aria-label="放大或还原窗口">
          <span>□</span>
        </button>
      </div>
    </div>
  );
}

function Login({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="mincave-login">
      <WindowControls />
      <div className="mincave-login-layout">
        <section className="mincave-login-art" aria-hidden="true">
          <div className="mincave-orbit mincave-orbit-one" />
          <div className="mincave-orbit mincave-orbit-two" />
          <div className="mincave-orbit mincave-orbit-three" />
          <div className="mincave-orb mincave-orb-one" />
          <div className="mincave-orb mincave-orb-two" />
          <div className="mincave-portal-light" />
          <img src={snake} alt="" draggable="false" />
          <span className="mincave-orbit-app orbit-triangle">△</span>
          <span className="mincave-orbit-app orbit-moon">☾</span>
          <span className="mincave-orbit-app orbit-layers">▱</span>
        </section>
        <section className="mincave-login-card">
          <h1>MinCave，探索从这里开始</h1>
          <p className="mincave-login-subtitle">企业内网，统一访问。</p>
          <LegacyPanel html={snapshot.loginHtml} className="mincave-login-form" />
          {snapshot.loginError && <p role="alert" className="mincave-login-error">{snapshot.loginError}</p>}
          <NetworkControl snapshot={snapshot} />
        </section>
      </div>
    </div>
  );
}

function NetworkControl({ snapshot }: { snapshot: Snapshot }) {
  const control = snapshot.networkControl;
  if (!control) return null;
  return (
    <div className="mincave-operation-actions">
      <button
        className="mincave-text-button"
        data-action="cancelNetworkOperation"
        data-operation-id={control.id}
        disabled={!control.cancelable || control.stopping}
      >
        {control.stopping ? '正在取消' : '取消'}
      </button>
    </div>
  );
}

function OverseasSubscription({ snapshot }: { snapshot: Snapshot }) {
  const subscription = snapshot.overseasSubscription;
  return (
    <div className="mincave-subscription">
      {subscription.url ? (
        <>
          <label htmlFor="clash-subscription">Clash 订阅</label>
          <input
            id="clash-subscription"
            value={subscription.url}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <button className="mincave-button primary" data-action="copyH2oClashLink">
            复制订阅
          </button>
        </>
      ) : (
        <>
          <p role="status">{subscription.loading ? '正在获取订阅…' : '暂无可导入的订阅'}</p>
          <div className="mincave-subscription-actions">
            <button
              className="mincave-button"
              data-action="refreshH2oSubscription"
              data-subscription-id="h2o-default"
              disabled={!subscription.canRefresh}
            >
              刷新订阅
            </button>
            <button
              className="mincave-button primary"
              data-action="issueH2oClashLink"
              disabled={!subscription.canRefresh || subscription.status === 'unverified'}
            >
              {subscription.status === 'remote-only' ? '重新生成订阅' : '生成订阅'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Connection({ snapshot }: { snapshot: Snapshot }) {
  const state = snapshot.runtime.connection?.state;
  const busy = Boolean(snapshot.busyAction) || snapshot.mutating;
  const hasRetainedConnection = !!state && state !== 'idle';
  const guest = snapshot.runtime.connection?.mode === 'guest';
  const connectAction = guest ? 'connectGuest' : 'repairSystemNetwork';
  const connectDisabled =
    snapshot.connected || busy || (guest && (!snapshot.guestCanRenew || snapshot.anonymousBlocked));
  return (
    <section
      className={`mincave-connection ${snapshot.connected ? 'connected' : ''}`}
      aria-label="办公网络连接"
    >
      <span className="mincave-connection-icon">
        <Icon name="shield" size={28} />
      </span>
      <div className="mincave-connection-identity">
        <strong>Minsight办公网络</strong>
        <span className={`mincave-status ${snapshot.connected ? 'green' : ''}`} role="status">
          <i />
          {snapshot.busyAction === 'disconnect'
            ? '正在断开'
            : connectionLabel(state, snapshot.pending, snapshot.paused)}
        </span>
      </div>
      <div className="mincave-connection-actions">
        <button
          className="mincave-button primary"
          data-action={connectAction}
          disabled={connectDisabled}
        >
          <Icon name="power" size={15} />
          {snapshot.retainedEmployee || (hasRetainedConnection && !guest) ? '修复网络' : '连接'}
        </button>
        <button
          className="mincave-button outline"
          data-action="disconnect"
          disabled={!hasRetainedConnection || busy}
        >
          <Icon name="unplug" size={15} />
          断开
        </button>
      </div>
    </section>
  );
}

function AppCard({ app, connected }: { app: CatalogApp; connected: boolean }) {
  const content = (
    <>
      <span className={`mincave-app-icon ${app.color || ''}`}>
        <Icon name={app.icon || 'network'} size={24} />
      </span>
      <h3>{app.name}</h3>
      <div className="mincave-resource-bottom">
        <span
          className={`mincave-status ${connected && (app.url || app.installed) ? 'green' : ''}`}
        >
          <i />
          {app.url
            ? connected
              ? '可访问'
              : '未连接'
            : app.running
              ? '运行中'
              : app.installed
                ? '已安装'
                : '未安装'}
        </span>
        <span>{app.action.label}</span>
      </div>
    </>
  );
  return (
    <article className="mincave-resource-card">
      {app.url ? (
        <a
          className="mincave-resource-main"
          href={connected ? app.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          role="link"
          aria-label={`打开 ${app.name}`}
          aria-disabled={!connected}
          tabIndex={connected ? 0 : -1}
        >
          {content}
        </a>
      ) : (
        <button
          className="mincave-resource-main"
          data-action={app.action.action}
          data-app-id={app.id}
          disabled={app.action.disabled}
          aria-label={`${app.action.label} ${app.name}`}
        >
          {content}
        </button>
      )}
    </article>
  );
}

function Catalog({ snapshot }: { snapshot: Snapshot }) {
  const [search, setSearch] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [category, setCategory] = useState('all');
  const catalog = [
    ...workplaceApps,
    ...snapshot.apps.map((app) =>
      app.id === 'h2o'
        ? {
            ...app,
            name: '海外代理',
            category: '员工福利',
            action: { ...app.action, label: app.action.label.replaceAll('H2O', '海外代理') },
          }
        : app,
    ),
  ];
  const categories = [...new Set(catalog.map((app) => app.category))];
  const query = search.trim().toLocaleLowerCase();
  const matches = catalog.filter((app) =>
    [app.name, app.description].some((s) => (s || '').toLocaleLowerCase().includes(query)),
  );
  const effectiveCategory = category === 'all' || categories.includes(category) ? category : 'all';
  const apps = matches.filter(
    (app) => effectiveCategory === 'all' || app.category === effectiveCategory,
  );
  return (
    <section className="mincave-catalog">
      <div className="mincave-section-toolbar">
        <h2>
          应用 <span>{apps.length}</span>
        </h2>
        <div className="mincave-toolbar-actions">
          <label className="mincave-search">
            <Icon name="search" size={18} />
            <input
              type="search"
              placeholder="搜索应用"
              aria-label="搜索应用"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="mincave-view-switch">
            <button
              className={layout === 'grid' ? 'selected' : ''}
              aria-label="网格视图"
              aria-pressed={layout === 'grid'}
              onClick={() => setLayout('grid')}
            >
              <Icon name="grid" size={18} />
            </button>
            <button
              className={layout === 'list' ? 'selected' : ''}
              aria-label="列表视图"
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
            >
              <Icon name="list" size={19} />
            </button>
          </div>
        </div>
      </div>
      <div className="mincave-categories" aria-label="应用分类">
        <button
          className={effectiveCategory === 'all' ? 'selected' : ''}
          aria-pressed={effectiveCategory === 'all'}
          onClick={() => setCategory('all')}
        >
          全部应用 <span>{matches.length}</span>
        </button>
        {categories.map((c) => (
          <button
            key={c}
            className={effectiveCategory === c ? 'selected' : ''}
            aria-pressed={effectiveCategory === c}
            onClick={() => setCategory(c)}
          >
            {categoryLabel(c)} <span>{matches.filter((app) => app.category === c).length}</span>
          </button>
        ))}
      </div>
      {apps.length ? (
        <div className={`mincave-apps-grid ${layout === 'list' ? 'is-list' : ''}`}>
          {apps.map((app) => (
            <AppCard key={app.id} app={app} connected={snapshot.connected} />
          ))}
        </div>
      ) : (
        <div className="mincave-empty">
          <Icon name="apps" size={30} />
          <strong>{query ? '没有匹配的应用' : '暂无可访问应用'}</strong>
        </div>
      )}
    </section>
  );
}

function UpdateDetails({ update, busy }: { update: UpdateState; busy: boolean }) {
  const stage = updateStage(update.status);
  const progress = update.downloadProgress;
  const percent =
    typeof progress?.percent === 'number' && Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, progress.percent))
      : null;
  return (
    <div className="mincave-update">
      <div className="mincave-version-row">
        <span>
          当前版本 <strong>{update.currentVersion || '正在读取'}</strong>
        </span>
        {update.latestVersion && update.latestVersion !== update.currentVersion && (
          <span>
            新版本 <strong>{update.latestVersion}</strong>
          </span>
        )}
      </div>
      <div className="mincave-update-steps">
        {['发现更新', '下载与校验', '准备安装'].map((label, i) => (
          <span key={label} className={stage >= i ? 'active' : ''}>
            <i>{i + 1}</i>
            {label}
          </span>
        ))}
      </div>
      {update.notesHtml && (
        <LegacyPanel
          html={update.notesHtml}
          className="release-notes-markdown mincave-release-notes"
        />
      )}
      {update.status === 'downloading' && (
        <div className="mincave-download">
          <div
            className={`mincave-progress ${percent === null ? 'indeterminate' : ''}`}
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <span style={{ width: percent === null ? '25%' : `${percent}%` }} />
          </div>
          <span>
            {percent === null ? '正在下载' : `${percent}%`}
            {progress?.bytes !== undefined ? ` · ${formatTransfer(progress.bytes)}` : ''}
            {progress?.totalBytes ? ` / ${formatTransfer(progress.totalBytes)}` : ''}
          </span>
        </div>
      )}
      <div className="mincave-update-actions">
        <button
          className="mincave-button"
          data-action="checkUpdates"
          disabled={busy || update.status === 'downloading'}
        >
          检查更新
        </button>
        {update.canApply && (
          <button className="mincave-button primary" data-action="applyUpdate">
            {update.actionLabel}
          </button>
        )}
        {update.stagedPath && (
          <button className="mincave-button" data-action="showDownloadedInstaller" disabled={busy}>
            打开文件夹
          </button>
        )}
        {(update.restartPrompt || (update.status === 'staged' && update.restartRequired)) && (
          <button className="mincave-button primary" data-action="restartApp" disabled={busy}>
            重新启动
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  const [page, setPage] = useState<Page>('home');
  const [mode, setMode] = useState<'portal' | 'admin'>('portal');
  const [adminPage, setAdminPage] = useState<AdminPage>('members');
  const [menu, setMenu] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (snapshot?.releasePrompt) {
      setNoticeOpen(false);
      setUpdateOpen(true);
    }
  }, [snapshot?.releasePrompt]);
  useEffect(() => {
    if (!snapshot || snapshot.error) return;
    if (snapshot.screen === 'advanced') setPage('advanced');
    else if (snapshot.screen === 'appcenter' && !snapshot.h2oOpen) setPage('apps');
    else if (snapshot.screen !== 'appcenter')
      setPage((current) => (['advanced', 'apps'].includes(current) ? 'home' : current));
  }, [snapshot?.screen, snapshot?.h2oOpen]);
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
    setMenu(false);
  }, [page, mode, adminPage]);
  useEffect(() => {
    if (snapshot?.showLogin) {
      setNoticeOpen(false);
      setMenu(false);
      setPage('home');
      setMode('portal');
    }
  }, [snapshot?.showLogin]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(false);
        accountButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);
  useEffect(() => {
    if (!snapshot?.access?.canManage) setMode('portal');
  }, [snapshot?.access?.canManage]);
  const navigate = (next: Page) => {
    setPage(next);
    setMenu(false);
    view.navigate(next);
  };
  if (!snapshot)
    return (
      <div className="mincave-unavailable" role="status">
        <img src={snake} alt="" />
        <h1>MinCave</h1>
      </div>
    );
  if (snapshot.error)
    return (
      <div className="mincave-unavailable" role="alert">
        <img src={snake} alt="" />
        <h1>无法连接客户端</h1>
        <button className="mincave-button" onClick={() => location.reload()}>
          重新加载
        </button>
      </div>
    );
  const identity = snapshot.runtime.identity;
  const name =
    identity?.kind === 'user' ? identity.displayName || identity.account || '当前账号' : '访客连接';
  const headings: Record<Page, string> = {
    home: `欢迎，${name}`,
    apps: '应用中心',
    devices: '我的设备',
    settings: '连接设置',
    updates: '版本更新',
    advanced: '高级设置',
  };
  return (
    <>
      {snapshot.showLogin ? (
        <Login snapshot={snapshot} />
      ) : !snapshot.access.allowed ? (
        <div className="mincave-unavailable">
          <WindowControls />
          <Icon name="shield" size={38} />
          <h1>MinCave</h1>
          <p role="status">{snapshot.access.message || '正在验证使用权限'}</p>
          <button
            className="mincave-button"
            data-action="refreshMincaveAccess"
            disabled={Boolean(snapshot.busyAction)}
          >
            重试
          </button>
          <button
            className="mincave-button primary"
            data-action="login-feishu"
            disabled={Boolean(snapshot.busyAction)}
          >
            使用飞书登录
          </button>
          {snapshot.runtime.connection?.state !== 'idle' && (
            <button className="mincave-text-button" data-action="disconnect">
              断开
            </button>
          )}
        </div>
      ) : (
        <div className={`mincave-shell ${mode === 'admin' ? 'mincave-admin-shell' : ''}`}>
          <aside className="mincave-sidebar">
            <WindowControls />
            <button
              className="mincave-brand"
              onClick={() => (mode === 'admin' ? setAdminPage('members') : navigate('home'))}
              aria-label="MinCave 工作台"
            >
              <img src={snake} alt="" draggable="false" />
              <strong>MinCave</strong>
            </button>
            <nav aria-label="主导航">
              {mode === 'admin' && snapshot.access.canManage ? (
                adminPages.map((item) => (
                  <button
                    key={item.id}
                    className={adminPage === item.id ? 'selected' : ''}
                    aria-current={adminPage === item.id ? 'page' : undefined}
                    onClick={() => setAdminPage(item.id)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                ))
              ) : (
                <>
                  <button
                    className={page === 'home' ? 'selected' : ''}
                    onClick={() => navigate('home')}
                    aria-current={page === 'home' ? 'page' : undefined}
                  >
                    <Icon name="home" />
                    <span>工作台</span>
                  </button>
                  <button
                    className={page === 'devices' ? 'selected' : ''}
                    onClick={() => navigate('devices')}
                    aria-current={page === 'devices' ? 'page' : undefined}
                  >
                    <Icon name="device" />
                    <span>设备</span>
                  </button>
                </>
              )}
            </nav>
            <div className="mincave-sidebar-bottom" ref={menuRef}>
              <button
                className="mincave-account"
                ref={accountButton}
                aria-expanded={menu}
                aria-controls="mincave-account-menu"
                onClick={() => setMenu(!menu)}
              >
                <span className="mincave-avatar">{name[0]}</span>
                <strong>{name}</strong>
                <Icon name="chevron" size={13} />
              </button>
              {menu && (
                <div className="mincave-account-menu" id="mincave-account-menu">
                  <strong>{name}</strong>
                  {identity?.account && <small>{identity.account}</small>}
                  <hr />
                  <button
                    onClick={() => {
                      setMode('portal');
                      navigate('settings');
                    }}
                  >
                    <Icon name="settings" size={16} />
                    设置
                  </button>
                  <button
                    onClick={() => {
                      setMode('portal');
                      navigate('updates');
                    }}
                  >
                    <Icon name="package" size={16} />
                    版本更新
                  </button>
                  {snapshot.access.canManage && (
                    <button
                      onClick={() => {
                        setMode('admin');
                        setAdminPage('members');
                        setMenu(false);
                      }}
                    >
                      <Icon name="external" size={16} />
                      管理控制台
                    </button>
                  )}
                </div>
              )}
            </div>
          </aside>
          <div className="mincave-main-shell">
            <header className="mincave-topbar" data-window-drag="true">
              <div className="mincave-mode-switch" aria-label="切换工作端">
                <button
                  className={mode === 'portal' ? 'selected' : ''}
                  aria-pressed={mode === 'portal'}
                  onClick={() => {
                    setMode('portal');
                    navigate('home');
                  }}
                >
                  员工工作台
                </button>
                {snapshot.access.canManage && (
                  <button
                    className={mode === 'admin' ? 'selected' : ''}
                    aria-pressed={mode === 'admin'}
                    onClick={() => {
                      setMode('admin');
                      setAdminPage('members');
                    }}
                  >
                    管理控制台
                  </button>
                )}
              </div>
              {['settings', 'updates', 'advanced'].includes(page) && (
                <button
                  className="mincave-icon-button"
                  onClick={() => navigate('home')}
                  aria-label="返回工作台"
                >
                  <Icon name="home" size={19} />
                </button>
              )}
              <button
                className="mincave-icon-button mincave-notification-button"
                aria-label="通知"
                aria-haspopup="dialog"
                aria-expanded={noticeOpen}
                onClick={() => {
                  setMenu(false);
                  setNoticeOpen(true);
                }}
              >
                <Icon name="bell" size={23} />
                {hasUpdateNotification(snapshot.update) && (
                  <i className="mincave-notification-dot" aria-hidden="true" />
                )}
              </button>
            </header>
            <main ref={contentRef} className={`mincave-content ${mode === 'portal' && page === 'devices' ? 'mincave-devices-page' : ''}`} id="mincave-content">
              {mode === 'admin' && snapshot.access.canManage ? (
                <AdminConsole page={adminPage} setPage={setAdminPage} />
              ) : (
                <>
                  <div className="mincave-page-heading">
                    <h1>{headings[page]}</h1>
                    {snapshot.guestActive && page === 'home' && (
                      <button
                        className="mincave-button"
                        data-action="select-mode"
                        data-mode="employee"
                      >
                        员工登录
                      </button>
                    )}
                  </div>
                  {['home', 'apps', 'settings'].includes(page) && (
                    <Connection snapshot={snapshot} />
                  )}
                  <NetworkControl snapshot={snapshot} />
                  {['home', 'apps'].includes(page) && <Catalog snapshot={snapshot} />}
                  {page === 'devices' && <Devices key={snapshot.access.userId} snapshot={snapshot} />}
                  {page === 'settings' && (
                    <section className="mincave-panel mincave-settings">
                      <h2>连接设置</h2>
                      <div className="mincave-setting-row">
                        <strong>连接状态</strong>
                        <span>
                          {connectionLabel(
                            snapshot.runtime.connection?.state,
                            snapshot.pending,
                            snapshot.paused,
                          )}
                        </span>
                      </div>
                      <div className="mincave-setting-row">
                        <strong>协议</strong>
                        <span>WireGuard</span>
                      </div>
                      {identity?.provider && (
                        <div className="mincave-setting-row">
                          <strong>身份来源</strong>
                          <span>{identity.provider === 'feishu' ? '飞书' : '账号密码'}</span>
                        </div>
                      )}
                      <div className="mincave-setting-row">
                        <div>
                          <strong>版本更新</strong>
                          {snapshot.update.currentVersion && (
                            <small>当前版本 {snapshot.update.currentVersion}</small>
                          )}
                        </div>
                        <button
                          className="mincave-button"
                          onClick={() => {
                            setMode('portal');
                            navigate('updates');
                          }}
                        >
                          查看更新
                        </button>
                      </div>
                      <div className="mincave-setting-row">
                        <div>
                          <strong>高级设置与诊断</strong>
                        </div>
                        <button className="mincave-button" onClick={() => navigate('advanced')}>
                          打开设置
                        </button>
                      </div>
                    </section>
                  )}
                  {page === 'updates' && (
                    <>
                      <section className="mincave-panel">
                        <UpdateDetails
                          update={snapshot.update}
                          busy={Boolean(snapshot.busyAction)}
                        />
                      </section>
                      <LegacyPanel html={snapshot.update.historyHtml} trimHints />
                    </>
                  )}
                  {page === 'advanced' && (
                    <LegacyPanel
                      html={snapshot.advancedHtml}
                      className="mincave-advanced"
                      trimHints
                    />
                  )}
                </>
              )}
            </main>
          </div>
        </div>
      )}
      {snapshot.h2oOpen && !snapshot.showLogin && snapshot.access.allowed && (
        <Modal title="海外订阅" onClose={() => view.navigate('home')}>
          <OverseasSubscription snapshot={snapshot} />
        </Modal>
      )}
      {noticeOpen && !snapshot.showLogin && snapshot.access.allowed && (
        <Modal title="通知" onClose={() => setNoticeOpen(false)}>
          <UpdateNotifications
            update={snapshot.update}
            busy={Boolean(snapshot.busyAction)}
            onOpen={() => {
              setNoticeOpen(false);
              setUpdateOpen(true);
            }}
          />
        </Modal>
      )}
      {updateOpen && (
        <Modal
          title="版本更新"
          onClose={() => {
            setUpdateOpen(false);
            view.dismissRelease();
          }}
        >
          <UpdateDetails update={snapshot.update} busy={Boolean(snapshot.busyAction)} />
          <div className="mincave-modal-footer">
            <button
              className="mincave-text-button"
              onClick={() => {
                setUpdateOpen(false);
                view.dismissRelease();
              }}
            >
              稍后
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
