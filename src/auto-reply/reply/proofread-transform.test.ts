import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../types.js";
import {
  buildUserMessage,
  maybeProofreadPayload,
  parseProofreadResponse,
  stripCodeFences,
  stripEmotionTags,
  stripTtsDirectivesForDisplay,
} from "./proofread-transform.js";

// ── parseProofreadResponse ──────────────────────────────────────────────────

describe("parseProofreadResponse", () => {
  it("parses valid JSON response", () => {
    const raw = JSON.stringify({
      corrected_text: "Cześć, jak się masz?",
      corrected_voice: "[whispers] Cześć, jak się masz?",
      changes: ["Fixed greeting"],
      unchanged: false,
    });
    const result = parseProofreadResponse(raw, "original");
    expect(result.corrected_text).toBe("Cześć, jak się masz?");
    expect(result.corrected_voice).toBe("[whispers] Cześć, jak się masz?");
    expect(result.changes).toEqual(["Fixed greeting"]);
    expect(result.unchanged).toBe(false);
  });

  it("handles code-fenced JSON", () => {
    const raw =
      '```json\n{"corrected_text":"ok","corrected_voice":"ok","changes":[],"unchanged":true}\n```';
    const result = parseProofreadResponse(raw, "original");
    expect(result.corrected_text).toBe("ok");
    expect(result.unchanged).toBe(true);
  });

  it("handles unchanged response", () => {
    const raw = JSON.stringify({
      corrected_text: "hello",
      corrected_voice: "[soft] hello",
      changes: [],
      unchanged: true,
    });
    const result = parseProofreadResponse(raw, "hello");
    expect(result.unchanged).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("returns original text unchanged on parse failure", () => {
    const result = parseProofreadResponse("not json at all", "original text");
    expect(result.corrected_voice).toBe("original text");
    expect(result.corrected_text).toBe("original text");
    expect(result.unchanged).toBe(true);
    expect(result.error).toContain("JSON parse failed");
  });

  it("uses corrected field as fallback for corrected_voice", () => {
    const raw = JSON.stringify({
      corrected: "Cześć",
      changes: ["fix"],
      unchanged: false,
    });
    const result = parseProofreadResponse(raw, "original");
    expect(result.corrected_voice).toBe("Cześć");
  });
});

// ── stripEmotionTags ────────────────────────────────────────────────────────

describe("stripEmotionTags", () => {
  it("removes bracketed tags", () => {
    expect(stripEmotionTags("[whispers] hello [laughs] world")).toBe("hello world");
  });

  it("preserves clean text", () => {
    expect(stripEmotionTags("no tags here")).toBe("no tags here");
  });
});

// ── stripCodeFences ─────────────────────────────────────────────────────────

describe("stripCodeFences", () => {
  it("strips json code fences", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips code fences with preamble text", () => {
    const raw = 'Here is the corrected text:\n```json\n{"a":1}\n```';
    expect(stripCodeFences(raw)).toBe('{"a":1}');
  });

  it("returns text unchanged without fences", () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseProofreadResponse — trailing commas", () => {
  it("parses JSON with trailing commas", () => {
    const raw =
      '{"corrected_text":"ok","corrected_voice":"ok","changes":["fix",],"unchanged":false,}';
    const result = parseProofreadResponse(raw, "original");
    expect(result.corrected_text).toBe("ok");
    expect(result.unchanged).toBe(false);
  });
});

describe("parseProofreadResponse — literal newlines in strings", () => {
  it("repairs literal newlines inside corrected_voice (primary failure pattern)", () => {
    // Sonnet breaks lines at [emotion] tag boundaries instead of using \n escapes
    const raw = `{
  "corrected_text": "Przysuwam się blisko. Mówię ci do ucha.",
  "corrected_voice": "[whispers] Przysuwam się tak blisko.\n[soft] Mówię ci do ucha niskim głosem.",
  "changes": ["word order"],
  "unchanged": false
}`;
    const result = parseProofreadResponse(raw, "original");
    expect(result.error).toBeUndefined();
    expect(result.corrected_voice).toBe(
      "[whispers] Przysuwam się tak blisko.\n[soft] Mówię ci do ucha niskim głosem.",
    );
    expect(result.corrected_text).toBe("Przysuwam się blisko. Mówię ci do ucha.");
    expect(result.unchanged).toBe(false);
  });

  it("handles code fence wrapping + literal newlines combo", () => {
    const raw = `\`\`\`json
{
  "corrected_text": "Tekst poprawiony.",
  "corrected_voice": "[gentle] Tekst\npoprawiony.",
  "changes": [],
  "unchanged": true
}
\`\`\``;
    const result = parseProofreadResponse(raw, "original");
    expect(result.error).toBeUndefined();
    expect(result.corrected_voice).toBe("[gentle] Tekst\npoprawiony.");
    expect(result.unchanged).toBe(true);
  });

  it("handles multi-paragraph text with emotion tags at line starts", () => {
    const raw = `{
  "corrected_text": "Pierwszy akapit. Drugi akapit. Trzeci akapit.",
  "corrected_voice": "[whispers] Pierwszy akapit.\n[playful] Drugi akapit.\n[soft] Trzeci akapit.",
  "changes": ["gender fix"],
  "unchanged": false
}`;
    const result = parseProofreadResponse(raw, "original");
    expect(result.error).toBeUndefined();
    expect(result.corrected_voice).toBe(
      "[whispers] Pierwszy akapit.\n[playful] Drugi akapit.\n[soft] Trzeci akapit.",
    );
  });

  it("handles both trailing commas AND literal newlines", () => {
    const raw = `{
  "corrected_text": "Poprawiony tekst.",
  "corrected_voice": "[soft] Linia pierwsza.\n[whispers] Linia druga.",
  "changes": ["fix",],
  "unchanged": false,
}`;
    const result = parseProofreadResponse(raw, "original");
    expect(result.error).toBeUndefined();
    expect(result.corrected_text).toBe("Poprawiony tekst.");
    expect(result.corrected_voice).toBe("[soft] Linia pierwsza.\n[whispers] Linia druga.");
  });

  it("does not mangle already-escaped newlines", () => {
    // Well-formed JSON with proper \n escapes should pass through unchanged
    const raw = JSON.stringify({
      corrected_text: "ok",
      corrected_voice: "[soft] Line one.\n[whispers] Line two.",
      changes: [],
      unchanged: false,
    });
    const result = parseProofreadResponse(raw, "original");
    expect(result.error).toBeUndefined();
    expect(result.corrected_voice).toBe("[soft] Line one.\n[whispers] Line two.");
  });
});

// ── buildUserMessage ────────────────────────────────────────────────────────

describe("buildUserMessage", () => {
  it("includes speaker and addressee info", () => {
    const msg = buildUserMessage({
      text: "Cześć",
      speakerName: "Moisty",
      speakerGender: "kobieta",
      addresseeName: "Ikari",
      addresseeGender: "mężczyzna",
    });
    expect(msg).toContain("Speaker: Moisty, kobieta");
    expect(msg).toContain("Addressee: Ikari, mężczyzna");
    expect(msg).toContain("Text to proofread:");
    expect(msg).toContain("Cześć");
  });

  it("omits speaker/addressee when not provided", () => {
    const msg = buildUserMessage({ text: "Hello" });
    expect(msg).not.toContain("Speaker:");
    expect(msg).not.toContain("Addressee:");
    expect(msg).toContain("Hello");
  });
});

// ── stripTtsDirectivesForDisplay ────────────────────────────────────────────

describe("stripTtsDirectivesForDisplay", () => {
  it("strips [[tts:text]] directives", () => {
    const payload: ReplyPayload = {
      text: "Corrected text\n[[tts:text]][whispers] Corrected voice[[/tts:text]]",
    };
    const result = stripTtsDirectivesForDisplay(payload);
    expect(result.text).toBe("Corrected text");
  });

  it("preserves text when no directives present", () => {
    const payload: ReplyPayload = { text: "Just plain text" };
    const result = stripTtsDirectivesForDisplay(payload);
    expect(result.text).toBe("Just plain text");
  });

  it("returns original payload when text is undefined", () => {
    const payload: ReplyPayload = { mediaUrl: "/tmp/audio.mp3" };
    const result = stripTtsDirectivesForDisplay(payload);
    expect(result).toBe(payload);
  });

  it("falls back to original text when stripping leaves empty string", () => {
    const payload: ReplyPayload = { text: "[[tts:text]]only voice[[/tts:text]]" };
    const result = stripTtsDirectivesForDisplay(payload);
    // Should keep original rather than returning empty
    expect(result.text).toBe("[[tts:text]]only voice[[/tts:text]]");
  });
});

// ── maybeProofreadPayload ───────────────────────────────────────────────────

describe("maybeProofreadPayload", () => {
  const baseCfg: OpenClawConfig = {};

  it("returns original when proofread config is missing", async () => {
    const payload: ReplyPayload = { text: "Some text that is long enough to proofread" };
    const result = await maybeProofreadPayload({ payload, cfg: baseCfg });
    expect(result).toBe(payload);
  });

  it("returns original when auto is false", async () => {
    const cfg: OpenClawConfig = { messages: { proofread: { auto: false } } };
    const payload: ReplyPayload = { text: "Some text that is long enough to proofread" };
    const result = await maybeProofreadPayload({ payload, cfg });
    expect(result).toBe(payload);
  });

  it("returns original when text is too short", async () => {
    const cfg: OpenClawConfig = { messages: { proofread: { auto: true } } };
    const payload: ReplyPayload = { text: "Short" };
    const result = await maybeProofreadPayload({ payload, cfg, agentDir: "/tmp/agent" });
    expect(result).toBe(payload);
  });

  it("returns original when text is empty", async () => {
    const cfg: OpenClawConfig = { messages: { proofread: { auto: true } } };
    const payload: ReplyPayload = { text: "" };
    const result = await maybeProofreadPayload({ payload, cfg, agentDir: "/tmp/agent" });
    expect(result).toBe(payload);
  });

  it("returns original when text is undefined", async () => {
    const cfg: OpenClawConfig = { messages: { proofread: { auto: true } } };
    const payload: ReplyPayload = { mediaUrl: "/tmp/audio.mp3" };
    const result = await maybeProofreadPayload({ payload, cfg, agentDir: "/tmp/agent" });
    expect(result).toBe(payload);
  });

  it("returns original when agentDir is missing", async () => {
    const cfg: OpenClawConfig = { messages: { proofread: { auto: true } } };
    const payload: ReplyPayload = { text: "Some text that is long enough to proofread" };
    const result = await maybeProofreadPayload({ payload, cfg });
    expect(result).toBe(payload);
  });
});

// ── Embedding format ────────────────────────────────────────────────────────

describe("tts:text embedding format", () => {
  it("produces correct [[tts:text]] block when text is corrected", () => {
    // Simulates what maybeProofreadPayload would produce
    const correctedText = "Poprawiony tekst";
    const correctedVoice = "[whispers] Poprawiony tekst";
    const combined = `${correctedText}\n[[tts:text]]${correctedVoice}[[/tts:text]]`;

    expect(combined).toContain("[[tts:text]]");
    expect(combined).toContain("[[/tts:text]]");

    // The display part (before directive) should be the corrected_text
    const displayPart = combined.replace(/\[\[tts:text\]\][\s\S]*?\[\[\/tts:text\]\]/gi, "").trim();
    expect(displayPart).toBe("Poprawiony tekst");

    // The TTS directive content should be corrected_voice
    const ttsMatch = combined.match(/\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/i);
    expect(ttsMatch?.[1]).toBe("[whispers] Poprawiony tekst");
  });
});
