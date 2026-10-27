#!/usr/bin/env python3
"""Small, local dispatcher for existing MX installations (Python 3.6+)."""
import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parent.parent
DB_RUNTIME = ROOT / "scripts" / "pg_runtime.py"
DB_PROFILES = ROOT / "scripts" / "postgres-runtime.json"
ADMIN_CONFIG = Path("/etc/kubernetes/admin.conf")
RUNTIME_RESOLVER = Path("/usr/local/lib/mx-k8s-runtime/resolve.py")
ACTIVE_RUNTIME = Path("/etc/mx-k8s-runtime/active.json")
CHECKPOINT = Path("/var/lib/mx-launcher-recovery/latest.json")
APISERVER_MANIFEST = Path("/etc/kubernetes/manifests/kube-apiserver.yaml")
PROJECTS = {
    "mx-launcher": ("mx-launcher", "mx-internal-shadow", "MX_LAUNCHER_BUILD_PROXY"),
    "mx-insight-hub": ("mx-insight-hub", "mx-insight-hub", "MX_INSIGHT_BUILD_PROXY"),
    "mx-dataport": ("mx-dataport", "mx-harbor", "MX_HARBOR_BUILD_PROXY"),
    "mx-device": ("mx-base/mx-device", None, "MX_DEVICE_BUILD_PROXY"),
    "mx-pay": ("mx-base/mx-pay", "mx-pay", "MX_PAY_BUILD_PROXY"),
    "mx-rig": ("mx-rig", "mx-rig", "MX_RIG_BUILD_PROXY"),
    "mx-common": ("mx-common", "mx-common", None),
    "mx-hanlp": ("mx-common", "mx-common", "PROXY"),
}
ALIASES = dict(zip(("launcher", "hub", "dataport", "device", "pay", "rig", "common"), PROJECTS))
ALIASES["hanlp"] = "mx-hanlp"
ALL_PROJECTS = ("mx-launcher", "mx-pay", "mx-hanlp", "mx-insight-hub", "mx-dataport")
EFFECTS = {
    "mx-launcher": "发布 Internal 登录/网络相关组件；保留原恢复检查，地址变化可能触发控制面修复。PG 为 OnDelete，模板变化不重启数据库；完成后 db apply 原地调整资源和参数。",
    "mx-insight-hub": "执行 Hub 迁移及发布；原流程会 ensure mx-common：共享 PG 为 OnDelete 不重启，ES 模板变化仍会滚动；完成后 db apply 原地调整共享 PG；不启用 Launcher 同步或测试数据。",
    "mx-dataport": "执行 DataPort 迁移及单副本 Recreate 发布，可能短暂不可用；不执行 enroll。",
    "mx-device": "排空自身 Worker、迁移并替换 API/Worker；已有 PostgreSQL 使用 --no-recreate。",
    "mx-pay": "执行 Pay 自身迁移和 API/console 发布；按原流程暂停/恢复新 checkout；保留已有 PG。",
    "mx-rig": "执行 Rig Kubernetes 发布；PG 为 OnDelete，模板变化不重建数据库 Pod，CPU/内存由 db apply 原地调整。",
    "mx-hanlp": "执行 mx-common deploy hanlp：构建模型镜像、导入当前 K8s 运行时、发布 HanLP 并等待分词服务就绪。",
}
HELP = """MX 统一管理入口（在目标服务器的 electron-dock 目录执行）
  bash scripts/manage.sh list
  bash scripts/manage.sh plan <项目>       # 离线查看部署命令、参数与影响
  PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy <项目>
  bash scripts/manage.sh plan all          # 核心服务串行计划（离线）
  PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy all
  bash scripts/manage.sh boot audit|install|verify
  bash scripts/manage.sh status [项目]     # 查询当前选择的集群/Compose
  bash scripts/manage.sh doctor [项目]     # 只读检查 API、节点、空间和资源
  bash scripts/manage.sh etcd status       # 已有 mx-move 事务状态
  bash scripts/manage.sh db status [项目]  # 数据库参数/资源与声明是否一致（只读）
  bash scripts/manage.sh db apply <项目>   # 热加载参数、Pod 原地调整资源；从不重启数据库

项目：mx-launcher / mx-insight-hub / mx-dataport / mx-device / mx-pay / mx-rig
短名：launcher / hub / dataport / device / pay / rig / hanlp；mx-common 仅支持只读检查。
all = Launcher → Pay → HanLP → Hub → DataPort，仅用于已有 Internal 安装的显式发布。
Hub 发布前等待宿主 127.0.0.1:5432 PostgreSQL 和 HanLP；MX_WAIT_TIMEOUT 默认 300 秒。
PROXY 支持 host:port 或 http(s)://host:port；* 是主机占位，不能原样使用。
显式 PROXY 优先；空值清空本次专用构建代理，未设置时沿用各项目配置。
不会配置系统代理或 MX-H2I 用户代理。不提供通用 restart/restore；开机不执行 deploy。
原项目命令继续可用。总入口锁仅保护经它发起的同用户、同主机部署。
deploy 成功后自动执行一次 db apply（scripts/postgres-runtime.json）；MX_DB_RUNTIME=0 可跳过。
"""


class Stop(Exception):
    pass


class Interrupted(BaseException):
    def __init__(self, number):
        self.number = number


@contextmanager
def batch_signals():
    def interrupt(number, _frame):
        raise Interrupted(number)
    previous = {number: signal.signal(number, interrupt) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


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
        if env.get("MX_INSIGHT_HUB_DEPLOY", "0") != "0":
            raise Stop("MX_INSIGHT_HUB_DEPLOY 必须为 0；禁止 Launcher 隐式重复发布 Hub")
        env["MX_INSIGHT_HUB_DEPLOY"] = overrides["MX_INSIGHT_HUB_DEPLOY"] = "0"
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
    if name == "mx-hanlp":
        command += ["hanlp"]
    return ROOT / folder, command, env, overrides


def readiness():
    spec = importlib.util.spec_from_file_location("mx_readiness", ROOT / "scripts/readiness.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_dependencies(env, hub=False, proxy=False):
    checks = readiness()
    try:
        if proxy:
            checks.wait_proxy(env)
        if hub:
            checks.wait_host_postgres(env)
            checks.wait_hanlp(env)
    except checks.ReadinessError as error:
        raise Stop(str(error))


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
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(str(temporary), str(path))
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


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


def db_projects():
    try:
        return json.loads(DB_PROFILES.read_text()).get("projects") or {}
    except (OSError, ValueError):
        return {}


def db_runtime(action, names, summary=None, env=None, lock_fd=None):
    command = [sys.executable, "-I", str(DB_RUNTIME), action] + names
    if summary:
        command += ["--summary", str(summary)]
    env = kube_env(os.environ if env is None else env)
    if lock_fd is not None:
        return child_run(command, ROOT, env, lock_fd)
    return subprocess.call(command, cwd=str(ROOT), env=env)


def post_deploy_db(name, state, env=None, lock_fd=None):
    """Bring the project's databases to the declared runtime state; never restarts them."""
    env = os.environ if env is None else env
    if env.get("MX_DB_RUNTIME", "1") == "0":
        say("按 MX_DB_RUNTIME=0 跳过数据库运行配置")
        return {"skipped": True}
    say("应用数据库运行配置：参数热加载、Pod 原地调整资源；不重启、不重建数据库")
    summary = state / ("db-runtime-" + uuid.uuid4().hex + ".json")
    result = {}
    try:
        result["exitCode"] = db_runtime("apply", [name], summary, env, lock_fd)
        data = json.loads(summary.read_text())
        result["targets"] = [{
            "target": item.get("target"),
            "resources": (item.get("resources") or {}).get("status"),
            "settings": (item.get("settings") or {}).get("status"),
            "changed": [change.get("name") for change in (item.get("settings") or {}).get("changed", [])],
            "templatePending": item.get("templatePending"),
            "errors": item.get("errors"),
        } for item in data.get("targets", [])]
    except (OSError, ValueError):
        result["exitCode"] = result.get("exitCode") or 1
    finally:
        if summary.exists():
            summary.unlink()
    if result.get("exitCode"):
        say("数据库运行配置未全部完成；项目发布结果不变。可稍后执行 bash scripts/manage.sh db apply " + name)
    return result


@contextmanager
def deployment_lock(state):
    fd = os.open(str(state / "deploy.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Stop("发布锁必须由当前用户持有且仅该用户可访问")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stop("另一个统一部署正在进行；未启动项目脚本")
        yield fd
    finally:
        os.close(fd)


def deploy_step(name, state, fd, bound_env=None, db_env=None):
    cwd, command, env, overrides = deployment(name)
    if bound_env is not None:
        env.update(bound_env)
        overrides.update({key: env[key] for key in overrides if key in bound_env})
    if not (cwd / "scripts/manage.sh").is_file():
        raise Stop("项目管理入口不存在")
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
            record["preflightTarget"] = cluster_check(db_env or env)
        if name == "mx-insight-hub":
            wait_dependencies(env, hub=True)
        record["phase"] = "running"
        write_record(receipt, record)
        say("开始执行原项目部署脚本")
        code = child_run(command, cwd, env, fd)
        record["phase"] = "child_succeeded" if code == 0 else "child_failed"
        if code == 0 and name in db_projects():
            write_record(receipt, record)
            record["postgresRuntime"] = post_deploy_db(name, state, db_env or env, fd)
            if record["postgresRuntime"].get("exitCode", 0) >= 128:
                code = record["postgresRuntime"]["exitCode"]
                record["phase"] = "interrupted"
    except (Stop, OSError) as error:
        say(str(error) if isinstance(error, Stop) else "无法启动子项目命令")
        code = 1
        record["phase"] = "failed"
    record.update({"exitCode": code, "elapsedSeconds": round(time.monotonic() - started, 2),
                   "finishedAt": datetime.datetime.utcnow().isoformat() + "Z"})
    write_record(receipt, record)
    say("{} {}，耗时 {} 秒；退出码 {}".format(name, record["phase"], record["elapsedSeconds"], code))
    return record


def deploy(name):
    deployment(name)  # Reject invalid options before creating state or taking locks.
    state = private_state()
    with deployment_lock(state) as fd:
        return deploy_step(name, state, fd)["exitCode"]


def plan_all():
    steps = []
    for name in ALL_PROJECTS:
        cwd, command, _, overrides = deployment(name)
        steps.append({"project": name, "cwd": str(cwd), "command": command,
                      "environment": overrides, "effects": EFFECTS[name]})
    print(json.dumps({"mode": "offline-deploy-plan", "serial": True, "steps": steps,
                      "preflight": "已有 Internal 主机；固定 admin.conf、原 runtime 和保存的项目目标；等待显式 PROXY 与宿主 PG。Hub 前再次等待 PG/HanLP。",
                      "failure": "首次失败停止；保留已完成步骤，不回滚、不重放迁移。开机不执行此命令。"}, ensure_ascii=False, indent=2))
    return 0


def saved_object(path):
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (OSError, ValueError):
        raise Stop("全量部署需要有效的原安装记录：" + path.name + "；不执行首次安装或目标发现")


def check_target_overrides(path, expected):
    """Inspect operator-owned shell env files without evaluating their contents."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            # In shell, only an unquoted # starting a word begins a comment.
            # shlex's default also truncates KEY=value#suffix, which is unsafe.
            quote, escaped = None, False
            for index, char in enumerate(stripped):
                if escaped:
                    escaped = False
                elif char == "\\" and quote != "'":
                    escaped = True
                elif quote:
                    if char == quote:
                        quote = None
                elif char in ("'", '"'):
                    quote = char
                elif char == "#" and (index == 0 or stripped[index - 1].isspace()):
                    stripped = stripped[:index]
                    break
            lexer = shlex.shlex(stripped, posix=True, punctuation_chars=True)
            lexer.commenters = ""
            lexer.whitespace_split = True
            parts = list(lexer)
            if parts and parts[0] == "export":
                parts.pop(0)
            if len(parts) != 1 or "$" in parts[0] or "`" in parts[0]:
                raise ValueError()
            match = re.fullmatch(r"([A-Za-z_][A-Za-z_0-9]*)=(.*)", parts[0])
            if not match:
                raise ValueError()
        except ValueError:
            raise Stop(path.name + " 含非单一字面赋值；全量部署无法静态核对目标，请使用逐项目入口")
        key, value = match.groups()
        if key in expected and value != expected[key]:
            raise Stop(path.name + " 中 " + key + " 与固定 Internal 目标不一致；请先核对")


def batch_target():
    if not ADMIN_CONFIG.is_file():
        raise Stop("全量部署仅支持原 Internal Linux 主机的 /etc/kubernetes/admin.conf")
    env = os.environ.copy()
    if env.get("KUBECONFIG", str(ADMIN_CONFIG)) != str(ADMIN_CONFIG):
        raise Stop("全量部署 KUBECONFIG 必须指向原 admin.conf")
    env["KUBECONFIG"] = str(ADMIN_CONFIG)
    context = kube_read(["config", "current-context"], env)
    uid = kube_read(["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"], env)
    if not context or not uid:
        raise Stop("无法确认原 Internal 集群身份")
    active = saved_object(ACTIVE_RUNTIME)
    if (active.get("phase") != "active" or active.get("service") != "mx-k8s-containerd.service"
            or active.get("hostname") != os.uname().nodename):
        raise Stop("必须在已激活的原 Internal 独立 runtime 主机执行全量部署")
    try:
        nodes = json.loads(kube_read(["get", "nodes", "-o", "json"], env))["items"]
        addresses = [item["address"] for item in nodes[0]["status"]["addresses"]
                     if item["type"] == "InternalIP" and ":" not in item["address"]]
        if len(nodes) != 1 or nodes[0]["metadata"]["name"] != active["hostname"] or len(addresses) != 1:
            raise ValueError()
    except (ValueError, KeyError, IndexError, TypeError):
        raise Stop("无法唯一确认原 Internal 节点及控制面 IPv4 地址")
    try:
        advertised = re.findall(r"^\s*-\s+--advertise-address=([0-9.]+)\s*$", APISERVER_MANIFEST.read_text(), re.M)
        if advertised != addresses:
            raise ValueError()
    except (OSError, ValueError):
        raise Stop("原 apiserver advertise-address 与节点地址不一致或无法确认；全量部署不执行地址修复")
    runtime = read_command([sys.executable, "-I", str(RUNTIME_RESOLVER), "service"], env)
    if runtime != active["service"]:
        raise Stop("原 runtime 解析不一致；未选择备用 runtime")
    checkpoint = saved_object(CHECKPOINT)
    pay = saved_object(ROOT / "mx-base/mx-pay/.deploy/target.json")
    dataport = saved_object(ROOT / "mx-dataport/secrets/operations.json")
    if (checkpoint.get("clusterUid") != uid or pay.get("clusterUID") != uid
            or dataport.get("clusterUid") != uid or pay.get("context") != context
            or dataport.get("context") != context or pay.get("namespace") != "mx-pay"
            or dataport.get("node") != active["hostname"]):
        raise Stop("Launcher、Pay、DataPort 保存的集群/context/node 与原 Internal 不一致；请逐项目核对")
    bound = {"KUBECONFIG": str(ADMIN_CONFIG), "MX_PAY_KUBE_CONTEXT": context,
             "MX_PAY_NAMESPACE": "mx-pay", "MX_PAY_DEPLOY_DRIVER": "k8s",
             "MX_HARBOR_KUBE_CONTEXT": context, "MX_HARBOR_NODE": active["hostname"],
             "CONTEXT": context, "KUBE_CONTEXT": context,
             "MX_K8S_OS_HOSTNAME": active["hostname"],
             "MX_K8S_APISERVER_ADVERTISE_ADDRESS": addresses[0]}
    for key, expected in bound.items():
        if key in env and env[key] != expected:
            raise Stop(key + " 与固定 Internal 目标不一致")
    check_target_overrides(ROOT / "mx-base/mx-pay/.env", bound)
    check_target_overrides(ROOT / "mx-insight-hub/.env.internal", bound)
    return {"context": context, "clusterUID": uid, "node": active["hostname"], "runtime": runtime}, bound


def database_target_snapshot(state, target, env):
    # Only the DB post-step uses this private snapshot: it must not follow a
    # mutable current-context while a deployment is running. Never log its data.
    raw = kube_read(["--context", target["context"], "config", "view", "--minify", "--flatten", "--raw", "-o", "json"], env)
    try:
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get("current-context") != target["context"]
                or len(value.get("contexts", [])) != 1):
            raise ValueError()
    except (ValueError, TypeError):
        raise Stop("无法生成固定目标的私有数据库 kubeconfig")
    path = state / ("db-target-" + uuid.uuid4().hex + ".kubeconfig")
    write_record(path, value)
    snapshot_env = dict(env, KUBECONFIG=str(path))
    try:
        uid = kube_read(["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"], snapshot_env)
        if uid != target["clusterUID"]:
            raise Stop("数据库 kubeconfig 的集群身份不一致")
    except BaseException:
        path.unlink()
        raise
    return path, snapshot_env


def deploy_all():
    if not os.environ.get("PROXY"):
        raise Stop("全量部署需要显式 PROXY，例如 PROXY=127.0.0.1:7788；只用于本次构建")
    for name in ALL_PROJECTS:
        cwd, _, _, _ = deployment(name)
        if not (cwd / "scripts/manage.sh").is_file():
            raise Stop("全量部署缺少项目入口：" + name)
    state = private_state()
    with deployment_lock(state) as fd, batch_signals():
        record = {"action": "deploy-all", "phase": "preflight",
                  "steps": [{"project": name, "status": "pending"} for name in ALL_PROJECTS],
                  "startedAt": datetime.datetime.utcnow().isoformat() + "Z"}
        receipt = state / ("all-" + uuid.uuid4().hex + ".json")
        write_record(receipt, record)
        say("串行全量部署；记录 " + str(receipt))
        code = 1
        snapshot = None
        try:
            target, bound = batch_target()
            record["target"] = target
            env = dict(os.environ, **bound)
            cluster_check(env)
            snapshot, db_env = database_target_snapshot(state, target, env)
            wait_dependencies(env, proxy=True)
            checks = readiness()
            try:
                checks.wait_host_postgres(env)
            except checks.ReadinessError as error:
                raise Stop(str(error))
            for step in record["steps"]:
                current, current_bound = batch_target()
                if current != target or current_bound != bound:
                    raise Stop("部署期间目标发生变化；剩余步骤未执行")
                step["status"] = "running"
                record["phase"] = "running"
                write_record(receipt, record)
                result = deploy_step(step["project"], state, fd, bound, db_env)
                code = result["exitCode"] or (result.get("postgresRuntime") or {}).get("exitCode", 0)
                step.update({"status": "failed" if code else "succeeded", "exitCode": code})
                write_record(receipt, record)
                if code:
                    break
            record["phase"] = "interrupted" if code >= 128 else ("failed" if code else "completed")
        except (Stop, OSError) as error:
            code = 1
            record["phase"] = "failed"
            say(str(error) if isinstance(error, Stop) else "全量部署本地操作失败；未自动重试")
        except KeyboardInterrupt:
            code = 130
            record["phase"] = "interrupted"
        except Interrupted as error:
            code = 128 + error.number
            record["phase"] = "interrupted"
        finally:
            if snapshot is not None:
                snapshot.unlink()
            record.update({"exitCode": code, "finishedAt": datetime.datetime.utcnow().isoformat() + "Z"})
            write_record(receipt, record)
            say("全量部署 {}；已完成步骤保留，未执行步骤不会自动续跑".format(record["phase"]))
        return code


def main(args):
    if not args or args in (["help"], ["--help"], ["-h"]):
        print(HELP)
        return 0
    if args == ["list"]:
        for name, (_, namespace, proxy_key) in PROJECTS.items():
            print("{}\t{}\t{}".format(name, "k8s:" + namespace if namespace else "compose", "deploy/status/doctor" if proxy_key else "status/doctor"))
        print("etcd\tmx-move\tstatus")
        return 0
    if len(args) == 2 and args[0] == "boot" and args[1] in ("audit", "install", "verify"):
        return subprocess.call([sys.executable, "-I", str(ROOT / "scripts/boot.py"), args[1]])
    if args == ["plan", "all"]:
        return plan_all()
    if args == ["deploy", "all"]:
        return deploy_all()
    if len(args) in (2, 3) and args[0] == "db" and args[1] in ("status", "apply"):
        names = [project_name(args[2])] if len(args) == 3 else []
        if args[1] == "apply" and not names:
            raise Stop("db apply 需要指定项目")
        targets = db_projects()
        names = [n for n in (names or list(PROJECTS)) if n in targets]
        if not names:
            raise Stop("该项目没有声明数据库运行配置")
        return db_runtime(args[1], names)
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
