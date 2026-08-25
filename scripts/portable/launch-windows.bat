@echo off
REM OpsPilot launcher for Windows.
REM Opens OpsPilot in a real app window (Edge/Chrome --app mode).
REM No install, no admin rights. This file lives next to index.html in the
REM portable bundle (copied there by scripts/package-portable.mjs).

set "HERE=%~dp0"
set "INDEX=%HERE%index.html"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"

if not exist "%EDGE%" (
  echo Neither Microsoft Edge nor Google Chrome was found.
  echo Install one of them, then re-run this launcher.
  pause
  exit /b 1
)

start "" "%EDGE%" --app="file:///%INDEX:\=/%" --window-size=1440,900 --new-window
exit /b 0
