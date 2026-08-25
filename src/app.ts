import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
} from "./ipc/contract";

interface TermView {
  termId: string;
  profileId: string;
  title: string;
  status: TerminalStatus;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
}

interface AppState {
  profiles: HostProfile[];
  terminals: Map<string, TermView>;
  activeTerm: string | null;
  sessions: AiSession[];
  activeSession: string | null;
  settings: Settings | null;
  engine: EngineStatus | null;
  approvals: Map<string, ApprovalRequest>;
}

const state: AppState = {
  profiles: [],
  terminals: new Map(),
  activeTerm: null,
  sessions: [],
  activeSession: null,
  settings: null,
  engine: null,
  approvals: new Map(),
};

export function mount(root: HTMLElement) {
  root.classList.add("app");
  root.innerHTML = `
    <div class="topbar">
      <div class="logo">OpsPilot<span>AI SSH Ops Console</span></div>
      <div class="spacer"></div>
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
        <textarea id="ai-input" placeholder="Ask the copilot… e.g. 'check disk space on web-01'"></textarea>
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
    const [profiles, settings, engine, sessions] = await Promise.all([
      api.listProfiles(),
      api.getSettings(),
      api.engineStatus(),
      api.aiListSessions(),
    ]);
    state.profiles = profiles;
    state.settings = settings;
    state.engine = engine;
    state.sessions = sessions;
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
  if (state.terminals.size === 0) {
    main.innerHTML = `<div class="empty">
      <div style="font-size:32px">⌨</div>
      <div>Select a host on the left to open a terminal</div>
      <div style="font-size:11px">AI Copilot is on the right →</div>
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
  term.loadAddon(fit);
  term.onData((data) => {
    const bytes = Array.from(new TextEncoder().encode(data));
    void api.writeTerminal(info.termId, bytes);
  });
  const view: TermView = {
    termId: info.termId,
    profileId,
    title: state.profiles.find((p) => p.id === profileId)?.name ?? "host",
    status: info.status,
    term,
    fit,
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
