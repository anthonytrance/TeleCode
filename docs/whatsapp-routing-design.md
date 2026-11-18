# WhatsApp agent routing and restricted guests

Status: owner-only transport and Hermes answering through its existing gateway
are implemented. The real Hermes file-tool and cold-resume checks pass. The phone
was paired and its account identity/connection verified on 2026-11-18. Real owner
message and attachment checks remain pending. Guest isolation and the unified provider registry are a design,
not enabled features. Shared agent-selection state lives in `src/routing`, outside
the WhatsApp adapter. Active Telegram dispatch has not been converted.

## Shared TeleCode registry and command handling

Routing belongs to TeleCode, independent of Telegram and WhatsApp. Each transport
authenticates an identity (WhatsApp sender or Telegram numeric user ID) and hands
it to the same principal, grant and provider registry. Linking identities requires
an explicit owner decision; phone numbers and Telegram usernames are not aliases.

User-visible entries can be Codex, Claude, Hermes personal and Hermes social
editor. Distinguish adapter kind (SDK or gateway protocol), deployment (the actual
host or contained worker) and selected entry (deployment, profile and policy).
Reject a restricted entry whose deployment is the unrestricted owner host.

Effective capabilities are the intersection of the selected entry policy and the
principal's grant. An owner selecting the restricted editor receives that entry's
limits too. Administrative authority belongs to the authenticated principal and
is handled by trusted TeleCode code, never injected into the editor's tools.

Anthony explicitly rejected command prefixes. Select an entry once, then send
ordinary commands such as `/new`, `/model` and `/help` to the active entry's command
adapter. No `/hermes` or repeated `/codex` prefix. TeleCode intercepts its explicit
provider-selection and administrative operations; provider adapters expose their
native commands and report unsupported operations clearly. Authorization happens
before dispatch, including command-specific capability checks for guests.

Hermes' HTTP chat endpoint runs a full agent, but plain slash text is not a proven
native-command interface. Its documented shared-gateway JSON-RPC interface exposes
`command.resolve`, `command.dispatch` and `commands.catalog`, which is the proper
path for full native command forwarding. Do not claim HTTP model prompts execute
all Hermes commands. The current owner HTTP adapter implements `/new` by rotating
its API session; its model change is not exposed yet. Complete native command
support should use the gateway command protocol, preserving session ownership.

Telegram conversion must audit every handler and callback. Existing allowed-user
IDs must not silently become unrestricted guest grants. Every button rechecks the
clicking principal and current grant. Guest status, stop and session operations
are scoped to their own jobs. Entries that disappear or fail never fall back to
an owner provider. Bind in-flight work and its replies to the original principal,
entry, conversation and session rather than the current UI selection.

## Identity, routing and conversations

One authenticated GOWA connection feeds one router. The router validates account,
slot, transport signature and the actual sender. Display names, message text,
forwarded identities and quoted text never establish permissions.

A principal record determines allowed agents and capabilities. The full owner
can select TeleCode or Hermes for each private owner conversation. Within
TeleCode, Codex and Claude remain provider choices. Hermes is an agent backend,
invoked through its existing authenticated local gateway API, with its own tools,
memory and durable conversation state. Its native WhatsApp adapter remains off.

Exactly one selected backend receives an input. Switching is handled by trusted
router code, ordered with the conversation's queue. It is not a second LLM call
and cannot be triggered by generated assistant text. Persist a separate backend
session for each principal, account, conversation and agent, so returning to a
backend resumes its own history. The existing owner's Telegram sessions are not
silently adopted as WhatsApp sessions.

An ordinary contact has no agent access. A separately granted guest is pinned to
explicitly assigned agent IDs, for example `social-editor`. A guest cannot select
the owner agent, add numbers, alter policy, use an owner's session ID, or widen a
conversation into a shared group. Initially only private chats are admitted.

## A Hermes profile is not a sandbox

A profile separates configuration, model settings, memory and transcripts. It
does not prevent a local agent from reading or writing the host user's files.
Hermes' write-safe-root covers its file-writing tools, but a host terminal can
bypass that guard. A Docker terminal backend alone also does not establish that
every file, browser, MCP, credential and host-side tool runs inside the container.

The recommended guest deployment is a separate full-agent worker/gateway inside
an enforced OS boundary, using a distinct Hermes profile inside that boundary.
Contain the entire agent process and all guest tools, not only `terminal`.

On this Windows host, determine whether a full-agent container/VM is available
before choosing it. A separate Windows user and carefully tested ACL/token/job
and network restrictions are another possible implementation, but a different
process under the owner's account is not isolation. No guest should be enabled
until an actual deployment passes the escape and capability tests below.

## Worker contents and capabilities

The guest worker gets immutable agent code and an approved read-only snapshot of
the video-editing skill. It may write its own minimal state, temporary files,
edit plans and renders. Only explicitly assigned media/job workspaces are visible.
Use read-only input assets and writable per-job output storage where practical.
Editing inherently needs scoped writes; unrestricted host writes are unnecessary.

Do not expose the owner's skill directories, home directories, shared memory,
browser profiles, desktop session, WhatsApp keys, SSH/cloud credentials, raw Docker
socket, host filesystem mounts, or broad MCP servers. Give the worker a minimal
environment. Its model/API access must not carry the owner's general gateway key
or messaging/admin capability. Prefer a narrowly scoped model proxy when the
worker should not possess a reusable provider credential.

This boundary includes media parsers and preview/thumbnail generation. A hostile
video is not safe merely because its filename is inside a permitted directory.
FFmpeg, unpacking, metadata extraction and render previews belong in the worker.
Network egress is restricted to required services through a controlled proxy.
Host services and loopback metadata/control endpoints must be inaccessible or
reject a guest's distinct credentials. Read-only mounts are not confidentiality
boundaries: never mount a private directory merely because it is read-only.

## Trusted media and delivery broker

The router/broker holds WhatsApp credentials and policy. The guest receives scoped
job and artifact IDs instead of arbitrary host paths. The broker resolves them
against its own principal/job registry, rejects symlink and reparse escapes, and
streams only assigned assets. It never runs shell strings supplied by a guest.

Initially a guest can request an edit and receive its own results. It cannot list
other WhatsApp conversations, read owner chats, choose arbitrary recipients, send
external messages, publish to social accounts, or mutate grants. Adding a social
publishing role would be a separate explicit capability, not a consequence of
having the editing skill. Owner-required approvals stay outside guest/model text.

Outbound artifact delivery is bound to the requesting principal and originating
conversation. A worker's claimed `to`, `ownerChat`, `agent_id`, session ID or source
number cannot override that binding. Original photos/videos are documents, with
immutable byte snapshots and hashes. Host paths from the current owner CLI are
not an acceptable guest API.

The current local control bearer is an OWNER credential. Its `/chats`, `/messages`,
`/draft`, `/confirm` and `/deliver` surfaces are not delegated to guests. A guest
broker needs separate audience-bound, revocable credentials and allowlisted
operations, with no owner-route fallback when a target is unavailable.

## Revocation, durability and resource use

Every admission records the principal, policy version, target agent, job scope and
conversation binding. Recheck authorization when queued work starts and before
delivering output. Revocation stops new work, invalidates capabilities and prevents
pending deliveries. Define and test how already running renders are cancelled.
Bound per-principal concurrency, disk, memory, CPU, execution time and model spend.

Transport deduplication and worker idempotency prevent duplicate execution on
reconnects. Do not automatically replay an uncertain send or an interrupted action
that might already have caused effects. Guest inputs, outputs and cached state
stay separate across jobs/principals according to an explicit retention policy.

## Required tests before admitting a guest

* An unassigned number remains silent; an assigned number reaches only its agent.
* Guest text, quoted owner messages, forwarded contacts and model output cannot
  switch agent, add grants, select an owner session or approve owner actions.
* Attempts to read owner homes/skills/memory and to create or replace host files
  fail from terminal, file tools, Python, FFmpeg, browser and every exposed MCP tool.
* Symlink/junction, archive traversal and reparse races cannot escape asset scope.
* Calls to the owner control API, Hermes owner API, host browser/debug endpoints
  and metadata addresses fail, including SSRF through media URLs and tool arguments.
* No owner API keys or inherited credentials appear in environment, mounted files,
  processes, logs, exception messages or generated artifacts.
* Job/session/cache identifiers cannot be used by another principal. Shared-agent
  collaboration, if desired, is an explicit workspace grant rather than implicit
  transcript sharing.
* A guest cannot send an output to another recipient or publish it by injecting
  instructions in an edit plan, image metadata, tool output or an artifact filename.
* Revocation while queued, rendering and awaiting delivery blocks the subsequent
  step. Reconnects, retries and interrupted workers do not duplicate sends.
* Large-file transfers preserve hashes without whole-file RAM buffers; resource
  limits and failed-job cleanup work on the actual Windows deployment.

## Phases

1. Finish and live-test the two owner routes, original-document transfers and
   explicit TeleCode/Hermes selection. Other numbers stay denied.
2. Implement the distinct principal/policy registry and a narrow job/artifact
   broker. Keep guest grants disabled.
3. Deploy the entire guest Hermes worker inside a verified OS boundary and run
   the adversarial tests on that deployment.
4. Only then activate an owner-approved number-to-`social-editor` grant with
   explicit workspace, delivery and resource permissions.

## Independent review, 2026-11-18

Claude Opus 5.5 independently reviewed the requirements, then challenged the
worker design and the unified TeleCode registry in two follow-ups. Model
`claude-opus-5-5` was confirmed. Effort `xhigh` was requested and supported by live
model discovery; the result did not echo an applied effort, so that setting is
not independently confirmed by the result metadata. The initial source-heavy
attempt exhausted its tool-turn limit without a verdict; the completed review
used supplied verified evidence rather than claiming to audit all code.

Opus agrees that a shared TeleCode named-provider registry is better than
separate WhatsApp routing. It distinguishes adapter, deployment and registry
entry, and requires grant/policy intersection, no owner fallback, and rechecking
Telegram callbacks. Its command-prefix suggestion was rejected by Anthony;
ordinary commands go to the selected provider adapter instead.

Its strongest challenge was to remove the guest's unrestricted shell altogether:
use a planning agent and a deterministic renderer, while still containing media
parsers. The accepted refinement keeps a contained Hermes worker but gives it
only brokered asset-inspection, edit-plan and render tools. Validate a typed edit
grammar; never accept arbitrary FFmpeg arguments, filters, expressions, URLs or
host paths. Fonts, LUTs and media use broker/catalog IDs. Richer approved operations
can be added with adversarial tests. Keep model credentials outside the worker
behind a budget-enforcing proxy and avoid writable host shared folders.

Opus accepted same-requester render delivery as an explicit allowed capability,
with owner review only an optional rollout gate. It withdrew an exactly-once
external-send claim: deduplicate input, record uncertain sends and never replay
them automatically. Separate per-guest workers/snapshots are preferred; whether a
shared contained deployment can satisfy cross-guest isolation remains unresolved.
No unverified Windows edition or WSL containment claim is adopted. A review does
not prove containment and no guests are enabled.
