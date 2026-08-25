//! Real SSH client built on russh (enabled with `--features ssh-real`).
//!
//! Requires a C toolchain because russh's crypto backend compiles native code.
//! One connection per terminal tab; PTY channels feed the frontend via
//! `term:data` Tauri events. A separate `exec` path gives the AI a
//! deterministic stdout/stderr/exit code.

use crate::error::{AppError, AppResult};
use crate::protocol::{
    now_ms, ExecResult, HostFacts, OpenTerminalArgs, TerminalInfo, TerminalStatus, TermDataEvent,
    TermExitEvent, TermStatusEvent,
};
use crate::secret;
use crate::store::{HostKeyTrust, Store};
use base64::Engine as _;
use parking_lot::RwLock;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

pub struct SshManager {
    app: tauri::AppHandle,
    store: Arc<Store>,
    terminals: Arc<RwLock<HashMap<String, TerminalHandle>>>,
}

struct TerminalHandle {
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

impl SshManager {
    pub fn new(app: tauri::AppHandle, store: Arc<Store>) -> Self {
        Self {
            app,
            store,
            terminals: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn open_terminal(&self, args: OpenTerminalArgs) -> AppResult<TerminalInfo> {
        let profile = self
            .store
            .get_profile(&args.profile_id)
            .await?
            .ok_or_else(|| AppError::ProfileNotFound {
                profile_id: args.profile_id.clone(),
            })?;

        let term_id = uuid::Uuid::new_v4().to_string();
        let label = profile.label();
        let app = self.app.clone();

        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        self.terminals.write().insert(term_id.clone(), TerminalHandle { tx });

        let store = self.store.clone();
        let terminals = self.terminals.clone();
        let term_id2 = term_id.clone();
        tauri::async_runtime::spawn(async move {
            let result = connection_loop(
                app.clone(),
                store,
                &term_id2,
                profile,
                args.cols,
                args.rows,
                args.secret,
                &mut rx,
            )
            .await;
            terminals.write().remove(&term_id2);
            match result {
                Ok((code, reason)) => {
                    let _ = app.emit(
                        crate::protocol::evt::TERM_EXIT,
                        TermExitEvent {
                            term_id: term_id2,
                            code,
                            reason,
                        },
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        crate::protocol::evt::TERM_STATUS,
                        TermStatusEvent {
                            term_id: term_id2,
                            status: TerminalStatus::Error,
                            message: Some(e.to_string()),
                        },
                    );
                }
            }
        });

        Ok(TerminalInfo {
            term_id: term_id.clone(),
            profile_id: args.profile_id,
            title: label,
            status: TerminalStatus::Connecting,
            message: None,
        })
    }

    pub fn write_terminal(&self, term_id: &str, data: &[u8]) -> AppResult<()> {
        let guard = self.terminals.read();
        let handle = guard
            .get(term_id)
            .ok_or_else(|| AppError::TerminalNotFound {
                term_id: term_id.to_string(),
            })?;
        handle
            .tx
            .send(data.to_vec())
            .map_err(|_| AppError::TerminalNotFound {
                term_id: term_id.to_string(),
            })?;
        Ok(())
    }

    pub fn close_terminal(&self, term_id: &str) -> AppResult<()> {
        let guard = self.terminals.read();
        let handle = guard
            .get(term_id)
            .ok_or_else(|| AppError::TerminalNotFound {
                term_id: term_id.to_string(),
            })?;
        let _ = handle.tx.send(Vec::new());
        Ok(())
    }

    pub fn resize_terminal(&self, term_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        let msg = format!("\x1b]9001;{};{}\x07", cols, rows).into_bytes();
        self.write_terminal(term_id, &msg)
    }

    pub fn list_terminals(&self) -> Vec<TerminalInfo> {
        let guard = self.terminals.read();
        guard
            .keys()
            .map(|id| TerminalInfo {
                term_id: id.clone(),
                profile_id: String::new(),
                title: String::new(),
                status: TerminalStatus::Ready,
                message: None,
            })
            .collect()
    }

    /// Run a non-interactive command on `profile_id` and return stdout/stderr.
    /// This is the path used by the AI copilot.
    pub async fn exec(
        &self,
        profile_id: &str,
        command: &str,
        max_bytes: usize,
    ) -> AppResult<ExecResult> {
        let profile = self
            .store
            .get_profile(profile_id)
            .await?
            .ok_or_else(|| AppError::ProfileNotFound {
                profile_id: profile_id.to_string(),
            })?;
        let secret = self.fetch_secret(&profile).await?;
        let mut handle = connect_and_auth(&profile, secret.as_deref(), self.store.clone()).await?;
        exec_on_handle(&mut handle, command, max_bytes).await
    }

    pub async fn write_remote_file(
        &self,
        profile_id: &str,
        path: &str,
        content: &str,
    ) -> AppResult<()> {
        let qpath = sh_quote(path);
        let cmd = format!("cat > {qpath} << 'OPS_EOF'\n{content}\nOPS_EOF");
        let res = self.exec(profile_id, &cmd, 1024).await?;
        if res.exit_code != Some(0) {
            return Err(AppError::ssh(format!(
                "failed to write {}: {}",
                path,
                res.stderr
            )));
        }
        Ok(())
    }

    pub async fn read_remote_file(
        &self,
        profile_id: &str,
        path: &str,
        max_bytes: usize,
    ) -> AppResult<String> {
        let qpath = sh_quote(path);
        let cmd = format!("cat {qpath}");
        let res = self.exec(profile_id, &cmd, max_bytes).await?;
        if res.exit_code != Some(0) {
            return Err(AppError::ssh(format!(
                "failed to read {}: {}",
                path,
                res.stderr
            )));
        }
        Ok(res.stdout)
    }

    pub async fn collect_host_facts(&self, profile_id: &str) -> AppResult<HostFacts> {
        let mut facts = HostFacts {
            profile_id: profile_id.to_string(),
            ..Default::default()
        };

        let script = r#"echo "OS:$(uname -s -r 2>/dev/null)"
echo "KERNEL:$(uname -r 2>/dev/null)"
echo "UPTIME:$(uptime -p 2>/dev/null || uptime 2>/dev/null)"
echo "CPU:$(lscpu 2>/dev/null | grep 'Model name' | cut -d: -f2 | sed 's/^ *//' || echo unknown)"
echo "CORES:$(nproc 2>/dev/null || echo 1)"
echo "LOAD:$(cat /proc/loadavg 2>/dev/null || echo unknown)"
echo "MEM:$(free -h 2>/dev/null | awk '/^Mem:/{print $2","$3}')"
echo "DISK:$(df -h 2>/dev/null | awk 'NR>1 {print $6","$2","$3","$4","$5}')""#;

        let res = self.exec(profile_id, script, 4096).await?;
        if res.exit_code != Some(0) {
            warn!(stderr = %res.stderr, "host facts script returned non-zero");
        }

        for line in res.stdout.lines() {
            if let Some((k, v)) = line.split_once(':') {
                match k {
                    "OS" => facts.os = v.trim().to_string(),
                    "KERNEL" => facts.kernel = v.trim().to_string(),
                    "UPTIME" => facts.uptime = v.trim().to_string(),
                    "CPU" => facts.cpu_model = v.trim().to_string(),
                    "CORES" => facts.cpu_cores = v.trim().parse().unwrap_or(1),
                    "LOAD" => facts.load_avg = v.trim().to_string(),
                    "MEM" => {
                        let parts: Vec<&str> = v.split(',').collect();
                        if parts.len() == 2 {
                            facts.mem_total = parts[0].trim().to_string();
                            facts.mem_used = parts[1].trim().to_string();
                        }
                    }
                    "DISK" => {
                        for disk in v.split(';') {
                            let p: Vec<&str> = disk.split(',').collect();
                            if p.len() == 5 {
                                if let Ok(pct) = p[4].trim_end_matches('%').parse::<u32>() {
                                    facts.disks.push(crate::protocol::DiskUsage {
                                        mount: p[0].to_string(),
                                        size: p[1].to_string(),
                                        used: p[2].to_string(),
                                        avail: p[3].to_string(),
                                        percent: pct,
                                    });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        facts.collected_at = now_ms();
        Ok(facts)
    }

    async fn fetch_secret(&self, profile: &crate::protocol::HostProfile) -> AppResult<Option<String>> {
        if !profile.save_secret {
            return Ok(None);
        }
        secret::get(&profile.id).await
    }
}

// ---------------------------------------------------------------------------
// Connection + channel lifecycle
// ---------------------------------------------------------------------------

struct ClientHandler;

#[russh::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn connect_and_auth(
    profile: &crate::protocol::HostProfile,
    provided_secret: Option<&str>,
    store: Arc<Store>,
) -> AppResult<client::Handle<ClientHandler>> {
    let addr = (profile.host.as_str(), profile.port);
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        keepalive_interval: Some(Duration::from_secs(15)),
        ..<_>::default()
    };
    let config = Arc::new(config);

    let mut handle = client::connect(config, addr, ClientHandler {}).await?;

    let stored_secret = if profile.save_secret {
        crate::secret::get(&profile.id).await?
    } else {
        None
    };
    let secret = provided_secret.or_else(|| stored_secret.as_deref());

    let user = profile.username.clone();

    let auth_ok = match profile.auth_kind {
        crate::protocol::AuthKind::Password => {
            let password = secret.ok_or_else(|| AppError::MissingSecret {
                profile_id: profile.id.clone(),
            })?;
            handle
                .authenticate_password(user, password)
                .await?
                .success()
        }
        crate::protocol::AuthKind::Key => {
            let key_path = profile
                .key_path
                .as_deref()
                .ok_or_else(|| AppError::generic("key path not set"))?;
            let key_pair = load_secret_key(key_path, secret.map(|s| s.to_string()))
                .map_err(|e| AppError::ssh(format!("failed to load key: {e}")))?;
            handle
                .authenticate_publickey(
                    user,
                    PrivateKeyWithHashAlg::new(
                        Arc::new(key_pair),
                        handle.best_supported_rsa_hash().await?.flatten(),
                    ),
                )
                .await?
                .success()
        }
        crate::protocol::AuthKind::Agent => {
            handle.authenticate_none(user).await?.success()
        }
    };

    if !auth_ok {
        return Err(AppError::AuthFailed {
            profile_label: profile.label(),
        });
    }

    if !store
        .load_settings()
        .await
        .map(|s| s.strict_host_key_checking)
        .unwrap_or(true)
    {
        let _ = store
            .trust_host_key(&profile.host, profile.port, "accepted".into())
            .await;
    }

    Ok(handle)
}

/// PTY/shell loop for an interactive terminal tab.
async fn connection_loop(
    app: tauri::AppHandle,
    store: Arc<Store>,
    term_id: &str,
    profile: crate::protocol::HostProfile,
    cols: u32,
    rows: u32,
    provided_secret: Option<String>,
    input: &mut mpsc::UnboundedReceiver<Vec<u8>>,
) -> AppResult<(Option<u32>, String)> {
    let label = profile.label();

    emit_status(
        &app,
        term_id,
        TerminalStatus::Authenticating,
        Some(format!("Connecting to {}...", label)),
    );

    let mut handle = connect_and_auth(&profile, provided_secret.as_deref(), store).await?;
    let mut channel = handle.channel_open_session().await?;

    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await?;
    channel.request_shell(true).await?;

    emit_status(&app, term_id, TerminalStatus::Ready, None);

    for cmd in profile.init_commands {
        let line = format!("{}\r", cmd);
        channel.data(line.as_bytes()).await?;
    }

    let mut exit_code: Option<u32> = None;
    let mut exit_reason = String::new();

    loop {
        tokio::select! {
            Some(data) = input.recv() => {
                if data.is_empty() {
                    channel.eof().await?;
                } else if let Some(dims) = parse_resize_marker(&data) {
                    channel.window_change(dims.0, dims.1, 0, 0).await?;
                } else {
                    channel.data(&data[..]).await?;
                }
            }
            Some(msg) = channel.wait() => {
                match msg {
                    ChannelMsg::Data { ref data } => {
                        emit_data(&app, term_id, data);
                    }
                    ChannelMsg::ExtendedData { ref data, ext } => {
                        debug!(term_id, ext, bytes = data.len(), "extended data");
                        emit_data(&app, term_id, data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status);
                        exit_reason = "shell exited".to_string();
                        channel.eof().await?;
                    }
                    ChannelMsg::Close => {
                        exit_reason = "channel closed".to_string();
                        break;
                    }
                    ChannelMsg::Eof => {
                        exit_reason = "eof".to_string();
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = handle.disconnect(Disconnect::ByApplication, "closed by user", "English").await;
    Ok((exit_code, exit_reason))
}

async fn exec_on_handle(
    handle: &mut client::Handle<ClientHandler>,
    command: &str,
    max_bytes: usize,
) -> AppResult<ExecResult> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code: Option<u32> = None;

    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => {
                if stdout.len() < max_bytes {
                    stdout.extend_from_slice(data);
                }
            }
            Some(ChannelMsg::ExtendedData { ref data, ext }) => {
                if ext == 1 && stderr.len() < max_bytes {
                    stderr.extend_from_slice(data);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = Some(exit_status);
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
            None => break,
            _ => {}
        }
    }

    let stdout = String::from_utf8_lossy(&stdout[..stdout.len().min(max_bytes)]).to_string();
    let stderr = String::from_utf8_lossy(&stderr[..stderr.len().min(max_bytes)]).to_string();
    Ok(ExecResult {
        stdout,
        stderr,
        exit_code,
    })
}

fn emit_data(app: &tauri::AppHandle, term_id: &str, data: &[u8]) {
    let _ = app.emit(
        crate::protocol::evt::TERM_DATA,
        TermDataEvent {
            term_id: term_id.to_string(),
            base64: base64::engine::general_purpose::STANDARD.encode(data),
        },
    );
}

fn emit_status(
    app: &tauri::AppHandle,
    term_id: &str,
    status: TerminalStatus,
    message: Option<String>,
) {
    let _ = app.emit(
        crate::protocol::evt::TERM_STATUS,
        TermStatusEvent {
            term_id: term_id.to_string(),
            status,
            message,
        },
    );
}

fn parse_resize_marker(data: &[u8]) -> Option<(u32, u32)> {
    let s = String::from_utf8_lossy(data);
    let prefix = "\x1b]9001;";
    if !s.starts_with(prefix) || !s.ends_with('\x07') {
        return None;
    }
    let inner = &s[prefix.len()..s.len() - 1];
    let parts: Vec<&str> = inner.split(';').collect();
    if parts.len() != 2 {
        return None;
    }
    let cols = parts[0].parse().ok()?;
    let rows = parts[1].parse().ok()?;
    Some((cols, rows))
}

/// Naive POSIX shell single-quote: 'a'"'"'b' for any embedded single quote.
fn sh_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "._-/+=:@%".contains(c))
    {
        return s.into();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
