# Claude Provider — Hardening + Agent SDK Phase Plan (2026-07-08)

Executor: OpenAI Codex CLI. Written by Claude (Fable 5) after live-failure forensics on 2026-07-07/08.
Read this whole file before touching code. All paths are ABSOLUTE because Codex's cwd is `C:\Users\Anthony`, not the repo.

Repo: `C:\Users\Anthony\codetest\tools\telecodex`
Branch: `anthony/local-telecodex` — commit after every completed sub-step, push to remote `anthony` (github.com/anthonytrance/telecodex). Never commit to `origin`.
Build/test: `npm run build` then `npm test` (vitest; 327 tests green at plan time, baseline commit `f475b40`).
Design context: `C:\Users\Anthony\codetest\tools\telecodex\CLAUDE_PROVIDER_DESIGN.md` (Sections 2, 3, 3B, 6) and `C:\Users\Anthony\codetest\CLAUDE_PROVIDER_HANDOFF.md` (backend-neutral rule). This plan operationalizes them; where they conflict, this plan wins.

## Hard operational rules (violating these has bitten us before)

1. NEVER spawn a claude.exe that can load the user-scoped Telegram plugin while the production bridge runs — it 409s the bot token and kills the bridge. The existing PTY engine handles this via `CLAUDE_STRICT_MCP_CONFIG` (default true). Any NEW spawn path (including the Agent SDK backend) must guarantee the child cannot poll Telegram: scrub `TELEGRAM_BOT_TOKEN` from the child env AND disable plugin loading.
2. NEVER restart the production bridge; Anthony does that himself. Build/tests/smokes are fine while it runs (it executes from memory).
3. Live smoke tests spend Anthony's Claude quota. Run the unit suite freely; run `npm run test:claude-bot-smoke` once per phase completion, not per iteration.
4. The smoke live-lock (`scripts/claude-live-lock.mjs`) serializes smoke runs — keep acquiring it in any new smoke script.

## Confirmed defects this plan fixes (from live forensics 2026-07-07/08)

- D1 (race): two Telegram messages arriving within a few seconds can BOTH pass the `isProviderBusy` check in `handleClaudePrompt` (`src/bot.ts` ~line 2153); the second is typed into a busy PTY.
- D2 (kill): when a typed prompt does not echo into the transcript within ~30s, `locateTurnTranscript` (`src/providers/claude-adapter.ts` ~line 660) gives up and force-kills the mid-turn claude.exe. The user's message is lost and the running turn dies. Two turns were killed this way tonight.
- D3 (source-level narration loss): Claude Code 2.1.198 does NOT write some mid-turn assistant text blocks to the transcript jsonl at all (first text of a turn and the final text are reliably written; texts between tool calls are often missing — verified by phrase search). Transcript tailing therefore CANNOT deliver full progress narration. No bridge-side fix exists; this is why Phase C (Agent SDK backend) is the real fix.
- D4 (volatile queue): `queuedClaudePrompts` is an in-memory Map; a bridge restart discards queued user messages.
- D5 (idle-flush edge): `NARRATION_IDLE_FLUSH_MS` (1500ms, `src/bot.ts:90`) can flush the FINAL answer block as a progress message when `turn_duration` lags; the final-delivery step then has nothing left (`finalAssistantBlock` empty) — acceptable only because content still arrived; must never double-send or drop.
- D6 (no logging): kills, queueing, dispatch, and echo events leave no trace. Tonight's second turn-kill (23:02Z) is unattributable because of this.

Reaction UX note: the current reaction scheme (👀 while running, 👍/removal at completion) is Anthony's turn-state signal, it works with his screen reader, DO NOT change it.

## Phase A — intake correctness + never kill a mid-turn Claude

### A1. Atomic per-lane intake gate

File: `src/bot.ts`, `handleClaudePrompt` and its call sites (`startClaudePrompt`, queue dispatch in the `finally` block ~line 2502).

- Move the `busyState.switching || busyState.transcribing`, `isProviderBusy`, and `markProviderBusy(contextKey, "claude", true)` sequence to the VERY TOP of `handleClaudePrompt`, before ANY `await` (the embedded-command check and adapter-disabled replies run after the gate; release the gate before returning on those early-exit paths).
- Additionally add a per-lane synchronous mutex so two grammY middleware executions cannot interleave: `const claudeIntakeLocks = new Map<TelegramContextKey, boolean>()`; test-and-set synchronously; if locked → queue.
- Acceptance test (new, `test/bot-claude-flow.test.ts`): fire two `bot.handleUpdate` text updates in the same tick with a slow fake adapter; assert the second is queued (👀 reaction + queued reply), the adapter's `sendPrompt` is called exactly once while busy, and the queued prompt dispatches after the first completes.

### A2. Persistent prompt queue

Files: `src/bot.ts` (queue use), new `src/claude-prompt-queue.ts` + `test/claude-prompt-queue.test.ts`.

- Replace the raw `queuedClaudePrompts` Map with a small class persisting to `<workspace>/.telecodex/provider-state/claude-queue.json` (UTF-8 WITHOUT BOM — PowerShell-written BOMs have crashed this bot before; write with `fs.writeFileSync(path, JSON.stringify(...), "utf8")` from node only).
- Entry shape: `{ contextKey, chatId, messageThreadId, text, queuedAt }`. Note the current queue keeps only ONE pending prompt per lane (last wins) — upgrade to an ordered ARRAY per lane, dispatched FIFO, because Anthony often sends several messages during one long turn.
- On startup (`createBot`), load the file; if entries exist, deliver a notice to the lane ("N queued messages from before the restart will be sent to Claude now") and dispatch FIFO once the lane is idle.
- The Telegram `ctx` cannot be persisted; for restart-recovered entries send via `bot.api` using the stored chatId/threadId (mirror how `sendTextMessage` is called elsewhere), and skip reaction calls (no live ctx).
- Acceptance: unit tests for enqueue/dequeue/persist/reload/FIFO-across-restart; the A1 race test extended to assert both quick messages end up queued in order and both eventually run.

### A3. Never kill a mid-turn Claude; queue-back instead

File: `src/providers/claude-adapter.ts`, `locateTurnTranscript` failure path (~line 720 after `f475b40`).

- The adapter must know whether a turn is currently in flight on the runtime (it does — the send path is only entered when the bridge thinks the lane is idle; after A1 that is reliable). The remaining kill scenario is: prompt typed, echo genuinely missing (Claude was busy compacting, slow, or mid-turn due to a pre-A1 race remnant).
- New failure behavior, in order: (1) wait for ready prompt up to 2.5s and clear input (`clearInput()`, exists) and retry once — ALREADY IMPLEMENTED in f475b40, keep; (2) if the retry also fails AND the PTY is alive: clear input if possible, DO NOT `stopRuntimePty`, and throw a new typed error `PromptNotDeliveredError` carrying the original text; (3) only if the PTY is dead/unresponsive (no ready prompt AND no screen change for the whole window) dispose it.
- File: `src/bot.ts` catch block of `handleClaudePrompt` (~line 2482): on `PromptNotDeliveredError`, re-enqueue the text at the FRONT of the A2 queue and tell Anthony plainly: "Claude did not accept the message yet; it is queued and will be retried when the session is idle." No reaction change to 👍 (the turn did not complete).
- Acceptance: unit test with a fake PTY that never echoes but stays alive → assert no dispose call, error type, message re-queued. Existing tests asserting dispose-on-failure must be updated deliberately (they encoded the old bad behavior).

### A4. Steer support (explicit, not accidental)

Claude Code natively supports steering: text typed while a turn runs is queued by Claude itself and injected between tool calls. The bridge previously did this only BY ACCIDENT (the D1 race). Make it a feature:

- New command `/steer <text>` for the Claude provider, registered in `src/providers/claude-commands.ts` as class `emulate`, handled in `handleClaudeEmulatedCommand` (`src/bot.ts` ~line 2765): if a Claude turn is running in the lane, type the text into the PTY via `sendPrompt` on the ClaudePty directly (no transcript-echo expectation, no reply attribution — the ongoing turn simply absorbs it) and reply "Steered into the running turn."
- If NO turn is running: fall through to a normal prompt (start a new turn with the text). This is Anthony's requested default and it applies to the CODEX provider too: find where Codex steer currently errors with "no active turn" (search `src/app-server-session.ts` / `src/bot.ts` for the steer/interject path) and make the same change: steer-with-no-active-turn starts a new turn with that text instead of erroring.
- Acceptance: tests for both providers covering steer-while-running and steer-while-idle.

### A5. Bridge logging

New file `src/bridge-log.ts`: append-only daily log `<workspace>/.telecodex/logs/bridge-YYYYMMDD.log`, plain lines `ISO timestamp | area | message`, 7-day retention (delete older on boot). No dependency; ~40 lines.

Log at minimum: message received (lane, chars), gate decision (dispatched/queued/steered + queue depth), prompt echo located (file basename, offset), turn end (duration, usage), adapter failures verbatim, PTY spawn/dispose with reason, queue persistence load/save, startup/shutdown. Wire into `handleClaudePrompt`, the adapter callbacks (`onEvent` or around the event loop), and `claude-pty.ts` spawn/dispose.

Phase A exit: build + full unit suite green, `npm run test:claude-bot-smoke` PASS, commit per sub-step (A1..A5), push.

## Phase B — narration delivery polish (PTY path)

### B1. Final-block delivery invariant

File: `src/bot.ts` narration state machine (~lines 2196–2360). Invariant to enforce and test: EVERY assistant text block reaches Telegram EXACTLY once — as progress or as final, never both, never neither — including when: idle timer flushed the last block before `turn_duration` arrived (D5); the turn errors mid-way; delta and complete arrive in the same tailer batch. Add fixture tests in `test/bot-claude-flow.test.ts` for the three orderings (complete-before-timer, timer-before-complete, error-after-partial-stream). Fix any violation the tests reveal (likely: none delivered as "final" is fine content-wise since reactions signal completion — but assert no loss/no dup).

### B2. Edit-mode progress truncation — CROSS-PROVIDER (Anthony-reported 2026-07-08)

Root cause found: in `edit` progress mode both providers render the rolling progress message through `renderAssistantProgressMessage` (`src/bot.ts:6646`), and `trimProgressText` (`src/bot.ts:6680`) hard-truncates EVERY narration line at 500 chars (also flattens its newlines); `trimProgressToolName` cuts tool lines at 120. Anthony reads narration blocks cut off mid-sentence. The caps exist to keep the single edited message under the 4000-char Telegram edit limit, but content loss is not acceptable.

Fix (single point, applies to Codex AND Claude since the render function is shared):
- Never truncate narration CONTENT. Budget the edited message at ~3500 chars total. Fit as many of the most recent COMPLETE lines as the budget allows (drop OLDEST lines first, not characters).
- If a single narration block alone exceeds the budget: freeze the current progress message as-is, send the long block as its own ordinary message (chunked via `splitMarkdownForTelegram` — full content, no cuts), then continue the rolling edit message with subsequent lines. Preserve newlines inside a block (drop the `\s+`→single-space flattening for narration; keep it for tool lines).
- Keep the 120-char tool-line trim (tool lines are summaries by design; full output is governed by TOOL_VERBOSITY).
- Tests: fixture with a 2000-char and a 6000-char narration block in edit mode → assert no "..." truncation of narration, correct rollover message count/order, and the edited message never exceeds 4000 chars. Assert the same render path drives the Codex progress test.

### B3. Document + track the upstream transcript gap (D3)

Add a short section to `CLAUDE_PROVIDER_DESIGN.md` under Section 2 stating: on Claude Code 2.1.198 interim assistant text blocks are not reliably written to the transcript; PTY-backend narration is therefore BEST-EFFORT; the acceptance test "every interim block delivered" is only achievable on the SDK backend (Phase C). Check the installed Claude Code version (`claude --version`) during Phase C and note whether newer versions fix it.

Phase B exit: suite green, commit, push.

## Phase C — Agent SDK backend (the reliability fix Anthony wants to run on)

Goal: same provider surface, same commands, same session UX — different engine underneath, switchable per install with ONE env var, reversible if Anthropic un-pauses the billing change.

### C0. Preflight (do this FIRST, it gates the phase)

- Verify billing status: fetch Anthropic support article 15036540 and the Agent SDK overview page; confirm the "separate credit bucket for Agent SDK / claude -p" change is still PAUSED (it was as of 2026-06-16 per CLAUDE_PROVIDER_DESIGN.md §6). If un-paused: STOP, report to Anthony, do not build on the subscription.
- `npm install @anthropic-ai/claude-agent-sdk` (pin exact version). Auth: the SDK auto-reads `C:\Users\Anthony\.claude\.credentials.json` (verified 2026-06-17); no key handling in our code.
- Spike script `scripts/claude-sdk-spike.mjs` (throwaway, do not commit results, delete after): one `query()` turn, print the raw message stream. Confirm: (a) an init/system message carries the session id; (b) EVERY assistant text block arrives as its own message (this is the D3 fix — if interim blocks are missing here too, abort Phase C and report); (c) `resume` with the session id continues the conversation; (d) usage totals arrive on the result message. Run it with env scrubbed of `TELEGRAM_BOT_TOKEN` and confirm no Telegram polling from the child (rule 1).
- ORCHESTRATION-PARITY checklist (Anthony's question: does the SDK have everything interactive Claude Code has?). The SDK runs the same agent core, but parity is NOT the default — these options must be set and each one verified in the spike:
  - `systemPrompt: { type: "preset", preset: "claude_code" }` — without this the SDK uses an empty system prompt, NOT Claude Code's.
  - `settingSources: ["user", "project"]` — without this the SDK loads NO CLAUDE.md, NO user/project settings, NO skills from `~/.claude/skills`. This single option is what makes it behave like Anthony's interactive sessions.
  - Tools: default full built-in toolset (Bash/Edit/Write/Glob/Grep/WebSearch/Task subagents) — confirm none need explicit `allowedTools`.
  - Skills + custom slash commands from `.claude/commands` — confirm they load with the settingSources above.
  - Built-in slash commands as input (`/compact`, `/clear`, `/model`): verify which are accepted through SDK input (streaming input mode) vs must stay EMULATE/SURFACE in the registry; update the C2 registry overrides with the verified list.
  - `forkSession: true` alongside `resume` — the SDK-native session fork (needed for C5).
  - `includePartialMessages` — optional finer-grained streaming deltas; if stable, narration can stream even within one text block.
  - Hooks (PreToolUse/PostToolUse) and `canUseTool` — not needed for TeleCodex V1 (bypassPermissions), just confirm availability for later.
  - Known interactive-ONLY features that will NOT work on the SDK backend and stay PTY/EMULATE: the TUI checkpoint/rewind system (`/rewind`), interactive pickers, `#` memory shortcut. Record the verified list in this file's Execution log.

### C1. Engine

New file `src/providers/claude-sdk-engine.ts`. It implements the SAME internal runtime contract the adapter already consumes (see how `claude-adapter.ts` drives `ClaudePty` + `TranscriptTailer` and emits `AgentProviderEvent`s): sendPrompt → async stream of events, abort, dispose, compact, usage snapshot, session id reconciliation.

- Map SDK stream → events: assistant message text block → `assistant_text_delta` (one per block, in order); result message → `assistant_message_complete` (+ `usage_updated`, and `model_updated` from the message's model field); tool_use start → `tool_started` (name + one-line input summary); SDK errors → `error`. Session id from the init message → `providerSessionId` (reuse the existing reconciliation path in bot.ts — it already handles provider-session-id updates).
- Session continuity: store the SDK session id in the same descriptors/state as the PTY path (`claudeState`, `agentSessions`) so `--resume` semantics are identical; `query({ resume: <id> })` per turn, or keep a streaming-input session open per lane — prefer ONE query per turn with `resume` (simplest, restart-safe, matches current per-turn model).
- Abort: SDK interrupt/abort API (pin the exact call during C0 spike). Compact: if the SDK exposes no manual compact, implement `/compact` on the SDK backend as SURFACE ("automatic on the SDK backend") — do not fake it.
- Options per turn: `model` (from lane state), `permissionMode: "bypassPermissions"` (matches `CLAUDE_PERMISSION_MODE`), `cwd: config.claudeWorkspace`, env WITHOUT `TELEGRAM_BOT_TOKEN`, plugins/settings sources restricted so no user-scoped plugin loads (pin exact option names during C0; the SDK has settings-source controls).

### C2. Backend switch — LIVE COMMAND, no restart (Anthony's requirement)

- TeleCodex already has a per-context, persisted, restart-free backend switch for Codex: `bot.command("backend", ...)` at `src/bot.ts:4523` (`/backend sdk|appserver`). EXTEND that same command for the Claude provider instead of inventing a new one: when the lane's active provider is Claude, `/backend` shows the current Claude engine, and `/backend sdk` / `/backend pty` switches it. Per-context, persisted in the same state store the Codex backend choice uses, effective from the NEXT turn (dispose the lane's current PTY runtime lazily on switch so the next prompt starts on the new engine; never dispose mid-turn — if busy, reply "will switch when the current turn ends" and apply at turn end).
- `CLAUDE_BACKEND=pty|sdk` env var remains as the DEFAULT for contexts that never ran `/backend` (`src/config.ts` + `.env.example`). Register the command name in the Claude command registry as EMULATE so it is never typed into the PTY.
- Session continuity across the switch: both engines speak the same session-id space (the SDK stores sessions in the same `~/.claude/projects` transcript format), so `resume` after a backend switch continues the SAME conversation. C3 must include a test/smoke step proving: turn on pty → `/backend sdk` → next turn resumes the same session, and back.
- The adapter's Telegram-facing behavior (events, descriptors, reactions, queue from Phase A) is IDENTICAL on both engines — the A2 queue and A1 gate sit ABOVE the engine and apply to both.
- `/steer` on the SDK backend: if the SDK's streaming-input mode is not wired (per-turn `resume` model), implement steer-while-running as: append to the A2 queue with a "steer" flag delivered immediately after the current turn (documented behavioral difference, tell the user "queued for after this turn"); steer-while-idle starts a turn (same as PTY).
- Command registry: add optional `sdkClass?: ClaudeCommandClass` to `ClaudeCommandSpec` (`src/providers/claude-commands.ts`); default = same class. Known overrides only: `/compact` → surface (see C1); everything classed `dispatch`/`dispatch_arg` sends the same text as a prompt through the SDK (skills/workflows are just prompts and work unchanged); `emulate`/`surface`/`na`/`block` are backend-independent already. Add a test asserting every spec resolves to a handler class on BOTH backends.

### C3. Tests + canary

- Unit: engine event-mapping tests with a faked SDK stream (init, 3 interim text blocks, tool_use, result) asserting 3 `assistant_text_delta` + 1 complete, in order — this encodes the D3 fix.
- Smoke: `scripts/claude-sdk-bot-flow-smoke.mjs` — copy of `claude-bot-flow-smoke.mjs` with `CLAUDE_BACKEND=sdk`, plus one additional check the PTY smoke cannot pass: a prompt like "Reply with INTERIM_ONE, then run a trivial command (echo ok), then reply with INTERIM_TWO, then run another, then finish with FINAL_MARK" asserting all three texts arrive as separate messages in order. Acquire the live-lock. Add npm script `test:claude-sdk-smoke`.
- Rollback drill: flip back to `CLAUDE_BACKEND=pty`, run the old smoke, confirm green — proves the escape hatch Anthony requires if billing changes.

### C4. Ship

- After C3 passes, tell Anthony; he switches with `/backend sdk` in Telegram per context (no restart needed, per C2). `.env` `CLAUDE_BACKEND=sdk` optionally flips the default for new contexts. Log line on boot and on every switch must state the active backend. Document in `.env.example`: "sdk = full progress narration, currently billed to subscription (policy pause, revocable — see CLAUDE_PROVIDER_DESIGN.md §6); pty = guaranteed subscription floor."

### C5. Session commands: /resume <target> and /fork (IN SCOPE — Anthony asked, 2026-07-08)

- `/resume <target>`: the lane/session machinery already exists (`agent-session-manager.ts`, `/sessions`, `/switch`) — wire the Claude `/resume <n|id|title-prefix>` emulation (`src/bot.ts` ~2820, currently "not implemented") to select that agent session and attach its `providerSessionId` so the next turn resumes it. Bare `/resume` lists the lane's Claude sessions (reuse the `/sessions` renderer) instead of only "session is attached".
- `/fork`: creates a NEW agent session in the lane pointing at the CURRENT conversation state, then continues there, leaving the original session intact. SDK backend: `resume: <id>, forkSession: true` (verified in C0). PTY backend: spawn with `--resume <id> --fork-session` (verify the exact CLI flag during C0; if interactive mode lacks a non-interactive fork flag, fork on the PTY backend = reply "fork requires the sdk backend, use /backend sdk" rather than a broken emulation).
- `/branch`: alias of `/fork` unless a distinct Claude Code semantic is found during C0; then implement or NA it explicitly.
- Tests: fork produces a new session whose next turn does not advance the original; `/resume <target>` switches transcripts; both covered by unit tests with faked engines, plus one smoke assertion each.

Phase C exit: suite + both smokes green, committed, pushed, and a short summary appended to this file under "Execution log".

## Phase D (optional backlog, only if Anthony asks)

- `/rewind` real emulation (TUI checkpoint system — likely PTY-impossible and SDK-unsupported; investigate before promising).
- Live-fetch CI check diffing `claude-commands.ts` against code.claude.com's command list (DESIGN.md §3 note from 2026-07-01).
- Design §2's five-level `/verbosity` mapping (current three-level messages/edit/none works for Anthony today).

## Execution log

(append results per phase here)

- 2026-07-08 Codex partial Phase A/B bugfix slice:
  - Implemented persistent FIFO Claude prompt queue at `.telecodex/provider-state/claude-queue.json`, with restart recovery and no-BOM JSON writes.
  - Added atomic Claude intake gate so same-tick Telegram messages cannot both enter `sendPrompt`; queued prompts now run FIFO instead of last-wins replacement.
  - Added `PromptNotDeliveredError`; missed transcript echo on a live PTY now requeues the prompt and keeps Claude alive instead of force-killing the process.
  - Fixed Claude `/usage` leakage by cropping the screen scrape to the latest usage panel and routing top-level Telegram `/usage` through the same Claude usage-report path.
  - Verification: `npm run build` passed; focused tests passed; full `npm test` passed, 35 files / 333 tests.
