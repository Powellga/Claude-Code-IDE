# ⚡ Claude Code IDE

A local web-based IDE that wraps Claude Code's CLI with project and session management. Run Claude Code in your browser with a dark VS Code-inspired interface, save conversations, organize them into projects, and search across your history.

## What It Does

- **Interactive Terminal** — Runs Claude Code in a real terminal (xterm.js) inside your browser
- **Session Recording** — Every conversation is automatically captured
- **Project Organization** — Group related sessions into named projects
- **Session Viewer** — Browse and read past conversations
- **Search** — Full-text search across all saved sessions
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

1. Click **+ New Project** in the sidebar to create a project
2. Select the project from the dropdown in the toolbar
3. Click **▶ Start Claude Code** to open an interactive session
4. When you're done, click **■ Stop & Save** to save the session with a summary and tags
5. Browse past sessions in the sidebar, or use **Ctrl+Shift+F** to search

## Architecture

```
Browser (localhost:5000)
    │
    ↕  WebSocket + REST
    │
Flask Server (your machine)
    │
    ↕  PTY (pywinpty on Windows)
    │
Claude Code CLI
```

Everything runs locally. The browser is just the UI.

## File Structure

```
claude-code-ide/
├── app.py              # Flask server, WebSocket, API routes
├── requirements.txt    # Python dependencies
├── templates/
│   └── index.html      # Main page layout
├── static/
│   ├── css/
│   │   └── style.css   # Dark theme styling
│   └── js/
│       └── app.js      # Frontend logic
└── data/
    └── projects/       # Saved projects and sessions
```

## Configuration

Environment variables:

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
| `Escape` | Close modals |

## Roadmap

- [x] Phase 1: Interactive terminal in browser
- [x] Phase 2: Session recording and viewer
- [x] Phase 3: Project management
- [ ] Phase 4: Resume sessions with context injection
- [ ] Phase 5: Session diffing, export, and CLAUDE.md sync

## License

MIT
