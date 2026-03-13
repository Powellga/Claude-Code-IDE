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
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_from_directory
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

def _spawn_terminal(sid, project_path=None, resume_cmd=None):
    """
    Spawn a Claude Code process in a PTY and wire it to the WebSocket.

    On Windows, uses pywinpty. On Unix, uses pty module.
    Falls back to subprocess if PTY is unavailable.
    """
    import threading

    cwd = project_path or str(Path.home())
    cmd = resume_cmd or CLAUDE_CMD

    # Session recording buffer
    session_record = {
        "id": f"sess_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}",
        "created": datetime.now().isoformat(),
        "working_directory": cwd,
        "project": None,
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
                "session_count": session_count,
            })
    return projects


def create_project(name, display_name=None, description=""):
    """Create a new project."""
    project_dir = PROJECTS_DIR / name
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "sessions").mkdir(exist_ok=True)

    meta = {
        "name": name,
        "display_name": display_name or name,
        "description": description,
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


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


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
    meta = create_project(name, data.get("display_name"), data.get("description", ""))
    return jsonify(meta), 201


@app.route("/api/projects/<name>", methods=["DELETE"])
def api_delete_project(name):
    if delete_project(name):
        return jsonify({"status": "deleted"})
    return jsonify({"error": "Project not found"}), 404


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
        # Use project directory as working directory if it maps to a real path
        project_meta_file = PROJECTS_DIR / project / "project.json"
        if project_meta_file.exists():
            with open(project_meta_file) as f:
                meta = json.load(f)
                project_path = meta.get("working_directory")

    success = _spawn_terminal(sid, project_path)
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
