import { computed, ref } from 'vue';
import { Notify } from 'quasar';

import type { RuntimeMode, TunnelBridge, TunnelSnapshot } from 'src/types/tunnel';

const snapshot = ref<TunnelSnapshot | null>(null);
const selectedMode = ref<RuntimeMode>('app-rule');
const corePath = ref('');
const localPorts = ref({
  mixed: 23458,
  dns: 23459
});

export const modeOptions = [
  { label: '虚拟网卡', value: 'system-tun' },
  { label: '全局模式', value: 'app-global' },
  { label: 'App 模式', value: 'app-rule' }
] as const;

export const ruleKindOptions = [
  { label: '白名单', value: 'allow' },
  { label: '黑名单', value: 'block' }
] as const;

function toast(message: string, color = 'positive'): void {
  Notify.create({ message, color, timeout: 2200, position: 'top-right' });
}

function getTunnelBridge(): TunnelBridge {
  if (!window.tunnel) {
    throw new Error('Electron 隧道接口未加载，请重启开发服务后再试。');
  }
  return window.tunnel;
}

function friendlyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/Cannot read properties of undefined|Electron 隧道接口未加载|window\.tunnel/i.test(message)) {
    return 'Electron 隧道接口未加载，请重启 pnpm dev:quasar 后再试。';
  }
  if (/subscription url is required/i.test(message)) {
    return '请先填写订阅链接。';
  }
  if (/Invalid URL|Failed to construct 'URL'|subscription url is invalid/i.test(message)) {
    return '订阅链接格式不正确，请使用 http:// 或 https:// 开头的完整地址。';
  }
  if (/subscription url must use http or https/i.test(message)) {
    return '订阅链接只支持 http:// 或 https://。';
  }
  if (/subscription yaml is invalid|subscription yaml has no proxy definitions/i.test(message)) {
    return '订阅内容不是有效的 Mihomo YAML，已取消保存。';
  }
  if (/subscription update failed: empty body/i.test(message)) {
    return '订阅内容为空，已取消保存。';
  }
  if (/subscription update failed: HTTP 401|subscription update failed: HTTP 403/i.test(message)) {
    return '订阅拉取失败：用户名或密码不正确，或服务器拒绝访问。';
  }
  const httpStatus = message.match(/subscription update failed: HTTP (\d+)/i);
  if (httpStatus) {
    return `订阅拉取失败：服务器返回 HTTP ${httpStatus[1]}。`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    return '订阅拉取失败：当前网络无法连接订阅服务器。';
  }
  if (/no active subscription configured/i.test(message)) {
    return '还没有启用订阅，请先创建并启用一个订阅。';
  }
  if (/active subscription has no downloaded content/i.test(message)) {
    return '当前订阅还没有下载内容，请先更新订阅。';
  }
  if (/mihomo 未运行/i.test(message)) {
    return message;
  }
  if (/ERR_PROXY_CONNECTION_FAILED|本地代理连接失败/i.test(message)) {
    return '本地代理连接失败，请确认 mihomo 已启动，并且代理端口没有被其他应用占用。';
  }
  if (/ERR_TUNNEL_CONNECTION_FAILED|隧道连接失败/i.test(message)) {
    return '隧道连接失败，请检查当前节点是否可用，以及 App 模式白名单是否允许该域名。';
  }
  if (/ERR_CONNECTION_CLOSED|连接被关闭/i.test(message)) {
    return '连接被关闭。App 模式下海外域名必须在白名单内；如果已添加白名单，请稍等 core 重载后再试。';
  }

  return message || '操作失败，请查看日志。';
}

async function refresh(): Promise<void> {
  snapshot.value = await getTunnelBridge().snapshot();
  selectedMode.value = snapshot.value.status.mode;
  corePath.value = snapshot.value.status.corePath ?? '';
  localPorts.value = {
    mixed: snapshot.value.status.ports.mixed,
    dns: snapshot.value.status.ports.dns
  };
}

async function run(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
    await refresh();
    toast(message);
  } catch (error) {
    toast(friendlyErrorMessage(error), 'negative');
  }
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function redactedUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
}

function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.round(hours / 24)} 天前`;
}

async function toggleCore(): Promise<void> {
  if (snapshot.value?.status.running) {
    await run(() => window.tunnel.stop(), 'mihomo 已停止');
    return;
  }
  await run(() => window.tunnel.start(), 'mihomo 已启动');
}

export function useTunnel() {
  const modeLabel = computed(() => modeOptions.find((item) => item.value === snapshot.value?.status.mode)?.label ?? 'App 模式');
  const eventText = computed(() => (snapshot.value?.events ?? [])
    .map((event) => `[${event.level}] ${new Date(event.createdAt).toLocaleString()} ${event.message}`)
    .join('\n'));

  return {
    snapshot,
    selectedMode,
    corePath,
    localPorts,
    modeLabel,
    eventText,
    refresh,
    run,
    toast,
    formatBytes,
    redactedUrl,
    relativeTime,
    toggleCore
  };
}
