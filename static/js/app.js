/**
 * Claude Code IDE — Frontend Application
 * =======================================
 * Handles the terminal (xterm.js), WebSocket communication,
 * project/session sidebar, and search.
 */

// ─── State ─────────────────────────────────────────────────────────────────

let socket = null;
let terminal = null;
let fitAddon = null;
let isTerminalRunning = false;
let activeProject = null;
let activeSessionId = null;

// ─── Initialize ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initSocket();
    initTerminal();
    initUI();
    loadProjects();
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────

function initSocket() {
    socket = io({ transports: ["websocket", "polling"] });

    socket.on("connect", () => {
        console.log("[IDE] Connected to server");
    });

    socket.on("disconnect", () => {
        console.log("[IDE] Disconnected");
        setTerminalStopped();
    });

    socket.on("terminal_ready", () => {
        console.log("[IDE] Terminal ready");
        setTerminalRunning();
        terminal.focus();
    });

    socket.on("terminal_output", (msg) => {
        if (terminal && msg.data) {
            terminal.write(msg.data);
        }
    });

    socket.on("terminal_exit", (msg) => {
        terminal.writeln("\r\n\x1b[90m── Session ended ──\x1b[0m\r\n");
        setTerminalStopped();
    });

    socket.on("terminal_error", (msg) => {
        terminal.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        setTerminalStopped();
    });

    socket.on("session_saved", (msg) => {
        console.log("[IDE] Session saved:", msg.id);
        if (activeProject) {
            loadSessions(activeProject);
        }
    });
}

// ─── Terminal (xterm.js) ───────────────────────────────────────────────────

function initTerminal() {
    terminal = new Terminal({
        theme: {
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
        },
        fontFamily: '"Cascadia Code", "Consolas", "Courier New", monospace',
        fontSize: 14,
        lineHeight: 1.3,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10000,
        allowProposedApi: true,
    });

    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    try {
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
        terminal.loadAddon(webLinksAddon);
    } catch (e) { /* optional */ }

    const container = document.getElementById("terminal-container");
    terminal.open(container);
    fitAddon.fit();

    // Send keystrokes to server
    terminal.onData((data) => {
        if (isTerminalRunning && socket) {
            socket.emit("terminal_input", { data });
        }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
        if (fitAddon) {
            fitAddon.fit();
            if (isTerminalRunning && socket) {
                socket.emit("resize_terminal", {
                    rows: terminal.rows,
                    cols: terminal.cols,
                });
            }
        }
    });
    resizeObserver.observe(container);

    // Welcome message
    terminal.writeln("\x1b[1;36m  ⚡ Claude Code IDE\x1b[0m");
    terminal.writeln("\x1b[90m  Click \"Start Claude Code\" to begin a session.\x1b[0m");
    terminal.writeln("");
}

// ─── Terminal Controls ─────────────────────────────────────────────────────

function startTerminal() {
    if (isTerminalRunning) return;

    terminal.clear();
    terminal.writeln("\x1b[90m  Starting Claude Code...\x1b[0m\r\n");

    const project = document.getElementById("project-select").value || null;
    socket.emit("start_terminal", { project });
}

function stopTerminal() {
    if (!isTerminalRunning) return;
    openModal("save-modal");
}

function confirmStopAndSave() {
    const summary = document.getElementById("save-summary").value.trim();
    const tagsRaw = document.getElementById("save-tags").value.trim();
    const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : [];
    const project = document.getElementById("project-select").value || null;

    socket.emit("stop_terminal", { project, summary, tags });
    closeModal("save-modal");

    // Clear inputs
    document.getElementById("save-summary").value = "";
    document.getElementById("save-tags").value = "";
}

function setTerminalRunning() {
    isTerminalRunning = true;
    document.getElementById("btn-start").style.display = "none";
    document.getElementById("btn-stop").style.display = "";
    const status = document.getElementById("terminal-status");
    status.classList.add("running");
    status.classList.remove("stopped");
}

function setTerminalStopped() {
    isTerminalRunning = false;
    document.getElementById("btn-start").style.display = "";
    document.getElementById("btn-stop").style.display = "none";
    const status = document.getElementById("terminal-status");
    status.classList.remove("running");
    status.classList.add("stopped");
}

// ─── UI Initialization ────────────────────────────────────────────────────

function initUI() {
    // Toolbar buttons
    document.getElementById("btn-start").addEventListener("click", startTerminal);
    document.getElementById("btn-stop").addEventListener("click", stopTerminal);
    document.getElementById("btn-confirm-save").addEventListener("click", confirmStopAndSave);

    // Tab switching
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
            tab.classList.add("active");
            const panelId = tab.dataset.tab + "-panel";
            document.getElementById(panelId).classList.add("active");

            if (tab.dataset.tab === "terminal" && fitAddon) {
                setTimeout(() => fitAddon.fit(), 50);
            }
        });
    });

    // New project
    document.getElementById("btn-new-project").addEventListener("click", () => openModal("project-modal"));
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
            if (fitAddon) fitAddon.fit();
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
        renderProjectList(projects);
        updateProjectSelect(projects);
    } catch (e) {
        console.error("Failed to load projects:", e);
    }
}

function renderProjectList(projects) {
    const list = document.getElementById("project-list");
    if (projects.length === 0) {
        list.innerHTML = `
            <div style="padding: 16px; color: var(--text-muted); font-size: 12px; text-align: center;">
                No projects yet.<br>Click + to create one.
            </div>`;
        return;
    }

    list.innerHTML = projects.map(p => `
        <div class="sidebar-item ${activeProject === p.name ? 'active' : ''}"
             data-project="${escapeAttr(p.name)}">
            <span class="item-icon">📁</span>
            <span class="item-label">${escapeHtml(p.display_name || p.name)}</span>
            <span class="item-count">${p.session_count}</span>
        </div>
    `).join("");

    list.querySelectorAll(".sidebar-item[data-project]").forEach(el => {
        el.addEventListener("click", () => selectProject(el.dataset.project));
    });
}

function updateProjectSelect(projects) {
    const select = document.getElementById("project-select");
    const current = select.value;
    select.innerHTML = '<option value="">No project</option>' +
        projects.map(p =>
            `<option value="${escapeAttr(p.name)}" ${p.name === current ? 'selected' : ''}>${escapeHtml(p.display_name || p.name)}</option>`
        ).join("");
}

async function selectProject(name) {
    activeProject = name;
    document.getElementById("project-select").value = name;
    document.getElementById("active-project-label").textContent = name;

    // Highlight in sidebar
    document.querySelectorAll("#project-list .sidebar-item").forEach(el => {
        el.classList.toggle("active", el.dataset.project === name);
    });

    // Show sessions header and load sessions
    document.getElementById("sessions-header").style.display = "flex";
    await loadSessions(name);
}

async function createProject() {
    const name = document.getElementById("new-project-name").value.trim();
    const desc = document.getElementById("new-project-desc").value.trim();

    if (!name) return;

    try {
        await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, display_name: name, description: desc }),
        });
        closeModal("project-modal");
        document.getElementById("new-project-name").value = "";
        document.getElementById("new-project-desc").value = "";
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

        return `
            <div class="sidebar-item session-item ${activeSessionId === s.id ? 'active' : ''}"
                 data-session-project="${escapeAttr(project)}" data-session-id="${escapeAttr(s.id)}">
                <span class="item-icon">💬</span>
                <span class="item-label" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
                <span class="session-date">${timeStr}</span>
            </div>`;
    }).join("");

    list.querySelectorAll(".session-item[data-session-id]").forEach(el => {
        el.addEventListener("click", () => viewSession(el.dataset.sessionProject, el.dataset.sessionId));
    });
}

async function viewSession(project, sessionId) {
    activeSessionId = sessionId;

    // Switch to viewer tab
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.querySelector('[data-tab="viewer"]').classList.add("active");
    document.getElementById("viewer-panel").classList.add("active");

    // Highlight in sidebar
    document.querySelectorAll("#session-list .sidebar-item").forEach(el => {
        el.classList.toggle("active", el.textContent.includes(sessionId));
    });

    try {
        const resp = await fetch(`/api/projects/${project}/sessions/${sessionId}`);
        const session = await resp.json();

        document.getElementById("viewer-title").textContent =
            session.summary || `Session from ${new Date(session.created).toLocaleString()}`;

        const content = document.getElementById("session-content");
        if (session.raw_transcript) {
            content.textContent = session.raw_transcript;
        } else {
            content.innerHTML = `
                <div class="empty-state">
                    <p>This session has no recorded content.</p>
                </div>`;
        }
    } catch (e) {
        console.error("Failed to load session:", e);
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
