import { useState } from 'react';
import type { AdminMember, AdminRequest, AdminWorkspace } from './admin';
import Icon from './Icon';
import Modal from './Modal';

const roleName = (role: AdminMember['role']) =>
  role === 'admin' ? '管理员' : role === 'employee' ? '员工' : '已停用';
export default function AdminMembers({
  data,
  busy,
  error,
  save,
}: {
  data: AdminWorkspace;
  busy: boolean;
  error: string;
  save(input: AdminRequest): Promise<boolean>;
}) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [role, setRole] = useState<'admin' | 'employee'>('employee');
  const [enabled, setEnabled] = useState(true);
  const [appIds, setAppIds] = useState<string[]>([]);
  const [appsChanged, setAppsChanged] = useState(false);
  const applications = data.workspace?.applications || [];
  const canEditApps = data.memberPermissions === true && Boolean(data.workspace);
  const members = data.members.filter((member) =>
    `${member.name} ${member.department}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  async function submit() {
    if (!editing) return;
    const ok = await save({
      action: 'saveMember',
      id: editing.id,
      value: { role, enabled, ...(canEditApps && appsChanged ? { appIds } : {}) },
    });
    if (ok) setEditing(null);
  }
  return (
    <>
      <div className="mincave-section-toolbar mincave-member-toolbar">
        <span>{data.members.length} 位成员</span>
        <label className="mincave-search">
          <Icon name="search" size={18} />
          <input
            type="search"
            aria-label="搜索姓名、部门"
            placeholder="搜索姓名、部门"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {error && !editing && (
        <p className="mincave-admin-error" role="alert">
          {error}
        </p>
      )}
      <section className="mincave-panel mincave-admin-panel">
        <div className="mincave-admin-table-wrap">
          <table className="mincave-admin-table mincave-members-table">
            <thead>
              <tr>
                {['成员', '部门', '设备', '应用权限', '状态', '操作'].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <div className="mincave-member-name">
                      <span className="mincave-member-avatar">
                        {Array.from(member.name)[0] || '员'}
                      </span>
                      <div>
                        <strong>{member.name}</strong>
                        <small>{roleName(member.role)}</small>
                      </div>
                    </div>
                  </td>
                  <td>{member.department || '—'}</td>
                  <td>
                    <div className="mincave-member-devices">
                      {member.devices?.length
                        ? member.devices.map((device, index) => (
                            <span key={index}>{device.name}</span>
                          ))
                        : '—'}
                    </div>
                  </td>
                  <td>
                    {member.effectiveAppIds ? (
                      <div className="mincave-admin-tags">
                        {member.effectiveAppIds.length ? (
                          member.effectiveAppIds.map((id) => (
                            <span className="mincave-admin-tag" key={id}>
                              {applications.find((app) => app.id === id)?.name || '应用'}
                            </span>
                          ))
                        ) : (
                          <span className="mincave-member-none">无</span>
                        )}
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className={`mincave-status ${member.enabled ? 'green' : 'gray'}`}>
                      <i />
                      {member.enabled ? '已授权' : '已停用'}
                    </span>
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
                        setAppIds([...(member.appIds || [])]);
                        setAppsChanged(false);
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
        {!members.length && (
          <div className="mincave-empty">{search.trim() ? '没有匹配的成员' : '暂无成员'}</div>
        )}
      </section>
      {editing && (
        <Modal
          className="mincave-member-modal"
          title={`管理 ${editing.name}`}
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form
            className="mincave-admin-form mincave-member-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label>
              部门
              <input aria-label="部门" value={editing.department || '—'} readOnly />
            </label>
            <label>
              角色
              <select
                aria-label="角色"
                value={role}
                disabled={busy || !editing.accountActive}
                onChange={(event) => setRole(event.target.value as 'admin' | 'employee')}
              >
                <option value="employee">员工</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            {canEditApps && (
              <fieldset disabled={busy || !editing.accountActive}>
                <legend>可访问应用</legend>
                <div className="mincave-member-app-checks">
                  {applications.map((app) => (
                    <label className="mincave-member-app-choice" key={app.id}>
                      <input
                        type="checkbox"
                        aria-label={`授权 ${app.name}`}
                        checked={appIds.includes(app.id)}
                        onChange={(event) => {
                          setAppIds(
                            event.target.checked
                              ? [...appIds, app.id]
                              : appIds.filter((id) => id !== app.id),
                          );
                          setAppsChanged(true);
                        }}
                      />
                      <span className={`mincave-admin-app-icon ${app.color}`}>
                        <Icon name={app.icon} size={17} />
                      </span>
                      <span>{app.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {editing.id !== data.administratorId && (
              <div className="mincave-setting-row">
                <span>成员启用</span>
                <button
                  type="button"
                  role="switch"
                  aria-label="成员启用"
                  aria-checked={enabled}
                  className={`mincave-toggle ${enabled ? 'on' : ''}`}
                  disabled={busy || !editing.accountActive}
                  onClick={() => setEnabled(!enabled)}
                >
                  <span />
                </button>
              </div>
            )}
            {!editing.accountActive && (
              <p role="status">此账号已被用户中心停用或身份关联已变化。</p>
            )}
            {error && <p role="alert">{error}</p>}
            <button
              className="mincave-button primary mincave-member-save"
              type="submit"
              disabled={busy || !editing.accountActive}
            >
              保存权限
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
