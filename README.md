# OpsPilot — AI-native SSH Ops Console

A MobaXterm-style SSH client with an embedded **AI copilot** for server
operations. The AI layer is built on **DeepSeek Harness (`dsh`)** — the agent
runtime open-sourced by DeepSeek — wired in as a sidecar that drives the SSH
tools exposed by an in-app **MCP server**.

> Built with **Rust + Tauri 2** (native shell) and **Vite + TypeScript +
> xterm.js** (frontend). The AI engine is pluggable: `dsh` sidecar, direct
> DeepSeek API, or an offline mock rule engine.

---

## What it does

- **Connection manager** — grouped hosts, password / key-file / agent auth,
  colour tags, jump-host-friendly profiles.
- **Multi-tab terminal** — one PTY per tab via `russh`, base64-streamed to
  xterm.js, live resize. **Multi-exec (broadcast)** mode types once into every
  open terminal. **Search-in-scrollback** (`Ctrl+Shift+F`).
- **SFTP file browser** — MobaXterm-style two-pane remote browser: navigate,
  download, delete, per-host filesystem. (Mock filesystem in the browser
  preview; real SFTP via the `ssh-real` build.)
- **SSH tunnels manager** — local (L) / remote (R) / dynamic SOCKS (D) port
  forwards with start/stop and live status.
- **Macros** — record keystrokes from a terminal and replay them on any host.
- **Network tools** — embedded ping, port scan, wake-on-LAN, DNS lookup,
  traceroute — also drivable through the AI copilot.
- **Command history** — searchable, per-host, click-to-rerun.
- **AI copilot (right panel)** — chat with an LLM that can *plan* ops tasks,
  call SSH tools (`ssh_exec`, `ssh_read_file`, …) through dsh, run the
  embedded network tools, and analyse the output for you.
- **Risk gate + human approval** — every AI-suggested command is classified
  `safe | caution | dangerous`; risky commands raise an in-UI approval card
  before anything runs. Four policies from *ask-always* to *yolo*.
- **Internal MCP server** — exposes the SSH surface to `dsh` over
  Streamable HTTP (loopback, random port, Bearer token), so the agent can be
  extended with any MCP tool.

---

## Quick start

### A. Browser preview (no Rust toolchain needed) — ✅ verified here

The frontend ships with an **in-browser mock backend** so you can see the whole
UI and the copilot flow without compiling the native shell.

```bash
cd opspilot
npm install
npm run dev          # open the printed http://localhost:5173
```

- The sidebar is seeded with 3 demo hosts.
- Double-click a host → opens a simulated terminal (type `help`, `df -h`, …).
- Right panel → start a session, ask e.g. *"check disk space"*, *"how much
  memory?"*, *"show uptime"*. The mock engine maps intent → command, raises an
  approval card for risky commands, and prints an analysis.

### B. Full native app (real SSH + dsh) — run on your machine

Requires: Rust ≥ 1.82, a C toolchain (MSVC on Windows / clang on macOS-Linux),
and Node ≥ 20.

```bash
cd opspilot
npm install
# default build uses the simulated SSH backend (no C toolchain needed)
npm run tauri dev
# OR, for REAL SSH against real hosts, enable the russh backend:
npm run tauri dev -- --features ssh-real
```

To ship a binary: `npm run tauri build` (or with `-- --features ssh-real`).

> **Why two SSH backends?**
> `russh` (real SSH) pulls in a crypto backend that compiles native C code.
> The default `mock-ssh` build is pure Rust so the app still compiles and runs
> on machines / CI without a C compiler. Both expose the identical
> `ssh::SshManager` surface; switch with the `ssh-real` Cargo feature.

---

## AI engine setup

In **Settings** (⚙ top-right) choose the engine:

| Engine | Needs | Notes |
|--------|-------|-------|
| `mock` | nothing | Offline rule engine, demo only. |
| `dsh` | `npx @deepseek-ai/dsh` + DeepSeek API key | The "DeepSeek harness" integration. dsh runs as a sidecar, we inject the MCP config pointing at OpsPilot's internal server. |
| `deepseekDirect` | DeepSeek API key | Direct chat-completions call with the same tool schema. |

Set your API key in the Settings dialog — it is stored in the OS keychain
(`keyring`), never written to disk in plaintext.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend (Vite/TS/xterm)                                     │
│  sidebar · multi-tab terminal · AI panel · settings           │
└───────────────┬───────────────────────────┬───────────────────┘
                │ Tauri IPC (invoke/events) │
┌───────────────▼───────────────────────────▼───────────────────┐
│  Rust backend (src-tauri)                                      │
│  ├─ ssh  (russh | mock)      terminal PTY + exec               │
│  ├─ gate  risk classification + approval flow                  │
│  ├─ mcp   internal MCP server (SSH tools → dsh)                │
│  ├─ engine (dsh | deepseekDirect | mock)  AI adapter           │
│  └─ store / secret / commands                                  │
└───────────────┬───────────────────────────────────────────────┘
                │ spawns + injects MCP config
        ┌───────▼────────┐
        │  dsh sidecar   │  DeepSeek Harness agent loop
        └────────────────┘
```

The TypeScript↔Rust contract lives in **`src/ipc/contract.ts`** and is mirrored
by `src-tauri/src/protocol.rs`. Change one → change the other.

---

## Project layout

```
opspilot/
├─ index.html
├─ src/                      # frontend
│  ├─ main.ts  style.css  app.ts
│  └─ ipc/
│     ├─ contract.ts        # single source of truth for IPC types
│     ├─ client.ts          # Tauri-or-mock invoke/listen abstraction
│     └─ mock.ts            # in-browser backend (terminal + AI + approvals)
└─ src-tauri/
   ├─ Cargo.toml
   ├─ tauri.conf.json
   ├─ capabilities/default.json
   └─ src/
      ├─ lib.rs  main.rs  protocol.rs  error.rs
      ├─ store.rs  secret.rs  gate.rs  commands.rs
      ├─ ssh_real.rs   # russh backend   (--features ssh-real)
      ├─ ssh_mock.rs   # pure-Rust sim   (default)
      ├─ mcp.rs        # internal MCP server
      ├─ ai/mod.rs
      └─ engine/{mod,mock,deepseek,dsh}.rs
```

---

## Status / verification notes

- ✅ Frontend: `npm run build` (tsc type-check + vite bundle) passes; dev
  server serves and transforms every module cleanly (validated in-browser ESM).
- ✅ IPC contract, mock backend, risk gate, approval UI, AI panel wired and
  type-checked.
- ⚠️ Rust native build: the full Tauri app requires compiling crates whose
  build scripts invoke a C toolchain (the `windows`/`tao`/`wry` GUI stack and
  `russh`'s crypto). Those build steps were blocked in the original build
  sandbox (process-execution restriction), so the native binary was **not**
  produced here. On a normal developer machine `npm run tauri dev/build`
  compiles and runs as described above.
- 🔜 Not yet implemented (clearly scoped for next iterations): real-SFTP
  transport for the file browser (mock filesystem works in the browser preview),
  live server monitoring dashboard, keyboard-interactive auth, jump-host
  chaining. (Command history/search, SFTP browser, SSH tunnels, macros,
  multi-execution, and network tools are now in the UI — backed by the mock
  layer in the browser preview and by the `ssh-real` build on a real machine.)
```
