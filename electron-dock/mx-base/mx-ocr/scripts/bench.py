#!/usr/bin/env python3
"""knock-ocr 并发压测（只用标准库，宿主机不需要装任何东西）

    python3 scripts/bench.py --url http://127.0.0.1:8710/api/ocr \
        --file sample.png --concurrency 8 --requests 40

默认每个请求都是「新图」（在图片尾部追加几个字节，OCR 结果不变但 sha256 不同），
这样测到的才是真实 OCR 吞吐。否则同一张图会被内容寻址缓存命中，
第二个请求起就是几毫秒 —— 那测的是缓存，不是识别。

  --mode unique  每请求一张新图（默认）—— 测 OCR 真实吞吐
  --mode cached  全部同一张图        —— 测缓存路径能扛多少
  --mode nocache 同一张图但服务端跳过缓存 —— 测纯推理，排除缓存干扰

输出 QPS / P50 / P95 / P99 与错误分布，用来确定 worker 数与并发配比。
"""
import argparse
import json
import mimetypes
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def build_body(name, data):
    boundary = "----knockocr" + uuid.uuid4().hex
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    head = (
        "--%s\r\n"
        'Content-Disposition: form-data; name="file"; filename="%s"\r\n'
        "Content-Type: %s\r\n\r\n" % (boundary, name, ctype)
    ).encode()
    tail = ("\r\n--%s--\r\n" % boundary).encode()
    return head + data + tail, "multipart/form-data; boundary=" + boundary


def fetch_json(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--file", default=".deploy/sample.png",
                    help="压测用的图片；默认用 manage.sh test 生成的样张")
    ap.add_argument("--concurrency", "-c", type=int, default=8)
    ap.add_argument("--requests", "-n", type=int, default=40)
    ap.add_argument("--timeout", type=float, default=600)
    ap.add_argument("--mode", choices=("unique", "cached", "nocache"), default="unique",
                    help="unique=每请求新图(默认) / cached=同一张图 / nocache=服务端跳过缓存")
    a = ap.parse_args()

    path = Path(a.file)
    if not path.exists():
        sys.stderr.write("找不到 %s\n先跑一次：bash scripts/manage.sh test\n" % path)
        return 2
    base = path.read_bytes()

    url = a.url + ("&" if "?" in a.url else "?") + "include_json=false"
    if a.mode == "nocache":
        url += "&no_cache=true"

    metrics_url = a.url.split("/api/")[0] + "/api/metrics"
    before = fetch_json(metrics_url)

    lat = []
    errs = {}
    cached_n = [0]
    lock = threading.Lock()
    counter = iter(range(a.requests))

    def payload_for(i):
        if a.mode == "unique":
            # PNG/JPEG 解码器会忽略文件尾部多余字节：图不变、结果不变，
            # 但 sha256 变了 -> 必定 cache miss，测到的是真实识别耗时。
            return base + ("\n#knock-ocr-bench-%d-%s" % (i, uuid.uuid4().hex)).encode()
        return base

    def worker():
        while True:
            try:
                i = next(counter)
            except StopIteration:
                return
            body, ctype = build_body(path.name, payload_for(i))
            t0 = time.perf_counter()
            try:
                req = urllib.request.Request(url, data=body,
                                             headers={"Content-Type": ctype})
                with urllib.request.urlopen(req, timeout=a.timeout) as r:
                    raw = r.read()
                ms = (time.perf_counter() - t0) * 1000
                with lock:
                    lat.append(ms)
                    try:
                        if json.loads(raw.decode()).get("cached"):
                            cached_n[0] += 1
                    except Exception:
                        pass
            except urllib.error.HTTPError as e:
                with lock:
                    k = "HTTP %d" % e.code
                    errs[k] = errs.get(k, 0) + 1
            except Exception as e:
                with lock:
                    k = type(e).__name__
                    errs[k] = errs.get(k, 0) + 1

    mode_desc = {"unique": "每请求一张新图（测真实 OCR 吞吐）",
                 "cached": "同一张图（测缓存路径）",
                 "nocache": "同一张图 + 服务端跳过缓存（测纯推理）"}[a.mode]
    print("目标 %s" % url)
    print("样本 %s  (%.0f KB)" % (path, path.stat().st_size / 1024))
    print("模式 %s" % mode_desc)
    print("并发 %d  总请求 %d\n" % (a.concurrency, a.requests))

    t0 = time.perf_counter()
    threads = [threading.Thread(target=worker, daemon=True)
               for _ in range(a.concurrency)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - t0

    ok = len(lat)
    print("耗时      %.2fs" % wall)
    print("成功/总数 %d/%d" % (ok, a.requests))
    if ok:
        s = sorted(lat)

        def pct(p):
            return s[min(len(s) - 1, int(len(s) * p))]

        print("吞吐      %.2f req/s" % (ok / wall))
        print("延迟      P50 %.0fms  P95 %.0fms  P99 %.0fms  mean %.0fms"
              % (pct(.5), pct(.95), pct(.99), statistics.fmean(s)))
        print("          min %.0fms  max %.0fms" % (s[0], s[-1]))
    if cached_n[0]:
        print("缓存命中  %d/%d  <- 这些没走推理，会把数字拉好看" % (cached_n[0], ok))
    if errs:
        print("错误      " + "  ".join("%s×%d" % (k, v) for k, v in sorted(errs.items())))

    after = fetch_json(metrics_url)
    if before and after:
        try:
            c0, c1 = before.get("cache", {}), after.get("cache", {})
            print("\n服务端缓存 hits %s -> %s   misses %s -> %s"
                  % (c0.get("hits"), c1.get("hits"), c0.get("misses"), c1.get("misses")))
        except Exception:
            pass

    print("\n提示：并发从 1 往上扫（1/2/4/8/16），QPS 不再涨的那个点就是当前配置的上限。")
    print("      默认 --mode unique 每请求都是新图，不会被缓存命中蒙蔽。")
    print("      想看缓存能扛多少：--mode cached；想看纯推理：--mode nocache。")
    return 0 if ok == a.requests else 1


if __name__ == "__main__":
    sys.exit(main())
