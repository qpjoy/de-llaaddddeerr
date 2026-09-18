"""OCR 引擎抽象 —— 同一份 API 后面挂两种引擎。

  fast     RapidOCR + PP-OCRv6(ONNX)。纯文字提取，几百 ms 一张，镜像 <1GB。
           走 ONNXRuntime/OpenVINO，不经过 PaddlePaddle，因此没有 sm_120 问题。
           爬虫级批量入口用它。
  quality  PaddleOCR-VL-1.6 + vLLM。版面/表格/公式，OmniDocBench 96.3%，
           但逐块自回归生成，单页数十秒。少量高价值文档用它。

部署档（TIER）决定装哪些：
  fast     只装 fast，镜像 <1GB，不需要 GPU，也不拉 20~30GB 官方镜像
  quality  只装 quality
  full     两个都装，调用方用 ?engine=fast|quality 自选

调用方看到的响应形状完全一致，engine 字段标明本次用了哪个。
"""
from __future__ import annotations

import os
import tempfile
import time
import traceback
from pathlib import Path

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}


class OcrEngine:
    name = "base"
    label = ""
    supports_pdf = False
    # 构造期参数变了要重建实例；per-request 参数每次 predict 传
    per_request_keys: tuple = ()

    def build(self):
        raise NotImplementedError

    def run(self, handle, path: str, merge_tables: bool, overrides: dict | None = None):
        """统一返回 (markdown, pages_json, npages)。"""
        raise NotImplementedError

    def warm(self, handle) -> str:
        """在池子就绪前真的跑一次推理，把一次性开销从首批真实请求里挪走。

        构造 session 和「能跑」是两回事：GPU 上建 session 很快，真正贵的是
        第一次推理时的 PTX JIT 编译和 cuDNN 卷积算法搜索。不预热的话这笔账
        全砸在第一批请求头上 —— 实测能让 P95 冲到 73 秒，而热起来之后只要 281ms。
        默认空实现；子类按自己的输入形状覆盖。
        """
        return ""

    def describe(self) -> dict:
        return {"engine": self.name, "label": self.label, "supports_pdf": self.supports_pdf}


# --------------------------------------------------------------- 快速版
class FastEngine(OcrEngine):
    name = "fast"
    label = "RapidOCR / PP-OCRv6 (ONNX)"
    supports_pdf = False

    def __init__(self):
        # intra_op_num_threads 默认 0 = ONNX 自己决定 = 用「它看到的所有核」。
        # 容器里它看到的是宿主机核数（128），而 cgroup 配额可能只有 32 ——
        # 128 个线程抢 32 核的配额，全耗在上下文切换上，实测能慢几十倍。
        # 所以必须显式限制成和 CPU 配额匹配。
        self.intra = int(os.environ.get("OCR_ORT_INTRA_THREADS")
                         or os.environ.get("OMP_NUM_THREADS") or 4)
        self.inter = int(os.environ.get("OCR_ORT_INTER_THREADS") or 1)
        # ONNX Runtime 的 CUDA EP。fast-gpu 档默认就开，其余档默认关。
        # 注意 ONNX Runtime 在 kernel 架构不匹配时会「静默回落 CPU」而不报错，
        # 所以这里只记「请求了什么」，「实际跑在什么上」由 build() 事后回填。
        _tier = os.environ.get("OCR_TIER", "").strip().lower()
        _cuda = os.environ.get("OCR_FAST_CUDA", "").strip().lower()
        if _cuda:
            self.use_cuda = _cuda in ("1", "true", "yes")
        else:
            self.use_cuda = _tier == "fast-gpu"
        self.applied: dict = {}

    def build(self):
        # 新版 rapidocr 默认就是 PP-OCRv6 的 det/rec small；
        # 老包 rapidocr_onnxruntime 作为兜底（模型是 v4/v5 系列）。
        try:
            from rapidocr import RapidOCR
            new_pkg = True
        except ImportError:
            from rapidocr_onnxruntime import RapidOCR
            new_pkg = False

        if not new_pkg:
            self.applied = {"note": "经典包不支持线程配置，用 OMP_NUM_THREADS 兜底"}
            return RapidOCR()

        params = {
            "EngineConfig.onnxruntime.intra_op_num_threads": self.intra,
            "EngineConfig.onnxruntime.inter_op_num_threads": self.inter,
        }
        if self.use_cuda:
            params["EngineConfig.onnxruntime.use_cuda"] = True

        # 参数名按 rapidocr 版本可能有出入：被拒就逐个丢掉重试，不让服务起不来
        while True:
            try:
                eng = RapidOCR(params=params)
                self.applied = dict(params)
                self.applied["providers"] = _ort_providers(eng)
                return eng
            except TypeError:
                self.applied = {"note": "本版本 RapidOCR 不接受 params，退回默认配置"}
                return RapidOCR()
            except Exception as e:
                bad = next((k for k in params if k.split(".")[-1] in str(e)), None)
                if not bad:
                    raise
                params.pop(bad)
                print("[engine] RapidOCR 不支持 " + bad + "，已忽略", flush=True)

    def run(self, handle, path: str, merge_tables: bool, overrides: dict | None = None):
        if Path(path).suffix.lower() == ".pdf":
            raise RuntimeError("fast 引擎只处理图片；PDF 请用 ?engine=quality")

        items = _rapid_items(handle(path))

        # 按行归并：y 相近算同一行，行内按 x 排
        rows: list[list] = []
        for it in sorted(items, key=lambda i: i["cy"]):
            if rows and abs(it["cy"] - rows[-1][0]["cy"]) <= it["h"] * 0.6:
                rows[-1].append(it)
            else:
                rows.append([it])

        lines = [" ".join(x["text"] for x in sorted(r, key=lambda i: i["cx"])) for r in rows]
        md = "\n\n".join(l for l in lines if l.strip())
        page = {
            "engine": self.name,
            "lines": [{"text": it["text"], "score": it["score"], "box": it["box"]}
                      for it in items],
        }
        return md, [page], 1

    def warm(self, handle) -> str:
        """跑两种尺寸的合成图，把 JIT 和 cuDNN 算法搜索的账在就绪前付掉。

        必须让检测真的框出文字 —— 否则识别分支根本不执行，rec 那两个 session
        还是冷的，第一批真实请求照样要等。所以用大号字体画几行，
        画不出中文就退回 PIL 默认位图字体（英文数字够触发检测了）。
        """
        from PIL import Image, ImageDraw, ImageFont
        font = None
        for fp in ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
                   "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc"):
            try:
                font = ImageFont.truetype(fp, 30)
                break
            except Exception:
                continue

        notes = []
        # 检测分支按整图尺寸取整到 32 的倍数，识别分支按每行文字宽度变长；
        # cuDNN 的算法选择是按 shape 缓存的，形状没见过就要重搜一轮。
        # 两种尺寸 + 长短不一的行，覆盖住最常见的那几个 shape。
        for w, h in ((640, 360), (960, 540)):
            img = Image.new("RGB", (w, h), "white")
            d = ImageDraw.Draw(img)
            for i, s in enumerate(("warmup 12345", "预热 ABCDEFG 67890",
                                   "knock-ocr 一二三四五六七八九十")):
                d.text((24, 40 + i * 70), s, fill="black", font=font)
            path = ""
            try:
                with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                    path = f.name
                img.save(path)
                t0 = time.perf_counter()
                handle(path)
                notes.append("%dx%d %.0fms" % (w, h, (time.perf_counter() - t0) * 1000))
            finally:
                if path:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
        return "  ".join(notes)

    def describe(self) -> dict:
        # device 报「实际」而不是「请求」—— 老版本这里直接回显环境变量，
        # ONNX Runtime 静默回落 CPU 时界面照样显示 cuda，把人骗得很惨。
        provs = self.applied.get("providers") or {}
        on_cuda = any("CUDAExecutionProvider" in v for v in provs.values())
        return {**super().describe(), "runtime": "onnxruntime",
                "device": "cuda" if on_cuda else "cpu",
                "device_requested": "cuda" if self.use_cuda else "cpu",
                "providers": provs,
                "intra_op_num_threads": self.intra,
                "inter_op_num_threads": self.inter,
                "applied": self.applied}


def _seq(v):
    """安全转 list —— rapidocr 3.x 返回 numpy 数组，直接 `or []` 会触发
    「truth value of an array is ambiguous」，所以只判 None 不判真值。"""
    return [] if v is None else list(v)


def _ort_providers(eng) -> dict:
    """挖出 det/rec/cls 三个子模型真实使用的 ExecutionProvider。

    这是判断 GPU 到底有没有生效的唯一可信依据：环境变量只说明「请求了什么」，
    而 ONNX Runtime 在 kernel 架构不匹配时会悄悄把 CUDA EP 换成 CPU，不报错、
    不影响启动，只是慢。rapidocr 各版本把 session 藏的位置不一样，逐个试；
    全都取不到就返回空 dict，让 describe() 保守地报 cpu。
    """
    out: dict = {}
    for attr in ("text_det", "text_rec", "text_cls"):
        obj = getattr(eng, attr, None)
        if obj is None:
            continue
        for chain in ("session.session", "session", "_session", "model.session"):
            cur = obj
            for part in chain.split("."):
                cur = getattr(cur, part, None)
                if cur is None:
                    break
            if cur is not None and hasattr(cur, "get_providers"):
                try:
                    out[attr] = list(cur.get_providers())
                except Exception:
                    pass
                break
    return out


def _rapid_items(out) -> list[dict]:
    """统一 RapidOCR 各版本返回值 -> [{text, score, box, cx, cy, h}]。"""
    raw = []
    txts = getattr(out, "txts", None)
    if txts is not None:                                        # 新版对象
        boxes = _seq(getattr(out, "boxes", None))
        scores = _seq(getattr(out, "scores", None))
        for i, t in enumerate(_seq(txts)):
            raw.append((boxes[i] if i < len(boxes) else None, t,
                        scores[i] if i < len(scores) else None))
    else:                                                       # 老版 (result, elapse)
        res = out[0] if isinstance(out, tuple) else out
        for row in _seq(res):
            raw.append((row[0] if len(row) > 0 else None,
                        row[1] if len(row) > 1 else "",
                        row[2] if len(row) > 2 else None))

    items = []
    for box, text, score in raw:
        if not text:
            continue
        xs, ys = [], []
        try:
            for pt in _seq(box):
                xs.append(float(pt[0]))
                ys.append(float(pt[1]))
        except (TypeError, IndexError, ValueError):
            xs, ys = [], []
        items.append({
            "text": str(text),
            "score": round(float(score), 4) if score is not None else None,
            "box": [[float(p[0]), float(p[1])] for p in _seq(box)] or None,
            "cx": sum(xs) / len(xs) if xs else 0.0,
            "cy": sum(ys) / len(ys) if ys else 0.0,
            "h": max((max(ys) - min(ys)) if ys else 1.0, 1.0),
        })
    return items


# --------------------------------------------------------------- 最优版
class VLEngine(OcrEngine):
    name = "quality"
    label = "PaddleOCR-VL-1.6 + vLLM"
    supports_pdf = True
    per_request_keys = ("layout_threshold", "max_pixels", "max_new_tokens")

    def __init__(self, *, backend: str, server_url: str, model: str,
                 device: str, tuning: dict):
        self.backend = backend
        self.server_url = server_url
        self.model = model
        self.device = device
        self.tuning = tuning              # 与 server.py 共享同一个 dict，在线可改
        self._bad_predict_keys: set = set()

    def build(self):
        from paddleocr import PaddleOCRVL

        base = {
            "vl_rec_backend": self.backend,
            "vl_rec_server_url": self.server_url,
            "vl_rec_api_model_name": self.model,
        }
        if self.device:
            base["device"] = self.device

        # 性能参数按镜像版本可能不被接受：被拒就逐个丢掉重试，
        # 保证换版本时不会因为一个未知参数把服务起不来。
        extra = {k: v for k, v in self.tuning.items() if v}
        while True:
            try:
                return PaddleOCRVL(**base, **extra)
            except TypeError as e:
                dropped = next((k for k in extra if k in str(e)), None)
                if not dropped:
                    raise
                extra.pop(dropped)
                print("[engine] 本版本不支持构造参数 " + dropped + "，已忽略", flush=True)

    def _predict(self, handle, path: str, overrides: dict | None):
        kw = {k: v for k, v in (overrides or {}).items()
              if v is not None and k not in self._bad_predict_keys}
        while True:
            try:
                return list(handle.predict(path, **kw))
            except TypeError as e:
                bad = next((k for k in kw if k in str(e)), None)
                if not bad:
                    raise
                self._bad_predict_keys.add(bad)
                kw.pop(bad)
                print("[engine] predict 不支持参数 " + bad + "，已忽略", flush=True)

    def run(self, handle, path: str, merge_tables: bool, overrides: dict | None = None):
        pages = self._predict(handle, path, overrides)

        if len(pages) > 1 and hasattr(handle, "restructure_pages"):
            try:
                merged = handle.restructure_pages(pages, merge_tables=merge_tables)
                md = _vl_markdown(merged)
                if md:
                    return md, [_vl_json(p) for p in pages], len(pages)
            except Exception:
                print("[engine] restructure_pages 失败，回落逐页拼接:", flush=True)
                print(traceback.format_exc(limit=3), flush=True)

        md = "\n\n---\n\n".join(filter(None, (_vl_markdown(p) for p in pages)))
        return md, [_vl_json(p) for p in pages], len(pages)

    def describe(self) -> dict:
        return {**super().describe(), "backend": self.backend, "model": self.model,
                "server_url": self.server_url, "layout_device": self.device,
                "unsupported_predict_keys": sorted(self._bad_predict_keys)}


def _vl_markdown(res) -> str:
    """PaddleOCR 各版本 markdown 返回形状不一致，按优先级兜底取。"""
    m = getattr(res, "markdown", None)
    if isinstance(m, str):
        return m
    if isinstance(m, dict):
        for key in ("markdown_texts", "markdown_text", "text", "md"):
            v = m.get(key)
            if isinstance(v, str) and v.strip():
                return v
        parts = [v for v in m.values() if isinstance(v, str)]
        if parts:
            return "\n\n".join(parts)
    return ""


def _vl_json(res) -> dict:
    j = getattr(res, "json", None)
    if callable(j):
        try:
            j = j()
        except Exception:
            j = None
    return j.get("res", j) if isinstance(j, dict) else {}


# --------------------------------------------------------------- 工厂
def normalize_v1(url: str) -> str:
    url = (url or "").rstrip("/")
    return url if url.endswith("/v1") else url + "/v1"


def build_engines(tuning: dict) -> dict:
    """按 OCR_TIER 决定装哪些引擎，返回 {name: engine}。

    fast 和 fast-gpu 装的是同一个引擎，只是推理运行时不同（onnxruntime /
    onnxruntime-gpu），所以引擎名对外都叫 fast —— 调用方的 ?engine=fast 不用改。
    """
    tier = os.environ.get("OCR_TIER", "quality").strip().lower()
    if tier not in ("fast", "fast-gpu", "quality", "full"):
        raise ValueError(
            "OCR_TIER 只能是 fast | fast-gpu | quality | full，收到 %r" % tier)

    engines: dict = {}
    if tier in ("fast", "fast-gpu", "full"):
        engines["fast"] = FastEngine()
    if tier in ("quality", "full"):
        engines["quality"] = VLEngine(
            backend=os.environ.get("OCR_VL_BACKEND", "vllm-server"),
            server_url=normalize_v1(os.environ.get("OCR_VLLM_URL",
                                                   "http://127.0.0.1:8118")),
            model=os.environ.get("OCR_MODEL", "PaddleOCR-VL-1.6-0.9B"),
            device=os.environ.get("OCR_DEVICE", "cpu"),
            tuning=tuning,
        )
    return engines


def default_engine_name(engines: dict) -> str:
    """full 档下默认走哪个 —— 默认 fast，让大流量走快通道。"""
    want = os.environ.get("OCR_DEFAULT_ENGINE", "").strip().lower()
    if want in engines:
        return want
    return "fast" if "fast" in engines else next(iter(engines))
