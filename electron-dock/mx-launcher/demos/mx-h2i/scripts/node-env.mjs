export function cleanElectronNodeEnv(source = process.env, platform = process.platform) {
  const env = { ...source };
  for (const key of ['NODE_OPTIONS', 'NPM_CONFIG_NODE_OPTIONS', 'npm_config_node_options']) {
    if (!env[key]) continue;
    const next = String(env[key])
      .split(/\s+/)
      .filter((part) => part && !isUnsupportedElectronNodeOption(part))
      .join(' ');
    if (next) env[key] = next;
    else delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  if (platform === 'win32') ensureWindowsSystemToolsPath(env);
  return env;
}

function ensureWindowsSystemToolsPath(env) {
  const systemRoot = environmentValue(env, 'SystemRoot')
    || environmentValue(env, 'windir')
    || 'C:\\Windows';
  const root = String(systemRoot).replace(/[\\/]+$/, '');
  const required = [
    `${root}\\System32\\WindowsPowerShell\\v1.0`,
    `${root}\\System32`
  ];
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
  const existing = String(env[pathKey] || '').split(';').map((item) => item.trim()).filter(Boolean);
  const seen = new Set(existing.map(normalizeWindowsPath));
  const missing = required.filter((item) => !seen.has(normalizeWindowsPath(item)));
  env[pathKey] = [...missing, ...existing].join(';');
}

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : null;
}

function normalizeWindowsPath(value) {
  return String(value || '').replace(/^"|"$/g, '').replace(/[\\/]+$/, '').toLowerCase();
}

function isUnsupportedElectronNodeOption(value) {
  const option = String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/^[\u2010-\u2015]+/, '--');
  return /^--no-expose-wasm(?:=.*)?$/.test(option);
}
