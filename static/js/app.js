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

        // Auto-resume every tab that was running before the disconnect
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
        if (sess.id === activeTermId) sess.term.focus();
    });

    socket.on("terminal_output", (msg) => {
        const sess = routeSess(msg);
        if (sess && msg.data) sess.term.write(msg.data);
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
    newSessionTab(); // the initial tab
}

function newSessionTab() {
    const count = Object.keys(termSessions).length;
    if (count >= MAX_SESSION_TABS) {
        showToast(`Tab limit reached (${MAX_SESSION_TABS}). Close a tab first.`, 4000);
        return null;
    }
    if (legacySingleSession && count >= 1) {
        showToast("The server is running the pre-multi-tab backend. Restart the server (start-ide.bat) to enable multiple tabs.", 6000);
        return null;
    }

    const id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, "")
        : Date.now().toString(36) + Math.random().toString(36).slice(2);

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
        project: null,
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
    sess.term.focus();
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
    sess.tabEl.querySelector(".session-tab-label").textContent = name;
    sess.tabEl.title = name + (sess.running ? " (running)" : "");
    sess.tabEl.querySelector(".session-tab-dot").className =
        "session-tab-dot " + (sess.running ? "running" : "idle");
}

function setSessRunning(sess, running) {
    sess.running = running;
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

        // Ctrl+V: read clipboard and send directly
        if (e.key === "v" || e.key === "V") {
            ctrlVJustFired = true;
            setTimeout(() => { ctrlVJustFired = false; }, 200);
            navigator.clipboard.readText().then(text => {
                if (text && sess.running && socket) {
                    socket.emit("terminal_input", { terminal_id: sess.id, data: text });
                }
            }).catch(() => {});
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

    socket.emit("start_terminal", {
        terminal_id: sess.id,
        project: sess.project,
        permission_mode: currentPermissionMode,
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
// fresh tab - a running session is never stopped to make room.
function resumeInTab(project, claudeSessionId, workingDirectory, banner) {
    let sess = activeSess();
    if (!sess || sess.running) {
        sess = newSessionTab();
        if (!sess) return; // tab cap reached (toast already shown)
    }
    sess.project = project || null;
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

    // Compare button
    document.getElementById("btn-compare").addEventListener("click", compareSessions);

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
            if (tab.dataset.tab === "diff") {
                populateDiffSelectors();
            }
            if (tab.dataset.tab === "claudemd") {
                loadClaudeMd();
            }
            if (tab.dataset.tab === "gitdiff") {
                loadGitStatus();
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
            "\x1b[90m  Resuming previous session...\x1b[0m\r\n"
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

async function populateDiffSelectors() {
    if (!activeProject) {
        document.getElementById("diff-content-a").textContent = "Select a project first.";
        document.getElementById("diff-content-b").textContent = "";
        return;
    }

    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(activeProject)}/sessions`);
        const sessions = await resp.json();

        const options = sessions.map(s => {
            const date = new Date(s.created);
            const label = s.summary || `Session ${date.toLocaleDateString()}`;
            return `<option value="${escapeAttr(s.id)}">${escapeHtml(label)} (${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })})</option>`;
        }).join("");

        document.getElementById("diff-select-a").innerHTML = options;
        document.getElementById("diff-select-b").innerHTML = options;

        // Pre-select different sessions if possible
        if (sessions.length >= 2) {
            document.getElementById("diff-select-b").selectedIndex = 1;
        }
    } catch (e) {
        console.error("Failed to populate diff selectors:", e);
    }
}

async function compareSessions() {
    const idA = document.getElementById("diff-select-a").value;
    const idB = document.getElementById("diff-select-b").value;
    if (!activeProject || !idA || !idB) return;

    try {
        const resp = await fetch(
            `/api/sessions/compare?projectA=${encodeURIComponent(activeProject)}&sessionA=${encodeURIComponent(idA)}&projectB=${encodeURIComponent(activeProject)}&sessionB=${encodeURIComponent(idB)}`
        );
        const data = await resp.json();
        if (data.error) {
            document.getElementById("diff-content-a").textContent = data.error;
            document.getElementById("diff-content-b").textContent = "";
            return;
        }

        document.getElementById("diff-header-a").textContent = data.a.summary || "Session A";
        document.getElementById("diff-header-b").textContent = data.b.summary || "Session B";
        document.getElementById("diff-content-a").textContent = data.a.transcript || "(empty)";
        document.getElementById("diff-content-b").textContent = data.b.transcript || "(empty)";
    } catch (e) {
        console.error("Compare failed:", e);
    }
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

    try {
        const resp = await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                claude_cmd: claudeCmd,
                default_project: defaultProject,
                font_size: fontSize,
            }),
        });
        if (resp.ok) {
            for (const sess of Object.values(termSessions)) {
                sess.term.options.fontSize = fontSize;
                try { sess.fitAddon.fit(); } catch (err) { /* hidden tab */ }
            }
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
    } catch (e) {
        // Settings not saved yet, use defaults
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
            `\x1b[90m  Quick-resuming last session: ${latest.summary || latest.id}...\x1b[0m\r\n`
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
