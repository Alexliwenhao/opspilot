//! Direct DeepSeek chat-completions engine with native tool calling.

use super::{emit_delta, emit_done, emit_error, emit_message, run_tool};
use crate::ai::SessionStore;
use crate::error::{AppError, AppResult};
use crate::gate::GateHandle;
use crate::protocol::{AiMessage, AiRole, AiToolCall, EngineKind, EngineStatus, ToolStatus, now_ms};
use crate::ssh::SshManager;
use crate::store::Store;
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tracing::{debug, error, warn};

const API_KEY_ENTRY: &str = "deepseek-api-key";

pub struct DirectEngine {
    app: AppHandle,
    ssh: Arc<SshManager>,
    gate: Arc<GateHandle>,
    store: Arc<Store>,
    sessions: Arc<SessionStore>,
    client: reqwest::Client,
}

impl DirectEngine {
    pub fn new(
        app: AppHandle,
        ssh: Arc<SshManager>,
        gate: Arc<GateHandle>,
        store: Arc<Store>,
        sessions: Arc<SessionStore>,
    ) -> AppResult<Self> {
        Ok(Self {
            app,
            ssh,
            gate,
            store,
            sessions,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|e| AppError::generic(format!("http client: {e}")))?,
        })
    }

    async fn api_key(&self) -> AppResult<String> {
        crate::secret::get(API_KEY_ENTRY)
            .await?
            .ok_or_else(|| AppError::AiEngine {
                message: "DeepSeek API key not set. Add it in Settings.".to_string(),
            })
    }

    async fn settings(&self) -> crate::protocol::Settings {
        self.store.load_settings().await.unwrap_or_default()
    }

    fn to_api_messages(&self, history: &[AiMessage]) -> Vec<Value> {
        history
            .iter()
            .map(|m| {
                let role = match m.role {
                    AiRole::User => "user",
                    AiRole::Assistant => "assistant",
                    AiRole::System => "system",
                    AiRole::Tool => "tool",
                };
                json!({
                    "role": role,
                    "content": m.content,
                    "tool_calls": if m.tool_calls.is_empty() {
                        None
                    } else {
                        Some(m.tool_calls.iter().map(|c| {
                            json!({
                                "id": c.call_id,
                                "type": "function",
                                "function": {
                                    "name": c.tool,
                                    "arguments": c.detail.as_deref().unwrap_or("{}")
                                }
                            })
                        }).collect::<Vec<_>>())
                    }
                })
            })
            .collect()
    }
}

#[async_trait]
impl super::AiEngine for DirectEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::DeepseekDirect
    }

    async fn status(&self) -> EngineStatus {
        let has_key = crate::secret::get(API_KEY_ENTRY).await.ok().flatten().is_some();
        EngineStatus {
            kind: EngineKind::DeepseekDirect,
            ready: has_key,
            detail: if has_key {
                "DeepSeek API ready".to_string()
            } else {
                "API key not configured".to_string()
            },
            needs_api_key: !has_key,
        }
    }

    async fn send(
        &self,
        session_id: &str,
        history: Vec<AiMessage>,
        current: &str,
    ) -> AppResult<()> {
        let start = Instant::now();
        let settings = self.settings().await;
        let api_key = self.api_key().await?;
        let base_url = settings.base_url.trim_end_matches('/');
        let url = format!("{}/chat/completions", base_url);

        let mut messages = self.to_api_messages(&history);
        messages.push(json!({"role": "user", "content": current}));

        let tools = tool_definitions();
        let body = json!({
            "model": settings.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "stream": true,
            "max_tokens": 4096
        });

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", api_key))
                .map_err(|e| AppError::generic(format!("invalid api key: {e}")))?,
        );

        let response = self
            .client
            .post(&url)
            .headers(headers.clone())
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::AiEngine {
                message: format!("request failed: {e}"),
            })?;

        if !response.status().is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(AppError::AiEngine {
                message: format!("DeepSeek API error: {}", text),
            });
        }

        // Stream response and collect assistant content + tool calls.
        let assistant_msg = AiMessage::new(AiRole::Assistant, "");
        let message_id = assistant_msg.message_id.clone();
        self.sessions.push(session_id, assistant_msg.clone());
        emit_message(&self.app, session_id, assistant_msg);

        let mut content_buf = String::new();
        let mut tool_calls_buf: Vec<PartialToolCall> = Vec::new();

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::AiEngine {
                message: format!("stream error: {e}"),
            })?;
            let text = String::from_utf8_lossy(&chunk);
            for line in text.lines() {
                let line = line.trim();
                if !line.starts_with("data: ") {
                    continue;
                }
                let payload = &line[6..];
                if payload == "[DONE]" {
                    break;
                }
                let delta: StreamDelta = match serde_json::from_str(payload) {
                    Ok(d) => d,
                    Err(e) => {
                        warn!(error = %e, payload, "failed to parse delta");
                        continue;
                    }
                };

                if let Some(choice) = delta.choices.first() {
                    if let Some(delta_content) = &choice.delta.content {
                        content_buf.push_str(delta_content);
                        emit_delta(&self.app, session_id, &message_id, delta_content);
                    }
                    for tc in &choice.delta.tool_calls {
                        let idx = tc.index.unwrap_or(0);
                        while tool_calls_buf.len() <= idx {
                            tool_calls_buf.push(PartialToolCall::default());
                        }
                        let slot = &mut tool_calls_buf[idx];
                        if let Some(id) = &tc.id {
                            slot.id.push_str(id);
                        }
                        if let Some(name) = &tc.function.name {
                            slot.name.push_str(name);
                        }
                        if let Some(args) = &tc.function.arguments {
                            slot.arguments.push_str(args);
                        }
                    }
                }
            }
        }

        // Execute any tool calls.
        let mut executed_tools: Vec<AiToolCall> = Vec::new();
        if !tool_calls_buf.is_empty() {
            for tc in &tool_calls_buf {
                let id = if tc.id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    tc.id.clone()
                };
                let args: Value = serde_json::from_str(&tc.arguments).unwrap_or(json!({}));
                let call = run_tool(
                    &self.app, &self.ssh, &self.gate, &self.store,
                    session_id, &message_id, &id, &tc.name, &args,
                ).await;
                executed_tools.push(call);
            }

            // Second API call with tool results.
            let mut messages = self.to_api_messages(&history);
            messages.push(json!({"role": "user", "content": current}));
            messages.push(json!({
                "role": "assistant",
                "content": content_buf,
                "tool_calls": tool_calls_buf.iter().map(|tc| {
                    json!({
                        "id": tc.id,
                        "type": "function",
                        "function": { "name": tc.name, "arguments": tc.arguments }
                    })
                }).collect::<Vec<_>>()
            }));
            for tc in &tool_calls_buf {
                if let Some(tool) = executed_tools.iter().find(|t| t.call_id == tc.id || (tc.id.is_empty() && t.tool == tc.name)) {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tool.call_id,
                        "content": tool.detail.as_deref().unwrap_or("")
                    }));
                }
            }

            let body = json!({
                "model": settings.model,
                "messages": messages,
                "stream": true,
                "max_tokens": 4096
            });

            let response = self
                .client
                .post(&url)
                .headers(headers)
                .json(&body)
                .send()
                .await
                .map_err(|e| AppError::AiEngine {
                    message: format!("request failed: {e}"),
                })?;

            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| AppError::AiEngine {
                    message: format!("stream error: {e}"),
                })?;
                let text = String::from_utf8_lossy(&chunk);
                for line in text.lines() {
                    let line = line.trim();
                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let payload = &line[6..];
                    if payload == "[DONE]" {
                        break;
                    }
                    if let Ok(delta) = serde_json::from_str::<StreamDelta>(payload) {
                        if let Some(choice) = delta.choices.first() {
                            if let Some(c) = &choice.delta.content {
                                content_buf.push_str(c);
                                emit_delta(&self.app, session_id, &message_id, c);
                            }
                        }
                    }
                }
            }
        }

        let mut assistant = AiMessage::new(AiRole::Assistant, content_buf.clone());
        assistant.message_id = message_id.clone();
        assistant.tool_calls = executed_tools;
        assistant.created_at = now_ms();
        self.sessions.push(session_id, assistant.clone());
        emit_message(&self.app, session_id, assistant);
        emit_done(&self.app, session_id, start.elapsed().as_millis() as i64);
        Ok(())
    }

    async fn cancel(&self) {
        // reqwest streams cannot be trivially cancelled mid-request from here;
        // the next turn will simply start fresh.
    }
}

#[derive(Default, Debug)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    delta: Delta,
}

#[derive(Debug, Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Debug, Deserialize, Default)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: FunctionDelta,
}

#[derive(Debug, Deserialize, Default)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "ssh_list_hosts",
                "description": "List every SSH host configured in OpsPilot.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "ssh_host_facts",
                "description": "Collect a read-only summary of the remote host (OS, CPU, memory, disk, load).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profileId": { "type": "string", "description": "Host profile id" }
                    },
                    "required": ["profileId"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "ssh_exec",
                "description": "Run a non-interactive shell command on the selected host. The user must approve risky commands.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profileId": { "type": "string" },
                        "command": { "type": "string" }
                    },
                    "required": ["profileId", "command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "ssh_read_file",
                "description": "Read the contents of a file on the remote host.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profileId": { "type": "string" },
                        "path": { "type": "string" }
                    },
                    "required": ["profileId", "path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "ssh_write_file",
                "description": "Write text content to a file on the remote host. Requires user approval.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profileId": { "type": "string" },
                        "path": { "type": "string" },
                        "content": { "type": "string" }
                    },
                    "required": ["profileId", "path", "content"]
                }
            }
        }),
    ]
}
