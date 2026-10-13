# Show Git sync state, study progress, last mode and VoiceStudio availability.
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)
node server/cli.js status
Write-Host ""
Write-Host "Tools:"
foreach ($t in "node","git","gh","claude","ffmpeg") {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  Write-Host ("  {0,-7} {1}" -f $t, $(if ($c) { "ok" } else { "missing" }))
}
if (Get-Command gh -ErrorAction SilentlyContinue) { gh auth status 2>&1 | Select-Object -First 3 }
