//! AI session persistence and event helpers.

use crate::protocol::{AiMessage, AiRole, AiSession, AiSessionDetail, now_ms};
use crate::store::Store;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, warn};

pub struct SessionStore {
    store: Arc<Store>,
    sessions: Arc<RwLock<HashMap<String, Vec<AiMessage>>>>,
}

impl SessionStore {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn new_session(
        &self,
        profile_id: Option<String>,
        title: Option<String>,
    ) -> crate::error::AppResult<AiSession> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let session = AiSession {
            session_id: session_id.clone(),
            title: title.unwrap_or_else(|| "New chat".to_string()),
            profile_id,
            created_at: now,
            updated_at: now,
            message_count: 0,
        };
        self.sessions.write().insert(session_id, Vec::new());
        // TODO: persist sessions to disk for durability.
        Ok(session)
    }

    pub async fn list(&self) -> crate::error::AppResult<Vec<AiSession>> {
        let guard = self.sessions.read();
        let mut sessions: Vec<AiSession> = guard
            .iter()
            .map(|(id, msgs)| AiSession {
                session_id: id.clone(),
                title: msgs
                    .iter()
                    .find(|m| m.role == AiRole::User)
                    .map(|m| truncate(&m.content, 40))
                    .unwrap_or_else(|| "Chat".to_string()),
                profile_id: None,
                created_at: msgs.first().map(|m| m.created_at).unwrap_or(now_ms()),
                updated_at: msgs.last().map(|m| m.created_at).unwrap_or(now_ms()),
                message_count: msgs.len(),
            })
            .collect();
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(sessions)
    }

    pub async fn get(
        &self,
        session_id: &str,
    ) -> crate::error::AppResult<AiSessionDetail> {
        let guard = self.sessions.read();
        let messages = guard
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let session = AiSession {
            session_id: session_id.to_string(),
            title: messages
                .iter()
                .find(|m| m.role == AiRole::User)
                .map(|m| truncate(&m.content, 40))
                .unwrap_or_else(|| "Chat".to_string()),
            profile_id: None,
            created_at: messages.first().map(|m| m.created_at).unwrap_or(now_ms()),
            updated_at: messages.last().map(|m| m.created_at).unwrap_or(now_ms()),
            message_count: messages.len(),
        };
        Ok(AiSessionDetail { session, messages })
    }

    pub fn push(&self, session_id: &str, message: AiMessage) {
        let mut guard = self.sessions.write();
        guard
            .entry(session_id.to_string())
            .or_default()
            .push(message);
    }

    pub fn messages(&self, session_id: &str) -> Vec<AiMessage> {
        self.sessions
            .read()
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn update_title(&self, session_id: &str, title: String) {
        // Titles are derived from first user message; no-op for in-memory store.
    }
}

fn truncate(s: &str, len: usize) -> String {
    if s.chars().count() <= len {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(len).collect::<String>())
    }
}
