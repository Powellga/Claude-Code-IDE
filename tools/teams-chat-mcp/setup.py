"""One-time environment setup for teams-chat-mcp: venv + dependencies.
Run with system python:  python setup.py
"""
import subprocess
import sys
import venv
from pathlib import Path

HERE = Path(__file__).parent
VENV = HERE / ".venv"
PY = VENV / "Scripts" / "python.exe"

if not PY.exists():
    print("Creating venv...")
    venv.EnvBuilder(with_pip=True).create(VENV)
print("Installing msal, mcp, requests...")
subprocess.check_call([str(PY), "-m", "pip", "install", "--quiet", "msal", "mcp<2", "requests", "tzdata"])
subprocess.check_call([str(PY), "-c",
                       "import msal, requests, mcp.server.fastmcp; print('deps OK')"])
subprocess.check_call([str(PY), "-c",
                       "import ast; ast.parse(open(r'%s', encoding='utf-8').read()); print('server.py syntax OK')" % (HERE / 'server.py')])
print("\nSetup complete. Now sign in with:")
print(f'  "{PY}" "{HERE / "login.py"}"')
