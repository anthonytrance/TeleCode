export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export const LEGACY_CODEX_REASONING_EFFORTS: CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string" && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

/**
 * Capabilities that must survive a missing or stale shared Codex model cache.
 *
 * Each Codex child writes the same models_cache.json. A third-party provider can
 * therefore replace the native OpenAI catalog immediately before the user
 * switches back to an OpenAI model. Keep this list deliberately narrow and
 * limited to levels confirmed for the exact native model.
 */
const NATIVE_REQUIRED_REASONING_EFFORTS: Readonly<Record<string, readonly CodexReasoningEffort[]>> = {
  "gpt-6.1-sol": ["max"],
  "gpt-6-astra": ["max", "ultra"],
  "gpt-5.6": ["max"],
  "gpt-5.6-sol": ["max"],
};

export function addRequiredNativeReasoningEfforts(
  model: string | undefined,
  advertised: readonly CodexReasoningEffort[],
): CodexReasoningEffort[] {
  // GPT-6.1 Sol does not accept the legacy minimal level. A stale shared
  // catalog can still advertise it after switching models.
  const result = model?.toLowerCase() === "gpt-6.1-sol"
    ? advertised.filter((effort) => effort !== "minimal")
    : [...advertised];
  const required = model ? NATIVE_REQUIRED_REASONING_EFFORTS[model.toLowerCase()] ?? [] : [];
  for (const effort of required) {
    if (!result.includes(effort)) {
      result.push(effort);
    }
  }
  return result;
}
