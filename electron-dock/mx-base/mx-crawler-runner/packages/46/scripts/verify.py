"""Run offline tests using the installed standalone project."""
from pathlib import Path
import subprocess, sys
base=Path(__file__).resolve().parents[1]
result=subprocess.run([sys.executable,'-m','unittest','discover','-s',str(base/'tests'),'-v'],cwd=base)
if result.returncode:raise RuntimeError('Offline tests failed')
