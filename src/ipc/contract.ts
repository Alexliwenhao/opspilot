/**
 * OpsPilot IPC contract — the single source of truth shared by the Rust backend
 * and the TypeScript frontend.
 *
 * Rust side mirrors every type here with `#[serde(rename_all = "camelCase")]`.
 * If you change anything in this file, change `src-tauri/src/protocol.rs` too.
 */

// ---------------------------------------------------------------------------
// Host profiles
// ---------------------------------------------------------------------------

export type AuthKind = "password" | "key" | "agent";

export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  /** Absolute path to a private key file, used when authKind === "key". */
  keyPath: string | null;
  /** Free-form folder name used to group hosts in the sidebar. */
  group: string | null;
  /** Accent colour hex, e.g. "#e0533d". Used for tab + tree tinting. */
  color: string | null;
  /** Persist the password/passphrase in the OS keychain. */
  saveSecret: boolean;
  /** Commands sent automatically right after the shell becomes ready. */
  initCommands: string[];
  /** Extra note shown as a tooltip. */
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export type TerminalStatus =
  | "connecting"
  | "authenticating"
  | "ready"
  | "closed"
  | "error";

export interface TerminalInfo {
  termId: string;
  profileId: string;
  title: string;
  status: TerminalStatus;
  /** Present when status === "error". */
  message: string | null;
}

// ---------------------------------------------------------------------------
// Risk gate + approvals
// ---------------------------------------------------------------------------

export type Risk = "safe" | "caution" | "dangerous";

/** How aggressively the AI is allowed to run commands without asking. */
export type ApprovalPolicy =
  /** Ask before every single command. */
  | "askAlways"
  /** Auto-run read-only commands, ask for anything that writes. */
  | "autoSafe"
  /** Auto-run safe + caution, always ask for dangerous. */
  | "autoCaution"
  /** Run everything without asking. Dangerous commands still get blocked
   *  unless `allowDangerous` is enabled. */
  | "yolo";

export type ApprovalKind =
  | "exec"
  | "writeFile"
  | "terminalWrite";

export interface ApprovalRequest {
  requestId: string;
  kind: ApprovalKind;
  /** Human-readable host label, e.g. "web-01 (10.0.0.5)". */
  host: string;
  profileId: string;
  command: string;
  risk: Risk;
  /** Why the gate flagged it, e.g. "matched rule: recursive delete". */
  reason: string;
  /** Milliseconds until the request auto-denies. */
  expiresInMs: number;
  createdAt: number;
}

export type ApprovalDecision = "allow" | "deny" | "alwaysAllow";

// ---------------------------------------------------------------------------
// AI sessions
// ---------------------------------------------------------------------------

export type AiRole = "user" | "assistant" | "tool" | "system";

export type ToolStatus = "running" | "ok" | "error" | "denied";

export interface AiToolCall {
  callId: string;
  tool: string;
  /** Pretty-printed one-liner, e.g. `web-01 $ df -h`. */
  summary: string;
  status: ToolStatus;
  /** Full stdout/stderr or error text. */
  detail: string | null;
  risk: Risk | null;
  durationMs: number | null;
}

export interface AiMessage {
  messageId: string;
  role: AiRole;
  content: string;
  toolCalls: AiToolCall[];
  createdAt: number;
}

export interface AiSession {
  sessionId: string;
  title: string;
  /** Host this conversation is anchored to, if any. */
  profileId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface AiSessionDetail {
  session: AiSession;
  messages: AiMessage[];
}

// ---------------------------------------------------------------------------
// Engine + settings
// ---------------------------------------------------------------------------

export type EngineKind = "dsh" | "deepseekDirect" | "mock";

export interface EngineStatus {
  kind: EngineKind;
  ready: boolean;
  /** e.g. "dsh 0.1.1-rc.2 (node v24.14.0)" or "missing API key". */
  detail: string;
  /** True when the engine needs an API key that is not configured yet. */
  needsApiKey: boolean;
}

export interface Settings {
  engine: EngineKind;
  model: string;
  /** Base URL for the DeepSeek-compatible endpoint. */
  baseUrl: string;
  approvalPolicy: ApprovalPolicy;
  /** Allow the gate to run commands classified as "dangerous" after approval. */
  allowDangerous: boolean;
  /** Seconds before an unanswered approval request auto-denies. */
  approvalTimeoutSecs: number;
  /** Reject unknown SSH host keys instead of trust-on-first-use. */
  strictHostKeyChecking: boolean;
  fontFamily: string;
  fontSize: number;
  theme: "dark" | "light";
  /** Path to the dsh executable, or null to auto-detect via npx. */
  dshPath: string | null;
  /** Max bytes of command output handed back to the model. */
  maxOutputBytes: number;
}

export interface McpInfo {
  url: string;
  token: string;
  toolCount: number;
}

export interface HostFacts {
  profileId: string;
  os: string;
  kernel: string;
  uptime: string;
  cpuModel: string;
  cpuCores: number;
  loadAvg: string;
  memTotal: string;
  memUsed: string;
  memPercent: number;
  disks: DiskUsage[];
  collectedAt: number;
}

export interface DiskUsage {
  mount: string;
  size: string;
  used: string;
  avail: string;
  percent: number;
}

// ---------------------------------------------------------------------------
// Tauri command names — use these constants, never raw strings.
// ---------------------------------------------------------------------------

export const CMD = {
  listProfiles: "list_profiles",
  saveProfile: "save_profile",
  deleteProfile: "delete_profile",

  openTerminal: "open_terminal",
  closeTerminal: "close_terminal",
  writeTerminal: "write_terminal",
  resizeTerminal: "resize_terminal",
  listTerminals: "list_terminals",

  aiNewSession: "ai_new_session",
  aiListSessions: "ai_list_sessions",
  aiGetSession: "ai_get_session",
  aiSend: "ai_send",
  aiCancel: "ai_cancel",

  approvalResolve: "approval_resolve",
  approvalPending: "approval_pending",

  getSettings: "get_settings",
  saveSettings: "save_settings",
  setSecret: "set_secret",
  hasSecret: "has_secret",
  getMcpInfo: "get_mcp_info",
  engineStatus: "engine_status",

  hostFacts: "host_facts",
} as const;

// ---------------------------------------------------------------------------
// Event names + payloads
// ---------------------------------------------------------------------------

export const EVT = {
  termData: "term:data",
  termStatus: "term:status",
  termExit: "term:exit",

  aiDelta: "ai:delta",
  aiMessage: "ai:message",
  aiTool: "ai:tool",
  aiDone: "ai:done",
  aiError: "ai:error",

  approvalRequest: "approval:request",
  approvalResolved: "approval:resolved",
} as const;

/** `term:data` — terminal bytes, base64 encoded to survive JSON transport. */
export interface TermDataEvent {
  termId: string;
  base64: string;
}

export interface TermStatusEvent {
  termId: string;
  status: TerminalStatus;
  message: string | null;
}

export interface TermExitEvent {
  termId: string;
  code: number | null;
  reason: string;
}

export interface AiDeltaEvent {
  sessionId: string;
  messageId: string;
  delta: string;
}

export interface AiMessageEvent {
  sessionId: string;
  message: AiMessage;
}

export interface AiToolEvent {
  sessionId: string;
  messageId: string;
  call: AiToolCall;
}

export interface AiDoneEvent {
  sessionId: string;
  /** Total wall-clock time for the turn. */
  durationMs: number;
}

export interface AiErrorEvent {
  sessionId: string;
  message: string;
}

export interface ApprovalResolvedEvent {
  requestId: string;
  decision: ApprovalDecision;
}
