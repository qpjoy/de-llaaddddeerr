"""knock-ocr API —— 一个接口，两种引擎，按需路由。

  POST /api/ocr?engine=fast|quality   上传图片/PDF -> markdown + 结构化 json
  GET  /api/info                      当前档位、引擎、后端状态、实时指标
  GET  /api/metrics                   计数与 P50/P95/P99（分引擎）
  POST /api/config                    在线调参（含并发，会后台重建流水线）
  GET  /healthz                       就绪探针
  GET  /                              Web 界面

部署档由 OCR_TIER 决定：fast | fast-gpu | quality | full。
fast 档不装 PaddleOCR-VL，镜像 <1GB，也不需要 GPU；
fast-gpu 是同一套模型换 onnxruntime-gpu，要一张卡但同样不起 vLLM。
两者对外都叫 engine=fast，调用方不用区分。

刻意只依赖运行镜像里已有的包（fastapi / uvicorn / starlette），
不引入 python-multipart —— 内网构建 pip 可能出不去，多一个依赖就多一个卡点。
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import statistics
import tempfile
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager, contextmanager
from email.parser import BytesParser
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from engines import IMAGE_SUFFIXES, build_engines, default_engine_name

APP_DIR = Path(__file__).parent
STATIC = APP_DIR / "static"

TIER = os.environ.get("OCR_TIER", "quality").strip().lower()
MAX_MB = int(os.environ.get("OCR_MAX_MB", "50"))
# 单请求排队等流水线的上限；超时直接 503，避免请求堆积拖垮服务
ACQUIRE_TIMEOUT = float(os.environ.get("OCR_ACQUIRE_TIMEOUT", "120"))
# 内容寻址缓存：key = sha256(图片字节) + 引擎 + 影响结果的参数。
# 爬虫场景重复图极多（经验 30~60%），这是最省事的一项吞吐优化 ——
# 不需要队列、不需要额外组件。0 表示关闭。
# 注意：进程内缓存，UVICORN_WORKERS>1 时每个进程各存一份；
# 要跨进程/跨机共享，换成 Redis 即可，key 的算法不用变。
CACHE_SIZE = int(os.environ.get("OCR_CACHE_SIZE", "512"))
# 缓存只放「识别结果」，不放图片；上传的临时文件在 finally 里立即删除，
# 所以磁盘不会增长，要控的是内存。三重上限，任一触发就淘汰最久未用的：
CACHE_TTL = float(os.environ.get("OCR_CACHE_TTL", "900"))       # 秒，默认 15 分钟
CACHE_MAX_MB = float(os.environ.get("OCR_CACHE_MAX_MB", "128")) # 总字节上限
MAX_BATCH = int(os.environ.get("OCR_MAX_BATCH", "32"))          # 一次请求最多几个文件/URL
# 异步队列：进程内，不依赖 Redis。够爬虫用，重启会丢未完成任务 —— 要持久化再换 Redis。
JOB_QUEUE_MAX = int(os.environ.get("OCR_JOB_QUEUE_MAX", "1000"))  # 队列深度，满了返回 429
JOB_WORKERS = int(os.environ.get("OCR_JOB_WORKERS", "4"))         # 队列消费线程数
JOB_TTL = int(os.environ.get("OCR_JOB_TTL", "1800"))              # 结果保留秒数

# ---- 界面上那份「服务能力」报告用的数据 ----
# 资源占用由 manage.sh 在启动时传进来（docker 的 --cpus/--memory 是容器外的东西，
# 进程自己看不到真实配额，只能靠传）。额定吞吐是实测值，换配置要重测。


def _int_env(name: str, default: int = 0) -> int:
    try:
        return int(float(os.environ.get(name) or default))
    except ValueError:
        return default


CAPACITY = {
    "cpu_limit": _int_env("OCR_CPU_LIMIT"),
    "host_cpus": _int_env("OCR_HOST_CPUS"),
    "mem_limit": os.environ.get("OCR_MEM_LIMIT", ""),
    "host_mem_gb": _int_env("OCR_HOST_MEM_GB"),
    "cpuset": os.environ.get("OCR_CPUSET", ""),
    "gpu_id": os.environ.get("OCR_GPU_ID", ""),
    "uvicorn_workers": _int_env("UVICORN_WORKERS", 1),
    "ort_intra": _int_env("OCR_ORT_INTRA_THREADS", 4),
    "rated_concurrency": _int_env("OCR_RATED_CONCURRENCY", 24),
    "rated_rps": float(os.environ.get("OCR_RATED_RPS") or 24.8),
}


def _num_env(name, cast=int):
    v = os.environ.get(name, "").strip()
    return cast(v) if v else None


# 运行时可调。per-request 三项每次 predict 传，立即生效；
# vl_rec_max_concurrency 是构造期参数，改了要重建 quality 池。
TUNING = {
    "vl_rec_max_concurrency": _num_env("OCR_VL_CONCURRENCY") or 8,
    "max_pixels": _num_env("OCR_MAX_PIXELS"),
    "max_new_tokens": _num_env("OCR_MAX_NEW_TOKENS"),
    "layout_threshold": _num_env("OCR_LAYOUT_THRESHOLD", float),
}

ENGINES = build_engines(TUNING)
DEFAULT_ENGINE = default_engine_name(ENGINES)

# 快通道便宜，可以多开；VL 通道每条都占后端并发，少开
WORKERS = {
    "fast": int(os.environ.get("OCR_WORKERS_FAST", "8")),
    "quality": int(os.environ.get("OCR_WORKERS_QUALITY",
                                  os.environ.get("OCR_WORKERS", "4"))),
}

MAGIC = (
    (b"%PDF", ".pdf"),
    (bytes.fromhex("89504e470d0a1a0a"), ".png"),
    (bytes.fromhex("ffd8ff"), ".jpg"),
    (b"BM", ".bmp"),
    (bytes.fromhex("49492a00"), ".tif"),
    (bytes.fromhex("4d4d002a"), ".tif"),
)
CRLF = bytes.fromhex("0d0a")


def sniff_suffix(blob: bytes, filename: str) -> str:
    """魔数比文件名可靠：粘贴上来的截图往往没有正经文件名。"""
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return ".webp"
    for magic, suffix in MAGIC:
        if blob.startswith(magic):
            return suffix
    suffix = Path(filename or "").suffix.lower()
    return suffix if suffix in (IMAGE_SUFFIXES | {".pdf"}) else ""


def parse_uploads(content_type: str, body: bytes) -> list:
    """取出所有上传的文件，返回 [(filename, bytes), ...]。

    支持四种调用方式，同一个端点：
        multipart 单/多文件   curl -F 'file=@a.png' -F 'file=@b.png'
        裸 body              curl --data-binary @a.png -H 'X-Filename: a.png'
        JSON + url           {"url": "..."} 或 {"urls": ["...", "..."]}
        JSON + base64        {"image_base64": "..."} 或 {"images_base64": [...]}
    """
    # 注意：ctype 必须保留原始大小写。multipart 的 boundary 是大小写敏感的，
    # 浏览器发的是 `boundary=----WebKitFormBoundaryAbC123` 这种含大写的值，
    # 整条 header 转小写后解析器就找不到起始边界了（StartBoundaryNotFoundDefect），
    # payload 不会变成 list，is_multipart() 返回 False —— 表现就是界面上传一律
    # 报「multipart 格式不正确」，而 curl 完全正常，因为它的 boundary 是纯小写
    # 十六进制。判类型用小写副本，解析用原值。
    ctype = (content_type or "").strip()
    kind = ctype.lower()

    if kind.startswith("application/json"):
        import base64 as _b64
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            raise HTTPException(400, "JSON 解析失败")
        if not isinstance(payload, dict):
            raise HTTPException(400, "JSON 体必须是对象")

        urls = payload.get("urls") or ([payload["url"]] if payload.get("url") else [])
        b64s = payload.get("images_base64") or (
            [payload["image_base64"]] if payload.get("image_base64") else [])
        if not urls and not b64s:
            raise HTTPException(400, "JSON 里要有 url/urls 或 image_base64/images_base64")

        out = []
        for u in urls:
            out.append(fetch_url(str(u)))
        for i, b in enumerate(b64s):
            raw = str(b)
            if "," in raw[:64] and raw[:5] == "data:":     # data:image/png;base64,xxx
                raw = raw.split(",", 1)[1]
            try:
                out.append(("b64_%d" % i, _b64.b64decode(raw, validate=False)))
            except Exception as e:
                raise HTTPException(400, "第 %d 个 base64 解码失败：%s" % (i + 1, e))
        return out

    if not kind.startswith("multipart/"):
        return [("", body)]

    header = b"Content-Type: " + ctype.encode("latin-1", "replace") + CRLF + CRLF
    try:
        msg = BytesParser().parsebytes(header + body)
    except Exception as e:
        raise HTTPException(400, "multipart 解析失败：%s" % e)
    if not msg.is_multipart():
        # 把 defect 名字带出去。光说「格式不正确」等于什么都没说，
        # 上一次查这个问题就是卡在这条消息上。
        why = "、".join(d.__class__.__name__ for d in msg.defects) or "未找到分段"
        raise HTTPException(400, "multipart 格式不正确（%s）；boundary=%r"
                                 % (why, msg.get_boundary()))

    files, fallback = [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        fname = part.get_filename() or ""
        if part.get_param("name", header="content-disposition") == "file" or fname:
            files.append((fname, payload))
        else:
            fallback.append((fname, payload))
    out = files or fallback
    if not out:
        raise HTTPException(400, "multipart 中没有找到文件")
    return out


# --------------------------------------------------------------- 结果缓存
class ResultCache:
    """按内容寻址的 LRU，只在内存里，不落盘。

    存的是识别结果，不是图片 —— 图片写完临时文件就删了。
    三重上限：条数 / 存活时间 / 总字节，任一超了就淘汰最久未用的。
    """

    def __init__(self, size: int, ttl: float = 900.0, max_bytes: int = 128 << 20):
        self.size = size
        self.ttl = ttl
        self.max_bytes = max_bytes
        self._d: "OrderedDict[str, tuple]" = OrderedDict()   # key -> (value, at, nbytes)
        self._bytes = 0
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0
        self.expired = 0

    @staticmethod
    def key(blob: bytes, engine: str, params: dict) -> str:
        h = hashlib.sha256(blob)
        # 参数会改变结果，必须进 key，否则调完参数拿到的还是旧结果
        h.update(json.dumps({"e": engine, "p": params}, sort_keys=True).encode())
        return h.hexdigest()

    def _evict(self):
        """在锁内调用。按 条数/字节 淘汰最久未用的。"""
        while self._d and (len(self._d) > self.size or self._bytes > self.max_bytes):
            _, (_, _, n) = self._d.popitem(last=False)
            self._bytes -= n

    def get(self, k: str):
        if self.size <= 0:
            return None
        with self._lock:
            item = self._d.get(k)
            if item is None:
                self.misses += 1
                return None
            v, at, n = item
            if self.ttl > 0 and time.time() - at > self.ttl:   # 过期即销毁
                del self._d[k]
                self._bytes -= n
                self.expired += 1
                self.misses += 1
                return None
            self._d.move_to_end(k)
            self.hits += 1
            return v

    def put(self, k: str, v: dict):
        if self.size <= 0:
            return
        try:
            n = len(json.dumps(v, ensure_ascii=False).encode())
        except Exception:
            n = 4096
        if n > self.max_bytes:        # 单条就超上限，不值得缓存
            return
        with self._lock:
            old = self._d.pop(k, None)
            if old is not None:
                self._bytes -= old[2]
            self._d[k] = (v, time.time(), n)
            self._bytes += n
            self._evict()

    def sweep(self):
        """定期清掉过期条目，别等到被读到才发现过期。"""
        if self.size <= 0 or self.ttl <= 0:
            return
        now = time.time()
        with self._lock:
            dead = [k for k, (_, at, _) in self._d.items() if now - at > self.ttl]
            for k in dead:
                self._bytes -= self._d.pop(k)[2]
            self.expired += len(dead)

    def snapshot(self) -> dict:
        total = self.hits + self.misses
        with self._lock:
            n, b = len(self._d), self._bytes
        return {"enabled": self.size > 0, "size": n, "capacity": self.size,
                "bytes": b, "max_bytes": self.max_bytes,
                "mb": round(b / 1048576, 2), "max_mb": round(self.max_bytes / 1048576, 1),
                "ttl_s": self.ttl, "expired": self.expired,
                "hits": self.hits, "misses": self.misses,
                "hit_rate": round(self.hits / total, 3) if total else None,
                "note": "只存识别结果，不存图片，不落盘"}


CACHE = ResultCache(CACHE_SIZE, CACHE_TTL, int(CACHE_MAX_MB * 1048576))


# --------------------------------------------------------------- 取图
FETCH_TIMEOUT = float(os.environ.get("OCR_FETCH_TIMEOUT", "20"))
FETCH_UA = os.environ.get("OCR_FETCH_UA", "knock-ocr/0.4")
# 只允许 http/https；默认不限域名，内网部署自己可控。要收紧就设白名单。
FETCH_ALLOW_HOSTS = [h.strip().lower() for h in
                     os.environ.get("OCR_FETCH_ALLOW_HOSTS", "").split(",") if h.strip()]


def fetch_url(u: str) -> tuple[str, bytes]:
    """服务端去抓图。爬虫已经有 URL 了，让它直接给 URL 比「下载完再上传」省一趟往返。"""
    import urllib.parse
    import urllib.request

    parsed = urllib.parse.urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(400, "url 只支持 http/https，收到 %r" % parsed.scheme)
    if FETCH_ALLOW_HOSTS:
        host = (parsed.hostname or "").lower()
        if not any(host == h or host.endswith("." + h) for h in FETCH_ALLOW_HOSTS):
            raise HTTPException(403, "域名 %s 不在 OCR_FETCH_ALLOW_HOSTS 白名单内" % host)

    req = urllib.request.Request(u, headers={"User-Agent": FETCH_UA})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
            # 边读边卡大小，别让一个超大文件把内存吃掉
            blob = r.read(MAX_MB * 1024 * 1024 + 1)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, "抓取失败 %s: %s: %s" % (u, type(e).__name__, e))
    if len(blob) > MAX_MB * 1024 * 1024:
        raise HTTPException(413, "远端文件超过 %dMB" % MAX_MB)
    if not blob:
        raise HTTPException(502, "抓到空内容：%s" % u)
    name = urllib.parse.unquote(Path(parsed.path).name) or "fetched"
    return name, blob


# --------------------------------------------------------------- 流水线池
class PipelinePool:
    """每个引擎一个池。实例不保证线程安全，用队列做独占借还。

    这也是后面换成多进程 / 多机 worker 时最自然的切分点。
    """

    def __init__(self, engine, size: int):
        self.engine = engine
        self.size = size
        self._q: "queue.Queue" = queue.Queue()
        self.ready = 0
        self.error: str | None = None
        self.rebuilding = False
        self._lock = threading.Lock()

    def warmup(self):
        print("[pool:%s] 开始构建 %d 条  %s" % (self.engine.name, self.size,
                                              self.engine.describe()), flush=True)
        for i in range(self.size):
            t0 = time.perf_counter()
            try:
                inst = self.engine.build()
                # 建完 session 还不算能用：GPU 上第一次推理要 JIT 编译 + cuDNN
                # 算法搜索，能花几十秒。不在这里付掉，就会砸到第一批真实请求头上。
                # 预热失败不影响可用性，照常入池，只是第一次请求会慢些。
                note = ""
                try:
                    note = self.engine.warm(inst) or ""
                except Exception as exc:
                    note = "预热失败(%s)，首次请求会慢" % type(exc).__name__
                self._q.put(inst)
                with self._lock:
                    self.ready += 1
                print("[pool:%s] %d/%d 就绪（%.1fs）%s"
                      % (self.engine.name, i + 1, self.size,
                         time.perf_counter() - t0,
                         ("  预热 " + note) if note else ""), flush=True)
            except Exception:
                self.error = traceback.format_exc(limit=6)
                print("[pool:%s] 第 %d 条构建失败:" % (self.engine.name, i + 1), flush=True)
                print(self.error, flush=True)
                return
        print("[pool:%s] 全部 %d 条就绪" % (self.engine.name, self.ready), flush=True)

    def rebuild_async(self, note: str = ""):
        """构造期参数改动后重建整池。新实例全建好再原子替换，期间不中断服务。"""
        if self.rebuilding:
            return False
        self.rebuilding = True

        def run():
            try:
                print("[pool:%s] 重建（%s）…" % (self.engine.name, note), flush=True)
                fresh = []
                for _ in range(self.size):
                    inst = self.engine.build()
                    # 和首次预热同理：新实例没热就换上去，等于把冷启动的账
                    # 转嫁给下一批请求。换之前先跑热。
                    try:
                        self.engine.warm(inst)
                    except Exception as exc:
                        print("[pool:%s] 重建预热失败(%s)，忽略"
                              % (self.engine.name, type(exc).__name__), flush=True)
                    fresh.append(inst)
                nq: "queue.Queue" = queue.Queue()
                for x in fresh:
                    nq.put(x)
                with self._lock:
                    self._q = nq          # 原子替换，老实例交给 GC
                    self.ready = len(fresh)
                    self.error = None
                print("[pool:%s] 重建完成" % self.engine.name, flush=True)
            except Exception:
                self.error = traceback.format_exc(limit=6)
                print("[pool:%s] 重建失败:" % self.engine.name, flush=True)
                print(self.error, flush=True)
            finally:
                self.rebuilding = False

        threading.Thread(target=run, daemon=True,
                         name="rebuild-" + self.engine.name).start()
        return True

    @contextmanager
    def acquire(self, timeout: float):
        try:
            item = self._q.get(timeout=timeout)
        except queue.Empty:
            raise HTTPException(503, "%s 引擎繁忙，%d 条流水线全占用中，请重试"
                                     % (self.engine.name, self.size))
        try:
            yield item
        finally:
            self._q.put(item)

    @property
    def idle(self) -> int:
        return self._q.qsize()

    def snapshot(self) -> dict:
        return {"ready": self.ready, "idle": self.idle, "size": self.size,
                "rebuilding": self.rebuilding, "error": self.error}


POOLS = {name: PipelinePool(eng, WORKERS.get(name, 4)) for name, eng in ENGINES.items()}


# --------------------------------------------------------------- 指标
class Metrics:
    def __init__(self):
        self._d: dict = {}
        self._lock = threading.Lock()

    def record(self, engine: str, ms: float, ok: bool):
        with self._lock:
            s = self._d.setdefault(engine, {"total": 0, "failed": 0, "lat": []})
            s["total"] += 1
            if not ok:
                s["failed"] += 1
            s["lat"].append(ms)
            if len(s["lat"]) > 2000:
                del s["lat"][:1000]

    def snapshot(self) -> dict:
        with self._lock:
            data = {k: (v["total"], v["failed"], sorted(v["lat"]))
                    for k, v in self._d.items()}
        out = {}
        for k, (total, failed, lat) in data.items():
            def pct(p):
                return round(lat[min(len(lat) - 1, int(len(lat) * p))], 1) if lat else None
            out[k] = {"total": total, "failed": failed,
                      "p50_ms": pct(0.50), "p95_ms": pct(0.95), "p99_ms": pct(0.99),
                      "mean_ms": round(statistics.fmean(lat), 1) if lat else None}
        return out

    def totals(self) -> dict:
        snap = self.snapshot()
        return {"total": sum(v["total"] for v in snap.values()),
                "failed": sum(v["failed"] for v in snap.values())}


METRICS = Metrics()


# --------------------------------------------------------------- 异步任务
def _overrides_for(eng, layout_threshold, max_pixels, max_new_tokens) -> dict:
    """逐请求参数；没传的回落到全局 TUNING，且只保留该引擎认识的键。"""
    cand = {
        "layout_threshold": layout_threshold if layout_threshold is not None
                            else TUNING.get("layout_threshold"),
        "max_pixels": max_pixels if max_pixels is not None else TUNING.get("max_pixels"),
        "max_new_tokens": max_new_tokens if max_new_tokens is not None
                          else TUNING.get("max_new_tokens"),
    }
    return {k: v for k, v in cand.items() if k in eng.per_request_keys}


class JobStore:
    """进程内任务队列。

    爬虫投递后立刻拿到 id，连接不占着；队列满了直接 429，是明确的背压信号
    而不是所有请求一起变慢。重启会丢未完成任务 —— 要持久化就把这里换成 Redis，
    对外接口形状不用变。
    """

    def __init__(self, capacity: int, workers: int, ttl: int):
        self.capacity = capacity
        self.workers = workers
        self.ttl = ttl
        self._q: "queue.Queue" = queue.Queue(maxsize=capacity)
        self._jobs: "OrderedDict[str, dict]" = OrderedDict()
        self._lock = threading.Lock()
        self._started = False

    @property
    def pending(self) -> int:
        return self._q.qsize()

    def start(self):
        if self._started:
            return
        self._started = True
        for i in range(self.workers):
            threading.Thread(target=self._loop, daemon=True,
                             name="job-worker-%d" % i).start()

    def submit(self, pool, filename, blob, merge_tables, overrides) -> dict:
        jid = uuid.uuid4().hex[:16]
        rec = {"id": jid, "state": "queued", "engine": pool.engine.name,
               "filename": filename, "bytes": len(blob),
               "submitted_at": time.time(), "result_body": None, "error": None}
        try:
            self._q.put_nowait((jid, pool, filename, blob, merge_tables, overrides))
        except queue.Full:
            raise HTTPException(
                429, "队列已满（%d）。这是背压信号：请退避后重试，或调大 OCR_JOB_QUEUE_MAX"
                     % self.capacity)
        with self._lock:
            self._jobs[jid] = rec
            self._sweep_locked()
        return {"id": jid, "state": "queued", "filename": filename}

    def _loop(self):
        while True:
            jid, pool, filename, blob, merge_tables, overrides = self._q.get()
            with self._lock:
                rec = self._jobs.get(jid)
                if rec:
                    rec["state"] = "running"
                    rec["started_at"] = time.time()
            try:
                body = _run_one(pool, filename, blob, merge_tables, overrides, True)
                with self._lock:
                    rec = self._jobs.get(jid)
                    if rec:
                        rec.update(state="done", result_body=body,
                                   finished_at=time.time(),
                                   elapsed_ms=body.get("elapsed_ms"),
                                   cached=body.get("cached"))
            except HTTPException as e:
                with self._lock:
                    rec = self._jobs.get(jid)
                    if rec:
                        rec.update(state="failed", error=e.detail,
                                   status=e.status_code, finished_at=time.time())
            except Exception as e:
                with self._lock:
                    rec = self._jobs.get(jid)
                    if rec:
                        rec.update(state="failed",
                                   error="%s: %s" % (type(e).__name__, e),
                                   finished_at=time.time())
            finally:
                self._q.task_done()

    def _sweep_locked(self):
        now = time.time()
        dead = [k for k, v in self._jobs.items()
                if v.get("finished_at") and now - v["finished_at"] > self.ttl]
        for k in dead:
            self._jobs.pop(k, None)
        while len(self._jobs) > self.capacity * 4:      # 兜底，别无限涨
            self._jobs.popitem(last=False)

    def get(self, jid: str):
        with self._lock:
            self._sweep_locked()
            return self._jobs.get(jid)

    def recent(self, limit: int) -> list:
        with self._lock:
            items = list(self._jobs.values())[-limit:]
        return [{k: v for k, v in j.items() if k != "result_body"} for j in items]


JOBS = JobStore(JOB_QUEUE_MAX, JOB_WORKERS, JOB_TTL)


# --------------------------------------------------------------- 应用
@asynccontextmanager
async def lifespan(_: FastAPI):
    for pool in POOLS.values():
        threading.Thread(target=pool.warmup, daemon=True,
                         name="warmup-" + pool.engine.name).start()

    stop = threading.Event()

    def sweeper():                     # 定期清过期缓存，别让内存一直占着
        while not stop.wait(60):
            CACHE.sweep()

    threading.Thread(target=sweeper, daemon=True, name="cache-sweeper").start()
    JOBS.start()
    try:
        yield
    finally:
        stop.set()


app = FastAPI(title="knock-ocr", version="0.3.0",
              docs_url="/api/docs", lifespan=lifespan)


# VLM 探活结果缓存。/api/info 被界面每几秒轮询一次，如果每次都同步 urlopen，
# vLLM 未就绪时会一直卡在超时上，把线程池占满 —— 表现就是界面「无法连接服务」。
_VL_PROBE = {"at": 0.0, "val": None}
_VL_PROBE_TTL = float(os.environ.get("OCR_VL_PROBE_TTL", "5"))
_VL_PROBE_TIMEOUT = float(os.environ.get("OCR_VL_PROBE_TIMEOUT", "2"))
_VL_PROBE_LOCK = threading.Lock()


def _vl_backend_status() -> dict:
    eng = ENGINES.get("quality")
    if eng is None:
        return {"required": False, "reachable": True,
                "note": "当前档位（%s）不含 VL 引擎" % TIER}

    now = time.time()
    cached = _VL_PROBE["val"]
    if cached is not None and now - _VL_PROBE["at"] < _VL_PROBE_TTL:
        return cached
    # 同一时刻只让一个请求真去探测，其余直接用上一次结果，避免探测风暴
    if not _VL_PROBE_LOCK.acquire(blocking=False):
        return cached or {"required": True, "reachable": False, "note": "探测中"}

    try:
        probe = eng.server_url.rstrip("/") + "/models"
        out = {"required": True, "url": eng.server_url, "probe": probe,
               "reachable": False, "models": []}
        try:
            import urllib.request

            with urllib.request.urlopen(probe, timeout=_VL_PROBE_TIMEOUT) as r:
                data = json.loads(r.read().decode())
                out["reachable"] = True
                out["models"] = [m.get("id") for m in data.get("data", [])]
        except Exception as e:
            out["error"] = str(e)
        _VL_PROBE["val"] = out
        _VL_PROBE["at"] = time.time()
        return out
    finally:
        _VL_PROBE_LOCK.release()


@app.get("/healthz")
def healthz():
    pools = {k: p.snapshot() for k, p in POOLS.items()}
    return {
        "ready": any(p["ready"] > 0 for p in pools.values()),
        "tier": TIER,
        "engines": sorted(ENGINES),
        "default_engine": DEFAULT_ENGINE,
        "pools": pools,
    }


@app.get("/api/info")
def info():
    pools = {k: p.snapshot() for k, p in POOLS.items()}
    q = POOLS.get("quality")
    return {
        "tier": TIER,
        "engines": {k: e.describe() for k, e in ENGINES.items()},
        "default_engine": DEFAULT_ENGINE,
        "pools": pools,
        "tuning": dict(TUNING),
        "vlm_backend": _vl_backend_status(),
        "rebuilding": bool(q and q.rebuilding),
        "metrics": METRICS.snapshot(),
        "totals": METRICS.totals(),
        "cache": CACHE.snapshot(),
        "jobs": {"pending": JOBS.pending, "workers": JOBS.workers,
                 "capacity": JOBS.capacity, "ttl_s": JOBS.ttl},
        # 流水线总数 = 进程数 × 每进程池子大小。pools 只反映当前这个进程，
        # 界面要展示的是整个服务的规模，所以在这里乘一次。
        "capacity": dict(CAPACITY, pipelines_total=(
            CAPACITY["uvicorn_workers"]
            * max((p.get("size") or 0) for p in pools.values()) if pools else 0)),
    }


@app.get("/api/metrics")
def metrics():
    return {"tier": TIER, "by_engine": METRICS.snapshot(),
            "cache": CACHE.snapshot(),
            "pools": {k: p.snapshot() for k, p in POOLS.items()}}


def _pick_pool(engine: str | None) -> PipelinePool:
    name = (engine or DEFAULT_ENGINE).strip().lower()
    if name in ("auto", ""):
        name = DEFAULT_ENGINE
    pool = POOLS.get(name)
    if pool is None:
        raise HTTPException(
            400, "本次部署（TIER=%s）没有 %r 引擎，可用：%s。"
                 "想同时具备请用 TIER=full 部署。" % (TIER, name, sorted(POOLS)))
    if pool.ready == 0:
        detail = "%s 引擎尚未就绪（0/%d）。" % (name, pool.size)
        detail += ("构建时报错了，看 `manage.sh logs api`。" if pool.error
                   else "仍在初始化，请稍候。")
        raise HTTPException(503, detail)
    return pool


def _run_one(pool: PipelinePool, filename: str, blob: bytes,
             merge_tables: bool, overrides: dict, include_json: bool,
             no_cache: bool = False) -> dict:
    """跑一个文件，返回响应体。同步接口和队列 worker 共用这一段。"""
    eng = pool.engine
    rid = uuid.uuid4().hex[:12]
    t0 = time.perf_counter()

    suffix = sniff_suffix(blob, filename)
    allowed = IMAGE_SUFFIXES | ({".pdf"} if eng.supports_pdf else set())
    if suffix not in allowed:
        raise HTTPException(415, "%s 引擎不支持该文件类型（%r）。支持：%s"
                                 % (eng.name, filename, sorted(allowed)))

    ckey = ResultCache.key(blob, eng.name, {**overrides, "mt": merge_tables})
    hit = None if no_cache else CACHE.get(ckey)
    if hit is not None:
        METRICS.record(eng.name, (time.perf_counter() - t0) * 1000, True)
        body = dict(hit)
        body.update(request_id=rid, cached=True, filename=filename,
                    elapsed_ms=round((time.perf_counter() - t0) * 1000, 1))
        if not include_json:
            body.pop("result", None)
        return body

    timings, ok, tmp = {"receive_ms": 0.0}, False, None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as fh:
            fh.write(blob)
            tmp = fh.name
        q0 = time.perf_counter()
        with pool.acquire(ACQUIRE_TIMEOUT) as handle:
            q1 = time.perf_counter()
            md, pages_json, npages = eng.run(handle, tmp, merge_tables, overrides)
            timings["queue_ms"] = round((q1 - q0) * 1000, 1)
            timings["infer_ms"] = round((time.perf_counter() - q1) * 1000, 1)
        ok = True
        timings["total_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        body = {"request_id": rid, "engine": eng.name, "filename": filename,
                "bytes": len(blob), "pages": npages,
                "elapsed_ms": timings["total_ms"], "timings": timings,
                "applied": {k: v for k, v in overrides.items() if v is not None},
                "markdown": md, "cached": False, "result": pages_json}
        if not no_cache:
            CACHE.put(ckey, body)
        return body if include_json else {k: v for k, v in body.items() if k != "result"}
    except HTTPException:
        raise
    except Exception as e:
        print("[%s] 识别失败:" % rid, flush=True)
        print(traceback.format_exc(limit=6), flush=True)
        raise HTTPException(500, "识别失败 (request_id=%s): %s: %s"
                                 % (rid, type(e).__name__, e))
    finally:
        METRICS.record(eng.name, (time.perf_counter() - t0) * 1000, ok)
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


@app.post("/api/ocr")
async def ocr(
    request: Request,
    engine: str | None = Query(None, description="fast=快 | quality=准；不传用默认"),
    merge_tables: bool = Query(True, description="多页 PDF 是否合并跨页表格"),
    include_json: bool = Query(True, description="是否返回结构化结果"),
    no_cache: bool = Query(False, description="跳过缓存，用来测真实推理耗时"),
    layout_threshold: float | None = Query(None, ge=0.05, le=0.95),
    max_pixels: int | None = Query(None, ge=100000, le=20000000),
    max_new_tokens: int | None = Query(None, ge=64, le=8192),
):
    """同步识别。四种传参方式见 parse_uploads。

    传多个文件/URL 时返回 {"count": n, "items": [...]}；单个时直接返回该结果，
    保持和旧调用方的兼容。
    """
    pool = _pick_pool(engine)
    eng = pool.engine

    raw = await request.body()
    if not raw:
        raise HTTPException(400, "空请求体")
    if len(raw) > MAX_MB * 1024 * 1024:
        raise HTTPException(413, "请求超过 %dMB" % MAX_MB)

    ctype = request.headers.get("content-type", "")
    items = await run_in_threadpool(parse_uploads, ctype, raw)   # url 抓取会阻塞，扔线程池
    items = [(n or request.headers.get("x-filename", "") or "upload", b) for n, b in items]
    if not items:
        raise HTTPException(400, "没有取到任何文件")
    if len(items) > MAX_BATCH:
        raise HTTPException(413, "一次最多 %d 个，收到 %d 个" % (MAX_BATCH, len(items)))

    overrides = _overrides_for(eng, layout_threshold, max_pixels, max_new_tokens)

    def work():
        out = []
        for name, blob in items:
            try:
                out.append(_run_one(pool, name, blob, merge_tables, overrides,
                                    include_json, no_cache))
            except HTTPException as e:
                # 批量里单个失败不该让整批 400 —— 标注出来，其余照常返回
                out.append({"filename": name, "error": e.detail, "status": e.status_code})
        return out

    results = await run_in_threadpool(work)
    if len(results) == 1:
        r = results[0]
        if "error" in r:
            raise HTTPException(r.get("status", 500), r["error"])
        return JSONResponse(r)
    return JSONResponse({"count": len(results), "engine": eng.name, "items": results})


@app.post("/api/ocr/async")
async def ocr_async(
    request: Request,
    engine: str | None = Query(None),
    merge_tables: bool = Query(True),
    layout_threshold: float | None = Query(None, ge=0.05, le=0.95),
    max_pixels: int | None = Query(None, ge=100000, le=20000000),
    max_new_tokens: int | None = Query(None, ge=64, le=8192),
):
    """投递到队列，立刻返回 job id。爬虫用这个：连接不占着、超载有明确背压。"""
    pool = _pick_pool(engine)
    raw = await request.body()
    if not raw:
        raise HTTPException(400, "空请求体")
    if len(raw) > MAX_MB * 1024 * 1024:
        raise HTTPException(413, "请求超过 %dMB" % MAX_MB)

    ctype = request.headers.get("content-type", "")
    items = await run_in_threadpool(parse_uploads, ctype, raw)
    items = [(n or "upload", b) for n, b in items]
    if len(items) > MAX_BATCH:
        raise HTTPException(413, "一次最多 %d 个" % MAX_BATCH)

    overrides = _overrides_for(pool.engine, layout_threshold, max_pixels, max_new_tokens)
    jobs = [JOBS.submit(pool, n, b, merge_tables, overrides) for n, b in items]
    return JSONResponse({"count": len(jobs), "engine": pool.engine.name,
                         "jobs": jobs, "queued": JOBS.pending,
                         "poll": "/api/jobs/{id}"}, status_code=202)


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str, include_json: bool = Query(True)):
    j = JOBS.get(job_id)
    if j is None:
        raise HTTPException(404, "没有这个任务（可能已过期，结果保留 %ds）" % JOB_TTL)
    out = {k: v for k, v in j.items() if k != "result_body"}
    if j["state"] == "done":
        body = j["result_body"] or {}
        out["result"] = body if include_json else {
            k: v for k, v in body.items() if k != "result"}
    return out


@app.get("/api/jobs")
def job_list(limit: int = Query(50, ge=1, le=500)):
    return {"pending": JOBS.pending, "workers": JOBS.workers,
            "capacity": JOBS.capacity, "recent": JOBS.recent(limit)}


@app.post("/api/config")
async def set_config(request: Request):
    """在线调参。

    per-request 三项只改默认值，立即生效；
    vl_rec_max_concurrency 是构造期参数，改了后台重建 quality 池，期间不中断服务。
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "请求体必须是 JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "请求体必须是 JSON 对象")

    limits = {
        "vl_rec_max_concurrency": (1, 64, int),
        "max_pixels": (100000, 20000000, int),
        "max_new_tokens": (64, 8192, int),
        "layout_threshold": (0.05, 0.95, float),
    }
    changed, needs_rebuild = {}, False
    for k, v in body.items():
        if k not in limits:
            raise HTTPException(400, "未知参数 %s，可选：%s" % (k, sorted(limits)))
        lo, hi, cast = limits[k]
        if v in (None, "", 0):
            val = None                      # 显式清空 = 恢复不限制
        else:
            try:
                val = cast(v)
            except (TypeError, ValueError):
                raise HTTPException(400, "%s 不是合法数值：%r" % (k, v))
            if not (lo <= val <= hi):
                raise HTTPException(400, "%s 超出范围 [%s, %s]" % (k, lo, hi))
        if TUNING.get(k) != val:
            TUNING[k] = val
            changed[k] = val
            if k == "vl_rec_max_concurrency":
                needs_rebuild = True

    q = POOLS.get("quality")
    started = False
    if needs_rebuild and q:
        started = q.rebuild_async("并发数改为 %s" % TUNING["vl_rec_max_concurrency"])
    if started:
        note = "并发数已改，正在后台重建流水线；重建期间沿用旧实例，不中断服务。"
    elif needs_rebuild and not q:
        note = "当前档位没有 quality 引擎，该参数已记录但暂不生效。"
    elif needs_rebuild:
        note = "上一次重建还没结束，稍后再试。"
    else:
        note = "已生效，下一次识别即采用新参数。"
    return {"changed": changed, "tuning": dict(TUNING),
            "rebuilding": bool(q and q.rebuilding), "note": note}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
