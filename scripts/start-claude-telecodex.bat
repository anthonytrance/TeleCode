@echo off
cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0start-claude-telecodex.ps1" %*
