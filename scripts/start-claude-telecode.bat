@echo off
cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0start-claude-telecode.ps1" %*
