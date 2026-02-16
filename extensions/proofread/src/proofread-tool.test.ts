import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProofreadTool } from "./proofread-tool.js";

describe("proofread tool", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when agentDir is missing", () => {
    expect(createProofreadTool()).toBeNull();
    expect(createProofreadTool({})).toBeNull();
    expect(createProofreadTool({ agentDir: "" })).toBeNull();
    expect(createProofreadTool({ agentDir: "  " })).toBeNull();
  });

  it("returns a tool with correct name and label when agentDir is provided", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proofread-"));
    const tool = createProofreadTool({ agentDir });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("proofread");
    expect(tool?.label).toBe("Proofread");
    expect(tool?.description).toContain("any language");
    expect(tool?.description).toContain("grammar");
  });

  it("gracefully handles missing anthropic auth (no API key)", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proofread-"));
    const tool = createProofreadTool({ agentDir });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected tool");
    }

    const result = await tool.execute("t1", { text: "[whispers] Cześć, jak się masz?" });
    const details = result.details as Record<string, unknown>;
    // Should return gracefully with error, not throw
    expect(details.error).toBeDefined();
    // Returns split variants even on error
    expect(details.corrected_text).toBe("Cześć, jak się masz?");
    expect(details.corrected_voice).toBe("[whispers] Cześć, jak się masz?");
    expect(details.unchanged).toBe(true);
  });

  it("requires text parameter", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proofread-"));
    const tool = createProofreadTool({ agentDir });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected tool");
    }

    await expect(tool.execute("t1", {})).rejects.toThrow(/text required/i);
  });
});

describe("proofread tool schema", () => {
  it("has all expected parameter fields", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proofread-"));
    const tool = createProofreadTool({ agentDir });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected tool");
    }

    const schema = tool.parameters;
    expect(schema).toBeDefined();
    expect(schema.properties).toHaveProperty("text");
    expect(schema.properties).toHaveProperty("context");
    expect(schema.properties).toHaveProperty("speaker_name");
    expect(schema.properties).toHaveProperty("speaker_gender");
    expect(schema.properties).toHaveProperty("addressee_name");
    expect(schema.properties).toHaveProperty("addressee_gender");
  });
});
