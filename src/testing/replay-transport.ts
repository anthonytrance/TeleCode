import type { TelegramContextKey } from "../context-key.js";

export type ReplayUpdateKind =
  | "message:text"
  | "message:voice"
  | "message:photo"
  | "message:document"
  | "callback_query";

export interface ReplayUpdate {
  updateId: number;
  kind: ReplayUpdateKind;
  laneKey: TelegramContextKey;
  chatId: number;
  messageThreadId?: number;
  fromId: number;
  text?: string;
  caption?: string;
  fileId?: string;
  callbackData?: string;
}

export interface ReplayOutbound {
  method: string;
  laneKey: TelegramContextKey;
  chatId: number | string;
  messageThreadId?: number;
  text?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

type Clock = () => number;

export class ReplayTelegramTransport {
  private readonly updates: ReplayUpdate[];
  private readonly outbounds: ReplayOutbound[] = [];
  private readonly now: Clock;
  private cursor = 0;

  constructor(updates: ReplayUpdate[], options: { now?: Clock } = {}) {
    this.updates = [...updates].sort((left, right) => left.updateId - right.updateId);
    this.now = options.now ?? (() => Date.now());
  }

  nextUpdate(): ReplayUpdate | undefined {
    const update = this.updates[this.cursor];
    if (!update) {
      return undefined;
    }
    this.cursor += 1;
    return { ...update };
  }

  pendingUpdateCount(): number {
    return Math.max(0, this.updates.length - this.cursor);
  }

  sendMessage(
    chatId: number | string,
    text: string,
    options: { laneKey: TelegramContextKey; messageThreadId?: number; payload?: Record<string, unknown> },
  ): ReplayOutbound {
    return this.record("sendMessage", chatId, options.laneKey, {
      messageThreadId: options.messageThreadId,
      text,
      payload: options.payload,
    });
  }

  editMessageText(
    chatId: number | string,
    text: string,
    options: { laneKey: TelegramContextKey; messageThreadId?: number; payload?: Record<string, unknown> },
  ): ReplayOutbound {
    return this.record("editMessageText", chatId, options.laneKey, {
      messageThreadId: options.messageThreadId,
      text,
      payload: options.payload,
    });
  }

  answerCallbackQuery(
    laneKey: TelegramContextKey,
    options: { chatId: number | string; text?: string; payload?: Record<string, unknown> },
  ): ReplayOutbound {
    return this.record("answerCallbackQuery", options.chatId, laneKey, {
      text: options.text,
      payload: options.payload,
    });
  }

  sendChatAction(
    chatId: number | string,
    options: { laneKey: TelegramContextKey; messageThreadId?: number; payload?: Record<string, unknown> },
  ): ReplayOutbound {
    return this.record("sendChatAction", chatId, options.laneKey, {
      messageThreadId: options.messageThreadId,
      payload: options.payload,
    });
  }

  outboundLog(): ReplayOutbound[] {
    return this.outbounds.map((entry) => ({ ...entry, payload: entry.payload ? { ...entry.payload } : undefined }));
  }

  clearOutboundLog(): void {
    this.outbounds.length = 0;
  }

  private record(
    method: string,
    chatId: number | string,
    laneKey: TelegramContextKey,
    options: { messageThreadId?: number; text?: string; payload?: Record<string, unknown> },
  ): ReplayOutbound {
    const outbound: ReplayOutbound = {
      method,
      laneKey,
      chatId,
      messageThreadId: options.messageThreadId,
      text: options.text,
      payload: options.payload,
      createdAt: this.now(),
    };
    this.outbounds.push(outbound);
    return { ...outbound, payload: outbound.payload ? { ...outbound.payload } : undefined };
  }
}

export function createReplayTextUpdate(options: {
  updateId: number;
  chatId: number;
  fromId: number;
  text: string;
  messageThreadId?: number;
}): ReplayUpdate {
  const laneKey = options.messageThreadId === undefined
    ? `${options.chatId}`
    : `${options.chatId}:${options.messageThreadId}`;
  return {
    updateId: options.updateId,
    kind: "message:text",
    laneKey,
    chatId: options.chatId,
    messageThreadId: options.messageThreadId,
    fromId: options.fromId,
    text: options.text,
  };
}
