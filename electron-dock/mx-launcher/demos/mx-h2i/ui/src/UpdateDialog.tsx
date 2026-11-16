import type { UpdateState } from './bridge';
import { formatTransfer, updateStage } from './model';
import LegacyPanel from './LegacyPanel';
import Modal from './Modal';

function updatePhase(update: UpdateState, busyAction: string) {
  const ready = ['staged', 'ready-to-install', 'installer-opened'].includes(update.status || '');
  const restarting = busyAction === 'restartApp';
  const openingInstaller = busyAction === 'applyUpdate' && update.status === 'ready-to-install';
  const downloading = update.status === 'downloading' || (busyAction === 'applyUpdate' && !ready);
  const failed = update.status === 'download-failed';
  const canRestart = (update.status === 'staged' && update.restartRequired)
    || (['staged', 'installer-opened', 'applied'].includes(update.status || '') && update.restartPrompt);
  const title = restarting ? '准备重新启动'
    : openingInstaller ? '正在打开安装包'
    : downloading ? '正在下载更新'
    : failed ? '下载未完成'
    : update.status === 'installer-opened' ? '安装包已打开'
    : ready ? '更新已下载'
    : update.status === 'applied' ? '更新已完成'
    : update.status === 'up-to-date' ? '已是最新版本'
    : update.status === 'failed' ? '检查更新失败'
    : '发现新版本';
  return { ready, restarting, openingInstaller, downloading, failed, canRestart, title };
}

export function UpdateDetails({
  update,
  busyAction,
  onClose,
}: {
  update: UpdateState;
  busyAction: string;
  onClose?(): void;
}) {
  const phase = updatePhase(update, busyAction);
  const busy = Boolean(busyAction);
  const stage = phase.restarting ? 2 : updateStage(update.status);
  const percent = typeof update.downloadProgress?.percent === 'number'
    && Number.isFinite(update.downloadProgress.percent)
    ? Math.max(0, Math.min(100, update.downloadProgress.percent)) : null;
  const fileName = update.stagedPath?.split(/[\\/]/).pop();
  const error = update.installerOpenError
    || (phase.failed ? update.reason || '更新包下载失败，请重试。' : '')
    || (update.status === 'blocked' ? update.reason : '');
  const showNotes = ['update-available', 'blocked'].includes(update.status || '') && !phase.downloading;
  return (
    <div className="mincave-update">
      <div className="mincave-version-row">
        <span>当前版本 {update.currentVersion || '正在读取'}</span>
        {update.latestVersion && <strong>MinCave {update.latestVersion}</strong>}
      </div>
      <div className="mincave-update-steps">
        {['下载更新', '安装更新', '重新启动'].map((label, index) => (
          <span key={label} className={stage >= index ? 'active' : ''}>
            <i>{index + 1}</i>{label}
          </span>
        ))}
      </div>
      {showNotes && update.notesHtml && (
        <LegacyPanel html={update.notesHtml} className="release-notes-markdown mincave-release-notes" />
      )}
      {phase.downloading && (
        <div className="mincave-download">
          <div className="mincave-download-label">
            <strong>下载进度</strong>
            <span>{percent === null ? formatTransfer(update.downloadProgress?.bytes) || '正在下载' : `${percent}%`}</span>
          </div>
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
        </div>
      )}
      {phase.ready && !phase.restarting && !phase.openingInstaller && (
        <div className="mincave-update-ready">
          <strong>{update.status === 'installer-opened' ? '安装包已打开' : '下载完成'}</strong>
          {fileName && <code>{fileName}</code>}
        </div>
      )}
      {error && <p className="mincave-update-error" role="alert">{error}</p>}
      <div className="mincave-update-actions">
        {onClose && !phase.restarting && !phase.openingInstaller && (
          <button className="mincave-button" onClick={onClose}>
            {phase.ready ? '稍后安装' : '稍后'}
          </button>
        )}
        {phase.downloading || phase.openingInstaller || phase.restarting ? (
          <button className="mincave-button primary" disabled>
            {phase.restarting ? '重新启动中…' : phase.openingInstaller ? '正在打开…' : '下载中…'}
          </button>
        ) : phase.canRestart ? (
          <button className="mincave-button primary" data-action="restartApp" disabled={busy}>
            {update.status === 'staged' ? '安装并重新启动' : '重新启动'}
          </button>
        ) : update.canApply ? (
          <button className="mincave-button primary" data-action="applyUpdate" disabled={busy}>
            {phase.failed ? '重试下载' : update.status === 'ready-to-install' ? '安装更新' : '下载更新'}
          </button>
        ) : !phase.ready && update.status !== 'blocked' && (
          <button className="mincave-button" data-action="checkUpdates" disabled={busy}>检查更新</button>
        )}
        {update.installerOpenError && update.stagedPath && (
          <button className="mincave-button" data-action="showDownloadedInstaller" disabled={busy}>打开文件夹</button>
        )}
      </div>
    </div>
  );
}

export default function UpdateDialog({
  update,
  busyAction,
  onClose,
}: {
  update: UpdateState;
  busyAction: string;
  onClose(): void;
}) {
  return (
    <Modal title={updatePhase(update, busyAction).title} className="mincave-update-modal" onClose={onClose}>
      <UpdateDetails update={update} busyAction={busyAction} onClose={onClose} />
    </Modal>
  );
}
