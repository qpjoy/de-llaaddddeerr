"""Read-only HanLP memory report, run inside the HanLP container:

    kubectl -n mx-common exec -i deploy/mx-common-hanlp -c hanlp -- python - < scripts/hanlp-memory.py

This cluster has no metrics-server, so `kubectl top` is unavailable. The
container's cgroup is the number the OOM killer uses; per-process RSS shows how
it splits across the front and the workers. Worker RSS overlaps (shared
libraries), so the cgroup's process memory, not the sum, is the real total.
Prints only sizes, PIDs and roles -- never request text.
"""

import glob
import json
import urllib.request

CG, PROC = "/sys/fs/cgroup", "/proc"


def read(path):
    try:
        with open(path) as handle:
            return handle.read().strip()
    except OSError:
        return None


def gib(value):
    return f"{int(value) / 2**30:.2f} GiB" if value and str(value).isdigit() else "n/a"


# cgroup v2 first, then v1.
now = read(f"{CG}/memory.current") or read(f"{CG}/memory/memory.usage_in_bytes")
peak = read(f"{CG}/memory.peak") or read(f"{CG}/memory/memory.max_usage_in_bytes")
limit = read(f"{CG}/memory.max") or read(f"{CG}/memory/memory.limit_in_bytes")
stat = dict(
    line.split()
    for line in (read(f"{CG}/memory.stat") or read(f"{CG}/memory/memory.stat") or "").splitlines()
)
print(f"container: now {gib(now)}, peak {gib(peak)}, limit {gib(limit)}")
print(
    f"  process memory (anon/rss) {gib(stat.get('anon', stat.get('total_rss')))}, "
    f"page cache {gib(stat.get('file', stat.get('total_cache')))}"
)
for status in sorted(glob.glob(f"{PROC}/[0-9]*/status"), key=lambda path: int(path.split("/")[-2])):
    pid = status.split("/")[-2]
    fields = dict(line.split(":", 1) for line in (read(status) or "").splitlines() if ":" in line)
    command = (read(f"{PROC}/{pid}/cmdline") or "").replace("\0", " ")
    role = (
        "worker" if "multiprocessing.spawn" in command
        else "resource tracker" if "resource_tracker" in command
        else "http front" if "server.py" in command
        else command[:40]
    )
    if "VmRSS" in fields:
        print(
            f"  pid {pid:>6}  rss {fields['VmRSS'].strip():>12}  "
            f"peak {fields.get('VmHWM', '').strip():>12}  {role}"
        )
health = json.loads(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3).read())
print("pool:", health.get("pool", health))
