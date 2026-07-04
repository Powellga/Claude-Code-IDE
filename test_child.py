import ctypes
import sys
import time

print("ADMIN:", bool(ctypes.windll.shell32.IsUserAnAdmin()))
sys.stdout.flush()
time.sleep(3)
