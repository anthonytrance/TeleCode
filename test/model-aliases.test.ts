import { describe, expect, it } from "vitest";

import { resolveModelSlug } from "../src/bot.js";

const models = [
  { slug: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
  { slug: "gpt-6-sol", displayName: "GPT-6-Sol" },
  { slug: "gpt-6-luna", displayName: "GPT-6-Luna" },
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" },
];

describe("native model aliases", () => {
  it.each(["sol", "codexsol", "61sol", "codex61sol", "gpt-6.1-sol"])("maps %s to GPT-6.1 Sol", (alias) => {
    expect(resolveModelSlug(alias, models)).toBe("gpt-6.1-sol");
  });

  it.each(["6sol", "codex6sol"])("keeps explicit GPT-6 Sol aliases on GPT-6 Sol", (alias) => {
    expect(resolveModelSlug(alias, models)).toBe("gpt-6-sol");
  });

  it.each(["luna", "codexluna", "6luna", "codex6luna"])("maps %s to GPT-6 Luna", (alias) => {
    expect(resolveModelSlug(alias, models)).toBe("gpt-6-luna");
  });

  it("keeps explicitly versioned 5.6 aliases on the 5.6 models", () => {
    expect(resolveModelSlug("codex56sol", models)).toBe("gpt-5.6-sol");
    expect(resolveModelSlug("codex56luna", models)).toBe("gpt-5.6-luna");
  });
});
