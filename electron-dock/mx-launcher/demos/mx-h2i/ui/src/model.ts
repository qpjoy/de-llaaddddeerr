export function connectionLabel(
  state: string | undefined,
  pending = false,
  paused = false,
): string {
  if (paused) return '恢复已暂停';
  if (pending) return '正在连接';
  const labels: Record<string, string> = {
    connected: '已连接',
    idle: '未连接',
    connecting: '正在连接',
    'lease-only': '等待系统授权',
    'tunnel-only': '网络需要修复',
    'server-unavailable': '内网服务暂不可达',
    'network-unavailable': '当前网络不可用',
    forbidden: '访问受限',
  };
  return labels[state || ''] || '正在读取网络状态';
}

export function categoryLabel(category: string): string {
  return (
    (
      { network: '网络工具', ops: '工具箱', bridge: '测试工具', platform: '平台应用' } as Record<
        string,
        string
      >
    )[category] ||
    category ||
    '其他应用'
  );
}

export function formatTransfer(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(1)} ${units[unit]}`;
}

export function updateStage(status: string | undefined): number {
  if (['staged', 'ready-to-install', 'installer-opened'].includes(status || '')) return 2;
  if (status === 'downloading') return 1;
  return 0;
}
