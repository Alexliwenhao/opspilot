import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";

import { api, listen, hasTauri, EVT } from "./ipc/client";
import type {
  ApprovalRequest,
  HostProfile,
  Settings,
  TerminalStatus,
  AiSession,
  AiSessionDetail,
  AiMessage,
  EngineStatus,
  HistoryEntry,
  Macro,
  NetToolKind,
  NetToolResult,
  SftpEntry,
  SftpListing,
  Tunnel,
  Locale,
} from "./ipc/contract";
import { t, setLocale } from "./i18n";

type MainView =
  | "terminals"
  | "sftp"
  | "tunnels"
  | "macros"
  | "network"
  | "history";

interface TermView {
  termId: string;
  profileId: string;
  title: string;
  status: TerminalStatus;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLElement;
}

interface AppState {
  profiles: HostProfile[];
  terminals: Map<string, TermView>;
  activeTerm: string | null;
  /** Multi-execution (broadcast): keystrokes go to every open terminal. */
  broadcast: boolean;
  sessions: AiSession[];
  activeSession: string | null;
  settings: Settings | null;
  engine: EngineStatus | null;
  approvals: Map<string, ApprovalRequest>;
  view: MainView;
  // SFTP
  sftpProfileId: string | null;
  sftpPath: string;
  sftpEntries: SftpEntry[];
  sftpNote: string | null;
  // Tunnels
  tunnels: Tunnel[];
  // Macros
  macros: Macro[];
  macroRecording: string[] | null;
  // Network tools
  netResults: NetToolResult[];
  netRunning: boolean;
  // History
  history: HistoryEntry[];
  historyFilter: string;
}

const state: AppState = {
  profiles: [],
  terminals: new Map(),
  activeTerm: null,
  broadcast: false,
  sessions: [],
  activeSession: null,
  settings: null,
  engine: null,
  approvals: new Map(),
  view: "terminals",
  sftpProfileId: null,
  sftpPath: "/home/ops",
  sftpEntries: [],
  sftpNote: null,
  tunnels: [],
  macros: [],
  macroRecording: null,
  netResults: [],
  netRunning: false,
  history: [],
  historyFilter: "",
};

export function mount(root: HTMLElement) {
  root.classList.add("app");
  root.innerHTML = `
    <!-- Menu bar -->
    <div class="menubar">
      <div class="brand">◆ ${t("brand")}</div>
      <div class="menu" data-menu="session">${t("menuSession")}
        <div class="sub">
          <div class="sub-item" data-action="new-terminal">▸ ${t("menuNewTerminal")}</div>
          <div class="sub-item" data-action="new-session">▸ ${t("menuNewSession")}</div>
          <div class="sub-sep"></div>
          <div class="sub-item" data-action="close-tab">✕ ${t("menuCloseTab")}</div>
          <div class="sub-item" data-action="close-all">✕✕ ${t("menuCloseAll")}</div>
        </div>
      </div>
      <div class="menu" data-menu="servers">${t("menuServers")}
        <div class="sub">
          <div class="sub-item" data-action="add-host">＋ ${t("menuAddConnection")}</div>
        </div>
      </div>
      <div class="menu" data-menu="tools">${t("menuTools")}
        <div class="sub">
          <div class="sub-item" data-view="tunnels">🚇 ${t("viewTunnels")}</div>
          <div class="sub-item" data-view="macros">⏺ ${t("viewMacros")}</div>
          <div class="sub-item" data-view="network">🛰 ${t("viewNetwork")}</div>
          <div class="sub-item" data-view="history">🕘 ${t("viewHistory")}</div>
        </div>
      </div>
      <div class="menu" data-menu="games">${t("menuGames")}</div>
      <div class="menu" data-menu="sessions">${t("menuSessions")}
        <div class="sub">
          <div class="sub-item" data-view="terminals">⌨ ${t("viewTerminals")}</div>
          <div class="sub-item" data-view="sftp">📁 ${t("viewSftp")}</div>
        </div>
      </div>
      <div class="menu" data-menu="view">${t("menuView")}</div>
      <div class="menu" data-menu="split">${t("menuSplit")}</div>
      <div class="menu" data-menu="multiexec">${t("menuMultiExec")}
        <div class="sub">
          <div class="sub-item" data-toggle="broadcast" id="menu-broadcast">▸ ${t("menuMultiExecOff")}</div>
        </div>
      </div>
      <div class="menu" data-menu="tunneling">${t("menuTunneling")}</div>
      <div class="menu" data-menu="packages">${t("menuPackages")}</div>
      <div class="menu" data-menu="settings">${t("menuSettings")}
        <div class="sub">
          <div class="sub-item" data-action="open-settings">⚙ ${t("menuPreferences")}</div>
        </div>
      </div>
      <div class="menu" data-menu="help">${t("menuHelp")}
        <div class="sub">
          <div class="sub-item" data-action="about">ⓘ ${t("menuAbout")}</div>
        </div>
      </div>
      <div class="spacer"></div>
      <div class="tools">
        <button class="tbtn" id="tool-new" title="${t("menuNewTerminal")}">＋</button>
        <button class="tbtn" id="tool-broadcast" title="${t("multiExec")}">⇶</button>
        <button class="tbtn" id="tool-settings" title="${t("settings")}">⚙</button>
      </div>
    </div>

    <!-- Quick Connect bar -->
    <div class="quickbar">
      <span class="qlabel">${t("quickConnect")}:</span>
      <input id="quick-input" placeholder="user@host:port"/>
      <button class="qbtn" id="quick-go">${t("go")}</button>
      <div class="qspacer"></div>
      <span class="qinfo" id="engine-info">…</span>
    </div>

    <!-- SFTP panel (left) -->
    <div class="sftp-panel">
      <div class="sftp-head">
        <span>${t("connections")}</span>
        <div class="mini">
          <button id="add-host" title="${t("addHost")}">＋</button>
        </div>
      </div>
      <div class="conn-list" id="conn-list"></div>
      <div class="sftp-head" style="border-top:1px solid var(--border-soft)">
        <span>${t("fileBrowser")}</span>
        <div class="mini">
          <button id="sftp-up" title="${t("up")}">↑</button>
          <button id="sftp-refresh" title="${t("refresh")}">↻</button>
        </div>
      </div>
      <div class="file-toolbar">
        <button title="${t("up")}" data-sftp-tool="up">↑</button>
        <button title="${t("refresh")}" data-sftp-tool="refresh">↻</button>
        <button title="${t("upload")}" data-sftp-tool="upload">↑↓</button>
      </div>
      <div class="file-list" id="file-list"></div>
      <div class="sftp-foot">
        <label><input type="checkbox" id="follow-folder"/> ${t("followTerminalFolder")}</label>
        <label><input type="checkbox" id="remote-mon"/> ${t("remoteMonitoring")}</label>
      </div>
    </div>

    <!-- Main area -->
    <div class="main" id="main"></div>

    <!-- AI panel (right) -->
    <div class="ai-panel">
      <div class="ai-head">
        <span>${t("aiAssistant")}</span>
        <div class="actions">
          <button id="new-session" title="${t("newSession")}">＋</button>
        </div>
      </div>
      <div class="ai-meta" id="ai-meta"></div>
      <div class="messages" id="messages"></div>
      <div class="composer">
        <textarea id="ai-input" placeholder="${t("askCopilot")}"></textarea>
        <div class="row">
          <span class="hint" id="ai-hint">${hasTauri ? t("connectedNative") : t("browserPreview")}</span>
          <button class="send" id="ai-send">${t("send")}</button>
        </div>
      </div>
    </div>

    <!-- Status bar -->
    <div class="statusbar">
      <div class="sleft">
        <div class="sitem"><span class="dot"></span>${t("statusReady")}</div>
        <div class="sitem dim" id="sb-term-count">0 ${t("statusTerminals")}</div>
        <div class="sitem dim" id="sb-broadcast">${t("multiExec")}: ${t("multiExecOff")}</div>
      </div>
      <div class="sspacer"></div>
      <div class="sright">
        <span class="kbd">${t("statusKbd")}</span>
      </div>
    </div>
  `;

  wireEvents();
  wireControls();
  void bootstrap();
}

async function bootstrap() {
  try {
    const [profiles, settings, engine, sessions, tunnels, macros, history] = await Promise.all([
      api.listProfiles(),
      api.getSettings(),
      api.engineStatus(),
      api.aiListSessions(),
      api.listTunnels(),
      api.listMacros(),
      api.listHistory(null, 200),
    ]);
    state.profiles = profiles;
    state.settings = settings;
    state.engine = engine;
    state.sessions = sessions;
    state.tunnels = tunnels;
    state.macros = macros;
    state.history = history;
    setLocale(settings.locale);
    renderEngine();
    renderConnList();
    renderFileList();
    renderMain();
    renderMessages();
    renderStatusbar();
    renderTopbar(); // re-render with chosen locale
  } catch (e) {
    console.error("bootstrap failed", e);
  }
}

// --- top-level event wiring ----------------------------------------------

function wireEvents() {
  void listen<{ termId: string; base64: string }>(EVT.termData, (p) => {
    const v = state.terminals.get(p.termId);
    if (!v) return;
    const bytes = atob(p.base64);
    v.term.write(bytes);
  });

  void listen<{ termId: string; status: TerminalStatus; message: string | null }>(
    EVT.termStatus,
    (p) => {
      const v = state.terminals.get(p.termId);
      if (!v) return;
      v.status = p.status;
      updateTabStatus(p.termId);
    },
  );

  void listen<{ termId: string; code: number | null; reason: string }>(
    EVT.termExit,
    (p) => {
      const v = state.terminals.get(p.termId);
      if (!v) return;
      v.status = "closed";
      v.term.write(`\r\n\x1b[33m[session closed: ${p.reason}]\x1b[0m\r\n`);
    },
  );

  void listen<{ sessionId: string; messageId: string; delta: string }>(
    EVT.aiDelta,
    (p) => {
      const el = document.getElementById(`ai-live-${p.sessionId}`);
      if (el) el.textContent += p.delta;
    },
  );

  void listen<{ sessionId: string; message: AiMessage }>(EVT.aiMessage, (p) => {
    const s = state.sessions.find((x) => x.sessionId === p.sessionId);
    if (!s) {
      // session may have been created remotely; refresh
      void api.aiListSessions().then((list) => {
        state.sessions = list;
        renderMessages();
      });
      return;
    }
    renderMessages();
  });

  void listen<{ sessionId: string; messageId: string; call: any }>(
    EVT.aiTool,
    () => renderMessages(),
  );

  void listen<{ sessionId: string; durationMs: number }>(EVT.aiDone, () => {
    renderMessages();
  });

  void listen<{ sessionId: string; message: string }>(EVT.aiError, (p) => {
    console.error("ai error", p.message);
    renderMessages();
  });

  void listen<ApprovalRequest>(EVT.approvalRequest, (req) => {
    state.approvals.set(req.requestId, req);
    renderMessages();
  });

  void listen<{ requestId: string; decision: string }>(
    EVT.approvalResolved,
    () => renderMessages(),
  );

  void listen<{ tunnelId: string; status: string; message: string | null }>(
    EVT.tunnelStatus,
    (p) => {
      const t = state.tunnels.find((x) => x.id === p.tunnelId);
      if (!t) return;
      t.status = p.status as Tunnel["status"];
      t.message = p.message;
      if (state.view === "tunnels") renderMain();
    },
  );

  void listen<{ entry: HistoryEntry }>(EVT.historyAppend, (p) => {
    state.history.unshift(p.entry);
    if (state.history.length > 500) state.history.pop();
    if (state.view === "history") renderMain();
  });
}

function wireControls() {
  document.getElementById("add-host")!.onclick = () => openHostModal(null);
  document.getElementById("tool-settings")!.onclick = () => openSettingsModal();
  document.getElementById("settings-btn")?.addEventListener("click", () => openSettingsModal());
  document.getElementById("new-session")!.onclick = async () => {
    const res = await api.aiNewSession(state.activeTerm ?? null);
    state.activeSession = res.sessionId;
    state.sessions = await api.aiListSessions();
    renderMessages();
  };
  const input = document.getElementById("ai-input") as HTMLTextAreaElement;
  document.getElementById("ai-send")!.onclick = () => sendAi();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendAi();
    }
  });

  // Menu bar — view switches
  document.querySelectorAll<HTMLElement>(".menubar [data-view]").forEach((el) => {
    el.addEventListener("click", () => {
      const view = el.dataset.view as MainView;
      if (view) switchView(view);
    });
  });

  // Menu bar — toggle broadcast
  document.querySelectorAll<HTMLElement>("[data-toggle='broadcast']").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBroadcast();
    });
  });

  // Menu bar — actions
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = el.dataset.action;
      if (action === "add-host") openHostModal(null);
      else if (action === "new-session") openHostModal(null);
      else if (action === "open-settings") openSettingsModal();
      else if (action === "new-terminal") {
        if (state.profiles[0]) connectHost(state.profiles[0].id);
      } else if (action === "close-tab") {
        if (state.activeTerm) {
          const v = state.terminals.get(state.activeTerm);
          if (v) {
            void api.closeTerminal(v.termId);
            state.terminals.delete(v.termId);
            if (state.activeTerm === v.termId) state.activeTerm = null;
            renderMain();
            renderStatusbar();
          }
        }
      }
    });
  });

  // Menu bar — click to toggle dropdown (for better UX)
  document.querySelectorAll<HTMLElement>(".menubar .menu").forEach((menuEl) => {
    menuEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasActive = menuEl.classList.contains("active");
      document.querySelectorAll(".menubar .menu").forEach((m) => m.classList.remove("active"));
      if (!wasActive) menuEl.classList.add("active");
    });
  });
  // Close dropdowns when clicking outside
  document.addEventListener("click", () => {
    document.querySelectorAll(".menubar .menu").forEach((m) => m.classList.remove("active"));
  });

  // Toolbar buttons
  document.getElementById("tool-new")!.onclick = () => {
    if (state.profiles[0]) connectHost(state.profiles[0].id);
  };
  document.getElementById("tool-broadcast")!.onclick = () => toggleBroadcast();

  // Quick connect
  document.getElementById("quick-go")!.onclick = () => {
    const qinput = document.getElementById("quick-input") as HTMLInputElement;
    const val = qinput.value.trim();
    if (!val) return;
    openQuickConnect(val);
  };
  document.getElementById("quick-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const qinput = document.getElementById("quick-input") as HTMLInputElement;
      const val = qinput.value.trim();
      if (val) openQuickConnect(val);
    }
  });

  // SFTP panel controls
  document.getElementById("sftp-up")!.onclick = () => {
    if (state.sftpPath && state.sftpPath !== "/") {
      const parts = state.sftpPath.split("/").filter(Boolean);
      parts.pop();
      state.sftpPath = "/" + parts.join("/");
      void loadSftp();
    }
  };
  document.getElementById("sftp-refresh")!.onclick = () => {
    if (state.sftpProfileId) void loadSftp();
  };
  document.querySelectorAll<HTMLElement>("[data-sftp-tool]").forEach((btn) => {
    btn.onclick = () => {
      const tool = btn.dataset.sftpTool;
      if (tool === "up" && state.sftpPath && state.sftpPath !== "/") {
        const parts = state.sftpPath.split("/").filter(Boolean);
        parts.pop();
        state.sftpPath = "/" + parts.join("/");
        void loadSftp();
      } else if (tool === "refresh" && state.sftpProfileId) {
        void loadSftp();
      }
    };
  });

  // Global shortcuts
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      const v = state.terminals.get(state.activeTerm ?? "");
      if (v && state.view === "terminals") {
        e.preventDefault();
        openSearchOverlay(v);
      }
    }
  });
}

function toggleBroadcast() {
  state.broadcast = !state.broadcast;
  const btn = document.getElementById("tool-broadcast");
  if (btn) btn.classList.toggle("active", state.broadcast);
  const menuItem = document.getElementById("menu-broadcast");
  if (menuItem) menuItem.textContent = state.broadcast ? t("menuMultiExecOn") : t("menuMultiExecOff");
  renderStatusbar();
}

async function openQuickConnect(target: string) {
  // Parse user@host:port
  let user = "root";
  let host = target;
  let port = 22;
  const atIdx = target.indexOf("@");
  if (atIdx >= 0) {
    user = target.substring(0, atIdx);
    const rest = target.substring(atIdx + 1);
    const colonIdx = rest.lastIndexOf(":");
    if (colonIdx >= 0) {
      host = rest.substring(0, colonIdx);
      port = parseInt(rest.substring(colonIdx + 1), 10) || 22;
    } else {
      host = rest;
    }
  } else {
    const colonIdx = target.lastIndexOf(":");
    if (colonIdx >= 0) {
      host = target.substring(0, colonIdx);
      port = parseInt(target.substring(colonIdx + 1), 10) || 22;
    }
  }
  // Check if host already exists
  const existing = state.profiles.find((p) => p.host === host && p.port === port);
  if (existing) {
    connectHost(existing.id);
    return;
  }
  // Create new profile
  const profile: HostProfile = {
    id: `quick-${Date.now()}`,
    name: `${user}@${host}`,
    host,
    port,
    username: user,
    authKind: "password",
    keyPath: null,
    group: "Default",
    color: "#e0533d",
    saveSecret: false,
    initCommands: [],
    note: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await api.saveProfile(profile);
  state.profiles = await api.listProfiles();
  renderConnList();
  connectHost(profile.id);
}

function switchView(view: MainView) {
  state.view = view;
  void (async () => {
    if (view === "tunnels") state.tunnels = await api.listTunnels();
    if (view === "macros") state.macros = await api.listMacros();
    if (view === "history") state.history = await api.listHistory(null, 200);
    if (view === "sftp" && !state.sftpProfileId && state.profiles[0]) {
      state.sftpProfileId = state.profiles[0].id;
      await loadSftp();
    }
    renderMain();
    if (view === "terminals") setTimeout(refitActive, 30);
  })();
}

function refitActive() {
  const v = state.terminals.get(state.activeTerm ?? "");
  if (!v) return;
  try {
    v.fit.fit();
    if (v.term.cols && v.term.rows)
      void api.resizeTerminal(v.termId, v.term.cols, v.term.rows);
  } catch {
    /* ignore */
  }
}

/** Render connection list in SFTP panel (left sidebar). */
function renderConnList() {
  const list = document.getElementById("conn-list");
  if (!list) return;
  if (!state.profiles.length) {
    list.innerHTML = `<div class="hint" style="padding:8px 10px">${t("noConnections")}</div>`;
    return;
  }
  list.innerHTML = state.profiles
    .map((p) => {
      const active = state.activeTerm && state.terminals.get(state.activeTerm)?.profileId === p.id;
      return `<div class="conn-item ${active ? "active" : ""}" data-profile="${p.id}">
        <span class="cidot" style="background:${active ? "#fff" : "#6a9955"}"></span>
        <span>${escapeHtml(p.name)}</span>
      </div>`;
    })
    .join("");
  list.querySelectorAll<HTMLElement>(".conn-item").forEach((el) => {
    el.onclick = () => {
      const pid = el.dataset.profile!;
      connectHost(pid);
    };
  });
}

/** Render file list in SFTP panel. */
function renderFileList() {
  const list = document.getElementById("file-list");
  if (!list) return;
  if (!state.sftpEntries.length) {
    list.innerHTML = `<div class="hint" style="padding:8px 10px">${t("emptyDir")}</div>`;
    return;
  }
  list.innerHTML = state.sftpEntries
    .map((e) => {
      const icon = e.kind === "dir" ? "📁" : e.kind === "symlink" ? "🔗" : "📄";
      const size = e.kind === "dir" ? "" : formatSize(e.size);
      return `<div class="frow">
        <span class="ficon">${icon}</span>
        <span class="fname">${escapeHtml(e.name)}</span>
        <span class="fsize">${size}</span>
      </div>`;
    })
    .join("");
  list.querySelectorAll<HTMLElement>(".frow").forEach((row, i) => {
    row.onclick = () => {
      const entry = state.sftpEntries[i];
      if (entry && entry.kind === "dir") {
        const newPath = state.sftpPath === "/" ? "/" + entry.name : state.sftpPath + "/" + entry.name;
        state.sftpPath = newPath;
        void loadSftp();
      }
    };
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

/** Render bottom status bar. */
function renderStatusbar() {
  const count = document.getElementById("sb-term-count");
  if (count) count.textContent = `${state.terminals.size} ${t("statusTerminals")}`;
  const bc = document.getElementById("sb-broadcast");
  if (bc) bc.textContent = `${t("multiExec")}: ${state.broadcast ? t("multiExecOn") : t("multiExecOff")}`;
}

/** Re-render dynamic text after language change. */
function renderTopbar() {
  const setText = (sel: string, txt: string) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.textContent = txt;
  };
  const bc = document.getElementById("broadcast-btn");
  if (bc) bc.textContent = `⇶ ${t("multiExec")}: ${state.broadcast ? t("multiExecOn") : t("multiExecOff")}`;
  document.querySelectorAll<HTMLElement>("#viewswitch .vs").forEach((b) => {
    const v = b.dataset.view as MainView;
    const map: Record<MainView, string> = {
      terminals: t("viewTerminals"),
      sftp: t("viewSftp"),
      tunnels: t("viewTunnels"),
      macros: t("viewMacros"),
      network: t("viewNetwork"),
      history: t("viewHistory"),
    };
    const label = map[v];
    const icons: Record<MainView, string> = {
      terminals: "⌨", sftp: "📁", tunnels: "🚇", macros: "⏺", network: "🛰", history: "🕘",
    };
    b.title = label;
    b.textContent = `${icons[v]} ${label}`;
  });
  const sb = document.getElementById("settings-btn");
  if (sb) sb.textContent = `⚙ ${t("settings")}`;
  const ah = document.getElementById("add-host");
  if (ah) ah.textContent = t("addHost");
  setText(".sidebar .head span", t("connections"));
  setText(".aipanel .head span", t("aiCopilot"));
  const ns = document.getElementById("new-session");
  if (ns) ns.textContent = t("newSession");
  const sd = document.getElementById("ai-send");
  if (sd) sd.textContent = t("send");
  const ai = document.getElementById("ai-input") as HTMLTextAreaElement | null;
  if (ai) ai.placeholder = t("askCopilot");
  const hint = document.getElementById("ai-hint");
  if (hint) hint.textContent = hasTauri ? t("connectedNative") : t("browserPreview");
  renderMain();
}

async function sendAi() {
  const input = document.getElementById("ai-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  if (!state.activeSession) {
    const res = await api.aiNewSession(state.activeTerm ?? null);
    state.activeSession = res.sessionId;
    state.sessions = await api.aiListSessions();
  }
  input.value = "";
  await api.aiSend(state.activeSession, text);
  renderMessages();
}

// --- rendering ------------------------------------------------------------

function renderEngine() {
  const badge = document.getElementById("engine-info");
  if (!badge) return;
  if (!state.engine) {
    badge.textContent = "";
    return;
  }
  const status = state.engine.ready ? t("aiReady") : "…";
  badge.textContent = `${t("aiEngine")}: ${state.engine.kind} · ${status}`;
}

function renderTree() {
  // Keep for backward compat — actual rendering now goes through renderConnList
  renderConnList();
  renderStatusbar();
}

function renderMain() {
  const main = document.getElementById("main")!;
  switch (state.view) {
    case "sftp":
      return renderSftp(main);
    case "tunnels":
      return renderTunnels(main);
    case "macros":
      return renderMacros(main);
    case "network":
      return renderNetwork(main);
    case "history":
      return renderHistory(main);
    default:
      return renderTerminals(main);
  }
}

function renderTerminals(main: HTMLElement) {
  if (state.terminals.size === 0) {
    main.innerHTML = `<div class="empty">
      <div style="font-size:40px;opacity:0.4">⌨</div>
      <div>${t("selectHostToOpen")}</div>
      <div style="font-size:11px">${t("searchScrollback")}</div>
    </div>`;
    return;
  }
  let tabs = `<div class="tabbar">`;
  for (const v of state.terminals.values()) {
    const active = v.termId === state.activeTerm ? "active" : "";
    const color = profileColor(v.profileId);
    tabs += `<div class="tab ${active}" data-tab="${v.termId}">
      <span class="dot" style="background:${color};width:7px;height:7px;border-radius:50%"></span>
      <span>${escapeHtml(v.title)}</span>
      <span class="x" data-close="${v.termId}">×</span>
    </div>`;
  }
  tabs += `</div><div class="term-host" id="term-host"></div>`;
  main.innerHTML = tabs;

  const host = document.getElementById("term-host")!;
  for (const v of state.terminals.values()) {
    if (v.termId !== state.activeTerm) continue;
    v.el = document.createElement("div");
    v.el.className = "xterm-wrap";
    host.appendChild(v.el);
    v.term.open(v.el);
    v.fit.fit();
    v.term.focus();
  }

  main.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
    el.onclick = (e) => {
      if ((e.target as HTMLElement).dataset.close) return;
      state.activeTerm = el.dataset.tab!;
      renderMain();
    };
  });
  main.querySelectorAll<HTMLElement>("[data-close]").forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const id = (e.target as HTMLElement).dataset.close!;
      await api.closeTerminal(id);
      const v = state.terminals.get(id);
      v?.term.dispose();
      state.terminals.delete(id);
      if (state.activeTerm === id) state.activeTerm = state.terminals.keys().next().value ?? null;
      renderMain();
    };
  });
}

function updateTabStatus(termId: string) {
  // lightweight: re-render tab bar only
  const tabs = document.querySelectorAll<HTMLElement>(".tab");
  tabs.forEach((t) => {
    if (t.dataset.tab === termId) {
      const v = state.terminals.get(termId);
      const color = v?.status === "ready" ? profileColor(v.profileId) : "#e0c33d";
      const dot = t.querySelector(".dot") as HTMLElement;
      if (dot) dot.style.background = color;
    }
  });
}

async function connectHost(profileId: string) {
  const cols = 100;
  const rows = 30;
  const info = await api.openTerminal({ profileId, cols, rows });
  const term = new Terminal({
    fontFamily: state.settings?.fontFamily ?? '"JetBrains Mono", "SF Mono", monospace',
    fontSize: state.settings?.fontSize ?? 13,
    lineHeight: 1.3,
    theme: {
      background: "#05070a",
      foreground: "#e6eaf0",
      cursor: "#4d9cf0",
      cursorAccent: "#05070a",
      black: "#1f2530",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#fbbf24",
      blue: "#4d9cf0",
      magenta: "#b07cf0",
      cyan: "#22d3ee",
      white: "#e6eaf0",
      brightBlack: "#545d6b",
      brightRed: "#fca5a5",
      brightGreen: "#86efac",
      brightYellow: "#fcd34d",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#f1f5f9",
    },
    cursorBlink: true,
    cursorStyle: "bar",
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.onData((data) => {
    const bytes = Array.from(new TextEncoder().encode(data));
    if (state.broadcast) {
      void api.broadcastWrite(bytes);
    } else {
      void api.writeTerminal(info.termId, bytes);
    }
    // Macro recording: capture raw input while a recording is active.
    if (state.macroRecording) state.macroRecording.push(data);
  });
  const view: TermView = {
    termId: info.termId,
    profileId,
    title: state.profiles.find((p) => p.id === profileId)?.name ?? "host",
    status: info.status,
    term,
    fit,
    search,
    el: document.createElement("div"),
  };
  state.terminals.set(info.termId, view);
  state.activeTerm = info.termId;
  renderMain();

  // observe resize
  const ro = new ResizeObserver(() => {
    try {
      fit.fit();
      const dims = term.rows && term.cols;
      if (dims) void api.resizeTerminal(info.termId, term.cols, term.rows);
    } catch {
      /* ignore */
    }
  });
  const hostEl = document.getElementById("term-host");
  if (hostEl) ro.observe(hostEl);
}

function renderMessages() {
  const box = document.getElementById("messages")!;
  if (!state.activeSession) {
    box.innerHTML = `<div class="empty" style="color:var(--text-dim)">Start a session to talk to the copilot.<br/>Try: “check disk space”, “how much memory?”, “show uptime”.</div>`;
    return;
  }
  void api.aiGetSession(state.activeSession).then((detail: AiSessionDetail) => {
    let html = "";
    for (const m of detail.messages) {
      html += renderMessage(m);
    }
    // pending approvals
    for (const req of state.approvals.values()) {
      if (req.profileId !== detail.session.profileId && detail.session.profileId !== null)
        continue;
      html += renderApproval(req);
    }
    box.innerHTML = html;

    // wire approval buttons
    box.querySelectorAll<HTMLElement>("[data-approve]").forEach((el) => {
      el.onclick = async () => {
        const id = el.dataset.approve!;
        const decision = el.dataset.decision as any;
        await api.approvalResolve(id, decision);
        state.approvals.delete(id);
        renderMessages();
      };
    });
    box.scrollTop = box.scrollHeight;
  });
}

function renderMessage(m: AiMessage): string {
  const roleCls = m.role === "user" ? "user" : "assistant";
  let body = escapeHtml(m.content).replace(/`([^`]+)`/g, "<code>$1</code>");
  // naive code fences
  body = body.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre>${escapeHtml(code)}</pre>`);
  let tools = "";
  for (const t of m.toolCalls) {
    tools += `<div class="toolcall">
      <div class="row">
        <span class="badge ${t.status}">${t.status}</span>
        ${t.risk ? `<span class="badge ${t.risk}">${t.risk}</span>` : ""}
        <span>${escapeHtml(t.summary)}</span>
      </div>
      ${t.detail ? `<div class="detail">${escapeHtml(t.detail)}</div>` : ""}
    </div>`;
  }
  return `<div class="msg ${roleCls}">
    <div class="role ${roleCls}">${m.role}</div>
    <div>${body}</div>
    ${tools}
  </div>`;
}

function renderApproval(req: ApprovalRequest): string {
  return `<div class="approval" data-approval="${req.requestId}">
    <div class="cmd">${escapeHtml(req.command)}</div>
    <div class="reason">${escapeHtml(req.reason)} · risk: ${req.risk}</div>
    <div class="actions">
      <button class="allow" data-approve="${req.requestId}" data-decision="allow">${t("approve")}</button>
      <button class="deny" data-approve="${req.requestId}" data-decision="deny">${t("deny")}</button>
    </div>
  </div>`;
}

// --- SFTP file browser ----------------------------------------------------

async function loadSftp() {
  if (!state.sftpProfileId) return;
  try {
    const listing: SftpListing = await api.sftpList(state.sftpProfileId, state.sftpPath);
    state.sftpEntries = listing.entries;
    state.sftpNote = listing.note;
  } catch (e) {
    state.sftpEntries = [];
    state.sftpNote = String(e);
  }
}

function renderSftp(main: HTMLElement) {
  const host = state.profiles.find((p) => p.id === state.sftpProfileId)?.name ?? "—";
  main.innerHTML = `
    <div class="view sftp">
      <div class="view-head">
        <select id="sftp-host">${state.profiles
          .map((p) => `<option value="${p.id}" ${p.id === state.sftpProfileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
          .join("")}</select>
        <input id="sftp-path" value="${escapeAttr(state.sftpPath)}" placeholder="/"/>
        <button class="btn" id="sftp-go">${t("go")}</button>
        <button class="btn" id="sftp-up">${t("up")}</button>
        <span class="hint">${escapeHtml(host)}</span>
      </div>
      <div class="sftp-grid" id="sftp-grid"></div>
      ${state.sftpNote ? `<div class="hint" style="padding:0 12px 8px">${escapeHtml(state.sftpNote)}</div>` : ""}
    </div>`;
  renderSftpGrid();
  document.getElementById("sftp-host")!.onchange = async (e) => {
    state.sftpProfileId = (e.target as HTMLSelectElement).value;
    state.sftpPath = "/home/ops";
    await loadSftp();
    renderMain();
  };
  document.getElementById("sftp-go")!.onclick = async () => {
    state.sftpPath = (document.getElementById("sftp-path") as HTMLInputElement).value || "/";
    await loadSftp();
    renderMain();
  };
  document.getElementById("sftp-up")!.onclick = async () => {
    const parts = state.sftpPath.split("/").filter(Boolean);
    parts.pop();
    state.sftpPath = "/" + parts.join("/");
    await loadSftp();
    renderMain();
  };
  (document.getElementById("sftp-path") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("sftp-go")!.click();
  });
}

function renderSftpGrid() {
  const grid = document.getElementById("sftp-grid");
  if (!grid) return;
  if (!state.sftpEntries.length) {
    grid.innerHTML = `<div class="hint" style="padding:16px">${t("emptyDir")}</div>`;
    return;
  }
  grid.innerHTML = state.sftpEntries
    .map((e) => {
      const icon = e.kind === "dir" ? "📁" : e.kind === "symlink" ? "↪" : "📄";
      const size = e.kind === "dir" ? "—" : humanSize(e.size);
      return `<div class="frow" data-name="${escapeAttr(e.name)}" data-kind="${e.kind}">
        <span class="ficon">${icon}</span>
        <span class="fname">${escapeHtml(e.name)}</span>
        <span class="fsize">${size}</span>
        <span class="fmode">${escapeHtml(e.mode)}</span>
        <span class="factions">
          ${e.kind === "file" ? `<button class="lnk" data-act="dl">↓</button>` : ""}
          <button class="lnk" data-act="rm">×</button>
        </span>
      </div>`;
    })
    .join("");
  grid.querySelectorAll<HTMLElement>(".frow").forEach((row) => {
    const name = row.dataset.name!;
    const kind = row.dataset.kind as SftpEntry["kind"];
    row.ondblclick = async () => {
      if (kind === "dir" || kind === "symlink") {
        const path = joinPath(state.sftpPath, name);
        state.sftpPath = path;
        await loadSftp();
        renderMain();
      } else {
        await api.sftpDownload(state.sftpProfileId!, joinPath(state.sftpPath, name));
        flash(row, "queued ↓");
      }
    };
    row.querySelectorAll<HTMLElement>("[data-act]").forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const act = (b as HTMLElement).dataset.act;
        const path = joinPath(state.sftpPath, name);
        if (act === "dl") {
          await api.sftpDownload(state.sftpProfileId!, path);
          flash(row, "queued ↓");
        } else if (act === "rm") {
          if (confirm(`Delete ${path}?`)) {
            await api.sftpDelete(state.sftpProfileId!, path);
            await loadSftp();
            renderMain();
          }
        }
      };
    });
  });
}

function joinPath(base: string, name: string): string {
  if (name === "..") {
    const parts = base.split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.join("/");
  }
  if (name === ".") return base;
  return base.endsWith("/") ? base + name : base + "/" + name;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
}

function flash(el: HTMLElement, msg: string) {
  const t = document.createElement("span");
  t.className = "flash";
  t.textContent = msg;
  el.appendChild(t);
  setTimeout(() => t.remove(), 1200);
}

function statusLabel(s: string): string {
  switch (s) {
    case "stopped": return t("statusStopped");
    case "starting": return t("statusStarting");
    case "running": return t("statusRunning");
    case "error": return t("statusError");
    default: return s;
  }
}

// --- Tunnels --------------------------------------------------------------

function renderTunnels(main: HTMLElement) {
  main.innerHTML = `
    <div class="view">
      <div class="view-head">
        <strong>${t("sshTunnels")}</strong>
        <span class="hint">${t("tunnelHint")}</span>
        <div class="spacer"></div>
        <button class="btn" id="tun-add">${t("addTunnel")}</button>
      </div>
      <table class="ttable" id="tun-table"></table>
    </div>`;
  const tbl = document.getElementById("tun-table")!;
  if (!state.tunnels.length) {
    tbl.innerHTML = `<tr><td class="hint" style="padding:16px">${t("noTunnels")}</td></tr>`;
  } else {
    tbl.innerHTML = state.tunnels
      .map((tun) => {
        const host = state.profiles.find((p) => p.id === tun.profileId)?.name ?? tun.profileId;
        const dest = tun.kind === "dynamic" ? "SOCKS" : `${tun.remoteHost}:${tun.remotePort}`;
        return `<tr>
          <td><span class="badge ${tun.status}">${statusLabel(tun.status)}</span></td>
          <td><strong>${escapeHtml(tun.name)}</strong><div class="hint">${escapeHtml(host)}</div></td>
          <td><code>${tun.kind[0].toUpperCase()}:${tun.bindAddress}:${tun.localPort} → ${escapeHtml(dest)}</code></td>
          <td class="tmsg">${tun.message ? escapeHtml(tun.message) : ""}</td>
          <td class="tright">
            <button class="btn" data-toggle="${tun.id}">${tun.status === "running" ? t("stop") : t("start")}</button>
            <button class="btn" data-edit="${tun.id}">${t("edit")}</button>
            <button class="btn" data-del="${tun.id}">${t("delete")}</button>
          </td>
        </tr>`;
      })
      .join("");
  }
  document.getElementById("tun-add")!.onclick = () => openTunnelModal(null);
  tbl.querySelectorAll<HTMLElement>("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      await api.toggleTunnel(b.dataset.toggle!);
      state.tunnels = await api.listTunnels();
      renderMain();
    };
  });
  tbl.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const t = state.tunnels.find((x) => x.id === b.dataset.edit);
      if (t) openTunnelModal(t);
    };
  });
  tbl.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => {
    b.onclick = async () => {
      await api.deleteTunnel(b.dataset.del!);
      state.tunnels = await api.listTunnels();
      renderMain();
    };
  });
}

// --- Macros ---------------------------------------------------------------

function renderMacros(main: HTMLElement) {
  const rec = state.macroRecording;
  main.innerHTML = `
    <div class="view">
      <div class="view-head">
        <strong>${t("macros")}</strong>
        <span class="hint">${t("macroHint")}</span>
        <div class="spacer"></div>
        <button class="btn ${rec ? "rec-on" : ""}" id="mac-record">${rec ? t("stopRecording") : t("record")}</button>
        <button class="btn" id="mac-add">${t("addMacro")}</button>
      </div>
      <div class="mlist" id="mac-list"></div>
    </div>`;
  const list = document.getElementById("mac-list")!;
  if (!state.macros.length) {
    list.innerHTML = `<div class="hint" style="padding:16px">${t("noMacros")}</div>`;
  } else {
    list.innerHTML = state.macros
      .map((m) => `<div class="mrow">
        <div class="mname">${escapeHtml(m.name)} ${m.shortcut ? `<span class="hint">${escapeHtml(m.shortcut)}</span>` : ""}</div>
        <div class="msteps">${escapeHtml(m.steps.join("  ⏎  "))}</div>
        <div class="mactions">
          <button class="btn" data-run="${m.id}" ${state.terminals.size ? "" : "disabled"}>${t("runOnActive")}</button>
          <button class="btn" data-edit="${m.id}">${t("edit")}</button>
          <button class="btn" data-del="${m.id}">${t("delete")}</button>
        </div>
      </div>`)
      .join("");
  }
  document.getElementById("mac-record")!.onclick = () => {
    if (rec) {
      // Stop → save what we captured.
      const steps = state.macroRecording ?? [];
      state.macroRecording = null;
      const name = steps.length ? `macro-${state.macros.length + 1}` : "empty";
      const m: Macro = {
        id: `mac_${Math.random().toString(36).slice(2, 10)}`,
        name,
        steps,
        shortcut: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      void api.saveMacro(m).then(async () => {
        state.macros = await api.listMacros();
        renderMain();
      });
    } else {
      state.macroRecording = [];
      renderMain();
    }
  };
  document.getElementById("mac-add")!.onclick = () => openMacroModal(null);
  list.querySelectorAll<HTMLElement>("[data-run]").forEach((b) => {
    b.onclick = () => {
      if (state.activeTerm) void api.runMacro(b.dataset.run!, state.activeTerm);
    };
  });
  list.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const m = state.macros.find((x) => x.id === b.dataset.edit);
      if (m) openMacroModal(m);
    };
  });
  list.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => {
    b.onclick = async () => {
      await api.deleteMacro(b.dataset.del!);
      state.macros = await api.listMacros();
      renderMain();
    };
  });
}

// --- Network tools --------------------------------------------------------

function renderNetwork(main: HTMLElement) {
  main.innerHTML = `
    <div class="view">
      <div class="view-head">
        <strong>${t("networkTools")}</strong>
        <span class="hint">${t("networkHint")}</span>
      </div>
      <div class="netbar">
        <select id="net-tool">
          <option value="ping">${t("ping")}</option>
          <option value="portScan">${t("portScan")}</option>
          <option value="wakeOnLan">${t("wakeOnLan")}</option>
          <option value="dnsLookup">${t("dnsLookup")}</option>
          <option value="traceroute">${t("traceroute")}</option>
        </select>
        <input id="net-target" placeholder="${t("netTargetPlaceholder")}"/>
        <button class="btn primary" id="net-run" ${state.netRunning ? "disabled" : ""}>${t("run")}</button>
        <button class="btn" id="net-ai">${t("askAiAboutLast")}</button>
      </div>
      <div class="netlog" id="net-log"></div>
    </div>`;
  const log = document.getElementById("net-log")!;
  if (!state.netResults.length) {
    log.innerHTML = `<div class="hint" style="padding:16px">${t("noNetResults")}</div>`;
  } else {
    log.innerHTML = state.netResults
      .map(
        (r) => `<div class="netres ${r.ok ? "ok" : "err"}">
        <div class="nhead"><span class="badge ${r.ok ? "ok" : "error"}">${r.tool}</span> ${escapeHtml(r.target)} <span class="hint">${r.durationMs}ms</span></div>
        <pre>${escapeHtml(r.output)}</pre>
      </div>`,
      )
      .join("");
    log.scrollTop = log.scrollHeight;
  }
  document.getElementById("net-run")!.onclick = async () => {
    const tool = (document.getElementById("net-tool") as HTMLSelectElement).value as NetToolKind;
    const target = (document.getElementById("net-target") as HTMLInputElement).value.trim();
    if (!target) return;
    state.netRunning = true;
    renderMain();
    try {
      const r = await api.runNetTool(tool, target);
      state.netResults.push(r);
      if (state.netResults.length > 30) state.netResults.shift();
    } finally {
      state.netRunning = false;
      renderMain();
    }
  };
  (document.getElementById("net-target") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("net-run")!.click();
  });
  document.getElementById("net-ai")!.onclick = () => {
    const last = state.netResults[state.netResults.length - 1];
    if (!last) return;
    const ai = document.getElementById("ai-input") as HTMLTextAreaElement;
    ai.value = `analyze this ${last.tool} result for ${last.target}:\n${last.output}`;
    ai.focus();
  };
}

// --- Command history ------------------------------------------------------

function renderHistory(main: HTMLElement) {
  const filter = state.historyFilter.toLowerCase();
  const rows = state.history.filter((h) => !filter || h.command.toLowerCase().includes(filter));
  main.innerHTML = `
    <div class="view">
      <div class="view-head">
        <strong>${t("commandHistory")}</strong>
        <div class="spacer"></div>
        <input id="hist-filter" value="${escapeAttr(state.historyFilter)}" placeholder="${t("filter")}"/>
        <button class="btn" id="hist-clear">${t("clear")}</button>
      </div>
      <div class="hlist" id="hlist"></div>
    </div>`;
  const list = document.getElementById("hlist")!;
  if (!rows.length) {
    list.innerHTML = `<div class="hint" style="padding:16px">${t("noHistory")}</div>`;
  } else {
    list.innerHTML = rows
      .map((h) => {
        const host = state.profiles.find((p) => p.id === h.profileId)?.name ?? "—";
        const ec = h.exitCode === 0 ? "ok" : h.exitCode === null ? "" : "err";
        return `<div class="hrow" data-cmd="${escapeAttr(h.command)}">
          <span class="hec ${ec}">${h.exitCode ?? "?"}</span>
          <span class="hint">${escapeHtml(host)}</span>
          <code>${escapeHtml(h.command)}</code>
          <span class="hint">${new Date(h.createdAt).toLocaleTimeString()}</span>
        </div>`;
      })
      .join("");
    list.querySelectorAll<HTMLElement>(".hrow").forEach((r) => {
      r.onclick = () => {
        const v = state.terminals.get(state.activeTerm ?? "");
        if (v) {
          const bytes = Array.from(new TextEncoder().encode(r.dataset.cmd! + "\r"));
          void api.writeTerminal(v.termId, bytes);
        }
      };
    });
  }
  const f = document.getElementById("hist-filter") as HTMLInputElement;
  f.addEventListener("input", () => {
    state.historyFilter = f.value;
    renderMain();
    const nf = document.getElementById("hist-filter") as HTMLInputElement | null;
    if (nf) {
      nf.focus();
      nf.setSelectionRange(f.value.length, f.value.length);
    }
  });
  document.getElementById("hist-clear")!.onclick = async () => {
    await api.clearHistory();
    state.history = [];
    renderMain();
  };
}

// --- Terminal search overlay ---------------------------------------------

function openSearchOverlay(v: TermView) {
  if (document.getElementById("search-overlay")) return;
  const box = document.createElement("div");
  box.id = "search-overlay";
  box.className = "search-overlay";
  box.innerHTML = `<input id="search-input" placeholder="search scrollback (Enter=next, Shift+Enter=prev, Esc=close)"/>`;
  document.querySelector<HTMLElement>(".term-host")?.appendChild(box);
  const input = box.querySelector<HTMLInputElement>("#search-input")!;
  input.focus();
  let last = "";
  const find = (backwards: boolean) => {
    const q = input.value;
    if (!q) return;
    if (q !== last) {
      v.search.findNext(q);
      last = q;
    } else {
      backwards ? v.search.findPrevious(q) : v.search.findNext(q);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      find(e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      box.remove();
    }
  });
  input.addEventListener("input", () => {
    last = "";
    if (input.value) find(false);
  });
}

// --- modals ---------------------------------------------------------------

function openHostModal(existing: HostProfile | null) {
  const p: HostProfile =
    existing ?? {
      id: `h_${Math.random().toString(36).slice(2, 10)}`,
      name: "",
      host: "",
      port: 22,
      username: "",
      authKind: "password",
      keyPath: null,
      group: "Default",
      color: "#e0533d",
      saveSecret: false,
      initCommands: [],
      note: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal session-modal">
    <div class="session-title">Session settings</div>
    <div class="session-protocols">
      <div class="proto active" data-proto="ssh"><span class="proto-icon">⇌</span><span class="proto-label">SSH</span></div>
      <div class="proto" data-proto="telnet"><span class="proto-icon">⎔</span><span class="proto-label">Telnet</span></div>
      <div class="proto" data-proto="rsh"><span class="proto-icon">▣</span><span class="proto-label">Rsh</span></div>
      <div class="proto" data-proto="xdmcp"><span class="proto-icon">◈</span><span class="proto-label">Xdmcp</span></div>
      <div class="proto" data-proto="rdp"><span class="proto-icon">▨</span><span class="proto-label">RDP</span></div>
      <div class="proto" data-proto="vnc"><span class="proto-icon">⊞</span><span class="proto-label">VNC</span></div>
      <div class="proto" data-proto="ftp"><span class="proto-icon">↑↓</span><span class="proto-label">FTP</span></div>
      <div class="proto" data-proto="sftp"><span class="proto-icon">⇅</span><span class="proto-label">SFTP</span></div>
      <div class="proto" data-proto="serial"><span class="proto-icon">🔌</span><span class="proto-label">Serial</span></div>
      <div class="proto" data-proto="file"><span class="proto-icon">📄</span><span class="proto-label">File</span></div>
      <div class="proto" data-proto="shell"><span class="proto-icon">⌨</span><span class="proto-label">Shell</span></div>
      <div class="proto" data-proto="browser"><span class="proto-icon">🌐</span><span class="proto-label">Browser</span></div>
      <div class="proto" data-proto="mosh"><span class="proto-icon">ℳ</span><span class="proto-label">Mosh</span></div>
      <div class="proto" data-proto="aws-s3"><span class="proto-icon">☁</span><span class="proto-label">Aws S3</span></div>
      <div class="proto" data-proto="wsl"><span class="proto-icon">◫</span><span class="proto-label">WSL</span></div>
    </div>
    <div class="session-warning">
      Warning: you have reached the maximum number of saved sessions for the personal edition of MobaXterm.<br/>
      You can start a new session but it will not be automatically saved.<br/>
      Please support MobaXterm by subscribing to the Professional edition here: <a href="https://mobaxterm.mobatek.net" target="_blank">https://mobaxterm.mobatek.net</a>
    </div>
    <div class="session-config">
      <div class="session-config-head" id="proto-head">
        <span class="proto-icon-large">🖥</span>
        <span>Choose a session type…</span>
      </div>
      <div class="session-form">
        <div class="field"><label>Name</label><input id="m-name" value="${escapeAttr(p.name)}"/></div>
        <div class="field-row">
          <div class="field"><label>Host</label><input id="m-host" value="${escapeAttr(p.host)}" style="width:100%"/></div>
          <div class="field"><label>Port</label><input id="m-port" type="number" value="${p.port}" style="width:80px"/></div>
        </div>
        <div class="field"><label>Username</label><input id="m-user" value="${escapeAttr(p.username)}"/></div>
        <div class="field"><label>Authentication</label><select id="m-auth">
          <option value="password" ${p.authKind === "password" ? "selected" : ""}>Password</option>
          <option value="key" ${p.authKind === "key" ? "selected" : ""}>Key file</option>
          <option value="agent" ${p.authKind === "agent" ? "selected" : ""}>SSH agent</option>
        </select></div>
        <div class="field" id="m-keypath-field"><label>Key path (if key auth)</label><input id="m-keypath" value="${escapeAttr(p.keyPath ?? "")}"/></div>
        <div class="field-row">
          <div class="field"><label>Group</label><input id="m-group" value="${escapeAttr(p.group ?? "")}" style="width:100%"/></div>
          <div class="field"><label>Color</label><input id="m-color" type="color" value="${p.color ?? "#e0533d"}" style="width:48px;height:26px"/></div>
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="primary" id="m-save">✓ OK</button>
      <button id="m-cancel">✕ Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);

  // Protocol switching
  const protoIcons: Record<string, string> = {
    ssh: "⇌", telnet: "⎔", rsh: "▣", xdmcp: "◈", rdp: "▨", vnc: "⊞",
    ftp: "↑↓", sftp: "⇅", serial: "🔌", file: "📄", shell: "⌨",
    browser: "🌐", mosh: "ℳ", "aws-s3": "☁", wsl: "◫",
  };
  const protoLabels: Record<string, string> = {
    ssh: "SSH", telnet: "Telnet", rsh: "Rsh", xdmcp: "Xdmcp", rdp: "RDP", vnc: "VNC",
    ftp: "FTP", sftp: "SFTP", serial: "Serial", file: "File", shell: "Shell",
    browser: "Browser", mosh: "Mosh", "aws-s3": "Aws S3", wsl: "WSL",
  };
  backdrop.querySelectorAll<HTMLElement>(".proto").forEach((el) => {
    el.onclick = () => {
      backdrop.querySelectorAll<HTMLElement>(".proto").forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
      const proto = el.dataset.proto!;
      const icon = protoIcons[proto] ?? "⇌";
      const label = protoLabels[proto] ?? proto;
      const head = backdrop.querySelector<HTMLElement>("#proto-head");
      if (head) {
        head.innerHTML = `<span class="proto-icon-large">${icon}</span><span>${label}</span>`;
      }
      // Adjust port default
      const portInput = backdrop.querySelector<HTMLInputElement>("#m-port");
      if (portInput) {
        const defaults: Record<string, number> = { ssh: 22, telnet: 23, ftp: 21, sftp: 22, rdp: 3389, vnc: 5900, mosh: 60000 };
        if (defaults[proto]) portInput.value = String(defaults[proto]);
      }
    };
  });

  backdrop.onclick = (e) => {
    if (e.target === backdrop) backdrop.remove();
  };
  backdrop.querySelector<HTMLButtonElement>("#m-cancel")!.onclick = () => backdrop.remove();
  backdrop.querySelector<HTMLButtonElement>("#m-save")!.onclick = async () => {
    const updated: HostProfile = {
      ...p,
      name: val(backdrop, "#m-name"),
      host: val(backdrop, "#m-host"),
      port: parseInt(val(backdrop, "#m-port") || "22", 10),
      username: val(backdrop, "#m-user"),
      authKind: val(backdrop, "#m-auth") as any,
      keyPath: val(backdrop, "#m-keypath") || null,
      group: val(backdrop, "#m-group") || "Default",
      color: val(backdrop, "#m-color"),
      updatedAt: Date.now(),
    };
    await api.saveProfile(updated);
    state.profiles = await api.listProfiles();
    renderTree();
    backdrop.remove();
  };
}

function openSettingsModal() {
  if (!state.settings) return;
  const s = state.settings;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal">
    <h3>${t("settingsTitle")}</h3>
    <div class="field"><label>${t("language")}</label><select id="s-locale">
      <option value="en" ${s.locale === "en" ? "selected" : ""}>${t("english")}</option>
      <option value="zh" ${s.locale === "zh" ? "selected" : ""}>${t("chinese")}</option>
    </select></div>
    <div class="field"><label>${t("engine")}</label><select id="s-engine">
      <option value="mock" ${s.engine === "mock" ? "selected" : ""}>Mock (offline rule engine)</option>
      <option value="dsh" ${s.engine === "dsh" ? "selected" : ""}>DeepSeek Harness (dsh sidecar)</option>
      <option value="deepseekDirect" ${s.engine === "deepseekDirect" ? "selected" : ""}>DeepSeek Direct API</option>
    </select></div>
    <div class="field"><label>${t("model")}</label><input id="s-model" value="${escapeAttr(s.model)}"/></div>
    <div class="field"><label>${t("baseUrl")}</label><input id="s-base" value="${escapeAttr(s.baseUrl)}" placeholder="https://api.deepseek.com/v1"/></div>
    <div class="field"><label>${t("approvalPolicy")}</label><select id="s-policy">
      <option value="askAlways" ${s.approvalPolicy === "askAlways" ? "selected" : ""}>Ask always</option>
      <option value="autoSafe" ${s.approvalPolicy === "autoSafe" ? "selected" : ""}>Auto safe, ask caution</option>
      <option value="autoCaution" ${s.approvalPolicy === "autoCaution" ? "selected" : ""}>Auto safe+caution, ask dangerous</option>
      <option value="yolo" ${s.approvalPolicy === "yolo" ? "selected" : ""}>YOLO (run all, gate dangerous)</option>
    </select></div>
    <div class="field checkbox"><label><input type="checkbox" id="s-allow-dangerous" ${s.allowDangerous ? "checked" : ""}/> ${t("allowDangerous")}</label></div>
    <div class="field"><label>${t("approvalTimeout")}</label><input id="s-timeout" type="number" value="${s.approvalTimeoutSecs}"/></div>
    <div class="field checkbox"><label><input type="checkbox" id="s-strict" ${s.strictHostKeyChecking ? "checked" : ""}/> ${t("strictHostKey")}</label></div>
    <div class="field"><label>${t("terminalFontSize")}</label><input id="s-fontsize" type="number" value="${s.fontSize}"/></div>
    <div class="actions">
      <button id="s-cancel">${t("cancel")}</button>
      <button class="primary" id="s-save">${t("save")}</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => {
    if (e.target === backdrop) backdrop.remove();
  };
  backdrop.querySelector<HTMLButtonElement>("#s-cancel")!.onclick = () => backdrop.remove();
  backdrop.querySelector<HTMLButtonElement>("#s-save")!.onclick = async () => {
    const updated: Settings = {
      ...s,
      locale: val(backdrop, "#s-locale") as Locale,
      engine: val(backdrop, "#s-engine") as any,
      model: val(backdrop, "#s-model"),
      baseUrl: val(backdrop, "#s-base"),
      approvalPolicy: val(backdrop, "#s-policy") as any,
      allowDangerous: !!(backdrop.querySelector("#s-allow-dangerous") as HTMLInputElement).checked,
      approvalTimeoutSecs: parseInt(val(backdrop, "#s-timeout") || "30", 10),
      strictHostKeyChecking: !!(backdrop.querySelector("#s-strict") as HTMLInputElement).checked,
      fontSize: parseInt(val(backdrop, "#s-fontsize") || "13", 10),
    };
    await api.saveSettings(updated);
    state.settings = updated;
    setLocale(updated.locale);
    backdrop.remove();
    renderTopbar();
  };
}

// --- Tunnel / Macro modals ------------------------------------------------

function openTunnelModal(existing: Tunnel | null) {
  const tun: Tunnel =
    existing ?? {
      id: "",
      name: "",
      profileId: state.profiles[0]?.id ?? "",
      kind: "local",
      bindAddress: "127.0.0.1",
      localPort: 8080,
      remoteHost: "127.0.0.1",
      remotePort: 80,
      status: "stopped",
      message: null,
      createdAt: Date.now(),
    };
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal">
    <h3>${existing ? t("editTunnel") : t("newTunnel")}</h3>
    <div class="field"><label>${t("tunnelName")}</label><input id="t-name" value="${escapeAttr(tun.name)}"/></div>
    <div class="field"><label>${t("sftpHost")}</label><select id="t-host">${state.profiles
      .map((p) => `<option value="${p.id}" ${p.id === tun.profileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
      .join("")}</select></div>
    <div class="field"><label>${t("tunnelKind")}</label><select id="t-kind">
      <option value="local" ${tun.kind === "local" ? "selected" : ""}>${t("localL")}</option>
      <option value="remote" ${tun.kind === "remote" ? "selected" : ""}>${t("remoteR")}</option>
      <option value="dynamic" ${tun.kind === "dynamic" ? "selected" : ""}>${t("dynamicD")}</option>
    </select></div>
    <div class="field"><label>${t("bindAddress")}</label><input id="t-bind" value="${escapeAttr(tun.bindAddress)}"/></div>
    <div class="field"><label>${t("localPort")}</label><input id="t-lport" type="number" value="${tun.localPort}"/></div>
    <div class="field" id="t-remote-field"><label>${t("remoteHostPort")}</label>
      <div style="display:flex;gap:6px"><input id="t-rhost" value="${escapeAttr(tun.remoteHost)}"/><input id="t-rport" type="number" value="${tun.remotePort}"/></div>
    </div>
    <div class="actions">
      <button id="t-cancel">${t("cancel")}</button>
      <button class="primary" id="t-save">${t("save")}</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  const toggleRemote = () => {
    const k = val(backdrop, "#t-kind");
    const f = backdrop.querySelector("#t-remote-field") as HTMLElement;
    f.style.opacity = k === "dynamic" ? "0.4" : "1";
    (backdrop.querySelector("#t-rhost") as HTMLInputElement).disabled = k === "dynamic";
    (backdrop.querySelector("#t-rport") as HTMLInputElement).disabled = k === "dynamic";
  };
  toggleRemote();
  (backdrop.querySelector("#t-kind") as HTMLSelectElement).onchange = toggleRemote;
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  (backdrop.querySelector<HTMLButtonElement>("#t-cancel"))!.onclick = () => backdrop.remove();
  (backdrop.querySelector<HTMLButtonElement>("#t-save"))!.onclick = async () => {
    const updated: Tunnel = {
      ...tun,
      name: val(backdrop, "#t-name"),
      profileId: val(backdrop, "#t-host"),
      kind: val(backdrop, "#t-kind") as Tunnel["kind"],
      bindAddress: val(backdrop, "#t-bind"),
      localPort: parseInt(val(backdrop, "#t-lport") || "0", 10),
      remoteHost: val(backdrop, "#t-rhost"),
      remotePort: parseInt(val(backdrop, "#t-rport") || "0", 10),
      status: tun.status || "stopped",
    };
    await api.saveTunnel(updated);
    state.tunnels = await api.listTunnels();
    backdrop.remove();
    renderMain();
  };
}

function openMacroModal(existing: Macro | null) {
  const m: Macro =
    existing ?? {
      id: "",
      name: "",
      steps: [""],
      shortcut: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal">
    <h3>${existing ? t("editMacro") : t("newMacro")}</h3>
    <div class="field"><label>${t("tunnelName")}</label><input id="m-name" value="${escapeAttr(m.name)}"/></div>
    <div class="field"><label>${t("macroSteps")}</label>
      <textarea id="m-steps" style="min-height:120px;font-family:var(--mono)">${escapeHtml(m.steps.join("\n"))}</textarea>
    </div>
    <div class="field"><label>${t("macroShortcut")}</label><input id="m-shortcut" value="${escapeAttr(m.shortcut ?? "")}"/></div>
    <div class="actions">
      <button id="m-cancel">${t("cancel")}</button>
      <button class="primary" id="m-save">${t("save")}</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };
  (backdrop.querySelector<HTMLButtonElement>("#m-cancel"))!.onclick = () => backdrop.remove();
  (backdrop.querySelector<HTMLButtonElement>("#m-save"))!.onclick = async () => {
    const raw = val(backdrop, "#m-steps");
    const steps = raw.split("\n").map((s) => s.replace(/\\n/g, "\n"));
    const updated: Macro = {
      ...m,
      name: val(backdrop, "#m-name"),
      steps,
      shortcut: val(backdrop, "#m-shortcut") || null,
      updatedAt: Date.now(),
    };
    await api.saveMacro(updated);
    state.macros = await api.listMacros();
    backdrop.remove();
    renderMain();
  };
}

// --- helpers --------------------------------------------------------------

function profileColor(profileId: string): string {
  return state.profiles.find((p) => p.id === profileId)?.color ?? "#8a96a6";
}
function val(scope: ParentNode, sel: string): string {
  return (scope.querySelector(sel) as HTMLInputElement)?.value ?? "";
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
