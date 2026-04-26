# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Claude Code IDE** - A local web IDE that wraps Claude Code's CLI with real-time terminal emulation, project/session management, file processing, and MCP integration. Built in Python (Flask) and vanilla JavaScript - no frameworks, no Electron, no cloud dependencies.

**Repo:** https://github.com/Powellga/Claude-Code-IDE.git

## Running the Server

```bash
# Activate venv and start (runs backup first)
start-ide.bat

# Or manually:
.venv\Scripts\activate
python app.py
```

Server runs on **http://localhost:5050** (not 5000 despite the docstring in app.py). Requires admin elevation on Windows - `app.py` auto-elevates via UAC on startup. Restart the server to pick up backend changes. Frontend changes (JS/CSS/HTML) reload in the browser.

## Validating Changes

```bash
# Python syntax check
python -c "import ast; ast.parse(open('app.py').read()); print('OK')"

# JavaScript syntax check
node -c static/js/app.js

# Run the backup system
python backup.py
python backup.py --restore      # list backups
python backup.py --restore 0    # restore most recent
```

There are no automated tests or linters configured. The `test_*.py` files are one-off scripts for specific issues (admin inheritance, child processes), not a test suite.

## Architecture

Single-page app: Flask backend serves one HTML page. Browser connects via Socket.IO WebSocket for terminal I/O, plus REST API for everything else.

```
Browser (xterm.js + vanilla JS + Socket.IO client)
    |
    v  WebSocket + REST API
    |
Flask/SocketIO Server (app.py)
    |
    +-- PTY process (pywinpty on Windows, pty on Unix, subprocess fallback)
    |       \-- Claude Code CLI (--session-id / --resume)
    |
    +-- pyte (virtual terminal emulator for transcript cleaning)
    |
    +-- JSON file storage (data/projects/, data/settings.json)
```

## Key Files

| File | Lines | Role |
|------|-------|------|
| `app.py` | ~1520 | Entire backend: PTY management, session persistence, project CRUD, all REST endpoints, all WebSocket events |
| `static/js/app.js` | ~1880 | Entire frontend: terminal setup, Socket.IO client, sidebar, tabs, modals, context menus, file tree, git panel |
| `templates/index.html` | ~313 | Single-page layout: tabs, modals, panels (Jinja2 but minimal templating) |
| `static/css/style.css` | ~778 | Dark theme using CSS custom properties |
| `conpty_process.py` | ~414 | Direct Windows ConPTY API via ctypes - bypasses pywinpty to properly inherit admin tokens |
| `backup.py` | ~231 | Local zip snapshots + git push to a separate backup repo |
| `start-ide.bat` | Launcher | Checks admin, activates venv, runs backup, opens browser, starts server |

## Backend Structure (app.py)

The backend is one file organized into labeled sections:

1. **Admin Elevation** (lines ~25-68) - Auto-elevates to admin via UAC on Windows startup
2. **Configuration** (lines ~70-83) - `BASE_DIR`, `DATA_DIR`, `PROJECTS_DIR`, env vars
3. **Flask App** (lines ~85-92) - App + SocketIO init, `active_terminals` dict
4. **Terminal Management** (lines ~95-277) - `_spawn_terminal()`, `_write_to_terminal()`, `_kill_terminal()` with three backends: winpty, pty, subprocess
5. **Session Persistence** (lines ~280-373) - Save/load/list sessions, `_clean_transcript()` via pyte
6. **Project Management** (lines ~375-465) - CRUD for projects, auto-creates CLAUDE.md in working dirs
7. **Settings** (lines ~468-482) - Load/save settings JSON
8. **REST Routes** (lines ~483-1372) - All `/api/*` endpoints
9. **WebSocket Events** (lines ~1374-1509) - `start_terminal`, `resume_session`, `terminal_input`, `resize_terminal`, `stop_terminal`, `discard_terminal`

## Frontend Structure (app.js)

Vanilla JS, no build step. Key patterns:
- All state is in module-level variables (e.g., `currentProject`, `term`, `socket`)
- Socket.IO events for terminal I/O: `terminal_output`, `terminal_input`, `terminal_ready`, `terminal_exit`
- REST calls via `fetch()` to `/api/*` endpoints
- Context menus built dynamically on right-click for projects and sessions
- Tabs: Terminal, Session Viewer, Compare, CLAUDE.md Editor, Git

## Data Storage

```
data/
  settings.json              # IDE settings (claude_cmd, default_project, font_size)
  projects/
    <project-name>/
      project.json           # Name, display_name, description, working_directory, pinned, created, work_related, urls[]
      sessions/
        sess_YYYYMMDD_HHMMSS_<hex>.json   # Session record with raw_transcript, claude_session_id, tags
  unsorted_sessions/         # Sessions saved without a project
```

## Critical Windows Patterns

- **Always use `encoding="utf-8"`** when reading/writing session JSON files. Raw PTY output contains escape sequences that crash Python's default cp1252 codec.
- **Admin elevation is required** - pywinpty needs it to properly spawn Claude Code. The ConPTY module (`conpty_process.py`) exists because pywinpty doesn't reliably pass admin tokens to child processes.
- **Session resume depends on working directory** - Claude Code's `--resume <uuid>` must run from the same directory the session was originally started in. The `working_directory` field in session JSON tracks this.
- **Save destination derived from workdir, not UI** - `save_session()` calls `_project_for_workdir()` to find the project whose `working_directory` matches the session record's, and writes there regardless of the project name the UI passed in. This prevents sessions from being filed under whichever project happened to be selected in the sidebar at save time. The frontend also blocks `selectProject()` while a terminal is running (with a Quick-Resume bypass) as a defense-in-depth UX guardrail.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_IDE_DATA` | `./data` | Data storage location |
| `CLAUDE_IDE_SHELL` | `powershell.exe` | Shell for PTY |
| `CLAUDE_IDE_CMD` | `claude` | Claude Code CLI command |
| `CLAUDE_IDE_PORT` | `5050` | Server port |
| `CLAUDE_IDE_SECRET` | (dev key) | Flask secret key |

## Project-Specific Instructions

- **AutoSave** - Each time we complete updating code, ask if the user wants to push to GitHub. If yes, always update the README.md (create it if it does not exist).
