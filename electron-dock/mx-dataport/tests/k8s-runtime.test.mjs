import test from "node:test";
import assert from "node:assert/strict";
import { resolveContainerdAddress, verifyCriImage } from "../scripts/k8s-runtime.mjs";

const marker = "/etc/mx-k8s-runtime/active.json";
const managedSocket = "/run/mx-k8s/containerd.sock";
const expected = `sha256:${"a".repeat(64)}`;
const receipt = (stdout = "") => ({ status: 0, stdout });
const missing = () => { throw Object.assign(Error("private-sensitive-payload"), { code: "ENOENT" }); };
function fixture({ managed = true, args = ["/usr/bin/kubelet"], config, instance, override = {}, result } = {}) {
  const calls = [], files = new Map([["/proc/123/cmdline", args.join("\0")]]);
  if (config !== undefined) files.set(args.includes("--config") ? args[args.indexOf("--config") + 1] : "/var/lib/kubelet/config.yaml", config);
  if (instance !== undefined) files.set("/var/lib/kubelet/instance-config.yaml", instance);
  const fs = {
    lstatSync(path) { assert.equal(path, marker); if (!managed) return missing(); return { isSymbolicLink: () => managed === "dangling" }; },
    readFileSync(path) { return files.has(path) ? files.get(path) : missing(); },
    statSync(path) { return { isSocket: () => path.endsWith(".sock") }; },
    ...override,
  };
  const run = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    assert.equal(options.optional, true);
    assert.equal(options.timeout, 15000);
    const supplied = result?.(cmd, args);
    if (supplied) return supplied;
    if (cmd === "python3") return receipt(`${managedSocket}\n`);
    if (cmd === "systemctl") return receipt("123\n");
    if (cmd === "crictl") return receipt("Version:  0.1.0\nRuntimeName:  containerd\nRuntimeVersion:  2.0.0\nRuntimeApiVersion:  v1\n");
    return receipt();
  };
  return { fs, run, calls, files, env: {} };
}

test("managed runtime uses only verified explicit containerd and CRI endpoints", () => {
  const f = fixture();
  assert.equal(resolveContainerdAddress(f), managedSocket);
  assert.deepEqual(f.calls.map(c => [c.cmd, ...c.args]), [
    ["python3", "/usr/local/lib/mx-k8s-runtime/resolve.py", "address"],
    ["ctr", "--address", managedSocket, "-n", "k8s.io", "version"],
    ["crictl", `--runtime-endpoint=unix://${managedSocket}`, `--image-endpoint=unix://${managedSocket}`, "--timeout=10s", "version"],
  ]);
});

test("missing/broken resolver and dangling marker never select the legacy runtime or disclose output", () => {
  for (const managed of [true, "dangling"]) {
    for (const failed of [
      { status: 1, stderr: "private-sensitive-payload" },
      { status: null, error: { code: "ENOENT" }, stderr: "private-sensitive-payload" },
      receipt("/run/example.sock\nprivate-sensitive-payload"),
    ]) {
      const f = fixture({ managed, result: cmd => cmd === "python3" ? failed : null });
      assert.throws(() => resolveContainerdAddress(f), error => {
        assert.match(error.message, /managed runtime/);
        assert.doesNotMatch(error.message, /private-sensitive-payload/);
        return true;
      });
      assert.deepEqual(f.calls.map(c => c.cmd), ["python3"]);
    }
  }
});

test("inaccessible marker and conflicting override stop before contacting either runtime", () => {
  const inaccessible = fixture({ override: { lstatSync() { throw Object.assign(Error(), { code: "EACCES" }); } } });
  assert.throws(() => resolveContainerdAddress(inaccessible), /cannot inspect managed runtime/);
  assert.equal(inaccessible.calls.length, 0);
  const conflict = fixture();
  conflict.env.MX_K8S_CONTAINERD_ADDRESS = "/run/containerd/containerd.sock";
  assert.throws(() => resolveContainerdAddress(conflict), /differs from the verified kubelet runtime/);
  assert.deepEqual(conflict.calls.map(c => c.cmd), ["python3"]);
});

test("legacy discovery uses live CLI endpoint, effective config, then absent-only instance fallback", () => {
  const cases = [
    { args: ["/usr/bin/kubelet", "--container-runtime-endpoint=unix:///run/cli.sock"], config: "containerRuntimeEndpoint: unix:///run/config.sock\n", socket: "/run/cli.sock" },
    { args: ["/usr/bin/kubelet", "--config", "/custom/kubelet.yaml", "--container-runtime-endpoint", "unix:///run/cli.sock"], config: "containerRuntimeEndpoint: unix:///run/config.sock\n", socket: "/run/cli.sock" },
    { args: ["/usr/bin/kubelet", "--config", "/custom/kubelet.yaml"], config: "containerRuntimeEndpoint: 'unix:///run/config.sock' # configured\n", socket: "/run/config.sock" },
    { config: "kind: KubeletConfiguration\n", socket: "/run/instance.sock" },
  ];
  for (const value of cases) {
    const f = fixture({ managed: false, instance: "containerRuntimeEndpoint: unix:///run/instance.sock\n", ...value });
    assert.equal(resolveContainerdAddress(f), value.socket);
    assert.ok(!f.calls.some(c => c.cmd === "python3"));
    assert.ok(f.calls.find(c => c.cmd === "ctr").args.includes(value.socket));
  }
});

test("unverified legacy process, invalid/ambiguous config and a separate image endpoint fail closed", () => {
  for (const value of [
    { result: cmd => cmd === "systemctl" ? receipt("0\n") : null },
    { args: ["/usr/bin/other-process"] },
    { config: "containerRuntimeEndpoint: ''\n" },
    { config: "containerRuntimeEndpoint: unix:///run/one.sock\ncontainerRuntimeEndpoint: unix:///run/two.sock\n" },
    { config: "containerRuntimeEndpoint: tcp://127.0.0.1:9000\n" },
    { config: "containerRuntimeEndpoint: unix:///run/one.sock\nimageServiceEndpoint: unix:///run/two.sock\n" },
    { args: ["/usr/bin/kubelet", "--container-runtime-endpoint=unix:///run/one.sock", "--image-service-endpoint=unix:///run/two.sock"] },
  ]) {
    const f = fixture({ managed: false, instance: "containerRuntimeEndpoint: unix:///run/instance.sock\n", ...value });
    assert.throws(() => resolveContainerdAddress(f), /DataPort Kubernetes runtime/);
    assert.ok(!f.calls.some(c => ["ctr", "crictl"].includes(c.cmd)));
  }
});

test("preflight rejects a missing socket, unreachable containerd, missing crictl and wrong CRI service", () => {
  for (const value of [
    { override: { statSync: missing } },
    { result: cmd => cmd === "ctr" ? { status: 1, stderr: "private-sensitive-payload" } : null },
    { result: cmd => cmd === "crictl" ? { status: null, error: { code: "ENOENT" } } : null },
    { result: cmd => cmd === "crictl" ? receipt("RuntimeName: cri-o\nRuntimeApiVersion: v1\nprivate-sensitive-payload") : null },
  ]) {
    const f = fixture(value);
    assert.throws(() => resolveContainerdAddress(f), error => {
      assert.match(error.message, /DataPort Kubernetes runtime/);
      assert.doesNotMatch(error.message, /private-sensitive-payload/);
      return true;
    });
  }
});

test("CRI verification accepts only the exact imported Docker image ID, after bounded visibility retries", async () => {
  const calls = [], waits = [], ids = ["", `sha256:${"b".repeat(64)}`, expected];
  const result = await verifyCriImage({ address: managedSocket, image: "mx-harbor:build-test", expected,
    run(cmd, args, options) {
      calls.push({ cmd, args, options });
      return receipt(JSON.stringify({ status: { id: ids.shift() } }));
    }, pause: async ms => waits.push(ms),
  });
  assert.equal(result, expected);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [2000, 2000]);
  assert.ok(calls.every(c => c.cmd === "crictl" && c.options.timeout === 15000 && c.args.includes(`--image-endpoint=unix://${managedSocket}`) && c.args.includes("inspecti")));
});

test("CRI missing/mismatched/malformed responses exhaust bounded retries without accepting ctr metadata", async () => {
  for (const result of [
    { status: 1, stderr: "private-sensitive-payload" },
    receipt("private-sensitive-payload"),
    receipt(JSON.stringify({ status: { id: `sha256:${"b".repeat(64)}` } })),
  ]) {
    let calls = 0, waits = 0;
    await assert.rejects(verifyCriImage({ address: managedSocket, image: "mx-harbor:build-test", expected,
      run() { calls++; return result; }, pause: async () => { waits++; },
    }), error => {
      assert.match(error.message, /CRI cannot see the expected imported image/);
      assert.doesNotMatch(error.message, /private-sensitive-payload/);
      return true;
    });
    assert.equal(calls, 6);
    assert.equal(waits, 5);
  }
});
