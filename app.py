"""
Claude Code IDE — Main Application
===================================
A local web IDE that wraps Claude Code's CLI with project
and session management. Runs on localhost, serves a browser
UI with an interactive terminal powered by xterm.js.

Usage:
    python app.py
    Then open http://localhost:5000 in your browser.
"""

import json
import os
import re
import shutil
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_from_directory, Response
from flask_socketio import SocketIO, emit

# ─── Admin Elevation (Windows) ──────────────────────────────────────────────

def _is_admin():
    """Check if the current process is running with admin privileges."""
    if sys.platform != "win32":
        return os.geteuid() == 0  # Unix: check root
    try:
        import ctypes
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


def _relaunch_as_admin():
    """Relaunch this script with admin privileges via UAC prompt."""
    if sys.platform != "win32":
        print("ERROR: Not running as root. Please relaunch with sudo.")
        sys.exit(1)
    try:
        import ctypes
        # ShellExecuteW with "runas" verb triggers UAC elevation
        params = " ".join([f'"{arg}"' for arg in sys.argv])
        result = ctypes.windll.shell32.ShellExecuteW(
            None,           # hwnd
            "runas",        # lpOperation — triggers UAC
            sys.executable, # lpFile — python.exe
            params,         # lpParameters — this script + args
            None,           # lpDirectory
            1               # nShowCmd — SW_SHOWNORMAL
        )
        if result <= 32:
            print("ERROR: UAC elevation was denied or failed.")
            sys.exit(1)
        sys.exit(0)  # Exit the non-elevated instance
    except Exception as e:
        print(f"ERROR: Failed to relaunch as admin: {e}")
        print("Please right-click your terminal and 'Run as Administrator'.")
        sys.exit(1)


# Auto-elevate on startup
if not _is_admin():
    print("Not running as admin — requesting elevation...")
    _relaunch_as_admin()

# ─── Configuration ──────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent
DATA_DIR = Path(os.getenv("CLAUDE_IDE_DATA", BASE_DIR / "data"))
PROJECTS_DIR = DATA_DIR / "projects"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
ARCHIVED_DIR = DATA_DIR / "archived_projects"

# Default shell and Claude Code command
if sys.platform == "win32":
    DEFAULT_SHELL = os.getenv("CLAUDE_IDE_SHELL", "powershell.exe")
    CLAUDE_CMD = os.getenv("CLAUDE_IDE_CMD", "claude")
else:
    DEFAULT_SHELL = os.getenv("CLAUDE_IDE_SHELL", "/bin/bash")
    CLAUDE_CMD = os.getenv("CLAUDE_IDE_CMD", "claude")

# ─── Flask App ──────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("CLAUDE_IDE_SECRET", "claude-code-ide-dev-key")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Track active terminal sessions: sid -> session_info
active_terminals = {}


# ─── Terminal Management ────────────────────────────────────────────────────

def _account_env(account_name):
    """Resolve an account name to the env overrides that select it.

    Accounts live in settings.json: [{name, config_dir, api_key}]. A config
    dir makes Claude Code use that directory's credentials/settings (each
    account = its own CLAUDE_CONFIG_DIR, logged in separately via /login);
    an api_key sets ANTHROPIC_API_KEY directly. "Default"/empty = no
    overrides, i.e. the user's normal ~/.claude identity.
    """
    if not account_name or account_name == "Default":
        return {}
    for acct in load_settings().get("accounts", []):
        if acct.get("name") == account_name:
            env = {}
            if acct.get("config_dir"):
                env["CLAUDE_CONFIG_DIR"] = acct["config_dir"]
            if acct.get("api_key"):
                env["ANTHROPIC_API_KEY"] = acct["api_key"]
            return env
    print(f"[IDE] Unknown account '{account_name}' - spawning with default identity")
    return {}


def _spawn_terminal(sid, project_path=None, cmd=None, claude_session_id=None, term_id=None, account=None):
    """
    Spawn a Claude Code process in a PTY and wire it to the WebSocket.

    On Windows, uses pywinpty. On Unix, uses pty module.
    Falls back to subprocess if PTY is unavailable.

    Terminals are keyed by term_id (not socket sid) so one browser page can
    hold several concurrent sessions; the owning sid is stored for routing
    output and for cleanup on disconnect. Returns the term_id, or None.
    """
    import threading

    term_id = term_id or uuid.uuid4().hex

    # A tab id being reused while its previous terminal entry still exists
    # (e.g. the old process was orphaned by a reconnect, or exited without
    # cleanup) must not overwrite that entry - the old PTY would keep
    # emitting output under this id (two sessions interleaved in one tab)
    # and its session record would be lost. Kill and save the old one first.
    if term_id in active_terminals:
        old = _kill_terminal(term_id)
        if old:
            save_session(old, old.get("project"))
            print(f"[IDE] Terminal id {term_id} reused - previous session saved before respawn")

    cwd = project_path or str(Path.home())
    cmd = cmd or CLAUDE_CMD

    env = {**os.environ, "TERM": "xterm-256color", **_account_env(account)}

    # Session recording buffer
    session_record = {
        "id": f"sess_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}",
        "created": datetime.now().isoformat(),
        "working_directory": cwd,
        "project": None,
        "claude_session_id": claude_session_id,
        "account": account or "Default",
        "raw_output": [],
        "raw_input": [],
    }

    if sys.platform == "win32":
        try:
            from winpty import PtyProcess
            # Spawn Claude Code in a Windows PTY
            proc = PtyProcess.spawn(cmd, cwd=cwd, env=env)

            def read_output():
                """Read PTY output and send to browser via WebSocket."""
                try:
                    while proc.isalive():
                        try:
                            data = proc.read(4096)
                            if data:
                                session_record["raw_output"].append(data)
                                # Look up the CURRENT owner - reattach after a page
                                # refresh rebinds the terminal to a new socket
                                dest = _current_sid(term_id)
                                if dest:
                                    socketio.emit("terminal_output", {"terminal_id": term_id, "data": data}, to=dest)
                        except EOFError:
                            break
                        except Exception:
                            time.sleep(0.05)
                except Exception:
                    pass
                finally:
                    dest = _current_sid(term_id)
                    if dest:
                        socketio.emit("terminal_exit", {"terminal_id": term_id, "code": 0}, to=dest)
                    _finalize_exited_terminal(term_id, session_record)

            thread = threading.Thread(target=read_output, daemon=True)
            active_terminals[term_id] = {
                "proc": proc,
                "thread": thread,
                "record": session_record,
                "type": "winpty",
                "sid": sid,
            }
            thread.start()
            return term_id

        except ImportError:
            # pywinpty not available, fall back to subprocess
            pass

    # Unix PTY or fallback subprocess approach
    try:
        import pty
        import select
        import subprocess

        master_fd, slave_fd = pty.openpty()
        proc = subprocess.Popen(
            cmd if isinstance(cmd, list) else cmd.split(),
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=cwd,
            env=env,
        )
        os.close(slave_fd)

        def read_output():
            try:
                while proc.poll() is None:
                    r, _, _ = select.select([master_fd], [], [], 0.1)
                    if r:
                        data = os.read(master_fd, 4096).decode("utf-8", errors="replace")
                        if data:
                            session_record["raw_output"].append(data)
                            dest = _current_sid(term_id)
                            if dest:
                                socketio.emit("terminal_output", {"terminal_id": term_id, "data": data}, to=dest)
            except (OSError, ValueError):
                pass
            finally:
                os.close(master_fd)
                dest = _current_sid(term_id)
                if dest:
                    socketio.emit("terminal_exit", {"terminal_id": term_id, "code": proc.returncode or 0}, to=dest)
                _finalize_exited_terminal(term_id, session_record)

        thread = threading.Thread(target=read_output, daemon=True)
        active_terminals[term_id] = {
            "proc": proc,
            "master_fd": master_fd,
            "thread": thread,
            "record": session_record,
            "type": "pty",
            "sid": sid,
        }
        thread.start()
        return term_id

    except (ImportError, OSError):
        # No PTY available — use basic subprocess
        import subprocess

        proc = subprocess.Popen(
            cmd if isinstance(cmd, list) else cmd.split(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            env=env,
        )

        def read_output():
            try:
                for line in iter(proc.stdout.readline, b""):
                    data = line.decode("utf-8", errors="replace")
                    session_record["raw_output"].append(data)
                    dest = _current_sid(term_id)
                    if dest:
                        socketio.emit("terminal_output", {"terminal_id": term_id, "data": data}, to=dest)
            except Exception:
                pass
            finally:
                dest = _current_sid(term_id)
                if dest:
                    socketio.emit("terminal_exit", {"terminal_id": term_id, "code": proc.returncode or 0}, to=dest)
                _finalize_exited_terminal(term_id, session_record)

        thread = threading.Thread(target=read_output, daemon=True)
        active_terminals[term_id] = {
            "proc": proc,
            "thread": thread,
            "record": session_record,
            "type": "subprocess",
            "sid": sid,
        }
        thread.start()
        return term_id


def _current_sid(term_id):
    """The socket currently attached to a terminal (None while orphaned)."""
    info = active_terminals.get(term_id)
    return info.get("sid") if info else None


def _terminal_ids_for_sid(sid):
    """All terminal ids owned by a socket connection."""
    return [tid for tid, info in list(active_terminals.items()) if info.get("sid") == sid]


def _resolve_terminal_id(sid, data, allow_orphaned=False):
    """Find the terminal a client event refers to.

    Prefers an explicit terminal_id (validated against ownership); falls back
    to the connection's only terminal so an older cached frontend that sends
    no id keeps working in single-session mode.

    allow_orphaned lets stop/discard target a terminal whose sid is None
    (orphaned by a reconnect the client has not reattached yet) - otherwise
    a Stop & Save right after a network blip would silently do nothing.
    """
    tid = (data or {}).get("terminal_id")
    if tid:
        info = active_terminals.get(tid)
        if not info:
            return None
        owner = info.get("sid")
        if owner == sid or (allow_orphaned and owner is None):
            return tid
        return None
    owned = _terminal_ids_for_sid(sid)
    return owned[0] if len(owned) == 1 else None


def _write_to_terminal(term_id, data):
    """Send keyboard input to the terminal process."""
    info = active_terminals.get(term_id)
    if not info:
        return

    # Record input
    info["record"]["raw_input"].append(data)

    if info["type"] == "winpty":
        info["proc"].write(data)
    elif info["type"] == "pty":
        os.write(info["master_fd"], data.encode("utf-8"))
    elif info["type"] == "subprocess":
        if info["proc"].stdin:
            info["proc"].stdin.write(data.encode("utf-8"))
            info["proc"].stdin.flush()


def _kill_terminal(term_id):
    """Terminate the terminal process and return the session record."""
    info = active_terminals.pop(term_id, None)
    if not info:
        return None

    timer = info.pop("orphan_timer", None)
    if timer:
        timer.cancel()

    record = info["record"]
    record["ended"] = datetime.now().isoformat()

    try:
        if info["type"] == "winpty":
            info["proc"].close()
        elif info["type"] == "pty":
            info["proc"].terminate()
        elif info["type"] == "subprocess":
            info["proc"].terminate()
    except Exception:
        pass

    return record


def _finalize_exited_terminal(term_id, session_record):
    """The terminal process ended on its own - save the session and clean up.

    Called from the PTY reader thread's finally block. Stop/discard/reap all
    pop the entry via _kill_terminal BEFORE the process dies, so the identity
    check makes this a no-op for those paths. It only fires for a natural
    exit (user typed /exit, Claude crashed). Without it the entry stayed in
    active_terminals forever: the session was never saved, resuming it was
    refused as "already open", and starting a new session in the same tab
    overwrote (lost) the record.
    """
    info = active_terminals.get(term_id)
    if not info or info.get("record") is not session_record:
        return
    active_terminals.pop(term_id, None)
    timer = info.pop("orphan_timer", None)
    if timer:
        timer.cancel()
    record = info["record"]
    record["ended"] = datetime.now().isoformat()
    try:
        filepath = save_session(record, record.get("project"))
        print(f"[IDE] Terminal {term_id} exited on its own - session saved to {filepath}")
    except Exception as e:
        print(f"[IDE] Terminal {term_id} exited but saving failed: {e}")
        return
    dest = info.get("sid")
    if dest:
        socketio.emit("session_saved",
                      {"terminal_id": term_id, "filepath": filepath, "id": record["id"]},
                      to=dest)


# ─── Session Persistence ───────────────────────────────────────────────────

def _project_for_workdir(working_directory):
    """Return the project folder name whose working_directory matches, or None."""
    if not working_directory:
        return None
    target = os.path.normcase(os.path.normpath(working_directory)).rstrip("\\/")
    for d in PROJECTS_DIR.iterdir():
        if not d.is_dir():
            continue
        meta = _read_project_meta(d.name)
        if meta is None:
            continue
        wd = meta.get("working_directory", "")
        if not wd:
            continue
        if os.path.normcase(os.path.normpath(wd)).rstrip("\\/") == target:
            return d.name
    return None


def save_session(record, project_name=None):
    """Save a session record to disk.

    The destination project is determined by the session's working_directory
    when it matches a project, regardless of what the UI passed in. This
    prevents sessions from being filed under whichever project happened to
    be selected in the sidebar at save time.
    """
    correct = _project_for_workdir(record.get("working_directory", ""))
    if correct and correct != project_name:
        print(f"[IDE] save_session: routing to '{correct}' based on working_directory (UI passed '{project_name}')")
        project_name = correct
    if project_name:
        session_dir = PROJECTS_DIR / project_name / "sessions"
    else:
        session_dir = DATA_DIR / "unsorted_sessions"
    session_dir.mkdir(parents=True, exist_ok=True)

    filepath = session_dir / f"{record['id']}.json"

    # Build a clean record for storage
    save_data = {
        "id": record["id"],
        "project": project_name,
        "claude_session_id": record.get("claude_session_id", ""),
        "created": record["created"],
        "ended": record.get("ended", datetime.now().isoformat()),
        "working_directory": record.get("working_directory", ""),
        "summary": record.get("summary", ""),
        "tags": record.get("tags", []),
        "cols": record.get("cols"),
        "rows": record.get("rows"),
        "account": record.get("account", "Default"),
        "raw_transcript": "".join(record.get("raw_output", [])),
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(save_data, f, indent=2, ensure_ascii=False)

    return str(filepath)


def _clean_transcript(raw_text, cols=None, rows=None):
    """Render raw PTY output through a virtual terminal to get readable text.

    The virtual screen MUST be at least as wide as the terminal that produced
    the output - anything narrower clips every screen row at the boundary and
    wraps the remainder into shredded fragments. Sessions record their actual
    size on resize; older records without one get a generous default (wider
    than the real terminal is harmless, the excess is stripped as trailing
    whitespace).
    """
    import pyte

    width = int(cols) if cols else 240
    height = int(rows) if rows else 50

    screen = pyte.HistoryScreen(width, height, history=100000)
    stream = pyte.Stream(screen)
    stream.feed(raw_text)

    # Collect scrollback history + current screen
    lines = []
    for hist_line in screen.history.top:
        chars = ''
        for col in range(width):
            if col in hist_line:
                chars += hist_line[col].data
            else:
                chars += ' '
        lines.append(chars.rstrip())

    for row in screen.display:
        lines.append(row.rstrip())

    # TUI apps redraw the same content frame after frame - drop consecutive
    # identical non-blank lines so the transcript reads as prose, not frames
    deduped = []
    for line in lines:
        if deduped and line and line == deduped[-1]:
            continue
        deduped.append(line)

    text = '\n'.join(deduped)

    # Collapse excessive blank lines
    text = re.compile(r'\n{4,}').sub('\n\n\n', text)

    return text.strip()


def load_session(project_name, session_id):
    """Load a saved session."""
    filepath = PROJECTS_DIR / project_name / "sessions" / f"{session_id}.json"
    if not filepath.exists():
        return None
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def list_sessions(project_name):
    """List all sessions for a project."""
    session_dir = PROJECTS_DIR / project_name / "sessions"
    if not session_dir.exists():
        return []

    sessions = []
    for fp in session_dir.glob("*.json"):
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
                sessions.append({
                    "id": data["id"],
                    "created": data["created"],
                    "ended": data.get("ended", ""),
                    "summary": data.get("summary", ""),
                    "tags": data.get("tags", []),
                    "claude_session_id": data.get("claude_session_id", ""),
                    "working_directory": data.get("working_directory", ""),
                    "account": data.get("account", "Default"),
                })
        except Exception:
            continue
    # Newest SAVE first - a long-running session saved just now should top
    # the list even though it was created hours ago
    sessions.sort(key=lambda s: s.get("ended") or s.get("created") or "", reverse=True)
    return sessions


# ─── Project Management ────────────────────────────────────────────────────

def _safe_project_name(name):
    """Reject names that could escape the projects directory."""
    return bool(name) and "/" not in name and "\\" not in name and ".." not in name


def _read_project_meta(name, base_dir=None):
    """Read a project's metadata. Returns None if missing or unreadable."""
    meta_path = (base_dir or PROJECTS_DIR) / name / "project.json"
    if not meta_path.exists():
        return None
    try:
        with open(meta_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[IDE] Failed to read {meta_path}: {e}")
        return None


def _write_project_meta(name, meta):
    """Write a project's metadata."""
    with open(PROJECTS_DIR / name / "project.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)


def list_projects():
    """List all projects."""
    projects = []
    for d in sorted(PROJECTS_DIR.iterdir()):
        if d.is_dir():
            meta = _read_project_meta(d.name) or {}

            sessions_dir = d / "sessions"
            session_files = list(sessions_dir.glob("*.json")) if sessions_dir.exists() else []
            session_count = len(session_files)
            last_session_mtime = max((f.stat().st_mtime for f in session_files), default=0.0)

            projects.append({
                "name": d.name,
                "display_name": meta.get("display_name", d.name),
                "created": meta.get("created", ""),
                "description": meta.get("description", ""),
                "pinned": meta.get("pinned", False),
                "work_related": meta.get("work_related", False),
                "urls": meta.get("urls", []),
                "session_count": session_count,
                "last_session_mtime": last_session_mtime,
            })
    # Pinned first, then projects with most recent sessions on top, then name.
    projects.sort(key=lambda p: (not p["pinned"], -p["last_session_mtime"], p["name"].lower()))
    return projects


def create_project(name, display_name=None, description="", working_directory=""):
    """Create a new project."""
    project_dir = PROJECTS_DIR / name
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "sessions").mkdir(exist_ok=True)

    meta = {
        "name": name,
        "display_name": display_name or name,
        "description": description,
        "working_directory": working_directory,
        "created": datetime.now().isoformat(),
    }
    _write_project_meta(name, meta)

    # Auto-create CLAUDE.md in the working directory
    if working_directory:
        _create_default_claude_md(working_directory, display_name or name, description)

    return meta


def _create_default_claude_md(working_directory, project_name, description=""):
    """Create a minimal CLAUDE.md with project context only."""
    claude_md_path = Path(working_directory) / "CLAUDE.md"
    if claude_md_path.exists():
        return  # Don't overwrite an existing CLAUDE.md

    wd_display = working_directory.replace("\\", "/")

    desc_line = ""
    if description:
        desc_line = f"\n{description}\n"

    content = f"""# {project_name}

This file provides guidance to Claude Code when working with code in this repository.

## Project

**{project_name}**{desc_line}

## Working Directory

`{wd_display}`
"""

    try:
        with open(claude_md_path, "w", encoding="utf-8") as f:
            f.write(content.strip() + "\n")
        print(f"[IDE] Created CLAUDE.md: {claude_md_path}")
    except Exception as e:
        print(f"[IDE] Failed to create CLAUDE.md: {e}")


def delete_project(name):
    """Delete a project and all its sessions."""
    project_dir = PROJECTS_DIR / name
    if project_dir.exists():
        shutil.rmtree(project_dir)
        return True
    return False


# ─── Settings ────────────────────────────────────────────────────────────────

SETTINGS_FILE = DATA_DIR / "settings.json"

def load_settings():
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[IDE] Failed to read settings: {e}")
    return {"claude_cmd": CLAUDE_CMD, "default_project": "", "font_size": 14}

def save_settings(settings):
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── Settings API ──

@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify(load_settings())


@app.route("/api/settings", methods=["PUT"])
def api_put_settings():
    global CLAUDE_CMD
    data = request.json
    settings = load_settings()
    if "claude_cmd" in data:
        settings["claude_cmd"] = data["claude_cmd"].strip() or "claude"
        CLAUDE_CMD = settings["claude_cmd"]
    if "default_project" in data:
        settings["default_project"] = data["default_project"]
    if "font_size" in data:
        settings["font_size"] = max(10, min(24, int(data["font_size"])))
    if "notifications_enabled" in data:
        settings["notifications_enabled"] = bool(data["notifications_enabled"])
    if "notification_sound" in data:
        settings["notification_sound"] = bool(data["notification_sound"])
    if "accounts" in data:
        # [{name, config_dir, api_key}] - name required, the rest optional
        accounts = []
        for acct in data["accounts"] or []:
            name = (acct.get("name") or "").strip()
            if not name or name == "Default":
                continue
            accounts.append({
                "name": name,
                "config_dir": (acct.get("config_dir") or "").strip(),
                "api_key": (acct.get("api_key") or "").strip(),
            })
        settings["accounts"] = accounts
    save_settings(settings)
    return jsonify(settings)


# ── Usage API ──
#
# Token usage comes from Claude Code's own transcripts
# (~/.claude/projects/<munged-wd>/<session-id>.jsonl), matched to IDE
# sessions by claude_session_id. Parsed totals are cached by file
# mtime+size in data/usage_cache.json so only new activity is re-read.

USAGE_CACHE_FILE = DATA_DIR / "usage_cache.json"
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

USAGE_KEYS = ("input", "output", "cache_read", "cache_creation", "turns")

# Estimated pricing per MTok (USD), used for the Usage tab's cost column.
# Prefix-matched against the model id in the transcript (longest prefix
# wins). Cache read ~0.1x input; cache write ~1.25x input (5-minute TTL).
# Override or extend via a "model_pricing" object in data/settings.json.
# For subscription (Max/Pro) accounts this is API-equivalent value, not a
# bill.
DEFAULT_MODEL_PRICING = {
    "claude-fable-5":   {"input": 10.0, "output": 50.0, "cache_read": 1.0,  "cache_creation": 12.5},
    "claude-mythos-5":  {"input": 10.0, "output": 50.0, "cache_read": 1.0,  "cache_creation": 12.5},
    "claude-opus-4-8":  {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_creation": 6.25},
    "claude-opus-4-7":  {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_creation": 6.25},
    "claude-opus-4-6":  {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_creation": 6.25},
    "claude-opus-4-5":  {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_creation": 6.25},
    "claude-opus-4-1":  {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_creation": 18.75},
    "claude-opus-4":    {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_creation": 18.75},
    "claude-sonnet":    {"input": 3.0,  "output": 15.0, "cache_read": 0.3,  "cache_creation": 3.75},
    "claude-3-5-haiku": {"input": 0.8,  "output": 4.0,  "cache_read": 0.08, "cache_creation": 1.0},
    "claude-haiku":     {"input": 1.0,  "output": 5.0,  "cache_read": 0.1,  "cache_creation": 1.25},
    "default":          {"input": 5.0,  "output": 25.0, "cache_read": 0.5,  "cache_creation": 6.25},
}


def _pricing_for_model(model, pricing):
    best = None
    for prefix, rates in pricing.items():
        if prefix != "default" and model.startswith(prefix):
            if best is None or len(prefix) > len(best[0]):
                best = (prefix, rates)
    return best[1] if best else pricing.get("default", DEFAULT_MODEL_PRICING["default"])


def _cost_of_models(models, pricing):
    """Estimated USD cost of a per-model token breakdown."""
    cost = 0.0
    for model, u in models.items():
        r = _pricing_for_model(model, pricing)
        cost += (
            u.get("input", 0) * r.get("input", 0)
            + u.get("output", 0) * r.get("output", 0)
            + u.get("cache_read", 0) * r.get("cache_read", 0)
            + u.get("cache_creation", 0) * r.get("cache_creation", 0)
        ) / 1e6
    return cost


def _zero_usage():
    return {k: 0 for k in USAGE_KEYS}


def _add_usage(dst, usage):
    for k in USAGE_KEYS:
        dst[k] += usage.get(k, 0)


def _sum_models(models):
    """Collapse a per-model breakdown into one flat usage dict."""
    total = _zero_usage()
    for u in models.values():
        _add_usage(total, u)
    return total


def _parse_jsonl_usage(path):
    """Per-model token usage from one Claude Code transcript.

    Streamed responses repeat the same message id across several entries
    with identical usage - keep the last entry per message id so nothing
    is double-counted. Returns {"models": {model_id: usage dict}}.
    """
    per_msg = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            # cheap prefilter before json.loads - files can be tens of MB
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "assistant":
                continue
            msg = obj.get("message") or {}
            usage = msg.get("usage")
            if usage:
                per_msg[msg.get("id") or obj.get("uuid")] = (msg.get("model") or "unknown", usage)

    models = {}
    for model, usage in per_msg.values():
        bucket = models.setdefault(model, _zero_usage())
        bucket["turns"] += 1
        bucket["input"] += usage.get("input_tokens", 0) or 0
        bucket["output"] += usage.get("output_tokens", 0) or 0
        bucket["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
        bucket["cache_creation"] += usage.get("cache_creation_input_tokens", 0) or 0
    return {"models": models}


@app.route("/api/usage", methods=["GET"])
def api_usage():
    """Aggregate token usage and estimated cost per project, per day, and
    per Anthropic account for the Usage tab."""
    settings = load_settings()
    pricing = {**DEFAULT_MODEL_PRICING, **settings.get("model_pricing", {})}

    # 1. Every Claude session the IDE knows about: sid -> project/created/account
    sess_map = {}

    def note(sid, project, created, account):
        if not sid:
            return
        cur = sess_map.get(sid)
        if not cur:
            sess_map[sid] = {"project": project, "created": created or "", "account": account or "Default"}
            return
        if created and (not cur["created"] or created < cur["created"]):
            cur["created"] = created
        if project:
            cur["project"] = project
        if account and account != "Default":
            cur["account"] = account

    for project_dir in PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        for fp in (project_dir / "sessions").glob("*.json"):
            try:
                with open(fp, encoding="utf-8") as f:
                    data = json.load(f)
                note(data.get("claude_session_id"), project_dir.name, data.get("created", ""), data.get("account"))
            except Exception:
                continue
    unsorted_dir = DATA_DIR / "unsorted_sessions"
    if unsorted_dir.exists():
        for fp in unsorted_dir.glob("*.json"):
            try:
                with open(fp, encoding="utf-8") as f:
                    data = json.load(f)
                note(data.get("claude_session_id"), None, data.get("created", ""), data.get("account"))
            except Exception:
                continue
    for info in list(active_terminals.values()):
        record = info["record"]
        note(record.get("claude_session_id"), record.get("project"), record.get("created", ""), record.get("account"))

    # 2. Index transcripts across every account's config dir. Sessions run
    # under an alternate account write their jsonl to that account's
    # CLAUDE_CONFIG_DIR/projects, not ~/.claude/projects.
    transcript_roots = [CLAUDE_PROJECTS_DIR]
    for acct in settings.get("accounts", []):
        cfg = acct.get("config_dir")
        if cfg:
            transcript_roots.append(Path(cfg) / "projects")
    jsonl_index = {}
    for root in transcript_roots:
        if not root.exists():
            continue
        for p in root.glob("*/*.jsonl"):
            jsonl_index.setdefault(p.stem, p)

    # 3. Parse (or reuse cached) per-model usage per session
    cache = {}
    if USAGE_CACHE_FILE.exists():
        try:
            with open(USAGE_CACHE_FILE, encoding="utf-8") as f:
                cache = json.load(f)
        except Exception:
            cache = {}
    cache_dirty = False

    now = datetime.now()

    def zero_bucket():
        return {**_zero_usage(), "cost": 0.0}

    def add_bucket(dst, usage, cost):
        _add_usage(dst, usage)
        dst["cost"] += cost

    totals = {"all": zero_bucket(), "last7": zero_bucket(), "last30": zero_bucket()}
    projects_agg = {}
    days_agg = {}
    accounts_agg = {}
    counted = 0

    for sid, meta in sess_map.items():
        path = jsonl_index.get(sid)
        if not path:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        entry = cache.get(sid)
        # "models" distinguishes the current cache format from the pre-cost one
        if (entry and entry.get("mtime") == stat.st_mtime and entry.get("size") == stat.st_size
                and "models" in (entry.get("usage") or {})):
            parsed = entry["usage"]
        else:
            parsed = _parse_jsonl_usage(path)
            cache[sid] = {"mtime": stat.st_mtime, "size": stat.st_size, "usage": parsed}
            cache_dirty = True
        counted += 1

        usage = _sum_models(parsed["models"])
        cost = _cost_of_models(parsed["models"], pricing)

        created = meta.get("created") or ""
        try:
            age_days = (now - datetime.fromisoformat(created)).days if created else None
        except ValueError:
            age_days = None

        add_bucket(totals["all"], usage, cost)
        if age_days is not None and age_days < 7:
            add_bucket(totals["last7"], usage, cost)
        if age_days is not None and age_days < 30:
            add_bucket(totals["last30"], usage, cost)

        pkey = meta.get("project") or "(no project)"
        pa = projects_agg.setdefault(pkey, {**zero_bucket(), "sessions": 0, "last_used": ""})
        add_bucket(pa, usage, cost)
        pa["sessions"] += 1
        if created > pa["last_used"]:
            pa["last_used"] = created

        akey = meta.get("account") or "Default"
        aa = accounts_agg.setdefault(akey, {**zero_bucket(), "sessions": 0, "last_used": ""})
        add_bucket(aa, usage, cost)
        aa["sessions"] += 1
        if created > aa["last_used"]:
            aa["last_used"] = created

        day = created[:10]
        if day and age_days is not None and age_days < 30:
            add_bucket(days_agg.setdefault(day, zero_bucket()), usage, cost)

    if cache_dirty:
        try:
            with open(USAGE_CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(cache, f)
        except Exception:
            pass

    projects_out = [{"project": k, **v} for k, v in projects_agg.items()]
    projects_out.sort(key=lambda x: x["output"], reverse=True)
    accounts_out = [{"account": k, **v} for k, v in accounts_agg.items()]
    accounts_out.sort(key=lambda x: x["cost"], reverse=True)
    days_out = [{"date": k, **v} for k, v in sorted(days_agg.items())]

    return jsonify({
        "generated": now.isoformat(),
        "sessions_counted": counted,
        "totals": totals,
        "projects": projects_out,
        "accounts": accounts_out,
        "days": days_out,
    })


# ── Guide API ──

@app.route("/api/guide", methods=["GET"])
def api_guide():
    """The IDE's own README.md, rendered by the in-app Guide viewer."""
    path = BASE_DIR / "README.md"
    if not path.exists():
        return jsonify({"error": "README.md not found next to app.py"}), 404
    with open(path, encoding="utf-8", errors="replace") as f:
        return jsonify({"content": f.read()})


# ── Active Terminals API (refresh survival) ──

@app.route("/api/active-terminals", methods=["GET"])
def api_active_terminals():
    """List live terminals so a freshly loaded page can reattach to them."""
    out = []
    for tid, info in list(active_terminals.items()):
        record = info["record"]
        out.append({
            "terminal_id": tid,
            "project": record.get("project"),
            "claude_session_id": record.get("claude_session_id"),
            "working_directory": record.get("working_directory"),
            "created": record.get("created"),
            "account": record.get("account", "Default"),
            "summary": record.get("summary", ""),
            "attached": bool(info.get("sid")),
        })
    return jsonify(out)


# ── Notifications API ──
#
# Claude Code's Notification hook fires when a session needs attention
# (permission request, waiting for input). The installed hook forwards the
# hook's stdin JSON to /api/notify via curl; the payload's session_id is
# matched against each terminal's claude_session_id to find the owning tab.

CLAUDE_SETTINGS_FILE = Path.home() / ".claude" / "settings.json"


def _notify_hook_command():
    port = int(os.getenv("CLAUDE_IDE_PORT", 5050))
    return (
        'curl.exe -s --max-time 2 -X POST -H "Content-Type: application/json" '
        f"--data-binary @- http://localhost:{port}/api/notify"
    )


def _has_notify_hook(cfg):
    for entry in cfg.get("hooks", {}).get("Notification", []):
        for h in entry.get("hooks", []):
            if "/api/notify" in h.get("command", ""):
                return True
    return False


@app.route("/api/notify", methods=["POST"])
def api_notify():
    """Receive a Claude Code Notification-hook event and alert the owning tab."""
    data = request.get_json(silent=True) or {}
    claude_sid = data.get("session_id", "")
    message = data.get("message") or "Claude needs your input"
    if not claude_sid:
        return jsonify({"error": "no session_id"}), 400
    for tid, info in list(active_terminals.items()):
        if info["record"].get("claude_session_id") == claude_sid:
            socketio.emit("session_attention", {
                "terminal_id": tid,
                "message": message,
            }, to=info.get("sid"))
            return jsonify({"status": "delivered"})
    # Session not started from this IDE (plain terminal, other machine) - fine
    return jsonify({"status": "ignored"})


@app.route("/api/notify-hook-status", methods=["GET"])
def api_notify_hook_status():
    """Report whether the IDE's Notification hook is present in ~/.claude/settings.json."""
    try:
        with open(CLAUDE_SETTINGS_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    return jsonify({"installed": _has_notify_hook(cfg)})


@app.route("/api/install-notify-hook", methods=["POST"])
def api_install_notify_hook():
    """Add the IDE's Notification hook to ~/.claude/settings.json.

    Backs the file up to settings.json.bak first, and refuses to touch a
    settings file that exists but cannot be parsed.
    """
    cfg = {}
    if CLAUDE_SETTINGS_FILE.exists():
        try:
            with open(CLAUDE_SETTINGS_FILE, encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            return jsonify({"error": f"~/.claude/settings.json is unreadable, not modifying it: {e}"}), 500

    if _has_notify_hook(cfg):
        return jsonify({"status": "already-installed"})

    try:
        if CLAUDE_SETTINGS_FILE.exists():
            shutil.copy2(CLAUDE_SETTINGS_FILE, CLAUDE_SETTINGS_FILE.with_suffix(".json.bak"))
        cfg.setdefault("hooks", {}).setdefault("Notification", []).append({
            "hooks": [{"type": "command", "command": _notify_hook_command(), "timeout": 5}],
        })
        CLAUDE_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CLAUDE_SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        return jsonify({"status": "installed"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Restart API ──

@app.route("/api/restart", methods=["POST"])
def api_restart():
    """Restart the IDE server process."""
    import threading

    def _do_restart():
        time.sleep(1)  # Give the response time to reach the client
        print("[IDE] Restarting server...")
        os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=_do_restart, daemon=True).start()
    return jsonify({"status": "restarting"})


# ── Project API ──

@app.route("/api/projects", methods=["GET"])
def api_list_projects():
    return jsonify(list_projects())


@app.route("/api/projects", methods=["POST"])
def api_create_project():
    data = request.json
    name = data.get("name", "").strip().replace(" ", "-").lower()
    if not name:
        return jsonify({"error": "Project name required"}), 400
    if not _safe_project_name(name):
        return jsonify({"error": "Invalid project name"}), 400
    if (PROJECTS_DIR / name).exists():
        return jsonify({"error": f"Project '{name}' already exists"}), 409
    meta = create_project(name, data.get("display_name"), data.get("description", ""), data.get("working_directory", ""))
    return jsonify(meta), 201


@app.route("/api/upload", methods=["POST"])
def api_upload_file():
    """Upload a file to the active project's working directory."""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400

    project = request.form.get("project", "")
    if project:
        dest_dir = _get_project_working_dir(project)
    else:
        dest_dir = str(Path.home())

    # Secure the filename — keep original name but strip path components
    filename = os.path.basename(f.filename)
    dest_path = os.path.join(dest_dir, filename)

    try:
        f.save(dest_path)
        return jsonify({
            "status": "success",
            "filename": filename,
            "path": dest_path,
            "size": os.path.getsize(dest_path),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/import-conversation", methods=["POST"])
def api_import_conversation():
    """Save pasted conversation text as a file in the project working directory."""
    data = request.json
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "No text provided"}), 400

    project = data.get("project", "")
    label = data.get("label", "").strip()

    if project:
        dest_dir = _get_project_working_dir(project)
    else:
        dest_dir = str(Path.home())

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"imported_conversation_{timestamp}.txt"
    filepath = os.path.join(dest_dir, filename)

    # Write with optional label header
    with open(filepath, "w", encoding="utf-8") as f:
        if label:
            f.write(f"Source: {label}\n")
            f.write(f"Imported: {datetime.now().isoformat()}\n")
            f.write("=" * 60 + "\n\n")
        f.write(text)

    return jsonify({
        "status": "success",
        "filename": filename,
        "path": filepath,
        "size": os.path.getsize(filepath),
    })


@app.route("/api/screenshot", methods=["POST"])
def api_screenshot():
    """Launch Windows Snipping Tool, wait for capture, save to project directory."""
    import subprocess
    from PIL import ImageGrab

    project = request.json.get("project", "")
    if project:
        dest_dir = _get_project_working_dir(project)
    else:
        dest_dir = str(Path.home())

    # Clear clipboard first so we can detect new content
    try:
        import ctypes
        ctypes.windll.user32.OpenClipboard(0)
        ctypes.windll.user32.EmptyClipboard()
        ctypes.windll.user32.CloseClipboard()
    except Exception:
        pass

    # Launch Windows Snipping Tool in capture mode
    try:
        subprocess.Popen(["snippingtool", "/clip"], shell=True)
    except Exception:
        try:
            subprocess.Popen(["explorer", "ms-screenclip:"], shell=True)
        except Exception:
            return jsonify({"error": "Could not launch screenshot tool"}), 500

    # Poll clipboard for a new image (up to 30 seconds)
    from PIL import Image
    for _ in range(60):
        time.sleep(0.5)
        try:
            clip = ImageGrab.grabclipboard()
            if clip is None:
                continue

            img = None
            # grabclipboard() returns an Image for raw bitmap data,
            # but on Windows 11 the Snipping Tool may put a file
            # reference on the clipboard instead — which comes back
            # as a list of file paths.
            if isinstance(clip, Image.Image):
                img = clip
            elif isinstance(clip, list) and clip:
                src_path = clip[0]
                if os.path.isfile(src_path):
                    img = Image.open(src_path)

            if img is not None:
                filename = f"screenshot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
                filepath = os.path.join(dest_dir, filename)
                img.save(filepath, "PNG")
                print(f"[IDE] Screenshot saved: {filepath}")
                return jsonify({
                    "status": "success",
                    "filename": filename,
                    "path": filepath,
                    "size": os.path.getsize(filepath),
                })
        except Exception as e:
            print(f"[IDE] Screenshot poll error: {e}")
            continue

    return jsonify({"error": "Screenshot timed out — no image detected in clipboard"}), 408


@app.route("/api/projects/<name>/files", methods=["GET"])
def api_list_files(name):
    """List files in the project's working directory as a tree."""
    wd = _get_project_working_dir(name)
    if not os.path.isdir(wd):
        return jsonify({"error": "Working directory not found", "path": wd}), 404

    max_depth = int(request.args.get("depth", 3))
    max_files = int(request.args.get("limit", 500))
    count = 0

    # Directories to skip
    skip_dirs = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next',
                 '.cache', 'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
                 'env', '.env', '.idea', '.vs', '.vscode'}

    def scan_dir(path, depth):
        nonlocal count
        if depth > max_depth or count > max_files:
            return []

        entries = []
        try:
            items = sorted(os.listdir(path), key=lambda x: (not os.path.isdir(os.path.join(path, x)), x.lower()))
        except PermissionError:
            return []

        for item in items:
            if count > max_files:
                break
            full = os.path.join(path, item)
            is_dir = os.path.isdir(full)

            if is_dir and item in skip_dirs:
                continue

            count += 1
            entry = {
                "name": item,
                "path": full,
                "is_dir": is_dir,
            }

            if is_dir:
                entry["children"] = scan_dir(full, depth + 1)
            else:
                try:
                    entry["size"] = os.path.getsize(full)
                except OSError:
                    entry["size"] = 0

            entries.append(entry)

        return entries

    tree = scan_dir(wd, 0)
    return jsonify({"path": wd, "tree": tree})


# ── File Content API (editor pane) ──

EDITOR_MAX_FILE_BYTES = 2 * 1024 * 1024  # don't open huge files in Monaco


def _resolve_project_file(name, raw_path):
    """Validate that raw_path lives inside the project's working directory.

    Returns (abs_path, None) or (None, (json_error, http_status)).
    """
    wd = _get_project_working_dir(name)
    if not wd or not os.path.isdir(wd):
        return None, ({"error": "Working directory not found"}, 404)
    if not raw_path:
        return None, ({"error": "No path given"}, 400)
    full = os.path.realpath(raw_path if os.path.isabs(raw_path) else os.path.join(wd, raw_path))
    wd_real = os.path.realpath(wd)
    try:
        if os.path.commonpath([wd_real, full]) != wd_real:
            return None, ({"error": "Path is outside the project working directory"}, 403)
    except ValueError:  # different drives on Windows
        return None, ({"error": "Path is outside the project working directory"}, 403)
    return full, None


@app.route("/api/projects/<name>/file", methods=["GET"])
def api_read_file(name):
    """Read a text file from the project working directory for the editor."""
    full, err = _resolve_project_file(name, request.args.get("path", ""))
    if err:
        return jsonify(err[0]), err[1]
    if not os.path.isfile(full):
        return jsonify({"error": "File not found"}), 404
    size = os.path.getsize(full)
    if size > EDITOR_MAX_FILE_BYTES:
        return jsonify({"error": f"File too large for the editor ({size} bytes)"}), 413
    with open(full, "rb") as f:
        raw = f.read()
    if b"\x00" in raw[:8192]:
        return jsonify({"error": "Binary file - not editable"}), 415
    return jsonify({
        "path": full,
        "content": raw.decode("utf-8", errors="replace"),
        "mtime": os.path.getmtime(full),
    })


@app.route("/api/projects/<name>/file", methods=["PUT"])
def api_write_file(name):
    """Save editor content back to disk, guarding against clobbering
    changes made on disk (e.g. by Claude) since the file was loaded."""
    data = request.json or {}
    full, err = _resolve_project_file(name, data.get("path", ""))
    if err:
        return jsonify(err[0]), err[1]
    if not os.path.isfile(full):
        return jsonify({"error": "File not found"}), 404

    known_mtime = data.get("known_mtime")
    if known_mtime is not None and not data.get("force"):
        # Tolerate float jitter across filesystems
        if abs(os.path.getmtime(full) - float(known_mtime)) > 0.001:
            return jsonify({"error": "changed-on-disk"}), 409

    content = data.get("content")
    if content is None:
        return jsonify({"error": "No content"}), 400
    with open(full, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    return jsonify({"status": "saved", "mtime": os.path.getmtime(full)})


def _run_git(args, cwd, timeout=5):
    """Run a git command safely in a way that never hangs.

    - stdin is /dev/null so git can never prompt for input
    - GIT_TERMINAL_PROMPT=0 disables credential prompts
    - creationflags prevents spawning a console window on Windows
    - timeout kills the process if it takes too long
    """
    import subprocess
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"

    kwargs = dict(
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        stdin=subprocess.DEVNULL,
        env=env,
    )
    # On Windows, prevent git from spawning a visible console
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    return subprocess.run(["git"] + args, **kwargs)


def _collect_git_status(wd):
    """Gather all git info for a working directory. Runs in a thread."""
    # Check if it's a git repo. subprocess.run does not raise on a non-zero
    # exit code, so the returncode must be checked explicitly - otherwise
    # non-git directories are misreported as git repos.
    try:
        check = _run_git(["rev-parse", "--git-dir"], wd, timeout=3)
        if check.returncode != 0:
            return {"error": "Not a git repository", "is_git": False}
    except Exception:
        return {"error": "Not a git repository", "is_git": False}

    result = {"is_git": True, "files": [], "diff": "", "branch": ""}

    # Get current branch
    try:
        branch = _run_git(["branch", "--show-current"], wd, timeout=3)
        result["branch"] = branch.stdout.strip()
    except Exception:
        pass

    # Get status (porcelain for easy parsing)
    try:
        status = _run_git(["status", "--porcelain"], wd, timeout=5)
        for line in status.stdout.strip().split("\n"):
            if not line.strip():
                continue
            code = line[:2]
            filepath = line[3:]
            result["files"].append({"status": code.strip(), "path": filepath})
    except Exception:
        pass

    # Get diff (staged + unstaged) — limit output at the git level
    try:
        diff = _run_git(["diff", "HEAD"], wd, timeout=8)
        result["diff"] = diff.stdout[:100000]
    except Exception:
        try:
            diff = _run_git(["diff"], wd, timeout=8)
            result["diff"] = diff.stdout[:100000]
        except Exception:
            pass

    # Get recent log (last 5 commits)
    try:
        log = _run_git(["log", "--oneline", "-5"], wd, timeout=3)
        result["log"] = log.stdout.strip().split("\n") if log.stdout.strip() else []
    except Exception:
        result["log"] = []

    return result


# Thread pool for git operations — prevents blocking the server
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
_git_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="git")


@app.route("/api/projects/<name>/git-status", methods=["GET"])
def api_git_status(name):
    """Get git status and diff for the project's working directory.

    Runs all git operations in a background thread so the server
    stays responsive even if git hangs or takes a long time.
    """
    wd = _get_project_working_dir(name)
    if not os.path.isdir(wd):
        return jsonify({"error": "Working directory not found"}), 404

    if os.path.normpath(wd) == os.path.normpath(str(Path.home())):
        return jsonify({"error": "No working directory set for this project. Edit the project to set one.", "is_git": False, "no_workdir": True})

    try:
        future = _git_executor.submit(_collect_git_status, wd)
        result = future.result(timeout=15)  # Hard cap: entire git check must finish in 15s
        return jsonify(result)
    except FuturesTimeout:
        future.cancel()
        return jsonify({"error": "Git operations timed out", "is_git": True, "files": [], "diff": "", "branch": "", "log": []}), 504
    except Exception as e:
        return jsonify({"error": f"Git error: {str(e)}", "is_git": True, "files": [], "diff": "", "branch": "", "log": []}), 500


@app.route("/api/projects/<name>/git-remotes", methods=["GET"])
def api_git_remotes(name):
    """List the repo's remote URLs as browser-openable https links.

    A repo can push to several remotes (or one remote with multiple push
    URLs) - return them all so the UI can offer a choice.
    """
    wd = _get_project_working_dir(name)
    if not os.path.isdir(wd):
        return jsonify({"error": "Working directory not found"}), 404
    try:
        result = _run_git(["remote", "-v"], wd)
    except Exception:
        return jsonify({"remotes": []})
    if result.returncode != 0:
        return jsonify({"remotes": []})

    remotes = []
    seen = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        remote_name, url = parts[0], parts[1]
        # Normalize to an https URL the browser can open
        web = url
        if web.startswith("git@"):  # git@github.com:User/Repo.git
            web = "https://" + web[4:].replace(":", "/", 1)
        if web.endswith(".git"):
            web = web[:-4]
        if not web.startswith("http"):
            continue
        if web in seen:
            continue
        seen.add(web)
        remotes.append({"name": remote_name, "url": web})
    return jsonify({"remotes": remotes})


@app.route("/api/projects/<name>/readme", methods=["GET"])
def api_project_readme(name):
    """Return the project's README.md content for the Git tab viewer."""
    wd = _get_project_working_dir(name)
    if not os.path.isdir(wd):
        return jsonify({"error": "Working directory not found"}), 404
    for candidate in ("README.md", "readme.md", "Readme.md", "README.MD", "README"):
        path = os.path.join(wd, candidate)
        if os.path.isfile(path):
            with open(path, encoding="utf-8", errors="replace") as f:
                return jsonify({"filename": candidate, "content": f.read()})
    return jsonify({"error": "No README found in the working directory"}), 404


@app.route("/api/projects/<name>/git-init", methods=["POST"])
def api_git_init(name):
    """Initialize a git repo in the project's working directory."""
    wd = _get_project_working_dir(name)
    if not os.path.isdir(wd):
        return jsonify({"error": "Working directory not found"}), 404

    if os.path.normpath(wd) == os.path.normpath(str(Path.home())):
        return jsonify({"error": "Cannot initialize git in home directory. Set a working directory first."}), 400

    try:
        _run_git(["init"], wd, timeout=10)
        return jsonify({"status": "initialized", "path": wd})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


WORKSPACES_BASE = Path(os.getenv("CLAUDE_IDE_WORKSPACES",
                       Path.home() / "Claude-Code-IDE-Workspaces"))


@app.route("/api/default-workdir", methods=["GET"])
def api_default_workdir():
    """Return the default working directory path for a project name."""
    name = request.args.get("name", "").strip().replace(" ", "-").lower()
    if not name:
        return jsonify({"path": ""})
    return jsonify({"path": str(WORKSPACES_BASE / name)})


@app.route("/api/check-directory", methods=["POST"])
def api_check_directory():
    data = request.json
    path = data.get("path", "").strip()
    if not path:
        return jsonify({"error": "Path required"}), 400
    exists = os.path.isdir(path)
    return jsonify({"path": path, "exists": exists})


@app.route("/api/create-directory", methods=["POST"])
def api_create_directory():
    data = request.json
    path = data.get("path", "").strip()
    if not path:
        return jsonify({"error": "Path required"}), 400
    try:
        os.makedirs(path, exist_ok=True)
        return jsonify({"path": path, "created": True})
    except OSError as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/projects/<name>", methods=["DELETE"])
def api_delete_project(name):
    if delete_project(name):
        return jsonify({"status": "deleted"})
    return jsonify({"error": "Project not found"}), 404


# ── Archive API ──

@app.route("/api/projects/<name>/archive", methods=["POST"])
def api_archive_project(name):
    """Move a project into the archive so it no longer appears in the projects list."""
    if not _safe_project_name(name):
        return jsonify({"error": "Invalid project name"}), 400
    src = PROJECTS_DIR / name
    if not src.is_dir():
        return jsonify({"error": "Project not found"}), 404
    ARCHIVED_DIR.mkdir(parents=True, exist_ok=True)
    dest = ARCHIVED_DIR / name
    if dest.exists():
        return jsonify({"error": f"An archived project named '{name}' already exists"}), 409
    try:
        shutil.move(str(src), str(dest))
    except Exception as e:
        return jsonify({"error": f"Archive failed: {e}"}), 500
    print(f"[IDE] Archived project: {name}")
    return jsonify({"status": "archived", "name": name})


@app.route("/api/archived", methods=["GET"])
def api_list_archived():
    """List archived projects."""
    if not ARCHIVED_DIR.exists():
        return jsonify([])
    projects = []
    for d in sorted(ARCHIVED_DIR.iterdir()):
        if not d.is_dir():
            continue
        meta = _read_project_meta(d.name, base_dir=ARCHIVED_DIR) or {}
        sessions_dir = d / "sessions"
        session_count = len(list(sessions_dir.glob("*.json"))) if sessions_dir.exists() else 0
        projects.append({
            "name": d.name,
            "display_name": meta.get("display_name", d.name),
            "description": meta.get("description", ""),
            "work_related": meta.get("work_related", False),
            "session_count": session_count,
        })
    return jsonify(projects)


@app.route("/api/archived/<name>/unarchive", methods=["POST"])
def api_unarchive_project(name):
    """Restore an archived project back into the projects list."""
    if not _safe_project_name(name):
        return jsonify({"error": "Invalid project name"}), 400
    src = ARCHIVED_DIR / name
    if not src.is_dir():
        return jsonify({"error": "Archived project not found"}), 404
    dest = PROJECTS_DIR / name
    if dest.exists():
        return jsonify({"error": f"A project named '{name}' already exists"}), 409
    try:
        shutil.move(str(src), str(dest))
    except Exception as e:
        return jsonify({"error": f"Restore failed: {e}"}), 500
    print(f"[IDE] Restored project from archive: {name}")
    return jsonify({"status": "restored", "name": name})


@app.route("/api/projects/<name>/pin", methods=["POST"])
def api_pin_project(name):
    """Toggle the pinned state of a project."""
    meta = _read_project_meta(name)
    if meta is None:
        return jsonify({"error": "Project not found"}), 404
    meta["pinned"] = not meta.get("pinned", False)
    _write_project_meta(name, meta)
    return jsonify(meta)


@app.route("/api/projects/<name>/urls", methods=["GET", "PUT"])
def api_project_urls(name):
    """Get or replace the list of URLs (live web hosts / local URLs) for a project."""
    meta = _read_project_meta(name)
    if meta is None:
        return jsonify({"error": "Project not found"}), 404
    if request.method == "GET":
        return jsonify({"urls": meta.get("urls", [])})
    data = request.json or {}
    raw = data.get("urls", [])
    if not isinstance(raw, list):
        return jsonify({"error": "urls must be a list"}), 400
    cleaned = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        url = (entry.get("url") or "").strip()
        if not url:
            continue
        label = (entry.get("label") or "").strip() or url
        cleaned.append({"label": label, "url": url})
    meta["urls"] = cleaned
    _write_project_meta(name, meta)
    return jsonify({"urls": cleaned})


@app.route("/api/projects/<name>/work-related", methods=["POST"])
def api_toggle_work_related(name):
    """Set or toggle the work_related flag on a project."""
    meta = _read_project_meta(name)
    if meta is None:
        return jsonify({"error": "Project not found"}), 404
    data = request.json or {}
    if "work_related" in data:
        meta["work_related"] = bool(data["work_related"])
    else:
        meta["work_related"] = not meta.get("work_related", False)
    _write_project_meta(name, meta)
    return jsonify(meta)


@app.route("/api/projects/<name>/workdir", methods=["GET"])
def api_get_workdir(name):
    """Get the working directory for a project."""
    meta = _read_project_meta(name)
    if meta is None:
        return jsonify({"error": "Project not found"}), 404
    return jsonify({"working_directory": meta.get("working_directory", "")})


@app.route("/api/projects/<name>/open-workdir", methods=["POST"])
def api_open_workdir(name):
    """Open the project working directory in the system file explorer."""
    meta = _read_project_meta(name)
    if meta is None:
        return jsonify({"error": "Project not found"}), 404
    wd = meta.get("working_directory", "")
    if not wd or not os.path.isdir(wd):
        return jsonify({"error": "Working directory not found"}), 404
    try:
        import subprocess as _sp
        if sys.platform == "win32":
            _sp.Popen(f'explorer "{wd}"', shell=True)
        elif sys.platform == "darwin":
            _sp.Popen(["open", wd])
        else:
            _sp.Popen(["xdg-open", wd])
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/projects/<name>/workdir", methods=["PUT"])
def api_set_workdir(name):
    """Set the working directory for a project."""
    data = request.json
    new_wd = data.get("working_directory", "").strip()
    meta = _read_project_meta(name)
    if meta is None:
        return jsonify({"error": "Project not found"}), 404
    meta["working_directory"] = new_wd
    _write_project_meta(name, meta)
    return jsonify(meta)


@app.route("/api/projects/<name>/rename", methods=["POST"])
def api_rename_project(name):
    data = request.json
    new_display = data.get("display_name", "").strip()
    if not new_display:
        return jsonify({"error": "Display name required"}), 400
    meta = _read_project_meta(name)
    if meta is None:
        return jsonify({"error": "Project not found"}), 404
    meta["display_name"] = new_display
    _write_project_meta(name, meta)
    return jsonify(meta)


# ── Session API ──

@app.route("/api/projects/<project>/sessions", methods=["GET"])
def api_list_sessions(project):
    return jsonify(list_sessions(project))


@app.route("/api/projects/<project>/sessions/<session_id>", methods=["GET"])
def api_get_session(project, session_id):
    session = load_session(project, session_id)
    if session:
        return jsonify(session)
    return jsonify({"error": "Session not found"}), 404


@app.route("/api/projects/<project>/sessions/<session_id>/transcript", methods=["GET"])
def api_get_session_transcript(project, session_id):
    """Return a cleaned transcript for context injection."""
    session = load_session(project, session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    raw = session.get("raw_transcript", "")
    cleaned = _clean_transcript(raw, session.get("cols"), session.get("rows"))

    max_chars = 80000
    if len(cleaned) > max_chars:
        cleaned = "...(earlier conversation truncated)...\n" + cleaned[-max_chars:]

    return jsonify({
        "transcript": cleaned,
        "session_id": session_id,
        "summary": session.get("summary", ""),
    })


@app.route("/api/projects/<project>/sessions/<session_id>", methods=["DELETE"])
def api_delete_session(project, session_id):
    session_path = PROJECTS_DIR / project / "sessions" / f"{session_id}.json"
    if not session_path.exists():
        return jsonify({"error": "Session not found"}), 404
    session_path.unlink()
    return jsonify({"status": "deleted"})


@app.route("/api/projects/<project>/sessions/<session_id>/rename", methods=["POST"])
def api_rename_session(project, session_id):
    data = request.json
    new_summary = data.get("summary", "").strip()
    if not new_summary:
        return jsonify({"error": "Summary required"}), 400
    session_path = PROJECTS_DIR / project / "sessions" / f"{session_id}.json"
    if not session_path.exists():
        return jsonify({"error": "Session not found"}), 404
    with open(session_path, encoding="utf-8") as f:
        session = json.load(f)
    session["summary"] = new_summary
    with open(session_path, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2, ensure_ascii=False)
    return jsonify(session)


@app.route("/api/projects/<project>/sessions/<session_id>/move", methods=["POST"])
def api_move_session(project, session_id):
    """Move a session from one project to another."""
    data = request.json
    to_project = data.get("to_project", "").strip()
    if not to_project:
        return jsonify({"error": "Target project required"}), 400

    src = PROJECTS_DIR / project / "sessions" / f"{session_id}.json"
    if not src.exists():
        return jsonify({"error": "Session not found"}), 404

    dest_dir = PROJECTS_DIR / to_project / "sessions"
    if not dest_dir.parent.exists():
        return jsonify({"error": "Target project not found"}), 404
    dest_dir.mkdir(parents=True, exist_ok=True)

    dest = dest_dir / f"{session_id}.json"
    shutil.move(str(src), str(dest))

    # Update the project field inside the session JSON
    with open(dest, "r", encoding="utf-8") as f:
        session_data = json.load(f)
    session_data["project"] = to_project
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(session_data, f, indent=2, ensure_ascii=False)

    return jsonify({"status": "moved", "from": project, "to": to_project})


@app.route("/api/sessions/save", methods=["POST"])
def api_save_current_session():
    """Manually trigger saving a running terminal session."""
    data = request.json
    # Terminals are keyed by terminal_id; "sid" accepted as a legacy alias
    term_id = data.get("terminal_id") or data.get("sid")
    project = data.get("project")

    info = active_terminals.get(term_id)
    if not info:
        return jsonify({"error": "No active terminal for this session"}), 404

    record = info["record"]
    record["project"] = project
    # A blank summary keeps the name a resumed session was carrying instead
    # of wiping it (the save modal starts empty)
    record["summary"] = data.get("summary", "") or record.get("summary", "")
    record["tags"] = data.get("tags", [])
    filepath = save_session(record, project)
    return jsonify({"status": "saved", "filepath": filepath})


# ── Export API ──

@app.route("/api/projects/<project>/sessions/<session_id>/export", methods=["GET"])
def api_export_session(project, session_id):
    """Download a session as Markdown or plain text."""
    fmt = request.args.get("format", "txt")
    session = load_session(project, session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    raw = session.get("raw_transcript", "")
    cleaned = _clean_transcript(raw, session.get("cols"), session.get("rows"))
    summary = session.get("summary", "") or session_id
    tags = ", ".join(session.get("tags", []))
    created = session.get("created", "")
    ended = session.get("ended", "")

    if fmt == "md":
        content = (
            f"# Session: {summary}\n\n"
            f"**Project:** {project}\n"
            f"**Date:** {created} — {ended}\n"
        )
        if tags:
            content += f"**Tags:** {tags}\n"
        content += f"\n---\n\n```\n{cleaned}\n```\n"
        mimetype = "text/markdown"
        ext = "md"
    else:
        content = (
            f"Session: {summary}\n"
            f"Project: {project}\n"
            f"Date: {created} — {ended}\n"
        )
        if tags:
            content += f"Tags: {tags}\n"
        content += f"\n{'=' * 80}\n\n{cleaned}\n"
        mimetype = "text/plain"
        ext = "txt"

    return Response(
        content,
        mimetype=mimetype,
        headers={"Content-Disposition": f"attachment; filename={session_id}.{ext}"},
    )


# ── CLAUDE.md API ──

def _get_project_working_dir(project_name):
    """Resolve the working directory for a project."""
    meta = _read_project_meta(project_name)
    if meta:
        wd = meta.get("working_directory", "")
        if wd:
            return wd
    return str(Path.home())


@app.route("/api/projects/<project>/claude-md", methods=["GET"])
def api_get_claude_md(project):
    """Read the CLAUDE.md file for a project's working directory."""
    wd = _get_project_working_dir(project)
    filepath = Path(wd) / "CLAUDE.md"
    content = ""
    exists = False
    if filepath.exists():
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        exists = True
    return jsonify({"content": content, "path": str(filepath), "exists": exists})


@app.route("/api/projects/<project>/claude-md", methods=["PUT"])
def api_put_claude_md(project):
    """Write the CLAUDE.md file for a project's working directory."""
    wd = _get_project_working_dir(project)
    filepath = Path(wd) / "CLAUDE.md"
    data = request.json
    content = data.get("content", "")
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    return jsonify({"status": "saved", "path": str(filepath)})


# ── Search API ──

@app.route("/api/search", methods=["GET"])
def api_search():
    query = request.args.get("q", "").lower()
    if not query:
        return jsonify([])

    results = []
    for project_dir in PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        sessions_dir = project_dir / "sessions"
        if not sessions_dir.exists():
            continue
        for fp in sessions_dir.glob("*.json"):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    data = json.load(f)
                transcript = data.get("raw_transcript", "").lower()
                summary = data.get("summary", "").lower()
                if query in transcript or query in summary:
                    # Find snippet around match; fall back to the summary
                    # when the match is only in the summary (find() = -1
                    # would otherwise slice a meaningless snippet).
                    idx = transcript.find(query)
                    if idx >= 0:
                        start = max(0, idx - 100)
                        end = min(len(transcript), idx + len(query) + 100)
                        snippet = transcript[start:end]
                    else:
                        snippet = data.get("summary", "")

                    results.append({
                        "project": project_dir.name,
                        "session_id": data["id"],
                        "created": data["created"],
                        "summary": data.get("summary", ""),
                        "snippet": f"...{snippet}...",
                    })
            except Exception:
                continue

    return jsonify(results[:50])


# ── Import External Session API ──

@app.route("/api/local-sessions", methods=["GET"])
def api_list_local_sessions():
    """List all Claude Code sessions found in ~/.claude/history.jsonl."""
    history_file = Path.home() / ".claude" / "history.jsonl"
    if not history_file.exists():
        return jsonify([])

    sessions = {}
    try:
        with open(history_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                sid = entry.get("sessionId", "")
                if not sid:
                    continue
                ts = entry.get("timestamp", 0)
                if sid not in sessions:
                    sessions[sid] = {
                        "sessionId": sid,
                        "project": entry.get("project", ""),
                        "first_prompt": entry.get("display", "")[:120],
                        "timestamp": ts,
                        "prompt_count": 0,
                    }
                sessions[sid]["prompt_count"] += 1
                sessions[sid]["last_timestamp"] = ts
    except Exception as e:
        print(f"[IDE] Error reading history.jsonl: {e}")
        return jsonify([])

    # Sort by last activity, newest first
    result = sorted(sessions.values(),
                    key=lambda s: s.get("last_timestamp", 0), reverse=True)
    return jsonify(result)


@app.route("/api/import-session", methods=["POST"])
def api_import_session():
    """Import an external Claude Code session as a new IDE project."""
    data = request.json
    session_id = data.get("session_id", "").strip()
    project_name = data.get("project_name", "").strip().replace(" ", "-").lower()
    display_name = data.get("display_name", "").strip() or project_name
    original_dir = data.get("working_directory", "").strip()

    # Clean up session_id — user might paste "claude --resume <uuid>" instead of just the UUID
    if session_id.startswith("claude"):
        parts = session_id.split()
        session_id = parts[-1]  # Take the last part (the UUID)

    if not session_id or not project_name:
        return jsonify({"error": "Session ID and project name are required"}), 400

    # Check if project already exists
    project_dir = PROJECTS_DIR / project_name
    if project_dir.exists():
        return jsonify({"error": f"Project '{project_name}' already exists"}), 409

    # Determine working directory for the IDE project
    # For resume to work, we must track the ORIGINAL directory where the session ran
    if original_dir and os.path.isdir(original_dir):
        working_directory = original_dir
    else:
        working_directory = str(WORKSPACES_BASE / project_name)
        os.makedirs(working_directory, exist_ok=True)

    # Create the IDE project
    meta = create_project(project_name, display_name, "", working_directory)

    # Create a session record so it appears in the project's session list
    # working_directory must be the ORIGINAL dir so --resume finds the session
    session_record = {
        "id": f"sess_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}",
        "project": project_name,
        "claude_session_id": session_id,
        "created": datetime.now().isoformat(),
        "ended": "",
        "working_directory": original_dir or working_directory,
        "summary": data.get("summary", "Imported session"),
        "tags": ["imported"],
        "raw_transcript": "",
    }

    session_dir = project_dir / "sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    session_path = session_dir / f"{session_record['id']}.json"
    with open(session_path, "w", encoding="utf-8") as f:
        json.dump(session_record, f, indent=2, ensure_ascii=False)

    print(f"[IDE] Imported session {session_id} as project '{project_name}'")

    return jsonify({
        "status": "imported",
        "project": project_name,
        "session_id": session_record["id"],
        "claude_session_id": session_id,
        "working_directory": working_directory,
    }), 201


# ─── WebSocket Events ──────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    print(f"[IDE] Client connected: {request.sid}")


# How long a terminal survives without a browser attached (refresh, tab
# close, navigation) before it is auto-saved and killed. A page refresh
# reattaches within a second or two; the grace period is the safety net.
ORPHAN_GRACE_SECONDS = int(os.getenv("CLAUDE_IDE_ORPHAN_GRACE", "90"))


def _reap_orphan(term_id):
    """Grace period expired with nobody reattached - save and kill."""
    info = active_terminals.get(term_id)
    if not info or info.get("sid"):
        return  # gone already, or reattached in time
    record = _kill_terminal(term_id)
    if record:
        save_session(record, record.get("project"))
        print(f"[IDE] Orphaned terminal {term_id} auto-saved and killed after {ORPHAN_GRACE_SECONDS}s")


@socketio.on("disconnect")
def on_disconnect():
    import threading
    sid = request.sid
    print(f"[IDE] Client disconnected: {sid}")
    # Don't kill sessions on disconnect - orphan them with a grace timer so
    # a page refresh (or accidental navigation) can reattach and keep them.
    for tid in _terminal_ids_for_sid(sid):
        info = active_terminals.get(tid)
        if not info:
            continue
        info["sid"] = None
        info["orphaned_at"] = time.time()
        timer = threading.Timer(ORPHAN_GRACE_SECONDS, _reap_orphan, args=(tid,))
        timer.daemon = True
        info["orphan_timer"] = timer
        timer.start()
        print(f"[IDE] Terminal {tid} orphaned - reattach within {ORPHAN_GRACE_SECONDS}s or it auto-saves")


@socketio.on("reattach_terminal")
def on_reattach_terminal(data):
    """Rebind an orphaned terminal to a new socket (page refresh survival)."""
    sid = request.sid
    tid = (data or {}).get("terminal_id")
    info = active_terminals.get(tid)
    if not info:
        emit("terminal_error", {"terminal_id": tid, "code": "not_running",
                                "message": "Session is no longer running"})
        return
    if info.get("sid"):
        emit("terminal_error", {"terminal_id": tid, "code": "attached_elsewhere",
                                "message": "Session is attached to another window"})
        return

    timer = info.pop("orphan_timer", None)
    if timer:
        timer.cancel()
    info.pop("orphaned_at", None)
    info["sid"] = sid

    record = info["record"]
    # Replay the output tail so the screen isn't blank; the client then sends
    # a resize nudge which makes the TUI repaint itself at the current size.
    tail = "".join(record.get("raw_output", []))[-200000:]
    if tail:
        emit("terminal_output", {"terminal_id": tid, "data": tail})
    emit("terminal_ready", {
        "status": "reattached",
        "terminal_id": tid,
        "claude_session_id": record.get("claude_session_id"),
        "working_directory": record.get("working_directory"),
    })
    print(f"[IDE] Terminal {tid} reattached to {sid}")


def _permission_mode_flags(mode):
    """Map a permission mode name to Claude Code CLI flags.

    CLI flags override the user's settings.json, so "default" must send
    NO flags - that is what lets the user's own defaultMode (e.g.
    bypassPermissions in ~/.claude/settings.json) take effect.
    "askPermissions" sends an explicit --permission-mode manual so it
    forces prompting even when the user's global default is permissive.
    """
    if mode == "autoAcceptEdits":
        return " --permission-mode acceptEdits"
    elif mode == "planMode":
        return " --permission-mode plan"
    elif mode == "bypassPermissions":
        return " --dangerously-skip-permissions"
    elif mode == "askPermissions":
        return " --permission-mode manual"
    # "default": no extra flags - the user's settings.json decides
    return ""


@socketio.on("start_terminal")
def on_start_terminal(data):
    """Start a new Claude Code terminal session."""
    sid = request.sid
    project = data.get("project")
    term_id = data.get("terminal_id") or uuid.uuid4().hex
    # Fall back to "default" (no CLI flags) when the field is missing, e.g. a
    # stale cached frontend - never force prompting unless explicitly chosen.
    permission_mode = data.get("permission_mode", "default")
    project_path = None

    if project:
        meta = _read_project_meta(project)
        if meta:
            wd = meta.get("working_directory", "")
            if wd and os.path.isdir(wd):
                project_path = wd

    # Generate a Claude session ID so we can resume later via claude --resume
    claude_session_id = str(uuid.uuid4())
    cmd = f"{CLAUDE_CMD} --session-id {claude_session_id}{_permission_mode_flags(permission_mode)}"

    spawned = _spawn_terminal(sid, project_path, cmd=cmd, claude_session_id=claude_session_id,
                              term_id=term_id, account=data.get("account"))
    if spawned:
        active_terminals[spawned]["record"]["project"] = project
        emit("terminal_ready", {
            "status": "ok",
            "terminal_id": spawned,
            "claude_session_id": claude_session_id,
            "working_directory": project_path or str(Path.home()),
        })
    else:
        emit("terminal_error", {"terminal_id": term_id, "message": "Failed to spawn terminal"})


@socketio.on("resume_session")
def on_resume_session(data):
    """Resume a previous session using Claude Code's native --resume flag."""
    sid = request.sid
    project = data.get("project")
    term_id = data.get("terminal_id") or uuid.uuid4().hex
    claude_session_id = data.get("claude_session_id", "")
    permission_mode = data.get("permission_mode", "default")
    session_wd = data.get("working_directory", "")
    project_path = None

    # Clean up session ID — strip "claude --resume" prefix if present
    if claude_session_id.startswith("claude"):
        claude_session_id = claude_session_id.split()[-1]

    if not claude_session_id:
        emit("terminal_error", {"terminal_id": term_id, "message": "No Claude session ID found for this session"})
        return

    # Refuse to open the same Claude session twice - two processes would be
    # writing the same conversation transcript.
    for other in active_terminals.values():
        if other["record"].get("claude_session_id") == claude_session_id:
            emit("terminal_error", {
                "terminal_id": term_id,
                "code": "already_open",
                "message": "This session is already open in another tab",
            })
            return

    # Prefer the session's original working directory (where Claude stored the
    # conversation), then fall back to the project's configured directory.
    if session_wd and os.path.isdir(session_wd):
        project_path = session_wd
    elif project:
        meta = _read_project_meta(project)
        if meta:
            wd = meta.get("working_directory", "")
            if wd and os.path.isdir(wd):
                project_path = wd

    # A resumed session must run under the account that created it - the
    # conversation transcript lives in that account's config dir.
    cmd = f"{CLAUDE_CMD} --resume {claude_session_id}{_permission_mode_flags(permission_mode)}"
    spawned = _spawn_terminal(sid, project_path, cmd=cmd, claude_session_id=claude_session_id,
                              term_id=term_id, account=data.get("account"))
    if spawned:
        active_terminals[spawned]["record"]["project"] = project
        # Carry the saved session's display name into the live record so tab
        # tooltips (and reattach after a page refresh) can show it.
        active_terminals[spawned]["record"]["summary"] = data.get("summary", "")
        emit("terminal_ready", {
            "status": "ok",
            "terminal_id": spawned,
            "claude_session_id": claude_session_id,
            "working_directory": project_path or str(Path.home()),
        })
    else:
        emit("terminal_error", {"terminal_id": term_id, "message": "Failed to spawn terminal"})


@socketio.on("terminal_input")
def on_terminal_input(data):
    """Receive keyboard input from the browser terminal."""
    tid = _resolve_terminal_id(request.sid, data)
    if tid:
        _write_to_terminal(tid, data.get("data", ""))


@socketio.on("resize_terminal")
def on_resize(data):
    """Handle terminal resize events."""
    tid = _resolve_terminal_id(request.sid, data)
    info = active_terminals.get(tid) if tid else None
    if not info:
        return
    rows = data.get("rows", 24)
    cols = data.get("cols", 80)
    # Remember the terminal size so transcript cleaning can replay the raw
    # output through a virtual screen of the SAME width (see _clean_transcript)
    info["record"]["cols"] = cols
    info["record"]["rows"] = rows
    try:
        if info["type"] == "winpty":
            info["proc"].setwinsize(rows, cols)
        elif info["type"] == "pty":
            import struct
            import fcntl
            import termios
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(info["master_fd"], termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


@socketio.on("stop_terminal")
def on_stop_terminal(data):
    """Stop a terminal and save its session."""
    sid = request.sid
    project = data.get("project")
    tid = _resolve_terminal_id(sid, data, allow_orphaned=True)
    record = _kill_terminal(tid) if tid else None
    if record:
        record["summary"] = data.get("summary", "")
        record["tags"] = data.get("tags", [])
        filepath = save_session(record, project)
        emit("session_saved", {"terminal_id": tid, "filepath": filepath, "id": record["id"]})
    else:
        # Never fail silently - the user just clicked Stop & Save and needs
        # to know nothing was there to save (e.g. the process already exited
        # and was auto-saved by _finalize_exited_terminal).
        emit("terminal_error", {
            "terminal_id": (data or {}).get("terminal_id"),
            "code": "not_running",
            "message": "Session already ended - nothing left to save",
        })


@socketio.on("discard_terminal")
def on_discard_terminal(data):
    """Stop a terminal without saving."""
    sid = request.sid
    tid = _resolve_terminal_id(sid, data, allow_orphaned=True)
    if tid:
        _kill_terminal(tid)  # Kill process, discard the record
        print(f"[IDE] Session discarded by user: {sid} terminal {tid}")


# ─── Entry Point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Werkzeug prints a "development server" warning on startup; this server is
    # localhost-only by design, so drop that one message (request logs still show)
    import logging
    logging.getLogger("werkzeug").addFilter(
        lambda record: "development server" not in record.getMessage()
    )
    print("=" * 50)
    print("  Claude Code IDE")
    print(f"  Running as admin: {_is_admin()}")
    port = int(os.getenv("CLAUDE_IDE_PORT", 5050))
    print(f"  Open http://localhost:{port} in your browser")
    print(f"  Data directory: {DATA_DIR}")
    print("=" * 50)
    socketio.run(app, host="127.0.0.1", port=port, debug=False, allow_unsafe_werkzeug=True)
