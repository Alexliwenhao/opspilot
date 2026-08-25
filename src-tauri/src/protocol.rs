//! Wire types shared with the frontend.
//!
//! Every struct here mirrors `src/ipc/contract.ts` one-to-one. Field names are
//! camelCased on the wire so the TypeScript side needs no translation layer.

use serde::{Deserialize, Serialize};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Host profiles
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Password,
    Key,
    Agent,
}

impl Default for AuthKind {
    fn default() -> Self {
        AuthKind::Password
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub save_secret: bool,
    #[serde(default)]
    pub init_commands: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_port() -> u16 {
    22
}

impl HostProfile {
    /// Label used in logs, AI prompts and approval dialogs.
    pub fn label(&self) -> String {
        if self.name.trim().is_empty() {
            format!("{}@{}:{}", self.username, self.host, self.port)
        } else {
            format!("{} ({}@{})", self.name, self.username, self.host)
        }
    }

    /// Keychain entry name for this profile's password or key passphrase.
    pub fn secret_key(&self) -> String {
        format!("profile:{}", self.id)
    }
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalStatus {
    Connecting,
    Authenticating,
    Ready,
    Closed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub term_id: String,
    pub profile_id: String,
    pub title: String,
    pub status: TerminalStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTerminalArgs {
    pub profile_id: String,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
    /// One-shot password / passphrase supplied by the user for this attempt.
    #[serde(default)]
    pub secret: Option<String>,
}

fn default_cols() -> u32 {
    120
}
fn default_rows() -> u32 {
    30
}

// ---------------------------------------------------------------------------
// Risk gate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Risk {
    Safe,
    Caution,
    Dangerous,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalPolicy {
    AskAlways,
    AutoSafe,
    AutoCaution,
    Yolo,
}

impl Default for ApprovalPolicy {
    fn default() -> Self {
        ApprovalPolicy::AutoSafe
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalKind {
    Exec,
    WriteFile,
    TerminalWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub request_id: String,
    pub kind: ApprovalKind,
    pub host: String,
    pub profile_id: String,
    pub command: String,
    pub risk: Risk,
    pub reason: String,
    pub expires_in_ms: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Allow,
    Deny,
    AlwaysAllow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolvedEvent {
    pub request_id: String,
    pub decision: ApprovalDecision,
}

// ---------------------------------------------------------------------------
// AI sessions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiRole {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    Running,
    Ok,
    Error,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCall {
    pub call_id: String,
    pub tool: String,
    pub summary: String,
    pub status: ToolStatus,
    pub detail: Option<String>,
    pub risk: Option<Risk>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub message_id: String,
    pub role: AiRole,
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<AiToolCall>,
    pub created_at: i64,
}

impl AiMessage {
    pub fn new(role: AiRole, content: impl Into<String>) -> Self {
        Self {
            message_id: uuid::Uuid::new_v4().to_string(),
            role,
            content: content.into(),
            tool_calls: Vec::new(),
            created_at: now_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    pub session_id: String,
    pub title: String,
    pub profile_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionDetail {
    pub session: AiSession,
    pub messages: Vec<AiMessage>,
}

// ---------------------------------------------------------------------------
// Command execution result (shared by real + mock SSH backends)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

// --- streaming events ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDeltaEvent {
    pub session_id: String,
    pub message_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessageEvent {
    pub session_id: String,
    pub message: AiMessage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolEvent {
    pub session_id: String,
    pub message_id: String,
    pub call: AiToolCall,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDoneEvent {
    pub session_id: String,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiErrorEvent {
    pub session_id: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Terminal events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermDataEvent {
    pub term_id: String,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermStatusEvent {
    pub term_id: String,
    pub status: TerminalStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermExitEvent {
    pub term_id: String,
    pub code: Option<u32>,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Engine + settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EngineKind {
    /// DeepSeek Harness (`dsh`) driven as a sidecar process.
    Dsh,
    /// Direct DeepSeek chat-completions API with native tool calling.
    DeepseekDirect,
    /// Offline rule-based copilot; always available, no API key needed.
    Mock,
}

impl Default for EngineKind {
    fn default() -> Self {
        EngineKind::Mock
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub kind: EngineKind,
    pub ready: bool,
    pub detail: String,
    pub needs_api_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub engine: EngineKind,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub approval_policy: ApprovalPolicy,
    #[serde(default)]
    pub allow_dangerous: bool,
    #[serde(default = "default_approval_timeout")]
    pub approval_timeout_secs: u64,
    #[serde(default = "default_true")]
    pub strict_host_key_checking: bool,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_theme")]
    pub theme: String,
    /// UI language: "en" or "zh".
    #[serde(default = "default_locale")]
    pub locale: String,
    #[serde(default)]
    pub dsh_path: Option<String>,
    #[serde(default = "default_max_output")]
    pub max_output_bytes: usize,
}

fn default_model() -> String {
    "deepseek-v4-pro".to_string()
}
fn default_base_url() -> String {
    "https://api.deepseek.com".to_string()
}
fn default_approval_timeout() -> u64 {
    120
}
fn default_true() -> bool {
    true
}
fn default_font_family() -> String {
    "JetBrains Mono, Cascadia Code, Consolas, Menlo, monospace".to_string()
}
fn default_font_size() -> u32 {
    13
}
fn default_theme() -> String {
    "dark".to_string()
}
fn default_locale() -> String {
    "en".to_string()
}
fn default_max_output() -> usize {
    24_000
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            engine: EngineKind::default(),
            model: default_model(),
            base_url: default_base_url(),
            approval_policy: ApprovalPolicy::default(),
            allow_dangerous: false,
            approval_timeout_secs: default_approval_timeout(),
            strict_host_key_checking: true,
            font_family: default_font_family(),
            font_size: default_font_size(),
            theme: default_theme(),
            locale: default_locale(),
            dsh_path: None,
            max_output_bytes: default_max_output(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub url: String,
    pub token: String,
    pub tool_count: usize,
}

// ---------------------------------------------------------------------------
// Host facts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub mount: String,
    pub size: String,
    pub used: String,
    pub avail: String,
    pub percent: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostFacts {
    pub profile_id: String,
    pub os: String,
    pub kernel: String,
    pub uptime: String,
    pub cpu_model: String,
    pub cpu_cores: u32,
    pub load_avg: String,
    pub mem_total: String,
    pub mem_used: String,
    pub mem_percent: u32,
    pub disks: Vec<DiskUsage>,
    pub collected_at: i64,
}

// ---------------------------------------------------------------------------
// SFTP file browser
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SftpEntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub kind: SftpEntryKind,
    pub size: u64,
    pub modified_at: i64,
    pub mode: String,
    pub owner: String,
    pub group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListing {
    pub profile_id: String,
    pub path: String,
    pub entries: Vec<SftpEntry>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDownloadInfo {
    pub download_id: String,
    pub bytes: u64,
    pub local_path: Option<String>,
}

// ---------------------------------------------------------------------------
// SSH tunnels (port forwarding)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TunnelStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub kind: TunnelKind,
    pub bind_address: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: TunnelStatus,
    pub message: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusEvent {
    pub tunnel_id: String,
    pub status: TunnelStatus,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Macro {
    pub id: String,
    pub name: String,
    pub steps: Vec<String>,
    pub shortcut: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Network tools
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NetToolKind {
    Ping,
    PortScan,
    WakeOnLan,
    DnsLookup,
    Traceroute,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetToolResult {
    pub tool: NetToolKind,
    pub target: String,
    pub ok: bool,
    pub output: String,
    pub duration_ms: u64,
    pub collected_at: i64,
}

// ---------------------------------------------------------------------------
// Terminal command history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub profile_id: String,
    pub term_id: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAppendEvent {
    pub entry: HistoryEntry,
}

// ---------------------------------------------------------------------------
// Event name constants (must match src/ipc/contract.ts EVT)
// ---------------------------------------------------------------------------

pub mod evt {
    pub const TERM_DATA: &str = "term:data";
    pub const TERM_STATUS: &str = "term:status";
    pub const TERM_EXIT: &str = "term:exit";

    pub const AI_DELTA: &str = "ai:delta";
    pub const AI_MESSAGE: &str = "ai:message";
    pub const AI_TOOL: &str = "ai:tool";
    pub const AI_DONE: &str = "ai:done";
    pub const AI_ERROR: &str = "ai:error";

    pub const APPROVAL_REQUEST: &str = "approval:request";
    pub const APPROVAL_RESOLVED: &str = "approval:resolved";

    pub const TUNNEL_STATUS: &str = "tunnel:status";
    pub const HISTORY_APPEND: &str = "history:append";
}
