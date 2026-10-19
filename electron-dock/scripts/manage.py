#!/usr/bin/env python3
"""Small, local dispatcher for existing MX installations (Python 3.6+)."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = {
    "mx-launcher": ("mx-launcher", "mx-internal-shadow", "MX_LAUNCHER_BUILD_PROXY"),
    "mx-insight-hub": ("mx-insight-hub", "mx-insight-hub", "MX_INSIGHT_BUILD_PROXY"),
    "mx-dataport": ("mx-dataport", "mx-harbor", "MX_HARBOR_BUILD_PROXY"),
    "mx-device": ("mx-base/mx-device", None, "MX_DEVICE_BUILD_PROXY"),
    "mx-pay": ("mx-base/mx-pay", "mx-pay", "MX_PAY_BUILD_PROXY"),
    "mx-rig": ("mx-rig", "mx-rig", "MX_RIG_BUILD_PROXY"),
    "mx-common": ("mx-common", "mx-common", None),
}
ALIASES = dict(zip(("launcher", "hub", "dataport", "device", "pay", "rig", "common"), PROJECTS))
EFFECTS = {
    "mx-launcher": "发布 Internal 登录/网络相关组件；保留原恢复检查，地址变化可能触发控制面修复。",
    "mx-insight-hub": "执行 Hub 迁移及发布；原流程会 ensure mx-common，模板变化可能更新共享 PG/ES；不启用 Launcher 同步或测试数据。",
    "mx-dataport": "执行 DataPort 迁移及单副本 Recreate 发布，可能短暂不可用；不执行 enroll。",
    "mx-device": "排空自身 Worker、迁移并替换 API/Worker；已有 PostgreSQL 使用 --no-recreate。",
    "mx-pay": "执行 Pay 自身迁移和 API/console 发布；按原流程暂停/恢复新 checkout；保留已有 PG。",
    "mx-rig": "执行 Rig Kubernetes 发布；PG 模板变化会滚动重建数据库 Pod，需核对备份及维护窗口。",
}
HELP = """MX 统一管理入口（在目标服务器的 electron-dock 目录执行）
  bash scripts/manage.sh list
  bash scripts/manage.sh plan <项目>       # 离线查看部署命令、参数与影响
  PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy <项目>
  bash scripts/manage.sh status [项目]     # 查询当前选择的集群/Compose
  bash scripts/manage.sh doctor [项目]     # 只读检查 API、节点、空间和资源
  bash scripts/manage.sh etcd status       # 已有 mx-move 事务状态

项目：mx-launcher / mx-insight-hub / mx-dataport / mx-device / mx-pay / mx-rig
短名：launcher / hub / dataport / device / pay / rig；mx-common 仅支持只读检查。
PROXY 支持 host:port 或 http(s)://host:port；* 是主机占位，不能原样使用。
显式 PROXY 优先；空值清空本次专用构建代理，未设置时沿用各项目配置。
不会配置系统代理或 MX-H2I 用户代理。不支持全量 deploy、通用 restart/restore。
原项目命令继续可用。总入口锁仅保护经它发起的同用户、同主机部署。
"""


class Stop(Exception):
    pass


def say(message):
    print("[mx] " + message, flush=True)


def project_name(value):
    name = ALIASES.get(value, value)
    if name not in PROJECTS:
        raise Stop("未知项目；运行 list 查看支持列表")
    return name


def proxy_url(value):
    if not value:
        return ""
    try:
        if any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError()
        value = value if "://" in value else "http://" + value
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if (parsed.scheme not in ("http", "https") or not host or not port
                or not 1 <= port <= 65535 or any(c in host for c in "*\\/?#")
                or host in ("0.0.0.0", "::") or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError()
        return value.rstrip("/")
    except ValueError:
        raise Stop("PROXY 需要可连接的 HTTP(S) 主机和端口，例如 127.0.0.1:7788；不接受 * 或监听地址")


def safe_proxy(value):
    if not value:
        return "(empty)"
    try:
        parsed = urlsplit(value if "://" in value else "http://" + value)
        host = parsed.hostname or "(configured)"
        if ":" in host:
            host = "[" + host + "]"
        return "{}://{}{}{}".format(parsed.scheme, "<redacted>@" if "@" in parsed.netloc else "",
                                    host, ":" + str(parsed.port) if parsed.port else "")
    except ValueError:
        return "(configured; hidden)"


def deployment(name):
    folder, namespace, proxy_key = PROJECTS[name]
    if not proxy_key:
        raise Stop("mx-common 由现有 Hub 流程管理；本入口只支持查询")
    env = os.environ.copy()
    overrides = {}
    defaults = {}
    if name in ("mx-launcher", "mx-device", "mx-pay"):
        defaults["TMPDIR"] = "/data/tmp"
    if name == "mx-launcher":
        defaults.update({"MX_K8S_OS_HOSTNAME": "mx-internal-server",
                         "MX_K8S_APISERVER_ADVERTISE_ADDRESS": "192.168.1.2",
                         "MX_SHADOW_BUILDKIT_KEEP_STORAGE": "2GB",
                         "MX_SHADOW_BUILDKIT_PRUNE_UNTIL": "24h"})
    for key, value in defaults.items():
        env.setdefault(key, value)
        overrides[key] = env[key]
    if name == "mx-insight-hub":
        for key in ("MX_INSIGHT_SYNC_LAUNCHER", "MX_SMOKE_DATA"):
            if env.get(key, "0") != "0":
                raise Stop(key + " 必须为 0；统一 Hub 发布保持独立生产范围")
            env[key] = overrides[key] = "0"
    if "PROXY" in env:
        proxy = proxy_url(env["PROXY"])
        env["PROXY"] = env[proxy_key] = proxy
        overrides[proxy_key] = safe_proxy(proxy)
        # The existing DataPort entrypoint falls back with `harbor || insight`.
        if name == "mx-dataport":
            env["MX_INSIGHT_BUILD_PROXY"] = proxy
    else:
        overrides[proxy_key] = safe_proxy(env[proxy_key]) if proxy_key in env else "(project configuration)"
    command = ["bash", "scripts/manage.sh"]
    if name in ("mx-launcher", "mx-insight-hub", "mx-dataport"):
        command += ["ops", "internal-production"]
    command += ["deploy"]
    return ROOT / folder, command, env, overrides


def kube_env(env):
    env = env.copy()
    if "KUBECONFIG" not in env and Path("/etc/kubernetes/admin.conf").is_file():
        env["KUBECONFIG"] = "/etc/kubernetes/admin.conf"
    return env


def read_command(command, env, timeout=20):
    try:
        result = subprocess.run(command, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise Stop(command[0] + " 不可用或只读查询超时；未执行自动修复")
    if result.returncode:
        raise Stop(command[0] + " 只读查询失败；原始错误已隐藏，请检查目标和权限")
    return result.stdout.strip()


def kube_read(args, env):
    return read_command(["kubectl", "--request-timeout=15s"] + args, env)


def cluster_check(env):
    say("当前 kubeconfig 的辅助检查；子项目可能另选已保存目标，其原有身份校验仍负责最终发布目标")
    context = kube_read(["config", "current-context"], env)
    uid = kube_read(["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"], env)
    if not context or not uid:
        raise Stop("无法确认当前 Kubernetes context / cluster UID")
    say("检查集群 context={} clusterUID={}".format(context, uid))
    ready = kube_read(["get", "--raw=/readyz?verbose"], env)
    if "readyz check passed" not in ready:
        raise Stop("API readyz 未通过（包含 etcd 就绪检查）")
    try:
        nodes = json.loads(kube_read(["get", "nodes", "-o", "json"], env))["items"]
        if not nodes:
            raise ValueError()
        for node in nodes:
            conditions = {c["type"]: c["status"] for c in node.get("status", {}).get("conditions", [])}
            if conditions.get("Ready") != "True" or any(conditions.get(c) != "False" for c in (
                    "MemoryPressure", "DiskPressure", "PIDPressure")):
                raise Stop("节点未就绪或压力状态异常；部署停止，不自动重启服务")
        say("API/etcd readiness、节点 Ready 和压力检查通过")
    except (ValueError, KeyError, TypeError):
        raise Stop("无法解析节点健康状态")
    return {"context": context, "clusterUID": uid}


def status_project(name, env):
    folder, namespace, _ = PROJECTS[name]
    say("{} [{}]".format(name, "Kubernetes / " + namespace if namespace else "Compose"))
    try:
        if namespace:
            # Do not invoke Launcher status: it can repair kubeadm endpoints.
            output = kube_read(["-n", namespace, "get", "deployment,statefulset,daemonset,pods", "-o", "wide"], env)
        else:
            output = read_command(["bash", str(ROOT / folder / "scripts/manage.sh"), "status"], env, 30)
        print(output or "未列出资源（不等同业务健康）", flush=True)
        return 0
    except Stop as error:
        say("{} UNKNOWN：{}".format(name, error))
        return 1


def readonly(action, names):
    env = kube_env(os.environ)
    failed = 0
    if action == "doctor":
        if any(PROJECTS[name][1] for name in names):
            try:
                cluster_check(env)
            except Stop as error:
                say("cluster UNKNOWN：" + str(error))
                failed = 1
        paths = [p for p in ("/", "/data", "/var/lib/etcd") if os.path.exists(p)]
        try:
            print(read_command(["df", "-h"] + paths, env), flush=True)
        except Stop as error:
            say("disk UNKNOWN：" + str(error))
            failed = 1
    else:
        say("资源列表使用当前 KUBECONFIG/context；不加载项目 .env，不据列表判定业务健康")
    for name in names:
        failed = max(failed, status_project(name, env))
    return failed


def private_state():
    directory = Path(os.environ.get("MX_MANAGE_STATE_DIR", str(Path.home() / ".local/state/mx-electron-dock"))).absolute()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Stop("管理状态目录必须由当前用户持有且权限为 0700；不能使用符号链接")
    return directory


def write_record(path, record):
    temporary = path.with_suffix(".tmp")
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(str(temporary), str(path))


def child_run(command, cwd, env, lock_fd):
    # A killed dispatcher must not release the lock while its child still runs.
    child = subprocess.Popen(command, cwd=str(cwd), env=env, start_new_session=True, pass_fds=(lock_fd,))
    received = []

    def forward(number, _frame):
        received.append(number)
        say("正在向部署子进程转发停止信号，等待退出后释放锁")
        try:
            os.killpg(child.pid, number)
        except ProcessLookupError:
            pass

    previous = {number: signal.signal(number, forward) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        started = time.monotonic()
        while True:
            try:
                code = child.wait(timeout=15)
                break
            except subprocess.TimeoutExpired:
                say("本次项目部署仍在执行，总耗时 {} 秒（非当前阶段耗时）；未自动重试".format(int(time.monotonic() - started)))
        return 128 + received[0] if received else (128 - code if code < 0 else code)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def deploy(name):
    cwd, command, env, overrides = deployment(name)
    if not (cwd / "scripts/manage.sh").is_file():
        raise Stop("项目管理入口不存在")
    state = private_state()
    fd = os.open(str(state / "deploy.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Stop("发布锁必须由当前用户持有且仅该用户可访问")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stop("另一个统一部署正在进行；未启动项目脚本")
        started = time.monotonic()
        record = {"project": name, "action": "deploy", "phase": "preflight", "startedAt": datetime.datetime.utcnow().isoformat() + "Z"}
        receipt = state / (name + "-" + uuid.uuid4().hex + ".json")
        write_record(receipt, record)
        say("部署 {}；记录 {}".format(name, receipt))
        say(EFFECTS[name])
        say("参数：" + json.dumps(overrides, ensure_ascii=False))
        try:
            if PROJECTS[name][1]:
                env = kube_env(env)
                record["preflightTarget"] = cluster_check(env)
            record["phase"] = "running"
            write_record(receipt, record)
            say("开始执行原项目部署脚本")
            code = child_run(command, cwd, env, fd)
            record["phase"] = "child_succeeded" if code == 0 else "child_failed"
        except (Stop, OSError) as error:
            say(str(error) if isinstance(error, Stop) else "无法启动子项目命令")
            code = 1
            record["phase"] = "failed"
        record.update({"exitCode": code, "elapsedSeconds": round(time.monotonic() - started, 2),
                       "finishedAt": datetime.datetime.utcnow().isoformat() + "Z"})
        write_record(receipt, record)
        say("{} {}，耗时 {} 秒；退出码 {}".format(name, record["phase"], record["elapsedSeconds"], code))
        return code
    finally:
        os.close(fd)


def main(args):
    if not args or args in (["help"], ["--help"], ["-h"]):
        print(HELP)
        return 0
    if args == ["list"]:
        for name, (_, namespace, proxy_key) in PROJECTS.items():
            print("{}\t{}\t{}".format(name, "k8s:" + namespace if namespace else "compose", "deploy/status/doctor" if proxy_key else "status/doctor"))
        print("etcd\tmx-move\tstatus")
        return 0
    if args == ["etcd", "status"]:
        script = ROOT / "mx-base/mx-move/scripts/manage.sh"
        return subprocess.call(["bash", str(script), "etcd", "status"], cwd=str(script.parent.parent))
    action = args[0]
    if action in ("status", "doctor") and len(args) in (1, 2):
        return readonly(action, [project_name(args[1])] if len(args) == 2 else list(PROJECTS))
    if action in ("plan", "deploy") and len(args) == 2:
        name = project_name(args[1])
        if action == "deploy":
            return deploy(name)
        cwd, command, _, overrides = deployment(name)
        print(json.dumps({"project": name, "mode": "offline-deploy-plan", "cwd": str(cwd),
                          "command": command, "environment": overrides, "effects": EFFECTS[name],
                          "note": "不加载项目 .env，不检查线上状态；部署时先检查当前集群，子项目保留自己的配置与身份校验。"}, ensure_ascii=False, indent=2))
        return 0
    raise Stop("命令或参数不受支持；运行 help 查看用法")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Stop as error:
        say("停止：" + str(error))
        sys.exit(1)
    except OSError:
        say("停止：本地文件或进程操作失败；保留已有记录，未自动重试或恢复")
        sys.exit(1)
