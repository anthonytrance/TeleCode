# TeleCode

TeleCode is a provider-aware Telegram interface for coding agents. It runs persistent OpenAI Codex and Claude Code sessions, supports parallel provider workflows, and exposes SDK, app-server, session, usage, and delivery diagnostics without requiring a visual terminal.

## Features

- **Codex and Claude Code** — switch providers per Telegram context while preserving each provider's conversation
- **Parallel provider sessions** — keep working in the foreground while another provider finishes in the background
- **Per-context sessions** — each Telegram chat or forum topic gets independent provider sessions, models, and busy state
- **Backend diagnostics** — inspect and switch Codex SDK/app-server and Claude SDK/PTY paths from Telegram
- **Streaming responses** — agent text can be delivered as messages, a rolling edited message, or final-only output
- **Full tool visibility** — shell commands, file changes, web searches, MCP calls, and error items shown with configurable verbosity
- **Live plan display** — Codex's todo list rendered as a separate message and updated as steps complete
- **Voice transcription** — send a voice message or audio file; TeleCode transcribes it (local parakeet-coreml or OpenAI Whisper) and forwards the text to Codex
- **Image input** — send a photo (with optional caption) to pass screenshots or images directly to Codex
- **File ingest & artifacts** — send a document to stage it for Codex; generated files are delivered back as Telegram documents
- **Session browser** — `/sessions` lists recent threads from `~/.codex`, grouped by workspace; tap to switch
- **Telegram login** — `/login` authenticates against the Codex CLI via device auth flow, no terminal needed
- **Launch profiles** — `/launch_profiles` selects the sandbox + approval mode for new or reattached threads in the current Telegram context (`/launch` remains an alias)
- **Model picker** — `/model` shows available models and lets you switch for new threads
- **Reasoning effort** — `/effort` lets you dial from `minimal` to `xhigh` for new threads
- **Optional message reactions** — 👀 while processing, 👍 on success when enabled; silently degrades in chats without reaction support
- **Friendly errors** — common SDK and network errors are translated to actionable messages with command hints
- **Token usage** — session token totals shown on `/session`, with optional per-turn footer in replies
- **Handback flow** — `/handback` prints a ready-to-run `codex resume <id>` command (copied to clipboard on macOS)
- **User allowlist** — only configured Telegram user IDs can interact with the bot
- **Docker-friendly** — workspace auto-detected (`/workspace` in containers, `cwd` otherwise)

## Prerequisites

- Node.js 22+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The Codex CLI installed and authenticated on the host:
  - API key auth: set `CODEX_API_KEY`
  - ChatGPT login: `codex login` on the machine, or use `/login` from Telegram
- *(Optional)* `ffmpeg` — required for local voice transcription via parakeet-coreml
- *(Optional)* `OPENAI_API_KEY` — enables OpenAI Whisper as a voice transcription fallback

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Fill in `.env`:

   | Variable | Required | Description |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
   | `TELEGRAM_ALLOWED_USER_IDS` | ✅ | Comma-separated Telegram user IDs |
   | `CODEX_API_KEY` | — | API key for Codex (alternative to ChatGPT login) |
   | `CODEX_MODEL` | — | Default model, e.g. `gpt-5.4`, `o3` |
  | `CODEX_BACKEND` | — | Runtime backend selector: `app-server` or `sdk` |
   | `CODEX_APP_SERVER_PATH` | — | Optional absolute Codex binary path used by `/appserver` |
   | `CODEX_SANDBOX_MODE` | — | `read-only`, `workspace-write` *(default)*, `danger-full-access` |
   | `CODEX_APPROVAL_POLICY` | — | `never` *(default)*, `on-request`, `on-failure`, `untrusted` |
   | `CODEX_LAUNCH_PROFILES_JSON` | — | Optional JSON array of named launch profiles for `/launch_profiles` |
   | `CODEX_DEFAULT_LAUNCH_PROFILE` | — | Default launch profile id (defaults to `default`) |
   | `ENABLE_UNSAFE_LAUNCH_PROFILES` | — | Set to `true` to allow extra `danger-full-access` launch profiles |
   | `TOOL_VERBOSITY` | — | `all`, `summary` *(default)*, `errors-only`, `none` |
   | `STREAM_ASSISTANT_TEXT` | — | Stream assistant text before final reply (`false` by default) |
   | `PROGRESS_DELIVERY` | — | Intermediate progress delivery: `messages` *(default)*, `edit`, or `none` |
   | `SHOW_TURN_TOKEN_USAGE` | — | Show the per-turn `in/cached/out` footer in final replies (`false` by default) |
   | `MAX_FILE_SIZE` | — | Max upload size in bytes (default `20971520` = 20 MB) |
   | `ENABLE_TELEGRAM_LOGIN` | — | Allow `/login` and `/logout` from Telegram (`true` by default) |
   | `ENABLE_TELEGRAM_REACTIONS` | — | Enable Telegram emoji reactions like 👀 / 👍 (`false` by default) |
   | `OPENAI_API_KEY` | — | Enables OpenAI Whisper voice transcription fallback |

4. Start the bot:
   ```bash
   npm run dev
   ```

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Welcome & status (concise for returning users) |
| `/help` | Grouped command reference |
| `/new` | Start a fresh thread (workspace picker if multiple workspaces) |
| `/new default` | Start a fresh thread in `CODEX_WORKSPACE` |
| `/newsummary` | Start a fresh thread from a handoff summary of the current thread |
| `/newsummary default` | Summarize the current thread into a fresh `CODEX_WORKSPACE` thread |
| `/forkthread [n]` | Fork the active app-server thread; with `n`, roll back that many turns on the fork only |
| `/renamethread <name>` | Rename the active app-server thread |
| `/rollbackthread <n>` | Roll back app-server thread history by `n` turns; file changes are not reverted |
| `/session` | Current thread ID, workspace, model, effort, and token totals |
| `/backend` | Show the current backend for this Telegram context |
| `/backend appserver` | Switch this Telegram context to app-server; persists across restarts |
| `/backend sdk` | Switch this Telegram context back to SDK; persists across restarts |
| `/verbosity <mode>` | Set progress delivery for this Telegram context: `messages`, `edit`, or `none` |
| `/appserver` | Probe the Codex app-server without switching the live backend |
| `/appserverturn <prompt>` | Run one isolated app-server diagnostic turn |
| `/appserversteer <initial> || <steer>` | Run one isolated app-server turn and steer it mid-turn |
| `/appbackendtest` | Smoke-test the app-server backend path without switching this Telegram context |
| `/artifacttest` | Generate and send a small text file through TeleCode artifact delivery |
| `/sessions` | Browse recent threads grouped by workspace; tap to switch |
| `/switch <id>` | Switch directly to a thread by ID |
| `/retry` | Resend the last prompt |
| `/last` | Repeat the latest completed assistant reply (`/copy` and `/repeat` aliases) |
| `/abort` | Cancel the current turn |
| `/steer <text>` | Steer an active Codex app-server turn or active Claude turn |
| `/launch_profiles` | Select launch profile for new or reattached threads (`/launch` alias kept) |
| `/model` | View and change the model |
| `/effort` | Set reasoning effort: `minimal` · `low` · `medium` · `high` · `xhigh` |
| `/auth` | Check authentication status |
| `/login` | Start Codex device-auth flow from Telegram |
| `/logout` | Sign out of Codex |
| `/voice` | Check voice transcription backend status |
| `/handback` | Print `codex resume <id>` for CLI handoff |
| `/attach <id>` | Bind an existing Codex thread to this forum topic |

### Voice, image & file input

- **Voice / audio** — send any voice message or audio file; TeleCode transcribes it and sends the result to Codex
- **Photos** — send a photo with an optional caption; the image is forwarded to Codex as visual input
- **Documents** — send a file (with optional caption); TeleCode stages it in the workspace, runs Codex, and delivers any generated files back as Telegram documents

### Tool verbosity

| Mode | What you see |
|---|---|
| `all` | Every tool start, streaming output, and result |
| `summary` *(default)* | Tool calls stay quiet during the turn; assistant progress and the final answer still follow the selected progress-delivery mode |
| `errors-only` | Only failed tool calls |
| `none` | Silent |

Per-turn token usage is hidden by default. Set `SHOW_TURN_TOKEN_USAGE=true` if you want the `in / cached / out` footer appended to final replies.

### Progress delivery

`PROGRESS_DELIVERY` sets the default progress delivery mode, and `/verbosity <mode>` overrides it per Telegram context.

| Mode | What you see |
|---|---|
| `messages` *(default)* | Separate progress messages during the turn, with the final answer sent cleanly |
| `edit` | One short rolling progress message for assistant progress text only, then a separate final answer. Tool activity stays silent in this mode |
| `none` | No progress messages, only the final answer unless there is an error |

Changing `/verbosity` during an active turn affects future progress updates in that turn. Telegram messages already sent are not merged or rewritten into the new mode.

When Codex or Claude finishes in the background, TeleCode sends the full final answer with a provider completion heading. Intermediate background commentary stays quiet and is retained in a bounded 100-event in-memory backlog. Switch to that provider session and use `/replay [1-100|all]` to release the backlog in message-sized blocks. `/history` remains the transcript-backed option for older Codex output.

### Launch profiles

- TeleCode always provides a built-in `default` profile synthesized from `CODEX_SANDBOX_MODE` and `CODEX_APPROVAL_POLICY`
- Built-in Telegram-visible presets are:
  - `Default`
  - `Read Only`
  - `Review`
  - `Full Access` when `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- `Workspace Write` is not listed separately because it is already the default behavior in the shipped config
- Optional extra profiles can be configured with `CODEX_LAUNCH_PROFILES_JSON`, for example:
  ```json
  [
    { "id": "readonly", "label": "Read Only", "sandboxMode": "read-only", "approvalPolicy": "never" },
    { "id": "review", "label": "Review", "sandboxMode": "workspace-write", "approvalPolicy": "on-request" }
  ]
  ```
- `/launch_profiles` changes only future thread creation or reattachment in the current chat/topic context; it does not mutate an already active thread in place
- Extra `danger-full-access` profiles are blocked unless `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Selecting a `danger-full-access` profile from Telegram requires an explicit confirmation step

## Multi-Session Architecture

Each Telegram chat or forum topic is identified by a **context key** — the chat ID alone for private chats, or `chatId:threadId` for forum topics. This means every topic in a supergroup gets its own independent Codex session.

The `SessionRegistry` maps context keys to `CodexSessionService` instances:

```
┌───────────────────┐      ┌───────────────────────────────┐
│ Private Chat A     │─────▶│ CodexSessionService (thread X) │
│ key: "111"         │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 1  │─────▶│ CodexSessionService (thread Y) │
│ key: "222:1"       │      └───────────────────────────────┘
├───────────────────┤      ┌───────────────────────────────┐
│ Group B / Topic 2  │─────▶│ CodexSessionService (thread Z) │
│ key: "222:2"       │      └───────────────────────────────┘
└───────────────────┘
```

- **First message** in a context → creates a new `CodexSessionService` → starts a new Codex thread
- **Subsequent messages** → same context key → same session → conversation continues
- **`/new`** → replaces the thread within the same context (optionally picking a workspace first)
- **`/sessions`** → lists all Codex threads from `~/.codex`, lets you switch within the current context
- **`/attach <id>`** → resumes a specific Codex CLI thread (useful for picking up work started in the terminal)

Session metadata (thread ID, workspace, launch profile, model, effort) is persisted to `.telecode/contexts.json` and restored on restart so threads survive bot reboots.

TeleCode stores runtime state in `.telecode`. On first startup after upgrading, it automatically moves a legacy `.telecodex` state directory when the new path does not yet exist. New `TELECODE_*` safety variables are canonical, while their legacy `TELECODEX_*` equivalents remain accepted temporarily.

`/newsummary` follows the same active-thread replacement rule as `/new`, but it first captures a handoff summary from the previous active thread and sends that summary into the newly created thread.

Each context has independent busy-state tracking, so a running prompt in one topic doesn't block another.

## Handoff: Telegram → CLI

1. Run `/handback` in Telegram
2. TeleCode replies with:
   ```bash
   cd '/path/to/project' && codex resume 'thread-abc123'
   ```
3. Paste and run in your terminal

On macOS the command is also copied to the clipboard automatically.

## Handoff: Thread to Fresh Thread

Run `/newsummary` or send `new from summary` to create a compact handoff inside Telegram. TeleCode first asks the current thread for a summary, then starts a fresh Codex thread in the same context and sends that summary as the initial handoff. `/session` token totals are scoped to the new active thread after the handoff; previous-thread totals are not carried over.

## Architecture

```
Telegram ←→ Grammy bot (auto-retry, HTML formatting, inline keyboards)
                |
                v
        SessionRegistry  ──→  per-context CodexSessionService instances
                |
                ├── @openai/codex-sdk  ──→  spawns Codex CLI subprocess
                │     └── ThreadEvents (agent text, commands, file changes,
                │                       MCP calls, web searches, todo lists,
                │                       reasoning, errors, token usage)
                ├── CodexStateReader  ──→  ~/.codex/state_*.sqlite  (threads)
                │                    ──→  ~/.codex/models_cache.json (models)
                ├── CodexAuth        ──→  codex login/logout subprocess
                ├── Attachments      ──→  .telecode/inbox/<turnId>/ (staged files)
                ├── Artifacts        ──→  .telecode/outbox/<turnId>/ (generated files)
                └── VoiceTranscriber  ──→  parakeet-coreml (local)
                                     ──→  OpenAI Whisper (cloud fallback)
```

## Project Layout

```
TeleCode/
├── src/
│   ├── index.ts           — startup, signal handling, polling loop
│   ├── bot.ts             — Telegram bot, all commands and handlers
│   ├── bot-ui.ts          — pure render helpers (/help, /start, session labels)
│   ├── codex-launch.ts    — launch profile parsing, validation, and formatting
│   ├── codex-session.ts   — CodexSessionService wrapping the SDK
│   ├── codex-state.ts     — SQLite reader for thread/model discovery
│   ├── codex-auth.ts      — Codex CLI auth (login status, device auth, logout)
│   ├── session-registry.ts — per-context session map with persistence
│   ├── context-key.ts     — Telegram chat/topic → context key derivation
│   ├── attachments.ts     — file staging (sanitization, size limits)
│   ├── artifacts.ts       — generated file collection and Telegram delivery
│   ├── error-messages.ts  — SDK/network error → user-friendly translation
│   ├── voice.ts           — voice transcription (parakeet / Whisper)
│   ├── config.ts          — environment loading and validation
│   └── format.ts          — Markdown → Telegram HTML conversion
├── test/                  — 19 test files, 217+ tests (vitest)
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── tsconfig.json
└── vitest.config.ts
```

## Docker

```bash
docker compose up --build
```

The compose file:
- loads environment from `.env`
- mounts `~/.codex` for auth state and persisted threads
- mounts `./workspace` as `/workspace`
- runs as a non-root user

## Development

```bash
npm run dev      # run with tsx (no build step)
npm run build    # compile TypeScript
npm test         # run vitest
```

## Release Automation

TeleCode does not yet use the TelePi npm release pipeline, but the exact Trusted Publishing process has been documented so it can be adopted here.

See:
- `docs/npm-trusted-publishing.md`

That playbook covers:
- making the package publishable on npm
- adding a tag-driven GitHub Actions workflow
- configuring npm Trusted Publishing
- the maintainer release flow (`npm version ...` + `git push --follow-tags`)

## Security Notes

- Only users in `TELEGRAM_ALLOWED_USER_IDS` can interact with the bot
- Default sandbox mode is `workspace-write` — Codex can read and write within the working directory
- Use `danger-full-access` only if you fully trust the user and the host environment
- The built-in `Full Access` profile and any extra `danger-full-access` launch profiles are opt-in via `ENABLE_UNSAFE_LAUNCH_PROFILES=true`
- Default approval policy is `never` — suited for headless/automated use
- `/launch_profiles` only selects from validated configured profiles; Telegram users cannot submit arbitrary sandbox or approval values
- `CODEX_API_KEY` (agent auth) and `OPENAI_API_KEY` (voice transcription) are separate credentials
- `/login` and `/logout` can be disabled by setting `ENABLE_TELEGRAM_LOGIN=false`
- Files uploaded via Telegram are sanitized (name, size, type) before staging in the workspace
- All Markdown output is sanitized before being sent as Telegram HTML
