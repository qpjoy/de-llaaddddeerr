"""Snapshot mounted FastAPI contracts without starting the upstream application."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import date

root = Path(sys.argv[1]).resolve()
sys.dont_write_bytecode = True
os.environ["PLATFORM_DATABASE_URL"] = "sqlite:///:memory:"
os.environ.pop("PLATFORM_FRONTEND_DIR", None)
sys.path.insert(0, str(root / "backend"))
from app.main import app  # noqa: E402; imports contracts, does not execute lifespan

snapshot = {
    "source": "Night-All-A 本地 FastAPI app.openapi()；未核对线上部署",
    "reviewedAt": date.today().isoformat(),
    "sourceCommit": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
    "sourceHashes": {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted((root / "backend/app").glob("*.py"))},
    "openapi": app.openapi(),
    "guides": [{"key": p.stem, "text": p.read_text()} for p in sorted((root / "backend/app/public_docs").glob("*.md"))],
}
target = Path(__file__).resolve().parents[1] / "server/external-platforms/night-all-a-catalog.json"
target.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
print(f"Wrote {len(snapshot['openapi']['paths'])} paths to {target}")
