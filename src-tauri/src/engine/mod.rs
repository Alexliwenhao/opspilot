//! AI engine abstraction.
//!
//! Three implementations:
//!   * Mock  – deterministic rule-based copilot, no API key, always works.
//!   * DeepseekDirect – DeepSeek chat-completions with native tool definitions.
//!   * Dsh – DeepSeek Harness sidecar (MCP client) launcher.

use crate::ai::SessionStore;
use crate::error::{AppError, AppResult};
use crate::gate::GateHandle;
use crate::protocol::{
    AiDeltaEvent, AiDoneEvent, AiErrorEvent, AiMessage, AiMessageEvent, AiRole, AiToolCall,
    AiToolEvent, ApprovalPolicy, EngineKind, EngineStatus, McpInfo, Risk, Settings, ToolStatus,
    now_ms,
};
use crate::ssh::SshManager;
use crate::store::Store;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

mod deepseek;
mod dsh;
mod mock;

#[async_trait]
pub trait AiEngine: Send + Sync {
    fn kind(&self) -> EngineKind;
    async fn status(&self) -> EngineStatus;
    /// Process one user turn and stream events via Tauri.
    async fn send(
        &self,
        session_id: &str,
        history: Vec<AiMessage>,
        current: &str,
    ) -> AppResult<()>;
    /// Cancel an in-flight turn, if possible.
    async fn cancel(&self);
}

pub struct AiEngineHandle {
    inner: Mutex<Arc<dyn AiEngine>>,
    app: tauri::AppHandle,
}

impl AiEngineHandle {
    pub async fn new(
        kind: EngineKind,
        app: tauri::AppHandle,
        store: Arc<Store>,
        mcp: McpInfo,
        ssh: Arc<SshManager>,
        gate: Arc<GateHandle>,
        sessions: Arc<SessionStore>,
    ) -> AppResult<Self> {
        let engine: Arc<dyn AiEngine> = build(kind, app.clone(), store, mcp, ssh, gate, sessions).await?;
        Ok(Self {
            inner: Mutex::new(engine),
            app,
        })
    }

    pub async fn status(&self) -> EngineStatus {
        self.inner.lock().await.status().await
    }

    pub async fn send(&self, session_id: &str, content: &str) -> AppResult<()> {
        let sessions = self.app.state::<Arc<SessionStore>>().inner().clone();
        let history = sessions.messages(session_id);

        // Add user message to history and emit it immediately.
        let user_msg = AiMessage::new(AiRole::User, content);
        sessions.push(session_id, user_msg.clone());
        let _ = self.app.emit(
            crate::protocol::evt::AI_MESSAGE,
            AiMessageEvent {
                session_id: session_id.to_string(),
                message: user_msg,
            },
        );

        let engine = self.inner.lock().await.clone();
        if let Err(e) = engine.send(session_id, history, content).await {
            let _ = self.app.emit(
                crate::protocol::evt::AI_ERROR,
                AiErrorEvent {
                    session_id: session_id.to_string(),
                    message: e.to_string(),
                },
            );
            return Err(e);
        }
        Ok(())
    }

    pub async fn cancel(&self) {
        self.inner.lock().await.cancel().await;
    }
}

async fn build(
    kind: EngineKind,
    app: tauri::AppHandle,
    store: Arc<Store>,
    mcp: McpInfo,
    ssh: Arc<SshManager>,
    gate: Arc<GateHandle>,
    sessions: Arc<SessionStore>,
) -> AppResult<Arc<dyn AiEngine>> {
    match kind {
        EngineKind::Mock => Ok(Arc::new(mock::MockEngine::new(app, ssh, gate, store, sessions))),
        EngineKind::DeepseekDirect => Ok(Arc::new(deepseek::DirectEngine::new(
            app, ssh, gate, store, sessions,
        )?)),
        EngineKind::Dsh => Ok(Arc::new(dsh::DshEngine::new(app, store, mcp))),
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub(crate) fn emit_delta(app: &tauri::AppHandle, session_id: &str, message_id: &str, delta: &str) {
    let _ = app.emit(
        crate::protocol::evt::AI_DELTA,
        AiDeltaEvent {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
            delta: delta.to_string(),
        },
    );
}

pub(crate) fn emit_message(app: &tauri::AppHandle, session_id: &str, message: AiMessage) {
    let _ = app.emit(
        crate::protocol::evt::AI_MESSAGE,
        AiMessageEvent {
            session_id: session_id.to_string(),
            message,
        },
    );
}

pub(crate) fn emit_tool(
    app: &tauri::AppHandle,
    session_id: &str,
    message_id: &str,
    call: AiToolCall,
) {
    let _ = app.emit(
        crate::protocol::evt::AI_TOOL,
        AiToolEvent {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
            call,
        },
    );
}

pub(crate) fn emit_done(app: &tauri::AppHandle, session_id: &str, duration_ms: i64) {
    let _ = app.emit(
        crate::protocol::evt::AI_DONE,
        AiDoneEvent {
            session_id: session_id.to_string(),
            duration_ms,
        },
    );
}

pub(crate) fn emit_error(app: &tauri::AppHandle, session_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        crate::protocol::evt::AI_ERROR,
        AiErrorEvent {
            session_id: session_id.to_string(),
            message: message.into(),
        },
    );
}

pub(crate) async fn run_tool(
    app: &tauri::AppHandle,
    ssh: &SshManager,
    gate: &GateHandle,
    store: &Store,
    session_id: &str,
    message_id: &str,
    call_id: &str,
    tool: &str,
    args: &Value,
) -> AiToolCall {
    let start = Instant::now();
    let summary = format_tool_summary(tool, args);
    let mut call = AiToolCall {
        call_id: call_id.to_string(),
        tool: tool.to_string(),
        summary: summary.clone(),
        status: ToolStatus::Running,
        detail: None,
        risk: None,
        duration_ms: None,
    };
    emit_tool(app, session_id, message_id, call.clone());

    let result = match tool {
        "ssh_list_hosts" => list_hosts(store).await,
        "ssh_host_facts" => {
            let profile_id = arg_str(args, "profileId");
            ssh.collect_host_facts(&profile_id).await.map(|f| json!(f))
        }
        "ssh_exec" => {
            let profile_id = arg_str(args, "profileId");
            let command = arg_str(args, "command");
            let profile = store.get_profile(&profile_id).await.ok().flatten();
            if let Some(ref p) = profile {
                if let Err(e) = gate.check_exec(&profile_id, &p.label(), &command, false).await {
                    return tool_error(call, start, &format!("approval: {e}"));
                }
            }
            let max = store.load_settings().await.map(|s| s.max_output_bytes).unwrap_or(24_000);
            match ssh.exec(&profile_id, &command, max).await {
                Ok(r) => json!({
                    "exitCode": r.exit_code,
                    "stdout": r.stdout,
                    "stderr": r.stderr,
                }),
                Err(e) => return tool_error(call, start, &e.to_string()),
            }
        }
        "ssh_read_file" => {
            let profile_id = arg_str(args, "profileId");
            let path = arg_str(args, "path");
            let max = store.load_settings().await.map(|s| s.max_output_bytes).unwrap_or(24_000);
            match ssh.read_remote_file(&profile_id, &path, max).await {
                Ok(text) => json!({ "content": text }),
                Err(e) => return tool_error(call, start, &e.to_string()),
            }
        }
        "ssh_write_file" => {
            let profile_id = arg_str(args, "profileId");
            let path = arg_str(args, "path");
            let content = arg_str(args, "content");
            let profile = store.get_profile(&profile_id).await.ok().flatten();
            if let Some(ref p) = profile {
                if let Err(e) = gate.check_write(&profile_id, &p.label(), &path).await {
                    return tool_error(call, start, &format!("approval: {e}"));
                }
            }
            match ssh.write_remote_file(&profile_id, &path, &content).await {
                Ok(()) => json!({ "ok": true }),
                Err(e) => return tool_error(call, start, &e.to_string()),
            }
        }
        _ => return tool_error(call, start, &format!("unknown tool: {tool}")),
    };

    call.status = ToolStatus::Ok;
    call.detail = Some(serde_json::to_string_pretty(&result).unwrap_or_default());
    call.duration_ms = Some(start.elapsed().as_millis() as i64);
    emit_tool(app, session_id, message_id, call.clone());
    call
}

async fn list_hosts(store: &Store) -> Value {
    match store.list_profiles().await {
        Ok(profiles) => {
            let hosts = profiles
                .into_iter()
                .map(|p| {
                    json!({
                        "id": p.id,
                        "label": p.label(),
                        "group": p.group,
                        "host": format!("{}:{}", p.host, p.port),
                        "username": p.username
                    })
                })
                .collect::<Vec<_>>();
            json!(hosts)
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn format_tool_summary(tool: &str, args: &Value) -> String {
    match tool {
        "ssh_exec" => {
            let host = arg_str(args, "profileId");
            let cmd = arg_str(args, "command");
            format!("{host}$ {cmd}")
        }
        "ssh_read_file" => format!("cat {}", arg_str(args, "path")),
        "ssh_write_file" => format!("write {}", arg_str(args, "path")),
        "ssh_host_facts" => format!("facts for {}", arg_str(args, "profileId")),
        "ssh_list_hosts" => "list hosts".to_string(),
        _ => tool.to_string(),
    }
}

fn tool_error(mut call: AiToolCall, start: Instant, message: &str) -> AiToolCall {
    call.status = ToolStatus::Error;
    call.detail = Some(message.to_string());
    call.duration_ms = Some(start.elapsed().as_millis() as i64);
    call
}
