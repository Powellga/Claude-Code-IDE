/**
 * Claude Code IDE — Frontend Application
 * =======================================
 * Handles the terminal (xterm.js), WebSocket communication,
 * project/session sidebar, and search.
 */

// ─── State ─────────────────────────────────────────────────────────────────

let socket = null;
// Session tabs: terminal_id -> { id, term, fitAddon, containerEl, tabEl,
// project, running, claudeSessionId, workingDirectory, wasRunningBeforeDisconnect }
let termSessions = {};
let activeTermId = null;
let pendingStopTermId = null;   // tab being stopped via the save modal
let legacySingleSession = false; // server predates terminal ids (needs restart)
const MAX_SESSION_TABS = 8;
let activeProject = null;
let activeSessionId = null;
let viewedSessionProject = null;
let claudeMdDirty = false;
let currentPermissionMode = localStorage.getItem("permissionMode") || "default";
let projectFilterMode = "all"; // "all" | "work" | "personal"
let cachedProjects = [];
let projectSearchQuery = "";
// Notification preferences - hydrated from /api/settings on startup
let ideSettings = { notifications_enabled: true, notification_sound: true };
// Anthropic accounts: [{name, config_dir, api_key}] from settings; the
// selector picks which one the NEXT session spawns under
let ideAccounts = [];
let currentAccount = localStorage.getItem("claudeAccount") || "Default";

function activeSess() {
    return termSessions[activeTermId] || null;
}

function anyRunning() {
    return Object.values(termSessions).some(s => s.running);
}

// ─── Initialize ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initSocket();
    initSessionTabs();
    initUI();
    loadProjects();
    applyStartupSettings();
    checkNotifyHook();

    // Returning to the window means the user is looking at the active tab
    window.addEventListener("focus", () => clearAttention(activeSess()));

    // Unlock the audio engine on the first user gesture so the notification
    // chime can play later even while the window is unfocused
    document.addEventListener("click", ensureAudioContext, { once: true });
    document.addEventListener("keydown", ensureAudioContext, { once: true });
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────

function initSocket() {
    socket = io({
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
    });

    socket.on("connect", () => {
        console.log("[IDE] Connected to server");
        showConnectionStatus("connected");

        // First connect after page load: reattach to surviving sessions
        if (!initSocket._bootstrapped) {
            initSocket._bootstrapped = true;
            bootstrapSessionTabs();
            return;
        }

        // Reconnect (e.g. server restart): auto-resume tabs that were running
        for (const sess of Object.values(termSessions)) {
            if (sess.wasRunningBeforeDisconnect && sess.claudeSessionId) {
                sess.wasRunningBeforeDisconnect = false;
                sess.term.writeln("\r\n\x1b[33m  ⚡ Server restarted — auto-resuming session...\x1b[0m\r\n");
                socket.emit("resume_session", {
                    terminal_id: sess.id,
                    project: sess.project,
                    claude_session_id: sess.claudeSessionId,
                    working_directory: sess.workingDirectory || "",
                    permission_mode: currentPermissionMode,
                    account: sess.account || "Default",
                });
            }
        }
    });

    socket.on("disconnect", () => {
        console.log("[IDE] Disconnected");
        for (const sess of Object.values(termSessions)) {
            if (sess.running) sess.wasRunningBeforeDisconnect = true;
            setSessRunning(sess, false);
        }
        showConnectionStatus("disconnected");
    });

    socket.on("reconnecting", () => {
        showConnectionStatus("reconnecting");
    });

    socket.on("terminal_ready", (msg) => {
        const sess = routeSess(msg);
        if (!sess) return;
        if (msg && !msg.terminal_id && !legacySingleSession) {
            legacySingleSession = true;
            showToast("Server is running the pre-multi-tab backend. Restart the server to enable multiple session tabs.", 6000);
        }
        if (msg && msg.claude_session_id) sess.claudeSessionId = msg.claude_session_id;
        if (msg && msg.working_directory) sess.workingDirectory = msg.working_directory;
        setSessRunning(sess, true);
        if (msg && msg.status === "reattached") {
            // Nudge the PTY size so the TUI repaints itself after the replay
            setTimeout(() => {
                try { sess.fitAddon.fit(); } catch (e) { /* hidden tab */ }
                socket.emit("resize_terminal", { terminal_id: sess.id, rows: Math.max(2, sess.term.rows - 1), cols: sess.term.cols });
                setTimeout(() => {
                    socket.emit("resize_terminal", { terminal_id: sess.id, rows: sess.term.rows, cols: sess.term.cols });
                }, 150);
            }, 200);
        }
        if (sess.id === activeTermId) sess.term.focus();
    });

    socket.on("terminal_output", (msg) => {
        const sess = routeSess(msg);
        if (sess && msg.data) {
            sess.term.write(msg.data);
            noteOutputActivity(sess);
        }
    });

    // Claude Code's Notification hook fired for this session: it needs input
    // (permission request, question, or idle waiting). Full treatment: dot,
    // badges, and - when the user isn't watching - OS toast + chime.
    socket.on("session_attention", (msg) => {
        const sess = msg && msg.terminal_id ? termSessions[msg.terminal_id] : null;
        if (!sess || !sess.running) return;
        markAttention(sess, msg.message || "Claude needs your input", { alert: true });
    });

    socket.on("terminal_exit", (msg) => {
        const sess = routeSess(msg);
        if (!sess) return;
        sess.term.writeln("\r\n\x1b[90m── Session ended ──\x1b[0m\r\n");
        setSessRunning(sess, false);
    });

    socket.on("terminal_error", (msg) => {
        const sess = routeSess(msg);
        if (!sess) return;
        sess.term.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        setSessRunning(sess, false);
    });

    socket.on("session_saved", (msg) => {
        console.log("[IDE] Session saved:", msg.id);
        loadProjects();
        if (activeProject) {
            loadSessions(activeProject);
        }
    });
}

// Route a server event to its session tab. Events from a legacy backend
// carry no terminal_id - fall back to the active tab so single-session
// use keeps working until the server is restarted.
function routeSess(msg) {
    if (msg && msg.terminal_id) return termSessions[msg.terminal_id] || null;
    return activeSess();
}

// ─── Terminal (xterm.js) ───────────────────────────────────────────────────

const TERMINAL_THEME = {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#1e1e1e",
    selectionBackground: "#264f78",
    black: "#1e1e1e",
    red: "#f44747",
    green: "#4ec9b0",
    yellow: "#dcdcaa",
    blue: "#569cd6",
    magenta: "#c586c0",
    cyan: "#9cdcfe",
    white: "#d4d4d4",
    brightBlack: "#808080",
    brightRed: "#f44747",
    brightGreen: "#4ec9b0",
    brightYellow: "#dcdcaa",
    brightBlue: "#569cd6",
    brightMagenta: "#c586c0",
    brightCyan: "#9cdcfe",
    brightWhite: "#e7e7e7",
};

function initSessionTabs() {
    document.getElementById("btn-new-session-tab").addEventListener("click", () => newSessionTab());
    // The initial tab is created by bootstrapSessionTabs() on first socket
    // connect, after checking the server for live sessions to reattach.
}

// On first connect, reattach to any terminals that survived a page refresh
// (the server keeps them alive for a grace period); otherwise open a blank tab.
async function bootstrapSessionTabs() {
    let orphans = [];
    try {
        const resp = await fetch("/api/active-terminals");
        if (resp.ok) orphans = (await resp.json()).filter(t => !t.attached);
    } catch (e) { /* pre-Phase-24 server */ }

    for (const o of orphans) {
        const sess = newSessionTab({ id: o.terminal_id, project: o.project });
        if (!sess) break; // tab cap
        sess.claudeSessionId = o.claude_session_id;
        sess.workingDirectory = o.working_directory;
        sess.account = o.account || "Default";
        updateSessionTabEl(sess);
        sess.term.writeln("\x1b[33m  ⚡ Reattaching to running session...\x1b[0m");
        socket.emit("reattach_terminal", { terminal_id: sess.id });
    }
    if (!Object.keys(termSessions).length) newSessionTab();
}

function newSessionTab(opts = {}) {
    const count = Object.keys(termSessions).length;
    if (count >= MAX_SESSION_TABS) {
        showToast(`Tab limit reached (${MAX_SESSION_TABS}). Close a tab first.`, 4000);
        return null;
    }
    if (legacySingleSession && count >= 1) {
        showToast("The server is running the pre-multi-tab backend. Restart the server (start-ide.bat) to enable multiple tabs.", 6000);
        return null;
    }

    const id = opts.id || ((window.crypto && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, "")
        : Date.now().toString(36) + Math.random().toString(36).slice(2));

    const containerEl = document.createElement("div");
    containerEl.className = "term-instance";
    containerEl.style.display = "none";
    document.getElementById("terminal-container").appendChild(containerEl);

    const tabEl = document.createElement("div");
    tabEl.className = "session-tab";
    tabEl.dataset.termId = id;
    tabEl.innerHTML =
        '<span class="session-tab-dot idle"></span>' +
        '<span class="session-tab-label">new tab</span>' +
        '<span class="session-tab-close" title="Close tab">×</span>';
    tabEl.addEventListener("click", (e) => {
        if (e.target.classList.contains("session-tab-close")) {
            closeSessionTab(id);
            return;
        }
        activateSessionTab(id);
    });
    document.getElementById("session-tabs").appendChild(tabEl);

    const sess = {
        id,
        term: null,
        fitAddon: null,
        containerEl,
        tabEl,
        project: opts.project || null,
        running: false,
        claudeSessionId: null,
        workingDirectory: null,
        wasRunningBeforeDisconnect: false,
    };
    termSessions[id] = sess;
    buildTerminalInstance(sess);
    activateSessionTab(id);
    return sess;
}

function activateSessionTab(id) {
    const sess = termSessions[id];
    if (!sess) return;
    activeTermId = id;
    for (const s of Object.values(termSessions)) {
        const active = s.id === id;
        s.containerEl.style.display = active ? "" : "none";
        s.tabEl.classList.toggle("active", active);
    }
    setTimeout(() => { try { sess.fitAddon.fit(); } catch (e) { /* hidden */ } }, 30);
    refreshTerminalToolbar();
    applyEditorPane(sess); // each tab has its own editor-pane state
    sess.term.focus();
    if (isWatching(sess)) clearAttention(sess);
}

function closeSessionTab(id) {
    const sess = termSessions[id];
    if (!sess) return;
    if (sess.running) {
        activateSessionTab(id);
        showToast("This tab has a running session - use Stop & Save or Discard first.", 4000);
        return;
    }
    sess.containerEl.remove();
    sess.tabEl.remove();
    try { sess.term.dispose(); } catch (e) { /* already gone */ }
    delete termSessions[id];
    if (activeTermId === id) {
        activeTermId = null;
        const remaining = Object.keys(termSessions);
        if (remaining.length) activateSessionTab(remaining[remaining.length - 1]);
        else newSessionTab();
    }
}

function updateSessionTabEl(sess) {
    let name = "new tab";
    if (sess.project) {
        const p = cachedProjects.find(x => x.name === sess.project);
        name = (p && (p.display_name || p.name)) || sess.project;
    } else if (sess.running || sess.claudeSessionId) {
        name = "no project";
    }
    if (sess.account && sess.account !== "Default") {
        name += ` 👤${sess.account}`;
    }
    sess.tabEl.querySelector(".session-tab-label").textContent = name;
    sess.tabEl.title = name + (sess.running ? " (running)" : "") +
        (sess.account && sess.account !== "Default" ? ` - account: ${sess.account}` : "");
    sess.tabEl.querySelector(".session-tab-dot").className =
        "session-tab-dot " + (sess.needsAttention ? "attention" : sess.running ? "running" : "idle");
}

function setSessRunning(sess, running) {
    sess.running = running;
    if (!running) {
        clearTimeout(sess.idleTimer);
        sess.busyStart = null;
        clearAttention(sess);
    }
    updateSessionTabEl(sess);
    refreshTerminalToolbar();
}

// Toolbar buttons and the status dot always reflect the ACTIVE tab
function refreshTerminalToolbar() {
    const sess = activeSess();
    const running = !!(sess && sess.running);
    document.getElementById("btn-start").style.display = running ? "none" : "";
    document.getElementById("btn-stop").style.display = running ? "" : "none";
    document.getElementById("btn-discard").style.display = running ? "" : "none";
    const status = document.getElementById("terminal-status");
    status.classList.toggle("running", running);
    status.classList.toggle("stopped", !running);
}

function buildTerminalInstance(sess) {
    const term = new Terminal({
        theme: TERMINAL_THEME,
        fontFamily: '"Cascadia Code", "Consolas", "Courier New", monospace',
        fontSize: 14,
        lineHeight: 1.3,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10000,
        allowProposedApi: true,
    });
    sess.term = term;

    sess.fitAddon = new FitAddon.FitAddon();
    term.loadAddon(sess.fitAddon);

    try {
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
        term.loadAddon(webLinksAddon);
    } catch (e) { /* optional */ }

    term.open(sess.containerEl);

    // Track when Ctrl+V fires so onData can skip the duplicate bracket-paste.
    // Uses a short timeout instead of a persistent flag — auto-expires in 200ms
    // so it can never permanently block input.
    let ctrlVJustFired = false;

    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !e.ctrlKey) return true;

        // Ctrl+C: if text is selected, copy it; otherwise let SIGINT pass through
        if (e.key === "c" || e.key === "C") {
            const selection = term.getSelection();
            if (selection) {
                copyTextToClipboard(selection);
                return false;
            }
            return true;
        }

        // Ctrl+V: image on the clipboard uploads for Claude; text pastes
        if (e.key === "v" || e.key === "V") {
            ctrlVJustFired = true;
            setTimeout(() => { ctrlVJustFired = false; }, 200);
            pasteClipboardIntoSession(sess);
            return false;
        }

        return true;
    });

    // OSC 52 clipboard bridge. Claude Code's TUI captures the mouse
    // (\x1b[?1003h), renders its OWN selection highlight on drag, and "copies"
    // it by emitting OSC 52 (\x1b]52;c;<base64>) - that is what its
    // "copied N chars to clipboard" message refers to. Real terminals translate
    // OSC 52 into a system clipboard write; xterm.js ignores it by default, so
    // without this handler the copy silently goes nowhere.
    term.parser.registerOscHandler(52, (data) => {
        // Payload is "<selector>;<base64>", e.g. "c;SGVsbG8=". A payload of
        // "?" is a clipboard-read query - ignore those, only handle writes.
        const semi = data.indexOf(";");
        const payload = semi >= 0 ? data.slice(semi + 1) : data;
        if (!payload || payload === "?") return true;
        try {
            const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
            const text = new TextDecoder().decode(bytes);
            if (text) copyTextToClipboard(text);
        } catch (e) { /* malformed base64 - nothing to copy */ }
        return true;
    });

    // Copy-on-select for when the TUI is NOT capturing the mouse (welcome
    // screen, plain shell): a normal drag selects in xterm, and the selection
    // is copied automatically.
    //
    // IMPORTANT: with any-motion tracking (?1003h) every mouse move sends a
    // report, which xterm counts as user input and uses to clear the selection
    // instantly. So the selection text must be captured HERE, at the moment the
    // selection event fires - by the time the debounce runs (or the user
    // presses Ctrl+C) term.getSelection() is usually already empty.
    let copyOnSelectTimer = null;
    let capturedSelection = "";
    term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (!sel) return; // ignore the clear event - keep the captured text
        capturedSelection = sel;
        // Debounce: fires continuously while dragging - copy once it settles
        clearTimeout(copyOnSelectTimer);
        copyOnSelectTimer = setTimeout(() => {
            if (capturedSelection) copyTextToClipboard(capturedSelection);
        }, 200);
    });

    // Send keystrokes and right-click paste to server.
    // Right-click paste arrives as bracket-paste sequences — strip wrappers, send content.
    // Ctrl+V paste is handled above; if ctrlVJustFired, skip bracket-paste to avoid double.
    term.onData((data) => {
        if (!sess.running || !socket) return;
        clearAttention(sess); // the user is interacting with this session

        const hasBracketPaste = data.includes("\x1b[200~") || data.includes("\x1b[201~");

        if (hasBracketPaste) {
            // Ctrl+V already sent this — skip to prevent double-paste
            if (ctrlVJustFired) return;
            // Right-click paste — strip wrappers and send
            const cleaned = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
            if (cleaned) socket.emit("terminal_input", { terminal_id: sess.id, data: cleaned });
            return;
        }

        socket.emit("terminal_input", { terminal_id: sess.id, data });
    });

    // Refit when the container resizes (only meaningful while visible)
    const resizeObserver = new ResizeObserver(() => {
        if (!sess.fitAddon || sess.containerEl.style.display === "none") return;
        try { sess.fitAddon.fit(); } catch (e) { return; }
        if (sess.running && socket) {
            socket.emit("resize_terminal", {
                terminal_id: sess.id,
                rows: term.rows,
                cols: term.cols,
            });
        }
    });
    resizeObserver.observe(sess.containerEl);

    // Welcome message
    term.writeln("\x1b[1;36m  ⚡ Claude Code IDE\x1b[0m");
    term.writeln("\x1b[90m  Click \"Start Claude Code\" to begin a session.\x1b[0m");
    term.writeln("\x1b[90m  Tip: drag over text to select it - it is copied to the clipboard automatically.\x1b[0m");
    term.writeln("");
}

// Copy text to the clipboard, falling back to a hidden textarea +
// execCommand when the async Clipboard API is unavailable (e.g. the IDE
// is opened over a non-localhost address, which is not a secure context).
function copyTextToClipboard(text) {
    const notify = () => showToast("Copied to clipboard", 1500);
    const fail = (why) => showToast("Copy failed" + (why ? ": " + why : ""), 3000);
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(notify).catch((e) => {
            if (fallbackCopyText(text)) notify();
            else fail(e && e.name);
        });
    } else if (fallbackCopyText(text)) {
        notify();
    } else {
        fail("clipboard unavailable");
    }
}

function fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { /* unsupported */ }
    ta.remove();
    const sess = activeSess();
    if (sess) sess.term.focus();
    return ok;
}

// ─── Editor Pane (per-session Monaco, collapsed by default) ────────────────
//
// Each session tab has its own editor pane state (open/closed, open files,
// active file), but there is ONE shared Monaco instance and one pane in the
// DOM - switching session tabs re-applies that tab's state. Monaco itself is
// loaded lazily from the CDN the first time a pane is opened.

const MONACO_CDN = "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs";
let monacoReady = null;   // Promise resolving to the monaco global
let monacoEditor = null;  // the single shared editor instance
const editorModels = {};  // path -> { model, mtime, savedVersionId, viewState, name }
let editorPaneWidth = parseInt(localStorage.getItem("editorPaneWidth")) || 480;
let _editorTreeProject = undefined; // project the tree was last rendered for

function loadMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = MONACO_CDN + "/loader.js";
        s.onload = () => {
            require.config({ paths: { vs: MONACO_CDN } });
            require(["vs/editor/editor.main"], () => resolve(window.monaco));
        };
        s.onerror = () => {
            monacoReady = null;
            reject(new Error("could not load Monaco from CDN"));
        };
        document.head.appendChild(s);
    });
    return monacoReady;
}

function editorState(sess) {
    if (!sess.editor) sess.editor = { open: false, files: [], activeFile: null };
    return sess.editor;
}

function editorProject(sess) {
    return (sess && sess.project) || activeProject;
}

function initEditorPane() {
    document.getElementById("editor-toggle").addEventListener("click", () => {
        const sess = activeSess();
        if (!sess) return;
        editorState(sess).open = true;
        applyEditorPane(sess);
    });
    document.getElementById("btn-editor-close").addEventListener("click", () => {
        const sess = activeSess();
        if (!sess) return;
        editorState(sess).open = false;
        applyEditorPane(sess);
    });
    document.getElementById("btn-editor-refresh").addEventListener("click", () => {
        _editorTreeProject = undefined;
        loadEditorTree(activeSess());
    });
    document.getElementById("btn-editor-tree").addEventListener("click", () => {
        const tree = document.getElementById("editor-tree");
        const hidden = tree.style.display === "none";
        tree.style.display = hidden ? "" : "none";
        localStorage.setItem("editorTreeHidden", hidden ? "" : "1");
    });
    if (localStorage.getItem("editorTreeHidden")) {
        document.getElementById("editor-tree").style.display = "none";
    }

    // Drag the pane's left edge; width is capped at 50% of the content area
    const resizer = document.getElementById("editor-pane-resizer");
    resizer.addEventListener("mousedown", (e) => {
        e.preventDefault();
        resizer.classList.add("dragging");
        const split = document.getElementById("terminal-split");
        const onMove = (ev) => {
            const width = split.getBoundingClientRect().right - ev.clientX;
            editorPaneWidth = Math.round(width);
            clampEditorPaneWidth();
        };
        const onUp = () => {
            resizer.classList.remove("dragging");
            localStorage.setItem("editorPaneWidth", String(editorPaneWidth));
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
}

function clampEditorPaneWidth() {
    const split = document.getElementById("terminal-split");
    const max = Math.floor(split.getBoundingClientRect().width * 0.5);
    const width = Math.max(280, Math.min(editorPaneWidth, max));
    const pane = document.getElementById("editor-pane");
    pane.style.flex = "0 0 auto";
    pane.style.width = width + "px";
}

// Render the pane to match a session tab's editor state
function applyEditorPane(sess) {
    const pane = document.getElementById("editor-pane");
    const toggle = document.getElementById("editor-toggle");
    const st = sess ? editorState(sess) : null;
    if (!st || !st.open) {
        pane.style.display = "none";
        toggle.style.display = "";
        return;
    }
    toggle.style.display = "none";
    pane.style.display = "";
    clampEditorPaneWidth();
    renderEditorFileTabs(sess);
    loadEditorTree(sess);
    loadMonaco().then(() => {
        ensureMonacoEditor();
        setEditorActiveFile(sess, st.activeFile);
    }).catch(e => showToast("Editor unavailable: " + e.message, 5000));
}

function ensureMonacoEditor() {
    if (monacoEditor) return;
    monacoEditor = monaco.editor.create(document.getElementById("editor-monaco"), {
        theme: "vs-dark",
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        model: null,
    });
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveEditorFile());
    monacoEditor.onDidChangeModelContent(() => {
        const sess = activeSess();
        if (sess) renderEditorFileTabs(sess); // keep dirty dots current
    });
}

async function loadEditorTree(sess) {
    const project = editorProject(sess);
    const treeEl = document.getElementById("editor-tree");
    if (!project) {
        treeEl.innerHTML = '<div class="ed-empty">Select a project first</div>';
        _editorTreeProject = null;
        return;
    }
    if (_editorTreeProject === project) return; // already rendered
    _editorTreeProject = project;
    treeEl.innerHTML = '<div class="ed-empty">Loading…</div>';
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/files`);
        const data = await resp.json();
        if (!resp.ok) {
            treeEl.innerHTML = '<div class="ed-empty">No files</div>';
            return;
        }
        treeEl.innerHTML = "";
        const render = (entries, depth) => {
            for (const entry of entries) {
                const item = document.createElement("div");
                item.className = "ed-item" + (entry.is_dir ? " dir" : "");
                item.style.paddingLeft = (8 + depth * 12) + "px";
                item.textContent = (entry.is_dir ? "📁 " : "📄 ") + entry.name;
                item.title = entry.path;
                if (!entry.is_dir) {
                    item.addEventListener("click", () => {
                        const s = activeSess();
                        if (s) openFileInEditor(s, entry.path, entry.name);
                    });
                }
                treeEl.appendChild(item);
                if (entry.is_dir && entry.children) render(entry.children, depth + 1);
            }
        };
        render(data.tree || [], 0);
        if (!treeEl.children.length) treeEl.innerHTML = '<div class="ed-empty">No files</div>';
    } catch (e) {
        treeEl.innerHTML = '<div class="ed-empty">Failed to load files</div>';
    }
}

async function openFileInEditor(sess, path, name) {
    const st = editorState(sess);
    const project = editorProject(sess);
    if (!editorModels[path]) {
        try {
            const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`);
            const data = await resp.json();
            if (!resp.ok) {
                showToast("Open failed: " + (data.error || resp.status), 4000);
                return;
            }
            await loadMonaco();
            const uri = monaco.Uri.file(data.path);
            let model = monaco.editor.getModel(uri);
            if (model) model.setValue(data.content);
            else model = monaco.editor.createModel(data.content, undefined, uri);
            editorModels[path] = {
                model,
                mtime: data.mtime,
                savedVersionId: model.getAlternativeVersionId(),
                viewState: null,
                name,
            };
        } catch (e) {
            showToast("Open failed: " + e, 4000);
            return;
        }
    }
    if (!st.files.some(f => f.path === path)) st.files.push({ path, name });
    ensureMonacoEditor();
    setEditorActiveFile(sess, path);
}

function setEditorActiveFile(sess, path) {
    const st = editorState(sess);
    if (monacoEditor && monacoEditor.getModel()) {
        const cur = Object.values(editorModels).find(m => m.model === monacoEditor.getModel());
        if (cur) cur.viewState = monacoEditor.saveViewState();
    }
    st.activeFile = (path && st.files.some(f => f.path === path))
        ? path
        : (st.files[0] ? st.files[0].path : null);
    if (monacoEditor) {
        const entry = st.activeFile && editorModels[st.activeFile];
        monacoEditor.setModel(entry ? entry.model : null);
        if (entry && entry.viewState) monacoEditor.restoreViewState(entry.viewState);
    }
    renderEditorFileTabs(sess);
}

function editorFileIsDirty(path) {
    const entry = editorModels[path];
    return !!entry && entry.model.getAlternativeVersionId() !== entry.savedVersionId;
}

function renderEditorFileTabs(sess) {
    const st = editorState(sess);
    const bar = document.getElementById("editor-file-tabs");
    bar.innerHTML = "";
    for (const f of st.files) {
        const tab = document.createElement("div");
        tab.className = "editor-file-tab" + (f.path === st.activeFile ? " active" : "");
        tab.title = f.path;
        if (editorFileIsDirty(f.path)) {
            const dot = document.createElement("span");
            dot.className = "dirty-dot";
            dot.textContent = "●";
            tab.appendChild(dot);
        }
        const label = document.createElement("span");
        label.className = "file-name";
        label.textContent = f.name;
        tab.appendChild(label);
        const close = document.createElement("span");
        close.className = "tab-close";
        close.textContent = "×";
        close.title = "Close file";
        close.addEventListener("click", (e) => { e.stopPropagation(); closeEditorFile(sess, f.path); });
        tab.appendChild(close);
        tab.addEventListener("click", () => setEditorActiveFile(sess, f.path));
        bar.appendChild(tab);
    }
}

function closeEditorFile(sess, path) {
    const st = editorState(sess);
    if (editorFileIsDirty(path) && !confirm("Discard unsaved changes to this file?")) return;
    st.files = st.files.filter(f => f.path !== path);
    if (st.activeFile === path) setEditorActiveFile(sess, null);
    else renderEditorFileTabs(sess);
    // Dispose the model only if no other session tab still has the file open
    const usedElsewhere = Object.values(termSessions).some(
        s => s !== sess && s.editor && s.editor.files.some(f => f.path === path)
    );
    if (!usedElsewhere && editorModels[path]) {
        try { editorModels[path].model.dispose(); } catch (e) { /* already gone */ }
        delete editorModels[path];
    }
}

async function saveActiveEditorFile(force = false) {
    const sess = activeSess();
    if (!sess) return;
    const st = editorState(sess);
    const entry = st.activeFile && editorModels[st.activeFile];
    if (!entry) return;
    const project = editorProject(sess);
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/file`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                path: st.activeFile,
                content: entry.model.getValue(),
                known_mtime: entry.mtime,
                force,
            }),
        });
        const data = await resp.json();
        if (resp.status === 409) {
            if (confirm("This file changed on disk after you opened it (possibly by Claude).\n\nOK = overwrite the disk version with yours\nCancel = reload the disk version (your edits are lost)")) {
                return saveActiveEditorFile(true);
            }
            return reloadEditorFile(sess, st.activeFile);
        }
        if (!resp.ok) {
            showToast("Save failed: " + (data.error || resp.status), 4000);
            return;
        }
        entry.mtime = data.mtime;
        entry.savedVersionId = entry.model.getAlternativeVersionId();
        renderEditorFileTabs(sess);
        showToast("Saved " + entry.name, 1500);
    } catch (e) {
        showToast("Save failed: " + e, 4000);
    }
}

async function reloadEditorFile(sess, path) {
    const entry = editorModels[path];
    if (!entry) return;
    const project = editorProject(sess);
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`);
        const data = await resp.json();
        if (!resp.ok) {
            showToast("Reload failed: " + (data.error || resp.status), 4000);
            return;
        }
        entry.model.setValue(data.content);
        entry.mtime = data.mtime;
        entry.savedVersionId = entry.model.getAlternativeVersionId();
        renderEditorFileTabs(sess);
    } catch (e) {
        showToast("Reload failed: " + e, 4000);
    }
}

// ─── Terminal Controls ─────────────────────────────────────────────────────

function startTerminal() {
    const sess = activeSess();
    if (!sess || sess.running) return;

    // Bind the sidebar-selected project to THIS tab at spawn time. Changing
    // the sidebar selection later never affects a running tab.
    sess.project = activeProject;
    updateSessionTabEl(sess);

    // Two Claude sessions in the same working directory can stomp each
    // other's files - allowed, but say so.
    const clash = Object.values(termSessions).some(
        s => s !== sess && s.running && s.project && s.project === sess.project
    );
    if (clash) {
        showToast("Another running tab uses this project's directory - two sessions editing the same files can conflict.", 6000);
    }

    sess.term.clear();
    sess.term.writeln("\x1b[90m  Starting Claude Code...\x1b[0m\r\n");

    sess.account = currentAccount;
    updateSessionTabEl(sess);

    socket.emit("start_terminal", {
        terminal_id: sess.id,
        project: sess.project,
        permission_mode: currentPermissionMode,
        account: sess.account,
    });
}

async function stopTerminal() {
    const sess = activeSess();
    if (!sess || !sess.running) return;
    pendingStopTermId = sess.id;

    // Populate save modal's project selector from the current project list
    try {
        const resp = await fetch("/api/projects");
        const projects = await resp.json();
        const sel = document.getElementById("save-project-select");
        const currentProject = sess.project || "";
        sel.innerHTML = '<option value="">No project</option>' +
            projects.map(p =>
                `<option value="${escapeAttr(p.name)}" ${p.name === currentProject ? 'selected' : ''}>${escapeHtml(p.display_name || p.name)}</option>`
            ).join("");
    } catch (e) {
        console.error("Failed to load projects for save modal:", e);
    }

    openModal("save-modal");
}

function confirmStopAndSave() {
    const summary = document.getElementById("save-summary").value.trim();
    const tagsRaw = document.getElementById("save-tags").value.trim();
    const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : [];
    const project = document.getElementById("save-project-select").value || null;

    socket.emit("stop_terminal", { terminal_id: pendingStopTermId, project, summary, tags });
    pendingStopTermId = null;
    closeModal("save-modal");

    // Clear inputs
    document.getElementById("save-summary").value = "";
    document.getElementById("save-tags").value = "";
}

function discardTerminal() {
    const sess = activeSess();
    if (!sess || !sess.running) return;
    if (!confirm("Discard this session without saving?")) return;
    socket.emit("discard_terminal", { terminal_id: sess.id });
    sess.term.writeln("\r\n\x1b[90m── Session discarded ──\x1b[0m\r\n");
    setSessRunning(sess, false);
}

function switchToTerminalPanel() {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.querySelector('[data-tab="terminal"]').classList.add("active");
    document.getElementById("terminal-panel").classList.add("active");
}

// Ctrl+V handler: if the clipboard holds an image (e.g. a screenshot),
// upload it to the tab's project directory and prompt Claude to analyze
// it; otherwise paste clipboard text into the terminal as before.
async function pasteClipboardIntoSession(sess) {
    try {
        if (navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imgType = item.types.find(t => t.startsWith("image/"));
                if (imgType) {
                    const blob = await item.getType(imgType);
                    await uploadPastedImage(sess, blob, imgType);
                    return;
                }
            }
        }
    } catch (err) { /* rich clipboard unavailable - fall through to text */ }

    try {
        const text = await navigator.clipboard.readText();
        if (text && sess.running && socket) {
            socket.emit("terminal_input", { terminal_id: sess.id, data: text });
        }
    } catch (err) { /* nothing usable on the clipboard */ }
}

async function uploadPastedImage(sess, blob, mimeType) {
    const project = sess.project || activeProject;
    if (!project) {
        showToast("Select a project first so the pasted image has a destination directory.", 4000);
        return;
    }
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const ext = (mimeType.split("/")[1] || "png").replace("jpeg", "jpg");
    const filename = `pasted_image_${ts}.${ext}`;

    const formData = new FormData();
    formData.append("file", new File([blob], filename, { type: mimeType }));
    formData.append("project", project);
    try {
        const resp = await fetch("/api/upload", { method: "POST", body: formData });
        const data = await resp.json();
        if (data.error) {
            showToast("Image paste failed: " + data.error, 4000);
            return;
        }
        if (!sendPromptToActiveSession(`Read and analyze this pasted image in the current working directory: ${data.filename}\n`)) {
            showToast(`Image saved as ${data.filename} - start a session to have Claude analyze it.`, 4000);
        } else {
            showToast("Pasted image sent to Claude: " + data.filename, 2500);
        }
    } catch (err) {
        showToast("Image paste failed: " + err, 4000);
    }
}

// Send a prompt line to the active tab's running session, if any
function sendPromptToActiveSession(prompt) {
    const sess = activeSess();
    if (sess && sess.running && socket) {
        socket.emit("terminal_input", { terminal_id: sess.id, data: prompt });
        sess.term.focus();
        return true;
    }
    return false;
}

// Resume a saved session into the active tab if it is idle, otherwise a
// fresh tab - a running session is never stopped to make room. The session
// resumes under the ACCOUNT that created it (its transcript lives in that
// account's config dir), not the current selector.
function resumeInTab(project, claudeSessionId, workingDirectory, banner, account) {
    let sess = activeSess();
    if (!sess || sess.running) {
        sess = newSessionTab();
        if (!sess) return; // tab cap reached (toast already shown)
    }
    sess.project = project || null;
    sess.account = account || "Default";
    updateSessionTabEl(sess);

    switchToTerminalPanel();
    activateSessionTab(sess.id);

    sess.term.clear();
    sess.term.writeln(banner);

    socket.emit("resume_session", {
        terminal_id: sess.id,
        project: project,
        claude_session_id: claudeSessionId,
        working_directory: workingDirectory || "",
        permission_mode: currentPermissionMode,
        account: sess.account,
    });
}

function showConnectionStatus(state) {
    let indicator = document.getElementById("connection-status");
    if (!indicator) {
        indicator = document.createElement("span");
        indicator.id = "connection-status";
        indicator.style.cssText = "font-size:11px;padding:2px 8px;border-radius:8px;margin-left:8px;transition:opacity 0.3s;";
        document.querySelector(".titlebar-center").appendChild(indicator);
    }
    if (state === "connected") {
        indicator.textContent = "Connected";
        indicator.style.background = "#2ea04350";
        indicator.style.color = "#2ea043";
        // Fade out after 3 seconds
        setTimeout(() => { indicator.style.opacity = "0"; }, 3000);
    } else if (state === "disconnected") {
        indicator.style.opacity = "1";
        indicator.textContent = "Disconnected";
        indicator.style.background = "#f8514950";
        indicator.style.color = "#f85149";
    } else if (state === "reconnecting") {
        indicator.style.opacity = "1";
        indicator.textContent = "Reconnecting...";
        indicator.style.background = "#d2992250";
        indicator.style.color = "#d29922";
    }
}

// ─── Permission Mode ──────────────────────────────────────────────────────

const PERMISSION_MODES = {
    default:           { icon: "\u25C6", label: "Default (settings.json)" },
    askPermissions:    { icon: "\u270E", label: "Ask permissions" },
    autoAcceptEdits:   { icon: "</>",    label: "Auto accept edits" },
    planMode:          { icon: "\u2699", label: "Plan mode" },
    bypassPermissions: { icon: "\u26A0", label: "Bypass permissions" },
};

function initPermissionMode() {
    const btn = document.getElementById("btn-permission-mode");
    const menu = document.getElementById("permission-mode-menu");

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.style.display = menu.style.display === "none" ? "block" : "none";
    });

    document.querySelectorAll(".perm-option").forEach(opt => {
        opt.addEventListener("click", () => {
            const mode = opt.dataset.mode;
            setPermissionMode(mode);
            menu.style.display = "none";
        });
    });

    // Close menu when clicking outside
    document.addEventListener("click", () => {
        menu.style.display = "none";
    });
    menu.addEventListener("click", (e) => e.stopPropagation());

    // Restore the persisted mode (falls back to "default" if the stored
    // value is stale or unknown)
    if (!PERMISSION_MODES[currentPermissionMode]) currentPermissionMode = "default";
    setPermissionMode(currentPermissionMode, { silent: true });
}

function setPermissionMode(mode, opts = {}) {
    const info = PERMISSION_MODES[mode];
    if (!info) return;
    currentPermissionMode = mode;
    localStorage.setItem("permissionMode", mode);

    document.getElementById("permission-mode-icon").textContent = info.icon;
    document.getElementById("permission-mode-label").textContent = info.label;

    // Update checkmarks
    document.querySelectorAll(".perm-option").forEach(opt => {
        const check = opt.querySelector(".perm-option-check");
        if (opt.dataset.mode === mode) {
            opt.classList.add("selected");
            check.textContent = "\u2713";
        } else {
            opt.classList.remove("selected");
            check.textContent = "";
        }
    });

    // The mode is applied as CLI flags when a session spawns, so a change
    // never affects the session that is already running - tell the user.
    if (!opts.silent && anyRunning()) {
        showToast(`"${info.label}" saved - it applies to the NEXT session. Press Shift+Tab inside the terminal to change a running session's mode.`, 6000);
    }
}

// \u2500\u2500\u2500 Anthropic Account Selector \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// Each account maps to its own CLAUDE_CONFIG_DIR (and optionally an API
// key), letting you flip to a second subscription when the first hits its
// usage limit. The selection applies to the NEXT session you start; running
// tabs keep the account they spawned with, and resumes always use the
// session's original account.

function initAccountSelector() {
    const btn = document.getElementById("btn-account");
    const menu = document.getElementById("account-menu");

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menu.style.display === "none") {
            renderAccountMenu();
            menu.style.display = "block";
        } else {
            menu.style.display = "none";
        }
    });
    document.addEventListener("click", () => { menu.style.display = "none"; });
    menu.addEventListener("click", (e) => e.stopPropagation());

    updateAccountLabel();
}

function renderAccountMenu() {
    const menu = document.getElementById("account-menu");
    menu.innerHTML = "";
    const names = ["Default", ...ideAccounts.map(a => a.name)];
    for (const name of names) {
        const item = document.createElement("div");
        item.className = "account-option" + (name === currentAccount ? " selected" : "");
        item.textContent = (name === currentAccount ? "\u2713 " : "") + name;
        item.addEventListener("click", () => {
            setCurrentAccount(name);
            menu.style.display = "none";
        });
        menu.appendChild(item);
    }
    if (ideAccounts.length === 0) {
        const hint = document.createElement("div");
        hint.className = "account-option-hint";
        hint.textContent = "Add accounts in Settings (\u2699\ufe0f)";
        menu.appendChild(hint);
    }
}

function setCurrentAccount(name) {
    currentAccount = name;
    localStorage.setItem("claudeAccount", name);
    updateAccountLabel();
    if (anyRunning()) {
        showToast(`Account "${name}" applies to the NEXT session you start - running tabs keep their account.`, 5000);
    }
}

function updateAccountLabel() {
    // A stored selection may point at a deleted account - fall back
    if (currentAccount !== "Default" && !ideAccounts.some(a => a.name === currentAccount)) {
        currentAccount = "Default";
        localStorage.setItem("claudeAccount", currentAccount);
    }
    document.getElementById("account-label").textContent = currentAccount;
    // Hide the selector entirely when no extra accounts are configured
    document.getElementById("account-wrapper").style.display = "";
}

// \u2500\u2500\u2500 Toast Notifications \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function showToast(message, duration = 4000) {
    let toast = document.getElementById("ide-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "ide-toast";
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove("visible"), duration);
}

// Toast with an action button (e.g. "Install hook") and a dismiss ×
function showActionToast(message, buttonLabel, onAction, onDismiss) {
    const old = document.getElementById("ide-action-toast");
    if (old) old.remove();
    const toast = document.createElement("div");
    toast.id = "ide-action-toast";
    const text = document.createElement("span");
    text.textContent = message;
    const btn = document.createElement("button");
    btn.textContent = buttonLabel;
    btn.addEventListener("click", () => { toast.remove(); onAction(); });
    const close = document.createElement("button");
    close.className = "action-toast-close";
    close.textContent = "×";
    close.title = "Dismiss";
    close.addEventListener("click", () => { toast.remove(); if (onDismiss) onDismiss(); });
    toast.append(text, btn, close);
    document.body.appendChild(toast);
}

// ─── Session Attention (Claude needs your input) ───────────────────────────

function isWatching(sess) {
    return document.hasFocus() && !document.hidden && sess.id === activeTermId;
}

function markAttention(sess, message, opts = {}) {
    if (isWatching(sess)) return; // user is already looking at this session
    sess.needsAttention = true;
    updateSessionTabEl(sess);
    updateAttentionBadges();
    // Alert (OS toast + chime) at most once per attention episode - but a
    // hook event must still escalate a flag the silent idle heuristic set
    // first, so gate on "already alerted", not "already flagged".
    if (opts.alert && !sess.attentionAlerted && ideSettings.notifications_enabled) {
        sess.attentionAlerted = true;
        notifyDesktop(sess, message);
        if (ideSettings.notification_sound) playChime();
    }
}

function clearAttention(sess) {
    if (!sess) return;
    sess.attentionAlerted = false;
    if (!sess.needsAttention) return;
    sess.needsAttention = false;
    updateSessionTabEl(sess);
    updateAttentionBadges();
}

function updateAttentionBadges() {
    const count = Object.values(termSessions).filter(s => s.needsAttention).length;
    document.title = (count ? `(${count}) ` : "") + "Claude Code IDE";
    setFaviconBadge(count > 0);
}

function notifyDesktop(sess, message) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
        Notification.requestPermission();
        return;
    }
    if (Notification.permission !== "granted") return;
    const p = cachedProjects.find(x => x.name === sess.project);
    const title = (p && (p.display_name || p.name)) || sess.project || "Claude Code IDE";
    try {
        const n = new Notification(title, {
            body: message,
            icon: "/static/icons/favicon-32.png",
            tag: "claude-ide-" + sess.id, // replaces rather than stacks per session
        });
        n.onclick = () => {
            window.focus();
            activateSessionTab(sess.id);
            n.close();
        };
    } catch (e) { /* notification blocked */ }
}

// Short two-note chime via WebAudio - no audio asset needed.
//
// Chrome's autoplay policy: an AudioContext created while the window is
// unfocused (exactly when notifications fire) starts suspended and cannot
// be resumed without a user gesture - the chime would be silent. So the
// context is created and unlocked on the FIRST user gesture after page
// load (see the pre-warm listeners in DOMContentLoaded) and reused here.
let _audioCtx = null;
function ensureAudioContext() {
    try {
        _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (_audioCtx.state === "suspended") _audioCtx.resume();
    } catch (e) { /* audio unavailable */ }
}

function playChime() {
    try {
        ensureAudioContext();
        const now = _audioCtx.currentTime;
        for (const [freq, at] of [[880, 0], [1174.66, 0.12]]) {
            const osc = _audioCtx.createOscillator();
            const gain = _audioCtx.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, now + at);
            gain.gain.exponentialRampToValueAtTime(0.08, now + at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.25);
            osc.connect(gain).connect(_audioCtx.destination);
            osc.start(now + at);
            osc.stop(now + at + 0.3);
        }
    } catch (e) { /* audio unavailable */ }
}

// Badge the favicon with an orange dot while any session needs attention
let _baseFavicons = null;
function setFaviconBadge(on) {
    const links = document.querySelectorAll('link[rel="icon"]');
    if (!links.length) return;
    if (_baseFavicons === null) _baseFavicons = [...links].map(l => l.href);
    if (!on) {
        links.forEach((l, i) => { l.href = _baseFavicons[i]; });
        return;
    }
    const img = new Image();
    img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, 32, 32);
        ctx.fillStyle = "#ff8c00";
        ctx.beginPath();
        ctx.arc(24, 8, 7, 0, Math.PI * 2);
        ctx.fill();
        const badged = c.toDataURL("image/png");
        links.forEach(l => { l.href = badged; });
    };
    img.src = _baseFavicons[_baseFavicons.length - 1];
}

// Fallback signal for sessions without the Notification hook: while Claude
// works, the TUI redraws constantly (spinner), so the output stream is noisy;
// a sustained busy period followed by silence usually means it is waiting.
// Conservative treatment: attention dot + badges only, no OS toast or chime.
function noteOutputActivity(sess) {
    const now = Date.now();
    if (!sess.busyStart) sess.busyStart = now;
    sess.lastOutputAt = now;
    clearTimeout(sess.idleTimer);
    sess.idleTimer = setTimeout(() => {
        const busyMs = sess.lastOutputAt - sess.busyStart;
        sess.busyStart = null;
        if (sess.running && busyMs > 3000) {
            markAttention(sess, "Claude looks idle - it may be waiting for you", { alert: false });
        }
    }, 4000);
}

// Offer (once) to install the Claude Code Notification hook that powers
// the "needs your input" alerts
async function checkNotifyHook() {
    try {
        const resp = await fetch("/api/notify-hook-status");
        if (!resp.ok) return; // pre-Phase-22 server
        const status = await resp.json();
        if (status.installed || localStorage.getItem("notifyHookDismissed")) return;
        showActionToast(
            "Get notified when Claude needs your input? This adds a Notification hook to ~/.claude/settings.json.",
            "Install hook",
            async () => {
                try {
                    const res = await fetch("/api/install-notify-hook", { method: "POST" }).then(r => r.json());
                    if (res.status === "installed" || res.status === "already-installed") {
                        showToast("Notification hook installed - applies to sessions started from now on.", 5000);
                        if ("Notification" in window && Notification.permission === "default") {
                            Notification.requestPermission();
                        }
                    } else {
                        showToast("Hook install failed: " + (res.error || "unknown error"), 6000);
                    }
                } catch (e) {
                    showToast("Hook install failed: " + e, 6000);
                }
            },
            () => localStorage.setItem("notifyHookDismissed", "1")
        );
    } catch (e) { /* server unreachable - ignore */ }
}

// ─── UI Initialization ────────────────────────────────────────────────────

function initUI() {
    // Toolbar buttons
    document.getElementById("btn-start").addEventListener("click", startTerminal);
    document.getElementById("btn-stop").addEventListener("click", stopTerminal);
    document.getElementById("btn-discard").addEventListener("click", discardTerminal);
    document.getElementById("btn-resume").addEventListener("click", resumeSession);
    document.getElementById("btn-copy-uuid").addEventListener("click", copySessionUuid);
    document.getElementById("btn-confirm-save").addEventListener("click", confirmStopAndSave);

    // Permission mode dropdown
    initPermissionMode();

    // Editor pane (collapsed by default; < handle on the right edge)
    initEditorPane();

    // Usage dashboard
    document.getElementById("btn-usage-refresh").addEventListener("click", loadUsage);

    // Anthropic account selector + settings editor
    initAccountSelector();
    document.getElementById("btn-add-account").addEventListener("click", () => addAccountRow());

    // Git tab extras: open repo on GitHub + README viewer
    document.getElementById("btn-git-open-repo").addEventListener("click", openRepoClicked);
    document.getElementById("btn-git-readme").addEventListener("click", toggleGitReadme);
    document.addEventListener("click", (e) => {
        const wrap = document.getElementById("git-open-repo-wrapper");
        if (wrap && !wrap.contains(e.target)) {
            document.getElementById("git-remote-menu").style.display = "none";
        }
    });

    // Settings
    document.getElementById("btn-settings").addEventListener("click", openSettings);
    document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
    document.getElementById("btn-restart-server").addEventListener("click", restartServer);

    // Upload
    document.getElementById("btn-upload").addEventListener("click", () => {
        document.getElementById("file-upload-input").click();
    });
    document.getElementById("file-upload-input").addEventListener("change", uploadFile);

    // Screenshot
    document.getElementById("btn-screenshot").addEventListener("click", takeScreenshot);

    // Import external session
    document.getElementById("btn-import-session").addEventListener("click", openImportSessionModal);
    document.getElementById("btn-confirm-import-session").addEventListener("click", confirmImportSession);

    // Import conversation
    document.getElementById("btn-import").addEventListener("click", () => {
        if (!activeProject) {
            alert("Select a project first.");
            return;
        }
        document.getElementById("import-text").value = "";
        document.getElementById("import-label").value = "";
        document.getElementById("import-modal").style.display = "flex";
        document.getElementById("import-text").focus();
    });
    document.getElementById("btn-confirm-import").addEventListener("click", importConversation);

    // File tree
    document.getElementById("btn-toggle-filetree").addEventListener("click", toggleFileTree);
    document.getElementById("btn-refresh-filetree").addEventListener("click", loadFileTree);
    document.getElementById("btn-open-workdir").addEventListener("click", () => {
        if (!activeProject) { console.warn("open-workdir: no active project"); return; }
        console.log("open-workdir: requesting for", activeProject);
        fetch(`/api/projects/${activeProject}/open-workdir`, { method: "POST" })
            .then(r => r.json())
            .then(d => console.log("open-workdir response:", d))
            .catch(e => console.error("open-workdir error:", e));
    });

    // Git diff
    document.getElementById("btn-gitdiff-refresh").addEventListener("click", loadGitStatus);

    // Export buttons
    document.getElementById("btn-export-md").addEventListener("click", () => exportSession("md"));
    document.getElementById("btn-export-txt").addEventListener("click", () => exportSession("txt"));

    // CLAUDE.md buttons
    document.getElementById("btn-claudemd-save").addEventListener("click", saveClaudeMd);
    document.getElementById("btn-claudemd-reload").addEventListener("click", loadClaudeMd);

    // Track CLAUDE.md dirty state
    document.getElementById("claudemd-editor").addEventListener("input", () => {
        claudeMdDirty = true;
    });

    // Tab switching
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
            tab.classList.add("active");
            const panelId = tab.dataset.tab + "-panel";
            document.getElementById(panelId).classList.add("active");

            if (tab.dataset.tab === "terminal") {
                const sess = activeSess();
                if (sess) setTimeout(() => { try { sess.fitAddon.fit(); } catch (err) {} }, 50);
            }
            if (tab.dataset.tab !== "viewer") {
                document.getElementById("btn-resume").style.display = "none";
                document.getElementById("btn-export-md").style.display = "none";
                document.getElementById("btn-export-txt").style.display = "none";
                document.getElementById("viewer-uuid").style.display = "none";
                document.getElementById("btn-copy-uuid").style.display = "none";
            }
            if (tab.dataset.tab === "claudemd") {
                loadClaudeMd();
            }
            if (tab.dataset.tab === "gitdiff") {
                loadGitStatus();
            }
            if (tab.dataset.tab === "usage") {
                loadUsage();
            }
        });
    });

    // Navigate (live URL) button
    document.getElementById("btn-navigate").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleNavigateMenu();
    });

    // URLs modal: Add URL row
    document.getElementById("btn-add-url").addEventListener("click", () => {
        const list = document.getElementById("urls-list");
        // If currently empty placeholder, clear it first
        if (!list.querySelector(".url-row")) list.innerHTML = "";
        const div = document.createElement("div");
        div.className = "url-row";
        div.innerHTML = `
            <input type="text" class="url-label" placeholder="Label (e.g. Production)">
            <input type="text" class="url-value" placeholder="https://example.com">
            <button type="button" class="url-remove" title="Remove">&times;</button>`;
        div.querySelector(".url-remove").addEventListener("click", () => {
            div.remove();
            if (!list.querySelector(".url-row")) renderUrlsModal([]);
        });
        list.appendChild(div);
        div.querySelector(".url-label").focus();
    });

    // URLs modal: Save
    document.getElementById("btn-save-urls").addEventListener("click", saveUrlsModal);

    // Close navigate menu on outside click
    document.addEventListener("click", (e) => {
        const wrap = document.getElementById("navigate-wrapper");
        if (wrap && !wrap.contains(e.target)) {
            document.getElementById("navigate-menu").style.display = "none";
        }
    });

    // Work / personal filter - cycles All, Work only, Personal only
    document.getElementById("btn-work-filter").addEventListener("click", () => {
        const order = ["all", "work", "personal"];
        projectFilterMode = order[(order.indexOf(projectFilterMode) + 1) % order.length];
        updateWorkFilterButton();
        renderProjectList(cachedProjects);
    });

    // Project search
    const searchInput = document.getElementById("project-search");
    const clearBtn = document.getElementById("btn-clear-project-search");
    searchInput.addEventListener("input", () => {
        projectSearchQuery = searchInput.value.trim().toLowerCase();
        clearBtn.style.display = projectSearchQuery ? "" : "none";
        renderProjectList(cachedProjects);
    });
    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            searchInput.value = "";
            projectSearchQuery = "";
            clearBtn.style.display = "none";
            renderProjectList(cachedProjects);
        }
    });
    clearBtn.addEventListener("click", () => {
        searchInput.value = "";
        projectSearchQuery = "";
        clearBtn.style.display = "none";
        searchInput.focus();
        renderProjectList(cachedProjects);
    });

    // Archived projects
    document.getElementById("btn-archived").addEventListener("click", openArchivedModal);

    // New project
    document.getElementById("btn-new-project").addEventListener("click", () => {
        document.getElementById("new-project-name").value = "";
        document.getElementById("new-project-desc").value = "";
        document.getElementById("new-project-workdir").value = "";
        delete document.getElementById("new-project-workdir").dataset.manual;
        openModal("project-modal");
    });

    // Auto-fill working directory as user types project name
    document.getElementById("new-project-name").addEventListener("input", async () => {
        const name = document.getElementById("new-project-name").value.trim().replace(/\s+/g, "-").toLowerCase();
        const workdirInput = document.getElementById("new-project-workdir");
        if (name && !workdirInput.dataset.manual) {
            const resp = await fetch("/api/default-workdir?name=" + encodeURIComponent(name));
            const data = await resp.json();
            workdirInput.value = data.path || "";
        } else if (!name) {
            workdirInput.value = "";
            delete workdirInput.dataset.manual;
        }
    });

    // If user manually edits the workdir, stop auto-filling
    document.getElementById("new-project-workdir").addEventListener("input", () => {
        document.getElementById("new-project-workdir").dataset.manual = "true";
    });
    document.getElementById("btn-new-session").addEventListener("click", () => {
        // Switch to the terminal panel and start in the active tab; if that
        // tab already has a running session, open a fresh tab for this one.
        switchToTerminalPanel();
        const sess = activeSess();
        if (sess && sess.running) {
            if (!newSessionTab()) return; // tab cap reached
        }
        startTerminal();
    });
    document.getElementById("btn-create-project").addEventListener("click", createProject);

    // Search
    document.getElementById("btn-search").addEventListener("click", () => {
        openModal("search-modal");
        document.getElementById("search-input").focus();
    });
    document.getElementById("search-input").addEventListener("input", debounce(performSearch, 300));

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "F") {
            e.preventDefault();
            openModal("search-modal");
            document.getElementById("search-input").focus();
        }
        if (e.ctrlKey && e.key === "s") {
            // Ctrl+S: save CLAUDE.md if that panel is active
            const claudePanel = document.getElementById("claudemd-panel");
            if (claudePanel.classList.contains("active")) {
                e.preventDefault();
                saveClaudeMd();
            }
        }
        if (e.key === "Escape") {
            closeAllModals();
        }
    });

    // Sidebar resizer
    initSidebarResize();
}

// ─── Sidebar Resize ───────────────────────────────────────────────────────

function initSidebarResize() {
    const resizer = document.getElementById("sidebar-resizer");
    const sidebar = document.getElementById("sidebar");
    let startX, startWidth;

    resizer.addEventListener("mousedown", (e) => {
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        resizer.classList.add("dragging");

        const onMouseMove = (e) => {
            const newWidth = startWidth + (e.clientX - startX);
            sidebar.style.width = Math.max(180, Math.min(400, newWidth)) + "px";
            const sess = activeSess();
            if (sess) { try { sess.fitAddon.fit(); } catch (err) {} }
        };

        const onMouseUp = () => {
            resizer.classList.remove("dragging");
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    });
}

// ─── Projects ──────────────────────────────────────────────────────────────

async function loadProjects() {
    try {
        const resp = await fetch("/api/projects");
        const projects = await resp.json();
        cachedProjects = projects;
        renderProjectList(projects);
        // Session tabs resolve display names from cachedProjects - refresh
        // labels in case tabs were created before the list arrived
        for (const sess of Object.values(termSessions)) updateSessionTabEl(sess);
    } catch (e) {
        console.error("Failed to load projects:", e);
    }
}

const FILTER_MODE_INFO = {
    all:      { icon: "⚑",  title: "Showing all projects - click to show work only" },
    work:     { icon: "💼", title: "Showing work projects only - click to show personal only" },
    personal: { icon: "🏠", title: "Showing personal projects only - click to show all" },
};

function updateWorkFilterButton() {
    const btn = document.getElementById("btn-work-filter");
    const info = FILTER_MODE_INFO[projectFilterMode];
    btn.textContent = info.icon;
    btn.title = info.title;
    btn.classList.toggle("active", projectFilterMode !== "all");
}

function renderProjectList(projects) {
    const list = document.getElementById("project-list");
    let visible = projects;
    if (projectFilterMode === "work") {
        visible = projects.filter(p => p.work_related);
    } else if (projectFilterMode === "personal") {
        visible = projects.filter(p => !p.work_related);
    }
    if (projectSearchQuery) {
        visible = visible.filter(p =>
            (p.display_name || "").toLowerCase().includes(projectSearchQuery) ||
            (p.name || "").toLowerCase().includes(projectSearchQuery)
        );
    }

    if (projects.length === 0) {
        list.innerHTML = `
            <div style="padding: 16px; color: var(--text-muted); font-size: 12px; text-align: center;">
                No projects yet.<br>Click + to create one.
            </div>`;
        return;
    }
    if (visible.length === 0) {
        let msg;
        if (projectSearchQuery) {
            msg = `No projects match "<b>${escapeHtml(projectSearchQuery)}</b>".`;
        } else if (projectFilterMode === "work") {
            msg = "No work-related projects yet.<br>Check the Work box on any project.";
        } else {
            msg = "No personal projects.<br>Every project is marked as Work.";
        }
        list.innerHTML = `
            <div style="padding: 16px; color: var(--text-muted); font-size: 12px; text-align: center;">
                ${msg}
            </div>`;
        return;
    }

    list.innerHTML = visible.map(p => {
        const lastDate = p.last_session_mtime ? new Date(p.last_session_mtime * 1000) : (p.created ? new Date(p.created) : null);
        const dateStr = lastDate ? lastDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
        const pinIcon = p.pinned ? "📌" : "📁";
        const checked = p.work_related ? "checked" : "";

        return `
        <div class="sidebar-item ${activeProject === p.name ? 'active' : ''}"
             data-project="${escapeAttr(p.name)}"
             title="${escapeAttr((p.description || p.name) + ' — ' + p.session_count + ' session(s). Right-click for options.')}">
            <span class="item-icon">${pinIcon}</span>
            <span class="item-label">${escapeHtml(p.display_name || p.name)}</span>
            <span class="item-meta">${dateStr}</span>
            ${p.session_count > 0 ? `<button class="quick-resume-btn" data-qr-project="${escapeAttr(p.name)}" title="Quick-resume last session">▶</button>` : ''}
            <span class="item-count">${p.session_count}</span>
            <label class="work-checkbox" title="Mark as work-related">
                <input type="checkbox" data-work-project="${escapeAttr(p.name)}" ${checked}>
            </label>
        </div>`;
    }).join("");

    list.querySelectorAll(".sidebar-item[data-project]").forEach(el => {
        el.addEventListener("click", () => selectProject(el.dataset.project));
        el.addEventListener("contextmenu", (e) => onProjectContextMenu(e, el.dataset.project));
    });

    // Work-related checkboxes
    list.querySelectorAll('input[data-work-project]').forEach(cb => {
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", async (e) => {
            e.stopPropagation();
            await toggleWorkRelated(cb.dataset.workProject, cb.checked);
        });
    });
    // Prevent row click when clicking the label wrapper
    list.querySelectorAll(".work-checkbox").forEach(lbl => {
        lbl.addEventListener("click", (e) => e.stopPropagation());
    });

    // Quick-resume buttons
    list.querySelectorAll(".quick-resume-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            quickResume(btn.dataset.qrProject);
        });
    });
}

async function toggleWorkRelated(project, value) {
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/work-related`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ work_related: value }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        const proj = cachedProjects.find(p => p.name === project);
        if (proj) proj.work_related = value;
        if (projectFilterMode !== "all") renderProjectList(cachedProjects);
    } catch (e) {
        console.error("Failed to toggle work-related:", e);
        await loadProjects();
    }
}

async function selectProject(name) {
    // Multi-session tabs: switching projects is always allowed. A running
    // tab captured its project at spawn time, and save destinations are
    // derived from the session's working directory server-side.
    activeProject = name;
    document.getElementById("active-project-label").textContent = name;

    // Highlight in sidebar
    document.querySelectorAll("#project-list .sidebar-item").forEach(el => {
        el.classList.toggle("active", el.dataset.project === name);
    });

    // Show sessions header and load sessions
    document.getElementById("sessions-header").style.display = "flex";
    await loadSessions(name);

    // Update navigate (live URL) button visibility
    updateNavigateButton(name);

    // Refresh file tree if visible
    if (fileTreeVisible) loadFileTree();
}

// ─── Navigate (live URL) Button ────────────────────────────────────────────

function updateNavigateButton(projectName) {
    const wrapper = document.getElementById("navigate-wrapper");
    const menu = document.getElementById("navigate-menu");
    menu.style.display = "none";
    const proj = cachedProjects.find(p => p.name === projectName);
    const urls = (proj && Array.isArray(proj.urls)) ? proj.urls : [];
    if (!urls.length) {
        wrapper.style.display = "none";
        return;
    }
    wrapper.style.display = "block";
    const btn = document.getElementById("btn-navigate");
    if (urls.length === 1) {
        btn.title = `Open ${urls[0].label}: ${urls[0].url}`;
    } else {
        btn.title = `Open one of ${urls.length} URLs for this project`;
    }
}

function toggleNavigateMenu() {
    const proj = cachedProjects.find(p => p.name === activeProject);
    const urls = (proj && Array.isArray(proj.urls)) ? proj.urls : [];
    if (!urls.length) return;
    if (urls.length === 1) {
        window.open(urls[0].url, "_blank", "noopener");
        return;
    }
    const menu = document.getElementById("navigate-menu");
    if (menu.style.display === "block") {
        menu.style.display = "none";
        return;
    }
    menu.innerHTML = urls.map((u, i) => `
        <div class="nav-menu-item" data-nav-index="${i}">
            <span class="nav-label">${escapeHtml(u.label)}</span>
            <span class="nav-url">${escapeHtml(u.url)}</span>
        </div>
    `).join("");
    menu.querySelectorAll(".nav-menu-item").forEach(el => {
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.navIndex, 10);
            const u = urls[idx];
            if (u) window.open(u.url, "_blank", "noopener");
            menu.style.display = "none";
        });
    });
    menu.style.display = "block";
}

// ─── Project URLs Modal ────────────────────────────────────────────────────

let urlsModalProject = null;

async function openUrlsModal(projectName) {
    urlsModalProject = projectName;
    document.getElementById("urls-modal-title").textContent = `Live URLs — ${projectName}`;
    let urls = [];
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(projectName)}/urls`);
        if (resp.ok) {
            const data = await resp.json();
            urls = data.urls || [];
        }
    } catch (e) { console.error("Failed to load URLs:", e); }
    renderUrlsModal(urls);
    openModal("urls-modal");
}

function renderUrlsModal(urls) {
    const list = document.getElementById("urls-list");
    if (!urls.length) {
        list.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">No URLs configured. Click + Add URL below.</div>`;
        return;
    }
    list.innerHTML = urls.map((u, i) => `
        <div class="url-row" data-url-index="${i}">
            <input type="text" class="url-label" value="${escapeAttr(u.label || '')}" placeholder="Label (e.g. Production)">
            <input type="text" class="url-value" value="${escapeAttr(u.url || '')}" placeholder="https://example.com">
            <button type="button" class="url-remove" title="Remove">&times;</button>
        </div>
    `).join("");
    list.querySelectorAll(".url-remove").forEach(btn => {
        btn.addEventListener("click", () => {
            btn.closest(".url-row").remove();
            if (!list.querySelector(".url-row")) renderUrlsModal([]);
        });
    });
}

function readUrlsFromModal() {
    const rows = document.querySelectorAll("#urls-list .url-row");
    const out = [];
    rows.forEach(r => {
        const label = r.querySelector(".url-label").value.trim();
        const url = r.querySelector(".url-value").value.trim();
        if (url) out.push({ label: label || url, url });
    });
    return out;
}

async function saveUrlsModal() {
    if (!urlsModalProject) return;
    const urls = readUrlsFromModal();
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(urlsModalProject)}/urls`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        const proj = cachedProjects.find(p => p.name === urlsModalProject);
        if (proj) proj.urls = data.urls;
        if (urlsModalProject === activeProject) updateNavigateButton(activeProject);
        closeModal("urls-modal");
    } catch (e) {
        alert("Failed to save URLs: " + e);
    }
}

async function createProject() {
    const name = document.getElementById("new-project-name").value.trim();
    const desc = document.getElementById("new-project-desc").value.trim();
    const workdir = document.getElementById("new-project-workdir").value.trim();

    if (!name) return;

    // Check if working directory exists
    if (workdir) {
        try {
            const checkResp = await fetch("/api/check-directory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: workdir }),
            });
            const checkData = await checkResp.json();

            if (!checkData.exists) {
                if (!confirm(`Directory does not exist:\n${workdir}\n\nCreate it?`)) {
                    return;
                }
                const createResp = await fetch("/api/create-directory", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: workdir }),
                });
                const createData = await createResp.json();
                if (createData.error) {
                    alert(`Failed to create directory: ${createData.error}`);
                    return;
                }
            }
        } catch (e) {
            console.error("Directory check failed:", e);
        }
    }

    try {
        const body = { name, display_name: name, description: desc };
        if (workdir) body.working_directory = workdir;

        await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        closeModal("project-modal");
        document.getElementById("new-project-name").value = "";
        document.getElementById("new-project-desc").value = "";
        document.getElementById("new-project-workdir").value = "";
        await loadProjects();
        selectProject(name.replace(/\s+/g, "-").toLowerCase());
    } catch (e) {
        console.error("Failed to create project:", e);
    }
}

// ─── Sessions ──────────────────────────────────────────────────────────────

async function loadSessions(project) {
    try {
        const resp = await fetch(`/api/projects/${project}/sessions`);
        const sessions = await resp.json();
        renderSessionList(sessions, project);
    } catch (e) {
        console.error("Failed to load sessions:", e);
    }
}

function renderSessionList(sessions, project) {
    const list = document.getElementById("session-list");
    if (sessions.length === 0) {
        list.innerHTML = `
            <div style="padding: 16px; color: var(--text-muted); font-size: 11px; text-align: center;">
                No sessions yet.<br>Start Claude Code to create one.
            </div>`;
        return;
    }

    list.innerHTML = sessions.map(s => {
        const date = new Date(s.created);
        const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const timeStr = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        const label = s.summary || `Session ${dateStr}`;

        const uuidHint = s.claude_session_id ? `\nUUID: ${s.claude_session_id}` : '';
        return `
            <div class="sidebar-item session-item ${activeSessionId === s.id ? 'active' : ''}"
                 data-session-project="${escapeAttr(project)}" data-session-id="${escapeAttr(s.id)}"
                 title="${escapeAttr(label + ' — ' + dateStr + ' ' + timeStr + uuidHint + '\nRight-click for options.')}">
                <span class="item-icon">💬</span>
                <span class="item-label">${escapeHtml(label)}</span>
                <span class="session-date">${dateStr} ${timeStr}</span>
            </div>`;
    }).join("");

    list.querySelectorAll(".session-item[data-session-id]").forEach(el => {
        el.addEventListener("click", () => viewSession(el.dataset.sessionProject, el.dataset.sessionId));
        el.addEventListener("contextmenu", (e) => onSessionContextMenu(e, el.dataset.sessionProject, el.dataset.sessionId));
    });
}

async function viewSession(project, sessionId) {
    activeSessionId = sessionId;
    viewedSessionProject = project;

    // Switch to viewer tab
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.querySelector('[data-tab="viewer"]').classList.add("active");
    document.getElementById("viewer-panel").classList.add("active");

    // Highlight in sidebar
    document.querySelectorAll("#session-list .sidebar-item").forEach(el => {
        el.classList.toggle("active", el.dataset.sessionId === sessionId);
    });

    try {
        const [sessionResp, transcriptResp] = await Promise.all([
            fetch(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`),
            fetch(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/transcript`),
        ]);
        const session = await sessionResp.json();
        const transcriptData = await transcriptResp.json();

        document.getElementById("viewer-title").textContent =
            session.summary || `Session from ${new Date(session.created).toLocaleString()}`;

        // Show UUID with copy button
        const uuidSpan = document.getElementById("viewer-uuid");
        const btnCopyUuid = document.getElementById("btn-copy-uuid");
        if (session.claude_session_id) {
            uuidSpan.textContent = session.claude_session_id;
            uuidSpan.style.display = "";
            btnCopyUuid.style.display = "";
        } else {
            uuidSpan.style.display = "none";
            btnCopyUuid.style.display = "none";
        }

        const content = document.getElementById("session-content");
        const btnResume = document.getElementById("btn-resume");
        const btnExportMd = document.getElementById("btn-export-md");
        const btnExportTxt = document.getElementById("btn-export-txt");
        const cleaned = transcriptData.transcript || "";
        const hasResumableSession = !!session.claude_session_id;

        // Show resume button if session has a Claude session ID (even without transcript)
        btnResume.style.display = hasResumableSession ? "" : "none";

        if (cleaned) {
            content.textContent = cleaned;
            btnExportMd.style.display = "";
            btnExportTxt.style.display = "";
        } else {
            btnExportMd.style.display = "none";
            btnExportTxt.style.display = "none";
            content.innerHTML = `
                <div class="empty-state">
                    <p>${hasResumableSession
                        ? "This is an imported session — no transcript was recorded.<br>Click <b>Resume This Session</b> to continue where it left off."
                        : "This session has no recorded content."}</p>
                </div>`;
        }
    } catch (e) {
        console.error("Failed to load session:", e);
    }
}

// ─── Copy UUID ──────────────────────────────────────────────────────────────

function copySessionUuid() {
    const uuid = document.getElementById("viewer-uuid").textContent;
    if (!uuid) return;
    navigator.clipboard.writeText(uuid).then(() => {
        const btn = document.getElementById("btn-copy-uuid");
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
    }).catch(() => {});
}

// ─── Resume Session ─────────────────────────────────────────────────────────

async function resumeSession() {
    const project = viewedSessionProject;
    const sessionId = activeSessionId;
    if (!project || !sessionId) return;

    try {
        // Fetch session metadata to get the Claude session ID
        const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`);
        if (!resp.ok) {
            console.error("Failed to fetch session for resume");
            return;
        }
        const session = await resp.json();

        if (!session.claude_session_id) {
            alert("This session was saved before resume support was added and cannot be resumed natively.");
            return;
        }

        resumeInTab(
            project,
            session.claude_session_id,
            session.working_directory || "",
            "\x1b[90m  Resuming previous session...\x1b[0m\r\n",
            session.account
        );
    } catch (e) {
        console.error("Failed to resume session:", e);
    }
}

// ─── Export ─────────────────────────────────────────────────────────────

async function exportSession(format) {
    if (!viewedSessionProject || !activeSessionId) return;

    try {
        const resp = await fetch(
            `/api/projects/${encodeURIComponent(viewedSessionProject)}/sessions/${encodeURIComponent(activeSessionId)}/export?format=${format}`
        );
        if (!resp.ok) throw new Error("Export failed");

        const blob = await resp.blob();
        const disposition = resp.headers.get("Content-Disposition") || "";
        const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : `session.${format}`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Export failed:", e);
    }
}

// ─── Compare / Diff ─────────────────────────────────────────────────────

// ─── Git Tab Extras (open repo, README viewer) ──────────────────────────

// Lazy-load marked + DOMPurify from CDN for README rendering
let _mdLibsReady = null;
function loadMarkdownLibs() {
    if (_mdLibsReady) return _mdLibsReady;
    const addScript = (src) => new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error("failed to load " + src));
        document.head.appendChild(s);
    });
    _mdLibsReady = Promise.all([
        addScript("https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"),
        addScript("https://cdn.jsdelivr.net/npm/dompurify@3.0.9/dist/purify.min.js"),
    ]).catch(e => { _mdLibsReady = null; throw e; });
    return _mdLibsReady;
}

// Populate the Open Repo button from the project's git remotes
async function loadGitRemotes() {
    const wrapper = document.getElementById("git-open-repo-wrapper");
    wrapper.style.display = "none";
    wrapper.dataset.remotes = "[]";
    if (!activeProject) return;
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(activeProject)}/git-remotes`);
        if (!resp.ok) return;
        const data = await resp.json();
        const remotes = data.remotes || [];
        if (!remotes.length) return;
        wrapper.dataset.remotes = JSON.stringify(remotes);
        wrapper.style.display = "";
    } catch (e) { /* no remotes - keep hidden */ }
}

function openRepoClicked(e) {
    e.stopPropagation();
    const wrapper = document.getElementById("git-open-repo-wrapper");
    const remotes = JSON.parse(wrapper.dataset.remotes || "[]");
    if (!remotes.length) return;
    if (remotes.length === 1) {
        window.open(remotes[0].url, "_blank");
        return;
    }
    // Multiple repos - let the user pick which one to open
    const menu = document.getElementById("git-remote-menu");
    if (menu.style.display !== "none") {
        menu.style.display = "none";
        return;
    }
    menu.innerHTML = "";
    for (const r of remotes) {
        const item = document.createElement("div");
        item.className = "git-remote-option";
        item.textContent = r.url.replace("https://", "");
        item.title = `${r.name}: ${r.url}`;
        item.addEventListener("click", () => {
            menu.style.display = "none";
            window.open(r.url, "_blank");
        });
        menu.appendChild(item);
    }
    menu.style.display = "block";
}

// Toggle between the git status/diff view and the rendered README
async function toggleGitReadme() {
    const readmeView = document.getElementById("git-readme-view");
    const diffView = document.getElementById("gitdiff-content");
    const btn = document.getElementById("btn-git-readme");

    if (readmeView.style.display !== "none") {
        readmeView.style.display = "none";
        diffView.style.display = "";
        btn.classList.remove("primary");
        return;
    }
    if (!activeProject) {
        showToast("Select a project first.", 3000);
        return;
    }
    const content = document.getElementById("git-readme-content");
    content.innerHTML = '<div style="color:var(--text-muted);">Loading README…</div>';
    readmeView.style.display = "";
    diffView.style.display = "none";
    btn.classList.add("primary");
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(activeProject)}/readme`);
        const data = await resp.json();
        if (!resp.ok) {
            content.innerHTML = `<div style="color:var(--text-muted);">${escapeHtml(data.error || "No README found")}</div>`;
            return;
        }
        await loadMarkdownLibs();
        content.innerHTML = DOMPurify.sanitize(marked.parse(data.content));
    } catch (e) {
        content.textContent = "Failed to render README: " + e;
    }
}

function showGitDiffView() {
    document.getElementById("git-readme-view").style.display = "none";
    document.getElementById("gitdiff-content").style.display = "";
    document.getElementById("btn-git-readme").classList.remove("primary");
}

// ─── CLAUDE.md Editor ───────────────────────────────────────────────────

async function loadClaudeMd() {
    if (!activeProject) {
        document.getElementById("claudemd-path").textContent = "No project selected";
        document.getElementById("claudemd-editor").value = "";
        return;
    }

    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(activeProject)}/claude-md`);
        const data = await resp.json();
        document.getElementById("claudemd-path").textContent = data.path || `${activeProject}/CLAUDE.md`;
        document.getElementById("claudemd-editor").value = data.content || "";
        claudeMdDirty = false;
    } catch (e) {
        console.error("Failed to load CLAUDE.md:", e);
        document.getElementById("claudemd-editor").value = "";
    }
}

async function saveClaudeMd() {
    if (!activeProject) return;

    const content = document.getElementById("claudemd-editor").value;
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(activeProject)}/claude-md`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
        });
        if (resp.ok) {
            claudeMdDirty = false;
            // Brief visual feedback
            const btn = document.getElementById("btn-claudemd-save");
            const original = btn.textContent;
            btn.textContent = "Saved!";
            setTimeout(() => { btn.textContent = original; }, 1500);
        }
    } catch (e) {
        console.error("Failed to save CLAUDE.md:", e);
    }
}

// ─── Settings ───────────────────────────────────────────────────────────

async function openSettings() {
    // Load current settings
    try {
        const [settingsResp, projectsResp] = await Promise.all([
            fetch("/api/settings"),
            fetch("/api/projects"),
        ]);
        const settings = await settingsResp.json();
        const projects = await projectsResp.json();

        document.getElementById("settings-claude-cmd").value = settings.claude_cmd || "claude";
        document.getElementById("settings-font-size").value = settings.font_size || 14;
        document.getElementById("settings-notifications").checked = settings.notifications_enabled !== false;
        document.getElementById("settings-notification-sound").checked = settings.notification_sound !== false;
        renderAccountsEditor(settings.accounts || []);

        const sel = document.getElementById("settings-default-project");
        sel.innerHTML = '<option value="">None</option>' +
            projects.map(p =>
                `<option value="${escapeAttr(p.name)}" ${p.name === settings.default_project ? 'selected' : ''}>${escapeHtml(p.display_name || p.name)}</option>`
            ).join("");
    } catch (e) {
        console.error("Failed to load settings:", e);
    }

    openModal("settings-modal");
}

async function saveSettings() {
    const claudeCmd = document.getElementById("settings-claude-cmd").value.trim();
    const defaultProject = document.getElementById("settings-default-project").value;
    const fontSize = parseInt(document.getElementById("settings-font-size").value) || 14;
    const notificationsEnabled = document.getElementById("settings-notifications").checked;
    const notificationSound = document.getElementById("settings-notification-sound").checked;
    const accounts = collectAccountsFromEditor();

    try {
        const resp = await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                claude_cmd: claudeCmd,
                default_project: defaultProject,
                font_size: fontSize,
                notifications_enabled: notificationsEnabled,
                notification_sound: notificationSound,
                accounts: accounts,
            }),
        });
        if (resp.ok) {
            for (const sess of Object.values(termSessions)) {
                sess.term.options.fontSize = fontSize;
                try { sess.fitAddon.fit(); } catch (err) { /* hidden tab */ }
            }
            ideSettings.notifications_enabled = notificationsEnabled;
            ideSettings.notification_sound = notificationSound;
            // Ask for OS notification permission the moment the user opts in
            if (notificationsEnabled && "Notification" in window && Notification.permission === "default") {
                Notification.requestPermission();
            }
            ideAccounts = accounts;
            updateAccountLabel();
            // Audible confirmation - saving is a user gesture, so this also
            // unlocks the audio engine for later background chimes
            if (notificationSound) playChime();
            closeModal("settings-modal");
        }
    } catch (e) {
        console.error("Failed to save settings:", e);
    }
}

async function restartServer() {
    if (!confirm("Kill the IDE server?\n\nYou will need to restart it manually to continue using the IDE.")) return;
    closeModal("settings-modal");
    try {
        await fetch("/api/restart", { method: "POST" });
    } catch (e) { /* expected — server is shutting down */ }
    for (const sess of Object.values(termSessions)) {
        sess.term.writeln("\r\n\x1b[31m  Server killed. Restart manually to continue.\x1b[0m\r\n");
    }
}

async function applyStartupSettings() {
    try {
        const resp = await fetch("/api/settings");
        const settings = await resp.json();

        if (settings.font_size && settings.font_size !== 14) {
            for (const sess of Object.values(termSessions)) {
                sess.term.options.fontSize = settings.font_size;
                try { sess.fitAddon.fit(); } catch (err) { /* hidden tab */ }
            }
        }

        if (settings.default_project) {
            selectProject(settings.default_project);
        }

        ideSettings.notifications_enabled = settings.notifications_enabled !== false;
        ideSettings.notification_sound = settings.notification_sound !== false;
        ideAccounts = settings.accounts || [];
        updateAccountLabel();
    } catch (e) {
        // Settings not saved yet, use defaults
    }
}

// ─── Accounts editor (Settings modal) ─────────────────────────────────────

function renderAccountsEditor(accounts) {
    const container = document.getElementById("settings-accounts");
    container.innerHTML = "";
    for (const acct of accounts) addAccountRow(acct);
    if (!accounts.length) {
        const hint = document.createElement("div");
        hint.className = "accounts-empty-hint";
        hint.textContent = "No extra accounts - sessions use your normal Claude Code identity.";
        container.appendChild(hint);
    }
}

function addAccountRow(acct = {}) {
    const container = document.getElementById("settings-accounts");
    const emptyHint = container.querySelector(".accounts-empty-hint");
    if (emptyHint) emptyHint.remove();

    const row = document.createElement("div");
    row.className = "account-row";
    const mkInput = (cls, placeholder, value, type = "text", title = "") => {
        const inp = document.createElement("input");
        inp.type = type;
        inp.className = cls;
        inp.placeholder = placeholder;
        inp.value = value || "";
        inp.title = title;
        return inp;
    };
    row.appendChild(mkInput("acct-name", "Name (e.g. Work)", acct.name, "text", "Shown in the account selector"));
    row.appendChild(mkInput("acct-dir", "Config dir (e.g. C:\\Users\\you\\.claude-work)", acct.config_dir, "text", "CLAUDE_CONFIG_DIR for this account - created on first use; run /login once inside a session"));
    row.appendChild(mkInput("acct-key", "API key (optional)", acct.api_key, "password", "Sets ANTHROPIC_API_KEY for key-based accounts; leave empty for subscription logins"));
    const remove = document.createElement("button");
    remove.className = "account-row-remove";
    remove.textContent = "×";
    remove.title = "Remove this account";
    remove.addEventListener("click", () => row.remove());
    row.appendChild(remove);
    container.appendChild(row);
}

function collectAccountsFromEditor() {
    const accounts = [];
    document.querySelectorAll("#settings-accounts .account-row").forEach(row => {
        const name = row.querySelector(".acct-name").value.trim();
        if (!name) return;
        accounts.push({
            name,
            config_dir: row.querySelector(".acct-dir").value.trim(),
            api_key: row.querySelector(".acct-key").value.trim(),
        });
    });
    return accounts;
}

// ─── Usage Dashboard ────────────────────────────────────────────────────

function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
}

function fmtCost(v) {
    if (v >= 1000) return "$" + (v / 1000).toFixed(1) + "K";
    if (v >= 100) return "$" + v.toFixed(0);
    return "$" + v.toFixed(2);
}

async function loadUsage() {
    const status = document.getElementById("usage-status");
    status.textContent = "Scanning Claude Code transcripts... (first load can take a while)";
    try {
        const resp = await fetch("/api/usage");
        const data = await resp.json();
        if (!resp.ok) {
            status.textContent = "Usage unavailable: " + (data.error || resp.status);
            return;
        }
        status.textContent = `${data.sessions_counted} sessions with usage data · updated ${new Date(data.generated).toLocaleTimeString()}`;
        renderUsage(data);
    } catch (e) {
        status.textContent = "Usage unavailable: " + e;
    }
}

function renderUsage(data) {
    // Summary cards
    const cards = document.getElementById("usage-cards");
    cards.innerHTML = "";
    const defs = [
        ["Last 7 days", data.totals.last7],
        ["Last 30 days", data.totals.last30],
        ["All time", data.totals.all],
    ];
    for (const [label, t] of defs) {
        const card = document.createElement("div");
        card.className = "usage-card";
        card.innerHTML =
            `<div class="usage-card-label">${escapeHtml(label)}</div>` +
            `<div class="usage-card-big">${fmtTokens(t.output)} <span>out</span></div>` +
            `<div class="usage-card-small">${fmtTokens(t.input + t.cache_read + t.cache_creation)} in+cache · ${t.turns.toLocaleString()} turns</div>` +
            `<div class="usage-card-cost" title="Estimated at API rates - for subscription accounts this is API-equivalent value, not a bill">≈ ${fmtCost(t.cost || 0)}</div>`;
        cards.appendChild(card);
    }

    // Per-account table (which Anthropic account the usage was billed to)
    const abody = document.querySelector("#usage-accounts-table tbody");
    abody.innerHTML = "";
    for (const a of (data.accounts || [])) {
        const tr = document.createElement("tr");
        for (const c of [
            a.account,
            a.sessions.toLocaleString(),
            a.turns.toLocaleString(),
            fmtTokens(a.input),
            fmtTokens(a.output),
            fmtTokens(a.cache_read),
            fmtCost(a.cost || 0),
            (a.last_used || "").slice(0, 10),
        ]) {
            const td = document.createElement("td");
            td.textContent = c;
            tr.appendChild(td);
        }
        abody.appendChild(tr);
    }

    // Daily bar chart (output tokens)
    const chart = document.getElementById("usage-chart");
    chart.innerHTML = "";
    const days = data.days || [];
    const max = Math.max(1, ...days.map(d => d.output));
    for (const d of days) {
        const col = document.createElement("div");
        col.className = "usage-bar";
        col.style.height = Math.max(2, Math.round((d.output / max) * 100)) + "%";
        col.title = `${d.date}\n${fmtTokens(d.output)} output · ${fmtTokens(d.input + d.cache_read + d.cache_creation)} in+cache · ${d.turns} turns · ≈ ${fmtCost(d.cost || 0)}`;
        chart.appendChild(col);
    }
    if (!days.length) chart.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px;">No activity in the last 30 days</div>';

    // Per-project table
    const tbody = document.querySelector("#usage-table tbody");
    tbody.innerHTML = "";
    for (const p of data.projects) {
        const proj = cachedProjects.find(x => x.name === p.project);
        const name = (proj && (proj.display_name || proj.name)) || p.project;
        const tr = document.createElement("tr");
        const cells = [
            name,
            p.sessions.toLocaleString(),
            p.turns.toLocaleString(),
            fmtTokens(p.input),
            fmtTokens(p.output),
            fmtTokens(p.cache_read),
            fmtCost(p.cost || 0),
            (p.last_used || "").slice(0, 10),
        ];
        for (const c of cells) {
            const td = document.createElement("td");
            td.textContent = c;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
}

// ─── File Upload ────────────────────────────────────────────────────────

async function uploadFile() {
    const input = document.getElementById("file-upload-input");
    const file = input.files[0];
    if (!file) return;

    // Reset input so the same file can be re-uploaded
    input.value = "";

    if (!activeProject) {
        alert("Select a project first so the file has a destination directory.");
        return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("project", activeProject);

    try {
        const resp = await fetch("/api/upload", {
            method: "POST",
            body: formData,
        });
        const data = await resp.json();

        if (data.error) {
            alert("Upload failed: " + data.error);
            return;
        }

        // If the active tab has a running session, tell Claude to read the file
        if (!sendPromptToActiveSession(`Read and analyze this file in the current working directory: ${data.filename}\n`)) {
            alert(`File uploaded to:\n${data.path}\n\nStart a Claude Code session to have it read the file.`);
        }
    } catch (e) {
        console.error("Upload failed:", e);
        alert("Upload failed. Check console for details.");
    }
}

// ─── Screenshot Capture ─────────────────────────────────────────────────

async function takeScreenshot() {
    if (!activeProject) {
        alert("Select a project first so the screenshot has a destination directory.");
        return;
    }

    const btn = document.getElementById("btn-screenshot");
    const origText = btn.textContent;
    btn.textContent = "✂️ capturing...";
    btn.disabled = true;

    try {
        const resp = await fetch("/api/screenshot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project: activeProject }),
        });
        const data = await resp.json();

        if (data.error) {
            alert("Screenshot failed: " + data.error);
            return;
        }

        // If the active tab has a running session, tell Claude to look at the screenshot
        if (!sendPromptToActiveSession(`Read and analyze this screenshot image in the current working directory: ${data.filename}\n`)) {
            alert(`Screenshot saved to:\n${data.path}\n\nStart a Claude Code session to have Claude analyze it.`);
        }
    } catch (e) {
        console.error("Screenshot failed:", e);
        alert("Screenshot failed. Check console for details.");
    } finally {
        btn.textContent = origText;
        btn.disabled = false;
    }
}


// ─── Git Diff ───────────────────────────────────────────────────────────

async function loadGitStatus() {
    showGitDiffView();
    loadGitRemotes();
    if (!activeProject) {
        document.getElementById("gitdiff-status-label").textContent = "Select a project first";
        document.getElementById("gitdiff-files").innerHTML = "";
        document.getElementById("gitdiff-diff").textContent = "";
        return;
    }

    document.getElementById("gitdiff-status-label").textContent = "Loading...";

    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(activeProject)}/git-status`);
        const data = await resp.json();

        if (data.error) {
            document.getElementById("gitdiff-status-label").textContent = data.error;
            document.getElementById("gitdiff-diff").textContent = "";

            if (data.no_workdir) {
                document.getElementById("gitdiff-files").innerHTML = `
                    <div style="padding:16px;text-align:center;">
                        <p style="color:var(--text-muted);font-size:12px;">No working directory set for this project.<br>Right-click the project to set one.</p>
                    </div>`;
            } else if (data.is_git === false) {
                document.getElementById("gitdiff-files").innerHTML = `
                    <div style="padding:16px;text-align:center;">
                        <p style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">This project directory is not a git repository.</p>
                        <button id="btn-git-init" class="toolbar-btn primary" style="margin:0 auto;">Initialize Git Repo</button>
                    </div>`;
                document.getElementById("btn-git-init").addEventListener("click", async () => {
                    try {
                        const initResp = await fetch("/api/projects/" + encodeURIComponent(activeProject) + "/git-init", { method: "POST" });
                        const initData = await initResp.json();
                        if (initData.error) {
                            alert("Failed: " + initData.error);
                        } else {
                            loadGitStatus();
                        }
                    } catch (err) {
                        alert("Failed to initialize git repo.");
                    }
                });
            } else {
                document.getElementById("gitdiff-files").innerHTML = "";
            }
            return;
        }

        // Status label
        const changeCount = data.files.length;
        document.getElementById("gitdiff-status-label").textContent =
            `Branch: ${data.branch || '(none)'} — ${changeCount} changed file${changeCount !== 1 ? 's' : ''}`;

        // File list
        const filesDiv = document.getElementById("gitdiff-files");
        if (data.files.length === 0 && data.log.length === 0) {
            filesDiv.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;">Working tree clean</div>';
        } else {
            let html = '';

            // Changed files
            if (data.files.length > 0) {
                html += data.files.map(f => {
                    const statusClass = `git-status-${f.status.replace('?', '\\?')}`;
                    return `<div class="git-file-item" data-gitfile="${escapeAttr(f.path)}" title="${escapeAttr(f.path)}">
                        <span class="git-status ${statusClass}">${escapeHtml(f.status)}</span>
                        <span>${escapeHtml(f.path)}</span>
                    </div>`;
                }).join('');
            }

            // Recent commits
            if (data.log && data.log.length > 0) {
                html += '<div style="padding:6px 12px 2px;font-size:10px;color:var(--text-muted);letter-spacing:0.5px;border-top:1px solid var(--border);">RECENT COMMITS</div>';
                html += data.log.map(line => {
                    const spaceIdx = line.indexOf(' ');
                    const hash = spaceIdx > 0 ? line.substring(0, spaceIdx) : line;
                    const msg = spaceIdx > 0 ? line.substring(spaceIdx + 1) : '';
                    return `<div class="git-log-item"><span class="git-log-hash">${escapeHtml(hash)}</span>${escapeHtml(msg)}</div>`;
                }).join('');
            }

            filesDiv.innerHTML = html;
        }

        // Diff content with syntax highlighting
        const diffDiv = document.getElementById("gitdiff-diff");
        if (data.diff) {
            diffDiv.innerHTML = renderGitDiff(data.diff);
        } else {
            diffDiv.textContent = "No uncommitted changes";
        }
    } catch (e) {
        console.error("Failed to load git status:", e);
        document.getElementById("gitdiff-status-label").textContent = "Failed to load git status";
    }
}

function renderGitDiff(diffText) {
    return diffText.split('\n').map(line => {
        let cls = '';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-line-add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-line-del';
        else if (line.startsWith('@@')) cls = 'diff-line-hunk';
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls = 'diff-line-header';

        return `<div class="${cls}">${escapeHtml(line)}</div>`;
    }).join('');
}


// ─── File Tree ──────────────────────────────────────────────────────────

let fileTreeVisible = false;

function toggleFileTree() {
    const panel = document.getElementById("filetree-panel");
    fileTreeVisible = !fileTreeVisible;
    panel.style.display = fileTreeVisible ? "" : "none";
    if (fileTreeVisible && activeProject) {
        loadFileTree();
    }
    // Refit terminal after layout change
    setTimeout(() => {
        const sess = activeSess();
        if (sess) { try { sess.fitAddon.fit(); } catch (err) {} }
    }, 50);
}

async function loadFileTree() {
    const pathEl = document.getElementById("filetree-path");

    if (!activeProject) {
        pathEl.textContent = "";
        document.getElementById("filetree-content").innerHTML =
            '<div style="padding:10px;color:var(--text-muted);font-size:11px;">No project selected</div>';
        return;
    }

    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(activeProject)}/files`);
        const data = await resp.json();

        pathEl.textContent = data.path || "";
        pathEl.title = data.path || "Project working directory";

        if (data.error) {
            document.getElementById("filetree-content").innerHTML =
                `<div style="padding:10px;color:var(--text-muted);font-size:11px;">${escapeHtml(data.error)}</div>`;
            return;
        }

        document.getElementById("filetree-content").innerHTML = renderFileTree(data.tree, 0);

        // Add click handlers for directories
        document.getElementById("filetree-content").querySelectorAll(".ft-dir-toggle").forEach(toggle => {
            toggle.addEventListener("click", (e) => {
                e.stopPropagation();
                const children = toggle.closest(".ft-item").nextElementSibling;
                if (children && children.classList.contains("ft-children")) {
                    children.classList.toggle("open");
                    toggle.textContent = children.classList.contains("open") ? "▾" : "▸";
                }
            });
        });

        // Click on file to tell Claude to read it
        document.getElementById("filetree-content").querySelectorAll(".ft-item[data-filepath]").forEach(item => {
            item.addEventListener("click", () => {
                const filepath = item.dataset.filepath.replaceAll("\\", "/");
                sendPromptToActiveSession(`Read the file: ${filepath}\n`);
            });
        });
    } catch (e) {
        console.error("Failed to load file tree:", e);
    }
}

function renderFileTree(entries, depth) {
    if (!entries || entries.length === 0) return '';

    return entries.map(entry => {
        const indent = depth * 16;
        const icon = entry.is_dir ? "📁" : getFileIcon(entry.name);

        if (entry.is_dir) {
            return `
                <div class="ft-item" style="padding-left:${8 + indent}px">
                    <span class="ft-dir-toggle">▸</span>
                    <span class="ft-icon">${icon}</span>
                    <span class="ft-name">${escapeHtml(entry.name)}</span>
                </div>
                <div class="ft-children">${renderFileTree(entry.children, depth + 1)}</div>`;
        } else {
            const sizeStr = formatFileSize(entry.size || 0);
            return `
                <div class="ft-item" style="padding-left:${8 + indent + 14}px" data-filepath="${escapeAttr(entry.path)}" title="Click to ask Claude to read this file">
                    <span class="ft-icon">${icon}</span>
                    <span class="ft-name">${escapeHtml(entry.name)}</span>
                    <span class="ft-size">${sizeStr}</span>
                </div>`;
        }
    }).join('');
}

function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = {
        py: '🐍', js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
        json: '{}', md: '📝', txt: '📄', csv: '📊',
        html: '🌐', css: '🎨', svg: '🖼️',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', ico: '🖼️',
        xlsx: '📊', xls: '📊', docx: '📃', pptx: '📊',
        pdf: '📕', zip: '📦', gz: '📦', tar: '📦',
        yml: '⚙️', yaml: '⚙️', toml: '⚙️', ini: '⚙️', cfg: '⚙️',
        sh: '⚡', bat: '⚡', ps1: '⚡',
        git: '🔀', gitignore: '🔀',
    };
    return icons[ext] || '📄';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}


// ─── Import Conversation ────────────────────────────────────────────────

async function importConversation() {
    const text = document.getElementById("import-text").value.trim();
    if (!text) {
        alert("Paste some text first.");
        return;
    }

    const label = document.getElementById("import-label").value.trim();

    try {
        const resp = await fetch("/api/import-conversation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project: activeProject, text, label }),
        });
        const data = await resp.json();

        if (data.error) {
            alert("Import failed: " + data.error);
            return;
        }

        closeModal("import-modal");

        // If the active tab has a running session, tell Claude to read the imported conversation
        if (!sendPromptToActiveSession(`I've imported a previous conversation for context. Read this file in the current working directory and continue from where it left off: ${data.filename}\n`)) {
            alert(`Conversation saved to:\n${data.path}\n\nStart a Claude Code session to have Claude pick up from it.`);
        }
    } catch (e) {
        console.error("Import failed:", e);
        alert("Import failed. Check console for details.");
    }
}


// ─── Import External Session ────────────────────────────────────────────

async function openImportSessionModal() {
    const listDiv = document.getElementById("import-session-list");
    listDiv.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">Loading sessions...</div>';
    document.getElementById("import-session-name").value = "";
    document.getElementById("import-session-summary").value = "";
    document.getElementById("import-session-id").value = "";
    document.getElementById("import-session-workdir").value = "";
    openModal("import-session-modal");

    try {
        const resp = await fetch("/api/local-sessions");
        const sessions = await resp.json();

        if (sessions.length === 0) {
            listDiv.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">No local Claude Code sessions found.</div>';
            return;
        }

        listDiv.innerHTML = sessions.map(s => {
            const date = s.last_timestamp
                ? new Date(s.last_timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : "?";
            const time = s.last_timestamp
                ? new Date(s.last_timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
                : "";
            const dir = (s.project || "").replace(/\\/g, "/");
            const dirShort = dir.length > 50 ? "..." + dir.slice(-47) : dir;
            const prompt = s.first_prompt || "(no prompt)";

            return `
                <div class="import-session-item" data-sid="${escapeAttr(s.sessionId)}" data-dir="${escapeAttr(s.project || "")}" data-prompt="${escapeAttr(prompt)}"
                     style="padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s;"
                     onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background=''">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
                        <span style="font-size:12px;color:var(--text-primary);font-weight:500;">${escapeHtml(prompt.substring(0, 80))}${prompt.length > 80 ? '...' : ''}</span>
                        <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;margin-left:12px;">${date} ${time}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);">
                        <span style="font-family:Consolas,monospace;opacity:0.7;" title="Session UUID">${escapeHtml(s.sessionId)}</span>
                        <span>${s.prompt_count} prompt${s.prompt_count !== 1 ? 's' : ''}</span>
                    </div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:1px;">
                        <span title="${escapeAttr(dir)}">${escapeHtml(dirShort)}</span>
                    </div>
                </div>`;
        }).join("");

        // Click to select a session
        listDiv.querySelectorAll(".import-session-item").forEach(item => {
            item.addEventListener("click", () => {
                // Deselect previous
                listDiv.querySelectorAll(".import-session-item").forEach(el => {
                    el.style.background = "";
                    el.style.borderLeft = "";
                });
                // Highlight selected
                item.style.background = "var(--bg-hover)";
                item.style.borderLeft = "3px solid var(--accent)";

                const sid = item.dataset.sid;
                const dir = item.dataset.dir;
                const prompt = item.dataset.prompt;

                document.getElementById("import-session-id").value = sid;
                document.getElementById("import-session-workdir").value = dir;

                // Auto-fill project name from first prompt
                const autoName = prompt.substring(0, 50).replace(/[^a-zA-Z0-9\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "imported-session";
                document.getElementById("import-session-name").value = autoName;
                document.getElementById("import-session-summary").value = prompt.substring(0, 100);
            });
        });
    } catch (e) {
        console.error("Failed to load local sessions:", e);
        listDiv.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">Failed to load sessions.</div>';
    }
}

async function confirmImportSession() {
    const sessionId = document.getElementById("import-session-id").value;
    const projectName = document.getElementById("import-session-name").value.trim();
    const summary = document.getElementById("import-session-summary").value.trim();
    const workdir = document.getElementById("import-session-workdir").value;

    if (!sessionId) {
        alert("Select a session from the list or paste a UUID.");
        return;
    }
    if (!projectName) {
        alert("Enter a project name.");
        return;
    }

    try {
        const resp = await fetch("/api/import-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: sessionId,
                project_name: projectName,
                display_name: projectName,
                working_directory: workdir,
                summary: summary || "Imported session",
            }),
        });
        const data = await resp.json();

        if (data.error) {
            alert("Import failed: " + data.error);
            return;
        }

        closeModal("import-session-modal");
        await loadProjects();
        selectProject(data.project);
    } catch (e) {
        console.error("Import session failed:", e);
        alert("Import failed. Check console for details.");
    }
}


// ─── Context Menu ───────────────────────────────────────────────────────

function showContextMenu(e, items) {
    e.preventDefault();
    const menu = document.getElementById("context-menu");
    menu.innerHTML = items.map(item => {
        if (item === "---") return '<div class="ctx-separator"></div>';
        return `<button class="ctx-item ${item.danger ? 'danger' : ''}" data-action="${item.action}">${escapeHtml(item.label)}</button>`;
    }).join("");

    menu.style.display = "block";
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10) + "px";

    menu.querySelectorAll(".ctx-item").forEach(btn => {
        btn.addEventListener("click", () => {
            menu.style.display = "none";
            const action = btn.dataset.action;
            const matched = items.find(i => i.action === action);
            if (matched && matched.handler) matched.handler();
        });
    });
}

// Close context menu on any click
document.addEventListener("click", () => {
    document.getElementById("context-menu").style.display = "none";
});

function onProjectContextMenu(e, projectName) {
    // Check if project is currently pinned
    const item = document.querySelector(`.sidebar-item[data-project="${projectName}"] .item-icon`);
    const isPinned = item && item.textContent.trim() === "📌";

    showContextMenu(e, [
        { label: isPinned ? "Unpin Project" : "Pin to Top", action: "pin", handler: () => togglePinProject(projectName) },
        { label: "Set Working Directory", action: "workdir", handler: () => setProjectWorkDir(projectName) },
        { label: "Manage Live URLs...", action: "urls", handler: () => openUrlsModal(projectName) },
        { label: "Rename Project", action: "rename", handler: () => renameProject(projectName) },
        "---",
        { label: "Archive Project", action: "archive", handler: () => archiveProject(projectName) },
        { label: "Delete Project", action: "delete", danger: true, handler: () => deleteProject(projectName) },
    ]);
}

function onSessionContextMenu(e, project, sessionId) {
    showContextMenu(e, [
        { label: "Rename Session", action: "rename", handler: () => renameSession(project, sessionId) },
        { label: "Move to Project...", action: "move", handler: () => moveSession(project, sessionId) },
        { label: "Copy UUID", action: "copy-uuid", handler: () => copySessionUuidFromList(project, sessionId) },
        "---",
        { label: "Delete Session", action: "delete", danger: true, handler: () => deleteSession(project, sessionId) },
    ]);
}

async function copySessionUuidFromList(project, sessionId) {
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`);
        if (!resp.ok) {
            alert("Failed to load session.");
            return;
        }
        const session = await resp.json();
        const uuid = session.claude_session_id;
        if (!uuid) {
            alert("This session has no Claude UUID (saved before resume support was added).");
            return;
        }
        await navigator.clipboard.writeText(uuid);
    } catch (e) {
        console.error("Copy UUID failed:", e);
    }
}

async function togglePinProject(name) {
    try {
        await fetch(`/api/projects/${encodeURIComponent(name)}/pin`, { method: "POST" });
        await loadProjects();
    } catch (e) {
        console.error("Pin toggle failed:", e);
    }
}

async function quickResume(projectName) {
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(projectName)}/sessions`);
        const sessions = await resp.json();

        if (sessions.length === 0) return;

        const latest = sessions[0]; // Already sorted newest first
        if (!latest.claude_session_id) {
            alert("The most recent session cannot be resumed (no Claude session ID).");
            return;
        }

        await selectProject(projectName);

        resumeInTab(
            projectName,
            latest.claude_session_id,
            latest.working_directory || "",
            `\x1b[90m  Quick-resuming last session: ${latest.summary || latest.id}...\x1b[0m\r\n`,
            latest.account
        );
    } catch (e) {
        console.error("Quick resume failed:", e);
    }
}

async function setProjectWorkDir(name) {
    // Fetch current working directory to show in prompt
    let currentWd = "";
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(name)}/workdir`);
        const data = await resp.json();
        currentWd = data.working_directory || "";
    } catch (e) { /* ignore */ }

    const newDir = prompt("Enter working directory path:", currentWd);
    if (newDir === null) return; // cancelled

    // Check if directory exists
    if (newDir.trim()) {
        try {
            const checkResp = await fetch("/api/check-directory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: newDir.trim() }),
            });
            const checkData = await checkResp.json();

            if (!checkData.exists) {
                if (!confirm(`Directory does not exist:\n${newDir.trim()}\n\nCreate it?`)) return;
                const createResp = await fetch("/api/create-directory", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: newDir.trim() }),
                });
                const createData = await createResp.json();
                if (createData.error) {
                    alert("Failed to create directory: " + createData.error);
                    return;
                }
            }
        } catch (e) {
            console.error("Directory check failed:", e);
        }
    }

    try {
        await fetch(`/api/projects/${encodeURIComponent(name)}/workdir`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ working_directory: newDir.trim() }),
        });
        await loadProjects();
        if (fileTreeVisible) loadFileTree();
    } catch (e) {
        console.error("Set working directory failed:", e);
    }
}

async function renameProject(name) {
    const newName = prompt("Enter new project name:");
    if (!newName || !newName.trim()) return;

    try {
        await fetch(`/api/projects/${encodeURIComponent(name)}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: newName.trim() }),
        });
        await loadProjects();
    } catch (e) {
        console.error("Rename failed:", e);
    }
}

async function archiveProject(name) {
    if (Object.values(termSessions).some(s => s.running && s.project === name)) {
        alert("Stop the running terminal session(s) using this project before archiving it.");
        return;
    }
    if (!confirm(`Archive project "${name}"?\n\nIt will be hidden from the projects list. You can restore it anytime from the Archived Projects view (🗃️).`)) return;

    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(name)}/archive`, { method: "POST" });
        const data = await resp.json();
        if (data.error) {
            alert("Archive failed: " + data.error);
            return;
        }
        if (activeProject === name) {
            activeProject = null;
            document.getElementById("active-project-label").textContent = "No project selected";
            document.getElementById("sessions-header").style.display = "none";
            document.getElementById("session-list").innerHTML = "";
        }
        await loadProjects();
    } catch (e) {
        console.error("Archive failed:", e);
        alert("Archive failed. Check console for details.");
    }
}

// ─── Archived Projects Modal ────────────────────────────────────────────

async function openArchivedModal() {
    const list = document.getElementById("archived-list");
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">Loading...</div>';
    openModal("archived-modal");

    try {
        const resp = await fetch("/api/archived");
        const projects = await resp.json();

        if (!projects.length) {
            list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No archived projects.<br>Right-click a project and choose "Archive Project" to move it here.</div>';
            return;
        }

        list.innerHTML = projects.map(p => `
            <div class="archived-row" data-archived="${escapeAttr(p.name)}">
                <span class="item-icon">🗃️</span>
                <div class="archived-info">
                    <div class="archived-name">${escapeHtml(p.display_name || p.name)}</div>
                    ${p.description ? `<div class="archived-desc">${escapeHtml(p.description)}</div>` : ""}
                </div>
                <span class="item-count">${p.session_count}</span>
                <button class="toolbar-btn archived-restore" data-restore="${escapeAttr(p.name)}" title="Move this project back to the projects list">Restore</button>
            </div>
        `).join("");

        list.querySelectorAll("button[data-restore]").forEach(btn => {
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                btn.textContent = "Restoring...";
                try {
                    const r = await fetch(`/api/archived/${encodeURIComponent(btn.dataset.restore)}/unarchive`, { method: "POST" });
                    const d = await r.json();
                    if (d.error) {
                        alert("Restore failed: " + d.error);
                        btn.disabled = false;
                        btn.textContent = "Restore";
                        return;
                    }
                    await loadProjects();
                    openArchivedModal(); // Refresh the modal list
                } catch (e) {
                    console.error("Restore failed:", e);
                    btn.disabled = false;
                    btn.textContent = "Restore";
                }
            });
        });
    } catch (e) {
        console.error("Failed to load archived projects:", e);
        list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">Failed to load archived projects.</div>';
    }
}

async function deleteProject(name) {
    if (!confirm(`Delete project "${name}" and ALL its sessions? This cannot be undone.`)) return;

    try {
        await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
        if (activeProject === name) {
            activeProject = null;
            document.getElementById("active-project-label").textContent = "No project selected";
            document.getElementById("sessions-header").style.display = "none";
            document.getElementById("session-list").innerHTML = "";
        }
        await loadProjects();
    } catch (e) {
        console.error("Delete failed:", e);
    }
}

async function renameSession(project, sessionId) {
    const newSummary = prompt("Enter new session name:");
    if (!newSummary || !newSummary.trim()) return;

    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ summary: newSummary.trim() }),
        });
        const data = await resp.json();
        if (data.error) {
            alert("Rename failed: " + data.error);
            return;
        }
        await loadSessions(project);
    } catch (e) {
        console.error("Rename failed:", e);
        alert("Rename failed. Check console.");
    }
}

async function moveSession(fromProject, sessionId) {
    try {
        const resp = await fetch("/api/projects");
        const projects = await resp.json();
        const otherProjects = projects.filter(p => p.name !== fromProject);

        if (otherProjects.length === 0) {
            alert("No other projects to move to. Create one first.");
            return;
        }

        const choices = otherProjects.map((p, i) => `${i + 1}. ${p.display_name || p.name}`).join("\n");
        const pick = prompt(`Move session to which project?\n\n${choices}\n\nEnter number:`);
        if (!pick) return;

        const idx = parseInt(pick) - 1;
        if (isNaN(idx) || idx < 0 || idx >= otherProjects.length) {
            alert("Invalid selection.");
            return;
        }

        const toProject = otherProjects[idx].name;
        const moveResp = await fetch(`/api/projects/${encodeURIComponent(fromProject)}/sessions/${encodeURIComponent(sessionId)}/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to_project: toProject }),
        });
        const moveData = await moveResp.json();

        if (moveData.error) {
            alert("Move failed: " + moveData.error);
            return;
        }

        await loadSessions(fromProject);
        await loadProjects();
    } catch (e) {
        console.error("Move session failed:", e);
    }
}

async function deleteSession(project, sessionId) {
    if (!confirm("Delete this session? This cannot be undone.")) return;

    try {
        await fetch(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        if (activeSessionId === sessionId) {
            activeSessionId = null;
            document.getElementById("session-content").innerHTML = '<div class="empty-state"><div class="empty-icon">📂</div><p>Select a session from the sidebar to view its conversation history.</p></div>';
            document.getElementById("btn-resume").style.display = "none";
            document.getElementById("btn-export-md").style.display = "none";
            document.getElementById("btn-export-txt").style.display = "none";
        }
        await loadSessions(project);
        await loadProjects();
    } catch (e) {
        console.error("Delete failed:", e);
    }
}

// ─── Search ────────────────────────────────────────────────────────────────

async function performSearch() {
    const query = document.getElementById("search-input").value.trim();
    const resultsDiv = document.getElementById("search-results");

    if (!query) {
        resultsDiv.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center;">Type to search...</div>';
        return;
    }

    try {
        const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const results = await resp.json();

        if (results.length === 0) {
            resultsDiv.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center;">No results found.</div>';
            return;
        }

        resultsDiv.innerHTML = results.map(r => `
            <div class="search-result" data-search-project="${escapeAttr(r.project)}" data-search-session="${escapeAttr(r.session_id)}">
                <div class="search-result-header">
                    <span class="search-result-project">${escapeHtml(r.project)}</span>
                    <span class="search-result-date">${new Date(r.created).toLocaleDateString()}</span>
                </div>
                <div class="search-result-snippet">${escapeHtml(r.snippet)}</div>
            </div>
        `).join("");

        resultsDiv.querySelectorAll(".search-result[data-search-session]").forEach(el => {
            el.addEventListener("click", () => {
                closeModal("search-modal");
                viewSession(el.dataset.searchProject, el.dataset.searchSession);
            });
        });
    } catch (e) {
        resultsDiv.innerHTML = '<div style="padding:16px;color:var(--text-muted);">Search failed.</div>';
    }
}

// ─── Modal Helpers ─────────────────────────────────────────────────────────

function openModal(id) {
    document.getElementById(id).style.display = "flex";
}

function closeModal(id) {
    document.getElementById(id).style.display = "none";
}

function closeAllModals() {
    document.querySelectorAll(".modal").forEach(m => m.style.display = "none");
}

// Click outside modal to close
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal")) {
        e.target.style.display = "none";
    }
});

// ─── Utilities ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function debounce(fn, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}
