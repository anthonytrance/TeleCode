param(
  [string]$Workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$ClaudeBin = (Join-Path $env:USERPROFILE ".local\bin\claude.exe"),
  [string]$Model = "sonnet",
  [ValidateSet("default", "acceptEdits", "plan", "bypassPermissions")]
  [string]$PermissionMode = "acceptEdits"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ClaudeBin)) {
  throw "Claude binary not found: $ClaudeBin"
}
if (-not (Test-Path -LiteralPath $Workspace)) {
  throw "Workspace not found: $Workspace"
}

Get-ChildItem Env: | Where-Object {
  $_.Name -eq "CLAUDECODE" -or
  $_.Name -eq "CLAUDE_CONFIG_DIR" -or
  $_.Name -like "CLAUDE_CODE_*"
} | ForEach-Object {
  Remove-Item -LiteralPath "Env:$($_.Name)" -ErrorAction SilentlyContinue
}

Set-Location -LiteralPath $Workspace

$argsList = @(
  "--model", $Model,
  "--permission-mode", $PermissionMode,
  "--strict-mcp-config"
)

Write-Host "Starting standalone Claude Code for TeleCode."
Write-Host "Workspace: $Workspace"
Write-Host "Model: $Model"
Write-Host "Permission mode: $PermissionMode"
Write-Host "Telegram plugin: disabled via --strict-mcp-config"
Write-Host ""

& $ClaudeBin @argsList
exit $LASTEXITCODE
