//! Minimal Model Context Protocol (MCP) server.
//!
//! OpsPilot exposes SSH operations as MCP tools so that DeepSeek Harness
//! (running as a sidecar) can operate remote servers through a controlled,
//! permission-gated surface.
//!
//! This is a hand-rolled Streamable-HTTP-ish JSON-RPC 2.0 server.  We use a
//! single POST endpoint rather than SSE because every tool call is quick and
//! returns a complete response.

use crate::error::AppResult;
use crate::gate::GateHandle;
use crate::protocol::{McpInfo, Settings};
use crate::ssh::SshManager;
use crate::store::Store;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing::{debug, error, info, warn};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

pub struct McpServer {
    ssh: Arc<SshManager>,
    gate: Arc<GateHandle>,
    store: Arc<Store>,
}

impl McpServer {
    pub fn new(
        ssh: Arc<SshManager>,
        gate: Arc<GateHandle>,
        store: Arc<Store>,
    ) -> Self {
        Self { ssh, gate, store }
    }

    pub async fn start(&self) -> AppResult<McpInfo> {
        let token = generate_token();
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let url = format!("http://{}/mcp", addr);

        let state = AppState {
            ssh: self.ssh.clone(),
            gate: self.gate.clone(),
            store: self.store.clone(),
            token: token.clone(),
        };

        let app = Router::new()
            .route("/mcp", post(handle_mcp))
            .with_state(state);

        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        info!(url = %url, "MCP server started");
        Ok(McpInfo {
            url,
            token,
            tool_count: TOOLS.len(),
        })
    }
}

#[derive(Clone)]
struct AppState {
    ssh: Arc<SshManager>,
    gate: Arc<GateHandle>,
    store: Arc<Store>,
    token: String,
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

async fn handle_mcp(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Authorise.
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {}", state.token);
    if auth != expected {
        return error_response(None, -32001, "unauthorised", StatusCode::UNAUTHORIZED);
    }

    let req: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return error_response(None, -32700, format!("parse error: {e}"), StatusCode::OK);
        }
    };

    debug!(method = %req.method, "mcp request");

    let result = match req.method.as_str() {
        "initialize" => Ok(initialize()),
        "tools/list" => Ok(tools_list()),
        "tools/call" => call_tool(&state, req.params).await,
        _ => Err(JsonRpcError {
            code: -32601,
            message: format!("method not found: {}", req.method),
            data: None,
        }),
    };

    match result {
        Ok(result) => Json(JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(result),
            error: None,
        })
        .into_response(),
        Err(e) => Json(JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: None,
            error: Some(e),
        })
        .into_response(),
    }
}

fn error_response(id: Option<Value>, code: i32, message: impl Into<String>, status: StatusCode) -> Response {
    let resp = JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.into(),
            data: None,
        }),
    };
    (status, Json(resp)).into_response()
}

fn initialize() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "opspilot-mcp",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: &[(&str, &str, Value)] = &[
    (
        "ssh_list_hosts",
        "List every SSH host configured in OpsPilot. Returns id, label and group.",
        json!({
            "type": "object",
            "properties": {},
            "required": []
        }),
    ),
    (
        "ssh_host_facts",
        "Collect a short, read-only summary of the remote host (OS, CPU, memory, disk, load).",
        json!({
            "type": "object",
            "properties": {
                "profileId": { "type": "string", "description": "Host profile id" }
            },
            "required": ["profileId"]
        }),
    ),
    (
        "ssh_exec",
        "Run a non-interactive shell command on the selected host and return stdout/stderr/exit code. The user must approve risky commands before execution.",
        json!({
            "type": "object",
            "properties": {
                "profileId": { "type": "string" },
                "command": { "type": "string", "description": "Shell command to execute" },
                "context": { "type": "string", "description": "Optional one-line explanation of why the command is needed" }
            },
            "required": ["profileId", "command"]
        }),
    ),
    (
        "ssh_read_file",
        "Read the contents of a file on the remote host (base64 for binary).",
        json!({
            "type": "object",
            "properties": {
                "profileId": { "type": "string" },
                "path": { "type": "string", "description": "Absolute remote path" }
            },
            "required": ["profileId", "path"]
        }),
    ),
    (
        "ssh_write_file",
        "Write text content to a file on the remote host. This always requires user approval.",
        json!({
            "type": "object",
            "properties": {
                "profileId": { "type": "string" },
                "path": { "type": "string" },
                "content": { "type": "string", "description": "UTF-8 text to write" }
            },
            "required": ["profileId", "path", "content"]
        }),
    ),
];

fn tools_list() -> Value {
    let tools = TOOLS
        .iter()
        .map(|(name, desc, schema)| {
            json!({
                "name": name,
                "description": desc,
                "inputSchema": schema
            })
        })
        .collect::<Vec<_>>();
    json!({ "tools": tools })
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async fn call_tool(state: &AppState, params: Option<Value>) -> Result<Value, JsonRpcError> {
    let params = params.ok_or_else(|| JsonRpcError {
        code: -32602,
        message: "missing params".to_string(),
        data: None,
    })?;

    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JsonRpcError {
            code: -32602,
            message: "missing tool name".to_string(),
            data: None,
        })?;

    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let settings = state.store.load_settings().await.unwrap_or_default();

    match name {
        "ssh_list_hosts" => list_hosts(state).await,
        "ssh_host_facts" => host_facts(state, args).await,
        "ssh_exec" => exec(state, args, settings.max_output_bytes).await,
        "ssh_read_file" => read_file(state, args, settings.max_output_bytes).await,
        "ssh_write_file" => write_file(state, args).await,
        _ => Err(JsonRpcError {
            code: -32602,
            message: format!("unknown tool: {name}"),
            data: None,
        }),
    }
}

async fn list_hosts(state: &AppState) -> Result<Value, JsonRpcError> {
    let profiles = state
        .store
        .list_profiles()
        .await
        .map_err(|e| JsonRpcError {
            code: -32603,
            message: e.to_string(),
            data: None,
        })?;

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
    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string(&hosts).unwrap_or_default() }]
    }))
}

async fn host_facts(state: &AppState, args: Value) -> Result<Value, JsonRpcError> {
    let profile_id = get_str(&args, "profileId")?;
    let facts = state
        .ssh
        .collect_host_facts(&profile_id)
        .await
        .map_err(into_error)?;
    Ok(json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&facts).unwrap_or_default() }]
    }))
}

async fn exec(
    state: &AppState,
    args: Value,
    max_bytes: usize,
) -> Result<Value, JsonRpcError> {
    let profile_id = get_str(&args, "profileId")?;
    let command = get_str(&args, "command")?;

    let profile = state
        .store
        .get_profile(&profile_id)
        .await
        .map_err(into_error)?
        .ok_or_else(|| JsonRpcError {
            code: -32602,
            message: "profile not found".to_string(),
            data: None,
        })?;

    // Gate: ask for approval when required.
    if let Err(e) = state
        .gate
        .check_exec(&profile_id, &profile.label(), &command, false)
        .await
    {
        return Ok(json!({
            "content": [{ "type": "text", "text": format!("Approval required or denied: {e}") }],
            "isError": true
        }));
    }

    let result = state
        .ssh
        .exec(&profile_id, &command, max_bytes)
        .await
        .map_err(into_error)?;

    let text = format!(
        "exit_code: {}\nstdout:\n{}\nstderr:\n{}",
        result.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "none".into()),
        result.stdout,
        result.stderr
    );
    Ok(json!({
        "content": [{ "type": "text", "text": text }],
        "isError": result.exit_code != Some(0)
    }))
}

async fn read_file(
    state: &AppState,
    args: Value,
    max_bytes: usize,
) -> Result<Value, JsonRpcError> {
    let profile_id = get_str(&args, "profileId")?;
    let path = get_str(&args, "path")?;
    let content = state
        .ssh
        .read_remote_file(&profile_id, &path, max_bytes)
        .await
        .map_err(into_error)?;
    Ok(json!({
        "content": [{ "type": "text", "text": content }]
    }))
}

async fn write_file(state: &AppState, args: Value) -> Result<Value, JsonRpcError> {
    let profile_id = get_str(&args, "profileId")?;
    let path = get_str(&args, "path")?;
    let content = get_str(&args, "content")?;

    let profile = state
        .store
        .get_profile(&profile_id)
        .await
        .map_err(into_error)?
        .ok_or_else(|| JsonRpcError {
            code: -32602,
            message: "profile not found".to_string(),
            data: None,
        })?;

    if let Err(e) = state
        .gate
        .check_write(&profile_id, &profile.label(), &path)
        .await
    {
        return Ok(json!({
            "content": [{ "type": "text", "text": format!("Approval required or denied: {e}") }],
            "isError": true
        }));
    }

    state
        .ssh
        .write_remote_file(&profile_id, &path, &content)
        .await
        .map_err(into_error)?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("wrote {}", path) }]
    }))
}

fn get_str(args: &Value, key: &str) -> Result<String, JsonRpcError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| JsonRpcError {
            code: -32602,
            message: format!("missing required argument: {key}"),
            data: None,
        })
}

fn into_error(e: crate::error::AppError) -> JsonRpcError {
    JsonRpcError {
        code: -32603,
        message: e.to_string(),
        data: None,
    }
}
