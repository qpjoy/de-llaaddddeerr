import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';

import type { CoreDnsConfigMapManifest, GatewayConfigMapManifest } from '../types.js';

type ConfigMapManifest = CoreDnsConfigMapManifest | GatewayConfigMapManifest;

interface KubernetesConfigMapObject {
  apiVersion: 'v1';
  kind: 'ConfigMap';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    resourceVersion?: string;
  };
  data: ConfigMapManifest['data'];
}

interface KubernetesApplyOutcome {
  status: 'server-dry-run' | 'applied' | 'failed';
  applied: boolean;
  resourceVersion: string | null;
  message: string;
}

export interface KubernetesResponse {
  statusCode: number;
  body: unknown;
  text: string;
}

const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const caPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

export async function applyCoreDnsConfigMapToKubernetes(
  manifest: CoreDnsConfigMapManifest,
  serverDryRun: boolean
): Promise<KubernetesApplyOutcome> {
  return applyConfigMapToKubernetes(manifest, serverDryRun);
}

export async function applyGatewayConfigMapToKubernetes(
  manifest: GatewayConfigMapManifest,
  serverDryRun: boolean
): Promise<KubernetesApplyOutcome> {
  const outcome = await applyConfigMapToKubernetes(manifest, serverDryRun);
  if (serverDryRun || outcome.status !== 'applied') return outcome;
  const rollout = await triggerInternalGatewayRollout(manifest.metadata.namespace, outcome.resourceVersion);
  if (rollout.status === 'failed') {
    return {
      status: 'failed',
      applied: false,
      resourceVersion: outcome.resourceVersion,
      message: `${outcome.message}; ${rollout.message}`
    };
  }
  return {
    ...outcome,
    message: `${outcome.message}; ${rollout.message}`
  };
}

async function applyConfigMapToKubernetes(
  manifest: ConfigMapManifest,
  serverDryRun: boolean
): Promise<KubernetesApplyOutcome> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) {
    return {
      status: 'failed',
      applied: false,
      resourceVersion: null,
      message: 'not running inside a Kubernetes cluster'
    };
  }

  const name = manifest.metadata.name;
  const namespace = manifest.metadata.namespace;
  const resourcePath = `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`;
  const existing = await kubernetesRequest('GET', resourcePath);
  if (existing.statusCode === 404) {
    return {
      status: 'failed',
      applied: false,
      resourceVersion: null,
      message: `target ConfigMap ${namespace}/${name} does not exist; create the baseline object through RBAC-controlled manifests first`
    };
  }
  if (existing.statusCode < 200 || existing.statusCode >= 300) {
    return {
      status: 'failed',
      applied: false,
      resourceVersion: null,
      message: `failed to read target ConfigMap ${namespace}/${name}: HTTP ${existing.statusCode} ${existing.text}`
    };
  }

  const resourceVersion = metadataString(existing.body, 'resourceVersion');
  const query = serverDryRun ? '?dryRun=All' : '';
  const updated = await kubernetesRequest(
    'PUT',
    `${resourcePath}${query}`,
    toKubernetesConfigMapObject(manifest, resourceVersion)
  );
  if (updated.statusCode < 200 || updated.statusCode >= 300) {
    return {
      status: 'failed',
      applied: false,
      resourceVersion: null,
      message: `failed to update target ConfigMap ${namespace}/${name}: HTTP ${updated.statusCode} ${updated.text}`
    };
  }

  return {
    status: serverDryRun ? 'server-dry-run' : 'applied',
    applied: !serverDryRun,
    resourceVersion: metadataString(updated.body, 'resourceVersion'),
    message: serverDryRun
      ? `Kubernetes server dry-run accepted ConfigMap ${namespace}/${name}`
      : `Kubernetes ConfigMap ${namespace}/${name} updated`
  };
}

export async function kubernetesRequest(
  method: string,
  path: string,
  body?: unknown,
  contentType = 'application/json'
): Promise<KubernetesResponse> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? '443');
  if (!host) {
    return { statusCode: 0, body: null, text: 'not running inside a Kubernetes cluster' };
  }
  const [token, ca] = await Promise.all([
    readFile(tokenPath, 'utf8'),
    readFile(caPath)
  ]);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host,
      port,
      method,
      path,
      ca,
      timeout: 8000,
      headers: {
        authorization: `Bearer ${token.trim()}`,
        ...(payload ? {
          'content-type': contentType,
          'content-length': String(payload.byteLength)
        } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        if (text.trim()) {
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            parsed = null;
          }
        }
        resolve({ statusCode: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Kubernetes API request timed out'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function toKubernetesConfigMapObject(
  manifest: ConfigMapManifest,
  resourceVersion: string | null
): KubernetesConfigMapObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: manifest.metadata.name,
      namespace: manifest.metadata.namespace,
      labels: manifest.metadata.labels,
      annotations: manifest.metadata.annotations,
      ...(resourceVersion ? { resourceVersion } : {})
    },
    data: manifest.data
  };
}

async function triggerInternalGatewayRollout(
  namespace: string,
  configMapResourceVersion: string | null
): Promise<Pick<KubernetesApplyOutcome, 'status' | 'message'>> {
  const daemonSetName = 'mx-internal-gateway';
  const resourcePath = `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets/${encodeURIComponent(daemonSetName)}`;
  const reloadAt = new Date().toISOString();
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'mx.qpjoy.com/gateway-configmap-resource-version': configMapResourceVersion ?? 'unknown',
            'mx.qpjoy.com/gateway-configmap-reload-at': reloadAt
          }
        }
      }
    }
  };
  const updated = await kubernetesRequest('PATCH', resourcePath, patch, 'application/merge-patch+json');
  if (updated.statusCode < 200 || updated.statusCode >= 300) {
    return {
      status: 'failed',
      message: `failed to trigger Internal gateway rollout ${namespace}/${daemonSetName}: HTTP ${updated.statusCode} ${updated.text}`
    };
  }
  return {
    status: 'applied',
    message: `Internal gateway rollout triggered for ${namespace}/${daemonSetName}`
  };
}

function metadataString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw ? raw : null;
}
