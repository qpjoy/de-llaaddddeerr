import { useState } from 'react';
import type {
  AdminPage,
  AdminRequest,
  AdminWorkspace,
  ManagedApplication,
  ManagedPolicy,
} from './admin';
import { appCategories } from './admin';
import Icon from './Icon';
import Modal from './Modal';

function Toggle({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled: boolean;
  onChange(): void;
}) {
  return (
    <button
      type="button"
      className={`mincave-toggle ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
type Mutation = (input: AdminRequest) => Promise<boolean>;
export default function AdminWorkspacePages({
  page,
  data,
  busy,
  error,
  save,
  reload,
  setPage,
}: {
  page: AdminPage;
  data: AdminWorkspace;
  busy: boolean;
  error: string;
  save: Mutation;
  reload(): void;
  setPage(page: AdminPage): void;
}) {
  const [search, setSearch] = useState('');
  const [app, setApp] = useState<ManagedApplication | null>(null);
  const [policy, setPolicy] = useState<ManagedPolicy | null>(null);
  const workspace = data.workspace;
  if (!workspace)
    return (
      <section className="mincave-admin-access">
        <Icon name="shield" size={38} />
        <p role="status">请更新 MinCave 管理服务后使用此页面。</p>
        <button className="mincave-button" onClick={reload}>
          刷新
        </button>
      </section>
    );
  const { applications, policies, revision } = workspace;
  const query = search.trim().toLocaleLowerCase();
  const filteredApps = applications.filter((row) =>
    `${row.name} ${row.url} ${row.category}`.toLocaleLowerCase().includes(query),
  );
  const filteredPolicies = policies.filter((row) =>
    `${row.name} ${row.department}`.toLocaleLowerCase().includes(query),
  );
  const departments = [...new Set(data.members.map((row) => row.department).filter(Boolean))];
  const saveApplication = (row: ManagedApplication) =>
    save({
      action: 'saveApplication',
      ...(row.id ? { id: row.id } : {}),
      revision,
      value: {
        name: row.name,
        url: row.url,
        category: row.category,
        published: row.published,
      },
    });
  const savePolicy = (row: ManagedPolicy) =>
    save({
      action: 'savePolicy',
      ...(row.id ? { id: row.id } : {}),
      revision,
      value: {
        name: row.name,
        department: row.department,
        appIds: row.appIds,
        action: row.action,
        enabled: row.enabled,
      },
    });
  return (
    <>
      {error && !app && !policy && (
        <div className="mincave-admin-error" role="alert">
          {error}
          <button className="mincave-text-button" onClick={reload} disabled={busy}>
            刷新
          </button>
        </div>
      )}
      {page === 'overview' && (
        <>
          <div className="mincave-admin-metrics">
            {[
              {
                label: '成员总数',
                value: data.members.length,
                icon: 'users' as const,
              },
              {
                label: '已启用成员',
                value: data.members.filter((row) => row.enabled).length,
                icon: 'shield' as const,
              },
              {
                label: '已发布应用',
                value: applications.filter((row) => row.published).length,
                icon: 'apps' as const,
              },
              {
                label: '启用策略',
                value: policies.filter((row) => row.enabled).length,
                icon: 'settings' as const,
              },
            ].map((item) => (
              <article className="mincave-panel" key={item.label}>
                <span>
                  <Icon name={item.icon} size={18} />
                  {item.label}
                </span>
                <strong>{item.value}</strong>
              </article>
            ))}
          </div>
          <div className="mincave-admin-overview-panels">
            <section className="mincave-panel mincave-admin-panel">
              <div className="mincave-section-toolbar">
                <h2>应用发布</h2>
                <button className="mincave-text-button" onClick={() => setPage('applications')}>
                  管理应用
                </button>
              </div>
              <div className="mincave-admin-summary-list">
                {appCategories.map((category) => (
                  <div key={category}>
                    <span>{category}</span>
                    <strong>
                      {
                        applications.filter((row) => row.category === category && row.published)
                          .length
                      }
                      <small> 已发布</small>
                    </strong>
                  </div>
                ))}
              </div>
            </section>
            <section className="mincave-panel mincave-admin-panel">
              <div className="mincave-section-toolbar">
                <h2>访问管理</h2>
                <button className="mincave-text-button" onClick={() => setPage('policies')}>
                  管理策略
                </button>
              </div>
              <div className="mincave-admin-summary-list">
                <div>
                  <span>登录方式</span>
                  <strong>飞书企业登录</strong>
                </div>
                <div>
                  <span>所属企业</span>
                  <strong>明悉科技</strong>
                </div>
                <div>
                  <span>管理员</span>
                  <strong>
                    {data.members.filter((row) => row.enabled && row.role === 'admin').length}
                    <small> 位</small>
                  </strong>
                </div>
                <div>
                  <span>应用访问规则</span>
                  <strong>
                    {policies.filter((row) => row.enabled).length}
                    <small> 条启用</small>
                  </strong>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
      {page !== 'overview' && (
        <section className="mincave-panel mincave-admin-panel">
          <div className="mincave-section-toolbar">
            <h2>
              {page === 'applications' ? '应用' : '策略'}{' '}
              <span>{page === 'applications' ? applications.length : policies.length}</span>
            </h2>
            <div className="mincave-admin-heading-actions">
              <label className="mincave-search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  aria-label={page === 'applications' ? '搜索应用' : '搜索策略'}
                  placeholder={page === 'applications' ? '搜索应用' : '搜索策略'}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <button
                className="mincave-button primary"
                disabled={busy}
                onClick={() =>
                  page === 'applications'
                    ? setApp({
                        id: '',
                        name: '',
                        url: '',
                        category: '中台应用',
                        published: true,
                        icon: 'apps',
                        color: 'purple',
                      })
                    : setPolicy({
                        id: '',
                        name: '',
                        department: '*',
                        appIds: [],
                        action: 'allow',
                        enabled: true,
                      })
                }
              >
                {page === 'applications' ? '新建应用' : '新建策略'}
              </button>
            </div>
          </div>
          <div className="mincave-admin-table-wrap">
            <table className="mincave-admin-table">
              <thead>
                <tr>
                  {(page === 'applications'
                    ? ['应用', '分类', '应用地址', '发布状态', '操作']
                    : ['策略名称', '适用部门', '资源范围', '动作', '启用', '操作']
                  ).map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page === 'applications'
                  ? filteredApps.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="mincave-admin-app-name">
                            <span className={`mincave-admin-app-icon ${row.color}`}>
                              <Icon name={row.icon} size={18} />
                            </span>
                            <strong>{row.name}</strong>
                          </div>
                        </td>
                        <td>
                          <span className="mincave-admin-tag">{row.category}</span>
                        </td>
                        <td>
                          <code className="mincave-admin-url">{row.url}</code>
                        </td>
                        <td>
                          <Toggle
                            checked={row.published}
                            label={`发布 ${row.name}`}
                            disabled={busy}
                            onChange={() =>
                              void saveApplication({
                                ...row,
                                published: !row.published,
                              })
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="mincave-text-button"
                            aria-label={`配置 ${row.name}`}
                            disabled={busy}
                            onClick={() => setApp({ ...row })}
                          >
                            配置
                          </button>
                        </td>
                      </tr>
                    ))
                  : filteredPolicies.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td>{row.department === '*' ? '全部成员' : row.department}</td>
                        <td>
                          <div className="mincave-admin-tags">
                            {row.appIds.map((id) => (
                              <span className="mincave-admin-tag" key={id}>
                                {applications.find((app) => app.id === id)?.name || '已移除应用'}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <span className={`mincave-admin-decision ${row.action}`}>
                            {row.action === 'allow' ? '允许' : '拒绝'}
                          </span>
                        </td>
                        <td>
                          <Toggle
                            checked={row.enabled}
                            label={`启用 ${row.name}`}
                            disabled={busy}
                            onChange={() => void savePolicy({ ...row, enabled: !row.enabled })}
                          />
                        </td>
                        <td>
                          <button
                            className="mincave-text-button"
                            aria-label={`编辑 ${row.name}`}
                            disabled={busy}
                            onClick={() => setPolicy({ ...row, appIds: [...row.appIds] })}
                          >
                            编辑
                          </button>
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {!(page === 'applications' ? filteredApps : filteredPolicies).length && (
            <div className="mincave-empty">
              {query ? '没有匹配结果' : page === 'applications' ? '暂无应用' : '暂无策略'}
            </div>
          )}
        </section>
      )}
      {app && (
        <Modal
          title={app.id ? '配置应用' : '新建应用'}
          onClose={() => {
            if (!busy) setApp(null);
          }}
        >
          <form
            className="mincave-admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveApplication(app).then((ok) => {
                if (ok) setApp(null);
              });
            }}
          >
            <label>
              应用名称
              <input
                aria-label="应用名称"
                value={app.name}
                maxLength={50}
                required
                disabled={busy}
                onChange={(event) => setApp({ ...app, name: event.target.value })}
              />
            </label>
            <label>
              应用地址
              <input
                type="url"
                aria-label="应用地址"
                value={app.url}
                maxLength={2048}
                required
                disabled={busy}
                onChange={(event) => setApp({ ...app, url: event.target.value })}
              />
            </label>
            <label>
              分类
              <select
                aria-label="应用分类"
                value={app.category}
                disabled={busy}
                onChange={(event) => setApp({ ...app, category: event.target.value })}
              >
                {appCategories.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={app.published}
                disabled={busy}
                onChange={(event) => setApp({ ...app, published: event.target.checked })}
              />
              发布到员工工作台
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="mincave-modal-footer">
              <button
                className="mincave-button"
                type="button"
                disabled={busy}
                onClick={() => setApp(null)}
              >
                取消
              </button>
              <button
                className="mincave-button primary"
                type="submit"
                disabled={busy || !app.name.trim() || !app.url.trim()}
              >
                保存
              </button>
            </div>
          </form>
        </Modal>
      )}
      {policy && (
        <Modal
          title={policy.id ? '编辑策略' : '新建策略'}
          onClose={() => {
            if (!busy) setPolicy(null);
          }}
        >
          <form
            className="mincave-admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void savePolicy(policy).then((ok) => {
                if (ok) setPolicy(null);
              });
            }}
          >
            <label>
              策略名称
              <input
                aria-label="策略名称"
                value={policy.name}
                maxLength={40}
                required
                disabled={busy}
                onChange={(event) => setPolicy({ ...policy, name: event.target.value })}
              />
            </label>
            <label>
              适用部门
              <select
                aria-label="适用部门"
                value={policy.department}
                disabled={busy}
                onChange={(event) => setPolicy({ ...policy, department: event.target.value })}
              >
                <option value="*">全部成员</option>
                {[
                  ...new Set([
                    ...departments,
                    ...(policy.department !== '*' ? [policy.department] : []),
                  ]),
                ].map((department) => (
                  <option key={department}>{department}</option>
                ))}
              </select>
            </label>
            <fieldset disabled={busy}>
              <legend>资源范围</legend>
              <div className="mincave-admin-checks">
                {applications.map((row) => (
                  <label key={row.id}>
                    <input
                      type="checkbox"
                      checked={policy.appIds.includes(row.id)}
                      onChange={(event) =>
                        setPolicy({
                          ...policy,
                          appIds: event.target.checked
                            ? [...policy.appIds, row.id]
                            : policy.appIds.filter((id) => id !== row.id),
                        })
                      }
                    />
                    {row.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              动作
              <select
                aria-label="策略动作"
                value={policy.action}
                disabled={busy}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    action: event.target.value as ManagedPolicy['action'],
                  })
                }
              >
                <option value="allow">允许</option>
                <option value="deny">拒绝</option>
              </select>
            </label>
            <p className="mincave-admin-policy-help">
              控制员工工作台的应用入口。有允许规则的应用仅向匹配部门展示；拒绝规则优先。
            </p>
            <label>
              <input
                type="checkbox"
                checked={policy.enabled}
                disabled={busy}
                onChange={(event) => setPolicy({ ...policy, enabled: event.target.checked })}
              />
              启用策略
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="mincave-modal-footer">
              <button
                className="mincave-button"
                type="button"
                disabled={busy}
                onClick={() => setPolicy(null)}
              >
                取消
              </button>
              <button
                className="mincave-button primary"
                type="submit"
                disabled={busy || !policy.name.trim() || !policy.appIds.length}
              >
                保存
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
