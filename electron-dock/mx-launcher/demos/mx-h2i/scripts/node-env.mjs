export function cleanElectronNodeEnv(source = process.env) {
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
  return env;
}

function isUnsupportedElectronNodeOption(value) {
  const option = String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/^[\u2010-\u2015]+/, '--');
  return /^--no-expose-wasm(?:=.*)?$/.test(option);
}
