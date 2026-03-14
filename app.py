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
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_from_directory, Response
from flask_socketio import SocketIO, emit

# ─── Configuration ──────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent
DATA_DIR = Path(os.getenv("CLAUDE_IDE_DATA", BASE_DIR / "data"))
PROJECTS_DIR = DATA_DIR / "projects"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

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

def _spawn_terminal(sid, project_path=None, cmd=None, claude_session_id=None):
    """
    Spawn a Claude Code process in a PTY and wire it to the WebSocket.

    On Windows, uses pywinpty. On Unix, uses pty module.
    Falls back to subprocess if PTY is unavailable.
    """
    import threading

    cwd = project_path or str(Path.home())
    cmd = cmd or CLAUDE_CMD

    # Session recording buffer
    session_record = {
        "id": f"sess_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}",
        "created": datetime.now().isoformat(),
        "working_directory": cwd,
        "project": None,
        "claude_session_id": claude_session_id,
        "raw_output": [],
        "raw_input": [],
    }

    if sys.platform == "win32":
        try:
            from winpty import PtyProcess
            # Spawn Claude Code in a Windows PTY
            proc = PtyProcess.spawn(cmd, cwd=cwd)

            def read_output():
                """Read PTY output and send to browser via WebSocket."""
                try:
                    while proc.isalive():
                        try:
                            data = proc.read(4096)
                            if data:
                                session_record["raw_output"].append(data)
                                socketio.emit("terminal_output", {"data": data}, to=sid)
                        except EOFError:
                            break
                        except Exception:
                            time.sleep(0.05)
                except Exception:
                    pass
                finally:
                    socketio.emit("terminal_exit", {"code": 0}, to=sid)

            thread = threading.Thread(target=read_output, daemon=True)
            thread.start()

            active_terminals[sid] = {
                "proc": proc,
                "thread": thread,
                "record": session_record,
                "type": "winpty",
            }
            return True

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
            env={**os.environ, "TERM": "xterm-256color"},
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
                            socketio.emit("terminal_output", {"data": data}, to=sid)
            except (OSError, ValueError):
                pass
            finally:
                os.close(master_fd)
                socketio.emit("terminal_exit", {"code": proc.returncode or 0}, to=sid)

        thread = threading.Thread(target=read_output, daemon=True)
        thread.start()

        active_terminals[sid] = {
            "proc": proc,
            "master_fd": master_fd,
            "thread": thread,
            "record": session_record,
            "type": "pty",
        }
        return True

    except (ImportError, OSError):
        # No PTY available — use basic subprocess
        import subprocess

        proc = subprocess.Popen(
            cmd if isinstance(cmd, list) else cmd.split(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            env={**os.environ, "TERM": "xterm-256color"},
        )

        def read_output():
            try:
                for line in iter(proc.stdout.readline, b""):
                    data = line.decode("utf-8", errors="replace")
                    session_record["raw_output"].append(data)
                    socketio.emit("terminal_output", {"data": data}, to=sid)
            except Exception:
                pass
            finally:
                socketio.emit("terminal_exit", {"code": proc.returncode or 0}, to=sid)

        thread = threading.Thread(target=read_output, daemon=True)
        thread.start()

        active_terminals[sid] = {
            "proc": proc,
            "thread": thread,
            "record": session_record,
            "type": "subprocess",
        }
        return True


def _write_to_terminal(sid, data):
    """Send keyboard input to the terminal process."""
    info = active_terminals.get(sid)
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


def _kill_terminal(sid):
    """Terminate the terminal process and return the session record."""
    info = active_terminals.pop(sid, None)
    if not info:
        return None

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


# ─── Session Persistence ───────────────────────────────────────────────────

def save_session(record, project_name=None):
    """Save a session record to disk."""
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
        "raw_transcript": "".join(record.get("raw_output", [])),
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(save_data, f, indent=2, ensure_ascii=False)

    return str(filepath)


def _clean_transcript(raw_text):
    """Render raw PTY output through a virtual terminal to get readable text."""
    import pyte

    screen = pyte.HistoryScreen(120, 50, history=100000)
    stream = pyte.Stream(screen)
    stream.feed(raw_text)

    # Collect scrollback history + current screen
    lines = []
    for hist_line in screen.history.top:
        chars = ''
        for col in range(120):
            if col in hist_line:
                chars += hist_line[col].data
            else:
                chars += ' '
        lines.append(chars.rstrip())

    for row in screen.display:
        lines.append(row.rstrip())

    text = '\n'.join(lines)

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
    for fp in sorted(session_dir.glob("*.json"), reverse=True):
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
                })
        except Exception:
            continue
    return sessions


# ─── Project Management ────────────────────────────────────────────────────

def list_projects():
    """List all projects."""
    projects = []
    for d in sorted(PROJECTS_DIR.iterdir()):
        if d.is_dir():
            meta_file = d / "project.json"
            meta = {}
            if meta_file.exists():
                with open(meta_file, "r") as f:
                    meta = json.load(f)

            session_count = len(list((d / "sessions").glob("*.json"))) if (d / "sessions").exists() else 0
            projects.append({
                "name": d.name,
                "display_name": meta.get("display_name", d.name),
                "created": meta.get("created", ""),
                "description": meta.get("description", ""),
                "pinned": meta.get("pinned", False),
                "session_count": session_count,
            })
    # Sort pinned projects to the top
    projects.sort(key=lambda p: (not p["pinned"], p["name"]))
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
    with open(project_dir / "project.json", "w") as f:
        json.dump(meta, f, indent=2)

    return meta


def delete_project(name):
    """Delete a project and all its sessions."""
    import shutil
    project_dir = PROJECTS_DIR / name
    if project_dir.exists():
        shutil.rmtree(project_dir)
        return True
    return False


# ─── Settings ────────────────────────────────────────────────────────────────

SETTINGS_FILE = DATA_DIR / "settings.json"

def load_settings():
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    return {"claude_cmd": CLAUDE_CMD, "default_project": "", "font_size": 14}

def save_settings(settings):
    with open(SETTINGS_FILE, "w") as f:
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
    save_settings(settings)
    return jsonify(settings)


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
    for _ in range(60):
        time.sleep(0.5)
        try:
            img = ImageGrab.grabclipboard()
            if img is not None:
                filename = f"screenshot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
                filepath = os.path.join(dest_dir, filename)
                img.save(filepath, "PNG")
                return jsonify({
                    "status": "success",
                    "filename": filename,
                    "path": filepath,
                    "size": os.path.getsize(filepath),
                })
        except Exception:
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


@app.route("/api/projects/<name>/git-status", methods=["GET"])
def api_git_status(name):
    """Get git status and diff for the project's working directory."""
    import subprocess

    wd = _get_project_working_dir(name)
    if not os.path.isdir(wd):
        return jsonify({"error": "Working directory not found"}), 404

    # Check if it's a git repo
    try:
        subprocess.run(["git", "rev-parse", "--git-dir"], cwd=wd,
                       capture_output=True, check=True, timeout=5)
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return jsonify({"error": "Not a git repository", "is_git": False})

    result = {"is_git": True, "files": [], "diff": "", "branch": ""}

    # Get current branch
    try:
        branch = subprocess.run(["git", "branch", "--show-current"], cwd=wd,
                                capture_output=True, text=True, timeout=5)
        result["branch"] = branch.stdout.strip()
    except Exception:
        pass

    # Get status (porcelain for easy parsing)
    try:
        status = subprocess.run(["git", "status", "--porcelain"], cwd=wd,
                                capture_output=True, text=True, timeout=10)
        for line in status.stdout.strip().split("\n"):
            if not line.strip():
                continue
            code = line[:2]
            filepath = line[3:]
            result["files"].append({"status": code.strip(), "path": filepath})
    except Exception:
        pass

    # Get diff (staged + unstaged)
    try:
        diff = subprocess.run(["git", "diff", "HEAD"], cwd=wd,
                              capture_output=True, text=True, timeout=15)
        result["diff"] = diff.stdout[:100000]  # Cap at 100KB
    except Exception:
        # Might fail if no commits yet, try just unstaged
        try:
            diff = subprocess.run(["git", "diff"], cwd=wd,
                                  capture_output=True, text=True, timeout=15)
            result["diff"] = diff.stdout[:100000]
        except Exception:
            pass

    # Get recent log (last 5 commits)
    try:
        log = subprocess.run(["git", "log", "--oneline", "-5"], cwd=wd,
                             capture_output=True, text=True, timeout=5)
        result["log"] = log.stdout.strip().split("\n") if log.stdout.strip() else []
    except Exception:
        result["log"] = []

    return jsonify(result)


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


@app.route("/api/projects/<name>/pin", methods=["POST"])
def api_pin_project(name):
    """Toggle the pinned state of a project."""
    project_dir = PROJECTS_DIR / name
    meta_path = project_dir / "project.json"
    if not meta_path.exists():
        return jsonify({"error": "Project not found"}), 404
    with open(meta_path) as f:
        meta = json.load(f)
    meta["pinned"] = not meta.get("pinned", False)
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    return jsonify(meta)


@app.route("/api/projects/<name>/rename", methods=["POST"])
def api_rename_project(name):
    data = request.json
    new_display = data.get("display_name", "").strip()
    if not new_display:
        return jsonify({"error": "Display name required"}), 400
    project_dir = PROJECTS_DIR / name
    meta_path = project_dir / "project.json"
    if not meta_path.exists():
        return jsonify({"error": "Project not found"}), 404
    with open(meta_path) as f:
        meta = json.load(f)
    meta["display_name"] = new_display
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
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
    cleaned = _clean_transcript(raw)

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
    with open(session_path) as f:
        session = json.load(f)
    session["summary"] = new_summary
    with open(session_path, "w") as f:
        json.dump(session, f, indent=2)
    return jsonify(session)


@app.route("/api/sessions/save", methods=["POST"])
def api_save_current_session():
    """Manually trigger saving the current terminal session."""
    data = request.json
    sid = data.get("sid")
    project = data.get("project")

    info = active_terminals.get(sid)
    if not info:
        return jsonify({"error": "No active terminal for this session"}), 404

    record = info["record"]
    record["project"] = project
    record["summary"] = data.get("summary", "")
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
    cleaned = _clean_transcript(raw)
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


# ── Compare API ──

@app.route("/api/sessions/compare", methods=["GET"])
def api_compare_sessions():
    """Return cleaned transcripts for two sessions for side-by-side comparison."""
    project_a = request.args.get("projectA", "")
    session_a = request.args.get("sessionA", "")
    project_b = request.args.get("projectB", "")
    session_b = request.args.get("sessionB", "")

    result = {}
    for label, proj, sid in [("a", project_a, session_a), ("b", project_b, session_b)]:
        sess = load_session(proj, sid)
        if not sess:
            return jsonify({"error": f"Session {label.upper()} not found"}), 404
        raw = sess.get("raw_transcript", "")
        cleaned = _clean_transcript(raw)
        max_chars = 80000
        if len(cleaned) > max_chars:
            cleaned = "...(earlier conversation truncated)...\n" + cleaned[-max_chars:]
        result[label] = {
            "session_id": sid,
            "summary": sess.get("summary", ""),
            "created": sess.get("created", ""),
            "transcript": cleaned,
        }

    return jsonify(result)


# ── CLAUDE.md API ──

def _get_project_working_dir(project_name):
    """Resolve the working directory for a project."""
    meta_file = PROJECTS_DIR / project_name / "project.json"
    if meta_file.exists():
        with open(meta_file, "r") as f:
            meta = json.load(f)
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
                    # Find snippet around match
                    idx = transcript.find(query)
                    start = max(0, idx - 100)
                    end = min(len(transcript), idx + len(query) + 100)
                    snippet = transcript[start:end]

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


# ─── WebSocket Events ──────────────────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    print(f"[IDE] Client connected: {request.sid}")


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    print(f"[IDE] Client disconnected: {sid}")
    record = _kill_terminal(sid)
    if record:
        # Auto-save on disconnect
        save_session(record, record.get("project"))


@socketio.on("start_terminal")
def on_start_terminal(data):
    """Start a new Claude Code terminal session."""
    sid = request.sid
    project = data.get("project")
    project_path = None

    if project:
        project_meta_file = PROJECTS_DIR / project / "project.json"
        if project_meta_file.exists():
            with open(project_meta_file) as f:
                meta = json.load(f)
                wd = meta.get("working_directory", "")
                if wd and os.path.isdir(wd):
                    project_path = wd

    # Generate a Claude session ID so we can resume later via claude --resume
    claude_session_id = str(uuid.uuid4())
    cmd = f"{CLAUDE_CMD} --session-id {claude_session_id}"

    success = _spawn_terminal(sid, project_path, cmd=cmd, claude_session_id=claude_session_id)
    if success:
        active_terminals[sid]["record"]["project"] = project
        emit("terminal_ready", {"status": "ok"})
    else:
        emit("terminal_error", {"message": "Failed to spawn terminal"})


@socketio.on("resume_session")
def on_resume_session(data):
    """Resume a previous session using Claude Code's native --resume flag."""
    sid = request.sid
    project = data.get("project")
    claude_session_id = data.get("claude_session_id", "")
    project_path = None

    if not claude_session_id:
        emit("terminal_error", {"message": "No Claude session ID found for this session"})
        return

    # First try the working directory from the saved session
    saved_wd = data.get("working_directory", "")
    if saved_wd and os.path.isdir(saved_wd):
        project_path = saved_wd
    elif project:
        # Fall back to the project's configured working directory
        project_meta_file = PROJECTS_DIR / project / "project.json"
        if project_meta_file.exists():
            with open(project_meta_file) as f:
                meta = json.load(f)
                wd = meta.get("working_directory", "")
                if wd and os.path.isdir(wd):
                    project_path = wd

    cmd = f"{CLAUDE_CMD} --resume {claude_session_id}"
    success = _spawn_terminal(sid, project_path, cmd=cmd, claude_session_id=claude_session_id)
    if success:
        active_terminals[sid]["record"]["project"] = project
        emit("terminal_ready", {"status": "ok"})
    else:
        emit("terminal_error", {"message": "Failed to spawn terminal"})


@socketio.on("terminal_input")
def on_terminal_input(data):
    """Receive keyboard input from the browser terminal."""
    _write_to_terminal(request.sid, data.get("data", ""))


@socketio.on("resize_terminal")
def on_resize(data):
    """Handle terminal resize events."""
    sid = request.sid
    info = active_terminals.get(sid)
    if not info:
        return
    rows = data.get("rows", 24)
    cols = data.get("cols", 80)
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
    """Stop the current terminal and save the session."""
    sid = request.sid
    project = data.get("project")
    record = _kill_terminal(sid)
    if record:
        record["summary"] = data.get("summary", "")
        record["tags"] = data.get("tags", [])
        filepath = save_session(record, project)
        emit("session_saved", {"filepath": filepath, "id": record["id"]})


# ─── Entry Point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 50)
    print("  Claude Code IDE")
    port = int(os.getenv("CLAUDE_IDE_PORT", 5050))
    print(f"  Open http://localhost:{port} in your browser")
    print(f"  Data directory: {DATA_DIR}")
    print("=" * 50)
    socketio.run(app, host="127.0.0.1", port=port, debug=False, allow_unsafe_werkzeug=True)
