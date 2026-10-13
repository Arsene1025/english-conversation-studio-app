# Start English Conversation Studio and open it in the default browser.
param([int]$Port = 4177, [string]$Backend = "claude-cli", [switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Node.js 20+ is required: https://nodejs.org"; exit 1 }
if ($Backend -eq "claude-cli" -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "Claude Code CLI not found. Install it and run 'claude' once to log in."; exit 1
}
$env:PORT = "$Port"
$env:COACH_BACKEND = $Backend
if (-not $NoBrowser) { Start-Job -ScriptBlock { param($u) Start-Sleep 2; Start-Process $u } -ArgumentList "http://127.0.0.1:$Port" | Out-Null }
node server/index.js
