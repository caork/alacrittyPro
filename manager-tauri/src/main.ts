import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { setLiquidGlassEffect, isGlassSupported, GlassMaterialVariant } from "tauri-plugin-liquid-glass-api";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
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
  sidebarCollapsed: boolean;
  rightSidebarCollapsed: boolean;
  view: View;
};

const state: UiState = {
  profiles: [],
  selectedId: undefined,
  query: "",
  sidebarCollapsed: true,
  rightSidebarCollapsed: true,
  view: "terminals",
};

// Terminal sessions keyed by profileId (or 'local')
const sessions = new Map<string, SessionInfo>();

// ── File browser state ──
type DirEntry = { name: string; isDir: boolean };
// Tracks which directories have been expanded (path -> children)
const expandedDirs = new Map<string, DirEntry[]>();
let fileBrowserRoot = "";

// ── Native drag state (for startDrag plugin) ──
let nativeDragSourcePath: string | null = null;

// ── Add-panel state ──
let addPanelClickLocked = false;
let addPanelHideTimeout: ReturnType<typeof setTimeout> | null = null;

// ── Context menu state ──
let contextMenuTarget: { path: string; isDir: boolean; name: string } | null = null;

// ── Toast system ──
function ensureToastContainer(): HTMLElement {
  let container = document.querySelector<HTMLElement>(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message: string, type: "info" | "error" = "info", duration = 3000) {
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " error" : ""}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove());
  }, duration);
}

// ── Context menu helpers ──
function showContextMenu(x: number, y: number, target: { path: string; isDir: boolean; name: string }) {
  hideContextMenu();
  contextMenuTarget = target;

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.id = "context-menu";

  let items = "";

  if (target.isDir) {
    items += `<button class="context-menu-item" data-action="new-file">New File</button>`;
    items += `<button class="context-menu-item" data-action="new-folder">New Folder</button>`;
    items += `<div class="context-menu-separator"></div>`;
  }

  items += `<button class="context-menu-item" data-action="rename">Rename</button>`;
  items += `<button class="context-menu-item danger" data-action="delete">Delete</button>`;
  items += `<div class="context-menu-separator"></div>`;
  items += `<button class="context-menu-item" data-action="open-vscode">Open in VS Code</button>`;
  items += `<button class="context-menu-item" data-action="open-default">Open with Default App</button>`;

  menu.innerHTML = items;

  document.body.appendChild(menu);

  // Position: ensure it stays within viewport
  const menuRect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 4;
  const maxY = window.innerHeight - menuRect.height - 4;
  menu.style.left = `${Math.min(x, maxX)}px`;
  menu.style.top = `${Math.min(y, maxY)}px`;

  requestAnimationFrame(() => menu.classList.add("visible"));

  menu.querySelectorAll<HTMLButtonElement>(".context-menu-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleContextMenuAction(btn.dataset.action!, target);
    });
  });
}

function showRootContextMenu(x: number, y: number) {
  hideContextMenu();
  contextMenuTarget = { path: fileBrowserRoot, isDir: true, name: "" };

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.id = "context-menu";

  menu.innerHTML = `
    <button class="context-menu-item" data-action="new-file">New File</button>
    <button class="context-menu-item" data-action="new-folder">New Folder</button>
  `;

  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 4;
  const maxY = window.innerHeight - menuRect.height - 4;
  menu.style.left = `${Math.min(x, maxX)}px`;
  menu.style.top = `${Math.min(y, maxY)}px`;

  requestAnimationFrame(() => menu.classList.add("visible"));

  menu.querySelectorAll<HTMLButtonElement>(".context-menu-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action!;
      if (action === "new-file") promptNewEntry(fileBrowserRoot, false);
      else if (action === "new-folder") promptNewEntry(fileBrowserRoot, true);
      hideContextMenu();
    });
  });
}

function hideContextMenu() {
  const menu = document.getElementById("context-menu");
  if (menu) {
    menu.classList.remove("visible");
    setTimeout(() => menu.remove(), 120);
  }
  contextMenuTarget = null;
}

async function handleContextMenuAction(action: string, target: { path: string; isDir: boolean; name: string }) {
  hideContextMenu();
  switch (action) {
    case "rename":
      startInlineRename(target.path, target.isDir);
      break;
    case "delete":
      confirmAndDelete(target.path, target.name, target.isDir);
      break;
    case "new-file":
      promptNewEntry(target.path, false);
      break;
    case "new-folder":
      promptNewEntry(target.path, true);
      break;
    case "open-vscode":
      try {
        await invoke("open_in_vscode", { path: target.path });
      } catch (e: any) {
        showToast(e.toString(), "error");
      }
      break;
    case "open-default":
      try {
        await invoke("open_file_default", { path: target.path });
      } catch (e: any) {
        showToast(e.toString(), "error");
      }
      break;
  }
}

// ── Delete with confirmation ──
function confirmAndDelete(path: string, name: string, isDir: boolean) {
  const menu = document.createElement("div");
  menu.className = "context-menu visible";
  menu.id = "context-menu";

  // Position near center of viewport as a confirmation dialog
  const existing = document.getElementById("context-menu");
  let posX = window.innerWidth / 2 - 90;
  let posY = window.innerHeight / 2 - 40;
  if (existing) {
    posX = parseInt(existing.style.left) || posX;
    posY = parseInt(existing.style.top) || posY;
    existing.remove();
  }

  menu.innerHTML = `
    <div class="context-menu-confirm">
      <span>Delete ${escapeHtml(name)}?</span>
      <div class="confirm-actions">
        <button class="cancel-btn">Cancel</button>
        <button class="delete-btn">Delete</button>
      </div>
    </div>
  `;

  menu.style.left = `${posX}px`;
  menu.style.top = `${posY}px`;

  document.body.appendChild(menu);

  menu.querySelector<HTMLButtonElement>(".cancel-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    hideContextMenu();
  });

  menu.querySelector<HTMLButtonElement>(".delete-btn")!.addEventListener("click", async (e) => {
    e.stopPropagation();
    hideContextMenu();
    try {
      await invoke("delete_entry", { path });
      showToast(`Deleted ${name}`);
      await reloadSubtree(parentDir(path));
    } catch (err: any) {
      showToast(err.toString(), "error");
    }
  });
}

// ── New File / New Folder via inline input ──
async function promptNewEntry(parentPath: string, isDir: boolean) {
  // Ensure parent is expanded
  if (!expandedDirs.has(parentPath)) {
    const children = await loadDirectory(parentPath);
    expandedDirs.set(parentPath, children);
    renderFileTreeDOM();
  }

  // Find the children container for parentPath
  const container = document.getElementById("file-tree");
  if (!container) return;

  // Find the tree-children div that belongs to parentPath
  let childrenContainer: HTMLElement | null = null;
  if (parentPath === fileBrowserRoot) {
    childrenContainer = container;
  } else {
    const parentBtn = container.querySelector<HTMLElement>(`[data-path="${CSS.escape(parentPath)}"]`);
    if (parentBtn) {
      childrenContainer = parentBtn.nextElementSibling as HTMLElement;
      if (!childrenContainer || !childrenContainer.classList.contains("file-tree-children")) {
        // Need to re-render to get the children container
        renderFileTreeDOM();
        const btn2 = container.querySelector<HTMLElement>(`[data-path="${CSS.escape(parentPath)}"]`);
        childrenContainer = btn2?.nextElementSibling as HTMLElement;
      }
    }
  }

  if (!childrenContainer) return;

  // Create inline input row
  const row = document.createElement("div");
  row.className = "file-tree-item";
  row.innerHTML = `
    <span class="expand-arrow" style="visibility:hidden">&#9654;</span>
    <span class="file-icon">${isDir ? "&#128193;" : "&#128196;"}</span>
    <input class="rename-input" type="text" placeholder="${isDir ? "folder name" : "file name"}" />
  `;

  childrenContainer.insertBefore(row, childrenContainer.firstChild);

  const input = row.querySelector<HTMLInputElement>(".rename-input")!;
  input.focus();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName) {
      row.remove();
      return;
    }
    const newPath = `${parentPath}/${newName}`;
    try {
      if (isDir) {
        await invoke("create_dir", { path: newPath });
      } else {
        await invoke("create_file", { path: newPath });
      }
      showToast(`Created ${newName}`);
      await reloadSubtree(parentPath);
    } catch (err: any) {
      showToast(err.toString(), "error");
      row.remove();
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      committed = true;
      row.remove();
    }
  });
  input.addEventListener("blur", commit);
}

// ── Inline Rename ──
function startInlineRename(path: string, isDir: boolean) {
  const container = document.getElementById("file-tree");
  if (!container) return;

  const btn = container.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
  if (!btn) return;

  const nameSpan = btn.querySelector<HTMLElement>(".file-name");
  if (!nameSpan) return;

  const oldName = nameSpan.textContent || "";
  const input = document.createElement("input");
  input.className = "rename-input";
  input.type = "text";
  input.value = oldName;

  nameSpan.replaceWith(input);
  input.focus();

  // Select name without extension for files
  if (!isDir && oldName.includes(".")) {
    const dotIndex = oldName.lastIndexOf(".");
    input.setSelectionRange(0, dotIndex);
  } else {
    input.select();
  }

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      // Revert
      const span = document.createElement("span");
      span.className = "file-name";
      span.textContent = oldName;
      input.replaceWith(span);
      return;
    }

    const parent = parentDir(path);
    const newPath = `${parent}/${newName}`;

    try {
      await invoke("rename_entry", { oldPath: path, newPath });
      showToast(`Renamed to ${newName}`);

      // Remap expandedDirs if it was a directory
      if (isDir) {
        const keysToRemap: string[] = [];
        for (const key of expandedDirs.keys()) {
          if (key === path || key.startsWith(path + "/")) {
            keysToRemap.push(key);
          }
        }
        for (const oldKey of keysToRemap) {
          const entries = expandedDirs.get(oldKey)!;
          expandedDirs.delete(oldKey);
          const newKey = newPath + oldKey.slice(path.length);
          expandedDirs.set(newKey, entries);
        }
      }

      await reloadSubtree(parent);
    } catch (err: any) {
      showToast(err.toString(), "error");
      const span = document.createElement("span");
      span.className = "file-name";
      span.textContent = oldName;
      input.replaceWith(span);
    }
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      committed = true;
      const span = document.createElement("span");
      span.className = "file-name";
      span.textContent = oldName;
      input.replaceWith(span);
    }
  });
  input.addEventListener("blur", commit);
}

// ── Subtree reload helper ──
async function reloadSubtree(dirPath: string) {
  const entries = await loadDirectory(dirPath);
  expandedDirs.set(dirPath, entries);

  // Also reload any expanded child directories
  for (const key of [...expandedDirs.keys()]) {
    if (key !== dirPath && key.startsWith(dirPath + "/")) {
      try {
        const childEntries = await loadDirectory(key);
        expandedDirs.set(key, childEntries);
      } catch {
        expandedDirs.delete(key);
      }
    }
  }

  renderFileTreeDOM();
}

function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx > 0 ? filePath.slice(0, idx) : "/";
}

// ── Native drag-drop helpers ──
function clearDropHighlights() {
  document.querySelectorAll<HTMLElement>(".file-tree-item.drag-over").forEach((el) => {
    el.classList.remove("drag-over");
  });
}

function getDropTargetDir(physX: number, physY: number): { path: string; name: string } | null {
  // onDragDropEvent positions are physical pixels; elementFromPoint uses logical (CSS) pixels
  const x = physX / window.devicePixelRatio;
  const y = physY / window.devicePixelRatio;
  const el = document.elementFromPoint(x, y);
  const btn = el?.closest<HTMLElement>(".file-tree-item");
  if (!btn || btn.dataset.isDir !== "true") return null;
  return { path: btn.dataset.path!, name: btn.querySelector<HTMLElement>(".file-name")?.textContent || "" };
}

async function handleNativeDrop(srcPath: string, destPath: string, destName: string) {
  try {
    await invoke("move_entry", { src: srcPath, destDir: destPath });
    const srcName = srcPath.split("/").pop() || "";
    showToast(`Moved ${srcName} to ${destName}`);

    for (const key of [...expandedDirs.keys()]) {
      if (key === srcPath || key.startsWith(srcPath + "/")) {
        expandedDirs.delete(key);
      }
    }

    await reloadSubtree(parentDir(srcPath));
    await reloadSubtree(destPath);
  } catch (err: any) {
    showToast(err.toString(), "error");
  }
}

function setupNativeDragDrop() {
  appWindow.onDragDropEvent((event: any) => {
    if (!nativeDragSourcePath) return; // Ignore external drops

    const payload = event.payload ?? event;
    if (payload.type === "over") {
      clearDropHighlights();
      const target = getDropTargetDir(payload.position.x, payload.position.y);
      if (target && target.path !== nativeDragSourcePath && !target.path.startsWith(nativeDragSourcePath + "/")) {
        const btn = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(target.path)}"]`);
        btn?.classList.add("drag-over");
      }
    } else if (payload.type === "drop") {
      clearDropHighlights();
      const target = getDropTargetDir(payload.position.x, payload.position.y);
      if (target && target.path !== nativeDragSourcePath && !target.path.startsWith(nativeDragSourcePath + "/")) {
        handleNativeDrop(nativeDragSourcePath, target.path, target.name);
      }
      nativeDragSourcePath = null;
    } else if (payload.type === "leave") {
      clearDropHighlights();
    }
  });
}

function showAddPanel() {
  const panel = document.getElementById("add-panel");
  const btn = document.getElementById("add-btn");
  if (!panel || !btn) return;
  if (addPanelHideTimeout) {
    clearTimeout(addPanelHideTimeout);
    addPanelHideTimeout = null;
  }
  const rect = btn.getBoundingClientRect();
  panel.style.top = `${rect.top - 4}px`;
  panel.style.left = `${rect.right + 10}px`;
  panel.classList.add("visible");
}

function hideAddPanel() {
  const panel = document.getElementById("add-panel");
  if (!panel) return;
  panel.classList.remove("visible");
  addPanelClickLocked = false;
  if (addPanelHideTimeout) {
    clearTimeout(addPanelHideTimeout);
    addPanelHideTimeout = null;
  }
  panel.querySelectorAll("input").forEach((el) => {
    const input = el as HTMLInputElement;
    if (input.type === "number") input.value = "22";
    else input.value = "";
  });
}

function tryHideAddPanel() {
  if (addPanelClickLocked || hasAddPanelInput()) return;
  hideAddPanel();
}

function scheduleHideAddPanel() {
  if (addPanelClickLocked || hasAddPanelInput()) return;
  addPanelHideTimeout = setTimeout(tryHideAddPanel, 200);
}

function hasAddPanelInput(): boolean {
  const panel = document.getElementById("add-panel");
  if (!panel) return false;
  return Array.from(panel.querySelectorAll("input")).some((el) => {
    const input = el as HTMLInputElement;
    if (input.type === "number") return input.value !== "22";
    if (input.type === "password") return input.value !== "";
    return input.value.trim() !== "";
  });
}

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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideContextMenu();
    const panel = document.getElementById("add-panel");
    if (panel?.classList.contains("visible")) {
      hideAddPanel();
    }
  }
});

// Dismiss context menu on click outside
document.addEventListener("click", (e) => {
  const menu = document.getElementById("context-menu");
  if (menu && !menu.contains(e.target as Node)) {
    hideContextMenu();
  }
});

// Dismiss context menu on scroll
document.addEventListener("scroll", () => hideContextMenu(), true);

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

  // Track shell working directory via OSC 7 (emitted by zsh/bash on cd)
  term.parser.registerOscHandler(7, (data) => {
    // data is "file://hostname/path" or "file:///path"
    try {
      const url = new URL(data);
      if (url.protocol === "file:") {
        const newPath = decodeURIComponent(url.pathname);
        if (newPath && newPath !== fileBrowserRoot) {
          fileBrowserRoot = newPath;
          // Clear stale expanded directories and reload
          expandedDirs.clear();
          if (!state.rightSidebarCollapsed) {
            loadDirectory(fileBrowserRoot).then((entries) => {
              expandedDirs.set(fileBrowserRoot, entries);
              renderFileTreeDOM();
            });
          }
        }
      }
    } catch {
      // Ignore malformed OSC 7 data
    }
    return false; // allow other handlers to process too
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

async function loadDirectory(path: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("list_directory", { path: path || null });
  } catch {
    return [];
  }
}

function renderFileTree(parentPath: string, entries: DirEntry[]): string {
  return entries
    .map((entry) => {
      const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const isExpanded = expandedDirs.has(fullPath);
      const children = expandedDirs.get(fullPath);

      if (entry.isDir) {
        return `
          <button class="file-tree-item" data-path="${escapeHtml(fullPath)}" data-is-dir="true">
            <span class="expand-arrow ${isExpanded ? "expanded" : ""}">&#9654;</span>
            <span class="file-icon">&#128193;</span>
            <span class="file-name">${escapeHtml(entry.name)}</span>
          </button>
          ${isExpanded && children ? `<div class="file-tree-children">${renderFileTree(fullPath, children)}</div>` : ""}
        `;
      }
      return `
        <button class="file-tree-item is-file" data-path="${escapeHtml(fullPath)}" data-is-dir="false">
          <span class="expand-arrow" style="visibility:hidden">&#9654;</span>
          <span class="file-icon">&#128196;</span>
          <span class="file-name">${escapeHtml(entry.name)}</span>
        </button>
      `;
    })
    .join("");
}

async function openRightSidebar() {
  state.rightSidebarCollapsed = false;
  const shell = app.querySelector<HTMLElement>(".app-shell");
  shell?.classList.remove("right-collapsed");

  // Load root directory if not already loaded
  if (!expandedDirs.has(fileBrowserRoot)) {
    const entries = await loadDirectory(fileBrowserRoot);
    expandedDirs.set(fileBrowserRoot, entries);
  }
  renderFileTreeDOM();

  setTimeout(() => {
    const key = state.selectedId || "local";
    const session = sessions.get(key);
    if (session && !session.exited) session.fitAddon.fit();
  }, 300);
}

function closeRightSidebar() {
  state.rightSidebarCollapsed = true;
  const shell = app.querySelector<HTMLElement>(".app-shell");
  shell?.classList.add("right-collapsed");

  setTimeout(() => {
    const key = state.selectedId || "local";
    const session = sessions.get(key);
    if (session && !session.exited) session.fitAddon.fit();
  }, 300);
}

function renderFileTreeDOM() {
  const container = document.getElementById("file-tree");
  if (!container) return;
  const rootEntries = expandedDirs.get(fileBrowserRoot);
  if (rootEntries) {
    container.innerHTML = renderFileTree(fileBrowserRoot, rootEntries);
    bindFileTreeEvents(container);
  }
}

function bindFileTreeEvents(container: HTMLElement) {
  container.querySelectorAll<HTMLButtonElement>(".file-tree-item").forEach((btn) => {
    const path = btn.dataset.path!;
    const isDir = btn.dataset.isDir === "true";
    const nameSpan = btn.querySelector<HTMLElement>(".file-name");
    const name = nameSpan?.textContent || "";

    // Click to expand/collapse directories
    btn.onclick = async () => {
      if (!isDir) return;
      if (expandedDirs.has(path)) {
        expandedDirs.delete(path);
      } else {
        const children = await loadDirectory(path);
        expandedDirs.set(path, children);
      }
      renderFileTreeDOM();
    };

    // Right-click context menu
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, { path, isDir, name });
    });

    // Native drag via mousedown + threshold → startDrag plugin
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragStarted = false;

      const onMouseMove = (ev: MouseEvent) => {
        if (dragStarted) return;
        if (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5) {
          dragStarted = true;
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);

          nativeDragSourcePath = path;
          btn.classList.add("dragging");

          const iconPath = isDir
            ? "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns"
            : "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns";

          startDrag({ item: [path], icon: iconPath })
            .catch(() => {}) // Ignore drag cancellation
            .finally(() => {
              btn.classList.remove("dragging");
              nativeDragSourcePath = null;
              clearDropHighlights();
            });
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });

  // Right-click on empty space in file tree → root context menu
  container.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".file-tree-item")) return;
    e.preventDefault();
    showRootContextMenu(e.clientX, e.clientY);
  });
}

function render() {
  const filtered = state.profiles;

  const selected = activeServer(filtered);
  if (selected && state.selectedId !== selected.id) {
    state.selectedId = selected.id;
  }

  const groups = groupedProfiles(filtered);

  app.innerHTML = `
    <main class="app-shell ${state.sidebarCollapsed ? "collapsed" : ""} ${state.rightSidebarCollapsed ? "right-collapsed" : ""}">
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
      </aside>

      <div class="sidebar-resize-handle" id="sidebar-resize-handle"></div>

      <div class="main-card">
      <header class="window-strip">
        <button class="expand-btn" id="expand-sidebar" title="Expand Sidebar" aria-label="Expand Sidebar">\u2261</button>
        <span class="window-strip-title">${escapeHtml(state.view === "terminals" ? (state.profiles.find((p) => p.id === state.selectedId)?.host ?? "Terminal") : state.view.charAt(0).toUpperCase() + state.view.slice(1))}</span>
        <div class="drag-region"></div>
        ${state.view === "terminals" ? `<button class="window-strip-action" id="open-vscode" title="Open in VS Code">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>` : ""}
        <button class="window-strip-action" id="toggle-right-sidebar" title="File Browser">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
      </header>

      <section class="main-view">
        ${renderMainPanel()}
      </section>
      </div>

      <aside class="right-sidebar">
        <div class="right-sidebar-header">
          <h3>Files</h3>
          <button class="right-sidebar-collapse" id="collapse-right-sidebar" title="Close File Browser">&times;</button>
        </div>
        <div class="file-tree" id="file-tree"></div>
      </aside>

    </main>
    <div class="add-panel" id="add-panel">
      <div class="add-panel-grid">
        <label><span>Name</span><input id="add-name" placeholder="my-server" /></label>
        <label><span>Host / IP</span><input id="add-host" placeholder="localhost" /></label>
        <label><span>User</span><input id="add-user" placeholder="root" /></label>
        <label><span>Port</span><input id="add-port" type="number" value="22" /></label>
        <label class="full-width"><span>Password</span><input id="add-password" type="password" /></label>
      </div>
      <div class="add-panel-actions">
        <button class="button-solid add-panel-submit" id="confirm-add">Add</button>
      </div>
    </div>
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

  // Right sidebar toggle (button in window-strip)
  app.querySelector<HTMLButtonElement>("#toggle-right-sidebar")?.addEventListener("click", async () => {
    if (state.rightSidebarCollapsed) {
      await openRightSidebar();
    } else {
      closeRightSidebar();
    }
  });

  // Right sidebar collapse (X button inside right sidebar)
  app.querySelector<HTMLButtonElement>("#collapse-right-sidebar")?.addEventListener("click", () => {
    closeRightSidebar();
  });

  // Render file tree if right sidebar is open
  if (!state.rightSidebarCollapsed && expandedDirs.has(fileBrowserRoot)) {
    renderFileTreeDOM();
  }

  // Sidebar resize by dragging the right edge
  const resizeHandle = app.querySelector<HTMLElement>("#sidebar-resize-handle");
  if (resizeHandle) {
    resizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      resizeHandle.classList.add("dragging");
      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.max(160, Math.min(ev.clientX, 500));
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

  // ── Add-panel: hover, click, and input handlers ──
  const addBtn = app.querySelector<HTMLButtonElement>("#add-btn");
  const addPanel = app.querySelector<HTMLElement>("#add-panel");

  if (addBtn && addPanel) {
    addBtn.addEventListener("mouseenter", showAddPanel);
    addBtn.addEventListener("mouseleave", scheduleHideAddPanel);

    addPanel.addEventListener("mouseenter", () => {
      if (addPanelHideTimeout) {
        clearTimeout(addPanelHideTimeout);
        addPanelHideTimeout = null;
      }
    });
    addPanel.addEventListener("mouseleave", scheduleHideAddPanel);

    addBtn.addEventListener("click", () => {
      if (addPanel.classList.contains("visible") && addPanelClickLocked) {
        hideAddPanel();
      } else {
        addPanelClickLocked = true;
        showAddPanel();
      }
    });

    addPanel.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => {
        if (hasAddPanelInput()) addPanelClickLocked = true;
      });
    });

    const confirmAdd = app.querySelector<HTMLButtonElement>("#confirm-add");
    if (confirmAdd) {
      confirmAdd.onclick = async () => {
        const name = app.querySelector<HTMLInputElement>("#add-name")?.value.trim() ?? "";
        const host = app.querySelector<HTMLInputElement>("#add-host")?.value.trim() ?? "";
        const user = app.querySelector<HTMLInputElement>("#add-user")?.value.trim() || undefined;
        const portRaw = app.querySelector<HTMLInputElement>("#add-port")?.value ?? "22";
        const password = app.querySelector<HTMLInputElement>("#add-password")?.value || undefined;

        if (!name || !host) return;

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
        hideAddPanel();
        render();
      };
    }
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

// Setup native drag-drop listener for file tree (once, globally)
setupNativeDragDrop();

// Apply liquid glass effect to the window (macOS 26+ only)
isGlassSupported()
  .then((supported) => {
    if (!supported) return;
    return setLiquidGlassEffect({
      variant: GlassMaterialVariant.Sidebar,
    }).then(() => {
      // Make surfaces translucent so native glass shows through
      document.documentElement.classList.add("liquid-glass");
    });
  })
  .catch(() => {
    // Silently ignore on unsupported platforms
  });
