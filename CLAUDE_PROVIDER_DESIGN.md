# Claude Provider — Unified Design (TeleCodex + Hermes)

Date: 2026-06-17
Status: DESIGN. Supersedes the three earlier docs, which are now stale references:
- `tools/telecodex/CLAUDE_PROVIDER_PLAN.md` (2026-06-12, minimal slice)
- `tools/telecodex/PLAN.md` (2026-05-20, unified bot plan)
- `%LOCALAPPDATA%/hermes/CLAUDE_CODE_PROVIDER_PLAN.md` (2026-06-12, Shape A in-core)

Authoritative pointer doc: `C:\Users\Anthony\codetest\CLAUDE_PROVIDER_HANDOFF.md` (2026-06-17).

This document designs BOTH projects end to end. Build order is TeleCodex first, then Hermes. H1 (subscription PTY) is built first; H2 (Agent SDK) is designed here but built later, only if the billing question lands acceptably.

---

## 0. Ground truth and non-negotiables

- **Billing reality (corrected):** Anthropic PAUSED the change that would move Agent SDK / `claude -p` usage off the Claude subscription into a separate credit bucket. So the Agent SDK is usable on subscription today but is policy-sensitive. Keep the provider backend-neutral. PTY (interactive TUI) is the guaranteed-subscription backend; Agent SDK is an optional backend; direct Anthropic Messages API with the subscription OAuth token stays REJECTED (account-ban risk).
- **Telegram is Anthony's lifeline.** Never run a second poller on the production token. Canary on a separate token + state dir. Warn before any production restart. Keep a one-command rollback to the Codex-only build. Store new state in new files; never mutate `.telecodex/contexts.json` in place during migration.
- **Subscription-safe mechanism (spike-verified 2026-06-12):** drive interactive `claude.exe` in a hidden ConPTY, read structured output from the transcript JSONL at `~/.claude/projects/*/<uuid>.jsonl`. Never the Agent SDK / `claude -p` / stream-json for the subscription path.

---

## 1. Shared engine principle

The fragile part of this whole project is the PTY + transcript mechanics (spawn args, trust dialog, readiness markers, bracketed-paste input, transcript tailing, compact/interrupt/resume, usage extraction). Build it ONCE and share it.

- TeleCodex already has a TypeScript implementation under `src/providers/` (claude-pty, claude-transcript, claude-state, claude-adapter).
- Hermes has a Python implementation (`claude_pty_session.py`, `claude_event_projector.py`) — currently jammed into Hermes core; it moves OUT into Anthony's own plugin package (see Section 5).
- These two implementations of the same mechanics are the maintenance cost. Keep them behaviourally identical and documented from the same spec (this doc). If we later want a single source of truth, the OpenAI-compatible local bridge (appendix) collapses both consumers onto one Python engine — deferred, not part of H1.

Backend-neutral boundary: in both projects the provider/runtime exposes one interface (start, run-turn, interrupt, compact, usage, dispose) with a swappable backend: `pty` (default) or `agent_sdk` (later). Swapping the backend must not change any downstream routing, commands, or delivery.

---

## 2. Progress / narration delivery (FIRST-CLASS REQUIREMENT, both projects)

The point Anthony flagged as very important. There are two distinct streams in a Claude turn, and they must be handled separately:

1. **Tool activity** — "ran bash", "edited file X". Lines about executing commands.
2. **Assistant progress narration** — the assistant's OWN interim text it writes BETWEEN tool calls inside one turn ("Found the bug in the parser, now fixing the off-by-one..."). The official Telegram plugin currently sends Anthony only the FINAL assistant message, so this running commentary is invisible. That is the gap to close.

Where it comes from: the transcript has multiple `assistant` entries per turn (one per API iteration). Each can carry `text` blocks. The interim ones (every assistant text block before the turn ends at `turn_duration`) ARE the progress narration. The engine already sees them; the delivery layer must surface them, not just the last one.

### Verbosity model (shared `PROGRESS_DELIVERY` / `TOOL_VERBOSITY`, settable via command)

NOTE (2026-07-01): as built, delivery is driven by `PROGRESS_DELIVERY` (`none` / `messages` / `edit`) plus `TOOL_VERBOSITY`, not by the named levels below. A `/verbosity <level>` command mapping onto the levels below is NOT yet implemented; either implement it or treat the ordered levels as the target design. Define ordered levels, per context, changeable live with a command (`/verbosity <level>` plus the existing `/quiet` style aliases):

- `silent` — final assistant message only (today's plugin behaviour). The floor, never the default.
- `summary` — final message + a short collapsed digest of interim narration (e.g. one combined block per turn). For people who want signal without spam.
- `progress` (DEFAULT) — stream EVERY interim assistant narration block as it appears in the transcript, plus the final message. Tool lines collapsed to one-liners. This is the level that fixes Anthony's complaint.
- `verbose` — progress narration + full tool input/output one-liners (the existing tool-line rendering).
- `debug` — everything, including raw tool args and usage deltas per iteration.

Delivery mechanics (both projects):
- Interim narration streams via Telegram message edits while a block grows, then a new message when a new interim block starts, so each piece of commentary is its own readable chunk (screen-reader friendly).
- Tool activity is governed by `TOOL_VERBOSITY` independently, so Anthony can have full narration (`progress`) with collapsed tool lines.
- Background (non-selected) sessions buffer narration and flush a digest on switch-back; approval requests and questions are never buffered away.
- Hermes: the same level model drives what the plugin emits per delegated turn. The projector must emit interim assistant text as `assistant_text_delta` progress events (not only the final), gated by the level. This is also the lever that mitigates the delegated-turn opacity: Anthony at least SEES Claude's reasoning narration during the turn even though Layla isn't driving it.

Acceptance for this feature: at `progress`, every interim assistant narration block from a multi-step turn reaches Telegram as its own message, in order, for both Codex and Claude providers and for Hermes delegated turns. Covered by transcript-fixture tests (a turn with 3 interim narration blocks + tool calls + final message asserts 4 assistant messages delivered in order).

---

## 3. TeleCodex V1 — full command coverage

The current adapter declares `slashCommands: false` and wires a handful of commands. V1 now targets the FULL Claude Code command surface. The live set is 98 commands (fetched 2026-06-17 from code.claude.com/docs/en/commands). "Every command supported" means: every command is RECOGNISED and HANDLED — no silent drops, no stack traces — with the meaningful ones fully functional and the terminal-cosmetic ones returning a clear "not applicable over Telegram" reply.

### Handling classes

Each command maps to exactly one handler class, driven by a command-capability table (not hardcoded branches):

- **DISPATCH** — type the command into the PTY; it works as-is. Covers commands whose effect is in-session and whose output lands in the transcript. Includes the bundled skills/workflows (they are just prompts handed to Claude).
- **DISPATCH+ARG** — menu-driven in the TUI, but a non-interactive argument form exists; require/encourage the arg form over Telegram (e.g. `/model sonnet`, `/advisor opus`, `/effort high`). Bare (menu) form returns the current value + usage hint in V1; full inline-button menu navigation is a Phase 2 fast-follow.
- **EMULATE** — TeleCodex owns the behaviour because typing it into the TUI is wrong or unsafe over a bridge (`/clear` → start fresh session and say so; `/resume`/`/branch`/`/fork` → session-manager operations; `/exit` → dispose the PTY).
- **SURFACE** — answer from data the engine already has rather than round-tripping the TUI (`/usage`, `/context`, `/cost`, `/status`, `/stats` → from transcript usage snapshot; `/session` → descriptor). Cheaper and screen-reader-clean.
- **NA** — terminal/host-cosmetic with no meaning over a text bridge; reply with a one-line "not applicable over Telegram" + what to use instead if relevant. Never errors.
- **BLOCK** — deliberately refused for safety (auth/billing/destructive-to-environment), with a clear reason.

### Mapping of the 98 commands

DISPATCH (in-session, transcript-backed, incl. bundled skills/workflows):
`/compact /context /memory /init /add-dir /cd /diff /pr-comments /recap /btw /goal /plan /sandbox /hooks /code-review /review /security-review /simplify /batch /loop /run /verify /run-skill-generator /deep-research /claude-api /ultraplan /ultrareview /workflows /powerup /team-onboarding /fewer-permission-prompts /release-notes /tasks /stop /passes /insights /focus`

DISPATCH+ARG (prefer the argument form; bare form surfaces current value in V1, inline-menu in Phase 2):
`/model /effort /advisor /permissions /config /agents /mcp /plugin /keybindings(arg only) /statusline(arg only) /theme(arg only — but see NA)`

EMULATE (session-manager owns it):
`/clear /resume /branch /fork /rename /export /copy /rewind /background /bg`

SURFACE (answer from engine data):
`/usage /context /cost /status /stats /session(TeleCodex-native) /doctor /debug(report) /heapdump(report or NA)`

NA (recognised, clear "not applicable over Telegram" reply):
`/color /theme /vim /scroll-speed /statusline /ide /terminal-setup /tui /desktop /mobile /chrome /voice /radio /stickers /focus(cosmetic) /scroll-speed /remote-control /remote-env /teleport /install-github-app /install-slack-app /web-setup /setup-bedrock /setup-vertex /privacy-settings /color /stickers /reload-plugins /reload-skills /reload-* /terminal-setup /keybindings(menu) /fast(host) /tui`

BLOCK (safety — refuse with reason):
`/login /logout /upgrade /usage-credits /feedback(sends data externally — confirm-gate, not silent) /autofix-pr(spawns cloud session — confirm-gate) /install-github-app /install-slack-app /privacy-settings`

(Where a command appears in two lists above, the stricter handler wins; the implementation table is the single source of truth — this prose is the rationale. The table lives as a STATIC list in `src/providers/claude-commands.ts`, and `test/claude-commands.test.ts` asserts every entry has a handler class. NOTE (2026-07-01): this is a static table, not a live fetch — nothing automatically diffs it against the current code.claude.com command set, so "keeps full coverage honest as Claude Code moves" is aspirational. To make that real, add a check that fetches the live command list and fails when an unclassified command appears.)

### The hard subset: interactive menu commands

`/agents`, `/mcp`, `/permissions`, `/config`, `/rewind`, `/model` (bare), `/resume` (bare) open TUI dialogs needing arrow-key navigation. V1: prefer the argument form (DISPATCH+ARG) and, for menu-only cases, return the rendered menu text + a numbered selection that Anthony replies with, OR Telegram inline buttons mapped to the menu. Full inline-button navigation is the Phase 2 fast-follow; V1 must at least not hang and must give a usable path.

### Capabilities update

Set `slashCommands: true`. Add `commandClassFor(name)` to the adapter, plus `permissions`/`userQuestions` handling needed by the menu/approval commands (these were `false` in the minimal slice; advanced commands pull some of them forward — scope precisely during build).

### TeleCodex ship steps

1. Build the command table + handler classes + the CI "every-command-classified" test.
2. Wire progress narration delivery (Section 2) into the existing `PROGRESS_DELIVERY` path; add `/verbosity`.
3. Re-run build + full test suite.
4. Canary on a separate token + `.telecodex-canary` state dir: a real Claude turn, the progress-narration stream at `progress` level, a sample from each handler class (DISPATCH, ARG, EMULATE, SURFACE, NA, BLOCK), resume after restart, photo/doc-while-Claude-active fails cleanly.
5. Restart production with Claude gated behind `ENABLE_CLAUDE_PROVIDER` (default off); Anthony flips it on.

---

## 3B. TeleCodex — parallel sessions, cross-provider switching, background completion notices

This was the design target of the old `PLAN.md` (lane / selected-session / running-job model, Phases 2–5). The minimal Claude slice deferred it; it is now IN SCOPE because Anthony runs OpenAI Codex and Claude Code in parallel and needs to be told when a background turn finishes. The earlier sections of this doc under-specified this — this section is the correction.

### Model

- **Lane** = a Telegram context (private chat, or a forum topic keyed `chatId:threadId`).
- A lane holds MANY sessions. Each session is bound to one provider: `codex` or `claude`.
- One session per lane is **selected** (foreground) — it receives ordinary text messages. The others keep running in the **background**.
- A running turn ("job") in one session must never block another session or block switching. (This fixes the current limitation, where you cannot switch away from a busy session within one context.) Codex and Claude are separate subprocesses, so true parallelism is free; the work is the lane/session/job bookkeeping + buffering, not concurrency itself.

### Switching commands

- `/provider [codex|claude]` — show or set the lane's DEFAULT provider for new sessions.
- `/codex` / `/claude` — switch the selected session to that provider (creating a session lazily if none of that provider exists in the lane).
- `/new [codex|claude]` — create a new session (defaults to lane provider; asks if ambiguous).
- `/sessions` — list every session in the lane with provider, status (idle/running/waiting/done/failed), and the selected marker.
- `/switch <n|id>` — select a different session.
- `/jobs` — running/waiting jobs in this lane; `/alljobs` — across all lanes (optional, behind a flag).
- `/abort [job]` — cancel the selected session's turn, or a named job.

All of these are screen-reader-clean plain text, and unsupported-per-provider commands degrade to a clear message (driven by capability flags, Section 3).

### Foreground vs background delivery

- **Foreground** (selected session, in the lane where Anthony sent the prompt): streams normally, including progress narration per the verbosity level (Section 2).
- **Background** (any non-selected session): narration + tool lines are BUFFERED, not streamed into the foreground conversation. On turn completion, emit ONE completion notice to the lane. Notice content is governed by a per-lane preference `BACKGROUND_NOTICE`:
  - `full` — "Session 2 (Claude) finished:" + the final response, chunked if long.
  - `head` (DEFAULT) — "Session 2 (Claude) finished:" + the first ~N chars of the final response + "…switch to it to see the rest (buffered)."
  - `notice` — just "Session 2 (Claude) turn done."
- **Never buffered away:** a background session's approval request or clarifying question is delivered immediately as a priority message, regardless of notice level — losing one would strand the session.

### Switch-back and recovery

- **Default flush is lean (Anthony's instruction):** switching to a session delivers ONLY the turn-ending message (the final response), plus any pending approval requests/questions/artifact references. It does NOT dump the full buffered narration — a long `/goal`-style autonomous run can hold dozens of interim assistant messages, and replaying them all would flood the chat.
- The full buffered narration/tool history for a session is available ON DEMAND via a command (`/history` or `/replay <session> [n]`), optionally scoped (last N blocks). Same lever for the completion notice: it carries the turn-ending message, never the narration backlog.
- Narration history is therefore never auto-dumped; it is pull, not push. (Foreground live narration is unaffected — that streams in real time per the verbosity level.)
- Missed-output rules: never drop final responses, approval requests, questions, or artifact references. Interim narration is buffered but surfaced only on request.
- Restart recovery: persist the session list (provider, uuid, status, last activity) + buffered final outputs in the new state files; resume sessions lazily on next message (no thundering herd of resumes at boot).

### Acceptance

- A Claude turn runs in session A while Codex is foreground in session B; A finishes → a completion notice with (at `head`) the start of A's final response arrives in the lane; `/switch A` then shows A's full buffered output. Neither session blocks the other; no duplicate Telegram messages; aborting B's job does not touch A.
- Restart mid-run recovers session metadata and any buffered final output.

### Sequence note

TeleCodex build splits into: **V1a** = full command coverage (Section 3) + progress narration (Section 2) on the existing per-context provider switching; **V1b** = this section (lanes/jobs/buffers + background completion notices). V1b is the larger lift (it's the session-manager rework). Both ship before the production cutover; canary covers mixed Codex+Claude parallel runs explicitly.

## 4. Hermes — Step 0: stop patching core

The in-core Shape A (the `api_mode=="claude_code"` branch in `conversation_loop.py`, the forwarder in `run_agent.py`, plus `claude_code_runtime.py` / `claude_pty_session.py` / `claude_event_projector.py`) must come OUT of the Hermes tree and into Anthony's own package, delivered as a plugin under `~/.hermes/plugins` so Hermes updates can never clobber it.

Mechanism (per today's handoff doc, validated): a general plugin's `register(ctx)` imports `agent.conversation_loop`, saves the original `run_conversation`, and replaces it with a wrapper that delegates when `agent.provider == "claude-code"` (a clear config marker — NOT `api_mode: claude_code`, which `runtime_provider.py` `_VALID_API_MODES` filters out). Otherwise it calls through. Ship a model-provider profile too so the model picker/config sees `claude-code` (reuse a valid `api_mode` like `chat_completions` as metadata; the wrapper owns the real path).

Revert the core edits afterward so a `git pull` of Hermes is clean. The plugin is the only Hermes-side footprint, and it lives outside the repo.

Risks + guards: the wrapper depends on `run_conversation` staying patchable and on the result-dict shape staying stable; add a startup self-check that asserts both and logs loudly (so a Hermes refactor surfaces immediately instead of silently breaking). If Anthony later wants the clean permanent answer, upstream a generic `register_turn_runtime(name, predicate, runner)` hook (Option B) and convert the plugin to use it — designed, not required for H1.

---

## 5. Hermes H1 — PTY backend (subscription-safe, ship after TeleCodex)

Behind the plugin boundary, the PTY backend (the shared engine, Python side) runs one Claude Code session per Hermes session, resumed by UUID across gateway restarts.

Memory handling — hardened beyond the current in-core code:
- Inbound: inject Hermes' prefetched external memory (`_ext_prefetch_cache`, computed at the top of `run_conversation`) into the prompt text fed to Claude. The current in-core code does NOT forward this, so Claude runs blind to Hermes memory — fix that.
- Outbound: keep the post-turn `_sync_external_memory_for_turn` + `_spawn_background_review` (memory + skill review) the in-core runtime already calls. Approximate skill-nudge counting via `turn.tool_iterations` as today.
- Be honest in docs: this is the codex_app_server-class "bolt-on" memory, improved but not native. Native read/write requires H2.

Progress narration: the projector emits interim assistant text as progress events (Section 2), gated by the Hermes-side verbosity level, so Anthony sees Claude's running commentary during a delegated turn.

Caching/usage (recap, verified in code): Claude's own prompt caching is internal and untouched. Hermes-managed prefix caching does not apply once a turn is delegated (Claude makes the API calls, not Hermes) — fine. Token/cache numbers (input/output/cache_read/cache_creation) come from the transcript and are surfaced as usage; Hermes' context-% gauge becomes Claude's reported numbers.

---

## 6. Hermes H2 — Agent SDK backend (DESIGNED now, built later)

The same plugin boundary, backend flipped from `pty` to `agent_sdk`. This is the only route that gets orchestration AND real Hermes memory, because the SDK can be handed Hermes' own tools and exposes hooks.

Design:
- **Custom tools / in-process MCP:** register Hermes' memory-write tool (and optionally skill-manage) as SDK tools so the orchestrating Claude writes to the SAME backend Layla uses, mid-turn, natively. This closes the outbound memory gap the PTY can't.
- **Context injection:** pass Hermes' prefetched memory + relevant Layla context via the SDK's system-prompt/append mechanism, cleanly (not bracketed-paste). Closes the inbound gap.
- **Hooks (PreToolUse/PostToolUse):** fire on every internal step → real per-step progress narration to Telegram AND real skill-nudge/memory-check granularity instead of the once-per-turn approximation.
- **Permission round-trips:** the SDK permission callback (canUseTool) bridges to Hermes' approval flow → Telegram approve/deny, replacing PTY Phase-2 hook plumbing.
- **Session continuity:** SDK session resume per Hermes session.

### H2 authentication + billing — VERIFIED 2026-06-17

- **Subscription token is present locally:** `C:\Users\Anthony\.claude\.credentials.json` → `claudeAiOauth` { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier }. Plaintext JSON, refreshable. The Agent SDK (like Claude Code) reads this logged-in credential automatically — no manual token copy is strictly required, though `claude setup-token` can mint an explicit `CLAUDE_CODE_OAUTH_TOKEN` for headless use.
- **Current billing (verified at source, support article 15036540, updated 2026-06-16):** the separate-bucket change is PAUSED. As of now, Agent SDK usage, `claude -p`, and third-party apps run by the user still DRAW FROM THE SUBSCRIPTION's usage limits — same as Claude Code. So H2 on Anthony's subscription is billing-fine TODAY.
- **The revocable risk:** the paused plan, if reinstated, moves Agent SDK / `claude -p` usage OFF the plan onto a monthly "Agent SDK credit", then API rates. So H2's billing can shift under us at Anthropic's discretion; H1 (PTY = literally Claude Code on the subscription) is immune and is the always-safe floor.
- **ToS nuance (verified, agent-sdk overview):** Anthropic disallows THIRD-PARTY DEVELOPERS offering claude.ai login/limits in PRODUCTS for OTHER users, and steers them to API keys. Anthony's case is single-user personal use of his OWN plan on his OWN machine — the "use the Agent SDK with your Claude plan" scenario, which is the sanctioned personal path. Not a product with external logins. So the warning doesn't block H2 for his use, but it confirms the subscription-via-SDK route is the grey-but-personal path, while the API-key route is the unambiguous (paid) one.

Net: H1 = guaranteed subscription, zero ambiguity. H2 = currently subscription (paused), auth via the existing stored credential, billing revocable by Anthropic; sanctioned for personal use. Build H1; keep H2 behind its own flag with a visible billing warning so a future un-pause is a known, opt-in cost change, not a surprise.

Still to PIN at H2 build time (code API only, not auth): exact SDK custom-tool registration (in-process MCP server helper), hook names/shapes (PreToolUse/PostToolUse), system-prompt override, session-resume, and permission callback. Flipping `pty`→`agent_sdk` changes nothing downstream.

---

## 7. Sequencing

1. TeleCodex: full command coverage + progress narration + canary + ship (gated).
2. Hermes Step 0: extract the core patch into a `~/.hermes/plugins` plugin; revert core edits; add the patchability self-check.
3. Hermes H1: PTY backend behind the plugin, hardened memory, progress narration; CLI live test (Anthony's go), then gateway.
4. Hermes H2: when billing is settled — wire the SDK backend (MCP memory tool + hooks + permission callback). Config flip.

Shared engine built once (TeleCodex), mirrored in the Hermes plugin. Optional later: collapse both onto one Python OpenAI-compatible local bridge (appendix) for a single source of truth.

---

## Appendix: OpenAI-compatible local bridge (deferred option)

Wrap the Python PTY engine in a local server speaking OpenAI `/v1/chat/completions`, registered in Hermes as a `chat_completions` custom provider (base_url → localhost) = zero core patch, sidesteps `_VALID_API_MODES`, and serves both TeleCodex and Hermes from one engine. NOT used for H1 because it makes Claude opaque to Hermes' deeper memory/skill hooks (worse for the memory requirement) and re-introduces OpenAI-compat streaming fiddliness. Kept as the long-term single-source-of-truth option if maintaining two engine implementations becomes painful.
