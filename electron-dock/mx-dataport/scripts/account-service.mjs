import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { operationSettings } from "./bootstrap.mjs";

const name = "mx-dataport-accounts";
const authNamespace = "mx-internal-shadow",
  hubNamespace = "mx-insight-hub";
const authOrigin =
  "http://mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090";
const help =
  "Usage: bash scripts/manage.sh ops internal-production accounts status|configure [--initialize]\nstatus is read-only and never prints credentials. configure preserves existing secrets and only creates missing resources. --initialize is only for a verified first installation with no account records or existing credential files; otherwise restore the original Auth Secret. This command does not deploy/restart services or create users.";
const decode = (secret, key) => {
  const encoded = secret?.data?.[key];
  if (
    typeof encoded !== "string" ||
    Buffer.from(encoded, "base64").toString("base64") !== encoded
  )
    throw Error(
      `Retained ${key} is missing or invalid; restore the original Secret, no rotation performed`,
    );
  return Buffer.from(encoded, "base64").toString("utf8");
};

export function accountSecretPlan({
  auth,
  hub,
  initialize = false,
  emptyStoreVerified = false,
}) {
  if (hub?.data && Object.hasOwn(hub.data, "credential-key"))
    throw Error(
      "Hub must not receive the password encryption key; restore its token-only Secret",
    );
  let token, tokenFile, key;
  if (auth) {
    tokenFile = decode(auth, "account-token");
    token = tokenFile.trim();
    key = decode(auth, "credential-key").trim();
    if (token.length < 32 || !/^[a-f0-9]{64}$/i.test(key))
      throw Error(
        "Retained Auth credentials are invalid; restore them, never regenerate in place",
      );
  } else {
    if (hub)
      throw Error(
        "Auth Secret missing while Hub retains credentials; restore Auth, do not initialize a new key",
      );
    if (!initialize || !emptyStoreVerified)
      throw Error(
        "No retained Auth Secret. First install requires --initialize and a verified empty Auth account store; otherwise restore the original Secret",
      );
    token = randomBytes(32).toString("base64url");
    tokenFile = token;
    key = randomBytes(32).toString("hex");
  }
  if (
    hub &&
    (decode(hub, "account-token").trim() !== token ||
      decode(hub, "account-origin").trim() !== authOrigin)
  )
    throw Error(
      "Hub/Auth account bridge differs; no existing credentials or origin will be overwritten",
    );
  const secret = (namespace, data) => ({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name, namespace },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [
        k,
        Buffer.from(v).toString("base64"),
      ]),
    ),
  });
  return [
    ...(!auth
      ? [
          secret(authNamespace, {
            "account-token": token,
            "credential-key": key,
          }),
        ]
      : []),
    ...(!hub
      ? [
          secret(hubNamespace, {
            "account-token": tokenFile,
            "account-origin": authOrigin,
          }),
        ]
      : []),
  ];
}

// Check effective process configuration as well as explicit Deployment env:
// envFrom may otherwise hide an existing custom credential source.
const runtimeProbe = `
const role=process.argv[2],token=process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE,key=process.env.MX_DATAPORT_CREDENTIAL_KEY_FILE,origin=process.env.MX_DATAPORT_ACCOUNT_ORIGIN;
console.log(JSON.stringify({standard:(!token||token==='/run/mx-dataport-accounts/account-token')&&(role==='auth'?(!key||key==='/run/mx-dataport-accounts/credential-key'):(!origin||origin===${JSON.stringify(authOrigin)}))}));
`;
// Only counts and booleans leave the Pod. No user rows, encrypted values or
// credentials are returned. Refuse key initialization if any prior account
// command exists, including invitations, or any credential file already exists.
const emptyStoreProbe = `
import { existsSync } from 'node:fs';
import pg from 'pg';
if (process.env.INTERNAL_STORE_DRIVER !== 'postgres' || !process.env.DATABASE_URL) throw Error('Auth PostgreSQL is not configured');
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:10000});
const db = await pool.connect();
try {
  await db.query('BEGIN READ ONLY');
  const {rows}=await db.query("SELECT count(*)::int AS count FROM mx_platform_records WHERE kind IN ('dataport-managed-password','dataport-account-command')");
  console.log(JSON.stringify({records:rows[0].count,credentialFilesPresent:[process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE,process.env.MX_DATAPORT_CREDENTIAL_KEY_FILE,'/run/mx-dataport-accounts/account-token','/run/mx-dataport-accounts/credential-key'].filter(Boolean).some(p=>existsSync(p))}));
} finally { await db.query('ROLLBACK').catch(()=>{}); db.release(); await pool.end(); }
`;

export function main(args = process.argv.slice(2)) {
  const action = args[0] || "status",
    initialize = args.includes("--initialize");
  if (
    !["status", "configure"].includes(action) ||
    args.slice(1).some((v) => v !== "--initialize") ||
    (action === "status" && initialize)
  )
    throw Error(help);
  const run = (cmd, args, { input } = {}) => {
    const result = spawnSync(cmd, args, {
      input,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
    // Do not include kubectl output: an error may echo a Secret manifest.
    if (result.status !== 0)
      throw Error(
        `${cmd} failed; inspect access/connectivity locally (output withheld)`,
      );
    return result;
  };
  const { settings } = operationSettings({ run, action: "status" });
  if (
    settings.hubAdminOrigin !==
    "http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151"
  )
    throw Error(
      "This account setup supports only the pinned canonical Internal Hub target; custom upstream is unchanged",
    );
  const kube = (namespace, args, input) =>
    run("kubectl", ["--context", settings.context, "-n", namespace, ...args], {
      input,
    });
  const parse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      throw Error("Kubernetes/probe response is invalid (contents withheld)");
    }
  };
  const read = (namespace, kind, resource) => {
    const raw = kube(namespace, [
      "get",
      kind,
      resource,
      "--ignore-not-found",
      "-o",
      "json",
    ]).stdout.trim();
    return raw ? parse(raw) : null;
  };
  const cluster = read(authNamespace, "namespace", "kube-system");
  if (cluster?.metadata?.uid !== settings.clusterUid)
    throw Error("Cluster identity differs; no mutation performed");
  let auth = read(authNamespace, "secret", name),
    hub = read(hubNamespace, "secret", name);
  if (action === "status") {
    if (auth) accountSecretPlan({ auth, hub });
    console.log(
      JSON.stringify(
        {
          authSecret: !!auth,
          hubSecret: !!hub,
          credentialsMatch: !!auth && !!hub,
          origin: authOrigin,
          note: "Secret presence does not prove active Pod mounts or account readiness; no credentials displayed",
        },
        null,
        2,
      ),
    );
    return;
  }
  const node = read(authNamespace, "node", settings.node);
  if (
    node?.metadata?.labels?.["kubernetes.io/hostname"] !== hostname() ||
    node.spec?.unschedulable ||
    !node.status?.conditions?.some(
      (c) => c.type === "Ready" && c.status === "True",
    )
  )
    throw Error("Run configuration on the pinned ready Internal node");
  // Do not move a manually configured bridge to new secrets or a new origin.
  for (const [namespace, deployment, containerName] of [
    [authNamespace, "mx-launcher-internal", "internal-api"],
    [hubNamespace, "mx-insight-hub-admin", "admin"],
  ]) {
    const deploymentObject = read(namespace, "deployment", deployment);
    const container = deploymentObject?.spec?.template?.spec?.containers?.find(
      (c) => c.name === containerName,
    );
    if (!container)
      throw Error(
        `Expected deployment/container absent: ${deployment}/${containerName}`,
      );
    for (const env of container.env || []) {
      if (
        (env.name === "MX_DATAPORT_ACCOUNT_TOKEN_FILE" &&
          env.value !== "/run/mx-dataport-accounts/account-token") ||
        (env.name === "MX_DATAPORT_CREDENTIAL_KEY_FILE" &&
          env.value !== "/run/mx-dataport-accounts/credential-key") ||
        (env.name === "MX_DATAPORT_ACCOUNT_ORIGIN" &&
          (env.valueFrom?.secretKeyRef?.name !== name ||
            env.valueFrom?.secretKeyRef?.key !== "account-origin"))
      )
        throw Error(
          "Existing account configuration uses another source; preserve/import the original credentials before configuration",
        );
    }
    const mount = container.volumeMounts?.find(
      (m) => m.mountPath === "/run/mx-dataport-accounts",
    );
    if (
      mount &&
      (mount.name !== "dataport-accounts" ||
        deploymentObject.spec.template.spec.volumes?.find(
          (v) => v.name === mount.name,
        )?.secret?.secretName !== name)
    )
      throw Error(
        "Existing account mount uses another credential source; restore/import it instead of overwriting",
      );
    const runtime = parse(
      kube(
        namespace,
        [
          "exec",
          `deployment/${deployment}`,
          "-c",
          containerName,
          "-i",
          "--",
          "node",
          "--input-type=module",
          "-",
          namespace === authNamespace ? "auth" : "hub",
        ],
        runtimeProbe,
      ).stdout.trim(),
    );
    if (runtime.standard !== true)
      throw Error(
        "Running service uses another account credential source (including envFrom); preserve/import it before configuration",
      );
  }
  const lockName = "mx-dataport-accounts-config-lock";
  const lock = parse(
    kube(authNamespace, [
      "create",
      "configmap",
      lockName,
      "--from-literal=purpose=configure-dataport-accounts",
      `--from-literal=ownerHost=${hostname()}`,
      `--from-literal=ownerPid=${process.pid}`,
      "-o",
      "json",
    ]).stdout,
  );
  if (typeof lock.metadata?.uid !== "string" || !lock.metadata.uid)
    throw Error(
      "Configuration lock ownership could not be verified; no credential writes performed",
    );
  try {
    // Reread while holding the lock; a partial previous run must reuse Auth's key.
    auth = read(authNamespace, "secret", name);
    hub = read(hubNamespace, "secret", name);
    let emptyStoreVerified = false;
    if (!auth && !hub && initialize) {
      const result = parse(
        kube(
          authNamespace,
          [
            "exec",
            "deployment/mx-launcher-internal",
            "-c",
            "internal-api",
            "-i",
            "--",
            "node",
            "--input-type=module",
            "-",
          ],
          emptyStoreProbe,
        ).stdout.trim(),
      );
      emptyStoreVerified =
        result.records === 0 && result.credentialFilesPresent === false;
      if (!emptyStoreVerified)
        throw Error(
          "Prior DataPort account state/files exist; restore original credentials, no new encryption key generated",
        );
    }
    for (const object of accountSecretPlan({
      auth,
      hub,
      initialize,
      emptyStoreVerified,
    })) {
      // Atomic create only, never apply/replace a retained Secret. Auth first;
      // interrupted Hub creation is recovered by reading the same Auth Secret.
      kube(
        object.metadata.namespace,
        ["create", "-f", "-"],
        JSON.stringify(object),
      );
    }
    console.log(
      "DataPort account secrets configured/preserved. Deploy Auth, Hub Admin and DataPort to load the fixed optional mounts. No users created, no credentials printed.",
    );
  } finally {
    // UID-preconditioned release, without persisting a kubeconfig or Secret.
    kube(
      authNamespace,
      [
        "delete",
        "--raw",
        `/api/v1/namespaces/${authNamespace}/configmaps/${lockName}`,
        "-f",
        "-",
      ],
      JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: lock.metadata.uid },
      }),
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`DataPort accounts: ${error.message}`);
    process.exitCode = 1;
  }
}
