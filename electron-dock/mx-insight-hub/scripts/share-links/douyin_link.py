# -*- coding: utf-8 -*-
"""
抖音分享链接解析器 — 分享文本/短链 → 作品ID(aweme_id)
=====================================================
原理: v.douyin.com 短链是服务端 302 跳转, Location 里直接带
      https://www.iesdouyin.com/share/{video|note|slides}/<aweme_id>/?...
      纯服务端行为(与UA无关), 不需要手机/App/登录。
      作品ID(aweme_id) 就是第三方接口取作品数据的参数, 例如 TikHub:
        GET https://api.tikhub.io/api/v1/douyin/web/fetch_one_video?aweme_id=<作品ID>
      没有链接的纯口令解不出作品ID, 脚本改为输出接口要的 share_code 参数:
        GET https://api.tikhub.io/api/v1/douyin/app/v3/fetch_share_info_by_share_code?share_code=<口令>

用法:
  python douyin_link.py "<整段分享文本或链接>"        # 每个链接输出: 链接 + 作品ID
  python douyin_link.py "<纯口令文本>"                # 没有链接时输出接口用的 share_code 请求地址
  python douyin_link.py "<文本>" --json               # 机器可读(列表, 含类型/作者UID/跳转链)
  python douyin_link.py "<文本>" --chain              # 额外打印逐跳302原文
  python douyin_link.py "<链接>" --ua mobile          # 换UA: pc(默认)|mobile|android
  python douyin_link.py "<链接>" --noproxy            # 忽略系统代理
  python douyin_link.py "<链接>" --timeout 30         # 单个请求超时秒数, 默认15
  一段文本里有多个链接时全部解析, 按出现顺序输出。
  详细说明见同目录的 分享链接解析使用说明.md

  # Python API:
  from douyin_link import resolve, resolve_all
  rs = resolve_all("... https://v.douyin.com/aaa/ ... https://v.douyin.com/bbb/")  # 全部链接 → 列表
  r = resolve("标题... https://v.douyin.com/PUSMTYbFSNA/ 复制此链接...")           # 第一个链接
  r["link"], r["aweme_id"], r["type"]
"""
import sys, re, json, html, argparse, http.client
from urllib.parse import urlsplit, urljoin, parse_qs, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from urllib.error import HTTPError

UAS = {
    "pc": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "mobile": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "android": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
}
NUM_ID = r"\d{15,25}"
# 分享文本里链接前后紧贴中文/标点, 所以只认ASCII字符
URL_ANY = re.compile(
    r"(?:https?://)?(?:www\.)?(?:v\.douyin\.com|iesdouyin\.com|douyin\.com)/[A-Za-z0-9_\-./?=&%~+;]+",
    re.I)
# 短链跳转目标 /share/{video|note|slides}/<id>/, 网页版 /video/<id> /note/<id>
ITEM_PATH = re.compile(
    r"douyin\.com/(?:share/)?(?P<kind>video|note|slides)/(?P<id>" + NUM_ID + ")", re.I)
USER_PATH = re.compile(r"douyin\.com/(?:share/)?user/([A-Za-z0-9_\-]{20,})", re.I)
OTHER_PATH = re.compile(r"douyin\.com/(?:share/)?(?P<kind>music|live|challenge)/", re.I)
WORK_KINDS = ("video", "note", "slides")
KIND_CN = {"video": "视频", "note": "图文", "slides": "图集", "user": "用户主页",
           "music": "音乐", "live": "直播", "challenge": "话题"}
REDIRECT_CODES = (301, 302, 303, 307, 308)
HOME = "https://www.douyin.com"
# 没有链接的纯口令解不出作品ID(口令里的码是编码过的), 只能交给接口解析
SHARE_CODE_HINT = re.compile(r"抖音|douyin", re.I)
TIKHUB_SHARE_CODE = "https://api.tikhub.io/api/v1/douyin/app/v3/fetch_share_info_by_share_code"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # 不自动跟随, 由resolve逐跳控制


def _find_urls(text):
    """正则摘出文本里全部链接(按出现顺序去重), 没写协议头的补 https://"""
    urls = []
    for m in URL_ANY.finditer(text):
        # 只剥句末标点; 参数值末尾的 = 是base64补位, 不能剥
        url = m.group(0).rstrip(".,;:!?)]}'\"")
        if "://" not in url:
            url = "https://" + url
        if url not in urls:
            urls.append(url)
    return urls


def _query(url):
    """URL query → dict(取首个值); 旧式分享链接用 ; 分隔参数"""
    if not url:
        return {}
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query.replace(";", "&")).items()}


def _identify(url):
    """识别URL指向什么 → (kind, id) 或 None; 作品=video/note/slides, 其余都不是作品"""
    m = ITEM_PATH.search(url)
    if m:
        return m.group("kind").lower(), m.group("id")
    m = USER_PATH.search(url)
    if m:
        return "user", m.group(1)
    m = OTHER_PATH.search(url)
    if m:
        return m.group("kind").lower(), ""
    return None


def _scan_body(body):
    """落地页源码里找作品(不跳转的中间页/JS跳转页)"""
    text = html.unescape(body.decode("utf-8", errors="replace")).replace("\\/", "/")
    return _identify(text)


def _fetch(url, ua, timeout, noproxy):
    handlers = [_NoRedirect()] + ([ProxyHandler({})] if noproxy else [])
    opener = build_opener(*handlers)
    req = Request(url, headers={
        "User-Agent": UAS[ua],
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    try:
        resp = opener.open(req, timeout=timeout)
        return resp.status, resp.headers.get("Location"), resp.read(2_000_000)
    except HTTPError as e:  # 3xx也算: _NoRedirect把它变成了异常
        return e.code, (e.headers.get("Location") if e.headers else None), b""


def _resolve_url(start, ua="pc", timeout=15, max_hops=10, noproxy=False):
    """单个链接 → {"ok", "link", "aweme_id", "type", "author_uid", ...}; 失败时 ok=False + error"""
    def fail(error, chain, **extra):
        return {"ok": False, "link": start, "error": error, "chain": chain, **extra}

    url, chain, how = start, [], "direct"
    hit = _identify(url)
    while not hit and len(chain) < max_hops:
        try:
            status, location, body = _fetch(url, ua, timeout, noproxy)
        except (OSError, http.client.HTTPException, ValueError) as e:
            return fail(f"请求失败: {url} ({e})", chain)
        chain.append({"url": url, "status": status, "location": location})
        if status in REDIRECT_CODES and location:
            url, how = urljoin(url, location), "redirect"
            hit = _identify(url)
            if not hit and url.rstrip("/") == HOME:
                return fail("短链无效或已失效(跳回首页)", chain)
        else:
            hit, how = _scan_body(body), "body-scan"
            break
    if not hit:
        return fail("跟完跳转也没找到作品ID", chain)
    kind, _id = hit
    if kind not in WORK_KINDS:
        return fail(f"这是{KIND_CN.get(kind, kind)}链接, 不是作品", chain, type=kind,
                    **({"sec_uid": _id} if kind == "user" else {}))
    # 跳转目标自带的 activity_info 里有作者UID(直接给的完整链接没有)
    author_uid = None
    try:
        author_uid = json.loads(_query(url).get("activity_info") or "{}").get("social_author_id")
    except ValueError:
        pass
    return {
        "ok": True, "type": kind, "link": start, "aweme_id": _id,
        "author_uid": author_uid, "url": url, "how": how,
        "uncertain": how == "body-scan",
        "chain": chain,
    }


def _share_code(text):
    """纯口令 → 接口要的 share_code 参数(整段口令原文做URL编码); 口令里解不出作品ID"""
    code = text.strip()
    encoded = quote(code, safe="")
    return {"ok": False, "type": "share_code", "link": None,
            "error": "文本里没有链接, 是分享口令; 口令解不出作品ID, 要交给接口解析",
            "share_code": code, "share_code_encoded": encoded,
            "url": f"{TIKHUB_SHARE_CODE}?share_code={encoded}", "chain": []}


def resolve_all(text, **kw):
    """文本里所有链接逐个解析 → 结果列表(按出现顺序); 没有链接但像口令 → 一条口令结果; 否则 []"""
    urls = _find_urls(text)
    if not urls:
        return [_share_code(text)] if SHARE_CODE_HINT.search(text) else []
    return [_resolve_url(u, **kw) for u in urls]


def resolve(text, **kw):
    """文本里第一个链接 → 结果dict; 没有链接时 ok=False + error"""
    rs = resolve_all(text, **kw)
    return rs[0] if rs else {"ok": False, "link": None, "error": "文本里没找到抖音链接", "chain": []}


def _print(results, chain=False):
    if not results:
        print("失败: 文本里没找到抖音链接")
        return
    multi = len(results) > 1
    if multi:
        print(f"共 {len(results)} 个链接")
    for i, r in enumerate(results):
        p = f"[{i + 1}] " if multi else ""
        if i:
            print()
        if chain:
            for j, h in enumerate(r["chain"]):
                print(f"{p}{j + 1}. {h['url']}")
                print(f"{p}   [{h['status']}] -> {h['location'] or '(无跳转, 落地页)'}")
        if r.get("type") == "share_code":
            print(f"{p}分享口令(没有链接), 解不出作品ID, 交给接口解析:")
            print(f"{p}  GET {r['url']}")
            continue
        print(f"{p}{r['link']}")
        if not r["ok"]:
            print(f"{p}  失败: {r['error']}")
        else:
            print(f"{p}  作品ID: {r['aweme_id']}  ({KIND_CN[r['type']]})")
            if r.get("uncertain"):
                print(f"{p}  注意: ID来自落地页扫描, 不保证正确")


def main():
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows管道默认GBK
    ap = argparse.ArgumentParser(description="抖音分享链接 → 作品ID(aweme_id)")
    ap.add_argument("text", help="整段分享文本或链接, 可含多个链接")
    ap.add_argument("--json", action="store_true", help="机器可读输出(列表)")
    ap.add_argument("--chain", action="store_true", help="额外打印逐跳302原文")
    ap.add_argument("--ua", choices=UAS, default="pc", help="浏览器UA, 默认pc")
    ap.add_argument("--noproxy", action="store_true", help="忽略系统代理")
    ap.add_argument("--timeout", type=int, default=15, help="单个请求超时秒数, 默认15")
    a = ap.parse_args()

    results = resolve_all(a.text, ua=a.ua, timeout=a.timeout, noproxy=a.noproxy)
    if a.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        _print(results, chain=a.chain)
    return 0 if results and all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
