# Legacy launcher retained for existing installations after the TeleCode rename.
& (Join-Path $PSScriptRoot "start-claude-telecode.ps1") @args
exit $LASTEXITCODE
