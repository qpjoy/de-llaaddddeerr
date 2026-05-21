#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const host = process.env.HDO_GATEWAY_RUNNER_HOST || '127.0.0.1';
const port = Number(process.env.HDO_GATEWAY_RUNNER_PORT || '18081');
const token = process.env.HDO_GATEWAY_RUNNER_TOKEN || '';
const scriptPath = resolve(process.env.HDO_GATEWAY_SCRIPT || resolve(here, 'manage.sh'));
const cwd = resolve(process.env.HDO_GATEWAY_CWD || resolve(here, '../..'));
const timeoutMs = Number(process.env.HDO_GATEWAY_RUNNER_TIMEOUT_MS || String(20 * 60 * 1000));
const outputLimit = Number(process.env.HDO_GATEWAY_RUNNER_OUTPUT_LIMIT || '80000');
const allowedCommands = new Set([
  'deploy-domestic',
  'sync-peers',
  'sync-and-repair-domestic',
  'repair-domestic-routes',
  'deploy-domestic-mihomo-wireguard',
  'deploy-oversea-mihomo-hysteria2',
  'status'
]);

let running = false;

if (!token) {
  console.error('hdo-runner: HDO_GATEWAY_RUNNER_TOKEN is required');
  process.exit(1);
}

if (!existsSync(scriptPath)) {
  console.error(`hdo-runner: gateway script not found: ${scriptPath}`);
  process.exit(1);
}

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`hdo-runner: invalid HDO_GATEWAY_RUNNER_PORT: ${process.env.HDO_GATEWAY_RUNNER_PORT}`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        host,
        port,
        scriptPath,
        cwd,
        running,
        commands: [...allowedCommands]
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/run') {
      if (running) {
        sendJson(res, 409, { error: 'HDO gateway runner already has a job running' });
        return;
      }
      const body = await readJson(req);
      const args = normalizeArgs(body.args);
      if (!args.length || !allowedCommands.has(args[0])) {
        sendJson(res, 400, { error: 'unsupported HDO gateway command' });
        return;
      }

      running = true;
      try {
        const result = await runGateway(args, body);
        sendJson(res, result.exitCode === 0 ? 200 : 500, result);
      } finally {
        running = false;
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, host, () => {
  console.log(`hdo-runner: listening on http://${host}:${port}`);
  console.log(`hdo-runner: script=${scriptPath}`);
  console.log(`hdo-runner: cwd=${cwd}`);
});

function isAuthorized(req) {
  const header = String(req.headers.authorization || '').trim();
  return header === `Bearer ${token}`;
}

function normalizeArgs(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

function readJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
        rejectBody(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function runGateway(args, body) {
  const startedAt = new Date().toISOString();
  const env = {
    ...process.env,
    HDO_SERVER_URL: typeof body.serverUrl === 'string' ? body.serverUrl : process.env.HDO_SERVER_URL || ''
  };
  if (typeof body.bearerToken === 'string' && body.bearerToken) {
    env.HDO_TOKEN = body.bearerToken;
  }

  return new Promise((resolveRun) => {
    let output = '';
    let timedOut = false;
    const child = spawn('bash', [scriptPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      append(`\nhdo-runner: command timed out after ${Math.round(timeoutMs / 60000)} minutes\n`);
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolveRun({
        status: 'failed',
        command: formatCommand(['bash', scriptPath, ...args]),
        args,
        scriptPath,
        cwd,
        output,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        error: err.message
      });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const exitCode = timedOut ? code ?? 124 : code ?? 1;
      resolveRun({
        status: exitCode === 0 ? 'succeeded' : 'failed',
        command: formatCommand(['bash', scriptPath, ...args]),
        args,
        scriptPath,
        cwd,
        output,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        error:
          exitCode === 0
            ? null
            : timedOut
              ? `command timed out after ${Math.round(timeoutMs / 60000)} minutes`
              : `command exited with ${exitCode}`
      });
    });

    function append(chunk) {
      const next = output + chunk.toString();
      output = next.length > outputLimit ? next.slice(next.length - outputLimit) : next;
    }
  });
}

function sendJson(res, statusCode, payload) {
  const content = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content)
  });
  res.end(content);
}

function formatCommand(parts) {
  return parts.map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
