# make-shortcut.ps1
# Creates a native Windows shortcut "OpsPilot.lnk" that launches OpsPilot
# in a real app window (Microsoft Edge --app mode, no browser chrome).
#
# Run ONCE on the user's machine:
#    powershell -ExecutionPolicy Bypass -File make-shortcut.ps1
# It writes OpsPilot.lnk next to this script (in the portable bundle root).
# After that, double-clicking OpsPilot.lnk opens OpsPilot as its own window,
# and you can pin it to the taskbar / Start menu.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$index = Join-Path $here "index.html"
$edge = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) {
  $edge = Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $edge)) {
  $edge = Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $edge)) {
  $edge = Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $edge)) { throw "Neither Edge nor Chrome found." }

$appUrl = "file:///" + ($index -replace "\\", "/")
$args = "--app=`"$appUrl`" --window-size=1440,900 --new-window"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $here "OpsPilot.lnk"))
$shortcut.TargetPath = $edge
$shortcut.Arguments = $args
$shortcut.WorkingDirectory = $here
$shortcut.Description = "OpsPilot - AI-native SSH ops console"
$shortcut.IconLocation = "$edge,0"
$shortcut.Save()

Write-Host "Created OpsPilot.lnk -> $edge $args"
