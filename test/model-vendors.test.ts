import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildVendorClaudeEnv,
  buildVendorClaudeSettingsEnv,
  buildVendorCodexConfig,
  buildVendorCodexEnv,
  canonicalizeVendorModel,
  describeVendorModel,
  isVendorAvailable,
  listVendorModels,
  resolveVendorApiKey,
  resolveVendorModel,
  VENDOR_CREDENTIALS_FILENAME,
  vendorReasoningEffortsForModel,
} from "../src/model-vendors.js";
import { buildClaudePtyEnv } from "../src/providers/claude-pty.js";

function requireResolved(raw: string): NonNullable<ReturnType<typeof resolveVendorModel>> {
  const resolved = resolveVendorModel(raw);
  if (!resolved) {
    throw new Error(`expected ${raw} to resolve to a vendor model`);
  }
  return resolved;
}

function withCredentialsDir(vendorId: string, key: string): string {
  const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-"));
  writeFileSync(join(dir, VENDOR_CREDENTIALS_FILENAME), JSON.stringify({ [vendorId]: key }), "utf8");
  return dir;
}

describe("model vendor resolution", () => {
  it("routes Qwen4 preview aliases through both agents with its documented budgets", () => {
    for (const name of ["qwen4-max-preview", "qwen", "qwenmax", " Qwen ", "qwen4", "qwen4max", "qwen4preview", "qwen4.0-max-preview"]) {
      const resolved = requireResolved(name);
      expect(resolved.model.slug).toBe("qwen4-max-preview");
      expect(buildVendorCodexConfig(resolved).model_provider).toBe("modelstudio");
      const env = buildVendorClaudeSettingsEnv(resolved);
      expect(env.ANTHROPIC_MODEL).toBe("qwen4-max-preview");
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("qwen4-max-preview");
      expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
      expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
    }
    expect(buildVendorClaudeSettingsEnv(requireResolved("qwen38")).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it("resolves a vendor model by slug and by every alias", () => {
    for (const name of ["qwen3.8-max", "qwen38", "QWEN38MAX"]) {
      expect(resolveVendorModel(name)?.model.slug).toBe("qwen3.8-max");
    }
  });

  it("canonicalizes vendor aliases before they reach an API request", () => {
    expect(canonicalizeVendorModel("qwen")).toBe("qwen4-max-preview");
    expect(canonicalizeVendorModel("qwenmax")).toBe("qwen4-max-preview");
    expect(canonicalizeVendorModel("claude-opus-5")).toBe("claude-opus-5");
  });

  it("leaves native models alone so today's behaviour is untouched", () => {
    for (const name of ["gpt-5.6-terra", "opus", "sonnet", "haiku", "default", "", "  "]) {
      expect(resolveVendorModel(name)).toBeNull();
    }
  });

  it("exposes every registered model with a vendor that exists", () => {
    const models = listVendorModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(resolveVendorModel(model.slug)?.vendor.id).toBe(model.vendorId);
    }
  });

  it("describes a model with its vendor label", () => {
    expect(describeVendorModel(requireResolved("qwen"))).toBe(
      "qwen4-max-preview (QwenCloud Token Plan)",
    );
  });
});

describe("vendor credentials", () => {
  it("prefers the environment over the credentials file", () => {
    const resolved = requireResolved("qwen");
    const dir = withCredentialsDir(resolved.vendor.id, "from-file");
    try {
      const key = resolveVendorApiKey(resolved.vendor, {
        workspace: dir,
        env: { [resolved.vendor.apiKeyEnv]: "from-env" },
      });
      expect(key).toBe("from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the credentials file in the workspace", () => {
    const resolved = requireResolved("qwen");
    const dir = withCredentialsDir(resolved.vendor.id, "from-file");
    try {
      expect(resolveVendorApiKey(resolved.vendor, { workspace: dir, env: {} })).toBe("from-file");
      expect(isVendorAvailable(resolved.vendor, { workspace: dir, env: {} })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unavailable rather than throwing when no credential exists", () => {
    const resolved = requireResolved("qwen");
    const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-empty-"));
    try {
      expect(resolveVendorApiKey(resolved.vendor, { workspace: dir, env: {} })).toBeNull();
      expect(isVendorAvailable(resolved.vendor, { workspace: dir, env: {} })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an unreadable credentials file as no credential", () => {
    const resolved = requireResolved("qwen");
    const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-bad-"));
    writeFileSync(join(dir, VENDOR_CREDENTIALS_FILENAME), "{ not json", "utf8");
    try {
      expect(resolveVendorApiKey(resolved.vendor, { workspace: dir, env: {} })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codex vendor wiring", () => {
  it("points model_provider at the provider table and keeps the catalog scoped", () => {
    const config = buildVendorCodexConfig(requireResolved("qwen"));
    expect(config.model_provider).toBe("modelstudio");
    // model_catalog_json REPLACES the built-in catalog, so it must only ever be
    // applied to a session that is already on this vendor.
    expect(config.model_catalog_json).toMatch(/model-catalog\.qwen\.json$/);
  });

  it("reads advertised efforts from the vendor catalog, not the shared cache", () => {
    const catalogPath = buildVendorCodexConfig(requireResolved("qwen")).model_catalog_json;
    const efforts = vendorReasoningEffortsForModel("qwen");
    if (existsSync(catalogPath)) {
      expect(efforts).toEqual(["low", "medium", "xhigh"]);
      expect(vendorReasoningEffortsForModel("qwen4-max-preview")).toEqual(efforts);
    } else {
      expect(efforts).toBeNull();
    }
  });

  it("returns null for native models so the legacy fallback still applies", () => {
    expect(vendorReasoningEffortsForModel("gpt-5.6-terra")).toBeNull();
    expect(vendorReasoningEffortsForModel("")).toBeNull();
  });

  it("carries the vendor key under the env var the provider table reads", () => {
    const resolved = requireResolved("qwen");
    const env = buildVendorCodexEnv(resolved, { env: { DASHSCOPE_API_KEY: "sk-test" } });
    expect(env).toEqual({ DASHSCOPE_API_KEY: "sk-test" });
  });

  it("contributes no env at all when the vendor has no credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "telecode-vendor-none-"));
    try {
      expect(buildVendorCodexEnv(requireResolved("qwen"), { workspace: dir, env: {} })).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claude vendor wiring", () => {
  it("pins every model slot so nothing falls back to a slug the vendor cannot serve", () => {
    const env = buildVendorClaudeSettingsEnv(requireResolved("qwen"));
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    );
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      expect(env[key]).toBe("qwen4-max-preview");
    }
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
  });

  it("keeps the Haiku slot on the cheap model, since the plan is metered", () => {
    const env = buildVendorClaudeSettingsEnv(requireResolved("qwen"));
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("qwen3.6-flash");
  });

  it("claims a context window only for the model that documents one", () => {
    const undocumented = buildVendorClaudeSettingsEnv(requireResolved("glm-5.2"));
    expect(undocumented.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(undocumented.ANTHROPIC_MODEL).toBe("glm-5.2");
  });

  it("keeps a model Codex cannot reach out of the Codex config but usable by Claude", () => {
    const flash = requireResolved("deepseek-v4-flash-0731");
    expect(flash.model.codex).toBe(false);
    expect(buildVendorCodexConfig(flash)).toEqual({});
    expect(buildVendorClaudeSettingsEnv(flash).ANTHROPIC_MODEL).toBe("deepseek-v4-flash-0731");
  });

  it("never puts the auth token in the settings overlay", () => {
    const env = buildVendorClaudeSettingsEnv(requireResolved("qwen"));
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("sends only the token through the child environment", () => {
    const env = buildVendorClaudeEnv(requireResolved("qwen"), {
      env: { DASHSCOPE_API_KEY: "sk-test" },
    });
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: "sk-test" });
  });

  it("survives the CLAUDE_CODE_* scrub in the PTY environment", () => {
    const resolved = requireResolved("qwen");
    const built = buildClaudePtyEnv(
      {
        bin: "claude",
        args: [],
        cwd: "C:\\workspace",
        extraEnv: buildVendorClaudeEnv(resolved, { env: { DASHSCOPE_API_KEY: "sk-test" } }),
      },
      { CLAUDE_CODE_SOMETHING: "stripped", PATH: "/usr/bin" },
    );
    expect(built.CLAUDE_CODE_SOMETHING).toBeUndefined();
    expect(built.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(built.PATH).toBe("/usr/bin");
  });
});

describe("zai vendor wiring", () => {
  it("resolves the zai models by slug and every alias without touching qwen's", () => {
    for (const name of ["glm-5.3", "glm53", "glm5.3", "zai"]) {
      expect(resolveVendorModel(name)?.model.slug).toBe("glm-5.3");
      expect(resolveVendorModel(name)?.vendor.id).toBe("zai");
    }
    for (const name of ["glm-5.3-flash", "glmflash", "glm53flash", "glm5.3flash"]) {
      expect(resolveVendorModel(name)?.model.slug).toBe("glm-5.3-flash");
      expect(resolveVendorModel(name)?.vendor.id).toBe("zai");
    }
    // QwenCloud keeps its glm-5.2 slug and the glm52 alias; "glm" now
    // points at Z.AI glm-5.3 (user request, 2026-08-28).
    expect(resolveVendorModel("glm")?.model.slug).toBe("glm-5.3");
    expect(resolveVendorModel("glm")?.vendor.id).toBe("zai");
    expect(resolveVendorModel("glm52")?.model.slug).toBe("glm-5.2");
    expect(resolveVendorModel("glm52")?.vendor.id).toBe("modelstudio");
  });

  it("points the Codex provider at the Responses endpoint with the GLM catalog", () => {
    const config = buildVendorCodexConfig(requireResolved("glmflash"));
    expect(config.model_provider).toBe("zai");
    expect(config.model_catalog_json).toMatch(/model-catalog\.glm\.json$/);
    const efforts = vendorReasoningEffortsForModel("glmflash");
    if (existsSync(config.model_catalog_json)) {
      expect(efforts).toContain("low");
      expect(efforts).toContain("high");
      expect(efforts).toContain("max");
    } else {
      expect(efforts).toBeNull();
    }
  });

  it("pins the Claude slots to the requested model with flash on the Haiku slot", () => {
    const env = buildVendorClaudeSettingsEnv(requireResolved("glm53"));
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.3-flash");
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
    // Same rule as every vendor: the token never rides the settings overlay.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("carries the GLM key as ANTHROPIC_AUTH_TOKEN and survives the PTY scrub", () => {
    const resolved = requireResolved("glmflash");
    const env = buildVendorClaudeEnv(resolved, { env: { GLM_API_KEY: "zai-test" } });
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: "zai-test" });
    const built = buildClaudePtyEnv(
      {
        bin: "claude",
        args: [],
        cwd: "C:\\workspace",
        extraEnv: env,
      },
      { CLAUDE_CODE_SOMETHING: "stripped", PATH: "/usr/bin" },
    );
    expect(built.CLAUDE_CODE_SOMETHING).toBeUndefined();
    expect(built.ANTHROPIC_AUTH_TOKEN).toBe("zai-test");
  });
});
