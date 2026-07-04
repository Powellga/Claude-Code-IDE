"""
Test: does each spawn method inherit admin privileges?
Uses a script file to avoid all quoting issues.
"""
import ctypes
import os
import sys
import time

print(f"Parent process admin: {bool(ctypes.windll.shell32.IsUserAnAdmin())}")
print()

CHILD_SCRIPT = os.path.join(os.path.dirname(__file__), "test_child.py")

# Test 1: subprocess (baseline)
print("=== Test 1: subprocess.Popen ===")
import subprocess
result = subprocess.run(
    [sys.executable, CHILD_SCRIPT],
    capture_output=True, text=True, timeout=10
)
print(f"  Result: {result.stdout.strip()}")
print()

# Test 2: ConPtyProcess
print("=== Test 2: ConPtyProcess ===")
try:
    from conpty_process import ConPtyProcess
    proc = ConPtyProcess.spawn([sys.executable, CHILD_SCRIPT])
    print(f"  PID={proc.pid}, alive={proc.isalive()}")

    output = ""
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            data = proc.read(4096)
            if data:
                output += data
            else:
                if not proc.isalive():
                    break
                time.sleep(0.1)
        except EOFError:
            break

    proc.close()
    import re
    clean = re.sub(r'\x1b\[[^a-zA-Z]*[a-zA-Z]', '', output)
    for line in clean.splitlines():
        stripped = line.strip()
        if stripped.startswith("ADMIN:"):
            print(f"  Result: {stripped}")
            break
    else:
        print(f"  No ADMIN line. Clean output: {repr(clean.strip()[:300])}")
        print(f"  Raw output: {repr(output[:300])}")

except Exception as e:
    import traceback
    print(f"  FAILED: {e}")
    traceback.print_exc()
print()

# Test 3: pywinpty
print("=== Test 3: pywinpty PtyProcess ===")
try:
    from winpty import PtyProcess
    proc = PtyProcess.spawn([sys.executable, CHILD_SCRIPT])

    output = ""
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            data = proc.read(4096)
            if data:
                output += data
        except EOFError:
            break
        except Exception:
            time.sleep(0.1)
    proc.close()

    import re
    clean = re.sub(r'\x1b\[[^a-zA-Z]*[a-zA-Z]', '', output)
    for line in clean.splitlines():
        stripped = line.strip()
        if stripped.startswith("ADMIN:"):
            print(f"  Result: {stripped}")
            break
    else:
        print(f"  No ADMIN line. Clean output: {repr(clean.strip()[:300])}")
        print(f"  Raw output: {repr(output[:300])}")

except Exception as e:
    print(f"  FAILED: {e}")

print()
print("Done.")
