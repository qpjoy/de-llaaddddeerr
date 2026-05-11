import { computed, ref } from 'vue';
import { Notify } from 'quasar';

import type { RuntimeMode, TunnelSnapshot } from 'src/types/tunnel';

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
  Notify.create({ message, color, timeout: 1400, position: 'top-right' });
}

async function refresh(): Promise<void> {
  snapshot.value = await window.tunnel.snapshot();
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
    toast(error instanceof Error ? error.message : String(error), 'negative');
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
