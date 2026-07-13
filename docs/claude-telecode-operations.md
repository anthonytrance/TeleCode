# Claude and TeleCode Operations

This project has two safe Claude Code modes.

1. Integrated Claude through TeleCode

Use this when Anthony wants to talk to Claude from Telegram while TeleCode remains the Telegram bot.

Commands:

```text
/claude
hello
```

or:

```text
/claude hello
```

Model selection:

```text
/new claude opus
/model opus
```

Default integrated Claude model:

```text
claude-sonnet-5
```

`/new claude <model>` starts a fresh Claude session with that model. `/model <model>` sends Claude Code's model selection through the active Claude integration. Common values are `fable`, `best`, `claude-fable-5`, `claude-sonnet-5`, `sonnet`, `opus`, `haiku`, and `default`. If Claude Code rejects a model because it is unavailable, blocked by the account or organization, or requires usage credits, TeleCode reports the CLI error instead of saying the model changed.

If `CLAUDE_DEFAULT_MODEL=default` is explicitly set, TeleCode omits `--model` and lets Claude Code choose its local default. On 2026-07-01, a live smoke showed that this machine's local Claude default resolved to `claude-opus-4-8`, so the built-in TeleCode default is explicitly `claude-sonnet-5`.

Runtime rules:

- `ENABLE_CLAUDE_PROVIDER=true` must be set in `.env`.
- `CLAUDE_STRICT_MCP_CONFIG=true` should stay set while using the real `~/.claude` config.
- TeleCode strips inherited `CLAUDECODE` and `CLAUDE_CODE_*` variables before spawning Claude.
- TeleCode strips inherited `CLAUDE_CONFIG_DIR` unless an isolated config is explicitly configured.
- TeleCode scans Claude transcripts by file growth, not just by guessed session ID.
- If a persisted Claude session has no transcript file, TeleCode starts fresh instead of resuming a stale UUID.
- If Claude is working and another normal message arrives, TeleCode queues it as the next Claude turn instead of dropping it.
- If Claude is working and `/steer <instruction>` arrives, TeleCode sends it into the active Claude turn. PTY sessions type the instruction into the running Claude Code TUI; SDK sessions push it through the SDK streaming-input channel. If the turn is still starting and cannot accept live input yet, TeleCode falls back to queueing it as the next Claude follow-up.
- If Claude finishes while Codex is foreground, TeleCode sends the Claude final answer directly with a background header.

Self-test:

```powershell
npm run test:claude-tool-smoke
```

That test builds TeleCode, spawns Claude through the same provider adapter, makes Claude run a harmless PowerShell command, verifies tool events and final text, then kills the Claude process.

The bot-flow smoke test builds TeleCode, creates a local in-process bot with mocked Telegram sends, simulates `/claude <prompt>`, sends a second normal message to the active Claude session, verifies `/sessions` exposes a useful title, runs `/exit`, verifies the Claude PID registry is empty, starts Claude again and verifies a post-exit reply, then checks `/new claude opus` with a real response. It does not poll Telegram and does not send messages to Anthony.

Run the live Claude smoke tests serially. They both drive real interactive Claude processes and scan Claude's transcript directory, so running them in parallel can create false failures. The individual smoke scripts also share a lock under `.telecode/locks` to prevent accidental parallel runs from colliding.

2. Standalone Claude Code on the TeleCode repo

Use this when Claude should work directly in a normal interactive terminal session, separate from Telegram.

Safe launcher:

```powershell
C:\Users\Anthony\codetest\tools\telecode\scripts\start-claude-telecode.bat
```

Desktop launcher:

```powershell
C:\Users\Anthony\Desktop\Start Claude TeleCode.bat
```

Optional arguments:

```powershell
C:\Users\Anthony\codetest\tools\telecode\scripts\start-claude-telecode.bat -Model opus -PermissionMode acceptEdits
```

The launcher:

- Starts in `C:\Users\Anthony\codetest\tools\telecode`.
- Removes `CLAUDECODE`, `CLAUDE_CODE_*`, and `CLAUDE_CONFIG_DIR` from the environment.
- Uses `--strict-mcp-config`.
- Does not enable the Claude Telegram plugin.

`Start Claude Here.bat` and `Start Claude Telegram.bat` launch Claude with `plugin:telegram@claude-plugins-official`. They can run at the same time as TeleCode if that plugin uses a different Telegram bot token. They are unsafe only if they use the same bot token as TeleCode, because Telegram long polling conflicts per bot token.

For TeleCode repo development, prefer `Start Claude TeleCode.bat` anyway. It avoids the Telegram plugin entirely, strips inherited Claude/Codex session variables, and is easier to reason about when debugging transcripts.

TeleCode prints a startup notice if it sees a running Claude command line that includes `plugin:telegram`. That notice is informational unless the token is shared.

Operational rule

Only one process should own Telegram polling for the same bot token at a time.

- Normal operation: TeleCode owns Telegram polling. Integrated Claude runs as a child without the Telegram plugin.
- Standalone terminal Claude: no Telegram plugin. It can edit and test files directly.
- Legacy Claude Telegram bridge: can run alongside TeleCode if it uses a different bot token.

Current automated checks

```powershell
npm test
npm run test:claude-tool-smoke
```

`npm test` includes an offline bot-flow replay that verifies `/claude`, then normal text, routes to Claude, and `/claude <text>` runs as an inline Claude prompt without contacting Telegram.
