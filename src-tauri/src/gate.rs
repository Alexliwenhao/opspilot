//! Risk gate + human-in-the-loop approvals.
//!
//! Every command or file write initiated by the AI flows through here.  The
//! gate classifies risk, applies the configured policy, and (when required)
//! sends an approval request to the frontend and waits for the user decision.

use crate::error::{AppError, AppResult};
use crate::protocol::{
    ApprovalDecision, ApprovalKind, ApprovalRequest, ApprovalResolvedEvent, Risk,
};
use crate::store::Store;
use regex::Regex;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{oneshot, RwLock};
use tracing::{debug, warn};

pub struct GateHandle {
    store: Arc<Store>,
    app: tauri::AppHandle,
    pending: Arc<RwLock<HashMap<String, PendingApproval>>>,
}

struct PendingApproval {
    tx: oneshot::Sender<ApprovalDecision>,
}

impl GateHandle {
    pub fn new(store: Arc<Store>, app: tauri::AppHandle) -> Self {
        Self {
            store,
            app,
            pending: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Determine whether the AI may execute `command` on `host`.
    /// Returns Ok(()) if allowed, or an error if denied / timed out.
    pub async fn check_exec(
        &self,
        profile_id: &str,
        host_label: &str,
        command: &str,
        force_allow: bool,
    ) -> AppResult<()> {
        let (risk, reason) = classify_risk(command);
        let settings = self.store.load_settings().await.unwrap_or_default();

        // Policy: dangerous commands are only auto-allowed if the user has
        // explicitly enabled the override (and the policy is not "ask always").
        let auto = match (risk, settings.approval_policy) {
            (Risk::Safe, _) => true,
            (Risk::Caution, crate::protocol::ApprovalPolicy::AutoSafe) => false,
            (Risk::Caution, _) => true, // AutoCaution / Yolo
            (Risk::Dangerous, crate::protocol::ApprovalPolicy::Yolo) => settings.allow_dangerous,
            (Risk::Dangerous, _) => false,
        };

        if force_allow || auto {
            debug!(host = host_label, risk = ?risk, command, "auto-approved");
            return Ok(());
        }

        let decision = self
            .request_approval(profile_id, host_label, command, risk, reason, ApprovalKind::Exec)
            .await?;
        match decision {
            ApprovalDecision::Allow | ApprovalDecision::AlwaysAllow => Ok(()),
            ApprovalDecision::Deny => Err(AppError::ApprovalDenied {
                command: command.to_string(),
            }),
        }
    }

    /// Variant for file writes.
    pub async fn check_write(
        &self,
        profile_id: &str,
        host_label: &str,
        path: &str,
    ) -> AppResult<()> {
        let command = format!("write file {}", path);
        let decision = self
            .request_approval(
                profile_id,
                host_label,
                &command,
                Risk::Caution,
                "file modification on remote host".to_string(),
                ApprovalKind::WriteFile,
            )
            .await?;
        match decision {
            ApprovalDecision::Allow | ApprovalDecision::AlwaysAllow => Ok(()),
            ApprovalDecision::Deny => Err(AppError::ApprovalDenied { command }),
        }
    }

    async fn request_approval(
        &self,
        profile_id: &str,
        host_label: &str,
        command: &str,
        risk: Risk,
        reason: String,
        kind: ApprovalKind,
    ) -> AppResult<ApprovalDecision> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let settings = self.store.load_settings().await.unwrap_or_default();
        let expires_in_ms = (settings.approval_timeout_secs.max(5) * 1000) as i64;

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.write().await;
            pending.insert(request_id.clone(), PendingApproval { tx });
        }

        let req = ApprovalRequest {
            request_id: request_id.clone(),
            kind,
            host: host_label.to_string(),
            profile_id: profile_id.to_string(),
            command: command.to_string(),
            risk,
            reason,
            expires_in_ms,
            created_at: crate::protocol::now_ms(),
        };

        self.app
            .emit(crate::protocol::evt::APPROVAL_REQUEST, &req)
            .map_err(|e| AppError::generic(format!("failed to emit approval request: {e}")))?;

        let decision = tokio::time::timeout(Duration::from_millis(expires_in_ms as u64), rx)
            .await
            .map_err(|_| AppError::generic("approval request timed out"))?;

        let mut pending = self.pending.write().await;
        pending.remove(&request_id);

        let decision = decision.unwrap_or(ApprovalDecision::Deny);
        let resolved = ApprovalResolvedEvent {
            request_id,
            decision,
        };
        let _ = self.app.emit(crate::protocol::evt::APPROVAL_RESOLVED, &resolved);
        Ok(decision)
    }

    pub async fn resolve(&self, request_id: &str, decision: ApprovalDecision) -> AppResult<()> {
        let tx = {
            let mut pending = self.pending.write().await;
            pending.remove(request_id).map(|p| p.tx)
        };
        if let Some(tx) = tx {
            let _ = tx.send(decision);
        } else {
            warn!(request_id, "approval resolution received for unknown request");
        }
        let resolved = ApprovalResolvedEvent {
            request_id: request_id.to_string(),
            decision,
        };
        let _ = self.app.emit(crate::protocol::evt::APPROVAL_RESOLVED, &resolved);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

fn classify_risk(command: &str) -> (Risk, String) {
    let lower = command.to_lowercase();
    // Block outright regardless of policy.
    if matches_any(&lower, dangerous_patterns()) {
        return (
            Risk::Dangerous,
            "matches high-risk destructive pattern".to_string(),
        );
    }
    if matches_any(&lower, caution_patterns()) {
        return (
            Risk::Caution,
            "writes data or changes system state".to_string(),
        );
    }
    (Risk::Safe, "read-only or informational".to_string())
}

fn matches_any(s: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|re| re.is_match(s))
}

fn dangerous_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"\brm\s+-[a-zA-Z]*f\b.*(/|\\)\s*\b",
            r"\brm\b.*-rf\b",
            r"\bmkfs\.?\b",
            r"\bdd\b.*\bof\s*=\s*/dev/[sh]d",
            r"\bdd\b.*\bof\s*=\s*/dev/nvme",
            r"\b>:?\s*/dev/[sh]d",
            r"\bfdisk\b.*\b/dev/",
            r"\bparted\b.*\bmklabel\b",
            r"\bdrop\s+database\b",
            r"\bdrop\s+table\b",
            r"\bpasswd\s+-?[a-zA-Z]*\broot\b",
            r"\busermod\b.*-.*p",
            r"\bkill\s+-9\s+-1\b",
            r"\bshutdown\b",
            r"\breboot\b",
            r"\binit\s+0\b",
            r"\bpoweroff\b",
            r"\bsystemctl\b.*\bpoweroff\b",
            r"\bsystemctl\b.*\breboot\b",
        ]
        .into_iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    })
}

fn caution_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"\brm\b",
            r"\bmv\b",
            r"\bcp\b",
            r"\bchmod\b",
            r"\bchown\b",
            r"\bsudo\b",
            r"\bsu\b",
            r"\bkill\b",
            r"\bpkill\b",
            r"\bkillall\b",
            r"\bsystemctl\b.*\b(restart|stop|disable|mask)\b",
            r"\bservice\b.*\brestart\b",
            r"\bapt\b.*\b(remove|purge|autoremove)\b",
            r"\byum\b.*\b(remove|erase)\b",
            r"\bdnf\b.*\b(remove|erase)\b",
            r"\bapk\b.*\bdel\b",
            r"\bpacman\b.*\b-R\b",
            r"\bwget\b.*\b-O\s*-\b",
            r"\bcurl\b.*\b-o\b.*\b(sh|bash)\b",
            r"\b\.\s*/\b",
            r"\bsource\s+\b",
            r"\btee\b",
            r"\b>\s*\S+",
            r"\b>>\s*\S+",
        ]
        .into_iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    })
}
