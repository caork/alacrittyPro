import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type ServerProfile = {
  id: string;
  name: string;
  host: string;
  user?: string;
  port?: number;
  password?: string;
  tags: string[];
  favorite: boolean;
  last_used_at?: string;
};

type View = "terminals" | "automations" | "skills" | "settings";

type SessionInfo = {
  sessionId: string;
  profileId: string; // profileId or 'local'
  term: Terminal;
  fitAddon: FitAddon;
  unlistenOutput: UnlistenFn;
  unlistenExit: UnlistenFn;
  exited: boolean;
};

type UiState = {
  profiles: ServerProfile[];
  selectedId?: string;
  query: string;
  showAdd: boolean;
  sidebarCollapsed: boolean;
  view: View;
};

const state: UiState = {
  profiles: [],
  selectedId: undefined,
  query: "",
  showAdd: false,
  sidebarCollapsed: false,
  view: "terminals",
};

// Terminal sessions keyed by profileId (or 'local')
const sessions = new Map<string, SessionInfo>();

const app = document.querySelector<HTMLDivElement>("#app")!;
const appWindow = getCurrentWindow();

const resizeObserver = new ResizeObserver(() => {
  const key = state.selectedId || "local";
  const session = sessions.get(key);
  if (session && !session.exited) {
    session.fitAddon.fit();
  }
});

// ── Global Backspace fix for WKWebView ──
// WKWebView intercepts Backspace at the native input layer, modifying xterm.js's
// hidden textarea before JS event handlers run. We use capture-phase listeners
// with stopImmediatePropagation to fully intercept the key before xterm.js or
// the WebView can act on it, then manually write DEL to the PTY.
let _bkspDown = false;

document.addEventListener("keydown", (e) => {
  if (e.key !== "Backspace") return;
  const el = e.target as HTMLElement | null;
  if (!el?.closest(".xterm")) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _bkspDown = true;
  const key = state.selectedId || "local";
  const session = sessions.get(key);
  if (session && !session.exited) {
    let data = "\x7f";
    if (e.altKey) data = "\x1b\x7f";
    if (e.ctrlKey) data = "\x08";
    invoke("write_pty", { sessionId: session.sessionId, data });
  }
}, true);

document.addEventListener("keyup", (e) => {
  if (e.key !== "Backspace") return;
  const el = e.target as HTMLElement | null;
  if (!el?.closest(".xterm")) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _bkspDown = false;
}, true);

document.addEventListener("beforeinput", (e) => {
  if (!_bkspDown) return;
  const el = e.target as HTMLElement | null;
  if (!el?.closest(".xterm")) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

document.addEventListener("input", (e) => {
  if (!_bkspDown) return;
  const el = e.target as HTMLElement | null;
  if (!el?.closest(".xterm")) return;
  e.stopImmediatePropagation();
}, true);

function createProfileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `profile-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function groupedProfiles(profiles: ServerProfile[]): Array<[string, ServerProfile[]]> {
  const groups = new Map<string, ServerProfile[]>();
  for (const profile of profiles) {
    const key = profile.host;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(profile);
    } else {
      groups.set(key, [profile]);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function activeServer(filtered: ServerProfile[]): ServerProfile | undefined {
  const selected = state.profiles.find((profile) => profile.id === state.selectedId);
  if (selected && filtered.some((profile) => profile.id === selected.id)) {
    return selected;
  }
  return filtered[0];
}

async function openTerminalSession(profileId?: string) {
  const key = profileId || "local";

  // Close existing session for this profile if any
  const existing = sessions.get(key);
  if (existing) {
    await closeTerminalSession(key);
  }

  const sessionId = createProfileId();

  // Spawn the PTY on the backend
  await invoke("spawn_pty", {
    sessionId,
    profileId: profileId ?? null,
  });

  // Create xterm.js instance
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
    theme: {
      background: "#0b1018",
      foreground: "#e8f0fa",
      cursor: "#9ad4ff",
      cursorAccent: "#0b1018",
      selectionBackground: "rgba(154, 212, 255, 0.25)",
      selectionForeground: "#ffffff",
      black: "#1a2233",
      red: "#ff6b6b",
      green: "#69db7c",
      yellow: "#ffd43b",
      blue: "#74c0fc",
      magenta: "#da77f2",
      cyan: "#66d9e8",
      white: "#e8f0fa",
      brightBlack: "#495670",
      brightRed: "#ff8787",
      brightGreen: "#8ce99a",
      brightYellow: "#ffe066",
      brightBlue: "#a5d8ff",
      brightMagenta: "#e599f7",
      brightCyan: "#99e9f2",
      brightWhite: "#ffffff",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  // Listen for PTY output (base64 encoded)
  const unlistenOutput = await listen<string>(`pty-output-${sessionId}`, (event) => {
    const bytes = base64ToBytes(event.payload);
    term.write(bytes);
  });

  const unlistenExit = await listen(`pty-exit-${sessionId}`, () => {
    const s = sessions.get(key);
    if (s && s.sessionId === sessionId) {
      s.exited = true;
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
    }
  });

  // Forward keyboard input to PTY
  term.onData((data) => {
    invoke("write_pty", { sessionId, data });
  });

  // Forward resize events to PTY
  term.onResize(({ rows, cols }) => {
    invoke("resize_pty", { sessionId, rows, cols });
  });

  const session: SessionInfo = {
    sessionId,
    profileId: key,
    term,
    fitAddon,
    unlistenOutput,
    unlistenExit,
    exited: false,
  };

  sessions.set(key, session);
  requestAnimationFrame(attachTerminal);
}

async function closeTerminalSession(key: string) {
  const session = sessions.get(key);
  if (!session) return;

  session.unlistenOutput();
  session.unlistenExit();
  session.term.dispose();
  sessions.delete(key);

  try {
    await invoke("close_pty", { sessionId: session.sessionId });
  } catch {
    // Session may already be closed on the backend
  }
}

function attachTerminal() {
  if (state.view !== "terminals") return;

  const key = state.selectedId || "local";
  const session = sessions.get(key);
  if (!session) return;

  const container = document.getElementById("terminal-container");
  if (!container) return;

  // Clear any placeholder content
  container.innerHTML = "";
  container.onclick = () => session.term.focus();

  if (session.term.element) {
    // Re-attach existing terminal element
    container.appendChild(session.term.element);
  } else {
    // First time: open the terminal in this container
    session.term.open(container);
  }

  // Fit after a frame to ensure layout is computed
  requestAnimationFrame(() => {
    session.fitAddon.fit();
    session.term.focus();
    // Observe for future resizes
    resizeObserver.disconnect();
    resizeObserver.observe(container);
    // Refit after transitions settle (sidebar collapse/expand)
    setTimeout(() => session.fitAddon.fit(), 300);
  });
}

function renderMainPanel(): string {
  if (state.view === "automations") {
    return `
      <section class="placeholder-view">
        <h2>Automations</h2>
        <p>Automation workspace placeholder. Next step: task list, schedules, and quick actions.</p>
      </section>
    `;
  }

  if (state.view === "skills") {
    return `
      <section class="placeholder-view">
        <h2>Skills</h2>
        <p>Skills workspace placeholder. Next step: install, enable, and manage skill packs.</p>
      </section>
    `;
  }

  if (state.view === "settings") {
    return `
      <section class="placeholder-view">
        <h2>Settings</h2>
        <p>Settings placeholder. App-level options will be added here.</p>
      </section>
    `;
  }

  // Terminal view - full-area terminal (name + VS Code icon are in window-strip)
  return `<div class="terminal-surface has-terminal" id="terminal-container"></div>`;
}

function render() {
  const filtered = state.profiles;

  const selected = activeServer(filtered);
  if (selected && state.selectedId !== selected.id) {
    state.selectedId = selected.id;
  }

  const groups = groupedProfiles(filtered);

  app.innerHTML = `
    <main class="app-shell ${state.sidebarCollapsed ? "collapsed" : ""}">
      <aside class="sidebar">
        <div class="sidebar-header">
          <button class="collapse-btn" id="collapse-sidebar" title="Collapse Sidebar" aria-label="Collapse Sidebar">\u2261</button>
        </div>

        <div class="top-nav">
          <button class="nav-item ${state.view === "terminals" ? "active" : ""}" id="new-terminal">
            <span class="nav-icon">\u2318</span>
            <span class="nav-label">New Terminal</span>
          </button>
          <button class="nav-item ${state.view === "automations" ? "active" : ""}" data-view="automations">
            <span class="nav-icon">\u27F3</span>
            <span class="nav-label">Automations</span>
          </button>
          <button class="nav-item ${state.view === "skills" ? "active" : ""}" data-view="skills">
            <span class="nav-icon">\u2726</span>
            <span class="nav-label">Skills</span>
          </button>
        </div>

        <div class="terminals-area">
          <div class="terminals-title">
            <h3>Terminals</h3>
            <button class="add-btn" id="add-btn" title="Add server">+</button>
          </div>

          <div class="terminal-list">
            ${groups
              .map(([host, profiles]) => {
                const items = profiles
                  .map((profile) => {
                    const selectedClass = state.selectedId === profile.id ? "selected" : "";
                    const hasSession = sessions.has(profile.id);
                    const subtitle = `${profile.user ? `${profile.user}@` : ""}${profile.host}${profile.port ? `:${profile.port}` : ""}`;
                    return `
                      <button class="terminal-item ${selectedClass}" data-id="${profile.id}">
                        <span class="item-name">${hasSession ? '<span class="session-dot"></span>' : ""}${escapeHtml(profile.name)}</span>
                        <span class="item-target">${escapeHtml(subtitle)}</span>
                      </button>
                    `;
                  })
                  .join("");
                return `
                  <div class="terminal-group">
                    <div class="group-host">${escapeHtml(host)}</div>
                    <div class="group-items">${items}</div>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>

        <button class="nav-item settings ${state.view === "settings" ? "active" : ""}" data-view="settings">
          <span class="nav-icon">\u2699</span>
          <span class="nav-label">Settings</span>
        </button>
        <div class="sidebar-resize-handle" id="sidebar-resize-handle"></div>
      </aside>

      <header class="window-strip">
        <button class="expand-btn" id="expand-sidebar" title="Expand Sidebar" aria-label="Expand Sidebar">\u2261</button>
        <span class="window-strip-title">${escapeHtml(state.view === "terminals" ? (state.profiles.find((p) => p.id === state.selectedId)?.host ?? "Terminal") : state.view.charAt(0).toUpperCase() + state.view.slice(1))}</span>
        <div class="drag-region"></div>
        ${state.view === "terminals" ? `<button class="window-strip-action" id="open-vscode" title="Open in VS Code">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>` : ""}
      </header>

      <section class="main-view">
        ${renderMainPanel()}
      </section>

      ${
        state.showAdd
          ? `
        <section class="overlay" id="overlay">
          <div class="modal" role="dialog" aria-modal="true">
            <h3>Add Server</h3>
            <p>Create a server profile for quick login.</p>
            <div class="modal-grid">
              <label>
                <span>Name</span>
                <input id="add-name" placeholder="Prod API" />
              </label>
              <label>
                <span>Host/IP</span>
                <input id="add-host" placeholder="10.0.0.5" />
              </label>
              <label>
                <span>User</span>
                <input id="add-user" placeholder="alice" />
              </label>
              <label>
                <span>Port</span>
                <input id="add-port" type="number" value="22" />
              </label>
              <label class="full-width">
                <span>Password (MVP plaintext)</span>
                <input id="add-password" type="password" />
              </label>
            </div>
            <div class="modal-actions">
              <button class="button-ghost" id="cancel-add">Cancel</button>
              <button class="button-solid" id="confirm-add">Add Server</button>
            </div>
          </div>
        </section>
      `
          : ""
      }
    </main>
  `;

  bindEvents();

  // Attach terminal to DOM after render
  requestAnimationFrame(attachTerminal);
}

function bindEvents() {
  // Window drag via JS API (works reliably with titleBarStyle: Overlay)
  const dragRegions = app.querySelectorAll<HTMLElement>(".window-strip, .sidebar-header");
  dragRegions.forEach((region) => {
    region.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      appWindow.startDragging();
    });
  });

  // Sidebar collapse (button inside sidebar)
  app.querySelector<HTMLButtonElement>("#collapse-sidebar")?.addEventListener("click", () => {
    state.sidebarCollapsed = true;
    const shell = app.querySelector<HTMLElement>(".app-shell");
    shell?.classList.add("collapsed");
    // Refit terminal after transition
    setTimeout(() => {
      const key = state.selectedId || "local";
      const session = sessions.get(key);
      if (session && !session.exited) session.fitAddon.fit();
    }, 300);
  });

  // Sidebar expand (button in window-strip when collapsed)
  app.querySelector<HTMLButtonElement>("#expand-sidebar")?.addEventListener("click", () => {
    state.sidebarCollapsed = false;
    const shell = app.querySelector<HTMLElement>(".app-shell");
    shell?.classList.remove("collapsed");
    // Refit terminal after transition
    setTimeout(() => {
      const key = state.selectedId || "local";
      const session = sessions.get(key);
      if (session && !session.exited) session.fitAddon.fit();
    }, 300);
  });

  // Sidebar resize by dragging the right edge
  const resizeHandle = app.querySelector<HTMLElement>("#sidebar-resize-handle");
  if (resizeHandle) {
    resizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      resizeHandle.classList.add("dragging");
      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.max(200, Math.min(ev.clientX, 500));
        document.documentElement.style.setProperty("--sidebar-width", `${newWidth}px`);
        // Refit terminal during drag
        const key = state.selectedId || "local";
        const session = sessions.get(key);
        if (session && !session.exited) {
          session.fitAddon.fit();
        }
      };
      const onMouseUp = () => {
        resizeHandle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        // Final refit
        const key = state.selectedId || "local";
        const session = sessions.get(key);
        if (session && !session.exited) {
          session.fitAddon.fit();
        }
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  // Terminal item selection - auto-opens terminal for the server
  app.querySelectorAll<HTMLButtonElement>(".terminal-item").forEach((button) => {
    button.onclick = async () => {
      state.selectedId = button.dataset.id;
      state.view = "terminals";
      render();
      if (state.selectedId && !sessions.has(state.selectedId)) {
        await openTerminalSession(state.selectedId);
      }
    };
  });

  app.querySelector<HTMLButtonElement>("#new-terminal")?.addEventListener("click", async () => {
    if (state.view !== "terminals") {
      state.view = "terminals";
      // Update active states
      app.querySelectorAll<HTMLElement>("[data-view]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.view === "terminals");
      });
      app.querySelector<HTMLElement>("#new-terminal")?.classList.add("active");
      const mainView = app.querySelector<HTMLElement>(".main-view");
      if (mainView) {
        mainView.innerHTML = renderMainPanel();
        const titleEl = app.querySelector<HTMLElement>(".window-strip-title");
        if (titleEl) titleEl.textContent = state.profiles.find((p) => p.id === state.selectedId)?.host ?? "Terminal";
        const vscodeBtn = app.querySelector<HTMLElement>("#open-vscode");
        if (vscodeBtn) vscodeBtn.style.display = "";
      }
    }
    const selected = state.profiles.find((profile) => profile.id === state.selectedId);
    await openTerminalSession(selected?.id);
  });

  // Open VS Code for current terminal context
  app.querySelector<HTMLButtonElement>("#open-vscode")?.addEventListener("click", async () => {
    const selected = state.profiles.find((p) => p.id === state.selectedId);
    await invoke("open_vscode", { profileId: selected?.id ?? null });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.onclick = () => {
      const view = button.dataset.view as View | undefined;
      if (!view || state.view === view) return;
      state.view = view;
      // Update active states in sidebar without full re-render
      app.querySelectorAll<HTMLElement>("[data-view]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.view === view);
      });
      app.querySelector<HTMLElement>("#new-terminal")?.classList.toggle("active", view === "terminals");
      // Swap main panel content
      const mainView = app.querySelector<HTMLElement>(".main-view");
      if (mainView) {
        mainView.innerHTML = renderMainPanel();
        // Update window-strip title
        const titleEl = app.querySelector<HTMLElement>(".window-strip-title");
        if (titleEl) {
          titleEl.textContent = view === "terminals"
            ? (state.profiles.find((p) => p.id === state.selectedId)?.host ?? "Terminal")
            : view.charAt(0).toUpperCase() + view.slice(1);
        }
        // Show/hide VS Code button
        const vscodeBtn = app.querySelector<HTMLElement>("#open-vscode");
        if (vscodeBtn) vscodeBtn.style.display = view === "terminals" ? "" : "none";
        requestAnimationFrame(attachTerminal);
      }
    };
  });

  const addButton = app.querySelector<HTMLButtonElement>("#add-btn");
  if (addButton) {
    addButton.onclick = () => {
      state.showAdd = true;
      render();
    };
  }

  const cancelAdd = app.querySelector<HTMLButtonElement>("#cancel-add");
  if (cancelAdd) {
    cancelAdd.onclick = () => {
      state.showAdd = false;
      render();
    };
  }

  const confirmAdd = app.querySelector<HTMLButtonElement>("#confirm-add");
  if (confirmAdd) {
    confirmAdd.onclick = async () => {
      const name = app.querySelector<HTMLInputElement>("#add-name")?.value.trim() ?? "";
      const host = app.querySelector<HTMLInputElement>("#add-host")?.value.trim() ?? "";
      const user = app.querySelector<HTMLInputElement>("#add-user")?.value.trim() || undefined;
      const portRaw = app.querySelector<HTMLInputElement>("#add-port")?.value ?? "22";
      const password = app.querySelector<HTMLInputElement>("#add-password")?.value || undefined;

      if (!name || !host) {
        return;
      }

      const portNumber = Number(portRaw);
      const port = Number.isFinite(portNumber) && portNumber > 0 ? portNumber : 22;

      const profile: ServerProfile = {
        id: createProfileId(),
        name,
        host,
        user,
        port,
        password,
        tags: [],
        favorite: false,
      };

      await invoke("upsert_profile", { profile });
      await refreshProfiles();
      state.selectedId = profile.id;
      state.view = "terminals";
      state.showAdd = false;
      render();
    };
  }
}

async function refreshProfiles() {
  state.profiles = await invoke<ServerProfile[]>("list_profiles");
  if (!state.selectedId && state.profiles.length > 0) {
    state.selectedId = state.profiles[0].id;
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

refreshProfiles().then(() => {
  render();
  // Auto-open local terminal on startup
  openTerminalSession();
});
