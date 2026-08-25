//! Tauri command handlers.
//!
//! Each handler maps one-to-one with the `CMD` constants in
//! `src/ipc/contract.ts`.

use crate::ai::{AiEngineHandle, SessionStore};
use crate::error::{AppError, AppResult};
use crate::gate::GateHandle;
use crate::protocol::{
    ApprovalDecision, ApprovalRequest, ApprovalResolvedEvent, EngineKind, EngineStatus,
    HostProfile, HostFacts, McpInfo, OpenTerminalArgs, Settings, TerminalInfo, AiMessage,
    AiSession, AiSessionDetail,
};
use crate::ssh::SshManager;
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use tracing::{debug, error, warn};

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_profiles(store: State<'_, Arc<Store>>) -> AppResult<Vec<HostProfile>> {
    store.list_profiles().await
}

#[tauri::command]
pub async fn save_profile(
    store: State<'_, Arc<Store>>,
    profile: HostProfile,
) -> AppResult<HostProfile> {
    store.save_profile(profile).await
}

#[tauri::command]
pub async fn delete_profile(
    store: State<'_, Arc<Store>>,
    id: String,
) -> AppResult<()> {
    store.delete_profile(&id).await
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn open_terminal(
    ssh: State<'_, Arc<SshManager>>,
    args: OpenTerminalArgs,
) -> AppResult<TerminalInfo> {
    ssh.open_terminal(args).await
}

#[tauri::command]
pub fn close_terminal(ssh: State<'_, Arc<SshManager>>, term_id: String) -> AppResult<()> {
    ssh.close_terminal(&term_id)
}

#[tauri::command]
pub fn write_terminal(
    ssh: State<'_, Arc<SshManager>>,
    term_id: String,
    data: String,
) -> AppResult<()> {
    ssh.write_terminal(&term_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(
    ssh: State<'_, Arc<SshManager>>,
    term_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    ssh.resize_terminal(&term_id, cols, rows)
}

#[tauri::command]
pub fn list_terminals(ssh: State<'_, Arc<SshManager>>) -> Vec<TerminalInfo> {
    ssh.list_terminals()
}

// ---------------------------------------------------------------------------
// AI sessions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_new_session(
    sessions: State<'_, Arc<SessionStore>>,
    profile_id: Option<String>,
    title: Option<String>,
) -> AppResult<AiSession> {
    sessions.new_session(profile_id, title).await
}

#[tauri::command]
pub async fn ai_list_sessions(
    sessions: State<'_, Arc<SessionStore>>,
) -> AppResult<Vec<AiSession>> {
    sessions.list().await
}

#[tauri::command]
pub async fn ai_get_session(
    sessions: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> AppResult<AiSessionDetail> {
    sessions.get(&session_id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSendArgs {
    pub session_id: String,
    pub content: String,
}

#[tauri::command]
pub async fn ai_send(
    engine: State<'_, Arc<AiEngineHandle>>,
    sessions: State<'_, Arc<SessionStore>>,
    args: AiSendArgs,
) -> AppResult<()> {
    engine.send(&args.session_id, &args.content).await
}

#[tauri::command]
pub async fn ai_cancel(engine: State<'_, Arc<AiEngineHandle>>) -> AppResult<()> {
    engine.cancel().await
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolveArgs {
    pub request_id: String,
    pub decision: ApprovalDecision,
}

#[tauri::command]
pub async fn approval_resolve(
    gate: State<'_, Arc<GateHandle>>,
    args: ApprovalResolveArgs,
) -> AppResult<()> {
    gate.resolve(&args.request_id, args.decision).await
}

#[tauri::command]
pub async fn approval_pending(gate: State<'_, Arc<GateHandle>>) -> Vec<ApprovalRequest> {
    // GateHandle currently drops pending requests from its map after resolution,
    // so we cannot list them without keeping tombstones.  For the UI, approvals
    // are pushed via events; this command returns an empty list.
    Vec::new()
}

// ---------------------------------------------------------------------------
// Settings / secrets
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_settings(store: State<'_, Arc<Store>>) -> AppResult<Settings> {
    store.load_settings().await
}

#[tauri::command]
pub async fn save_settings(
    store: State<'_, Arc<Store>>,
    settings: Settings,
) -> AppResult<()> {
    store.save_settings(&settings).await
}

#[tauri::command]
pub async fn set_secret(
    profile_id: String,
    secret: String,
) -> AppResult<()> {
    crate::secret::set(&profile_id, &secret).await
}

#[tauri::command]
pub async fn has_secret(profile_id: String) -> AppResult<bool> {
    Ok(crate::secret::get(&profile_id).await?.is_some())
}

#[tauri::command]
pub async fn get_mcp_info(mcp: State<'_, Arc<McpInfo>>) -> McpInfo {
    (**mcp).clone()
}

#[tauri::command]
pub async fn engine_status(engine: State<'_, Arc<AiEngineHandle>>) -> EngineStatus {
    engine.status().await
}

#[tauri::command]
pub async fn host_facts(
    ssh: State<'_, Arc<SshManager>>,
    profile_id: String,
) -> AppResult<HostFacts> {
    ssh.collect_host_facts(&profile_id).await
}
