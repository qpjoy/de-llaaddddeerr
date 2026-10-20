#!/usr/bin/env python3
"""Idempotent PostgreSQL runtime reconcile for MX deployments (Python 3.6+).

It never deletes, restarts or recreates a database Pod and never edits a
StatefulSet. For each target in postgres-runtime.json it:

1. resizes the running Pod in place to the CPU/memory its StatefulSet template
   already declares (Kubernetes Pod resize; the container keeps running), and
2. writes declared reload-level settings with ALTER SYSTEM, then reloads.

Restart-level settings, command-line overrides, rejected resizes and template
revisions waiting under OnDelete are only reported. Running it again with
nothing changed performs no writes.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
DEFAULT_PROFILES = HERE / "postgres-runtime.json"
NAME = re.compile(r"^[a-z_][a-z0-9_]*$")
VALUE = re.compile(r"^[A-Za-z0-9_.+:-]{1,64}$")
KUBE_NAME = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
RESIZE_WAIT_SECONDS = 90


class Failure(Exception):
    pass


def say(message):
    print("[db] " + message, flush=True)


def first_line(text):
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:300]
    return ""


def kube_env():
    env = os.environ.copy()
    if "KUBECONFIG" not in env and Path("/etc/kubernetes/admin.conf").is_file():
        env["KUBECONFIG"] = "/etc/kubernetes/admin.conf"
    return env


def kubectl(args, stdin=None, timeout=30):
    try:
        result = subprocess.run(["kubectl"] + args, input=stdin, env=kube_env(), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise Failure("kubectl 不可用或超时")
    if result.returncode:
        raise Failure(first_line(result.stderr) or "kubectl 返回失败")
    return result.stdout


def get_json(namespace, kind, name):
    try:
        return json.loads(kubectl(["--request-timeout=15s", "-n", namespace, "get", kind, name, "-o", "json"]))
    except ValueError:
        raise Failure("kubectl 返回的 {} 不是 JSON".format(kind))


# ---- Kubernetes quantities ------------------------------------------------

BINARY = {"Ki": 2 ** 10, "Mi": 2 ** 20, "Gi": 2 ** 30, "Ti": 2 ** 40, "Pi": 2 ** 50, "Ei": 2 ** 60}
DECIMAL = {"k": 10 ** 3, "M": 10 ** 6, "G": 10 ** 9, "T": 10 ** 12, "P": 10 ** 15, "E": 10 ** 18}


def quantity(resource, value):
    """CPU in millicores, memory in bytes; None when the text is not understood."""
    text = str(value).strip()
    match = re.match(r"^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]*)$", text)
    if not match:
        return None
    number, suffix = float(match.group(1)), match.group(2)
    if resource == "cpu":
        if suffix == "m":
            return int(round(number))
        return int(round(number * 1000)) if suffix == "" else None
    if suffix == "":
        return int(round(number))
    factor = BINARY.get(suffix) or DECIMAL.get(suffix)
    return int(round(number * factor)) if factor else None


def cpu_memory(resources):
    out = {}
    for group in ("requests", "limits"):
        for resource in ("cpu", "memory"):
            value = ((resources or {}).get(group) or {}).get(resource)
            if value is not None:
                out[group + "." + resource] = str(value)
    return out


def same_resources(left, right):
    if set(left) != set(right):
        return False
    for key, value in left.items():
        resource = key.split(".")[1]
        a, b = quantity(resource, value), quantity(resource, right[key])
        if a is None or b is None or a != b:
            return False
    return True


def container(spec, name):
    for item in (spec or {}).get("containers") or []:
        if item.get("name") == name:
            return item
    raise Failure("找不到容器 " + name)


def container_status(pod, name):
    for item in (pod.get("status") or {}).get("containerStatuses") or []:
        if item.get("name") == name:
            return item
    return {}


def reconcile_resources(target, sts, pod, apply):
    name = target["container"]
    desired = cpu_memory(container(sts["spec"]["template"]["spec"], name).get("resources"))
    current = cpu_memory(container(pod["spec"], name).get("resources"))
    report = {"desired": desired, "before": current}
    if same_resources(desired, current):
        report["status"] = "in-sync"
        return report
    if set(desired) - set(current) or set(current) - set(desired):
        # Adding or removing a request/limit is not an in-place resize.
        report.update(status="restart-required", detail="模板增删了 requests/limits 项，只能在计划重启时生效")
        return report
    if not apply:
        report["status"] = "resize-needed"
        return report
    patch = {"spec": {"containers": [{"name": name, "resources": {}}]}}
    for key, value in desired.items():
        group, resource = key.split(".")
        patch["spec"]["containers"][0]["resources"].setdefault(group, {})[resource] = value
    body = json.dumps(patch, separators=(",", ":"))
    restarts = container_status(pod, name).get("restartCount")
    base = ["--request-timeout=15s", "-n", target["namespace"], "patch", "pod", target["pod"],
            "--subresource", "resize", "--type", "strategic", "-p", body]
    try:
        kubectl(base + ["--dry-run=server"])
    except Failure as error:
        report.update(status="resize-rejected", detail=str(error))
        return report
    kubectl(base)
    deadline = time.monotonic() + RESIZE_WAIT_SECONDS
    while True:
        latest = get_json(target["namespace"], "pod", target["pod"])
        status = container_status(latest, name)
        allocated = cpu_memory(status.get("resources")) if status.get("resources") else None
        conditions = {c.get("type"): c for c in (latest.get("status") or {}).get("conditions") or []}
        pending = conditions.get("PodResizePending")
        if status.get("restartCount") != restarts:
            report.update(status="restarted", detail="容器重启次数发生变化，请检查 resizePolicy 与 Pod 事件")
            return report
        if allocated is not None and same_resources(desired, allocated):
            report.update(status="resized", after=allocated)
            return report
        if pending and pending.get("status") == "True" and pending.get("reason") == "Infeasible":
            report.update(status="resize-infeasible", detail=first_line(pending.get("message")) or "节点资源不足")
            return report
        if time.monotonic() >= deadline:
            report.update(status="resize-pending", detail="已提交，kubelet 尚未确认；不会重试或重启")
            return report
        time.sleep(3)


# ---- PostgreSQL settings ---------------------------------------------------

def psql(target, sql, timeout=60):
    user = target.get("user")
    database = target.get("database")
    login = ("-U {} -d {}".format(user, database) if user and database
             else '-U "$POSTGRES_USER" -d "$POSTGRES_DB"')
    command = "exec psql -X -q -At -v ON_ERROR_STOP=1 " + login
    return kubectl(["-n", target["namespace"], "exec", "-i", target["pod"], "-c", target["container"], "--",
                    "sh", "-c", command], stdin=sql, timeout=timeout)


def desired_values(settings):
    out = {}
    for name, value in settings.items():
        options = value if isinstance(value, list) else [value]
        if not NAME.match(name) or not options or not all(isinstance(v, str) and VALUE.match(v) for v in options):
            raise Failure("配置项格式无效：" + name)
        out[name] = options
    return out


def read_settings(target, names):
    literal = ",".join("'" + name + "'" for name in names)
    sql = """SELECT json_build_object(
  'settings', coalesce((SELECT json_agg(json_build_object(
    'name', s.name, 'setting', s.setting, 'unit', s.unit, 'context', s.context, 'source', s.source,
    'enumvals', s.enumvals,
    'auto', (SELECT f.setting FROM pg_file_settings f
              WHERE f.name = s.name AND f.sourcefile LIKE '%postgresql.auto.conf'
              ORDER BY f.seqno DESC LIMIT 1)))
    FROM pg_settings s WHERE s.name = ANY(ARRAY[{names}]::text[])), '[]'::json),
  'pendingRestart', coalesce((SELECT json_agg(name ORDER BY name) FROM pg_settings WHERE pending_restart), '[]'::json));
""".format(names=literal or "NULL")
    output = psql(target, sql).strip().splitlines()
    if not output:
        raise Failure("psql 没有返回设置")
    data = json.loads(output[-1])
    return {row["name"]: row for row in data["settings"]}, data["pendingRestart"]


def reconcile_settings(target, apply):
    wanted = desired_values(target.get("settings") or {})
    report = {"changed": [], "skipped": [], "effective": {}}
    if not wanted:
        report["status"] = "none-declared"
        _, report["pendingRestart"] = read_settings(target, [])
        return report
    current, pending = read_settings(target, sorted(wanted))
    statements = []
    for name, options in sorted(wanted.items()):
        row = current.get(name)
        if not row:
            report["skipped"].append({"name": name, "reason": "此 PostgreSQL 版本没有该参数"})
            continue
        enumvals = [str(v).lower() for v in (row.get("enumvals") or [])]
        choice = next((v for v in options if not enumvals or v.lower() in enumvals), None)
        if choice is None:
            report["skipped"].append({"name": name, "reason": "构建不支持 " + "/".join(options)})
            continue
        auto = row.get("auto")
        if auto is not None and auto.strip().lower() == choice.lower():
            continue
        if auto is None and not row.get("unit") and str(row.get("setting")).lower() == choice.lower():
            continue
        if row.get("source") == "command line":
            report["skipped"].append({"name": name, "reason": "由启动参数固定；请改清单，计划重启时生效"})
            continue
        if row.get("context") == "postmaster":
            report["skipped"].append({"name": name, "reason": "需要重启才生效；未自动应用"})
            continue
        statements.append("ALTER SYSTEM SET {} = '{}';".format(name, choice))
        report["changed"].append({"name": name, "from": auto if auto is not None else row.get("setting"), "to": choice})
    if statements and apply:
        psql(target, "\n".join(statements + ["SELECT pg_reload_conf();"]) + "\n")
        time.sleep(1)
        current, pending = read_settings(target, sorted(wanted))
    report["status"] = ("applied" if statements and apply else "changes-needed" if statements else "in-sync")
    for name in sorted(wanted):
        row = current.get(name)
        if row:
            report["effective"][name] = str(row.get("setting")) + (row.get("unit") or "")
    report["pendingRestart"] = pending
    return report


# ---- Targets ---------------------------------------------------------------

def load_profiles(path):
    data = json.loads(Path(path).read_text())
    targets, projects = data.get("targets") or {}, data.get("projects") or {}
    for key, target in targets.items():
        for field in ("namespace", "statefulset", "container"):
            if not KUBE_NAME.match(str(target.get(field, ""))):
                raise Failure("目标 {} 的 {} 无效".format(key, field))
        target.setdefault("pod", target["statefulset"] + "-0")
        for field in ("user", "database"):
            if target.get(field) is not None and not NAME.match(str(target[field])):
                raise Failure("目标 {} 的 {} 无效".format(key, field))
    for project, names in projects.items():
        for name in names:
            if name not in targets:
                raise Failure("项目 {} 引用了未知目标 {}".format(project, name))
    return targets, projects


def reconcile_target(key, target, apply):
    report = {"target": key, "namespace": target["namespace"], "statefulset": target["statefulset"],
              "pod": target["pod"], "errors": []}
    try:
        sts = get_json(target["namespace"], "statefulset", target["statefulset"])
        pod = get_json(target["namespace"], "pod", target["pod"])
    except Failure as error:
        report["errors"].append("读取 StatefulSet/Pod 失败：" + str(error))
        return report
    report["updateStrategy"] = ((sts.get("spec") or {}).get("updateStrategy") or {}).get("type", "RollingUpdate")
    update_revision = (sts.get("status") or {}).get("updateRevision")
    pod_revision = ((pod.get("metadata") or {}).get("labels") or {}).get("controller-revision-hash")
    report["templatePending"] = bool(update_revision and pod_revision and update_revision != pod_revision)
    try:
        report["resources"] = reconcile_resources(target, sts, pod, apply)
    except Failure as error:
        report["errors"].append("资源调整失败：" + str(error))
    try:
        report["settings"] = reconcile_settings(target, apply)
    except (Failure, ValueError, KeyError) as error:
        report["errors"].append("参数调整失败：" + str(error))
    return report


def describe(report):
    say("{} ({}/{})：更新策略 {}".format(report["target"], report["namespace"], report["pod"],
                                       report.get("updateStrategy", "?")))
    resources = report.get("resources")
    if resources:
        say("  资源：{} {}".format(resources["status"], resources.get("detail", "")).rstrip())
        if resources["status"] not in ("in-sync",):
            say("    当前 {} → 模板 {}".format(json.dumps(resources["before"]), json.dumps(resources["desired"])))
    settings = report.get("settings")
    if settings:
        say("  参数：" + settings["status"])
        for item in settings.get("changed", []):
            say("    {}: {} → {}".format(item["name"], item["from"], item["to"]))
        for item in settings.get("skipped", []):
            say("    跳过 {}：{}".format(item["name"], item["reason"]))
        if settings.get("pendingRestart"):
            say("    待计划重启生效：" + ", ".join(settings["pendingRestart"]))
    if report.get("templatePending"):
        say("  StatefulSet 模板有新版本尚未作用于 Pod（{}）；不会自动重启，请在维护窗口删除 Pod 生效".format(
            report.get("updateStrategy")))
    for error in report["errors"]:
        say("  错误：" + error)


def main(argv):
    parser = argparse.ArgumentParser(description="MX PostgreSQL runtime reconcile (never restarts)")
    parser.add_argument("action", choices=("status", "apply"))
    parser.add_argument("names", nargs="+", help="项目名或目标名")
    parser.add_argument("--profiles", default=str(DEFAULT_PROFILES))
    parser.add_argument("--summary", help="把 JSON 结果写入该文件")
    args = parser.parse_args(argv)
    try:
        targets, projects = load_profiles(args.profiles)
        selected = []
        for name in args.names:
            keys = projects.get(name, [name] if name in targets else None)
            if keys is None:
                raise Failure("未知项目或目标：" + name)
            selected += [key for key in keys if key not in selected]
    except (Failure, OSError, ValueError) as error:
        say("停止：" + str(error))
        return 1
    reports = []
    for key in selected:
        report = reconcile_target(key, targets[key], args.action == "apply")
        describe(report)
        reports.append(report)
    if args.summary:
        Path(args.summary).write_text(json.dumps({"action": args.action, "targets": reports},
                                                 ensure_ascii=False, indent=2) + "\n")
    return 2 if any(report["errors"] for report in reports) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
