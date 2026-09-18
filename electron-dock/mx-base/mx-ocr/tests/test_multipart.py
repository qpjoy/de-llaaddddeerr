"""parse_uploads 的回归测试 —— 重点是 boundary 大小写。

为什么单独写这个：curl 生成的 boundary 是纯小写十六进制，而浏览器发的是
`----WebKitFormBoundaryAbC123` 这种含大写的。服务端一度把整条 Content-Type
转小写再喂给 email 解析器，boundary 的大小写被抹掉 -> 找不到起始分段 ->
界面上传一律报「multipart 格式不正确」，而所有 curl 压测和自检全绿。
这类 bug 只能靠自己拼 body 才测得到。

跑法（不需要装 fastapi，桩件在下面）：
    python tests/test_multipart.py
"""
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))


# ---- 桩件：只为了能 import server，不跑真服务 ----
class HTTPException(Exception):
    def __init__(self, status_code, detail=""):
        super().__init__("%s %s" % (status_code, detail))
        self.status_code, self.detail = status_code, detail


def _stub_modules():
    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = lambda **kw: types.SimpleNamespace(
        get=lambda *a, **k: (lambda f: f), post=lambda *a, **k: (lambda f: f))
    fastapi.HTTPException = HTTPException
    fastapi.Query = lambda default=None, **kw: default
    fastapi.Request = object
    responses = types.ModuleType("fastapi.responses")
    responses.FileResponse = responses.JSONResponse = object
    fastapi.responses = responses
    starlette = types.ModuleType("starlette")
    conc = types.ModuleType("starlette.concurrency")

    async def _rit(fn, *a, **k):
        return fn(*a, **k)

    conc.run_in_threadpool = _rit
    starlette.concurrency = conc
    for name, mod in [("fastapi", fastapi), ("fastapi.responses", responses),
                      ("starlette", starlette), ("starlette.concurrency", conc)]:
        sys.modules.setdefault(name, mod)


_stub_modules()
import server  # noqa: E402

CRLF = b"\r\n"


def build_body(boundary: str, filename: str = "4ocr.jpg") -> bytes:
    b = boundary.encode()
    return (b"--" + b + CRLF
            + b'Content-Disposition: form-data; name="file"; filename="'
            + filename.encode() + b'"' + CRLF
            + b"Content-Type: image/jpeg" + CRLF + CRLF
            + b"\xff\xd8\xff\xe0JFIF-fake-payload" + CRLF
            + b"--" + b + b"--" + CRLF)


CASES = [
    # 名称,                    boundary
    ("Chrome / WebKit",        "----WebKitFormBoundaryAbC123XyZ"),
    ("Firefox",                "---------------------------9BwyA8cQr3"),
    ("curl（纯小写十六进制）",  "------------------------1a2b3c4d5e6f"),
    ("含大写 + 引号包裹",       "MiXeDCaseBoundary42"),
]


def main() -> int:
    bad = 0
    for name, bnd in CASES:
        body = build_body(bnd)
        ct = 'multipart/form-data; boundary="%s"' % bnd if " " in bnd \
            else "multipart/form-data; boundary=" + bnd
        try:
            out = server.parse_uploads(ct, body)
            okay = len(out) == 1 and out[0][0] == "4ocr.jpg" and out[0][1].startswith(b"\xff\xd8\xff")
        except HTTPException as e:
            out, okay = e.detail, False
        print("%-24s %s  %s" % (name, "PASS" if okay else "FAIL",
                                "" if okay else out))
        bad += 0 if okay else 1

    # 顺带守住另外两条分支，别改 multipart 时把它们碰坏
    raw = server.parse_uploads("application/octet-stream", b"\x89PNG\r\n")
    assert raw == [("", b"\x89PNG\r\n")], raw
    print("%-24s PASS" % "裸 body")

    js = server.parse_uploads("application/json",
                              b'{"images_base64":["aGVsbG8="]}')
    assert js == [("b64_0", b"hello")], js
    print("%-24s PASS" % "JSON + base64")

    # 大小写不敏感的那一半：Content-Type 的类型名本身可以是大写
    up = server.parse_uploads("MULTIPART/FORM-DATA; boundary=----WebKitFormBoundaryZz",
                              build_body("----WebKitFormBoundaryZz"))
    assert len(up) == 1, up
    print("%-24s PASS" % "大写 MULTIPART/")

    print("\n%s" % ("全部通过" if not bad else "%d 项失败" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
