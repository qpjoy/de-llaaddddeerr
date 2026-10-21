import * as fileSystem from "node:fs";
import { posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const marker = "/etc/mx-k8s-runtime/active.json";
const resolver = "/usr/local/lib/mx-k8s-runtime/resolve.py";
const fail = (message) => { throw Error(`DataPort Kubernetes runtime: ${message}`); };
const localPath = (value) => typeof value === "string" && /^\/[A-Za-z0-9_./-]+$/.test(value) &&
  value !== "/" && posix.normalize(value) === value;
const succeeded = (result) => result && !result.error && result.status === 0;
const bounded = (run, command, args) => run(command, args, { optional: true, timeout: 15000 });
const criArgs = (address) => [
  `--runtime-endpoint=unix://${address}`, `--image-endpoint=unix://${address}`, "--timeout=10s",
];

function readConfig(fs, path, required = false) {
  try { return fs.readFileSync(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT" && !required) return "";
    fail("cannot read kubelet configuration; no runtime selected");
  }
}

function scalar(text, key) {
  const entries = [...text.matchAll(new RegExp(`^${key}:[ \\t]*(.*)$`, "gm"))];
  if (!entries.length) return undefined;
  if (entries.length !== 1) fail("ambiguous kubelet endpoint configuration");
  const value = entries[0][1].match(/^(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#'"\r\n]*?))[ \t]*(?:#.*)?$/);
  if (!value) fail("invalid kubelet endpoint configuration");
  return (value[1] ?? value[2] ?? value[3]).trim();
}

function socketPath(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///"))
    fail("a local unix kubelet endpoint is required");
  const address = endpoint.slice("unix://".length);
  if (!localPath(address)) fail("invalid kubelet socket path");
  return address;
}

function kubeletAddress(run, fs) {
  const service = bounded(run, "systemctl", ["show", "kubelet", "--property=MainPID", "--value"]);
  const pid = succeeded(service) ? service.stdout?.trim() : "";
  if (!/^[1-9][0-9]*$/.test(pid || "")) fail("cannot identify the running kubelet");
  const args = readConfig(fs, `/proc/${pid}/cmdline`, true).split("\0");
  if (posix.basename(args[0]) !== "kubelet") fail("kubelet process identity differs");
  const flags = new Map();
  const names = ["--config", "--container-runtime-endpoint", "--image-service-endpoint"];
  for (let i = 1; i < args.length; i++) {
    const name = names.find(key => args[i] === key || args[i].startsWith(`${key}=`));
    if (!name) continue;
    const value = args[i] === name ? args[++i] : args[i].slice(name.length + 1);
    if (!value || value.startsWith("--")) fail("invalid kubelet process arguments");
    flags.set(name, value);
  }
  const config = flags.get("--config") || "/var/lib/kubelet/config.yaml";
  if (!localPath(config)) fail("invalid kubelet configuration path");
  const text = readConfig(fs, config, flags.has("--config"));
  let endpoint = flags.get("--container-runtime-endpoint") ?? scalar(text, "containerRuntimeEndpoint");
  const imageEndpoint = flags.get("--image-service-endpoint") ?? scalar(text, "imageServiceEndpoint");
  // Kubeadm's instance record must not override live flags or the effective config.
  if (endpoint === undefined)
    endpoint = scalar(readConfig(fs, "/var/lib/kubelet/instance-config.yaml"), "containerRuntimeEndpoint");
  const address = socketPath(endpoint);
  if (imageEndpoint && socketPath(imageEndpoint) !== address)
    fail("separate kubelet image service endpoint is unsupported; no runtime selected");
  return address;
}

export function resolveContainerdAddress({ run, env = process.env, fs = fileSystem }) {
  let managed;
  try { fs.lstatSync(marker); managed = true; }
  catch (error) {
    if (error.code !== "ENOENT") fail("cannot inspect managed runtime marker; refusing default runtime");
    managed = false;
  }
  let address;
  if (managed) {
    // lstat also detects dangling markers: a broken managed installation must
    // never silently redirect images back into Docker's shared runtime.
    const result = bounded(run, "python3", [resolver, "address"]);
    if (!succeeded(result)) fail("managed runtime verification failed; refusing default runtime");
    address = result.stdout?.trim();
    if (!localPath(address)) fail("managed runtime returned an invalid address; refusing default runtime");
  } else address = kubeletAddress(run, fs);
  if (env.MX_K8S_CONTAINERD_ADDRESS && env.MX_K8S_CONTAINERD_ADDRESS !== address)
    fail("MX_K8S_CONTAINERD_ADDRESS differs from the verified kubelet runtime");
  try {
    if (!fs.statSync(address).isSocket()) throw Error();
  } catch { fail("verified kubelet runtime socket is unavailable"); }
  if (!succeeded(bounded(run, "ctr", ["--address", address, "-n", "k8s.io", "version"])))
    fail("verified kubelet runtime is not a reachable containerd service");
  // crictl version has fixed text output (no JSON output flag).
  const version = bounded(run, "crictl", [...criArgs(address), "version"]);
  if (!succeeded(version) || !/^RuntimeName:[ \t]+containerd[ \t]*$/m.test(version.stdout || "") ||
      !/^RuntimeApiVersion:[ \t]+v1[ \t]*$/m.test(version.stdout || ""))
    fail("cannot verify containerd CRI v1; check crictl and the kubelet endpoint");
  return address;
}

export async function verifyCriImage({ run, address, image, expected, pause = sleep }) {
  if (!localPath(address) || !/^sha256:[a-f0-9]{64}$/.test(expected || "") ||
      typeof image !== "string" || !image || /\s/.test(image))
    fail("invalid image verification inputs");
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = bounded(run, "crictl", [...criArgs(address), "inspecti", image]);
    if (succeeded(result)) {
      try { if (JSON.parse(result.stdout)?.status?.id === expected) return expected; }
      catch { /* Incomplete/invalid CRI responses cannot confirm an image. */ }
    }
    if (attempt < 5) await pause(2000);
  }
  fail("CRI cannot see the expected imported image; application not updated. Check runtime endpoint, image GC and disk pressure");
}
