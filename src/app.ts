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
} from "./ipc/contract";

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
    <div class="topbar">
      <div class="logo">OpsPilot<span>AI MobaX</span></div>
      <div class="viewswitch" id="viewswitch">
        <button class="vs active" data-view="terminals" title="Terminals">⌨ Terminals</button>
        <button class="vs" data-view="sftp" title="SFTP file browser">📁 SFTP</button>
        <button class="vs" data-view="tunnels" title="SSH tunnels">🚇 Tunnels</button>
        <button class="vs" data-view="macros" title="Macros">⏺ Macros</button>
        <button class="vs" data-view="network" title="Network tools">🛰 Network</button>
        <button class="vs" data-view="history" title="Command history">🕘 History</button>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="broadcast-btn" title="Multi-exec: type once, run on every terminal">⇶ Multi-exec: off</button>
      <div class="engine" id="engine-badge">engine: …</div>
      <button class="btn" id="settings-btn">⚙ Settings</button>
    </div>
    <div class="sidebar">
      <div class="head"><span>Connections</span><button class="btn" id="add-host">+ Host</button></div>
      <div class="tree" id="tree"></div>
    </div>
    <div class="main" id="main"></div>
    <div class="aipanel">
      <div class="head"><span>AI Copilot</span><button class="btn" id="new-session">+ Session</button></div>
      <div class="messages" id="messages"></div>
      <div class="composer">
        <textarea id="ai-input" placeholder="Ask the copilot… e.g. 'check disk space', 'ping 10.0.0.11', 'port scan web-01'"></textarea>
        <div class="row">
          <span class="hint" id="ai-hint">${hasTauri ? "connected to native shell" : "browser preview (mock backend)"}</span>
          <button class="send" id="ai-send">Send</button>
        </div>
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
    renderEngine();
    renderTree();
    renderMain();
    renderMessages();
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
  document.getElementById("settings-btn")!.onclick = () => openSettingsModal();
  document.getElementById("new-session")!.onclick = async () => {
    const res = await api.aiNewSession(state.activeTerm ?? null);
    state.activeSession = res.sessionId;
    state.sessions = await api.aiListSessions();
    renderMessages();
  };
  const input = document.getElementById("ai-input") as HTMLTextAreaElement;
  document.getElementById("ai-send")!.onclick = () => sendAi();
  input.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendAi();
    }
  });

  // View switcher (topbar).
  document.getElementById("viewswitch")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
    if (!btn) return;
    switchView(btn.dataset.view as MainView);
  });

  // Multi-execution toggle.
  document.getElementById("broadcast-btn")!.onclick = () => {
    state.broadcast = !state.broadcast;
    const b = document.getElementById("broadcast-btn")!;
    b.textContent = `⇶ Multi-exec: ${state.broadcast ? "on" : "off"}`;
    b.classList.toggle("on", state.broadcast);
  };

  // Global shortcuts: Ctrl+Shift+F search-in-terminal, Ctrl+Shift+R history.
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

function switchView(view: MainView) {
  state.view = view;
  document.querySelectorAll<HTMLElement>("#viewswitch .vs").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  // Load data lazily for the chosen view.
  void (async () => {
    if (view === "tunnels") state.tunnels = await api.listTunnels();
    if (view === "macros") state.macros = await api.listMacros();
    if (view === "history") state.history = await api.listHistory(null, 200);
    if (view === "sftp" && !state.sftpProfileId && state.profiles[0]) {
      state.sftpProfileId = state.profiles[0].id;
      await loadSftp();
    }
    renderMain();
    // Re-fit terminal when returning to it.
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
  const badge = document.getElementById("engine-badge")!;
  if (!state.engine) return;
  badge.textContent = `engine: ${state.engine.kind} ${state.engine.ready ? "✓" : "✗"}`;
  badge.className = `engine ${state.engine.ready ? "ready" : ""}`;
}

function renderTree() {
  const tree = document.getElementById("tree")!;
  const groups = new Map<string, HostProfile[]>();
  for (const p of state.profiles) {
    const g = p.group ?? "Ungrouped";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }
  let html = "";
  for (const [g, list] of groups) {
    html += `<div class="group">${escapeHtml(g)}</div>`;
    for (const p of list) {
      const color = p.color ?? "#8a96a6";
      html += `<div class="host" data-id="${p.id}">
        <span class="dot" style="background:${color}"></span>
        <div>
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="meta">${escapeHtml(p.username)}@${escapeHtml(p.host)}:${p.port}</div>
        </div>
        <button class="del" data-del="${p.id}" title="Delete">×</button>
      </div>`;
    }
  }
  if (!state.profiles.length) {
    html = `<div class="empty" style="padding:20px;color:var(--text-dim)">No hosts yet. Click “+ Host”.</div>`;
  }
  tree.innerHTML = html;

  tree.querySelectorAll<HTMLElement>(".host").forEach((el) => {
    const id = el.dataset.id!;
    el.onclick = (e) => {
      if ((e.target as HTMLElement).dataset.del) return;
      void connectHost(id);
    };
  });
  tree.querySelectorAll<HTMLElement>("[data-del]").forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const id = (e.target as HTMLElement).dataset.del!;
      await api.deleteProfile(id);
      state.profiles = await api.listProfiles();
      renderTree();
    };
  });
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
      <div style="font-size:32px">⌨</div>
      <div>Select a host on the left to open a terminal</div>
      <div style="font-size:11px">AI Copilot is on the right →  ·  Ctrl+Shift+F to search scrollback</div>
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
    fontFamily: state.settings?.fontFamily ?? "monospace",
    fontSize: state.settings?.fontSize ?? 13,
    theme: {
      background: "#000000",
      foreground: "#d7dde5",
      cursor: "#e0533d",
    },
    cursorBlink: true,
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
      <button class="allow" data-approve="${req.requestId}" data-decision="allow">Allow</button>
      <button class="allow" data-approve="${req.requestId}" data-decision="alwaysAllow">Always</button>
      <button class="deny" data-approve="${req.requestId}" data-decision="deny">Deny</button>
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
        <button class="btn" id="sftp-go">Go</button>
        <button class="btn" id="sftp-up">↑ Up</button>
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
    grid.innerHTML = `<div class="hint" style="padding:16px">empty directory</div>`;
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

// --- Tunnels --------------------------------------------------------------

function renderTunnels(main: HTMLElement) {
  main.innerHTML = `
    <div class="view">
      <div class="view-head">
        <strong>SSH Tunnels</strong>
        <span class="hint">local (L) · remote (R) · dynamic SOCKS (D)</span>
        <div class="spacer"></div>
        <button class="btn" id="tun-add">+ Tunnel</button>
      </div>
      <table class="ttable" id="tun-table"></table>
    </div>`;
  const tbl = document.getElementById("tun-table")!;
  if (!state.tunnels.length) {
    tbl.innerHTML = `<tr><td class="hint" style="padding:16px">No tunnels. Click “+ Tunnel”.</td></tr>`;
  } else {
    tbl.innerHTML = state.tunnels
      .map((t) => {
        const host = state.profiles.find((p) => p.id === t.profileId)?.name ?? t.profileId;
        const dest = t.kind === "dynamic" ? "SOCKS" : `${t.remoteHost}:${t.remotePort}`;
        return `<tr>
          <td><span class="badge ${t.status}">${t.status}</span></td>
          <td><strong>${escapeHtml(t.name)}</strong><div class="hint">${escapeHtml(host)}</div></td>
          <td><code>${t.kind[0].toUpperCase()}:${t.bindAddress}:${t.localPort} → ${escapeHtml(dest)}</code></td>
          <td class="tmsg">${t.message ? escapeHtml(t.message) : ""}</td>
          <td class="tright">
            <button class="btn" data-toggle="${t.id}">${t.status === "running" ? "Stop" : "Start"}</button>
            <button class="btn" data-edit="${t.id}">Edit</button>
            <button class="btn" data-del="${t.id}">×</button>
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
        <strong>Macros</strong>
        <span class="hint">record keystrokes → replay on any terminal</span>
        <div class="spacer"></div>
        <button class="btn ${rec ? "rec-on" : ""}" id="mac-record">${rec ? "⏹ Stop recording" : "⏺ Record"}</button>
        <button class="btn" id="mac-add">+ Macro</button>
      </div>
      <div class="mlist" id="mac-list"></div>
    </div>`;
  const list = document.getElementById("mac-list")!;
  if (!state.macros.length) {
    list.innerHTML = `<div class="hint" style="padding:16px">No macros. Record one or add manually.</div>`;
  } else {
    list.innerHTML = state.macros
      .map((m) => `<div class="mrow">
        <div class="mname">${escapeHtml(m.name)} ${m.shortcut ? `<span class="hint">${escapeHtml(m.shortcut)}</span>` : ""}</div>
        <div class="msteps">${escapeHtml(m.steps.join("  ⏎  "))}</div>
        <div class="mactions">
          <button class="btn" data-run="${m.id}" ${state.terminals.size ? "" : "disabled"}>▶ Run on active</button>
          <button class="btn" data-edit="${m.id}">Edit</button>
          <button class="btn" data-del="${m.id}">×</button>
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
        <strong>Network Tools</strong>
        <span class="hint">also drivable by the AI copilot →</span>
      </div>
      <div class="netbar">
        <select id="net-tool">
          <option value="ping">ping</option>
          <option value="portScan">port scan</option>
          <option value="wakeOnLan">wake-on-LAN</option>
          <option value="dnsLookup">DNS lookup</option>
          <option value="traceroute">traceroute</option>
        </select>
        <input id="net-target" placeholder="10.0.0.11  ·  web-01  ·  00:11:22:33:44:55"/>
        <button class="btn primary" id="net-run" ${state.netRunning ? "disabled" : ""}>Run</button>
        <button class="btn" id="net-ai">↳ Ask AI about last result</button>
      </div>
      <div class="netlog" id="net-log"></div>
    </div>`;
  const log = document.getElementById("net-log")!;
  if (!state.netResults.length) {
    log.innerHTML = `<div class="hint" style="padding:16px">Run a tool, or just ask the copilot: “ping 10.0.0.11”.</div>`;
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
        <strong>Command History</strong>
        <div class="spacer"></div>
        <input id="hist-filter" value="${escapeAttr(state.historyFilter)}" placeholder="filter…"/>
        <button class="btn" id="hist-clear">Clear</button>
      </div>
      <div class="hlist" id="hlist"></div>
    </div>`;
  const list = document.getElementById("hlist")!;
  if (!rows.length) {
    list.innerHTML = `<div class="hint" style="padding:16px">No history yet. Run commands in a terminal.</div>`;
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
  backdrop.innerHTML = `<div class="modal">
    <h3>${existing ? "Edit Host" : "New Host"}</h3>
    <div class="field"><label>Name</label><input id="m-name" value="${escapeAttr(p.name)}"/></div>
    <div class="field"><label>Host</label><input id="m-host" value="${escapeAttr(p.host)}"/></div>
    <div class="field"><label>Port</label><input id="m-port" type="number" value="${p.port}"/></div>
    <div class="field"><label>Username</label><input id="m-user" value="${escapeAttr(p.username)}"/></div>
    <div class="field"><label>Auth</label><select id="m-auth">
      <option value="password" ${p.authKind === "password" ? "selected" : ""}>Password</option>
      <option value="key" ${p.authKind === "key" ? "selected" : ""}>Key file</option>
      <option value="agent" ${p.authKind === "agent" ? "selected" : ""}>SSH agent</option>
    </select></div>
    <div class="field" id="m-keypath-field"><label>Key path (if key auth)</label><input id="m-keypath" value="${escapeAttr(p.keyPath ?? "")}"/></div>
    <div class="field"><label>Group</label><input id="m-group" value="${escapeAttr(p.group ?? "")}"/></div>
    <div class="field"><label>Color</label><input id="m-color" type="color" value="${p.color ?? "#e0533d"}" style="height:32px"/></div>
    <div class="actions">
      <button id="m-cancel">Cancel</button>
      <button class="primary" id="m-save">Save</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);

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
    <h3>Settings</h3>
    <div class="field"><label>AI Engine</label><select id="s-engine">
      <option value="mock" ${s.engine === "mock" ? "selected" : ""}>Mock (offline rule engine)</option>
      <option value="dsh" ${s.engine === "dsh" ? "selected" : ""}>DeepSeek Harness (dsh sidecar)</option>
      <option value="deepseekDirect" ${s.engine === "deepseekDirect" ? "selected" : ""}>DeepSeek Direct API</option>
    </select></div>
    <div class="field"><label>Model</label><input id="s-model" value="${escapeAttr(s.model)}"/></div>
    <div class="field"><label>Base URL</label><input id="s-base" value="${escapeAttr(s.baseUrl)}" placeholder="https://api.deepseek.com/v1"/></div>
    <div class="field"><label>Approval Policy</label><select id="s-policy">
      <option value="askAlways" ${s.approvalPolicy === "askAlways" ? "selected" : ""}>Ask always</option>
      <option value="autoSafe" ${s.approvalPolicy === "autoSafe" ? "selected" : ""}>Auto safe, ask caution</option>
      <option value="autoCaution" ${s.approvalPolicy === "autoCaution" ? "selected" : ""}>Auto safe+caution, ask dangerous</option>
      <option value="yolo" ${s.approvalPolicy === "yolo" ? "selected" : ""}>YOLO (run all, gate dangerous)</option>
    </select></div>
    <div class="field checkbox"><label><input type="checkbox" id="s-allow-dangerous" ${s.allowDangerous ? "checked" : ""}/> Allow dangerous after approval</label></div>
    <div class="field"><label>Approval timeout (s)</label><input id="s-timeout" type="number" value="${s.approvalTimeoutSecs}"/></div>
    <div class="field checkbox"><label><input type="checkbox" id="s-strict" ${s.strictHostKeyChecking ? "checked" : ""}/> Strict host key checking</label></div>
    <div class="field"><label>Font size</label><input id="s-fontsize" type="number" value="${s.fontSize}"/></div>
    <div class="actions">
      <button id="s-cancel">Cancel</button>
      <button class="primary" id="s-save">Save</button>
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
    backdrop.remove();
  };
}

// --- Tunnel / Macro modals ------------------------------------------------

function openTunnelModal(existing: Tunnel | null) {
  const t: Tunnel =
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
    <h3>${existing ? "Edit Tunnel" : "New Tunnel"}</h3>
    <div class="field"><label>Name</label><input id="t-name" value="${escapeAttr(t.name)}"/></div>
    <div class="field"><label>Host</label><select id="t-host">${state.profiles
      .map((p) => `<option value="${p.id}" ${p.id === t.profileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
      .join("")}</select></div>
    <div class="field"><label>Kind</label><select id="t-kind">
      <option value="local" ${t.kind === "local" ? "selected" : ""}>Local (L)</option>
      <option value="remote" ${t.kind === "remote" ? "selected" : ""}>Remote (R)</option>
      <option value="dynamic" ${t.kind === "dynamic" ? "selected" : ""}>Dynamic SOCKS (D)</option>
    </select></div>
    <div class="field"><label>Bind address</label><input id="t-bind" value="${escapeAttr(t.bindAddress)}"/></div>
    <div class="field"><label>Local port</label><input id="t-lport" type="number" value="${t.localPort}"/></div>
    <div class="field" id="t-remote-field"><label>Remote host:port</label>
      <div style="display:flex;gap:6px"><input id="t-rhost" value="${escapeAttr(t.remoteHost)}"/><input id="t-rport" type="number" value="${t.remotePort}"/></div>
    </div>
    <div class="actions">
      <button id="t-cancel">Cancel</button>
      <button class="primary" id="t-save">Save</button>
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
      ...t,
      name: val(backdrop, "#t-name"),
      profileId: val(backdrop, "#t-host"),
      kind: val(backdrop, "#t-kind") as Tunnel["kind"],
      bindAddress: val(backdrop, "#t-bind"),
      localPort: parseInt(val(backdrop, "#t-lport") || "0", 10),
      remoteHost: val(backdrop, "#t-rhost"),
      remotePort: parseInt(val(backdrop, "#t-rport") || "0", 10),
      status: t.status || "stopped",
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
    <h3>${existing ? "Edit Macro" : "New Macro"}</h3>
    <div class="field"><label>Name</label><input id="m-name" value="${escapeAttr(m.name)}"/></div>
    <div class="field"><label>Steps (one keystroke block per line; \\n is Enter)</label>
      <textarea id="m-steps" style="min-height:120px;font-family:var(--mono)">${escapeHtml(m.steps.join("\n"))}</textarea>
    </div>
    <div class="field"><label>Shortcut (optional, e.g. Ctrl+Shift+1)</label><input id="m-shortcut" value="${escapeAttr(m.shortcut ?? "")}"/></div>
    <div class="actions">
      <button id="m-cancel">Cancel</button>
      <button class="primary" id="m-save">Save</button>
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
