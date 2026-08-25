//! Mock SSH backend (the default `mock-ssh` build, i.e. when `ssh-real` is off).
//!
//! A pure-Rust simulation so the entire app compiles and runs on machines
//! without a C toolchain (the agent sandbox, CI, etc.).  It provides a
//! functional echo terminal and canned command output so the UI, AI copilot
//! and approval gate can be exercised end-to-end.  For real hosts build with
//! `--features ssh-real` (which pulls in `russh`).
//!
//! The public surface mirrors `ssh_real::SshManager` exactly.

use crate::error::{AppError, AppResult};
use crate::protocol::{
    now_ms, ExecResult, HostFacts, OpenTerminalArgs, TerminalInfo, TerminalStatus, TermDataEvent,
    TermExitEvent, TermStatusEvent,
};
use crate::store::Store;
use base64::Engine as _;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::info;

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
        info!("mock SSH backend active (real SSH requires --features ssh-real)");
        Self {
            app,
            store,
            terminals: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn open_terminal(&self, args: OpenTerminalArgs) -> AppResult<TerminalInfo> {
        let _ = &args.profile_id;
        let term_id = uuid::Uuid::new_v4().to_string();
        let app = self.app.clone();

        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        self.terminals.write().insert(term_id.clone(), TerminalHandle { tx });

        let term_id2 = term_id.clone();
        tauri::async_runtime::spawn(async move {
            mock_shell_loop(app.clone(), &term_id2, &mut rx).await;
            let _ = app.emit(
                crate::protocol::evt::TERM_EXIT,
                TermExitEvent {
                    term_id: term_id2,
                    code: Some(0),
                    reason: "mock session closed".to_string(),
                },
            );
        });

        Ok(TerminalInfo {
            term_id: term_id.clone(),
            profile_id: args.profile_id,
            title: "mock-shell".to_string(),
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

    pub fn resize_terminal(&self, term_id: &str, _cols: u32, _rows: u32) -> AppResult<()> {
        // Nothing to do for the mock terminal.
        let _ = term_id;
        Ok(())
    }

    pub fn list_terminals(&self) -> Vec<TerminalInfo> {
        let guard = self.terminals.read();
        guard
            .keys()
            .map(|id| TerminalInfo {
                term_id: id.clone(),
                profile_id: String::new(),
                title: "mock-shell".to_string(),
                status: TerminalStatus::Ready,
                message: None,
            })
            .collect()
    }

    pub async fn exec(
        &self,
        _profile_id: &str,
        command: &str,
        max_bytes: usize,
    ) -> AppResult<ExecResult> {
        let (stdout, exit_code) = mock_exec(command);
        let stdout = if stdout.len() > max_bytes {
            stdout[..max_bytes].to_string()
        } else {
            stdout
        };
        Ok(ExecResult {
            stdout,
            stderr: String::new(),
            exit_code: Some(exit_code),
        })
    }

    pub async fn write_remote_file(
        &self,
        _profile_id: &str,
        _path: &str,
        _content: &str,
    ) -> AppResult<()> {
        Err(AppError::generic(
            "mock backend: file writes are disabled. Build with --features ssh-real to operate on real hosts.",
        ))
    }

    pub async fn read_remote_file(
        &self,
        _profile_id: &str,
        _path: &str,
        _max_bytes: usize,
    ) -> AppResult<String> {
        Err(AppError::generic(
            "mock backend: file reads are disabled. Build with --features ssh-real to operate on real hosts.",
        ))
    }

    pub async fn collect_host_facts(&self, profile_id: &str) -> AppResult<HostFacts> {
        Ok(HostFacts {
            profile_id: profile_id.to_string(),
            os: "MockLinux 6.8.0-mock".to_string(),
            kernel: "6.8.0-mock".to_string(),
            uptime: "up 3 days, 4:12".to_string(),
            cpu_model: "Mock CPU @ 3.20GHz".to_string(),
            cpu_cores: 8,
            load_avg: "0.42 0.38 0.31".to_string(),
            mem_total: "31Gi".to_string(),
            mem_used: "11Gi".to_string(),
            mem_percent: 35,
            disks: vec![crate::protocol::DiskUsage {
                mount: "/".to_string(),
                size: "200G".to_string(),
                used: "64G".to_string(),
                avail: "136G".to_string(),
                percent: 32,
            }],
            collected_at: now_ms(),
        })
    }
}

// ---------------------------------------------------------------------------
// Simulated shell
// ---------------------------------------------------------------------------

fn prompt() -> String {
    "mock$ ".to_string()
}

async fn mock_shell_loop(
    app: tauri::AppHandle,
    term_id: &str,
    rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
) {
    emit_status(&app, term_id, TerminalStatus::Connecting, Some("starting mock shell".into()));
    // Brief delay so the UI shows the connecting state.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    emit_status(&app, term_id, TerminalStatus::Ready, None);

    let banner = "OpsPilot mock shell — real SSH is disabled in this build.\r\n\
                  Type 'help' for available simulated commands.\r\n";
    emit_data(&app, term_id, banner.as_bytes());
    emit_data(&app, term_id, prompt().as_bytes());

    let mut line = String::new();
    while let Some(data) = rx.recv().await {
        if data.is_empty() {
            break; // close signal
        }
        // Echo printable bytes; handle CR as Enter.
        for &b in &data {
            if b == b'\r' || b == b'\n' {
                let cmd = line.trim().to_string();
                line.clear();
                emit_data(&app, term_id, "\r\n".as_bytes());
                run_line(&app, term_id, &cmd).await;
                emit_data(&app, term_id, prompt().as_bytes());
            } else if b == 0x7f || b == 0x08 {
                // backspace
                if !line.is_empty() {
                    line.pop();
                    emit_data(&app, term_id, &[0x08, b' ', 0x08]);
                }
            } else if b >= 0x20 {
                line.push(b as char);
                emit_data(&app, term_id, &[b]);
            }
        }
    }
}

async fn run_line(app: &tauri::AppHandle, term_id: &str, cmd: &str) {
    let (out, _code) = mock_exec(cmd);
    if !out.is_empty() {
        let mut s = out;
        if !s.ends_with('\n') {
            s.push('\n');
        }
        emit_data(app, term_id, s.as_bytes());
    }
}

/// Canned command output used by both the terminal and the AI `exec` path.
fn mock_exec(command: &str) -> (String, u32) {
    let cmd = command.trim();
    let lower = cmd.to_lowercase();

    if cmd.is_empty() {
        return (String::new(), 0);
    }
    if lower == "help" {
        return (
            "Simulated commands:\n\
             \x20 help            show this help\n\
             \x20 echo <text>     print text\n\
             \x20 ls [path]       list (mock)\n\
             \x20 pwd             print working directory\n\
             \x20 whoami          print user\n\
             \x20 uname -a        system info\n\
             \x20 date            current time\n\
             \x20 uptime          load average\n\
             \x20 df -h           disk usage\n\
             \x20 free -h         memory usage\n\
             \x20 cat <file>      read (mock files)\n\
             Everything else returns a mock notice. Real host access requires\n\
             the 'ssh-real' build feature.".to_string(),
            0,
        );
    }
    if lower == "pwd" {
        return ("/home/ops".to_string(), 0);
    }
    if lower == "whoami" {
        return ("ops".to_string(), 0);
    }
    if lower == "uname -a" || lower == "uname" {
        return ("MockLinux ops 6.8.0-mock #1 SMP x86_64 GNU/Linux".to_string(), 0);
    }
    if lower == "date" {
        return (
            chrono::Utc::now().format("%a %b %d %H:%M:%S UTC %Y").to_string(),
            0,
        );
    }
    if lower == "uptime" {
        return (" 09:00:00 up 3 days,  4:12,  load average: 0.42, 0.38, 0.31".to_string(), 0);
    }
    if lower == "df -h" || lower == "df" {
        return (
            "Filesystem      Size  Used Avail Use% Mounted on\n\
             /dev/mock       200G   64G  136G  32% /".to_string(),
            0,
        );
    }
    if lower == "free -h" || lower == "free" {
        return (
            "              total        used        free\n\
             Mem:           31Gi        11Gi        20Gi".to_string(),
            0,
        );
    }
    if lower.starts_with("echo ") {
        return (cmd[5..].to_string(), 0);
    }
    if lower == "ls" || lower.starts_with("ls ") {
        return (
            "bin  etc  home  opt  srv  tmp  usr  var\n\
             (mock listing)".to_string(),
            0,
        );
    }
    if lower.starts_with("cat ") {
        let f = &cmd[4..];
        if f.contains("passwd") || f.contains("shadow") || f.contains("id_rsa") {
            return (
                "mock: refusing to print a sensitive file in the demo backend".to_string(),
                1,
            );
        }
        return (format!("(mock) contents of {f}"), 0);
    }
    (
        format!(
            "mock-shell: '{cmd}' was not executed. Real host access requires the 'ssh-real' build feature."
        ),
        1,
    )
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
