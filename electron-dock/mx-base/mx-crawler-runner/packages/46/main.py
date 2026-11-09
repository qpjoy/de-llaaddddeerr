"""Standalone JSON entry; log messages belong to stderr."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))
from audiosource_46.client import invoke, invoke_async, cli
if __name__ == '__main__':
    raise SystemExit(cli())
