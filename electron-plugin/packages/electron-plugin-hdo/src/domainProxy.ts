import { Buffer } from 'node:buffer';
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface HdoSessionLike {
  setProxy(config: {
    mode?: string;
    proxyRules?: string;
    proxyBypassRules?: string;
    pacScript?: string;
  }): Promise<void>;
  forceReloadProxyConfig?(): Promise<void>;
}

export interface HdoDomainBinding {
  domain: string;
  targetHost: string;
  targetPort?: number | null;
  protocol?: string | null;
}

interface NormalizedBinding extends HdoDomainBinding {
  domain: string;
  targetHost: string;
  targetPort: number | null;
}

export class HdoSessionDomainProxy {
  private server: Server | null = null;
  private port: number | null = null;
  private bindings: NormalizedBinding[] = [];
  private applied = false;

  constructor(
    private readonly session: HdoSessionLike,
    private readonly log?: {
      warn(msg: string, meta?: Record<string, unknown>): void;
    }
  ) {}

  async apply(bindings: HdoDomainBinding[]): Promise<Record<string, unknown>> {
    const result = await this.prepare(bindings);
    if (this.bindings.length === 0) {
      await this.disable();
      return result;
    }
    const pacScript = renderPacDataUrl(this.port!, this.bindings.map((binding) => binding.domain));
    await this.session.setProxy({ mode: 'pac_script', pacScript });
    await this.session.forceReloadProxyConfig?.().catch((err) => {
      this.log?.warn('failed to reload HDO domain proxy config', { error: errorMessage(err) });
    });
    this.applied = true;
    return result;
  }

  async prepare(bindings: HdoDomainBinding[]): Promise<Record<string, unknown>> {
    this.bindings = normalizeBindings(bindings);
    if (this.bindings.length === 0) {
      return { enabled: false, domains: [] };
    }
    await this.ensureServer();
    return {
      enabled: true,
      proxy: `127.0.0.1:${this.port}`,
      pacUrl: `http://127.0.0.1:${this.port}/proxy.pac`,
      domains: this.bindings.map((binding) => binding.domain)
    };
  }

  async disable(): Promise<void> {
    this.bindings = [];
    if (!this.applied) return;
    this.applied = false;
    await this.session.setProxy({ mode: 'direct' }).catch((err) => {
      this.log?.warn('failed to clear HDO domain proxy', { error: errorMessage(err) });
    });
    await this.session.forceReloadProxyConfig?.().catch((err) => {
      this.log?.warn('failed to reload HDO domain proxy config after clear', { error: errorMessage(err) });
    });
  }

  async close(): Promise<void> {
    await this.disable();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async ensureServer(): Promise<void> {
    if (this.server && this.port) return;
    const server = createServer((socket) => this.handleClient(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to allocate HDO domain proxy port'));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve();
      });
    });
  }

  private handleClient(client: Socket): void {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      const buffered = Buffer.concat(chunks, total);
      if (total < 16_384 && buffered.indexOf('\r\n\r\n') === -1) return;
      client.off('data', onData);
      this.forward(client, buffered);
    };
    client.on('data', onData);
    client.once('error', () => undefined);
  }

  private forward(client: Socket, firstChunk: Buffer): void {
    if (this.respondToPacRequest(client, firstChunk)) return;

    const request = parseProxyRequest(firstChunk);
    if (!request) {
      client.destroy();
      return;
    }
    const binding = this.findBinding(request.hostname);
    const host = binding?.targetHost ?? request.hostname;
    const port = binding?.targetPort ?? request.port ?? defaultPort(request.protocol, request.connect);
    const upstream = connect({ host, port });
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once('error', closeBoth);
    upstream.once('error', closeBoth);
    upstream.once('connect', () => {
      if (request.connect) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      } else {
        upstream.write(rewriteHttpRequestForOrigin(firstChunk));
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  private respondToPacRequest(client: Socket, buffer: Buffer): boolean {
    const request = parsePacRequest(buffer);
    if (!request) return false;

    if (!this.port) {
      client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }

    const body = request.method === 'HEAD'
      ? ''
      : renderPacScript(this.port, this.bindings.map((binding) => binding.domain));
    const headers = [
      'HTTP/1.1 200 OK',
      'Content-Type: application/x-ns-proxy-autoconfig; charset=utf-8',
      'Cache-Control: no-store',
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n');
    client.end(headers + body);
    return true;
  }

  private findBinding(hostname: string): NormalizedBinding | null {
    const host = hostname.toLowerCase();
    return this.bindings.find((binding) => host === binding.domain || host.endsWith(`.${binding.domain}`)) ?? null;
  }
}

function normalizeBindings(bindings: HdoDomainBinding[]): NormalizedBinding[] {
  const seen = new Set<string>();
  const out: NormalizedBinding[] = [];
  for (const binding of bindings) {
    const domain = normalizeDomain(binding.domain);
    if (!domain || seen.has(domain)) continue;
    const targetHost = stringValue(binding.targetHost);
    if (!targetHost) continue;
    seen.add(domain);
    out.push({
      domain,
      targetHost,
      targetPort: normalizePort(binding.targetPort),
      protocol: stringValue(binding.protocol)
    });
  }
  return out;
}

function parseProxyRequest(buffer: Buffer): {
  connect: boolean;
  hostname: string;
  port: number | null;
  protocol: string;
} | null {
  const header = buffer.toString('latin1', 0, Math.min(buffer.length, 16_384));
  const [requestLine, ...lines] = header.split(/\r?\n/);
  const [method, target] = requestLine.split(/\s+/);
  if (!method || !target) return null;

  if (method.toUpperCase() === 'CONNECT') {
    const { host, port } = splitHostPort(target);
    if (!host) return null;
    return { connect: true, hostname: host, port, protocol: 'https' };
  }

  let host: string | null = null;
  let port: number | null = null;
  let protocol = 'http';
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      host = url.hostname;
      port = normalizePort(url.port ? Number(url.port) : null);
      protocol = url.protocol === 'https:' ? 'https' : 'http';
    } catch {
      host = null;
    }
  }
  if (!host) {
    const hostHeader = lines.find((line) => /^host:/i.test(line));
    const parsed = splitHostPort(hostHeader?.replace(/^host:\s*/i, '') ?? '');
    host = parsed.host;
    port = parsed.port;
  }
  return host ? { connect: false, hostname: host, port, protocol } : null;
}

function parsePacRequest(buffer: Buffer): { method: 'GET' | 'HEAD' } | null {
  const header = buffer.toString('latin1', 0, Math.min(buffer.length, 16_384));
  const [requestLine, ...lines] = header.split(/\r?\n/);
  const [rawMethod, rawTarget] = requestLine.split(/\s+/);
  const method = rawMethod?.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (!rawTarget || /^https?:\/\//i.test(rawTarget)) return null;

  const hostHeader = lines.find((line) => /^host:/i.test(line));
  const { host } = splitHostPort(hostHeader?.replace(/^host:\s*/i, '') ?? '');
  const localHost = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!localHost) return null;

  try {
    const url = new URL(rawTarget, 'http://127.0.0.1');
    return url.pathname === '/proxy.pac' ? { method } : null;
  } catch {
    return null;
  }
}

function rewriteHttpRequestForOrigin(buffer: Buffer): Buffer {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return buffer;
  const header = buffer.toString('latin1', 0, headerEnd);
  const lines = header.split('\r\n');
  const parts = lines[0]?.split(/\s+/) ?? [];
  if (parts.length < 3 || !/^https?:\/\//i.test(parts[1])) return buffer;
  try {
    const url = new URL(parts[1]);
    parts[1] = `${url.pathname || '/'}${url.search}`;
    lines[0] = parts.join(' ');
    return Buffer.concat([
      Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
      buffer.subarray(headerEnd + 4)
    ]);
  } catch {
    return buffer;
  }
}

function splitHostPort(value: string): { host: string | null; port: number | null } {
  const trimmed = value.trim();
  if (!trimmed) return { host: null, port: null };
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    const host = end > 0 ? trimmed.slice(1, end) : null;
    const port = normalizePort(trimmed.slice(end + 1).replace(/^:/, ''));
    return { host, port };
  }
  const parts = trimmed.split(':');
  if (parts.length > 1) {
    const port = normalizePort(parts.pop());
    return { host: parts.join(':'), port };
  }
  return { host: trimmed, port: null };
}

function renderPacDataUrl(port: number, domains: string[]): string {
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(renderPacScript(port, domains)).toString('base64')}`;
}

function renderPacScript(port: number, domains: string[]): string {
  return `
function FindProxyForURL(url, host) {
  var h = String(host || '').toLowerCase();
  var domains = ${JSON.stringify(domains)};
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (h === d || h.slice(-(d.length + 1)) === '.' + d) {
      return 'PROXY 127.0.0.1:${port}';
    }
  }
  return 'DIRECT';
}
`;
}

function defaultPort(protocol: string, connectRequest: boolean): number {
  if (connectRequest || protocol === 'https') return 443;
  return 80;
}

function normalizeDomain(value: unknown): string | null {
  const text = stringValue(value)?.toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!text || text.length > 253 || !/^[a-z0-9.-]+$/.test(text)) return null;
  return text;
}

function normalizePort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
