# -*- coding: utf-8 -*-
"""
小红书分享链接解析器 — 分享文本/短链 → 笔记ID
=============================================
原理: xhslink 短链是服务端 302 跳转, Location 里直接带
      https://www.xiaohongshu.com/discovery/item/<note_id>?...&xsec_token=...
      纯服务端行为(与UA无关), 不需要手机/App/登录。
      未登录时笔记页会再 302 到 /login, 所以只跟到"出现ID的那一跳"就停。

用法:
  python xhs_link.py "<整段分享文本或链接>"        # 每个链接输出: 链接 + 笔记ID
  python xhs_link.py "<文本>" --json               # 机器可读(列表, 含xsec_token/跳转链)
  python xhs_link.py "<文本>" --chain              # 额外打印逐跳302原文
  python xhs_link.py "<链接>" --ua mobile          # 换UA: pc(默认)|mobile|android
  python xhs_link.py "<链接>" --noproxy            # 忽略系统代理
  python xhs_link.py "<链接>" --timeout 30         # 单个请求超时秒数, 默认15
  一段文本里有多个链接时全部解析, 按出现顺序输出。
  详细说明见同目录的 分享链接解析使用说明.md

  # Python API:
  from xhs_link import resolve, resolve_all
  rs = resolve_all("... https://xhslink.cn/o/aaa ... https://xhslink.cn/o/bbb ...")  # 全部链接 → 列表
  r = resolve("标题... https://xhslink.cn/o/3E3SprcTUEs 复制本条信息...")            # 第一个链接
  r["link"], r["note_id"], r["xsec_token"]
"""
import sys, re, json, html, argparse, http.client
from urllib.parse import urlsplit, urljoin, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from urllib.error import HTTPError

UAS = {
    "pc": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "mobile": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "android": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
}
HEX24 = r"[0-9a-f]{24}"
# 分享文本里链接前后紧贴中文/标点, 所以只认ASCII字符, 末尾标点再剥掉
URL_ANY = re.compile(
    r"(?:https?://)?(?:www\.)?(?:xhslink\.(?:com|cn)|xiaohongshu\.com)/[A-Za-z0-9/_\-~.?=&%+;]+",
    re.I)
NOTE_PATH = re.compile(r"xiaohongshu\.com/(?:discovery/item|explore)/(" + HEX24 + ")", re.I)
USER_PATH = re.compile(r"xiaohongshu\.com/user/profile/(" + HEX24 + ")", re.I)
SCHEME_ITEM = re.compile(r"xhsdiscover://item/(" + HEX24 + ")", re.I)
# 裸24位hex: 前后不能再接hex, 避免截到32位md5的一段
ANY_HEX24 = re.compile(r"(?<![0-9a-fA-F])" + HEX24 + r"(?![0-9a-fA-F])")
REDIRECT_CODES = (301, 302, 303, 307, 308)
HOME = "https://www.xiaohongshu.com"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # 不自动跟随, 由resolve逐跳控制


def _find_urls(text):
    """正则摘出文本里全部链接(按出现顺序去重), 没写协议头的补 https://"""
    urls = []
    for m in URL_ANY.finditer(text):
        # 只剥句末标点; xsec_token 末尾的 = 是base64补位, 不能剥
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
    """识别URL指向什么 → (kind, id, 带ID的那个URL) 或 None"""
    for pat, kind in ((NOTE_PATH, "note"), (USER_PATH, "user"), (SCHEME_ITEM, "note")):
        m = pat.search(url)
        if m:
            return kind, m.group(1), url
    # 经过登录跳转时, ID藏在 redirectPath 参数里
    nested = _query(url).get("redirectPath")
    if nested:
        hit = _identify(html.unescape(nested))
        if hit:
            return hit
    return None


def _scan_body(body):
    """落地页源码里找ID: 优先明确路径, 否则唯一的24位hex候选"""
    text = html.unescape(body.decode("utf-8", errors="replace")).replace("\\/", "/")
    for pat, kind in ((NOTE_PATH, "note"), (USER_PATH, "user"), (SCHEME_ITEM, "note")):
        m = pat.search(text)
        if m:
            return kind, m.group(1), m.group(0)
    cands = list(dict.fromkeys(ANY_HEX24.findall(text)))
    if len(cands) == 1:
        return "note", cands[0], None
    return None


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
    """单个链接 → {"ok", "link", "note_id", "xsec_token", "url", ...}; 失败时 ok=False + error"""
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
        return fail("跟完跳转也没找到笔记ID", chain)
    kind, _id, matched = hit
    if kind == "user":
        return fail(f"这是用户主页链接, 不是笔记 (用户ID: {_id})", chain, type="user", user_id=_id)
    q = _query(matched)
    return {
        "ok": True, "type": "note", "link": start, "note_id": _id,
        "xsec_token": q.get("xsec_token"), "url": matched,
        "track_code": q.get("track_code"), "how": how,
        "uncertain": how == "body-scan",
        "chain": chain,
    }


def resolve_all(text, **kw):
    """文本里所有链接逐个解析 → 结果列表(按出现顺序); 一个链接都没有返回 []"""
    return [_resolve_url(u, **kw) for u in _find_urls(text)]


def resolve(text, **kw):
    """文本里第一个链接 → 结果dict; 没有链接时 ok=False + error"""
    urls = _find_urls(text)
    if not urls:
        return {"ok": False, "link": None, "error": "文本里没找到小红书链接", "chain": []}
    return _resolve_url(urls[0], **kw)


def _print(results, chain=False):
    if not results:
        print("失败: 文本里没找到小红书链接")
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
        print(f"{p}{r['link']}")
        if not r["ok"]:
            print(f"{p}  失败: {r['error']}")
        else:
            print(f"{p}  笔记ID: {r['note_id']}")
            if r.get("uncertain"):
                print(f"{p}  注意: ID来自落地页裸hex扫描, 不保证是笔记")


def main():
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows管道默认GBK
    ap = argparse.ArgumentParser(description="小红书分享链接 → 笔记ID")
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
