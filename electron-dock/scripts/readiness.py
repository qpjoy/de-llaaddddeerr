#!/usr/bin/env python3
"""Bounded, read-only dependency checks for MX deployment and boot (Python 3.6+)."""
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit


class ReadinessError(Exception):
    """A dependency could not be verified; messages never include command output."""


class _Pending(Exception):
    pass


_PG_ISREADY_CANDIDATES = (
    "/usr/pgsql-16/bin/pg_isready",
    "/usr/lib/postgresql/16/bin/pg_isready",
    "/usr/local/pgsql/bin/pg_isready",
)
_KUBE_NAME = re.compile(r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$")
_HANLP_HEALTH = """import json, urllib.request, urllib.error
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:8000/health', timeout=5) as response:
        body = json.loads(response.read(65537).decode('utf-8'))
        print(json.dumps({'httpStatus': response.status, 'body': body}))
except Exception:
    print(json.dumps({'httpStatus': 0}))
"""


def _number(value, label):
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ReadinessError("{} must be a positive number".format(label))
    if not math.isfinite(result) or result <= 0:
        raise ReadinessError("{} must be a positive number".format(label))
    return result


def _program(name, env, candidates=()):
    found = shutil.which(name, path=env.get("PATH", os.defpath))
    if found:
        return found
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise ReadinessError("{} is required for readiness verification".format(name))


def _run(args, env, deadline, stdin=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _Pending("probe timeout")
    try:
        return subprocess.run(args, input=stdin, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True,
                              timeout=min(10.0, remaining), env=dict(env))
    except subprocess.TimeoutExpired:
        raise _Pending("probe timeout")
    except OSError:
        raise ReadinessError("readiness probe command is unavailable")


def _wait(service, env, timeout, probe):
    duration = _number(env.get("MX_WAIT_TIMEOUT", "300") if timeout is None else timeout,
                       "MX_WAIT_TIMEOUT")
    interval = _number(env.get("MX_WAIT_INTERVAL", "5"), "MX_WAIT_INTERVAL")
    start = time.monotonic()
    deadline = start + duration
    next_log = start + 15
    reason = "not ready"
    while time.monotonic() < deadline:
        try:
            summary = probe(deadline)
            summary["elapsedSeconds"] = round(time.monotonic() - start, 3)
            return summary
        except _Pending as error:
            reason = str(error)
        now = time.monotonic()
        if now >= deadline:
            break
        if now >= next_log:
            print("[readiness] waiting for {}: {}".format(service, reason), file=sys.stderr)
            next_log = now + 15
        time.sleep(min(interval, deadline - now))
    raise ReadinessError("{} readiness timed out: {}".format(service, reason))


def wait_host_postgres(env, timeout=None):
    """Verify the existing host PostgreSQL protocol listener; never start it."""
    executable = _program("pg_isready", env, _PG_ISREADY_CANDIDATES)
    probe_env = dict(env)
    for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
        probe_env.pop(key, None)

    def probe(deadline):
        result = _run([executable, "-h", "127.0.0.1", "-p", "5432", "-t", "5"], probe_env, deadline)
        if result.returncode != 0:
            raise _Pending("PostgreSQL is not accepting connections")
        return {"service": "host-postgres", "status": "ready", "host": "127.0.0.1", "port": 5432}

    return _wait("host-postgres", env, timeout, probe)


def wait_hanlp(env, timeout=None):
    """Verify an existing ready Service endpoint and its loaded HanLP model."""
    executable = _program("kubectl", env)
    context = env.get("CONTEXT") or env.get("KUBE_CONTEXT")
    if env.get("CONTEXT") and env.get("KUBE_CONTEXT") and env["CONTEXT"] != env["KUBE_CONTEXT"]:
        raise ReadinessError("CONTEXT and KUBE_CONTEXT disagree")
    base = [executable]
    if context:
        base += ["--context", context]
    base += ["--request-timeout=10s", "-n", "mx-common"]

    def read_json(args, deadline, missing=None):
        result = _run(base + args, env, deadline)
        if result.returncode != 0:
            raise _Pending("Kubernetes observation unavailable")
        if missing and not result.stdout.strip():
            raise ReadinessError(missing)
        try:
            value = json.loads(result.stdout)
        except (ValueError, TypeError):
            raise _Pending("invalid Kubernetes observation")
        if not isinstance(value, dict):
            raise _Pending("invalid Kubernetes observation")
        return value

    def probe(deadline):
        deployment = read_json(["get", "deployment", "mx-common-hanlp", "--ignore-not-found", "-o", "json"],
                               deadline, "HanLP deployment is missing; deploy HanLP explicitly first")
        spec, status, metadata = deployment.get("spec", {}), deployment.get("status", {}), deployment.get("metadata", {})
        if not all(isinstance(value, dict) for value in (spec, status, metadata)):
            raise _Pending("invalid HanLP deployment observation")
        replicas = spec.get("replicas", 1)
        if replicas == 0:
            raise ReadinessError("HanLP deployment is disabled (replicas=0)")
        ready_replicas, observed, generation = status.get("readyReplicas", 0), status.get("observedGeneration", 0), metadata.get("generation", 1)
        if (not all(isinstance(value, int) for value in (replicas, ready_replicas, observed, generation))
                or replicas < 1 or ready_replicas < replicas or observed < generation):
            raise _Pending("HanLP deployment is not ready")
        endpoints = read_json(["get", "endpoints", "mx-common-hanlp", "--ignore-not-found", "-o", "json"], deadline)
        pods = set()
        subsets = endpoints.get("subsets", [])
        if not isinstance(subsets, list):
            raise _Pending("invalid HanLP endpoint observation")
        for subset in subsets:
            if not isinstance(subset, dict) or not isinstance(subset.get("addresses", []), list):
                continue
            for address in subset.get("addresses", []):
                if not isinstance(address, dict):
                    continue
                ref = address.get("targetRef", {})
                if not isinstance(ref, dict):
                    continue
                name = ref.get("name", "")
                if (ref.get("kind") == "Pod" and ref.get("namespace", "mx-common") == "mx-common"
                        and isinstance(name, str) and _KUBE_NAME.match(name)):
                    pods.add(name)
        if not pods:
            raise _Pending("HanLP has no ready Pod endpoint")
        for pod in sorted(pods):
            result = _run(base + ["exec", "pod/" + pod, "-c", "hanlp", "--", "python3", "-c", _HANLP_HEALTH], env, deadline)
            if result.returncode != 0:
                continue
            try:
                health = json.loads(result.stdout)
                body = health.get("body", {})
                ready = (health.get("httpStatus") == 200 and isinstance(body, dict)
                         and body.get("status") == "ready" and isinstance(body.get("model"), str)
                         and bool(body["model"].strip()))
            except (ValueError, TypeError, AttributeError):
                ready = False
            if ready:
                return {"service": "hanlp", "status": "ready", "namespace": "mx-common",
                        "pod": pod, "modelLoaded": True}
        raise _Pending("HanLP model health is not ready")

    return _wait("hanlp", env, timeout, probe)


def _proxy_url(value):
    try:
        if any(char.isspace() or ord(char) < 32 for char in value):
            raise ValueError()
        value = value if "://" in value else "http://" + value
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname or not parsed.port
                or not 1 <= parsed.port <= 65535 or parsed.hostname in ("0.0.0.0", "::")
                or any(char in parsed.hostname for char in "*\\/?#")
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError()
        return value.rstrip("/")
    except (ValueError, TypeError):
        raise ReadinessError("PROXY must be a valid HTTP(S) proxy host and port")


def wait_proxy(env, timeout=None):
    """Check HTTPS registry reachability through an explicitly configured proxy."""
    if not env.get("PROXY"):
        return {"service": "build-proxy", "status": "skipped", "reason": "no explicit PROXY"}
    proxy = _proxy_url(env["PROXY"])
    executable = _program("curl", env)
    probe_env = {key: value for key, value in env.items()
                 if key.lower() != "proxy" and not key.lower().endswith("_proxy")}
    # -q disables user curlrc; the proxy (including any credential) is stdin-only.
    # Empty noproxy overrides inherited NO_PROXY so this cannot test a direct route.
    quoted_proxy = proxy.replace("\\", "\\\\").replace('"', '\\"')
    config = ('url = "https://registry-1.docker.io/v2/"\n'
              'proxy = "{}"\n'.format(quoted_proxy)
              + 'noproxy = ""\nsilent\noutput = "/dev/null"\nwrite-out = "%{http_code}"\n'
              + 'connect-timeout = "5"\nmax-time = "9"\nproto = "=https"\n')

    def probe(deadline):
        result = _run([executable, "-q", "--config", "-"], probe_env, deadline, stdin=config)
        status = result.stdout.strip()
        if result.returncode != 0 or status not in ("200", "401"):
            raise _Pending("proxy cannot reach the HTTPS registry")
        return {"service": "build-proxy", "status": "ready", "registryStatus": int(status)}

    return _wait("build-proxy", env, timeout, probe)
