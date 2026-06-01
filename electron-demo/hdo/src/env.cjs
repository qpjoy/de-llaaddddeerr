const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function loadProjectEnv(options = {}) {
  const appDir = options.appDir ? resolve(options.appDir) : resolve(__dirname, '..');
  const candidates = unique([
    resolve(process.cwd(), '.env'),
    resolve(appDir, '.env')
  ]);
  const loaded = [];
  const values = {};

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    Object.assign(values, parsed);
    loaded.push(file);
  }

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return { files: loaded, values };
}

function parseEnv(source) {
  const out = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = cleanEnvValue(match[2]);
  }
  return out;
}

function cleanEnvValue(value) {
  const withoutComment = stripInlineComment(value.trim());
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    const body = withoutComment.slice(1, -1);
    return withoutComment.startsWith('"')
      ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : body;
  }
  return withoutComment;
}

function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (!quote && char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function unique(items) {
  return [...new Set(items)];
}

module.exports = {
  loadProjectEnv,
  parseEnv
};
