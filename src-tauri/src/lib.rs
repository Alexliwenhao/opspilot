mod ai;
mod commands;
mod engine;
mod error;
mod mcp;
mod protocol;
mod secret;
mod store;

// SSH backend selection.  The real russh-based backend needs a C toolchain
// (its crypto compiles native code).  The default `mock-ssh` build ships a
// pure-Rust simulated terminal so the whole app compiles and runs on machines
// without a C compiler (sandbox, CI, etc.).  Both expose the same
// `ssh::SshManager` surface.
#[cfg(feature = "ssh-real")]
mod ssh_real as ssh;
#[cfg(not(feature = "ssh-real"))]
mod ssh_mock as ssh;

use std::sync::Arc;
use tauri::Manager;
use tracing::{error, info};

pub fn run() {
    // Initialise logging so panics and traces show up in development.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("opspilot=debug")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = bootstrap(handle).await {
                    error!(error = %e, "bootstrap failed");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::open_terminal,
            commands::close_terminal,
            commands::write_terminal,
            commands::resize_terminal,
            commands::list_terminals,
            commands::ai_new_session,
            commands::ai_list_sessions,
            commands::ai_get_session,
            commands::ai_send,
            commands::ai_cancel,
            commands::approval_resolve,
            commands::approval_pending,
            commands::get_settings,
            commands::save_settings,
            commands::set_secret,
            commands::has_secret,
            commands::get_mcp_info,
            commands::engine_status,
            commands::host_facts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpsPilot");
}

async fn bootstrap(handle: tauri::AppHandle) -> anyhow::Result<()> {
    info!("OpsPilot bootstrapping");

    let store = Arc::new(store::Store::from_app(&handle));
    store.init().await?;

    let ssh_manager = Arc::new(ssh::SshManager::new(handle.clone(), store.clone()));
    let gate = Arc::new(gate::GateHandle::new(store.clone(), handle.clone()));
    let ai_store = Arc::new(ai::SessionStore::new(store.clone()));

    // Start the internal MCP server that exposes SSH tools to dsh.
    let mcp = mcp::McpServer::new(ssh_manager.clone(), gate.clone(), store.clone());
    let mcp_info = mcp.start().await?;

    // Build the AI engine adapter.
    let settings = store.load_settings().await.unwrap_or_default();
    let engine = engine::AiEngineHandle::new(
        settings.engine,
        handle.clone(),
        store.clone(),
        mcp_info.clone(),
        ssh_manager.clone(),
        gate.clone(),
        ai_store.clone(),
    )
    .await?;

    handle.manage(store);
    handle.manage(ssh_manager);
    handle.manage(gate);
    handle.manage(ai_store);
    handle.manage(Arc::new(mcp));
    handle.manage(mcp_info);
    handle.manage(engine);

    info!(mcp_url = %mcp_info.url, "ready");
    Ok(())
}
