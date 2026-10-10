export function workload({
  namespace = "mx-harbor",
  node,
  image,
  secret = "mx-harbor-runtime",
  job,
}) {
  const labels = { app: "mx-harbor" },
    securityContext = {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    };
  const container = {
    name: job ? "migrate" : "web",
    image,
    imagePullPolicy: "Never",
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "512Mi" },
    },
    env: job
      ? [
          {
            name: "MX_HARBOR_DATABASE_URL",
            valueFrom: {
              secretKeyRef: { name: secret, key: "MX_HARBOR_DATABASE_URL" },
            },
          },
        ]
      : [
          "MX_HARBOR_DATABASE_URL",
          "MX_HARBOR_GATEWAY_TOKEN",
          "MX_HARBOR_HUB_ADMIN_ORIGIN",
          "MX_HARBOR_SSO_PROFILE",
          "MX_HARBOR_PORT",
        ].map((name) => ({
          name,
          valueFrom: { secretKeyRef: { name: secret, key: name } },
        })),
    volumeMounts: job
      ? undefined
      : [{ name: "identity", mountPath: "/run/harbor", readOnly: true }],
    ...(job
      ? { command: ["node", "scripts/migrate.mjs"] }
      : {
          ports: [
            {
              name: "http",
              containerPort: 18220,
              hostPort: 18220,
              hostIP: "127.0.0.1",
            },
          ],
          readinessProbe: {
            httpGet: { path: "/ready", port: "http" },
            initialDelaySeconds: 2,
            periodSeconds: 5,
          },
          livenessProbe: {
            httpGet: { path: "/health", port: "http" },
            initialDelaySeconds: 10,
            periodSeconds: 15,
          },
        }),
  };
  const spec = {
    enableServiceLinks: false,
    automountServiceAccountToken: false,
    securityContext,
    nodeSelector: { "kubernetes.io/hostname": node },
    tolerations: [
      {
        key: "node-role.kubernetes.io/control-plane",
        operator: "Exists",
        effect: "NoSchedule",
      },
      {
        key: "node-role.kubernetes.io/master",
        operator: "Exists",
        effect: "NoSchedule",
      },
    ],
    containers: [container],
    restartPolicy: job ? "Never" : "Always",
    volumes: job
      ? undefined
      : [
          {
            name: "identity",
            secret: {
              secretName: secret,
              defaultMode: 288,
              items: [{ key: "profile.json", path: "profile.json" }],
            },
          },
        ],
  };
  return job
    ? {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { namespace, name: job, labels },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 300,
          ttlSecondsAfterFinished: 86400,
          template: { metadata: { labels }, spec },
        },
      }
    : {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { namespace, name: "mx-harbor", labels },
        spec: {
          replicas: 1,
          strategy: { type: "Recreate" },
          selector: { matchLabels: labels },
          template: { metadata: { labels }, spec },
        },
      };
}
