/**
 * In-browser mock backend.
 *
 * Mirrors the Rust `opspilot_lib` command surface so the UI runs without the
 * native shell.  Keeps everything in module-local state.  The terminal
 * simulation reuses the same canned command set as `ssh_mock.rs`; the AI
 * copilot is a deterministic rule engine (no network) that decides which
 * SSH tool to call, raises an approval request for risky commands, and writes
 * a short analysis of the returned output.
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  AiMessage,
  AiSessionDetail,
  EngineStatus,
  HistoryEntry,
  HostFacts,
  HostProfile,
  Macro,
  McpInfo,
  NetToolKind,
  NetToolResult,
  Settings,
  SftpDownloadInfo,
  SftpEntry,
  SftpListing,
  Tunnel,
  TunnelStatus,
} from "./contract";
import { CMD, EVT } from "./contract";

// --- event bus ------------------------------------------------------------

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

// Mirrors src/ipc/client.ts; the mock backend is only reached when the real
// Tauri shell is not present, but we keep the flag so SFTP/tunnel messages
// can read naturally in both contexts.
const hasTauri =
  typeof window !== "undefined" &&
  // @ts-expect-error - injected by the Tauri runtime
  (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined);

function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((h) => h(payload));
}

export function mockListen<T>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const h = handler as Handler;
  set.add(h);
  return () => set!.delete(h);
}

// --- persistent-ish state -------------------------------------------------

const profiles = new Map<string, HostProfile>();
const terminals = new Map<
  string,
  { tx: (bytes: number[]) => void; closed: boolean }
>();
const sessions = new Map<string, AiSessionDetail>();
const approvals = new Map<string, ApprovalRequest>();
const tunnels = new Map<string, Tunnel>();
const macros = new Map<string, Macro>();
const history: HistoryEntry[] = [];
const broadcastSubscribers = new Set<string>();

let settings: Settings = {
  engine: "mock",
  model: "mock-rule-engine",
  baseUrl: "",
  approvalPolicy: "autoSafe",
  allowDangerous: false,
  approvalTimeoutSecs: 30,
  strictHostKeyChecking: false,
  fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
  fontSize: 13,
  theme: "dark",
  dshPath: null,
  maxOutputBytes: 8000,
};

const mcpInfo: McpInfo = {
  url: "http://127.0.0.1:0/mock (browser preview — real MCP runs inside the Tauri shell)",
  token: "mock-token",
  toolCount: 6,
};

// Seed a couple of demo hosts so the sidebar is not empty on first load.
function seed() {
  if (profiles.size > 0) return;
  const now = Date.now();
  const demo: HostProfile[] = [
    {
      id: "demo-web-01",
      name: "web-01",
      host: "10.0.0.11",
      port: 22,
      username: "ops",
      authKind: "password",
      keyPath: null,
      group: "Production",
      color: "#e0533d",
      saveSecret: false,
      initCommands: [],
      note: "Nginx + Node 前端机",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "demo-db-01",
      name: "db-01",
      host: "10.0.0.21",
      port: 22,
      username: "ops",
      authKind: "key",
      keyPath: "~/.ssh/id_ed25519",
      group: "Production",
      color: "#3da5e0",
      saveSecret: false,
      initCommands: [],
      note: "PostgreSQL 主库",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "demo-jump",
      name: "jump",
      host: "jump.example.com",
      port: 2222,
      username: "admin",
      authKind: "password",
      keyPath: null,
      group: "Bastion",
      color: "#7bd66b",
      saveSecret: false,
      initCommands: [],
      note: "跳板机",
      createdAt: now,
      updatedAt: now,
    },
  ];
  demo.forEach((p) => profiles.set(p.id, p));

  // Seed a couple of demo tunnels + macros so the new views aren't empty.
  if (tunnels.size === 0) {
    const t0: Tunnel = {
      id: "tun_db",
      name: "pg → local",
      profileId: "demo-db-01",
      kind: "local",
      bindAddress: "127.0.0.1",
      localPort: 5432,
      remoteHost: "127.0.0.1",
      remotePort: 5432,
      status: "stopped",
      message: null,
      createdAt: now,
    };
    const t1: Tunnel = {
      id: "tun_web",
      name: "web socks",
      profileId: "demo-web-01",
      kind: "dynamic",
      bindAddress: "127.0.0.1",
      localPort: 1080,
      remoteHost: "",
      remotePort: 0,
      status: "stopped",
      message: null,
      createdAt: now,
    };
    tunnels.set(t0.id, t0);
    tunnels.set(t1.id, t1);
  }
  if (macros.size === 0) {
    const m0: Macro = {
      id: "mac_tail",
      name: "tail app logs",
      steps: ["tail -f /var/log/app.log\n"],
      shortcut: "Ctrl+Shift+1",
      createdAt: now,
      updatedAt: now,
    };
    const m1: Macro = {
      id: "mac_top",
      name: "docker ps + top",
      steps: ["docker ps\n", "docker stats --no-stream\n"],
      shortcut: null,
      createdAt: now,
      updatedAt: now,
    };
    macros.set(m0.id, m0);
    macros.set(m1.id, m1);
  }
}

export function initMock() {
  seed();
}

// --- SFTP mock filesystem -------------------------------------------------

/** A tiny simulated per-host tree so the SFTP browser is demoable offline. */
function mockFs(profileId: string, dir: string): SftpEntry[] {
  const host = profiles.get(profileId)?.name ?? "host";
  void host;
  const norm = dir.replace(/\/+$/, "") || "/";
  const e = (name: string, kind: SftpEntry["kind"], size: number, mode = "0644"): SftpEntry => ({
    name,
    kind,
    size,
    modifiedAt: Date.now() - Math.floor(Math.random() * 8.64e7),
    mode,
    owner: "ops",
    group: "ops",
  });
  const base = (extra: SftpEntry[]): SftpEntry[] => [
    e(".", "dir", 0, "0755"),
    e("..", "dir", 0, "0755"),
    ...extra,
  ];
  switch (norm) {
    case "/":
      return base([e("home", "dir", 4096, "0755"), e("etc", "dir", 4096, "0755"), e("var", "dir", 4096, "0755"), e("opt", "dir", 4096, "0755")]);
    case "/home":
    case "/home/ops":
      return base([
        e(".bashrc", "file", 412),
        e(".ssh", "dir", 4096, "0700"),
        e("app.log", "file", 81234, "0644"),
        e("config.toml", "file", 1024, "0644"),
        e("deploy.sh", "file", 2048, "0755"),
      ]);
    case "/etc":
      return base([e("hostname", "file", 12), e("hosts", "file", 196), e("nginx", "dir", 4096, "0755")]);
    case "/var":
      return base([e("log", "dir", 4096, "0755"), e("lib", "dir", 4096, "0755")]);
    case "/var/log":
      return base([
        e("syslog", "file", 1_280_000),
        e("auth.log", "file", 245_000, "0640"),
        e("archive", "dir", 4096, "0755"),
      ]);
    default:
      return base([]);
  }
}

// --- SSH tunnels mock ------------------------------------------------------

function emitTunnelStatus(id: string, status: TunnelStatus, message: string | null) {
  emit(EVT.tunnelStatus, { tunnelId: id, status, message });
}

async function startTunnel(t: Tunnel) {
  t.status = "starting";
  t.message = "negotiating SSH channel";
  emitTunnelStatus(t.id, t.status, t.message);
  await new Promise((r) => setTimeout(r, 250));
  t.status = "running";
  t.message = `forwarding ${t.bindAddress}:${t.localPort} ↔ ${t.remoteHost || "(socks)"}:${t.remotePort || "*"}`;
  emitTunnelStatus(t.id, t.status, t.message);
}

// --- Macros mock -----------------------------------------------------------

// --- Network tools mock ----------------------------------------------------

function runNetToolImpl(tool: NetToolKind, target: string): NetToolResult {
  const start = Date.now();
  const ok = target.trim().length > 0;
  let output = "";
  switch (tool) {
    case "ping":
      output = ok
        ? Array.from({ length: 4 }, (_, i) => `64 bytes from ${target}: icmp_seq=${i + 1} ttl=64 time=${(8 + Math.random() * 6).toFixed(2)} ms`).join("\n") +
          `\n--- ${target} ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss`
        : "no target";
      break;
    case "portScan":
      output = ok
        ? ["Scanning " + target + " ports 22, 80, 443, 3306, 5432, 8080 …",
          "22/tcp   open   ssh",
          "80/tcp   open   http",
          "443/tcp  open   https",
          "3306/tcp closed mysql",
          "5432/tcp closed postgres",
          "8080/tcp open   http-alt"].join("\n")
        : "no target";
      break;
    case "wakeOnLan":
      output = ok
        ? `Sent magic packet (FF FF …) to ${target} → broadcast\nWaiting for host to come online …`
        : "need a MAC or hostname";
      break;
    case "dnsLookup":
      output = ok
        ? [`Server: 8.8.8.8`, `Address: 8.8.8.8#53`, ``, `Name:   ${target}`, `Address: 10.0.0.${Math.floor(Math.random() * 250) + 2}`].join("\n")
        : "no name";
      break;
    case "traceroute":
      output = ok
        ? [`traceroute to ${target}, 30 hops max, 60 byte packets`,
          " 1  10.0.0.1   1.21 ms",
          " 2  10.0.0.254 3.04 ms",
          " 3  " + target + " 4.92 ms"].join("\n")
        : "no target";
      break;
  }
  return {
    tool,
    target,
    ok,
    output,
    durationMs: 20 + Math.floor(Math.random() * 80),
    collectedAt: Date.now() - start < 0 ? start : Date.now(),
  };
}

// --- Terminal history ------------------------------------------------------

function recordHistory(profileId: string, termId: string, command: string, exitCode: number) {
  const entry: HistoryEntry = {
    id: `h_${Math.random().toString(36).slice(2, 10)}`,
    profileId,
    termId,
    command,
    exitCode,
    createdAt: Date.now(),
  };
  history.push(entry);
  if (history.length > 500) history.shift();
  emit(EVT.historyAppend, { entry });
}

// --- canned command output (mirrors ssh_mock.rs) --------------------------

function mockExec(command: string): { stdout: string; exitCode: number } {
  const cmd = command.trim();
  const lower = cmd.toLowerCase();
  if (!cmd) return { stdout: "", exitCode: 0 };
  if (lower === "help")
    return {
      stdout:
        "Simulated commands:\n  help  echo  ls  pwd  whoami  uname -a  date  uptime  df -h  free -h  cat <file>\nThis is the browser mock backend. The AI copilot works offline here;\nreal SSH + dsh requires the Tauri build (`cargo tauri dev`).",
      exitCode: 0,
    };
  if (lower === "pwd") return { stdout: "/home/ops", exitCode: 0 };
  if (lower === "whoami") return { stdout: "ops", exitCode: 0 };
  if (lower === "uname -a" || lower === "uname")
    return {
      stdout: "MockLinux ops 6.8.0-mock #1 SMP x86_64 GNU/Linux",
      exitCode: 0,
    };
  if (lower === "date")
    return { stdout: new Date().toUTCString(), exitCode: 0 };
  if (lower === "uptime")
    return {
      stdout: " 09:00:00 up 3 days,  4:12,  load average: 0.42, 0.38, 0.31",
      exitCode: 0,
    };
  if (lower === "df -h" || lower === "df")
    return {
      stdout:
        "Filesystem      Size  Used Avail Use% Mounted on\n/dev/mock       200G   64G  136G  32% /",
      exitCode: 0,
    };
  if (lower === "free -h" || lower === "free")
    return {
      stdout:
        "              total        used        free\nMem:           31Gi        11Gi        20Gi",
      exitCode: 0,
    };
  if (lower.startsWith("echo ")) return { stdout: cmd.slice(5), exitCode: 0 };
  if (lower === "ls" || lower.startsWith("ls "))
    return {
      stdout: "bin  etc  home  opt  srv  tmp  usr  var\n(mock listing)",
      exitCode: 0,
    };
  if (lower.startsWith("cat ")) {
    const f = cmd.slice(4);
    if (f.includes("passwd") || f.includes("shadow") || f.includes("id_rsa"))
      return {
        stdout: "mock: refusing to print a sensitive file in the demo backend",
        exitCode: 1,
      };
    return { stdout: `(mock) contents of ${f}`, exitCode: 0 };
  }
  return {
    stdout: `mock-shell: '${cmd}' was not executed on a real host.`,
    exitCode: 1,
  };
}

function hostFacts(profileId: string): HostFacts {
  return {
    profileId,
    os: "MockLinux 6.8.0-mock",
    kernel: "6.8.0-mock",
    uptime: "up 3 days, 4:12",
    cpuModel: "Mock CPU @ 3.20GHz",
    cpuCores: 8,
    loadAvg: "0.42 0.38 0.31",
    memTotal: "31Gi",
    memUsed: "11Gi",
    memPercent: 35,
    disks: [
      { mount: "/", size: "200G", used: "64G", avail: "136G", percent: 32 },
    ],
    collectedAt: Date.now(),
  };
}

// --- risk gate (mirrors gate.rs classification) ---------------------------

function classify(command: string): { risk: "safe" | "caution" | "dangerous"; reason: string } {
  const c = command.toLowerCase();
  const dangerous = [
    /\brm\s+-[a-z]*f\b/,
    /\brm\b.*-rf\b/,
    /\bmkfs\b/,
    /\bdd\b.*\bof=\/dev\//,
    /\b(shutdown|reboot|poweroff|init 0)\b/,
    /\bdrop\s+(database|table)\b/,
    /\bkill\s+-9\s+-1\b/,
  ];
  const caution = [
    /\brm\b/,
    /\bmv\b/,
    /\bcp\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bsudo\b/,
    /\bkill\b/,
    /\bsystemctl\b/,
    /\bapt\b.*\b(remove|purge)\b/,
    /\bcurl\b.*\b-o\b/, // ask before pipe-to-shell
    /\b>\s*\S+/,
    /\b>>\s*\S+/,
  ];
  if (dangerous.some((re) => re.test(c)))
    return { risk: "dangerous", reason: "matches high-risk destructive pattern" };
  if (caution.some((re) => re.test(c)))
    return { risk: "caution", reason: "writes data or changes system state" };
  return { risk: "safe", reason: "read-only / informational" };
}

function needsApproval(risk: string): boolean {
  if (risk === "dangerous") return !settings.allowDangerous;
  if (settings.approvalPolicy === "askAlways") return true;
  if (risk === "caution" && settings.approvalPolicy === "autoSafe") return true;
  if (risk === "caution" && settings.approvalPolicy === "autoCaution") return false;
  return false;
}

// --- naive AI intent → command mapping -----------------------------------

interface Intent {
  match: RegExp;
  command: string;
  label: string;
}

const INTENTS: Intent[] = [
  { match: /(disk|磁盘|空间|df)/i, command: "df -h", label: "disk usage" },
  { match: /(memory|内存|mem|ram|free)/i, command: "free -h", label: "memory" },
  { match: /(uptime|负载|load|运行时间)/i, command: "uptime", label: "uptime" },
  { match: /(whoami|我是谁|当前用户)/i, command: "whoami", label: "current user" },
  { match: /(kernel|系统|uname|版本)/i, command: "uname -a", label: "system info" },
  { match: /(pwd|当前目录|路径)/i, command: "pwd", label: "working dir" },
  { match: /(list|列出|目录|ls)/i, command: "ls -la", label: "directory listing" },
  // A risky intent so the approval gate can be demonstrated offline.
  { match: /(clean|清理|删除|delete|remove|purge).*(log|日志|cache|缓存|temp|临时)/i, command: "rm -rf /var/log/archive", label: "purge old logs" },
];

function pickIntent(text: string): Intent | null {
  return INTENTS.find((i) => i.match.test(text)) ?? null;
}

// --- AI → network-tool intents -------------------------------------------

interface NetIntent {
  match: RegExp;
  tool: NetToolKind;
  label: string;
  defaultTarget: string;
}

const NET_INTENTS: NetIntent[] = [
  { match: /(ping|连通|可达)/i, tool: "ping", label: "ping host", defaultTarget: "10.0.0.11" },
  { match: /(scan|端口|端口扫描|nmap)/i, tool: "portScan", label: "port scan", defaultTarget: "10.0.0.11" },
  { match: /(wake|wol|唤醒|开机)/i, tool: "wakeOnLan", label: "wake-on-LAN", defaultTarget: "00:11:22:33:44:55" },
  { match: /(dns|域名|解析|resolve)/i, tool: "dnsLookup", label: "DNS lookup", defaultTarget: "web-01.local" },
  { match: /(traceroute|路由追踪|跳数)/i, tool: "traceroute", label: "traceroute", defaultTarget: "10.0.0.11" },
];

function pickNetIntent(text: string): NetIntent | null {
  return NET_INTENTS.find((i) => i.match.test(text)) ?? null;
}

function extractTarget(text: string, fallback: string): string {
  // Pull the last token that looks like a host / ip / mac.
  const m = text.match(/([a-zA-Z0-9._:-]+)/g);
  if (!m) return fallback;
  const last = m[m.length - 1];
  return last;
}

// --- command dispatch -----------------------------------------------------

export async function mockInvoke<T>(
  cmd: string,
  args: Record<string, unknown>,
): Promise<T> {
  switch (cmd) {
    case CMD.listProfiles:
      return Array.from(profiles.values()) as T;

    case CMD.saveProfile: {
      const p = args.profile as HostProfile;
      p.updatedAt = Date.now();
      profiles.set(p.id, p);
      return undefined as T;
    }

    case CMD.deleteProfile:
      profiles.delete(args.id as string);
      return undefined as T;

    case CMD.openTerminal: {
      const termId = `term_${Math.random().toString(36).slice(2, 10)}`;
      terminals.set(termId, {
        tx: () => {},
        closed: false,
      });
      termProfiles.set(termId, args.profileId as string);
      // Simulate async connect → ready.
      setTimeout(() => {
        emit(EVT.termStatus, {
          termId,
          status: "connecting",
          message: "starting mock shell",
        });
      }, 10);
      setTimeout(() => {
        emit(EVT.termStatus, { termId, status: "ready", message: null });
        emit(EVT.termData, {
          termId,
          base64: b64(
            "OpsPilot mock shell — browser preview. Type 'help'.\r\nmock$ ",
          ),
        });
      }, 200);
      const info = {
        termId,
        profileId: args.profileId as string,
        title: "mock-shell",
        status: "connecting",
        message: null,
      };
      // wire tx so writeTerminal echoes
      terminals.get(termId)!.tx = (bytes) => {
        const text = new TextDecoder().decode(new Uint8Array(bytes));
        handleTerminalInput(termId, text);
      };
      return info as T;
    }

    case CMD.closeTerminal: {
      const t = terminals.get(args.termId as string);
      if (t) t.closed = true;
      terminals.delete(args.termId as string);
      termProfiles.delete(args.termId as string);
      return undefined as T;
    }

    case CMD.writeTerminal: {
      const t = terminals.get(args.termId as string);
      if (t && !t.closed) t.tx(args.data as number[]);
      return undefined as T;
    }

    case CMD.resizeTerminal:
      return undefined as T;

    case CMD.listTerminals:
      return Array.from(terminals.keys()).map((id) => ({
        termId: id,
        profileId: "",
        title: "mock-shell",
        status: "ready",
        message: null,
      })) as T;

    case CMD.aiNewSession: {
      const sid = `sess_${Math.random().toString(36).slice(2, 10)}`;
      const detail: AiSessionDetail = {
        session: {
          sessionId: sid,
          title: (args.title as string) || "New session",
          profileId: (args.profileId as string) ?? null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0,
        },
        messages: [],
      };
      sessions.set(sid, detail);
      return { sessionId: sid } as T;
    }

    case CMD.aiListSessions:
      return Array.from(sessions.values()).map((s) => s.session) as T;

    case CMD.aiGetSession:
      return sessions.get(args.sessionId as string)! as T;

    case CMD.aiSend:
      void runAiTurn(args.sessionId as string, args.text as string);
      return undefined as T;

    case CMD.aiCancel:
      return undefined as T;

    case CMD.approvalResolve: {
      const req = approvals.get(args.requestId as string);
      if (req) {
        approvals.delete(args.requestId as string);
        emit(EVT.approvalResolved, {
          requestId: args.requestId,
          decision: args.decision,
        });
        pendingExecutors.get(args.requestId as string)?.(args.decision as ApprovalDecision);
        pendingExecutors.delete(args.requestId as string);
      }
      return undefined as T;
    }

    case CMD.approvalPending:
      return Array.from(approvals.values()) as T;

    case CMD.getSettings:
      return settings as T;

    case CMD.saveSettings: {
      settings = { ...settings, ...(args.settings as Settings) };
      return undefined as T;
    }

    case CMD.setSecret:
      return undefined as T;

    case CMD.hasSecret:
      return false as T;

    case CMD.getMcpInfo:
      return mcpInfo as T;

    case CMD.engineStatus: {
      const st: EngineStatus = {
        kind: "mock",
        ready: true,
        detail: "mock rule engine (offline, no API key needed)",
        needsApiKey: false,
      };
      return st as T;
    }

    case CMD.hostFacts:
      return hostFacts(args.profileId as string) as T;

    // --- SFTP -------------------------------------------------------------
    case CMD.sftpList: {
      const profileId = args.profileId as string;
      const path = (args.path as string) || "/home/ops";
      const listing: SftpListing = {
        profileId,
        path,
        entries: mockFs(profileId, path),
        note: hasTauri
          ? null
          : "mock filesystem — connect to a real host with the Tauri build",
      };
      return listing as T;
    }

    case CMD.sftpDownload: {
      const info: SftpDownloadInfo = {
        downloadId: `dl_${Math.random().toString(36).slice(2, 10)}`,
        bytes: 1024 + Math.floor(Math.random() * 8000),
        localPath: hasTauri
          ? null
          : `(mock) downloaded to browser downloads/`,
      };
      return info as T;
    }

    case CMD.sftpUpload:
    case CMD.sftpMkdir:
    case CMD.sftpDelete:
      return undefined as T;

    // --- Tunnels ----------------------------------------------------------
    case CMD.listTunnels:
      return Array.from(tunnels.values()) as T;

    case CMD.saveTunnel: {
      const t = args.tunnel as Tunnel;
      if (!t.id) t.id = `tun_${Math.random().toString(36).slice(2, 10)}`;
      t.createdAt = t.createdAt || Date.now();
      tunnels.set(t.id, t);
      return undefined as T;
    }

    case CMD.deleteTunnel:
      tunnels.delete(args.id as string);
      return undefined as T;

    case CMD.toggleTunnel: {
      const t = tunnels.get(args.id as string);
      if (!t) throw new Error(`mock: tunnel ${args.id} not found`);
      if (t.status === "running" || t.status === "starting") {
        t.status = "stopped";
        t.message = "tunnel closed by user";
        emitTunnelStatus(t.id, t.status, t.message);
      } else {
        void startTunnel(t);
      }
      return undefined as T;
    }

    // --- Macros -----------------------------------------------------------
    case CMD.listMacros:
      return Array.from(macros.values()) as T;

    case CMD.saveMacro: {
      const m = args.macro as Macro;
      if (!m.id) m.id = `mac_${Math.random().toString(36).slice(2, 10)}`;
      m.updatedAt = Date.now();
      if (!m.createdAt) m.createdAt = m.updatedAt;
      macros.set(m.id, m);
      return undefined as T;
    }

    case CMD.deleteMacro:
      macros.delete(args.id as string);
      return undefined as T;

    case CMD.runMacro: {
      const m = macros.get(args.id as string);
      if (!m) throw new Error(`mock: macro ${args.id} not found`);
      const termId = args.termId as string | null;
      if (termId) {
        const t = terminals.get(termId);
        for (const step of m.steps) t?.tx(Array.from(new TextEncoder().encode(step)));
      }
      return undefined as T;
    }

    // --- Network tools ----------------------------------------------------
    case CMD.runNetTool:
      return runNetToolImpl(
        args.tool as NetToolKind,
        args.target as string,
      ) as T;

    // --- History ----------------------------------------------------------
    case CMD.listHistory: {
      const limit = (args.limit as number) ?? 100;
      const profileId = args.profileId as string | null;
      const out = history
        .filter((h) => !profileId || h.profileId === profileId)
        .slice(-limit)
        .reverse();
      return out as T;
    }

    case CMD.clearHistory:
      history.length = 0;
      return undefined as T;

    case CMD.broadcastWrite: {
      // Send the same keystrokes to every open terminal (MobaXterm MultiExec).
      const data = args.data as number[];
      for (const id of broadcastSubscribers.size
        ? Array.from(broadcastSubscribers)
        : Array.from(terminals.keys())) {
        terminals.get(id)?.tx(data);
      }
      return undefined as T;
    }

    default:
      throw new Error(`mock: unknown command ${cmd}`);
  }
}

/** Subscribe a terminal to multi-execution broadcasts (mock-only helper). */
export function _setBroadcast(termId: string, on: boolean) {
  if (on) broadcastSubscribers.add(termId);
  else broadcastSubscribers.delete(termId);
}

// --- terminal echo loop (browser) ----------------------------------------

function handleTerminalInput(termId: string, text: string) {
  for (const ch of text) {
    if (ch === "\r" || ch === "\n") {
      const cmd = (lineBuf.get(termId) ?? "").trim();
      lineBuf.set(termId, "");
      emit(EVT.termData, { termId, base64: b64("\r\n") });
      const { stdout, exitCode } = mockExec(cmd);
      emit(EVT.termData, { termId, base64: b64(stdout + "\r\n") });
      emit(EVT.termData, { termId, base64: b64("mock$ ") });
      if (cmd) recordHistory(termProfiles.get(termId) ?? "", termId, cmd, exitCode);
    } else if (ch === "\x7f" || ch === "\b") {
      const cur = lineBuf.get(termId) ?? "";
      lineBuf.set(termId, cur.slice(0, -1));
      emit(EVT.termData, { termId, base64: b64("\x08 \x08") });
    } else if (ch >= " ") {
      lineBuf.set(termId, (lineBuf.get(termId) ?? "") + ch);
      emit(EVT.termData, { termId, base64: b64(ch) });
    }
  }
}
const lineBuf = new Map<string, string>();
/** Maps termId → profileId so history can be filtered per host. */
const termProfiles = new Map<string, string>();

// --- approval executor bridge --------------------------------------------

const pendingExecutors = new Map<
  string,
  (d: ApprovalDecision) => void
>();

// --- AI turn (deterministic rule engine) ---------------------------------

function pushMessage(sessionId: string, msg: AiMessage) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.messages.push(msg);
  s.session.messageCount = s.messages.length;
  s.session.updatedAt = Date.now();
  emit(EVT.aiMessage, { sessionId, message: msg });
}

function pickHostLabel(profileId: string | null): string {
  if (!profileId) return "selected host";
  return profiles.get(profileId)?.name ?? profileId;
}

async function runAiTurn(sessionId: string, text: string) {
  const start = Date.now();
  const s = sessions.get(sessionId);
  if (!s) return;

  pushMessage(sessionId, {
    messageId: rid(),
    role: "user",
    content: text,
    toolCalls: [],
    createdAt: Date.now(),
  });

  // 1. Echo a "thinking" assistant placeholder via delta.
  emit(EVT.aiDelta, {
    sessionId,
    messageId: "thinking",
    delta: "🤖 Thinking… ",
  });

  const intent = pickIntent(text);
  const netIntent = pickNetIntent(text);

  // Route network-tool requests (ping / scan / WoL / dns / traceroute) through
  // the embedded network tools — MobaXterm-style, but reasoned about by the AI.
  if (!intent && netIntent) {
    const target = extractTarget(text, netIntent.defaultTarget);
    const result = runNetToolImpl(netIntent.tool, target);
    const callId = rid();
    emit(EVT.aiTool, {
      sessionId,
      messageId: "tool",
      call: {
        callId,
        tool: `net_${netIntent.tool}`,
        summary: `${netIntent.label} → ${target}`,
        status: result.ok ? "ok" : "error",
        detail: result.output,
        risk: "safe",
        durationMs: result.durationMs,
      },
    });
    pushMessage(sessionId, {
      messageId: rid(),
      role: "assistant",
      content:
        `Ran **${netIntent.label}** against \`${target}\` (${result.durationMs} ms).\n\n` +
        "```\n" + result.output + "\n```\n\n" +
        analyzeNet(netIntent.tool, target, result),
      toolCalls: [],
      createdAt: Date.now(),
    });
    emit(EVT.aiDone, { sessionId, durationMs: Date.now() - start });
    return;
  }

  if (!intent) {
    pushMessage(sessionId, {
      messageId: rid(),
      role: "assistant",
      content:
        "I can demo a few ops tasks offline (disk, memory, uptime, user, system info, files) " +
        "and run the embedded network tools (ping, port scan, wake-on-LAN, DNS, traceroute). " +
        "In the real Tauri build I would plan a multi-step playbook, call the SSH tools through dsh, " +
        "and analyze the output. Try: “check disk space”, “how much memory is used?”, “show uptime”, " +
        "“ping 10.0.0.11”, “port scan web-01”, “dns lookup example.com”.",
      toolCalls: [],
      createdAt: Date.now(),
    });
    emit(EVT.aiDone, { sessionId, durationMs: Date.now() - start });
    return;
  }

  // 2. Decide risk + approval.
  const { risk, reason } = classify(intent.command);
  const host = pickHostLabel(s.session.profileId);

  const callId = rid();
  emit(EVT.aiTool, {
    sessionId,
    messageId: "tool",
    call: {
      callId,
      tool: "ssh_exec",
      summary: `${host} $ ${intent.command}`,
      status: "running",
      detail: null,
      risk,
      durationMs: null,
    },
  });

  const runCommand = () => {
    const { stdout, exitCode } = mockExec(intent.command);
    emit(EVT.aiTool, {
      sessionId,
      messageId: "tool",
      call: {
        callId,
        tool: "ssh_exec",
        summary: `${host} $ ${intent.command}`,
        status: exitCode === 0 ? "ok" : "error",
        detail: stdout,
        risk,
        durationMs: 120,
      },
    });
    const analysis = analyze(intent.command, stdout, exitCode);
    pushMessage(sessionId, {
      messageId: rid(),
      role: "assistant",
      content: `Ran \`${intent.command}\` on **${host}**.\n\n${analysis}`,
      toolCalls: [],
      createdAt: Date.now(),
    });
    emit(EVT.aiDone, { sessionId, durationMs: Date.now() - start });
  };

  if (needsApproval(risk)) {
    const reqId = rid();
    const req: ApprovalRequest = {
      requestId: reqId,
      kind: "exec",
      host,
      profileId: s.session.profileId ?? "",
      command: intent.command,
      risk,
      reason,
      expiresInMs: settings.approvalTimeoutSecs * 1000,
      createdAt: Date.now(),
    };
    approvals.set(reqId, req);
    emit(EVT.approvalRequest, req);
    pendingExecutors.set(reqId, (d) => {
      if (d === "allow" || d === "alwaysAllow") runCommand();
      else {
        emit(EVT.aiTool, {
          sessionId,
          messageId: "tool",
          call: {
            callId,
            tool: "ssh_exec",
            summary: `${host} $ ${intent.command}`,
            status: "denied",
            detail: "denied by user",
            risk,
            durationMs: 0,
          },
        });
        pushMessage(sessionId, {
          messageId: rid(),
          role: "assistant",
          content: "Command was denied. Let me know if you want to proceed differently.",
          toolCalls: [],
          createdAt: Date.now(),
        });
        emit(EVT.aiDone, { sessionId, durationMs: Date.now() - start });
      }
    });
    return;
  }

  // Safe / auto-approved → run immediately.
  setTimeout(runCommand, 150);
}

function analyze(command: string, output: string, exitCode: number): string {
  if (exitCode !== 0) return `⚠️ Command exited with code ${exitCode}.\n\n\`\`\`\n${output}\n\`\`\``;
  if (command.startsWith("df")) {
    const usedPct = output.match(/(\d+)%/g)?.pop()?.replace("%", "");
    return (
      `Disk usage looks healthy${usedPct ? ` (highest mount at ${usedPct}% used)` : ""}.\n` +
      "No immediate action needed unless a mount exceeds 85%."
    );
  }
  if (command.startsWith("free")) {
    return (
      "Memory is comfortably available (~20Gi free). " +
      "No signs of memory pressure. Watch `used` over time if the service leaks."
    );
  }
  if (command === "uptime") {
    return "Load average (0.42 / 0.38 / 0.31) is well below core count (8). The box is idle.";
  }
  return `Output captured (${output.length} chars). No anomalies detected by the demo rules.`;
}

function analyzeNet(tool: NetToolKind, target: string, r: NetToolResult): string {
  if (!r.ok) return `⚠️ ${tool} needs a target. You gave "${target}".`;
  switch (tool) {
    case "ping":
      return r.output.includes("0% packet loss")
        ? `${target} is reachable — 0% loss, RTT looks normal.`
        : `⚠️ Packet loss detected reaching ${target}. Check route / firewall.`;
    case "portScan":
      return r.output.includes("22/tcp   open")
        ? `SSH (22) is open on ${target}. Several web ports are also exposed — review whether 8080 should be public.`
        : `Port scan complete. SSH does not appear open — verify the host is up.`;
    case "wakeOnLan":
      return `Magic packet sent to ${target}. The host should boot within ~30s; ping it to confirm.`;
    case "dnsLookup":
      return r.output.includes("Address:")
        ? `Resolved ${target} successfully.`
        : `⚠️ No DNS record for ${target}.`;
    case "traceroute":
      return `Route to ${target} completed in a few hops; no obvious blackhole.`;
  }
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
