//! DeepSeek Harness (`dsh`) sidecar engine.
//!
//! In the MVP this engine is a placeholder that reports its configuration
//! status.  Fully wiring dsh requires resolving its headless/ACP interface,
//! which is still stabilising in v0.1.x.  The MCP server is already running,
//! so once dsh can be pointed at `mcp.url` with `mcp.token`, this module can
//! be expanded to spawn the process and proxy JSON-RPC.

use crate::ai::SessionStore;
use crate::error::AppResult;
use crate::protocol::{AiMessage, EngineKind, EngineStatus, McpInfo};
use crate::store::Store;
use async_trait::async_trait;
use std::sync::Arc;
use tauri::AppHandle;

pub struct DshEngine {
    app: AppHandle,
    store: Arc<Store>,
    mcp: McpInfo,
}

impl DshEngine {
    pub fn new(app: AppHandle, store: Arc<Store>, mcp: McpInfo) -> Self {
        Self { app, store, mcp }
    }
}

#[async_trait]
impl super::AiEngine for DshEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Dsh
    }

    async fn status(&self) -> EngineStatus {
        let configured = self.store.load_settings().await.ok().and_then(|s| s.dsh_path).is_some();
        EngineStatus {
            kind: EngineKind::Dsh,
            ready: false,
            detail: if configured {
                format!("dsh configured; MCP endpoint is {} (not yet wired in MVP)", self.mcp.url)
            } else {
                "dsh executable not configured; set it in Settings or use Mock/Direct".to_string()
            },
            needs_api_key: !configured,
        }
    }

    async fn send(
        &self,
        session_id: &str,
        _history: Vec<AiMessage>,
        _current: &str,
    ) -> AppResult<()> {
        super::emit_error(
            &self.app,
            session_id,
            "dsh engine is not yet implemented. Please switch to Mock or DeepSeek Direct in Settings.",
        );
        Ok(())
    }

    async fn cancel(&self) {}
}
