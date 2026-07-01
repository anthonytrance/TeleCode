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

## Debug Pass Findings — 2026-07-01 (notes only, nothing changed yet)

A read-only debug pass reviewed the adapter, transcript tailer, PTY wrapper, command table, config-dir isolation, and the bot wiring against the live `.env` (`ENABLE_CLAUDE_PROVIDER=true`, `CLAUDE_STRICT_MCP_CONFIG=true`, `CLAUDE_PERMISSION_MODE=bypassPermissions`, `PROGRESS_DELIVERY=messages`, `STREAM_ASSISTANT_TEXT=false`, `TOOL_VERBOSITY=summary`). Findings are ranked. Confidence is noted; items marked VERIFY were reasoned from the code, not reproduced live. The next agent can act on these directly.

### Fix status — 2026-07-01 (code changed, built + unit-tested, NOT yet live)

Fixes for F1–F7 were written the same day. `npm run build` clean; `npm test` green (32 files / 319 tests, incl. a new abort-tailer test). NOT yet restarted into the live bridge and NOT yet run through the live Claude smoke or a manual Telegram pass — that is the remaining step and must be triggered deliberately (a restart drops the Telegram bridge for the running session).

- F1: `sendPrompt` now detects DISPATCH/DISPATCH+ARG slash commands (`isDispatchSlashCommand`) and locates the turn by transcript growth (no prompt echo), and slash-command locate failure no longer disposes the PTY (`disposeOnFailure: false`). `src/providers/claude-adapter.ts`.
- F2: removed the fragile `startsWith` prefix dedup in `handleClaudePrompt`; when narration was streamed as messages, only the held final block (`finalAssistantBlock`) is delivered, so the answer is never re-posted. `src/bot.ts`.
- F3: `/model` now reports "command sent … use /status to confirm" instead of claiming "applied", and the confirm-dialog marker set is broadened. Still marker-based; a transcript-verified switch would be better. `src/providers/claude-adapter.ts`.
- F4: transcript locate is scoped to the known project directory (`projectDir` / `isInProjectDir`) so a concurrent standalone Claude can't be mistaken for this turn. `src/providers/claude-transcript.ts`.
- F5: `/abort` sets `runtime.abortRequested`; `eventsUntilTurnEnd` takes a `shouldStop` hook and ends within one poll instead of waiting out the 180s idle timeout. `src/providers/claude-adapter.ts`, `src/providers/claude-transcript.ts`.
- F6: `/rename` and `/export` implemented; remaining emulate commands now say "not supported over Telegram yet" instead of "not complete yet". `/fork`, `/branch`, `/rewind`, `/background`/`/bg` are still stubs by design. `src/bot.ts`.
- F7: design-doc claims about the "live 98-command CI check" and the `/verbosity` levels annotated as aspirational vs. as-built. `CLAUDE_PROVIDER_DESIGN.md`.

REMAINING VERIFY (do live before trusting): F1 needs a per-command matrix (which DISPATCH commands actually stream a readable turn vs. return the benign no-transcript message); F3 needs a real model switch on the installed Claude build; F5 needs a real mid-turn `/abort`.

### F1 (HIGH, VERIFY) — DISPATCH slash commands can time out and KILL the Claude PTY
- Where: `src/providers/claude-adapter.ts` `sendPrompt` sends every non-`/model` prompt through `locateTurnTranscript(..., { requirePromptEcho: true })` (lines ~146-151). On failure it throws AND calls `stopRuntimePty` (lines ~520-522), disposing the Claude process.
- Problem: DISPATCH commands (`/diff`, `/memory`, `/init`, `/recap`, `/pr-comments`, `/review`, `/security-review`, etc.) are typed into the PTY as if they were prompts, then TeleCodex waits for the exact command text to reappear as a `user` transcript entry. But Claude Code records slash-command invocations as user entries that begin with `<command-name>` / `<command-message>` — the projector itself explicitly skips those (`src/providers/claude-transcript.ts` lines ~330-332). So `findLastPromptOffset` normalizes `/diff` and never matches `<command-name>/diff...`. After the 30s locate timeout plus recovery failure, the adapter throws and kills the PTY.
- Evidence the authors already knew some commands do not echo: `/compact` is the ONE dispatch command routed through `requirePromptEcho: false` (adapter line ~230). Every other DISPATCH command still uses the echo path.
- Fix direction: give DISPATCH real Claude slash commands the same non-echo treatment as `/compact` (detect turn by file growth / turn_duration, not prompt echo), OR match the `<command-name>` form, OR at minimum make the locate-failure path NOT dispose the PTY. Needs a per-command test matrix (which dispatch commands actually write a matching user entry).

### F2 (HIGH) — Progress-vs-final dedup double-posts in the live `messages` mode
- Where: `src/bot.ts` `handleClaudePrompt`, delivery dedup at lines ~2149-2159 and ~2174-2186; per-block handling at ~2081-2092.
- Problem: at `PROGRESS_DELIVERY=messages` (the production default), interim assistant text blocks are delivered as their own messages and concatenated into `deliveredAssistantProgressText` using `trim()` per block (no inter-block whitespace). The final `assistant_message_complete` text is the tailer's `collectedText`, which is the RAW concatenation of every assistant text block in the turn (`claude-transcript.ts` ~417-433). Dedup relies on `finalText.trim().startsWith(deliveredProgressTrimmed)`. Because the delivered string dropped inter-block whitespace and the final kept it, the prefix check fails whenever blocks had leading/trailing whitespace, so the WHOLE answer is re-delivered after the narration was already streamed. Any multi-iteration turn (tool use, common under bypassPermissions) can trigger this.
- Deeper issue: by design the final message already contains every interim block, so interim-vs-final is separated only by brittle string surgery. Consider tracking delivered blocks structurally (e.g. count/identity of delivered text blocks) instead of prefix-matching a concatenated string, or have the tailer emit ONLY the last block as the "final" when interim blocks were already streamed.
- Fix direction: make dedup whitespace-insensitive at block boundaries, or restructure so the final delivery never repeats already-streamed blocks.

### F3 (MEDIUM, VERIFY) — `/model` (and other confirm-dialog commands) can silently no-op after a Claude version bump
- Where: `src/providers/claude-adapter.ts` `applyModelCommand` (lines ~386-410). It waits for `[/switchmodel/, /yes,switchto/]` against the whitespace-stripped screen; if the marker is not seen it skips the confirm keypress but still reports "model command applied".
- Problem: the confirm-dialog wording is version-sensitive (local Claude is 2.1.197). If wording drifts, the model never actually switches but TeleCodex says it did. Same brittleness class as the trust/fullscreen markers in `claude-pty.ts` (`CLAUDE_TRUST_MARKERS`, `CLAUDE_FULLSCREEN_PROMPT_MARKERS`).
- Fix direction: verify the switch from the transcript/model field rather than trusting the screen marker; report failure honestly if unconfirmed.

### F4 (MEDIUM, VERIFY) — transcript locate can grab another session's transcript under concurrency
- Where: `src/providers/claude-transcript.ts` `locateActiveTranscript` fallback picks the newest fresh/grown file globally (lines ~149-155); the non-echo path (`/compact`) uses this directly.
- Problem: Anthony sometimes runs standalone Claude (`start-claude-telecodex.bat`) or a canary alongside TeleCodex. A fresh transcript from a DIFFERENT Claude process can be selected as this turn's transcript. The prompt-echo variant mitigates for normal prompts but not for the non-echo path.
- Fix direction: constrain candidate transcripts to the expected project dir / session id, or verify the located file actually contains this turn's prompt before tailing.

### F5 (MEDIUM) — `/abort` desyncs busy state and then stalls until idle timeout
- Where: `abortClaudeSession` (`src/bot.ts` ~2534-2560) presses Escape via `claudeAdapter.abort` (`claude-adapter.ts` 213-216) and force-sets `busyState.processing = false`, but the running `sendPrompt` loop keeps `markProviderBusy(..., "claude", true)` until its tailer returns. An interrupted turn may not write `turn_duration`, so the tailer waits the full `CLAUDE_TURN_IDLE_TIMEOUT` (180s) before emitting the idle-timeout error (`claude-transcript.ts` ~448-456). During that window `busyState` and `markProviderBusy` disagree, and new messages are queued rather than run.
- Fix direction: make abort actually terminate the in-flight tailer/turn (signal the async iterator to stop) and reconcile both busy flags together.

### F6 (LOW) — several EMULATE commands still fall through to "not complete yet"
- Where: `handleClaudeEmulatedCommand` (`src/bot.ts` ~2530). `/rename`, `/export`, `/background`/`/bg`, `/fork`/`/branch`, `/rewind` hit the generic "implementation is not complete yet" reply. This matches the Priority Work list above; noting for completeness so the next agent wires them or downgrades them to a clearer "not supported" message.

### F7 (LOW / DOC) — stale design claims to reconcile
- `CLAUDE_PROVIDER_HANDOFF.md` and `CLAUDE_PROVIDER_DESIGN.md` still describe the "98-command CI coverage test that fetches the live command list." The shipped `src/providers/claude-commands.ts` is a STATIC table; `test/claude-commands.test.ts` asserts against that static table, not a live fetch. Not a bug, but the docs oversell "keeps full coverage honest as Claude Code moves." Either add the live-fetch check or soften the doc.
- The design's `/verbosity` command and the ordered `silent/summary/progress/verbose/debug` levels are not implemented as such; delivery is driven by `PROGRESS_DELIVERY` (`none`/`messages`/`edit`) + `TOOL_VERBOSITY`. Reconcile naming or implement `/verbosity` as designed.

### Not bugs (checked, OK in the live config)
- Permission-prompt hang is NOT a live risk because `.env` uses `bypassPermissions` + `--dangerously-skip-permissions`. It WOULD hang if permission mode were ever set to `default`/`acceptEdits` in strict-mcp mode, since there is no Telegram permission-answer path (`capabilities.permissions=false`). Worth a guard/warning if that env ever changes.

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
