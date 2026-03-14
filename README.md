# ⚡ Claude Code IDE

A local web-based IDE that wraps Claude Code's CLI with project and session management. Run Claude Code in your browser with a dark VS Code-inspired interface, save conversations, organize them into projects, and search across your history.

## What It Does

- **Interactive Terminal** — Runs Claude Code in a real terminal (xterm.js) inside your browser
- **Session Recording** — Every conversation is automatically captured and cleaned via virtual terminal rendering (pyte)
- **Session Resume** — Resume any saved session using Claude Code's native `--resume` flag
- **Project Organization** — Group related sessions into named projects with custom working directories
- **Session Viewer** — Browse and read past conversations with clean, readable transcripts
- **Session Export** — Download transcripts as `.md` or `.txt` files
- **Session Compare** — Side-by-side diff view of any two sessions within a project
- **CLAUDE.md Editor** — Read, edit, and save CLAUDE.md project instructions directly in the IDE
- **File Upload** — Upload files (Excel, Word, images, etc.) to the project directory for Claude to read via MCP tools
- **Search** — Full-text search across all saved sessions (Ctrl+Shift+F)
- **Settings** — Configurable Claude Code command, default project, and terminal font size
- **Context Menus** — Right-click projects and sessions to rename or delete them
- **Tooltips** — Hover hints on every interactive element
- **Dark Theme** — VS Code-inspired dark UI

## Requirements

- **Python 3.10+**
- **Claude Code** installed and on PATH (`npm install -g @anthropic-ai/claude-code`)
- **Windows 10/11** (primary target; Unix/macOS also supported)

## Quick Start

### 1. Set Up Environment

```powershell
# Navigate to the project
cd claude-code-ide

# Create a virtual environment
python -m venv .venv

# Activate it
.\.venv\Scripts\Activate

# Install dependencies
pip install -r requirements.txt
```

**Windows note:** You also need `pywinpty` for interactive terminal support:
```powershell
pip install pywinpty
```

### 2. Run the IDE

```powershell
python app.py
```

Then open **http://localhost:5000** in your browser.

### 3. Use It

1. Click **+ New Project** in the sidebar to create a project (optionally set a working directory)
2. Select the project in the sidebar
3. Click **Start Claude Code** to open an interactive session
4. When you're done, click **Stop & Save** to save the session with a summary and tags
5. Browse past sessions in the sidebar, or use **Ctrl+Shift+F** to search
6. Click a saved session to view it, then **Resume** to continue where you left off
7. Use the **Compare** tab to diff two sessions side-by-side
8. Use the **CLAUDE.md** tab to edit project instructions
9. Click **📎** to upload files for Claude to analyze via MCP tools

## Tabs

| Tab | Purpose |
|-----|---------|
| **Terminal** | Live Claude Code session |
| **Session Viewer** | Read saved transcripts, export, or resume |
| **Compare** | Side-by-side diff of two sessions |
| **CLAUDE.md** | Edit project instructions file |

## Architecture

```
Browser (localhost:5000)
    |
    v  WebSocket + REST
    |
Flask Server (your machine)
    |
    v  PTY (pywinpty on Windows)
    |
Claude Code CLI
    |
    v  MCP (stdio)
    |
Browser & File MCP Server (optional)
```

Everything runs locally. The browser is just the UI. Claude Code connects to any configured MCP servers (browser automation, file processing, etc.) automatically.

## File Structure

```
claude-code-ide/
├── app.py              # Flask server, WebSocket, API routes
├── requirements.txt    # Python dependencies (flask, flask-socketio, pywinpty, pyte)
├── templates/
│   └── index.html      # Main page layout
├── static/
│   ├── css/
│   │   └── style.css   # Dark theme styling
│   └── js/
│       └── app.js      # Frontend logic
└── data/
    ├── settings.json   # IDE settings (persisted across restarts)
    └── projects/       # Saved projects and sessions
```

## Configuration

### Settings Modal (gear icon)

| Setting | Description |
|---------|-------------|
| **Claude Code Command** | CLI command to launch Claude Code (e.g. `claude`, or a full path) |
| **Default Project** | Auto-select this project on startup |
| **Terminal Font Size** | Adjustable 10-24px |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_IDE_DATA` | `./data` | Where projects and sessions are stored |
| `CLAUDE_IDE_SHELL` | `powershell.exe` | Shell to use (auto-detects OS) |
| `CLAUDE_IDE_CMD` | `claude` | Command to launch Claude Code |
| `CLAUDE_IDE_SECRET` | (dev key) | Flask secret key |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+F` | Open search |
| `Ctrl+S` | Save CLAUDE.md (when editor tab is active) |
| `Escape` | Close modals |
| Right-click | Context menu on projects and sessions (rename, delete) |

## Roadmap

- [x] Phase 1: Interactive terminal in browser
- [x] Phase 2: Session recording and viewer
- [x] Phase 3: Project management
- [x] Phase 4: Session resume with native Claude Code `--resume` flag
- [x] Phase 5: Session diffing, export, and CLAUDE.md sync
- [x] Phase 6: Settings, file upload, context menus, tooltips, working directory fixes

## License

MIT
