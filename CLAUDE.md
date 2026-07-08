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
| `conpty_process.py` | ~430 | EXPERIMENTAL, not imported by app.py. Direct Windows ConPTY API via ctypes, kept as a fallback if pywinpty ever breaks admin inheritance. Has a known blocking-read issue (see its docstring) that must be fixed before wiring it in |
| `backup.py` | ~231 | Local zip snapshots + git push to a separate backup repo |
| `start-ide.bat` | Launcher | Checks admin, activates venv, runs backup, opens browser, starts server |

## Backend Structure (app.py)

The backend is one file organized into labeled sections:

1. **Admin Elevation** (lines ~25-68) - Auto-elevates to admin via UAC on Windows startup
2. **Configuration** (lines ~70-83) - `BASE_DIR`, `DATA_DIR`, `PROJECTS_DIR`, env vars
3. **Flask App** (lines ~85-92) - App + SocketIO init, `active_terminals` dict keyed by `terminal_id` (NOT socket sid - one browser page can hold up to 8 concurrent session tabs; each entry stores its owning `sid` for output routing and disconnect cleanup)
4. **Terminal Management** (lines ~95-277) - `_spawn_terminal()`, `_write_to_terminal()`, `_kill_terminal()` with three backends: winpty, pty, subprocess
5. **Session Persistence** (lines ~280-373) - Save/load/list sessions, `_clean_transcript()` via pyte
6. **Project Management** (lines ~375-465) - CRUD for projects, auto-creates CLAUDE.md in working dirs
7. **Settings** (lines ~468-482) - Load/save settings JSON
8. **REST Routes** (lines ~483-1372) - All `/api/*` endpoints
9. **WebSocket Events** - `start_terminal`, `resume_session`, `reattach_terminal`, `terminal_input`, `resize_terminal`, `stop_terminal`, `discard_terminal`. Every event carries a `terminal_id` (client-generated for start/resume); `_resolve_terminal_id()` validates ownership and falls back to the connection's only terminal when the field is missing (legacy frontend). Disconnect does NOT kill sessions: it orphans them (`sid = None`) with a grace timer (`CLAUDE_IDE_ORPHAN_GRACE`, default 90s). A reloading page fetches `GET /api/active-terminals` and reattaches via `reattach_terminal`, which cancels the reaper, rebinds the sid, replays the output tail, and the client sends a resize nudge to make the TUI repaint. Only when the grace expires does `_reap_orphan()` auto-save and kill. PTY reader threads resolve the terminal's CURRENT sid per emit (`_current_sid()`) - never capture the spawn-time sid
10. **Usage API** - `/api/usage` parses Claude Code's own jsonl transcripts (`~/.claude/projects/*/<claude_session_id>.jsonl`) matched to IDE sessions. Streamed responses repeat identical usage per message id - dedupe by id before summing. Totals cached by mtime+size in `data/usage_cache.json`

## Frontend Structure (app.js)

Vanilla JS, no build step. Key patterns:
- All state is in module-level variables (e.g., `activeProject`, `socket`)
- Multi-session tabs: `termSessions` maps `terminal_id` -> session object (own xterm instance, container div, tab element, project, running flag). `activeSess()` returns the active tab's session; toolbar buttons and upload/screenshot/import prompts always target the active tab. A tab captures its project from the sidebar at spawn time - changing the sidebar later never affects a running tab. Never reintroduce a global `terminal`/`isTerminalRunning` singleton
- Refresh survival: the initial tab is NOT created at DOMContentLoaded - `bootstrapSessionTabs()` runs on first socket connect, reattaches any orphaned terminals from `/api/active-terminals` (reusing the server's terminal_id as the tab id), and only falls back to a blank tab. Subsequent reconnects (server restart) use the per-session `wasRunningBeforeDisconnect` auto-resume path instead
- Paste: Ctrl+V goes through `pasteClipboardIntoSession()` - an image on the clipboard is uploaded to the tab's project directory (`pasted_image_YYYYMMDD_HHMMSS.*`) and Claude is prompted to analyze it; text falls through to a terminal paste
- Editor pane: ONE shared Monaco instance (lazy CDN load) and one pane in the DOM, but open/closed + open-files state lives per session tab in `sess.editor`; `applyEditorPane(sess)` re-renders it on tab switch. Models are cached per file path in `editorModels` and shared across tabs. Saves send `known_mtime` and handle 409 (changed on disk) with an overwrite/reload choice - keep that guard, Claude edits the same files
- Permission mode: persisted in `localStorage` (key `permissionMode`, default `"default"`). Modes become CLI flags only at session spawn via `_permission_mode_flags()` in app.py - `"default"` sends NO flags so the user's settings.json `defaultMode` applies (CLI flags override settings files, so never send flags unless the user explicitly picked a mode). Changing the selector never affects an already-running session; the UI shows a toast saying so
- Socket.IO events for terminal I/O: `terminal_output`, `terminal_input`, `terminal_ready`, `terminal_exit`
- REST calls via `fetch()` to `/api/*` endpoints
- Context menus built dynamically on right-click for projects and sessions
- Tabs: Terminal, Session Viewer, CLAUDE.md Editor, Git (status/diffs + Open Repo button with multi-remote chooser + rendered README viewer), Usage

## Data Storage

```
data/
  settings.json              # IDE settings (claude_cmd, default_project, font_size, notification toggles)
  usage_cache.json           # Parsed token usage per claude_session_id, keyed by jsonl mtime+size
  projects/
    <project-name>/
      project.json           # Name, display_name, description, working_directory, pinned, created, work_related, urls[]
      sessions/
        sess_YYYYMMDD_HHMMSS_<hex>.json   # Session record with raw_transcript, claude_session_id, tags
  archived_projects/         # Archived projects (same structure); hidden from the projects list
  unsorted_sessions/         # Sessions saved without a project
```

Archiving moves the whole project folder between `projects/` and `archived_projects/` (`POST /api/projects/<name>/archive`, `GET /api/archived`, `POST /api/archived/<name>/unarchive`). All project.json reads/writes go through `_read_project_meta()` / `_write_project_meta()` - always use these helpers (UTF-8, corrupt-file tolerant) instead of opening the file directly.

## Critical Windows Patterns

- **Always use `encoding="utf-8"`** when reading/writing session JSON files. Raw PTY output contains escape sequences that crash Python's default cp1252 codec.
- **Admin elevation is required** - pywinpty needs it to properly spawn Claude Code. Admin token inheritance through pywinpty works correctly in the current setup (verified with `test_admin_inherit.py`); the unused ConPTY module (`conpty_process.py`) is only a fallback in case that ever regresses.
- **Session resume depends on working directory** - Claude Code's `--resume <uuid>` must run from the same directory the session was originally started in. The `working_directory` field in session JSON tracks this.
- **Save destination derived from workdir, not UI** - `save_session()` calls `_project_for_workdir()` to find the project whose `working_directory` matches the session record's, and writes there regardless of the project name the UI passed in. This prevents sessions from being filed under whichever project happened to be selected in the sidebar at save time. The frontend also blocks `selectProject()` while a terminal is running (with a Quick-Resume bypass) as a defense-in-depth UX guardrail.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_IDE_DATA` | `./data` | Data storage location |
| `CLAUDE_IDE_SHELL` | `powershell.exe` | Shell for PTY |
| `CLAUDE_IDE_CMD` | `claude` | Claude Code CLI command |
| `CLAUDE_IDE_PORT` | `5050` | Server port |
| `CLAUDE_IDE_ORPHAN_GRACE` | `90` | Seconds a disconnected session survives before auto-save + kill (page refresh reattaches within this window) |
| `CLAUDE_IDE_SECRET` | (dev key) | Flask secret key |

## Project-Specific Instructions

- **AutoSave** - Each time we complete updating code, ask if the user wants to push to GitHub. If yes, always update the README.md (create it if it does not exist).
