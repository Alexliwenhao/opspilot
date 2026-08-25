//! Mock AI engine — deterministic, offline, useful for testing the UI.
//!
//! It recognises a handful of natural-language patterns and maps them to SSH
//! tools.  It demonstrates the tool-call flow without requiring an API key.

use super::{emit_delta, emit_done, emit_message, run_tool};
use crate::ai::SessionStore;
use crate::error::AppResult;
use crate::gate::GateHandle;
use crate::protocol::{AiMessage, AiRole, AiToolCall, EngineKind, EngineStatus, ToolStatus, now_ms};
use crate::ssh::SshManager;
use crate::store::Store;
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tracing::debug;

pub struct MockEngine {
    app: AppHandle,
    ssh: Arc<SshManager>,
    gate: Arc<GateHandle>,
    store: Arc<Store>,
    sessions: Arc<SessionStore>,
}

impl MockEngine {
    pub fn new(
        app: AppHandle,
        ssh: Arc<SshManager>,
        gate: Arc<GateHandle>,
        store: Arc<Store>,
        sessions: Arc<SessionStore>,
    ) -> Self {
        Self {
            app,
            ssh,
            gate,
            store,
            sessions,
        }
    }
}

#[async_trait]
impl super::AiEngine for MockEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Mock
    }

    async fn status(&self) -> EngineStatus {
        EngineStatus {
            kind: EngineKind::Mock,
            ready: true,
            detail: "offline rule-based copilot".to_string(),
            needs_api_key: false,
        }
    }

    async fn send(
        &self,
        session_id: &str,
        _history: Vec<AiMessage>,
        current: &str,
    ) -> AppResult<()> {
        let start = Instant::now();
        let lower = current.to_lowercase();

        // Create assistant message shell.
        let mut assistant = AiMessage::new(AiRole::Assistant, "");
        let message_id = assistant.message_id.clone();
        self.sessions.push(session_id, assistant.clone());
        emit_message(&self.app, session_id, assistant.clone());

        let mut reply = String::new();
        let mut tool_calls: Vec<AiToolCall> = Vec::new();

        // Parse intent.
        let host = extract_host(&lower, &self.store).await;

        if lower.contains("hello") || lower.contains("hi") || lower.contains("你好") {
            reply = "你好，我是 OpsPilot 的离线演示引擎。你可以让我\n- 查看服务器状态（“检查 web-01 的磁盘和负载”）\n- 执行安全只读命令（“在 web-01 上运行 uname -a”）\n- 危险命令会触发人工审批\n\n要启用真正的 AI，请在设置里填入 DeepSeek API Key 或配置 dsh。".to_string();
        } else if lower.contains("disk") || lower.contains("磁盘") || lower.contains("df") {
            if let Some(profile_id) = host {
                let call = run_tool(
                    &self.app, &self.ssh, &self.gate, &self.store,
                    session_id, &message_id, "call-1", "ssh_exec",
                    &json!({"profileId": profile_id, "command": "df -h"}),
                ).await;
                tool_calls.push(call.clone());
                reply = format!("已获取磁盘使用情况。\n\n```\n{}\n```", call.detail.unwrap_or_default());
            } else {
                reply = "请告诉我具体是哪台主机，例如“检查 web-01 的磁盘”。".to_string();
            }
        } else if lower.contains("load") || lower.contains("cpu") || lower.contains("负载") || lower.contains("状态") {
            if let Some(profile_id) = host {
                let call = run_tool(
                    &self.app, &self.ssh, &self.gate, &self.store,
                    session_id, &message_id, "call-1", "ssh_host_facts",
                    &json!({"profileId": profile_id}),
                ).await;
                tool_calls.push(call.clone());
                reply = format!("已收集主机信息。\n\n```json\n{}\n```", call.detail.unwrap_or_default());
            } else {
                reply = "请指定主机名或配置一台主机。".to_string();
            }
        } else if lower.contains("run ") || lower.contains("执行") || lower.contains("运行") {
            if let Some(profile_id) = host {
                let cmd = extract_command(current);
                let call = run_tool(
                    &self.app, &self.ssh, &self.gate, &self.store,
                    session_id, &message_id, "call-1", "ssh_exec",
                    &json!({"profileId": profile_id, "command": cmd}),
                ).await;
                tool_calls.push(call.clone());
                reply = format!("命令执行结果：\n\n```\n{}\n```", call.detail.unwrap_or_default());
            } else {
                reply = "请告诉我要在哪台主机上运行命令。".to_string();
            }
        } else if lower.contains("list host") || lower.contains("主机列表") {
            let call = run_tool(
                &self.app, &self.ssh, &self.gate, &self.store,
                session_id, &message_id, "call-1", "ssh_list_hosts", &json!({}),
            ).await;
            tool_calls.push(call.clone());
            reply = format!("当前配置的主机：\n\n```json\n{}\n```", call.detail.unwrap_or_default());
        } else {
            reply = "我（离线演示引擎）没理解你的意图。试试：\n- “检查 web-01 的磁盘”\n- “在 web-01 运行 uptime”\n- “列出所有主机”".to_string();
        }

        // Stream reply word-by-word so the UI feels alive.
        for word in reply.split_inclusive(' ') {
            emit_delta(&self.app, session_id, &message_id, word);
            tokio::time::sleep(tokio::time::Duration::from_millis(12)).await;
        }

        assistant.content = reply;
        assistant.tool_calls = tool_calls;
        assistant.created_at = now_ms();
        self.sessions.push(session_id, assistant.clone());
        emit_message(&self.app, session_id, assistant);
        emit_done(&self.app, session_id, start.elapsed().as_millis() as i64);
        Ok(())
    }

    async fn cancel(&self) {
        // No-op for mock.
    }
}

async fn extract_host(lower: &str, store: &Store) -> Option<String> {
    let profiles = store.list_profiles().await.ok()?;
    // Prefer an exact id or name match.
    for p in &profiles {
        let search = format!("{} ", p.name.to_lowercase());
        if lower.contains(&search) || lower == p.name.to_lowercase() {
            return Some(p.id.clone());
        }
        if lower.contains(&format!("{} ", p.id.to_lowercase())) {
            return Some(p.id.clone());
        }
    }
    // Fall back to first configured host if the user says "the server" etc.
    if lower.contains("server") || lower.contains("主机") || lower.contains("服务器") {
        profiles.first().map(|p| p.id.clone())
    } else {
        None
    }
}

fn extract_command(text: &str) -> String {
    // Very naive: take everything after "run" or "执行" or "运行".
    let lower = text.to_lowercase();
    let markers = ["run ", "执行", "运行"];
    for m in markers {
        if let Some(pos) = lower.find(m) {
            let start = pos + m.chars().count();
            return text[start..].trim().trim_matches('"').to_string();
        }
    }
    text.to_string()
}
