#!/bin/bash
# Template launcher for running TeleCode under launchd (macOS) or a service
# manager. Adjust REPO_DIR (and PATH if node lives elsewhere) for your machine.
REPO_DIR="${TELECODE_REPO_DIR:-$HOME/TeleCode}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$REPO_DIR" || exit 1
exec node dist/index.js
