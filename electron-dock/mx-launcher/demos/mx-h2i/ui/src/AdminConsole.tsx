import { useEffect, useRef, useState } from 'react';
import AdminWorkspacePages from './AdminWorkspacePages';
import AdminMembers from './AdminMembers';
import { adminPages, type AdminPage, type AdminRequest, type AdminWorkspace } from './admin';
import { view } from './bridge';
import Icon from './Icon';

export default function AdminConsole({
  page,
  setPage,
}: {
  page: AdminPage;
  setPage(page: AdminPage): void;
}) {
  const [data, setData] = useState<AdminWorkspace | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
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
  useEffect(() => {
    setError('');
  }, [page]);
  async function mutate(input: AdminRequest) {
    const turn = epoch.current;
    setBusy(true);
    setError('');
    const result = await view.admin(input);
    if (turn !== epoch.current) return false;
    if (!result.ok) {
      setError(result.error.message);
      setBusy(false);
      return false;
    }
    await load();
    return true;
  }
  const title = adminPages.find((item) => item.id === page)!.title;
  if (!data)
    return (
      <section className="mincave-admin-access">
        <Icon name="users" size={38} />
        <h1>{title}</h1>
        <p role="status">{busy ? '正在加载' : error}</p>
        {!busy && (
          <button className="mincave-button" onClick={() => void load()}>
            刷新
          </button>
        )}
      </section>
    );
  return (
    <>
      <div className="mincave-page-heading">
        <h1>{title}</h1>
      </div>
      {page === 'members' ? (
        <AdminMembers data={data} busy={busy} error={error} save={mutate} />
      ) : (
        <AdminWorkspacePages
          key={page}
          page={page}
          data={data}
          busy={busy}
          error={error}
          save={mutate}
          reload={() => void load()}
          setPage={setPage}
        />
      )}
    </>
  );
}
