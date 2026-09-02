import { useCallback, useState } from 'react'
import {
  ArrowClockwise,
  Database,
  Key,
  PencilSimple,
  Plus,
  ShieldCheck,
  Trash,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  ConfirmDialog,
  DropdownField,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  PageHeading,
  StatusBadge,
  formatDate,
  useRemoteData,
} from './components.jsx'

const SSL_MODE_OPTIONS = [
  { value: 'disable', label: 'disable（同机或受控内网）' },
  { value: 'require', label: 'require' },
  { value: 'verify-ca', label: 'verify-ca' },
  { value: 'verify-full', label: 'verify-full' },
]

function asList(value) {
  if (Array.isArray(value)) return value
  for (const key of ['items', 'connections']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

function DatabaseConnectionModal({ connection, busy, error, onClose, onSave }) {
  const editing = Boolean(connection)
  const formId = editing ? `database-connection-${connection.id}` : 'database-connection-create'
  const [form, setForm] = useState(() => ({
    connectionKey: connection?.connectionKey || '',
    displayName: connection?.displayName || '',
    host: connection?.host || '',
    port: String(connection?.port || 5432),
    database: connection?.database || '',
    username: connection?.username || '',
    password: '',
    sslMode: connection?.sslMode || 'require',
  }))

  const submit = (event) => {
    event.preventDefault()
    const password = form.password
    onSave({
      ...(editing
        ? { revision: connection.revision }
        : { connectionKey: form.connectionKey.trim() }),
      displayName: form.displayName.trim(),
      connection: {
        host: form.host.trim(),
        port: Number(form.port),
        database: form.database.trim(),
        username: form.username.trim(),
        sslMode: form.sslMode,
        ...(password ? { password } : {}),
      },
    })
  }

  return (
    <Modal
      title={editing ? `编辑 ${connection.displayName}` : '新增数据库配置'}
      description="共享配置只保存 PostgreSQL 连接；Schema、表、游标、映射和调度仍由清洗任务管理。"
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="qp-button" type="submit" form={formId} disabled={busy}>
            {busy ? '正在验证并保存…' : '验证并保存'}
          </button>
        </>
      )}
    >
      <form id={formId} className="mih-form mih-form--grid" onSubmit={submit}>
        <Field label="配置标识" hint={editing ? '稳定标识创建后不可修改' : '小写字母或数字开头，可包含点号、下划线与连字符'}>
          <input className="qp-input" value={form.connectionKey} required disabled={editing}
            pattern="[a-z0-9][a-z0-9._-]*" maxLength={128}
            onChange={(event) => setForm({ ...form, connectionKey: event.target.value })} />
        </Field>
        <Field label="显示名称">
          <input className="qp-input" value={form.displayName} required maxLength={160}
            onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
        </Field>
        <Field label="数据库引擎"><input className="qp-input" value="PostgreSQL" disabled /></Field>
        <Field label="主机">
          <input className="qp-input" value={form.host} required placeholder="127.0.0.1"
            onChange={(event) => setForm({ ...form, host: event.target.value })} />
        </Field>
        <Field label="端口">
          <input className="qp-input" type="number" min="1" max="65535" value={form.port} required
            onChange={(event) => setForm({ ...form, port: event.target.value })} />
        </Field>
        <Field label="数据库">
          <input className="qp-input" value={form.database} required placeholder="night_all"
            onChange={(event) => setForm({ ...form, database: event.target.value })} />
        </Field>
        <Field label="用户名">
          <input className="qp-input" value={form.username} required autoComplete="off" placeholder="mx_data"
            onChange={(event) => setForm({ ...form, username: event.target.value })} />
        </Field>
        <Field label="密码" hint={editing && connection.passwordConfigured ? '已配置；留空保留当前密码' : '保存前会通过只读连接验证'}>
          <input className="qp-input" type="password" value={form.password}
            required={!editing && !connection?.passwordConfigured} autoComplete="new-password"
            placeholder={editing && connection.passwordConfigured ? '留空保持不变' : '输入数据库密码'}
            onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </Field>
        <DropdownField label="SSL 模式" value={form.sslMode}
          onChange={(sslMode) => setForm({ ...form, sslMode })} options={SSL_MODE_OPTIONS} />
        <p className="mih-inline-warning mih-form__wide"><Key size={16} />密码不会返回浏览器；编辑时留空不会覆盖已保存凭据。</p>
        {error ? <div className="mih-form__wide"><ErrorState error={error} /></div> : null}
      </form>
    </Modal>
  )
}

export function DatabaseConnectionsPage({ token, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.databaseConnections(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [testingId, setTestingId] = useState(null)
  const [testResults, setTestResults] = useState({})
  const [deleting, setDeleting] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const items = asList(state.data)

  const handleError = (error) => {
    if (error?.status === 401) onUnauthorized?.(error)
    return error
  }

  const save = async (body) => {
    setSaving(true)
    setSaveError(null)
    try {
      if (editing) await adminApi.updateDatabaseConnection(token, editing.id, body)
      else await adminApi.createDatabaseConnection(token, body)
      notify?.(editing ? '数据库配置已更新' : '数据库配置已创建', 'success')
      setEditing(null)
      setCreating(false)
      state.refresh()
    } catch (error) {
      handleError(error)
      setSaveError(error)
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async (connection) => {
    setTestingId(connection.id)
    try {
      const result = await adminApi.testDatabaseConnection(token, connection.id)
      setTestResults((current) => ({ ...current, [connection.id]: { ok: true, result } }))
      notify?.(`${connection.displayName} 只读连接正常`, 'success')
    } catch (error) {
      handleError(error)
      setTestResults((current) => ({ ...current, [connection.id]: { ok: false, error } }))
      notify?.(error.message, 'error')
    } finally {
      setTestingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await adminApi.deleteDatabaseConnection(token, deleting.id)
      notify?.(`数据库配置 ${deleting.displayName} 已删除`, 'success')
      setDeleting(null)
      state.refresh()
    } catch (error) {
      handleError(error)
      notify?.(error.message, 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  if (state.loading && !state.data) return <LoadingState label="正在加载数据库配置" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading
        eyebrow="DATA CLEANING CENTER / DATABASE CONNECTIONS"
        title="数据库配置"
        description="集中维护可复用的 PostgreSQL 只读连接；表、游标、映射与同步周期仍在各清洗任务中独立定义。"
        loading={state.loading}
        onRefresh={state.refresh}
      >
        <button className="qp-button" type="button" onClick={() => { setSaveError(null); setCreating(true) }}>
          <Plus size={16} />新增数据库配置
        </button>
      </PageHeading>

      {items.length === 0 ? (
        <EmptyState icon={Database} title="还没有数据库配置"
          description="新增共享 PostgreSQL 连接后，清洗任务可以引用它，也仍可选择任务内独立填写。"
          action={<button className="qp-button" type="button" onClick={() => setCreating(true)}>新增配置</button>} />
      ) : (
        <section className="qp-panel mih-panel">
          <header className="mih-panel__header"><div><h2>共享 PostgreSQL 连接</h2><p>修改前先查看引用任务；服务端会阻止删除仍被任务使用的配置。</p></div></header>
          <div className="qp-data-table mih-table-wrap">
            <table className="mih-table" aria-label="数据库配置列表">
              <thead><tr><th>配置</th><th>连接</th><th>凭据 / SSL</th><th>引用任务</th><th>最近验证</th><th /></tr></thead>
              <tbody>{items.map((connection) => {
                const references = Array.isArray(connection.references) ? connection.references : []
                const referenceCount = Number(connection.referenceCount ?? references.length)
                const test = testResults[connection.id]
                return (
                  <tr key={connection.id}>
                    <td><strong>{connection.displayName}</strong><small><code>{connection.connectionKey}</code> · rev {connection.revision || 1}</small></td>
                    <td><code>{connection.host}:{connection.port || 5432}</code><small>{connection.database} · {connection.username}</small></td>
                    <td><StatusBadge status={connection.passwordConfigured ? 'active' : 'disabled'}
                      label={connection.passwordConfigured ? '密码已配置' : '密码待配置'} /><small>SSL {connection.sslMode || 'require'}</small></td>
                    <td>{referenceCount === 0 ? <span>未引用</span> : (
                      <details className="mih-inline-details"><summary>{referenceCount} 个任务</summary>
                        <ul className="mih-source-issues">{references.map((reference) => (
                          <li key={reference.sourceKey || reference.id}>{reference.displayName || reference.sourceKey}<small><code>{reference.sourceKey}</code> · {reference.status || 'unknown'}</small></li>
                        ))}</ul>
                      </details>
                    )}</td>
                    <td>{test ? <StatusBadge status={test.ok ? 'active' : 'down'} label={test.ok ? '连接正常' : test.error?.code || '测试失败'} /> : '尚未在本页测试'}<small>{formatDate(connection.updatedAt)}</small></td>
                    <td><div className="mih-table__actions mih-table__actions--wide">
                      <button className="qp-button qp-button--ghost" type="button" disabled={testingId === connection.id}
                        onClick={() => testConnection(connection)}><ShieldCheck size={16} />{testingId === connection.id ? '测试中…' : '测试'}</button>
                      <button className="qp-button qp-button--ghost" type="button"
                        onClick={() => { setSaveError(null); setEditing(connection) }}><PencilSimple size={16} />编辑</button>
                      <button className="qp-button qp-button--ghost" type="button" disabled={referenceCount > 0}
                        title={referenceCount > 0 ? '先从所有清洗任务解除引用' : ''} onClick={() => setDeleting(connection)}><Trash size={16} />删除</button>
                    </div></td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        </section>
      )}

      {creating ? <DatabaseConnectionModal busy={saving} error={saveError} onSave={save}
        onClose={() => { if (!saving) { setCreating(false); setSaveError(null) } }} /> : null}
      {editing ? <DatabaseConnectionModal key={editing.id} connection={editing} busy={saving} error={saveError} onSave={save}
        onClose={() => { if (!saving) { setEditing(null); setSaveError(null) } }} /> : null}
      {deleting ? <ConfirmDialog
        title="删除数据库配置"
        description={`将删除 ${deleting.displayName}。该操作只允许在没有任务引用时执行。`}
        confirmLabel="删除配置"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onCancel={() => { if (!deleteBusy) setDeleting(null) }}
      /> : null}
    </>
  )
}
