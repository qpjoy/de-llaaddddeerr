"""Pinterest (source 94): standalone Python/CLI collection entry."""
from __future__ import annotations
import argparse
import asyncio
import contextlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SOURCE_ID = 94

def _collect(target: str, work: Path) -> dict[str, Any]:
    import itertools
    from gallery_dl import config, extractor
    config.set(('extractor',), 'timeout', 20)
    config.set(('extractor',), 'retries', 0)
    selected = extractor.find(target)
    if selected is None:
        raise ValueError('Pinterest URL is not recognized')
    messages = list(itertools.islice(selected, 5))
    media = [m for m in messages if int(m[0]) == 3 and len(m) > 2 and isinstance(m[2], dict)]
    if not media:
        raise ValueError('No Pinterest media metadata returned')
    return {'status': 'success', 'capabilities_verified': ['pin_metadata', 'media_url'], 'data': {'messages': messages}, 'limits': ['board enumeration and full account profile not verified']}

def _worker(target: str, work: Path) -> dict[str, Any]:
    record = {"id": SOURCE_ID, "target": target,
              "observed_at": datetime.now(timezone.utc).isoformat(), "live_data_verified": False}
    try:
        if SOURCE_ID != 95 and (urlsplit(target).scheme not in ("http", "https") or not urlsplit(target).netloc):
            raise ValueError("target must be a complete public HTTP(S) URL")
        work.mkdir(parents=True, exist_ok=True)
        # The SDK default is bounded only inside this isolated worker process.
        try:
            import requests
            original = requests.sessions.Session.request
            def bounded_request(self: Any, *args: Any, **kwargs: Any) -> Any:
                kwargs.setdefault("timeout", 20)
                return original(self, *args, **kwargs)
            requests.sessions.Session.request = bounded_request
        except ImportError:
            pass
        with contextlib.redirect_stdout(sys.stderr):
            result = _collect(target, work)
        record.update(result)
        record["live_data_verified"] = result["status"] == "success"
    except Exception as exc:
        record.update(status="failed", error_type=type(exc).__name__, error=str(exc))
    return json.loads(json.dumps(record, ensure_ascii=False, default=str))

def collect(target: str, *, work_dir: str | Path = "data", timeout: float = 110) -> dict[str, Any]:
    """Collect this source in an isolated process and return a JSON-compatible result.

    target: public URL (source 95 currently performs compatibility diagnosis only).
    work_dir: caller-owned runtime directory. timeout: overall seconds, greater than zero.
    No media download is performed. Check status and capabilities_verified before use.
    """
    if timeout <= 0:
        raise ValueError("timeout must be greater than zero")
    work = Path(work_dir).resolve()
    command = [sys.executable, "-X", "utf8", str(Path(__file__).resolve()),
               "--worker", "--target", target, "--work-dir", str(work)]
    try:
        process = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                 errors="replace", timeout=timeout, check=False)
        if process.returncode:
            raise RuntimeError(process.stderr[-4000:] or f"Worker returned {process.returncode}")
        result = json.loads(process.stdout)
        if process.stderr.strip():
            result["diagnostics"] = process.stderr[-4000:]
        return result
    except subprocess.TimeoutExpired:
        return {"id": SOURCE_ID, "target": target, "status": "failed", "live_data_verified": False,
                "observed_at": datetime.now(timezone.utc).isoformat(), "error_type": "TimeoutError",
                "error": f"Overall collection exceeded {timeout} seconds"}

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="", help="Public source URL")
    parser.add_argument("--work-dir", type=Path, default=Path("data"))
    parser.add_argument("--timeout", type=float, default=110, help="Overall timeout in seconds")
    parser.add_argument("--output", type=Path, help="Optional JSON result file")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    result = _worker(args.target, args.work_dir) if args.worker else collect(args.target, work_dir=args.work_dir, timeout=args.timeout)
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output and not args.worker:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
