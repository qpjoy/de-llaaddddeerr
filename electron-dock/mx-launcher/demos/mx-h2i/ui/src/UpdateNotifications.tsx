import type { UpdateState } from './bridge';
import Icon from './Icon';

const messages: Record<string, string> = {
  'update-available': '新版本已发布',
  blocked: '新版本暂不可安装',
  downloading: '正在下载更新',
  'download-failed': '更新下载失败',
  'ready-to-install': '更新已下载，可以安装',
  'installer-opened': '安装包已打开',
  staged: '更新已准备就绪',
};

export function hasUpdateNotification(update: UpdateState): boolean {
  return update.updateAvailable === true || Boolean(messages[update.status || '']);
}

export default function UpdateNotifications({
  update,
  busy,
  onOpen,
}: {
  update: UpdateState;
  busy: boolean;
  onOpen(): void;
}) {
  const available = hasUpdateNotification(update);
  return (
    <section className="mincave-notifications" aria-label="版本更新通知">
      {available ? (
        <div className="mincave-notification-card">
          <span className="mincave-notification-icon">
            <Icon name="package" size={23} />
          </span>
          <div>
            <h3>版本更新{update.latestVersion ? ` · ${update.latestVersion}` : ''}</h3>
            <p role="status">{messages[update.status || ''] || '新版本已发布'}</p>
            <button className="mincave-button primary" onClick={onOpen}>
              查看更新
            </button>
          </div>
        </div>
      ) : (
        <div className="mincave-notifications-empty">
          <Icon name="bell" size={30} />
          <p role="status">{update.status === 'failed' ? '检查更新失败' : '暂无版本更新通知'}</p>
          <button className="mincave-notification-check" data-action="checkUpdates" disabled={busy}>
            <Icon name="refresh" size={14} />
            检查更新
          </button>
        </div>
      )}
      {update.currentVersion && (
        <p className="mincave-notification-version">当前版本 {update.currentVersion}</p>
      )}
    </section>
  );
}
