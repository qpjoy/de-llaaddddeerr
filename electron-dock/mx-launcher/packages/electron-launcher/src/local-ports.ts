import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

/**
 * Local port allocation for standalone launcher products (docs/19 §4.3).
 *
 * Fixed defaults like mihomo 23457/23458 collide as soon as two standalone
 * products (MX-H2I + Luopan) run the same runtime on one machine. Each
 * product/service pair instead derives a stable base port from a hash, probes
 * it, and scans upward past ports that are already in use. The result is
 * stable per machine as long as the same product asks first, and never
 * silently reuses a port another product is listening on.
 */

export interface ElectronLauncherLocalPortRequest {
  /** Product that owns the listener, e.g. `mx-h2i`, `luopan`. */
  productId: string;
  /** Service label inside the product, e.g. `mihomo-mixed`, `mihomo-controller`, `pac-edge`. */
  service: string;
  /** Previously persisted port; reused when still free. */
  preferredPort?: number | null;
  /** Override the hash-derived base port. */
  basePort?: number | null;
  /** How many candidate ports to probe before failing. Default 50. */
  maxAttempts?: number | null;
  /** Bind host used for probing. Default 127.0.0.1. */
  host?: string | null;
}

export interface ElectronLauncherLocalPortLease {
  port: number;
  source: 'preferred' | 'base' | 'scan';
  basePort: number;
  attempts: number;
}

const PORT_RANGE_START = 21000;
const PORT_RANGE_SIZE = 20000; // 21000-40999, clear of common dev servers and ephemeral churn

export function electronLauncherDefaultBasePort(productId: string, service: string): number {
  const digest = createHash('sha256').update(`${productId}:${service}`).digest();
  const offset = digest.readUInt32BE(0) % PORT_RANGE_SIZE;
  return PORT_RANGE_START + offset;
}

export async function allocateElectronLauncherLocalPort(
  request: ElectronLauncherLocalPortRequest
): Promise<ElectronLauncherLocalPortLease> {
  const productId = request.productId?.trim();
  const service = request.service?.trim();
  if (!productId || !service) throw new Error('allocateElectronLauncherLocalPort requires productId and service');
  const host = request.host?.trim() || '127.0.0.1';
  const maxAttempts = normalizeAttempts(request.maxAttempts);
  const basePort = normalizePort(request.basePort) ?? electronLauncherDefaultBasePort(productId, service);

  const preferred = normalizePort(request.preferredPort);
  let attempts = 0;
  if (preferred) {
    attempts += 1;
    if (await portIsFree(host, preferred)) {
      return { port: preferred, source: 'preferred', basePort, attempts };
    }
  }
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = PORT_RANGE_START + ((basePort - PORT_RANGE_START + i) % PORT_RANGE_SIZE);
    if (candidate === preferred) continue;
    attempts += 1;
    if (await portIsFree(host, candidate)) {
      return { port: candidate, source: i === 0 ? 'base' : 'scan', basePort, attempts };
    }
  }
  throw new Error(
    `No free local port for ${productId}/${service} after ${attempts} attempts (base ${basePort})`
  );
}

function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function normalizePort(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 65535 ? value : null;
}

function normalizeAttempts(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 50;
  return Math.min(value, 2000);
}
