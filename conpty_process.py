"""
ConPTY Process - Direct Windows Pseudo Console via ctypes
=========================================================
EXPERIMENTAL - NOT CURRENTLY USED BY app.py.

Drop-in replacement for pywinpty's PtyProcess that uses the
Windows ConPTY API directly, so child processes inherit the
parent's security token (admin privileges) without relying on
pywinpty's native extension.

Status (2026-07-04): kept as a fallback in case a future pywinpty
update breaks admin inheritance. Testing with test_admin_inherit.py
showed the problem this was built for does not occur in the current
setup (admin inherits fine through pywinpty and plain subprocess),
so app.py continues to use pywinpty.

Known issue before wiring this into app.py: read() is a blocking
ReadFile with no timeout, and ConPTY does NOT break the output pipe
when the child exits - the pipe stays open until ClosePseudoConsole
is called. With app.py's reader loop this means a naturally-exiting
session would hang the reader thread and never emit terminal_exit.
A fix needs either a watchdog that calls close() when the process
dies, or non-blocking reads via PeekNamedPipe (prototype already
declared below, unused).
"""

import ctypes
import ctypes.wintypes as wintypes
import os
import subprocess
import sys
from shutil import which

if sys.platform != "win32":
    raise ImportError("conpty_process is Windows-only")

# ─── Windows API Setup ─────────────────────────────────────────────────────

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# Constants
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
STILL_ACTIVE = 259
S_OK = 0

HPCON = ctypes.c_void_p
SIZE_T = ctypes.c_size_t


class COORD(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class STARTUPINFOEX(ctypes.Structure):
    _fields_ = [
        ("StartupInfo", STARTUPINFOW),
        ("lpAttributeList", ctypes.c_void_p),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", wintypes.BOOL),
    ]


# ─── Function Prototypes ──────────────────────────────────────────────────

kernel32.CreatePipe.argtypes = [
    ctypes.POINTER(wintypes.HANDLE),
    ctypes.POINTER(wintypes.HANDLE),
    ctypes.POINTER(SECURITY_ATTRIBUTES),
    wintypes.DWORD,
]
kernel32.CreatePipe.restype = wintypes.BOOL

kernel32.CreatePseudoConsole.argtypes = [
    COORD, wintypes.HANDLE, wintypes.HANDLE,
    wintypes.DWORD, ctypes.POINTER(HPCON),
]
kernel32.CreatePseudoConsole.restype = ctypes.HRESULT

kernel32.ResizePseudoConsole.argtypes = [HPCON, COORD]
kernel32.ResizePseudoConsole.restype = ctypes.HRESULT

kernel32.ClosePseudoConsole.argtypes = [HPCON]
kernel32.ClosePseudoConsole.restype = None

kernel32.InitializeProcThreadAttributeList.argtypes = [
    ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
    ctypes.POINTER(SIZE_T),
]
kernel32.InitializeProcThreadAttributeList.restype = wintypes.BOOL

kernel32.UpdateProcThreadAttribute.argtypes = [
    ctypes.c_void_p, wintypes.DWORD, SIZE_T,
    ctypes.c_void_p, SIZE_T, ctypes.c_void_p, ctypes.c_void_p,
]
kernel32.UpdateProcThreadAttribute.restype = wintypes.BOOL

kernel32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
kernel32.DeleteProcThreadAttributeList.restype = None

kernel32.CreateProcessW.argtypes = [
    wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p,
    ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD,
    ctypes.c_void_p, wintypes.LPCWSTR,
    ctypes.c_void_p, ctypes.POINTER(PROCESS_INFORMATION),
]
kernel32.CreateProcessW.restype = wintypes.BOOL

kernel32.ReadFile.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
]
kernel32.ReadFile.restype = wintypes.BOOL

kernel32.WriteFile.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
]
kernel32.WriteFile.restype = wintypes.BOOL

kernel32.GetExitCodeProcess.argtypes = [
    wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD),
]
kernel32.GetExitCodeProcess.restype = wintypes.BOOL

kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.TerminateProcess.restype = wintypes.BOOL

kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

kernel32.PeekNamedPipe.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.PeekNamedPipe.restype = wintypes.BOOL


# ─── ConPtyProcess ─────────────────────────────────────────────────────────

class ConPtyProcess:
    """
    A process running in a Windows Pseudo Console (ConPTY).

    Drop-in replacement for pywinpty.PtyProcess with the same
    interface: spawn(), read(), write(), isalive(), setwinsize(),
    close(), pid, exitstatus.

    Uses CreateProcessW directly, which inherits the caller's
    security token — so admin privileges pass through correctly.
    """

    def __init__(self):
        self._hpc = HPCON()
        self._pi = PROCESS_INFORMATION()
        self._pipe_in_write = wintypes.HANDLE()
        self._pipe_out_read = wintypes.HANDLE()
        self._attr_list_buf = None
        self._closed = False
        self._winsize = (24, 80)
        self.pid = None

    @classmethod
    def spawn(cls, argv, cwd=None, env=None, dimensions=(24, 80)):
        """Start the given command in a child process in a pseudo console."""
        import shlex

        if isinstance(argv, str):
            argv = shlex.split(argv, posix=False)
        argv = list(argv)

        env_dict = env or os.environ
        command = which(argv[0], path=env_dict.get("PATH", os.defpath))
        if command is None:
            raise FileNotFoundError(f"Command not found: {argv[0]}")
        argv[0] = command

        cmdline = subprocess.list2cmdline(argv)
        cwd = cwd or os.getcwd()

        inst = cls()
        inst._winsize = dimensions

        # ── Create pipes ──────────────────────────────────────────────
        pipe_in_read = wintypes.HANDLE()
        pipe_in_write = wintypes.HANDLE()
        pipe_out_read = wintypes.HANDLE()
        pipe_out_write = wintypes.HANDLE()

        if not kernel32.CreatePipe(
            ctypes.byref(pipe_in_read), ctypes.byref(pipe_in_write), None, 0
        ):
            raise OSError(f"CreatePipe (input) failed: {ctypes.get_last_error()}")

        if not kernel32.CreatePipe(
            ctypes.byref(pipe_out_read), ctypes.byref(pipe_out_write), None, 0
        ):
            kernel32.CloseHandle(pipe_in_read)
            kernel32.CloseHandle(pipe_in_write)
            raise OSError(f"CreatePipe (output) failed: {ctypes.get_last_error()}")

        # ── Create pseudo console ─────────────────────────────────────
        size = COORD(dimensions[1], dimensions[0])  # (cols, rows)
        hr = kernel32.CreatePseudoConsole(
            size, pipe_in_read, pipe_out_write, 0, ctypes.byref(inst._hpc)
        )
        if hr != S_OK:
            for h in (pipe_in_read, pipe_in_write, pipe_out_read, pipe_out_write):
                kernel32.CloseHandle(h)
            raise OSError(
                f"CreatePseudoConsole failed: HRESULT 0x{hr & 0xFFFFFFFF:08x}"
            )

        # ── Prepare thread attribute list with the pseudo console ─────
        attr_size = SIZE_T(0)
        kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(attr_size))

        inst._attr_list_buf = (ctypes.c_byte * attr_size.value)()
        attr_list = ctypes.cast(inst._attr_list_buf, ctypes.c_void_p)

        if not kernel32.InitializeProcThreadAttributeList(
            attr_list, 1, 0, ctypes.byref(attr_size)
        ):
            raise OSError(
                f"InitializeProcThreadAttributeList failed: {ctypes.get_last_error()}"
            )

        if not kernel32.UpdateProcThreadAttribute(
            attr_list,
            0,
            SIZE_T(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE),
            inst._hpc,
            ctypes.sizeof(ctypes.c_void_p),
            None,
            None,
        ):
            raise OSError(
                f"UpdateProcThreadAttribute failed: {ctypes.get_last_error()}"
            )

        # ── Build environment block ───────────────────────────────────
        env_block = None
        if env_dict:
            env_str = "\0".join(f"{k}={v}" for k, v in env_dict.items()) + "\0\0"
            env_block = ctypes.create_unicode_buffer(env_str)

        # ── Create process ────────────────────────────────────────────
        si = STARTUPINFOEX()
        si.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEX)
        si.lpAttributeList = attr_list

        pi = PROCESS_INFORMATION()
        cmdline_buf = ctypes.create_unicode_buffer(cmdline)

        success = kernel32.CreateProcessW(
            None,
            cmdline_buf,
            None,
            None,
            False,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            ctypes.cast(env_block, ctypes.c_void_p) if env_block else None,
            cwd,
            ctypes.byref(si),
            ctypes.byref(pi),
        )
        if not success:
            err = ctypes.get_last_error()
            raise OSError(f"CreateProcessW failed: error {err}")

        inst._pi = pi
        inst.pid = pi.dwProcessId

        # Keep only the handles we use for I/O
        inst._pipe_in_write = pipe_in_write
        inst._pipe_out_read = pipe_out_read

        # Close the pipe ends owned by the pseudo console
        kernel32.CloseHandle(pipe_in_read)
        kernel32.CloseHandle(pipe_out_write)

        # Close the thread handle (we only need the process handle)
        kernel32.CloseHandle(pi.hThread)

        return inst

    # ── I/O ────────────────────────────────────────────────────────────

    def read(self, size=4096):
        """Read from the pseudo console output. Blocks until data is available.

        Blocking is intentional — the IDE reads in a daemon thread, and
        blocking ensures complete escape sequences are delivered to xterm.js.
        When the process exits the pipe breaks and ReadFile returns False,
        which raises EOFError to end the reader loop.
        """
        buf = ctypes.create_string_buffer(size)
        bytes_read = wintypes.DWORD(0)

        success = kernel32.ReadFile(
            self._pipe_out_read, buf, size, ctypes.byref(bytes_read), None
        )
        if not success or bytes_read.value == 0:
            raise EOFError("Pipe closed")

        return buf.raw[: bytes_read.value].decode("utf-8", errors="replace")

    def write(self, data):
        """Write to the pseudo console input."""
        if isinstance(data, str):
            data = data.encode("utf-8")

        bytes_written = wintypes.DWORD(0)
        success = kernel32.WriteFile(
            self._pipe_in_write, data, len(data), ctypes.byref(bytes_written), None
        )
        if not success:
            raise OSError(f"WriteFile failed: {ctypes.get_last_error()}")
        return bytes_written.value

    # ── Process state ──────────────────────────────────────────────────

    def isalive(self):
        """Check if the process is still running."""
        if self._closed:
            return False
        exit_code = wintypes.DWORD()
        kernel32.GetExitCodeProcess(self._pi.hProcess, ctypes.byref(exit_code))
        return exit_code.value == STILL_ACTIVE

    @property
    def exitstatus(self):
        """The exit status of the process, or None if still running."""
        exit_code = wintypes.DWORD()
        kernel32.GetExitCodeProcess(self._pi.hProcess, ctypes.byref(exit_code))
        if exit_code.value == STILL_ACTIVE:
            return None
        return exit_code.value

    # ── Resize / cleanup ───────────────────────────────────────────────

    def setwinsize(self, rows, cols):
        """Resize the pseudo console."""
        self._winsize = (rows, cols)
        kernel32.ResizePseudoConsole(self._hpc, COORD(cols, rows))

    def close(self):
        """Close the pseudo console and release all resources."""
        if self._closed:
            return
        self._closed = True

        try:
            if self.isalive():
                kernel32.TerminateProcess(self._pi.hProcess, 1)
        except Exception:
            pass

        for h in (self._pipe_in_write, self._pipe_out_read):
            try:
                if h:
                    kernel32.CloseHandle(h)
            except Exception:
                pass

        try:
            if self._hpc:
                kernel32.ClosePseudoConsole(self._hpc)
        except Exception:
            pass

        try:
            if self._pi.hProcess:
                kernel32.CloseHandle(self._pi.hProcess)
        except Exception:
            pass

        try:
            if self._attr_list_buf:
                attr_list = ctypes.cast(self._attr_list_buf, ctypes.c_void_p)
                kernel32.DeleteProcThreadAttributeList(attr_list)
        except Exception:
            pass

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
