use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

/// A frontend-friendly error type. The `message` is shown to the user; the
/// `kind` lets the UI decide whether to retry / prompt for a password / etc.
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppError {
    #[error("{message}")]
    Generic { message: String },
    #[error("Host not found: {profile_id}")]
    ProfileNotFound { profile_id: String },
    #[error("Terminal not found: {term_id}")]
    TerminalNotFound { term_id: String },
    #[error("SSH error: {message}")]
    Ssh { message: String },
    #[error("Authentication failed for {profile_label}")]
    AuthFailed { profile_label: String },
    #[error("Host key rejected: {message}")]
    HostKeyRejected { message: String },
    #[error("Approval denied for: {command}")]
    ApprovalDenied { command: String },
    #[error("AI engine error: {message}")]
    AiEngine { message: String },
    #[error("MCP server error: {message}")]
    Mcp { message: String },
    #[error("Missing secret for profile {profile_id}")]
    MissingSecret { profile_id: String },
}

impl AppError {
    pub fn generic(message: impl Into<String>) -> Self {
        AppError::Generic {
            message: message.into(),
        }
    }

    pub fn ssh(message: impl Into<String>) -> Self {
        AppError::Ssh {
            message: message.into(),
        }
    }

    pub fn ai_engine(message: impl Into<String>) -> Self {
        AppError::AiEngine {
            message: message.into(),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::Generic {
            message: value.to_string(),
        }
    }
}

impl From<Arc<anyhow::Error>> for AppError {
    fn from(value: Arc<anyhow::Error>) -> Self {
        AppError::Generic {
            message: value.to_string(),
        }
    }
}

#[cfg(feature = "ssh-real")]
impl From<russh::Error> for AppError {
    fn from(value: russh::Error) -> Self {
        AppError::Ssh {
            message: value.to_string(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Generic {
            message: value.to_string(),
        }
    }
}

impl From<keyring::Error> for AppError {
    fn from(value: keyring::Error) -> Self {
        AppError::Generic {
            message: format!("Credential store error: {value}"),
        }
    }
}
