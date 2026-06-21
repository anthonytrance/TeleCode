export type OutputBufferEventKind =
  | "assistant"
  | "final"
  | "tool"
  | "permission"
  | "question"
  | "artifact"
  | "status"
  | "error";

export interface BufferedOutputEvent {
  id: string;
  sessionId: string;
  kind: OutputBufferEventKind;
  text?: string;
  artifactPath?: string;
  priority: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface OutputBufferSummary {
  sessionId: string;
  total: number;
  priority: number;
  finalMessages: number;
  artifacts: number;
  latestAt?: number;
}

type IdGenerator = () => string;
type Clock = () => number;

export class OutputBuffer {
  private readonly eventsBySession = new Map<string, BufferedOutputEvent[]>();
  private readonly idGenerator: IdGenerator;
  private readonly now: Clock;

  constructor(options: { idGenerator?: IdGenerator; now?: Clock } = {}) {
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.now = options.now ?? (() => Date.now());
  }

  append(
    sessionId: string,
    event: Omit<BufferedOutputEvent, "id" | "sessionId" | "createdAt" | "priority"> & {
      id?: string;
      createdAt?: number;
      priority?: boolean;
    },
  ): BufferedOutputEvent {
    const buffered: BufferedOutputEvent = {
      id: event.id ?? this.idGenerator(),
      sessionId,
      kind: event.kind,
      text: event.text,
      artifactPath: event.artifactPath,
      priority: event.priority ?? isPriorityKind(event.kind),
      createdAt: event.createdAt ?? this.now(),
      metadata: event.metadata,
    };

    const events = this.eventsBySession.get(sessionId) ?? [];
    events.push(buffered);
    this.eventsBySession.set(sessionId, events);
    return buffered;
  }

  list(sessionId: string): BufferedOutputEvent[] {
    return [...(this.eventsBySession.get(sessionId) ?? [])];
  }

  drain(sessionId: string): BufferedOutputEvent[] {
    const events = this.list(sessionId);
    this.eventsBySession.delete(sessionId);
    return events;
  }

  drainWhere(sessionId: string, predicate: (event: BufferedOutputEvent) => boolean): BufferedOutputEvent[] {
    const events = this.eventsBySession.get(sessionId) ?? [];
    const drained: BufferedOutputEvent[] = [];
    const kept: BufferedOutputEvent[] = [];

    for (const event of events) {
      if (predicate(event)) {
        drained.push(event);
      } else {
        kept.push(event);
      }
    }

    if (kept.length > 0) {
      this.eventsBySession.set(sessionId, kept);
    } else {
      this.eventsBySession.delete(sessionId);
    }
    return drained.map((event) => ({ ...event, metadata: event.metadata ? { ...event.metadata } : undefined }));
  }

  hasUnread(sessionId: string): boolean {
    return (this.eventsBySession.get(sessionId)?.length ?? 0) > 0;
  }

  summarize(sessionId: string): OutputBufferSummary {
    const events = this.eventsBySession.get(sessionId) ?? [];
    return {
      sessionId,
      total: events.length,
      priority: events.filter((event) => event.priority).length,
      finalMessages: events.filter((event) => event.kind === "final").length,
      artifacts: events.filter((event) => event.kind === "artifact").length,
      latestAt: events.at(-1)?.createdAt,
    };
  }

  summarizeAll(): OutputBufferSummary[] {
    return [...this.eventsBySession.keys()].map((sessionId) => this.summarize(sessionId));
  }
}

function isPriorityKind(kind: OutputBufferEventKind): boolean {
  return kind === "final" || kind === "permission" || kind === "question" || kind === "artifact" || kind === "error";
}
import { randomUUID } from "node:crypto";
