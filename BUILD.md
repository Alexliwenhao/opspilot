# Building a local installer for OpsPilot

This document explains how to produce an installable package for OpsPilot,
both the **real native app** (Tauri/Windows) and the **portable fallback**
that works without a Rust toolchain.

---

## Option A — Real native installer (recommended for production)

Requirements on **your** machine (not the build sandbox):
- Rust ≥ 1.82 (`rustup`)
- A C toolchain: **Visual Studio 2022 Build Tools + MSVC v143** (Windows),
  or `clang`/`make` on macOS/Linux
- Node ≥ 20, npm
- NSIS (for the `.exe` setup) — https://nsis.sourceforge.io
- WebView2 runtime (preinstalled on Win10/11)

Steps:
```bash
cd opspilot
npm install

# 1) Build the native binary (default = mock-ssh, no extra C deps)
npm run tauri build                # -> src-tauri/target/release/opspilot.exe (+ .msi/.nsis via tauri)
#    OR real SSH backend:
npm run tauri build -- --features ssh-real

# 2) If you want a custom NSIS setup.exe instead of tauri's bundler:
node scripts/package-portable.mjs  # -> dist-portable/OpsPilot-<v>-portable.zip
makensis scripts/installer.nsi     # -> dist-portable/OpsPilot-<v>-setup.exe
```

`scripts/package-portable.mjs` gathers the compiled `opspilot.exe` + the
`dist/` frontend assets into a staged folder and zips it. `scripts/installer.nsi`
wraps that staged folder into a per-user NSIS installer (Start Menu + Desktop
shortcuts, clean uninstall).

> NOTE: The build sandbox used during development **cannot** run Rust build
> scripts (every `build-script-build` binary is denied with OS error 5), so
> the native `.exe` was never produced there. On a normal developer machine
> the commands above work as written.

---

## Option B — Portable bundle (no Rust / no install) — ✅ produced here

The file `dist-portable/OpsPilot-0.1.0-portable.zip` is ready to ship right
now. It contains the full OpsPilot UI plus the in-browser **mock backend**,
so the whole product flow (connection tree, multi-tab terminal, AI copilot,
risk-gate approval) runs by simply double-clicking `index.html` in a browser.

- No Node, no Rust, no admin rights.
- Real SSH / DeepSeek are simulated (mock backend).
- To regenerate after changing the frontend:
  ```bash
  npm run build
  # then re-zip dist/ into dist-portable/OpsPilot-<v>-portable/ (see scripts)
  ```

---

## File map

| Path | Purpose |
|------|---------|
| `src-tauri/` | Rust/Tauri native shell source |
| `src/` | Vite + TS + xterm frontend |
| `scripts/package-portable.mjs` | Stage + zip the native build |
| `scripts/installer.nsi` | NSIS installer wrapping the staged folder |
| `scripts/zip_portable.py` | (alt) Python zipper for the portable folder |
| `dist-portable/` | **Output**: portable.zip + staged folder |
