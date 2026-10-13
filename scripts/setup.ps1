# One-time setup on a new PC (Windows PowerShell 5.1+). Safe to re-run.
#   .\scripts\setup.ps1                 check tools, init git if needed
#   .\scripts\setup.ps1 -CreateRepo     also create the PRIVATE GitHub repo (needs: gh auth login)
# It never edits global Claude Code settings and never installs VoiceStudio for you (see README).
param([switch]$CreateRepo, [string]$RepoName = "english-conversation-studio")
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Have($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
Write-Host "== Tools"
foreach ($t in @(@("node","required - https://nodejs.org"), @("git","required - https://git-scm.com"), @("claude","required for default backend - install Claude Code, then run 'claude' once to log in"), @("gh","needed for GitHub - https://cli.github.com , then: gh auth login"))) {
  Write-Host ("  {0,-7} {1}" -f $t[0], $(if (Have $t[0]) { "ok" } else { "MISSING: " + $t[1] }))
}
if (-not (Have node) -or -not (Have git)) { exit 1 }

Write-Host "== Git"
if (-not (Test-Path ".git")) { git init -b main | Out-Null; Write-Host "  initialized repository on branch main" } else { Write-Host "  repository present" }
if (-not (git config user.name))  { Write-Host "  note: git user.name is not set. Run: git config user.name `"Your Name`"" }
if (-not (git config user.email)) { Write-Host "  note: git user.email is not set. Run: git config user.email you@example.com" }

if ($CreateRepo) {
  if (-not (Have gh)) { Write-Host "  gh is missing; install it first."; exit 1 }
  gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { Write-Host "  Not logged in. Run:  gh auth login"; exit 1 }
  $remote = git remote get-url origin 2>$null
  if ($remote) { Write-Host "  origin already set: $remote (left unchanged)" }
  else {
    $login = gh api user --jq .login
    gh repo view "$login/$RepoName" *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  $login/$RepoName already exists on GitHub; connecting origin to it (no overwrite)."
      git remote add origin "https://github.com/$login/$RepoName.git"
    } else {
      gh repo create $RepoName --private --source . --remote origin
    }
  }
}

Write-Host "== Pull existing study history (fast-forward only)"
node server/cli.js sync
Write-Host ""
Write-Host "Done. Start with:  .\scripts\start.ps1   (or double-click start.cmd)"
Write-Host "Voice (optional): see README 'Voice setup'. Text mode works right now."
