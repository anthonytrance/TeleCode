# Claude Integration Hardening Plan

Status: active working plan.

Last updated: 2026-07-01 02:24 Europe/Brussels.

## Goal

Make Claude Code usable from TeleCodex with the same reliability expectations as Codex:

- predictable session discovery and titles
- no stale Claude child processes
- clear behavior for every Claude slash command
- safe provider switching between Codex and Claude
- useful foreground progress and background completion notices
- repeatable local tests that do not require Anthony to manually drive Telegram

This plan is scoped to TeleCodex first. Hermes reuse remains later work.

## Current Green Baseline

- Claude provider is enabled and uses interactive `claude.exe` through PTY.
- TeleCodex strips inherited Claude/Codex harness environment variables before spawning Claude.
- Transcript discovery uses known transcript growth, expected session IDs, and new transcript fallback.
- Transcript discovery has a prompt-text recovery fallback for missed file-growth detection.
- If Claude answers on screen but no transcript appears, TeleCodex captures a sanitized screen fallback or reports a screen tail instead of a bare "transcript was not created" error.
- Claude session titles update from transcript `ai-title`, with provisional prompt titles as fallback.
- Codex session titles resolve from Codex thread state instead of showing UUIDs.
- `/claude <prompt>` and `/claude`, then normal text, both route to Claude.
- Claude final answers are delivered from `assistant_message_complete` as the authoritative full answer. If the user switches providers while Claude is working, TeleCodex sends the final answer directly with a background header instead of only buffering a notice.
- Normal messages sent while Claude is busy are queued as the next Claude turn, replacing the previous queued Claude message.
- `/steer` while Claude is busy is allowed through TeleCodex command routing and queued as a Claude follow-up. It is not true live steering yet.
- `/exit`, `/clear`, replacement, context removal, shutdown, and fatal polling cleanup dispose Claude PTYs.
- TeleCodex-owned Claude PIDs are tracked and stale registered processes are cleaned on startup.
- Startup safety ignores old `cmd.exe` launcher wrappers and only treats actual `claude.exe` processes with the Telegram plugin as legacy Claude Telegram plugin processes.
- Claude Code fullscreen renderer prompt is dismissed automatically.
- TeleCodex launches integrated Claude with Telegram channel/plugin settings disabled and an appended system prompt that forbids self-sending Telegram messages.
- Default integrated Claude model is now `claude-sonnet-5`. The local installed Claude Code is `2.1.197`.
- Live checks exist:
  - `npm run test:claude-live`, serial provider plus bot-flow smoke
  - `npm run test:claude-tool-smoke`, tool-use smoke
  - `npm test`, unit suite

## Current Runtime Status

- The correct TeleCodex restart was run with `C:\Users\Anthony\codetest\restart_telecodex.bat`.
- The old TeleCodex node process PID 39960 was killed.
- A new TeleCodex node process started at 2026-07-01 02:20:11 as PID 16684.
- The old integrated Claude child PID 7904 was stopped before restart.
- No unexpected TeleCodex-owned `claude.exe` was visible after restart checks.

## Verified On 2026-07-01

- `npm run build`: passed.
- `npm test`: passed, 32 files, 316 tests.
- `npm run test:claude-tool-smoke`: passed with model `claude-sonnet-5`.
- The Sonnet 5 smoke transcript confirmed `claude-sonnet-5` in the assistant model field.
- A no-model smoke proved local Claude Code default currently resolved to `claude-opus-4-8`, so TeleCodex now explicitly defaults to `claude-sonnet-5` instead of relying on the local Claude default.

## Priority Work

1. Claude command coverage

The command table exists, but many `emulate` commands still return "not complete yet". Move from classified-only to handled:

- Already meaningful: `/compact`, `/clear`, `/copy`, `/exit`, `/resume`, `/stop`, `/abort`, usage/context/status surfaces.
- Next useful emulations: `/rename`, `/export`, `/background` or `/bg`, `/fork` or `/branch`, `/rewind`.
- For all `dispatch_arg` commands, bare form must never hang. It should return current value or a usage hint.
- For `na` and `block`, responses should be terse and consistent.
- Decide whether Claude `/steer` should remain queued follow-up only or become real live steering if Claude Code exposes a reliable input channel for it.

2. Mixed Codex and Claude session behavior

Prove and harden the lane/session/job model:

- Claude running in background while Codex is foreground sends one final answer, once.
- Codex running in background while Claude is foreground sends one completion notice.
- `/sessions` shows provider, useful title, status, and selected marker.
- `/switch` can select idle provider sessions safely.
- Busy session restrictions are explicit and screen-reader-clean.

3. Transcript failure diagnostics

The adapter now reports a sanitized fallback or screen tail. Next, turn that into a short local diagnostic report without secrets:

- expected provider session ID
- known transcript path and offset
- transcript scan root
- newest candidate transcript files and sizes
- sanitized environment summary
- screen tail

4. Startup and cleanup tests

Add direct tests around startup cleanup behavior without over-investing in boot-time work:

- corrupted PID registry does not block startup
- stale registered Claude PID is removed from registry when process is gone
- registered live non-Claude process is not killed
- registered live Claude process must match provider session ID before kill

5. Manual Telegram acceptance pass

Anthony should test from Telegram after this commit:

- `/claude hello`
- a tool-use prompt, for example ask Claude to run a harmless PowerShell `Write-Output` command
- while Claude is working, send a normal follow-up message and confirm it is queued and then run
- while Claude is working, send `/steer <instruction>` and confirm it is queued as a follow-up
- switch to Codex while Claude works and confirm Claude's final answer still arrives
- run `/sessions` and confirm titles are useful for both Codex and Claude

## Deferred Work

- Full interactive menu navigation for Claude TUI commands.
- Agent SDK backend.
- Hermes plugin extraction and shared engine work.
- A single shared local bridge for both TeleCodex and Hermes.

## Verification Policy

Before runtime restarts:

```powershell
npm run build
npm test
npm run test:claude-tool-smoke
```

After runtime restarts:

- verify exactly one TeleCodex `node.exe`
- verify no unexpected live `claude.exe`
- verify `C:\Users\Anthony\codetest\.telecodex\provider-state\claude-pids.json` is empty unless a Claude turn is actively running
