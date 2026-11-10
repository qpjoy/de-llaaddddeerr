import { useEffect, useRef, useState } from 'react';
import { view } from './bridge';
import Icon from './Icon';
import Modal from './Modal';
import type { AdminPage, AdminWorkspace, AdminMember } from './admin';

const roleName = (role: AdminMember['role']) =>
  role === 'admin' ? '管理员' : role === 'employee' ? '员工' : '已停用';
export default function AdminConsole(_props: { page: AdminPage; setPage(page: AdminPage): void }) {
  const [data, setData] = useState<AdminWorkspace | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [role, setRole] = useState<'admin' | 'employee'>('employee');
  const [enabled, setEnabled] = useState(true);
  const epoch = useRef(0);
  async function load() {
    const turn = ++epoch.current;
    setBusy(true);
    setError('');
    const result = await view.admin({ action: 'workspace' });
    if (turn !== epoch.current) return;
    if (result.ok) setData(result.value as AdminWorkspace);
    else {
      setData(null);
      setError(result.error.message);
    }
    setBusy(false);
  }
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
    };
  }, []);
  async function save() {
    if (!editing) return;
    setBusy(true);
    setError('');
    const result = await view.admin({
      action: 'saveMember',
      id: editing.id,
      value: { role, enabled },
    });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(false);
      return;
    }
    setEditing(null);
    await load();
  }
  if (!data)
    return (
      <section className="mincave-admin-access">
        <Icon name="users" size={38} />
        <h1>成员与角色</h1>
        <p role="status">{busy ? '正在加载' : error}</p>
        {!busy && (
          <button className="mincave-button" onClick={() => void load()}>
            刷新
          </button>
        )}
      </section>
    );
  const members = data.members.filter((member) =>
    `${member.name} ${member.department}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <div className="mincave-page-heading">
        <h1>成员与角色</h1>
      </div>
      <section className="mincave-panel">
        <div className="mincave-section-toolbar">
          <h2>
            成员 <span>{data.members.length}</span>
          </h2>
          <label className="mincave-search">
            <Icon name="search" size={18} />
            <input
              type="search"
              aria-label="搜索成员"
              placeholder="搜索成员"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        {error && !editing && <p role="alert">{error}</p>}
        <div className="mincave-admin-table-wrap">
          <table className="mincave-admin-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>部门</th>
                <th>MinCave 角色</th>
                <th>使用权限</th>
                <th>最近使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>{member.name}</td>
                  <td>{member.department || '—'}</td>
                  <td>{roleName(member.role)}</td>
                  <td>{member.enabled ? '已启用' : '已停用'}</td>
                  <td>
                    {member.lastSeenAt
                      ? new Date(member.lastSeenAt).toLocaleString('zh-CN', { hour12: false })
                      : '—'}
                  </td>
                  <td>
                    <button
                      className="mincave-text-button"
                      aria-label={`管理 ${member.name}`}
                      disabled={busy}
                      onClick={() => {
                        setEditing(member);
                        setRole(member.role || 'employee');
                        setEnabled(member.enabled);
                        setError('');
                      }}
                    >
                      管理
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!members.length && <div className="mincave-empty">暂无成员</div>}
      </section>
      {editing && (
        <Modal
          title="成员权限"
          onClose={() => {
            setEditing(null);
            setError('');
          }}
        >
          <form
            className="mincave-admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="mincave-setting-row">
              <strong>成员</strong>
              <span>{editing.name}</span>
            </div>
            <div className="mincave-setting-row">
              <strong>部门</strong>
              <span>{editing.department || '—'}</span>
            </div>
            <label>
              MinCave 角色
              <select
                aria-label="MinCave 角色"
                value={role}
                disabled={busy || !editing.accountActive}
                onChange={(event) => setRole(event.target.value as 'admin' | 'employee')}
              >
                <option value="employee">员工</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                aria-label="允许使用 MinCave"
                checked={enabled}
                disabled={busy || !editing.accountActive}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              允许使用 MinCave
            </label>
            {!editing.accountActive && (
              <p role="status">此账号已被用户中心停用或身份关联已变化。</p>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="mincave-modal-footer">
              <button
                type="submit"
                className="mincave-button primary"
                disabled={busy || !editing.accountActive}
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
