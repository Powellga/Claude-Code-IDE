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
let viewedSessionProject = null;
let claudeMdDirty = false;

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
        loadProjects();
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

async function stopTerminal() {
    if (!isTerminalRunning) return;

    // Populate save modal's project selector from the current project list
    try {
        const resp = await fetch("/api/projects");
        const projects = await resp.json();
        const sel = document.getElementById("save-project-select");
        const currentProject = document.getElementById("project-select").value || "";
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
    document.getElementById("btn-resume").addEventListener("click", resumeSession);
    document.getElementById("btn-confirm-save").addEventListener("click", confirmStopAndSave);

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

            if (tab.dataset.tab === "terminal" && fitAddon) {
                setTimeout(() => fitAddon.fit(), 50);
            }
            if (tab.dataset.tab !== "viewer") {
                document.getElementById("btn-resume").style.display = "none";
                document.getElementById("btn-export-md").style.display = "none";
                document.getElementById("btn-export-txt").style.display = "none";
            }
            if (tab.dataset.tab === "diff") {
                populateDiffSelectors();
            }
            if (tab.dataset.tab === "claudemd") {
                loadClaudeMd();
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
        el.addEventListener("contextmenu", (e) => onProjectContextMenu(e, el.dataset.project));
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
        el.classList.toggle("active", el.textContent.includes(sessionId));
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

        const content = document.getElementById("session-content");
        const btnResume = document.getElementById("btn-resume");
        const btnExportMd = document.getElementById("btn-export-md");
        const btnExportTxt = document.getElementById("btn-export-txt");
        const cleaned = transcriptData.transcript || "";
        if (cleaned) {
            content.textContent = cleaned;
            btnResume.style.display = "";
            btnExportMd.style.display = "";
            btnExportTxt.style.display = "";
        } else {
            btnResume.style.display = "none";
            btnExportMd.style.display = "none";
            btnExportTxt.style.display = "none";
            content.innerHTML = `
                <div class="empty-state">
                    <p>This session has no recorded content.</p>
                </div>`;
        }
    } catch (e) {
        console.error("Failed to load session:", e);
    }
}

// ─── Resume Session ─────────────────────────────────────────────────────────

async function resumeSession() {
    if (isTerminalRunning) {
        if (!confirm("A terminal is already running. Stop it and resume this session?")) {
            return;
        }
        socket.emit("stop_terminal", {
            project: document.getElementById("project-select").value || null,
            summary: "",
            tags: [],
        });
        await new Promise(resolve => setTimeout(resolve, 500));
    }

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

        // Switch to terminal tab
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
        document.querySelector('[data-tab="terminal"]').classList.add("active");
        document.getElementById("terminal-panel").classList.add("active");

        terminal.clear();
        terminal.writeln("\x1b[90m  Resuming previous session...\x1b[0m\r\n");

        document.getElementById("project-select").value = project;

        socket.emit("resume_session", {
            project: project,
            claude_session_id: session.claude_session_id,
        });
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
            `/api/sessions/compare?project=${encodeURIComponent(activeProject)}&session_a=${encodeURIComponent(idA)}&session_b=${encodeURIComponent(idB)}`
        );
        const data = await resp.json();

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
    showContextMenu(e, [
        { label: "Rename Project", action: "rename", handler: () => renameProject(projectName) },
        "---",
        { label: "Delete Project", action: "delete", danger: true, handler: () => deleteProject(projectName) },
    ]);
}

function onSessionContextMenu(e, project, sessionId) {
    showContextMenu(e, [
        { label: "Rename Session", action: "rename", handler: () => renameSession(project, sessionId) },
        "---",
        { label: "Delete Session", action: "delete", danger: true, handler: () => deleteSession(project, sessionId) },
    ]);
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
        await fetch(`/api/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ summary: newSummary.trim() }),
        });
        await loadSessions(project);
    } catch (e) {
        console.error("Rename failed:", e);
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
