OpsPilot — AI-native SSH Ops Console
======================================
Windows portable package (v%%VERSION%%)
Frontend + in-browser mock backend. No install, no admin rights.

WHAT THIS IS
  A double-click-to-run Windows package of OpsPilot. It ships the full UI
  (connection tree, multi-tab xterm terminal, AI copilot panel, risk-gate
  approval cards) with an in-browser mock backend, so you can evaluate the
  whole product flow without installing Rust, Node, or anything else.

HOW TO RUN (pick ONE)
  -- Option 1: app window (recommended, feels like a real desktop app) --
      Double-click  launch-windows.bat
      It opens OpsPilot in a clean app window via Microsoft Edge / Chrome
      "--app" mode (no browser address bar / tabs).

  -- Option 2: make a real .lnk shortcut (run once on your machine) --
      Right-click  make-shortcut.ps1  -> "Run with PowerShell"
      (or:  powershell -ExecutionPolicy Bypass -File make-shortcut.ps1)
      This writes "OpsPilot.lnk" next to it. Pin that to Start/Taskbar;
      double-clicking it launches OpsPilot as its own app window.

  -- Option 3: just open in browser --
      Double-click  index.html  (opens in your default browser).

REQUIREMENTS
  - Microsoft Edge OR Google Chrome (both preinstalled on most Windows 10/11).
  - No internet needed -- everything is bundled in this folder.

WHAT WORKS HERE
  - 3 seeded demo hosts in the connection tree.
  - Double-click a host -> simulated terminal. Try: help, df -h, free -h,
    uptime, ls, cat /etc/os-release.
  - AI copilot (right panel): "check disk space", "how much memory",
    "show uptime". The mock engine maps intent -> command, classifies risk,
    and for risky commands (e.g. "clean up old log files" ->
    `rm -rf /var/log/archive`) shows an approval card (Allow / Always / Deny).
  - Settings dialog (engine selector + API-key field; in-memory in this build).

WHAT IS SIMULATED
  - Terminal is a mock (canned responses); it does NOT open real SSH.
  - AI engine is a rule-based mock, not DeepSeek/dsh.

FOR THE REAL NATIVE WINDOWS APP (real SSH + DeepSeek dsh)
  See the project BUILD.md for the full installer flow:
    npm run tauri build                 # compiles the Rust/Tauri binary
    node scripts/package-portable.mjs   # stages it (+ this launcher)
    makensis scripts/installer.nsi      # -> OpsPilot-<v>-setup.exe
  (Those steps need Rust + a C toolchain + NSIS on YOUR machine; they cannot
   run in the original build sandbox, which blocks native compilation.)
