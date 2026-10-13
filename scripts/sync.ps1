# Manual Git sync: fast-forward pull, then commit+push study summaries (allowlisted files only).
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
node server/cli.js sync
exit $LASTEXITCODE
