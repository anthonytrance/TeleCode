$ErrorActionPreference = "Stop"

$repo = $PSScriptRoot
$defaultWorkspace = Resolve-Path (Join-Path $repo "..\..")
$workspace = if ($env:CODEX_WORKSPACE) { $env:CODEX_WORKSPACE } else { $defaultWorkspace.Path }
$logs = Join-Path $repo "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Location $repo
$entry = Join-Path $repo "dist\index.js"

function Get-ChildProcesses {
  param([int]$ParentProcessId)

  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ParentProcessId }
}

function Test-HasTeleCodeNodeDescendant {
  param([int]$RootProcessId)

  $queue = @($RootProcessId)
  while ($queue.Count -gt 0) {
    $parent = $queue[0]
    $queue = @($queue | Select-Object -Skip 1)

    foreach ($child in Get-ChildProcesses -ParentProcessId $parent) {
      if ($child.Name -eq "node.exe" -and (
        $child.CommandLine -match [regex]::Escape($entry) -or
        $child.CommandLine -match "dist\\index\.js"
      )) {
        return $true
      }

      $queue += [int]$child.ProcessId
    }
  }

  return $false
}

function Remove-StaleTeleCodeWrappers {
  $scriptPathPattern = [regex]::Escape((Join-Path $repo "start-telecode.ps1"))
  $wrappers = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -match "^(?:powershell|pwsh)(?:\.exe)?$" -and
    $_.CommandLine -match $scriptPathPattern
  }

  foreach ($wrapper in $wrappers) {
    if (-not (Test-HasTeleCodeNodeDescendant -RootProcessId ([int]$wrapper.ProcessId))) {
      try {
        Stop-Process -Id ([int]$wrapper.ProcessId) -Force -ErrorAction Stop
      } catch {
        Write-Warning "Failed to stop stale TeleCode wrapper PID $($wrapper.ProcessId): $($_.Exception.Message)"
      }
    }
  }
}

Remove-StaleTeleCodeWrappers

$env:Path = "$env:APPDATA\npm;C:\Program Files\nodejs;$env:Path"
$env:HOME = $env:USERPROFILE
# The bridge loads its configured default from .env. Do not let a model value
# inherited from an older bridge process override it after a restart.
Remove-Item Env:CODEX_MODEL -ErrorAction SilentlyContinue
if (-not $env:CODEX_HOME) {
  $env:CODEX_HOME = Join-Path $env:USERPROFILE ".codex"
}
$env:CODEX_WORKSPACE = $workspace

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $logs "manual-$stamp.out.log"
$err = Join-Path $logs "manual-$stamp.err.log"

Write-Host "Starting TeleCode from $repo"
Write-Host "Workspace: $workspace"
Write-Host "Logs:"
Write-Host "  $out"
Write-Host "  $err"
Write-Host "Press Ctrl+C to stop."

$process = Start-Process `
  -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList @($entry) `
  -WorkingDirectory $repo `
  -NoNewWindow `
  -Wait `
  -PassThru `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err

exit $process.ExitCode
