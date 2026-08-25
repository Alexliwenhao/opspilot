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
  HostFacts,
  HostProfile,
  McpInfo,
  Settings,
} from "./contract";
import { CMD, EVT } from "./contract";

// --- event bus ------------------------------------------------------------

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

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
}

export function initMock() {
  seed();
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

    default:
      throw new Error(`mock: unknown command ${cmd}`);
  }
}

// --- terminal echo loop (browser) ----------------------------------------

function handleTerminalInput(termId: string, text: string) {
  for (const ch of text) {
    if (ch === "\r" || ch === "\n") {
      const cmd = lineBuf.get(termId) ?? "";
      lineBuf.set(termId, "");
      emit(EVT.termData, { termId, base64: b64("\r\n") });
      const { stdout } = mockExec(cmd);
      emit(EVT.termData, { termId, base64: b64(stdout + "\r\n") });
      emit(EVT.termData, { termId, base64: b64("mock$ ") });
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
  if (!intent) {
    pushMessage(sessionId, {
      messageId: rid(),
      role: "assistant",
      content:
        "I can demo a few ops tasks offline (disk, memory, uptime, user, system info, files). " +
        "In the real Tauri build I would plan a multi-step playbook, call the SSH tools through dsh, " +
        "and analyze the output. Try: “check disk space”, “how much memory is used?”, “show uptime”.",
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

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
