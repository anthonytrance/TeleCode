import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

export interface HermesEvent { type: string; session_id?: string; admission_id?: string; seq?: number; replay_epoch?: string; payload?: Record<string, any> }
export interface HermesRpc {
  request<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  on(name: string, listener: (...args: any[]) => void): unknown;
  off(name: string, listener: (...args: any[]) => void): unknown;
  start(): void;
  drain(): void;
  kill(reason?: string): void;
}

export interface HermesSessionRow { id: string; title: string; source?: string; startedAt?: number; messageCount?: number; model?: string }

/** Named Hermes agents (profiles) installed on this host, without the default agent. */
export function hermesProfiles(): string[] {
  const installation = discoverHermes();
  if (!installation) return [];
  try {
    return readdirSync(path.join(installation.home, "profiles"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)).map((entry) => entry.name).sort();
  } catch { return []; }
}

export function discoverHermes(): { home: string; cli: string; sdk: string } | undefined {
  const home = process.env.HERMES_HOME || path.join(homedir(), ".hermes");
  const cli = process.env.HERMES_CLI || path.join(home, "bin", process.platform === "win32" ? "hermes.exe" : "hermes");
  const sdk = path.join(home, "hermes-agent", "apps", "shared", "src", "node", "gateway-client.ts");
  return existsSync(cli) && existsSync(sdk) ? { home, cli, sdk } : undefined;
}

export class HermesRuntime {
  private connection?: Promise<HermesRpc>;
  private readonly attached = new Set<string>();
  /** `profile` selects a named Hermes agent (`hermes -p NAME`), which has its own
   * gateway, config, skills and tool permissions. Undefined means the default agent. */
  constructor(private readonly factory?: () => Promise<HermesRpc>, readonly profile?: string) {}
  available(): boolean { return !!this.factory || !!discoverHermes(); }
  /** Whether a gateway connection has been made (or is being made). */
  connected(): boolean { return !!this.connection; }
  /** Drop a connection that can no longer recover so the next call reconnects. */
  private forget(client: HermesRpc): void {
    void this.connection?.then((current) => {
      if (current !== client) return;
      this.connection = undefined;
      this.attached.clear();
      client.kill("connection abandoned");
    }, () => {});
  }
  private client(): Promise<HermesRpc> {
    if (!this.connection) this.connection = this.connect().catch((error) => { this.connection = undefined; throw error; });
    return this.connection;
  }
  private async connect(): Promise<HermesRpc> {
    if (this.factory) return this.factory();
    const installation = discoverHermes();
    if (!installation) throw new Error("Hermes gateway SDK/CLI is not installed. Configure HERMES_HOME and start Hermes first.");
    const module = await tsImport(pathToFileURL(installation.sdk).href, import.meta.url);
    let client!: HermesRpc;
    client = new module.GatewayClient({
      source: "tui", client: { name: "telecode", version: "0.1.0" }, requestTimeoutMs: 90_000,
      // Only a protocol mismatch is permanent. A gateway that is restarting or
      // briefly down must be retried with the client's own backoff, otherwise
      // the Hermes provider stays dead until TeleCode itself restarts.
      terminalConnectFailure: (error: Error) => {
        if (!/unsupported local attach grant/i.test(error.message)) return undefined;
        this.forget(client);
        return error.message;
      },
      connect: async () => {
        const args = [...(this.profile ? ["-p", this.profile] : []), "gateway", "attach", "--json"];
        const { stdout } = await promisify(execFile)(installation.cli, args, {
          env: { ...process.env, HERMES_HOME: installation.home }, windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024,
        }).catch((error: any) => {
          const detail = String(error?.stderr || error?.message || "").trim().split(/\r?\n/).pop();
          throw new Error(`Hermes agent ${this.profile ?? "default"} has no running gateway${detail ? ` (${detail})` : ""}. Start it with: hermes${this.profile ? ` -p ${this.profile}` : ""} gateway start`);
        });
        const grant = JSON.parse(stdout.trim());
        const url = new URL(grant.url);
        if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/api/ws" || grant.protocol !== "hermes-gateway-v1" ||
            !Array.isArray(grant.protocols) || !grant.protocols.some((p: string) => p.startsWith("hermes-gateway-ticket."))) throw new Error("Hermes returned an unsupported local attach grant.");
        return { url: grant.url, protocols: grant.protocols, profile_id: grant.endpoint.profile_id, instance_id: grant.endpoint.instance_id };
      },
    });
    client.on("request", (request: any) => {
      // Do not silently approve server requests. Canonical controls are exposed
      // as events; unsupported interactive requests fail closed in the SDK.
      request.reject?.(new Error("This interactive request requires a supported TeleCode approval UI."));
    });
    client.on("event", (event: HermesEvent) => {
      if (event.type === "gateway.ready") {
        for (const id of this.attached) void client.request("session.resume", { session_id: id, omit_messages: true }).catch(() => {});
      }
    });
    client.start(); client.drain();
    try { await client.request("runtime.describe", {}, 40_000); }
    catch (error) { client.kill("connection failed"); throw error; }
    return client;
  }

  async create(workspace: string, model?: string): Promise<{ id: string; info: Record<string, any> }> {
    const client = await this.client();
    const result = await client.request("session.create", { cwd: workspace, ...(model ? { model } : {}) });
    if (typeof result.session_id !== "string") throw new Error("Hermes did not return a session ID.");
    this.attached.add(result.session_id);
    return { id: result.session_id, info: result.info ?? {} };
  }
  /** Stored sessions of this agent, newest first, as Hermes' own session picker shows them. */
  async listSessions(limit = 50): Promise<HermesSessionRow[]> {
    const result = await (await this.client()).request("session.list", { scope: "stored", picker: true, limit: Math.max(1, Math.min(200, limit)) }, 20_000);
    return (Array.isArray(result?.sessions) ? result.sessions : []).flatMap((row: any): HermesSessionRow[] => {
      const id = typeof row?.session_id === "string" ? row.session_id : typeof row?.id === "string" ? row.id : undefined;
      if (!id) return [];
      const started = Number(row.started_at);
      return [{ id, title: typeof row.title === "string" ? row.title : "", source: typeof row.source === "string" ? row.source : undefined,
        startedAt: Number.isFinite(started) ? (started < 1e12 ? started * 1000 : started) : undefined,
        messageCount: Number.isSafeInteger(row.message_count) ? row.message_count : undefined, model: typeof row.model === "string" ? row.model : undefined }];
    });
  }
  async resume(id: string): Promise<void> {
    if (this.attached.has(id)) return;
    await (await this.client()).request("session.resume", { session_id: id, omit_messages: true }); this.attached.add(id);
  }
  async command(id: string, command: string): Promise<{ type?: string; output?: string; message?: string; notice?: string }> {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(command.trim());
    if (!match) throw new Error("Invalid Hermes command.");
    const client = await this.client(), name = match[1].toLowerCase(), arg = match[2]?.trim() ?? "";
    if (name === "model") {
      if (!arg) {
        const info = await client.request("session.info", { session_id: id });
        return { type: "exec", output: `Model: ${info.model ?? "Hermes default"}\nProvider: ${info.provider ?? "Hermes default"}\nUse /model MODEL to change this session.` };
      }
      const snapshot = await client.request("session.resume", { session_id: id, omit_messages: true });
      if (!Number.isSafeInteger(snapshot.revision) || !Number.isSafeInteger(snapshot.execution_generation)) throw new Error("Hermes did not return the model-change revision fence.");
      const result = await client.request("session.mutate", { session_id: id, request_id: randomUUID(), operation: "model",
        expected_revision: snapshot.revision, expected_generation: snapshot.execution_generation, payload: { model: arg } });
      if (result.status === "confirmation_required") throw new Error(String(result.confirm_message || "Hermes requires confirmation for that model. It has not been changed."));
      if (!result.model) throw new Error("Hermes did not acknowledge the model change.");
      return { type: "exec", output: `Model ${result.status === "deferred" ? "queued for the next turn" : "set"}: ${result.model}.` };
    }
    if (name === "history") {
      const snapshot = await client.request("session.resume", { session_id: id });
      const rows = (snapshot.messages ?? []).filter((r: any) => r.role === "user" || r.role === "assistant").slice(-12);
      return { type: "exec", output: rows.map((r: any) => `${r.role}: ${String(r.text ?? r.content ?? "").slice(0, 1200)}`).join("\n\n") || "This Hermes session has no messages yet." };
    }
    return client.request("command.dispatch", { session_id: id, name: match[1], arg });
  }
  async history(id: string): Promise<any> { return (await this.client()).request("session.history", { session_id: id, limit: 12 }); }
  async interrupt(id: string): Promise<void> { await (await this.client()).request("session.interrupt", { session_id: id }); }

  async prompt(id: string, text: string, emit: (text: string, final: boolean) => Promise<void>, inputId: string = randomUUID()): Promise<void> {
    const client = await this.client();
    let receipt: any, terminal = false, delivery = Promise.resolve();
    const early: HermesEvent[] = [], seen = new Set<string>();
    let resolve!: () => void, reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    completion.catch(() => {});
    const consume = (event: HermesEvent) => {
      if (event.session_id !== id || terminal) return;
      if (!receipt) { early.push(event); return; }
      if (receipt.admission_id && event.admission_id && receipt.admission_id !== event.admission_id) return;
      const key = `${event.replay_epoch}:${event.seq}:${event.type}`;
      if (event.seq !== undefined && seen.has(key)) return;
      if (event.seq !== undefined) seen.add(key);
      const payload = event.payload ?? {};
      if (event.type === "message.interim" && typeof payload.text === "string" && payload.text.trim()) delivery = delivery.then(() => emit(payload.text, false));
      if (event.type === "approval.request" || event.type === "clarify.request") {
        const question = payload.description || payload.question || payload.command || "Hermes is waiting for your input.";
        delivery = delivery.then(() => emit(String(question), false));
      }
      if (event.type === "message.complete") {
        terminal = true;
        if (payload.status && payload.status !== "complete") reject(new Error(String(payload.error || payload.failure_reason || `Hermes turn ${payload.status}.`)));
        else {
          if (typeof payload.text === "string" && payload.text.trim()) delivery = delivery.then(() => emit(payload.text, true));
          delivery.then(resolve, reject);
        }
      }
      delivery.catch(reject);
    };
    const exited = () => reject(new Error("Hermes connection ended; the turn was not resubmitted."));
    client.on("event", consume); client.on("exit", exited);
    const timer = setTimeout(() => { reject(new Error("Hermes turn timed out; check its session before retrying.")); void this.interrupt(id).catch(() => {}); }, 20 * 60_000);
    timer.unref();
    try {
      receipt = await client.request("prompt.submit", { session_id: id, text, submission_id: inputId });
      for (const event of early.splice(0)) consume(event);
      await completion;
    } finally { clearTimeout(timer); client.off("event", consume); client.off("exit", exited); await delivery; }
  }

  async dispose(): Promise<void> { const client = await this.connection?.catch(() => undefined); client?.kill("TeleCode shutdown"); this.connection = undefined; this.attached.clear(); }
}
