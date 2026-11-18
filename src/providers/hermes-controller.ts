import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Context } from "grammy";
import type { TeleCodeConfig } from "../config.js";
import { contextKeyFromCtx } from "../context-key.js";
import type { SessionRegistry } from "../session-registry.js";
import type { AgentSessionManager, AgentSessionRecord } from "../agent-session-manager.js";
import { ensureOutDir } from "../artifacts.js";
import { outboxPath, outputFilesInstruction } from "../attachments.js";
import { HermesRuntime, hermesProfiles, type HermesSessionRow } from "./hermes-runtime.js";

interface HermesHooks {
  config: TeleCodeConfig;
  registry: SessionRegistry;
  sessions: AgentSessionManager;
  runtime: HermesRuntime;
  persist(): void;
  reply(ctx: Context, text: string): Promise<unknown>;
  prompt(ctx: Context, text: string): string;
  artifacts(ctx: Context, folder: string): Promise<void>;
  reaction?(ctx: Context, state: "working" | "done" | "failed"): Promise<void>;
  typing?(ctx: Context): Promise<void>;
  /** Named Hermes agents installed on this host. Defaults to the profiles folder. */
  profiles?(): string[];
  /** Runtime for a named Hermes agent (profile). Defaults to `new HermesRuntime(undefined, profile)`. */
  runtimeFor?(profile: string): HermesRuntime;
}

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** "hermes" -> undefined (default agent), "hermes:social" -> "social". */
export function hermesProfile(agent: string): string | undefined {
  const match = /^hermes(?::(.+))?$/i.exec(agent.trim());
  if (!match) throw new Error("Not a Hermes agent.");
  const name = match[1]?.toLowerCase();
  if (name === undefined || name === "default") return undefined;
  if (!PROFILE.test(name)) throw new Error("Hermes agent names use lowercase letters, digits, - and _.");
  return name;
}
export const hermesAgentName = (profile?: string) => profile ? `hermes:${profile}` : "hermes";

/** Hermes uses the same lane/session/job registry as Codex and Claude. Native
 * commands go to command.dispatch, never to a model pretending to execute them. */
export class HermesController {
  private readonly active = new Map<string, Promise<void>>();
  private readonly runtimes = new Map<string, HermesRuntime>();
  constructor(private readonly hooks: HermesHooks) {}
  static profileOf(record?: AgentSessionRecord): string | undefined {
    const profile = record?.metadata?.profile;
    return typeof profile === "string" && profile ? profile : undefined;
  }
  profiles(): string[] { return this.hooks.profiles?.() ?? hermesProfiles(); }
  /** Stored sessions of the default Hermes agent and of every named agent TeleCode
   * has used, for /sessions. An agent that does not answer within a few seconds
   * is left out of the list rather than delaying it. */
  async listSessions(limit = 50): Promise<Array<HermesSessionRow & { profile?: string }>> {
    if (!this.hooks.runtime.available()) return [];
    // Only once Hermes is in use here: a host that never selected Hermes is not
    // made to wait for (or start talking to) a Hermes gateway on every /sessions.
    let inUse = this.runtimes.size > 0 || this.hooks.runtime.connected?.() === true;
    const used = new Set<string>(this.runtimes.keys());
    for (const lane of this.hooks.sessions.listLanes()) {
      for (const record of this.hooks.sessions.listLaneSessions(lane.laneKey)) {
        if (record.provider !== "hermes") continue;
        inUse = true;
        const profile = HermesController.profileOf(record);
        if (profile) used.add(profile);
      }
    }
    if (!inUse) return [];
    const lists = await Promise.all([undefined, ...used].map(async (profile) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 3_000); timer.unref?.(); });
      try { return (await Promise.race([this.runtime(profile).listSessions(limit), timeout])).map((row) => ({ ...row, ...(profile ? { profile } : {}) })); }
      catch { return []; }
      finally { clearTimeout(timer); }
    }));
    return lists.flat();
  }
  private runtime(profile?: string): HermesRuntime {
    if (!profile) return this.hooks.runtime;
    let runtime = this.runtimes.get(profile);
    if (!runtime) { runtime = this.hooks.runtimeFor?.(profile) ?? new HermesRuntime(undefined, profile); this.runtimes.set(profile, runtime); }
    return runtime;
  }
  private runtimeOf(record: AgentSessionRecord): HermesRuntime { return this.runtime(HermesController.profileOf(record)); }
  /** Most recent Hermes session in the lane, optionally only for one agent (profile). */
  private record(lane: string, only?: { profile?: string }): AgentSessionRecord | undefined {
    const selected = this.hooks.sessions.getLane(lane)?.selectedSessionId;
    return this.hooks.sessions.listLaneSessions(lane).filter((s) => s.provider === "hermes" && (!only || HermesController.profileOf(s) === only.profile))
      .sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || (b.lastSelectedAt ?? b.updatedAt) - (a.lastSelectedAt ?? a.updatedAt))[0];
  }
  /** The agent ("hermes" or "hermes:NAME") the lane is using, if Hermes is active. */
  currentAgent(lane: string): string | undefined {
    if (this.hooks.registry.getActiveProvider(lane) !== "hermes") return undefined;
    const record = this.record(lane);
    return hermesAgentName(HermesController.profileOf(record));
  }
  /** Select (or create) a session of one specific Hermes agent. */
  async selectAgent(lane: string, profile: string | undefined, workspace = this.hooks.config.workspace): Promise<AgentSessionRecord> {
    const existing = this.record(lane, { profile });
    return existing ? this.select(lane, existing) : this.select(lane, await this.fresh(lane, workspace, profile));
  }
  async select(lane: string, record?: AgentSessionRecord): Promise<AgentSessionRecord> {
    if (!this.hooks.runtime.available()) throw new Error("Hermes is not configured on this TeleCode host.");
    let target = record ?? this.record(lane);
    if (!target) target = await this.fresh(lane, this.hooks.config.workspace);
    else if (target.providerSessionId) await this.runtimeOf(target).resume(target.providerSessionId);
    this.hooks.registry.setActiveProvider(lane, "hermes");
    this.hooks.sessions.selectSession(lane, target.id);
    this.hooks.persist();
    return target;
  }
  async fresh(lane: string, workspace: string, profile?: string): Promise<AgentSessionRecord> {
    const native = await this.runtime(profile).create(workspace);
    const record = this.hooks.sessions.createSession(lane, "hermes", { workspace, displayName: profile ? `Hermes ${profile}` : "Hermes", providerSessionId: native.id,
      metadata: { model: native.info.model, nativeProtocol: "hermes-gateway-v1", ...(profile ? { profile } : {}) } });
    this.hooks.registry.setActiveProvider(lane, "hermes"); this.hooks.persist();
    return record;
  }
  async handle(ctx: Context, text: string): Promise<boolean> {
    const lane = contextKeyFromCtx(ctx);
    if (!lane) return false;
    const command = /^\/([\w-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    const name = command?.[1].toLowerCase(), argument = command?.[2]?.trim() ?? "";
    const active = this.hooks.registry.getActiveProvider(lane) === "hermes";
    const choose = name === "hermes" || name === "provider" && /^hermes(?::\S+)?$/i.test(argument);
    const explicitNew = name === "new" && /^hermes(?::\S+)?(?:\s|$)/i.test(argument);
    if (choose) {
      // "/hermes social" picks the named agent, like "/provider hermes:social".
      // Any other text after /hermes is a prompt for the current Hermes agent.
      const named = name === "hermes" && /^[a-z0-9][a-z0-9_-]*$/i.test(argument) &&
        (argument.toLowerCase() === "default" || this.profiles().includes(argument.toLowerCase()));
      const agent = name === "provider" ? argument : named ? `hermes:${argument.toLowerCase()}` : "hermes";
      const target = agent.includes(":") ? await this.selectAgent(lane, hermesProfile(agent)) : await this.select(lane);
      if (name === "provider") this.hooks.sessions.setDefaultProvider(lane, "hermes");
      this.hooks.persist();
      await this.hooks.reply(ctx, `${target.displayName ?? "Hermes"} selected. Session: ${target.id}. Use normal commands such as /new, /model and /status.`);
      if (name === "hermes" && argument && !named) await this.run(ctx, target, argument);
      return true;
    }
    if (explicitNew || active && name === "new" && !/^(?:codex|claude)(?:\s|$)/i.test(argument)) {
      const agent = explicitNew ? /^hermes(?::\S+)?/i.exec(argument)![0] : undefined;
      // A bare /new keeps the agent the lane is using; /new hermes:NAME picks one.
      const profile = agent ? hermesProfile(agent) : HermesController.profileOf(this.record(lane));
      let folder = explicitNew ? argument.slice(agent!.length).trim() : argument;
      folder = !folder || folder === "default" ? this.hooks.config.workspace : path.resolve(folder);
      if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error("Workspace not found. Use /new, /new default, or /new hermes EXISTING_FOLDER.");
      const target = await this.fresh(lane, folder, profile);
      await this.hooks.reply(ctx, `New ${target.displayName ?? "Hermes"} session selected. Workspace: ${folder}. Session: ${target.id}.`);
      return true;
    }
    if (!active) return false;
    // These are TeleCode's shared navigation, policy and provider controls.
    if (name && ["provider", "codex", "claude", "new", "help", "health", "sessions", "switch", "use", "prev", "previous", "next", "sessionorder", "find", "search", "jobs", "alljobs", "replay", "saxo_approve", "reactions", "typing"].includes(name)) return false;
    const target = await this.select(lane);
    if (name === "abort" || name === "stop") {
      if (argument) return false;
      await this.runtimeOf(target).interrupt(target.providerSessionId!);
      await this.hooks.reply(ctx, "Stop requested for the selected Hermes session.");
      return true;
    }
    if (name) {
      const nativeName = name === "session" || name === "start" ? "status" : name;
      const result = await this.runtimeOf(target).command(target.providerSessionId!, `/${nativeName}${argument ? " " + argument : ""}`);
      if (result.notice) await this.hooks.reply(ctx, result.notice);
      if (result.type === "send" && result.message) await this.run(ctx, target, result.message);
      else await this.hooks.reply(ctx, result.output?.trim() || "Hermes command completed.");
      return true;
    }
    await this.run(ctx, target, text);
    return true;
  }

  private async run(ctx: Context, target: AgentSessionRecord, text: string): Promise<void> {
    if (this.active.has(target.id)) {
      await this.hooks.reply(ctx, "This Hermes session is still working. Use /stop, or /new to work in another session.");
      return;
    }
    // The same Hermes conversation may be open in another chat (Telegram and
    // WhatsApp). It runs in one chat at a time; Hermes itself holds the history.
    for (const id of this.active.keys()) {
      const other = this.hooks.sessions.getSession(id);
      if (other && other.laneKey !== target.laneKey && other.providerSessionId === target.providerSessionId) {
        await this.hooks.reply(ctx, "This conversation is still working in your other chat. Wait until it finishes there, or stop it there with /stop, then try again.");
        return;
      }
    }
    const job = this.hooks.sessions.startJob(target.id); this.hooks.persist();
    const foreground = () => this.hooks.registry.getActiveProvider(target.laneKey) === "hermes" && this.record(target.laneKey)?.id === target.id;
    const pulse = () => { if (foreground()) void this.hooks.typing?.(ctx).catch(() => {}); };
    const typing = setInterval(pulse, 4_500);
    typing.unref?.();
    pulse();
    const task = (async () => {
      const folder = outboxPath(target.workspace || this.hooks.config.workspace, randomUUID());
      try {
        await this.hooks.reaction?.(ctx, "working");
        await ensureOutDir(folder);
        const input = this.hooks.prompt(ctx, text) + "\n\n" + outputFilesInstruction(folder);
        await this.runtimeOf(target).prompt(target.providerSessionId!, input, async (message, final) => {
          if (foreground()) await this.hooks.reply(ctx, message);
          else if (final) await this.hooks.reply(ctx, `Hermes finished in background: ${target.displayName ?? target.id}\n\n${message}`);
        }, job.id);
        await this.hooks.artifacts(ctx, folder);
        this.hooks.sessions.completeJob(job.id);
        await this.hooks.reaction?.(ctx, "done");
      } catch (error) {
        this.hooks.sessions.failJob(job.id, error instanceof Error ? error.message : "Hermes failed");
        await this.hooks.reaction?.(ctx, "failed");
        await this.hooks.reply(ctx, `Hermes: ${error instanceof Error ? error.message : "the turn failed"} No automatic retry or provider fallback.`);
      } finally { clearInterval(typing); this.hooks.persist(); this.active.delete(target.id); }
    })();
    this.active.set(target.id, task);
  }
  async dispose(): Promise<void> {
    for (const id of this.active.keys()) {
      const record = this.hooks.sessions.getSession(id);
      if (record?.providerSessionId) await this.runtimeOf(record).interrupt(record.providerSessionId).catch(() => {});
    }
    await this.hooks.runtime.dispose();
    for (const runtime of this.runtimes.values()) await runtime.dispose();
  }
}
