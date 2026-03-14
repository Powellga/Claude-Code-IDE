# ⚡ Claude Code IDE

A full-featured local web IDE that wraps Claude Code's CLI with real-time terminal emulation, project/session management, file processing, and MCP integration. Built entirely in Python and vanilla JavaScript — no frameworks, no Electron, no cloud dependencies.

This is not a thin wrapper or a chat UI that calls an API. It manages real PTY processes, streams bidirectional I/O over WebSockets, renders raw terminal output through a virtual terminal emulator, and extends Claude Code's capabilities through a custom MCP tool server.

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
- **Screenshot Capture** — One-click Windows Snipping Tool integration: capture a screen region and Claude analyzes it automatically
- **Conversation Import** — Paste text from claude.ai, ChatGPT, email, or any source into a modal; saved as a file and Claude picks up where it left off
- **Quick-Resume** — Hover any project to one-click resume the most recent session
- **Pin Projects** — Right-click to pin frequently used projects to the top of the sidebar
- **File Tree** — Toggle a file explorer panel alongside the terminal showing the project's working directory; click any file to ask Claude to read it
- **Git Integration** — Dedicated Git tab showing branch, changed files, recent commits, and full color-highlighted diffs
- **Timestamps** — Projects and sessions display their creation date and time in the sidebar
- **Search** — Full-text search across all saved sessions (Ctrl+Shift+F)
- **Settings** — Configurable Claude Code command, default project, and terminal font size
- **Context Menus** — Right-click projects and sessions to rename or delete them
- **Tooltips** — Hover hints on every interactive element
- **Dark Theme** — VS Code-inspired dark UI

## How It Works Under the Hood

This project solves several non-trivial engineering problems:

### Real PTY Process Management
The server spawns Claude Code as a real pseudo-terminal process (`pywinpty` on Windows, `pty` on Unix), not a subprocess with piped stdio. This gives Claude Code a fully interactive terminal environment — cursor movement, color output, line editing, and TUI rendering all work correctly. The PTY output is streamed in real time over WebSocket to xterm.js in the browser, and user keystrokes flow back the other direction.

### Virtual Terminal Rendering for Clean Transcripts
Raw PTY output is full of ANSI escape sequences — cursor movements, screen clears, color codes, character-by-character streaming, spinner animations, and screen overwrites. Simple regex stripping produces garbled text with missing spaces and words running together. Instead, the entire raw output is replayed through **pyte**, a Python virtual terminal emulator that maintains a full screen buffer and scrollback history. The result is a clean, readable transcript that accurately represents what the user actually saw on screen.

### Native Session Resume
Rather than trying to inject previous conversation context into a new session (which breaks Claude Code's TUI and has timing issues), the IDE uses Claude Code's own session management. Each session is started with `--session-id <uuid>`, and resuming uses `--resume <uuid>`. Claude Code restores the full conversation context natively, including tool call history and system prompts that aren't visible in the transcript.

### MCP Tool Integration
The IDE works with a companion [Browser & File MCP Server](https://github.com/Powellga/Claude_Browser_MCP_Server) that exposes 25 tools — 18 for browser automation (Playwright) and 7 for file processing (Excel, Word, PowerPoint, CSV, images). The file upload button in the IDE drops files into the project's working directory and auto-prompts Claude to read them. Claude Code discovers and connects to the MCP server automatically via its config — the IDE doesn't need to broker the connection.

### Screenshot Capture Pipeline
The screenshot button launches Windows Snipping Tool in capture mode (`snippingtool /clip`), then polls the system clipboard via `PIL.ImageGrab.grabclipboard()` for up to 30 seconds waiting for the captured image. Once detected, it saves the image as a timestamped PNG to the project's working directory and auto-prompts Claude to analyze it. The clipboard is cleared before launching the tool so stale images aren't picked up. The entire flow — launch tool, detect capture, save file, prompt Claude — happens from a single button click.

### Working Directory Persistence
Each project has a configurable working directory. When you start a session, the PTY process spawns in that directory. The directory path is saved with every session record, so resumed sessions return to their original location even if the project config changes later. If the specified directory doesn't exist at project creation time, the IDE prompts to create it.

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
9. Click the **📎 upload button** to upload files for Claude to analyze via MCP tools
10. Click the **✂️ screenshot button** to capture a screen region — Claude will analyze it automatically
11. Click the **📋 import button** to paste a conversation from another source — Claude continues from it

## Tabs

| Tab | Purpose |
|-----|---------|
| **Terminal** | Live Claude Code session with full PTY emulation |
| **Session Viewer** | Read saved transcripts, export as .md/.txt, or resume |
| **Compare** | Side-by-side diff of two sessions from the same project |
| **CLAUDE.md** | Edit project instructions file (Ctrl+S to save) |
| **Git** | Branch info, changed files, recent commits, and color-highlighted diffs |

## Architecture

```
Browser (localhost:5000)
    |
    v  WebSocket (Socket.IO) + REST API
    |
Flask Server (Python)
    |
    +---> PTY Process (pywinpty / pty)
    |         |
    |         v
    |     Claude Code CLI
    |         |
    |         v  MCP Protocol (stdio)
    |         |
    |     Browser & File MCP Server
    |         |
    |         +---> Playwright (browser automation)
    |         +---> openpyxl / python-docx / python-pptx / Pillow (file processing)
    |
    +---> pyte (virtual terminal emulator — transcript cleaning)
    |
    +---> JSON file storage (projects, sessions, settings)
```

Everything runs locally. No cloud services, no databases, no containers. The browser is just the UI. Claude Code connects to any configured MCP servers automatically.

## File Structure

```
claude-code-ide/
├── app.py              # Flask server, WebSocket handlers, PTY management, REST API
├── requirements.txt    # Python dependencies (flask, flask-socketio, pywinpty, pyte)
├── templates/
│   └── index.html      # Single-page app layout (tabs, modals, panels)
├── static/
│   ├── css/
│   │   └── style.css   # Dark theme (CSS custom properties, no preprocessor)
│   └── js/
│       └── app.js      # Frontend logic (vanilla JS, no framework)
└── data/
    ├── settings.json   # IDE settings (persisted across restarts)
    └── projects/       # Project configs + session JSON files
```

## Configuration

### Settings Modal (gear icon)

| Setting | Description |
|---------|-------------|
| **Claude Code Command** | CLI command to launch Claude Code (e.g. `claude`, or a full path) |
| **Default Project** | Auto-select this project on startup |
| **Terminal Font Size** | Adjustable 10-24px, applied immediately |

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

- [x] Phase 1: Interactive terminal in browser (xterm.js + WebSocket + PTY)
- [x] Phase 2: Session recording and viewer (raw capture + pyte transcript cleaning)
- [x] Phase 3: Project management (CRUD, working directories, sidebar navigation)
- [x] Phase 4: Session resume (Claude Code native `--session-id` / `--resume` flags)
- [x] Phase 5: Session diffing, export, and CLAUDE.md editor
- [x] Phase 6: Settings, file upload, context menus, tooltips, working directory persistence
- [x] Phase 7: Screenshot capture, conversation import, sidebar timestamps, favicon/branding, launcher script
- [x] Phase 8: Quick-resume, pin projects, file tree viewer, git diff integration

## How Is This Different from Claude Desktop?

Claude Desktop is Anthropic's official desktop app. It's a conversation tool — you open it, chat with Claude, and close it. This IDE is a workflow tool built for managing ongoing technical work across projects over time.

| Capability | Claude Desktop | Claude Code IDE |
|------------|---------------|-----------------|
| Chat with Claude | Yes (direct API) | Yes (via Claude Code CLI) |
| Native multimodal input | Built-in | Via MCP file tools + upload button |
| Session save & organize | No — conversations aren't project-aware | Yes — save, name, tag, search, organize by project |
| Session resume | Scroll back in history | Native `--resume` restoring full context including tool calls |
| Session export | No | Download as `.md` or `.txt` |
| Session compare | No | Side-by-side diff of any two sessions |
| Project management | No | Named projects with dedicated working directories |
| CLAUDE.md editing | External editor | Integrated editor tab with Ctrl+S |
| Working directory control | No | Each project spawns in its configured directory |
| Full CLI capabilities | No — different integration path | Yes — all Claude Code features, slash commands, hooks, MCP tools |
| File upload for analysis | Built-in | Upload button drops files in project directory, auto-prompts Claude |
| Screenshot capture | No — paste image manually | One-click: launches Snipping Tool, saves to project, auto-prompts Claude |
| Import conversations | No cross-platform import | Paste from claude.ai, ChatGPT, email — Claude picks up where it left off |
| Git integration | No | Branch, status, diffs, recent commits — see what Claude changed |
| File explorer | No | Toggleable file tree alongside the terminal |
| Code transparency | Closed source | You own every line — fully inspectable and modifiable |

**Claude Desktop is more powerful for single conversations** — polished UI, faster responses, native file handling.

**This IDE is more powerful for managing work over time** — if you're running dozens of sessions across multiple projects over weeks or months, Claude Desktop gives you no way to organize, search, compare, or resume that work. This IDE does.

They solve different problems. Claude Desktop is a chat app. This is an engineering workbench.

## Companion Project

**[Browser & File MCP Server](https://github.com/Powellga/Claude_Browser_MCP_Server)** — 25-tool MCP server that gives Claude Code browser automation (Playwright) and file processing (Excel, Word, PowerPoint, CSV, images). Designed to work with this IDE but usable with any MCP client.

## License

MIT
