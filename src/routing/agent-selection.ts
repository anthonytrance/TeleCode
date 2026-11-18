/** TeleCode routing state, independent of WhatsApp, Telegram or a model provider. */
export type AgentBackend = "codex" | "claude" | "hermes";
export type AgentSelection = AgentBackend | "telecode";
export interface AgentConversation {
  provider: AgentBackend;
  model?: string;
  providerSessionId?: string;
  telecodeProvider?: "codex" | "claude";
  backends?: Partial<Record<AgentBackend, { model?: string; providerSessionId?: string }>>;
}

/** Call only after a transport adapter has authenticated the actual author. */
export function requestedAgent(text: string): "hermes" | "telecode" | undefined {
  const match = /^(?:\/agent\s+|(?:please\s+)?switch to )(hermes|telecode)[.!]?$/i.exec(text.trim());
  return match?.[1].toLowerCase() as "hermes" | "telecode" | undefined;
}

/** Selection never merges histories or copies another backend's conversation ID. */
export function selectAgent(state: AgentConversation, selection: AgentSelection, defaultProvider: "codex" | "claude"): AgentConversation {
  const provider = selection === "telecode" ? state.telecodeProvider ?? defaultProvider : selection;
  const backends = { ...state.backends, [state.provider]: { model: state.model, providerSessionId: state.providerSessionId } };
  return { ...backends[provider], provider, backends,
    telecodeProvider: provider === "hermes" ? (state.provider === "hermes" ? state.telecodeProvider : state.provider) : provider };
}
