"""Bake the HanLP model into the image, and prove it landed where it is read.

Run once at build time. The seed directory it produces is what the runtime
initContainer copies into the model volume, so "the model loaded" is not the
property worth asserting -- "the model files are in the seed directory" is.

Those differ in practice. `hanlp.load` resolves a model through its own resource
cache, and the directory that cache lives in is not always the one HANLP_HOME
names for a given HanLP version. A build that only asserted successful inference
therefore produced an image with an empty seed directory and a zero-byte
manifest, and the failure surfaced minutes later as an initContainer exiting 1.
So this asks HanLP where the files actually are and copies them in.

Kept in its own file, copied above the prefetch layer, so that editing the
server never invalidates a multi-gigabyte download.
"""
import os
import shutil
import sys
from pathlib import Path

import hanlp

SEED_DIR = Path(os.environ.get("HANLP_SEED_DIR", "/opt/hanlp-model-seed"))
WARMUP_TEXT = "吴恩达与人工智能"


def resolved_cache_root():
    """Where HanLP actually keeps downloaded resources, across versions."""
    for locate in (
        lambda: __import__("hanlp.utils.io_util", fromlist=["hanlp_home"]).hanlp_home(),
        lambda: __import__("hanlp_common.constant", fromlist=["HANLP_HOME"]).HANLP_HOME,
    ):
        try:
            root = Path(locate())
        except Exception:  # noqa: BLE001 - probing optional module layouts
            continue
        if root.is_dir():
            return root
    return None


def main():
    model_name = os.environ["HANLP_MODEL"]
    tokenizer = hanlp.load(getattr(hanlp.pretrained.tok, model_name))
    tokens = tokenizer([WARMUP_TEXT])
    if not (
        isinstance(tokens, list)
        and any(
            isinstance(sentence, list)
            and any(isinstance(token, str) and token.strip() for token in sentence)
            for sentence in tokens
        )
    ):
        sys.exit("HanLP tokenizer inference returned no tokens")

    SEED_DIR.mkdir(parents=True, exist_ok=True)
    if not any(path.is_file() for path in SEED_DIR.rglob("*")):
        cache_root = resolved_cache_root()
        if cache_root is None or cache_root == SEED_DIR:
            sys.exit(f"cannot locate the HanLP resource cache to seed {SEED_DIR}")
        print(f"[prefetch] copying resource cache {cache_root} -> {SEED_DIR}")
        shutil.copytree(cache_root, SEED_DIR, dirs_exist_ok=True)

    files = [path for path in SEED_DIR.rglob("*") if path.is_file()]
    if not files:
        sys.exit(f"model prefetch left {SEED_DIR} empty")
    total = sum(path.stat().st_size for path in files)
    print(f"[prefetch] seeded {len(files)} file(s), {total / 1048576:.1f} MiB")


if __name__ == "__main__":
    main()
