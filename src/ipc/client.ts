/**
 * IPC client — the only module the UI talks to.
 *
 * In a real Tauri build it forwards to `@tauri-apps/api`'s `invoke` and
 * `listen`.  When running under a plain browser (`npm run dev` without the
 * Rust shell) it transparently switches to an in-memory mock backend so the
 * whole UI is demoable without compiling the native layer.
 *
 * Nothing else in the app should import `@tauri-apps/api` directly.
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  AiSession,
  AiSessionDetail,
  EngineStatus,
  HostFacts,
  HostProfile,
  McpInfo,
  Settings,
  TerminalInfo,
} from "./contract";
import { CMD, EVT } from "./contract";

const hasTauri =
  typeof window !== "undefined" &&
  // @ts-expect-error - injected by the Tauri runtime
  (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined);

let mock: typeof import("./mock") | null = null;

async function loadMock() {
  if (!mock) {
    mock = await import("./mock");
    mock.initMock();
  }
  return mock;
}

/** Invoke a backend command. Mirrors Tauri's `invoke<T>(cmd, args)`. */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (hasTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  }
  const m = await loadMock();
  return m.mockInvoke<T>(cmd, args ?? {});
}

/**
 * Subscribe to a backend event. Returns an unlisten function.
 * Mirrors Tauri's `listen<T>(event, handler)`.
 */
export async function listen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (hasTauri) {
    const { listen: tauriListen } = await import("@tauri-apps/api/event");
    return tauriListen<T>(event, (e) => handler(e.payload as T));
  }
  const m = await loadMock();
  return m.mockListen<T>(event, handler);
}

// Convenience typed wrappers -------------------------------------------------

export const api = {
  listProfiles: () => invoke<HostProfile[]>(CMD.listProfiles),
  saveProfile: (p: HostProfile) => invoke<void>(CMD.saveProfile, { profile: p }),
  deleteProfile: (id: string) => invoke<void>(CMD.deleteProfile, { id }),
  openTerminal: (args: {
    profileId: string;
    cols: number;
    rows: number;
    secret?: string | null;
  }) => invoke<TerminalInfo>(CMD.openTerminal, args),
  closeTerminal: (termId: string) =>
    invoke<void>(CMD.closeTerminal, { termId }),
  writeTerminal: (termId: string, data: number[]) =>
    invoke<void>(CMD.writeTerminal, { termId, data }),
  resizeTerminal: (termId: string, cols: number, rows: number) =>
    invoke<void>(CMD.resizeTerminal, { termId, cols, rows }),
  listTerminals: () => invoke<TerminalInfo[]>(CMD.listTerminals),

  aiNewSession: (profileId: string | null, title?: string) =>
    invoke<{ sessionId: string }>(CMD.aiNewSession, { profileId, title }),
  aiListSessions: () => invoke<AiSession[]>(CMD.aiListSessions),
  aiGetSession: (sessionId: string) =>
    invoke<AiSessionDetail>(CMD.aiGetSession, { sessionId }),
  aiSend: (sessionId: string, text: string) =>
    invoke<void>(CMD.aiSend, { sessionId, text }),
  aiCancel: (sessionId: string) => invoke<void>(CMD.aiCancel, { sessionId }),

  approvalResolve: (requestId: string, decision: ApprovalDecision) =>
    invoke<void>(CMD.approvalResolve, { requestId, decision }),
  approvalPending: () => invoke<ApprovalRequest[]>(CMD.approvalPending),

  getSettings: () => invoke<Settings>(CMD.getSettings),
  saveSettings: (s: Settings) => invoke<void>(CMD.saveSettings, { settings: s }),
  setSecret: (profileId: string, secret: string) =>
    invoke<void>(CMD.setSecret, { profileId, secret }),
  hasSecret: (profileId: string) =>
    invoke<boolean>(CMD.hasSecret, { profileId }),
  getMcpInfo: () => invoke<McpInfo>(CMD.getMcpInfo),
  engineStatus: () => invoke<EngineStatus>(CMD.engineStatus),

  hostFacts: (profileId: string) =>
    invoke<HostFacts>(CMD.hostFacts, { profileId }),
};

export { hasTauri, CMD, EVT };
