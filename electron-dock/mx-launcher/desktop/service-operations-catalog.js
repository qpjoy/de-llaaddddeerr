// Shared by command preview and the independent host executor. No shell input API.
export const SERVICE_CATALOG_VERSION = 1;
export const DEFAULT_WORKSPACE = '/root/mx/workspace/de-llaaddddeerr/electron-dock';
const action = (label, impact = '', timeout = 120) => ({ label, impact, timeout });
export const SERVICE_CATALOG = {
  launcher: {
    label: 'MX Launcher', directory: 'mx-launcher', description: 'Internal 控制面 · 管理界面与登录服务',
    actions: {
      status: action('查看状态'), logs: action('查看日志'),
      predeploy: action('发布前检查', '构建与测试检查，不部署服务。', 1800),
      deploy: action('部署当前检出版本', '执行已有迁移、API 滚动更新、网关收敛；默认重启主机 Runner。发布期间需验证登录与联网连续性。', 7200)
    }
  },
  hub: {
    label: 'MX Insight Hub', directory: 'mx-insight-hub', description: '数据中心 · API、检索与后台任务',
    actions: {
      status: action('查看状态'), logs: action('查看日志'),
      deploy: action('部署当前检出版本', '执行 Hub 迁移与 API/worker 更新；保留原租户、Key 和共享数据。不会联动部署 Launcher。', 7200),
      smoke: action('运行验收', '显式执行 Hub 验收探针；需要主机已有验收配置。', 600)
    }
  },
  pay: {
    label: 'MX Pay', directory: 'mx-base/mx-pay', description: '独立支付中心 · 专用数据库与 SSO 查询台',
    actions: {
      status: action('查看状态'), logs: action('查看日志'), doctor: action('部署诊断'),
      deploy: action('部署当前检出版本', '仅发布 mx-pay：专用数据库迁移、支付 API 和已配置的独立 SSO 查询台。不启用正式收款、不切换 Hub 充值、不发布 Launcher/Auth。', 7200)
    }
  },
  embedding: {
    label: 'MX Embedding', directory: 'mx-base', description: 'GPU 向量服务 · Hub 向量化与 RAG 依赖',
    actions: {
      status: action('查看状态'), stats: action('资源用量'), logs: action('查看日志'), doctor: action('GPU 诊断'),
      deploy: action('部署当前检出版本', '替换模型容器时有服务窗口，影响 Hub 向量化/RAG。保留 Key、模型缓存与 GPU 检查。', 7200),
      start: action('启动', '恢复已有容器；严格检查 GPU 占用及 UUID。', 1800),
      restart: action('重启', '中断当前推理；严格 GPU 检查可能拒绝共享实例，--keep-gpu 仅适用于部署。', 1800),
      stop: action('停止', 'Hub 向量化/RAG 将不可用；保留配置、Key 和模型缓存。', 120),
      test: action('模型验收', '调用真实 GPU 模型进行验收，不启动 Hub 历史向量化。', 300)
    }
  },
  ocr: {
    label: 'MX OCR', directory: 'mx-base', description: '已验证的独立 OCR 服务 · 图像与文档识别',
    actions: {
      status: action('查看状态'), stats: action('资源用量'), logs: action('查看日志'), doctor: action('GPU 诊断'),
      deploy: action('部署当前检出版本', '替换容器会中断识别；内存中的异步任务与结果可能丢失，请先停止提交并收集结果。保留模型缓存及 GPU 保护。', 7200),
      start: action('启动', '启动现有容器并检查 GPU 与健康。', 1800),
      restart: action('重启', '识别请求会中断；异步队列与结果在内存中，请先停止提交并收集结果。', 1800),
      stop: action('停止', '停止识别服务，内存异步任务不保留；模型缓存和配置保留。', 120),
      test: action('OCR 验收', '运行真实模型验收，会占用 GPU 资源。', 300)
    }
  }
};

export function defaultServiceProfile(service, workspace = DEFAULT_WORKSPACE) {
  const definition = SERVICE_CATALOG[service];
  if (!definition) throw new Error('未知服务');
  return {
    cwd: `${workspace}/${definition.directory}`, tmpDir: '/data/tmp',
    proxyMode: ['launcher', 'hub'].includes(service) ? 'custom' : 'saved',
    proxyProtocol: 'http', proxyHost: ['launcher', 'hub'].includes(service) ? '127.0.0.1' : '', proxyPort: '7789',
    hostname: 'mx-internal-server', advertiseAddress: '192.168.1.2',
    keepStorage: '2GB', pruneUntil: '24h', installRunner: true,
    keepGpu: service === 'embedding', expectedRevision: ''
  };
}

const profileKeys = new Set(Object.keys(defaultServiceProfile('launcher')));
function invalid(message) { throw new Error(message); }
function scalar(value, label, max = 512) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(`${label}格式不正确`);
  return value.trim();
}
function absolutePath(value, label) {
  const path = scalar(value, label);
  if (!path.startsWith('/') || path === '/' || path.split('/').some(part => part === '..')) invalid(`${label}必须是专用绝对路径，不能包含 ..`);
  return path.replace(/\/+$/, '');
}
export function normalizeServiceProfile(service, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('配置必须为对象');
  for (const key of Object.keys(input)) if (!profileKeys.has(key)) invalid(`不支持的配置项：${key}`);
  const p = { ...defaultServiceProfile(service), ...input };
  p.cwd = absolutePath(p.cwd, '项目目录');
  p.tmpDir = absolutePath(p.tmpDir, '临时目录');
  if (!['saved', 'direct', 'custom'].includes(p.proxyMode)) invalid('代理模式不正确');
  if (!['http', 'https'].includes(p.proxyProtocol)) invalid('代理协议不正确');
  p.proxyHost = scalar(p.proxyHost, '代理主机', 253);
  p.proxyPort = scalar(String(p.proxyPort), '代理端口', 5);
  if (p.proxyMode === 'custom') {
    if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])$/.test(p.proxyHost)) invalid('请填写代理主机或 IP，不含协议、路径和凭据');
    if (!/^\d+$/.test(p.proxyPort) || Number(p.proxyPort) < 1 || Number(p.proxyPort) > 65535) invalid('代理端口范围为 1–65535');
    if (service === 'embedding' && /^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0|\[::\])$/i.test(p.proxyHost)) invalid('Embedding 代理必须是容器可达地址，不能指向回环或通配地址');
  }
  p.hostname = scalar(p.hostname, '节点名称', 63);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(p.hostname)) invalid('节点名称不正确');
  p.advertiseAddress = scalar(p.advertiseAddress, 'API Server 地址', 15);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(p.advertiseAddress) || p.advertiseAddress.split('.').some(n => Number(n) > 255)) invalid('API Server 地址需要 IPv4');
  p.keepStorage = scalar(p.keepStorage, '构建缓存上限', 12);
  if (!/^[1-9]\d*(?:MB|GB|TB)$/.test(p.keepStorage)) invalid('构建缓存上限示例：2GB');
  p.pruneUntil = scalar(p.pruneUntil, '缓存保留时间', 12);
  if (!/^[1-9]\d*(?:h|m)$/.test(p.pruneUntil)) invalid('缓存保留时间示例：24h');
  if (typeof p.installRunner !== 'boolean' || typeof p.keepGpu !== 'boolean') invalid('开关必须为布尔值');
  p.expectedRevision = scalar(p.expectedRevision, '代码版本', 64);
  if (p.expectedRevision && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p.expectedRevision)) invalid('代码版本需要完整 Git commit SHA，或留空在预检时锁定');
  return p;
}

export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

export function buildServiceCommand(service, operation, input) {
  const definition = SERVICE_CATALOG[service];
  const descriptor = definition?.actions[operation];
  if (!descriptor) invalid('该服务不支持此操作');
  const profile = normalizeServiceProfile(service, input);
  const env = {};
  let program = 'bash';
  let args = ['scripts/manage.sh'];
  const gpu = ['embedding', 'ocr'].includes(service);
  if (service === 'pay') args.push(operation);
  else if (gpu) args.push(operation, `mx-${service}`);
  else args.push('ops', 'internal-production', operation);
  if (operation === 'logs') {
    if (service === 'hub' || service === 'pay') { /* Product helpers return bounded API logs. */ }
    else if (gpu) { program = 'docker'; args = ['logs', '--tail', '200', `mx-${service}-api`]; }
    else { program = 'kubectl'; args = ['-n', 'mx-internal-shadow', 'logs', 'deployment/mx-launcher-internal', '--tail=200']; }
  }
  if (service === 'launcher') {
    env.MX_K8S_AUTO_REPAIR_KUBEADM_ENDPOINT = operation === 'deploy' ? '1' : '0';
    env.MX_INSIGHT_HUB_DEPLOY = '0';
    if (operation === 'deploy') {
      Object.assign(env, {
        TMPDIR: profile.tmpDir, MX_K8S_OS_HOSTNAME: profile.hostname,
        MX_K8S_APISERVER_ADVERTISE_ADDRESS: profile.advertiseAddress,
        MX_SHADOW_BUILDKIT_KEEP_STORAGE: profile.keepStorage,
        MX_SHADOW_BUILDKIT_PRUNE_UNTIL: profile.pruneUntil,
        MX_INTERNAL_PRODUCTION_NATIVE_HOST_RUNNER_INSTALL: profile.installRunner ? '1' : '0'
      });
    }
  }
  if (service === 'hub') env.MX_INSIGHT_SYNC_LAUNCHER = '0';
  if (service !== 'pay' && (operation === 'deploy' || (service === 'launcher' && operation === 'predeploy'))) {
    const proxy = `${profile.proxyProtocol}://${profile.proxyHost}:${profile.proxyPort}`;
    if (profile.proxyMode !== 'saved') {
      const name = { launcher: 'MX_LAUNCHER_BUILD_PROXY', hub: 'MX_INSIGHT_BUILD_PROXY', embedding: 'MX_EMBEDDING_PROXY', ocr: 'PROXY' }[service];
      env[name] = profile.proxyMode === 'direct' ? '' : proxy;
    }
    if (service === 'embedding' && profile.keepGpu) args.push('--keep-gpu');
  }
  const lines = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = `${program} ${args.map(shellQuote).join(' ')}`;
  return {
    service, action: operation, profile, cwd: profile.cwd, program, args, env,
    impact: service === 'launcher' && operation === 'deploy' && !profile.installRunner
      ? '执行已有迁移、API 滚动更新和网关收敛；本次不安装或重启原主机 Runner。发布期间需验证登录与联网连续性。'
      : descriptor.impact,
    timeout: descriptor.timeout,
    mutating: ['deploy', 'start', 'restart', 'stop'].includes(operation),
    // Preview is copyable; the executor uses argv and an isolated environment, never this string.
    command: `cd -- ${shellQuote(profile.cwd)} && \\\n${lines.length ? `${lines.join(' \\\n')} \\\n` : ''}${command}`
  };
}
