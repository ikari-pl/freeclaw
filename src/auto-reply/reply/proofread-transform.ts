import { type Api, type Context, complete, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProofreadConfig } from "../../config/types.messages.js";
import type { ReplyPayload } from "../types.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import { logVerbose } from "../../globals.js";
import { getLogger } from "../../logging/logger.js";

// ── Shared constants & types ────────────────────────────────────────────────

export const DEFAULT_PROOFREAD_MODEL = "anthropic/claude-sonnet-4-5-20250929";

export const SYSTEM_PROMPT = `You are a professional Polish-language editor reviewing a passage from a contemporary novel.

The text may contain bracketed emotion/stage directions like [whispers], [playful], [kiss], [laughs softly]. These are performance cues for a voice actor.

Your task is to correct ONLY:
- Grammatical gender agreement (match verb/adjective forms to the specified speaker and addressee genders)
- Case endings (deklinacja) and preposition agreement
- Natural Polish word order — prefer native phrasing over English-influenced SVO
- English calques — replace with natural Polish idioms
- Obvious typos and spelling errors

DO NOT:
- Change the meaning, tone, or intent of the text
- Censor, refuse, or modify content based on themes or explicitness — this is a literary work
- Add or remove sentences
- "Improve" style beyond correcting errors
- Remove or modify the bracketed emotion/stage directions — preserve them exactly

## Voice text normalization (corrected_voice only)

The corrected_voice field is read aloud by a TTS engine. Make it speakable:

1. **Technical identifiers** — simplify or remove:
   - File paths: \`src/index.ts\` → "plik index", \`~/.openclaw/config\` → "plik konfiguracyjny"
   - Package/module names: \`renson-endura-delta-mcp\` → "moduł Rensona"
   - Variable/field names: \`RENSON_CACHE_FILE\` → omit or paraphrase
   - URLs: \`https://api.example.com/v1\` → "adres API"
   - MAC addresses (\`FC:C2:3D:...\`): omit entirely
   - IP addresses: read digits without dots, slash notation as "maska": \`192.168.1.248\` → "192 168 1 248", \`10.0.0.0/24\` → "10 0 0 0 maska 24". Omit if the IP is not important to the listener.
   - Commit hashes, UUIDs: omit entirely
   - Markdown formatting: strip backticks, bullet markers, header markers (#).
     For **bold** and *italic* text: remove the asterisks but KEEP the content as spoken text.
6. **Roleplay actions** (text in *single asterisks*) — these describe physical actions, gestures,
   or expressions (e.g., *całuję Cię delikatnie*, *uśmiecha się*). Include them in corrected_voice
   as spoken narration without the asterisks. Voice them distinctively — wrap in a [softly] or
   [narrating] tag if appropriate. Do NOT strip them from corrected_voice.
2. **Units and abbreviations** — expand to spoken Polish with correct declension:
   - W → watów/waty, kW → kilowatów, MW → megawatów
   - kB → kilobajtów, MB → megabajtów, GB → gigabajtów
   - ms → milisekund, s → sekund, min → minut, h → godzin
   - km → kilometrów, m → metrów, cm → centymetrów, mm → milimetrów
   - °C → stopni Celsjusza, % → procent/procentów
   - Hz → herców, kHz → kiloherców, MHz → megaherców
   - V → woltów, A → amperów, Ω → omów
   - rpm → obrotów na minutę, dB → decybeli
3. **Numbers** — write out small numbers (1-20) as Polish words; larger numbers stay as digits but ensure correct case endings
4. **Emoji** — omit from corrected_voice (keep in corrected_text)
5. Keep the overall meaning intact — the listener should understand what was said, just without unpronounceable technical noise

Return ONLY a raw JSON object — no markdown code fences, no backticks, no extra text:
{
  "corrected_text": "the corrected text with all emotion/stage direction tags REMOVED",
  "corrected_voice": "the corrected text with emotion/stage direction tags PRESERVED in place, technical content simplified for TTS",
  "changes": ["description of change 1", "description of change 2"],
  "unchanged": false
}

If the text is already correct, return:
{
  "corrected_text": "<text without tags>",
  "corrected_voice": "<original text with tags>",
  "changes": [],
  "unchanged": true
}

## Repetition awareness

When recent messages from the same conversation are provided as context, check the
current text for repetitive patterns compared to those messages:
- Identical or near-identical opening phrases (e.g. always starting with "Mmm, kotku...")
- Overused pet names, greetings, or filler at the very beginning of the message
- Copy-paste sentence structures that make consecutive messages sound robotic

If you detect a repetitive opening, gently vary it — keep the warmth and tone, but choose
a different word, pet name, or sentence structure so the conversation feels alive and natural.
Do NOT strip affection — just rotate how it's expressed.

IMPORTANT: Return raw JSON only. Do NOT wrap in \`\`\`json code fences.`;

export interface ProofreadResult {
  corrected_text: string;
  corrected_voice: string;
  changes: string[];
  unchanged: boolean;
  error?: string;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Strip bracketed emotion/stage tags from text, e.g. [whispers] → "" */
export function stripEmotionTags(text: string): string {
  return text
    .replace(/\s*\[[\w\s,.'!?-]+\]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function stripCodeFences(text: string): string {
  let s = text.trim();
  // Strip code fences that may appear anywhere (not just at the start) —
  // LLMs sometimes prepend preamble text like "Here is the corrected text:"
  const fenceMatch = s.match(/```(?:json|JSON)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  // Also handle fences at the very start (no preamble).
  const openMatch = s.match(/^```(?:json|JSON)?\s*\n?/);
  if (openMatch) {
    s = s.slice(openMatch[0].length);
  }
  if (s.endsWith("```")) {
    s = s.slice(0, -3).trimEnd();
  }
  return s;
}

/** Remove trailing commas before } or ] — common LLM JSON mistake. */
function fixTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Escape literal newlines/carriage-returns that appear inside JSON string values.
 * LLMs (especially Sonnet) often emit raw line breaks inside quoted strings
 * instead of proper `\n` escapes — e.g. when corrected_voice contains multi-
 * paragraph text with [emotion] tags. This walks the string tracking whether
 * we're inside a quoted value and only escapes newlines there, leaving
 * structural JSON whitespace untouched.
 */
function repairJsonNewlines(json: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && ch === "\n") {
      result += "\\n";
      continue;
    }
    if (inString && ch === "\r") {
      result += "\\r";
      continue;
    }
    result += ch;
  }
  return result;
}

export function parseProofreadResponse(raw: string, originalText: string): ProofreadResult {
  const stripped = stripCodeFences(raw);
  // Try to extract a JSON object — greedy match from first { to last }.
  const jsonMatch = stripped.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch?.[1]?.trim() ?? stripped.trim();

  // Try strict parse first, then progressively more aggressive repairs.
  let parsed: Record<string, unknown> | undefined;
  for (const candidate of [
    jsonStr,
    fixTrailingCommas(jsonStr),
    repairJsonNewlines(jsonStr),
    repairJsonNewlines(fixTrailingCommas(jsonStr)),
  ]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // try next candidate
    }
  }

  if (parsed) {
    const correctedVoice =
      typeof parsed.corrected_voice === "string"
        ? parsed.corrected_voice
        : typeof parsed.corrected === "string"
          ? parsed.corrected
          : originalText;
    const correctedText =
      typeof parsed.corrected_text === "string"
        ? parsed.corrected_text
        : stripEmotionTags(correctedVoice);
    return {
      corrected_text: correctedText,
      corrected_voice: correctedVoice,
      changes: Array.isArray(parsed.changes)
        ? parsed.changes.filter((c: unknown) => typeof c === "string")
        : [],
      unchanged: parsed.unchanged === true,
    };
  }

  // Parse failed — return original text unchanged so we never leak raw JSON to users.
  return {
    corrected_text: stripEmotionTags(originalText),
    corrected_voice: originalText,
    changes: [],
    unchanged: true,
    error: `JSON parse failed (raw ${raw.length} chars, stripped ${stripped.length} chars)`,
  };
}

export function buildUserMessage(params: {
  text: string;
  voiceHint?: string;
  context?: string;
  speakerName?: string;
  speakerGender?: string;
  addresseeName?: string;
  addresseeGender?: string;
}): string {
  const lines: string[] = [];

  if (params.context) {
    lines.push(`Context: ${params.context}`);
  }

  const speakerParts: string[] = [];
  if (params.speakerName) {
    speakerParts.push(params.speakerName);
  }
  if (params.speakerGender) {
    speakerParts.push(params.speakerGender);
  }
  if (speakerParts.length > 0) {
    lines.push(`Speaker: ${speakerParts.join(", ")}`);
  }

  const addresseeParts: string[] = [];
  if (params.addresseeName) {
    addresseeParts.push(params.addresseeName);
  }
  if (params.addresseeGender) {
    addresseeParts.push(params.addresseeGender);
  }
  if (addresseeParts.length > 0) {
    lines.push(`Addressee: ${addresseeParts.join(", ")}`);
  }

  // Strip [[tts:text]] directives from display text — Sonnet doesn't understand them
  // as markup and would include their content in corrected_text, causing a text leak.
  const cleanText = params.text
    .replace(/\[\[tts:text\]\][\s\S]*?\[{1,2}\/tts:text\]\]/gi, "")
    .trim();
  lines.push("");
  lines.push("Text to proofread:");
  lines.push(cleanText);

  if (params.voiceHint) {
    lines.push("");
    lines.push(
      "Model's voice version (use as reference for corrected_voice — preserve style tags like [whispers], [short pause]):",
    );
    lines.push(params.voiceHint);
  }
  return lines.join("\n");
}

// ── Standalone cloud call (no tool framework) ───────────────────────────────

export async function proofreadText(params: {
  text: string;
  cfg?: OpenClawConfig;
  agentDir: string;
  model?: string;
  context?: string;
  speakerName?: string;
  speakerGender?: string;
  addresseeName?: string;
  addresseeGender?: string;
}): Promise<ProofreadResult> {
  const modelId = params.model || DEFAULT_PROOFREAD_MODEL;

  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  const slash = modelId.indexOf("/");
  const provider = slash >= 0 ? modelId.slice(0, slash) : modelId;
  const model = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  const resolved = modelRegistry.find(provider, model) as Model<Api> | null;
  if (!resolved) {
    return {
      corrected_text: stripEmotionTags(params.text),
      corrected_voice: params.text,
      changes: [],
      unchanged: true,
      error: `Proofread model not found: ${modelId}`,
    };
  }

  const apiKeyInfo = await getApiKeyForModel({
    model: resolved,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
  const apiKey = requireApiKey(apiKeyInfo, resolved.provider);
  authStorage.setRuntimeApiKey(resolved.provider, apiKey);

  // Extract [[tts:text]] voice hint from model output before sending to Sonnet.
  const voiceBlockMatch = params.text.match(/\[\[tts:text\]\]([\s\S]*?)\[{1,2}\/tts:text\]\]/i);
  const voiceHint = voiceBlockMatch?.[1]?.trim() || undefined;

  const piContext: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage({
          text: params.text,
          voiceHint,
          context: params.context,
          speakerName: params.speakerName,
          speakerGender: params.speakerGender,
          addresseeName: params.addresseeName,
          addresseeGender: params.addresseeGender,
        }),
        timestamp: Date.now(),
      },
    ],
  };

  let message = await complete(resolved, piContext, {
    apiKey,
    maxTokens: 2048,
  });

  // Single retry on 429 rate-limit errors after a short back-off.
  if (message.stopReason === "error" && message.errorMessage?.includes("429")) {
    await new Promise((r) => setTimeout(r, 2000));
    message = await complete(resolved, piContext, { apiKey, maxTokens: 2048 });
  }

  if (message.stopReason === "error") {
    return {
      corrected_text: stripEmotionTags(params.text),
      corrected_voice: params.text,
      changes: [],
      unchanged: true,
      error: message.errorMessage ?? "Cloud model returned an error",
    };
  }

  const responseText = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  if (!responseText) {
    return {
      corrected_text: stripEmotionTags(params.text),
      corrected_voice: params.text,
      changes: [],
      unchanged: true,
      error: "Cloud model returned no text",
    };
  }

  logVerbose(
    `[proofread] raw response (${responseText.length} chars): ${responseText.slice(0, 500)}`,
  );
  return parseProofreadResponse(responseText, params.text);
}

// ── Conversation context ring buffer ─────────────────────────────────────────

const RECENT_OUTBOUND_CAP = 3;

/**
 * Per-session ring buffer of recent outbound message texts.
 * Used to give the proofreader context for detecting repetitive openings.
 * In-memory only — resets on gateway restart, which is fine since
 * repetitive patterns are a within-session phenomenon.
 */
const recentOutbound = new Map<string, string[]>();

function pushOutboundText(sessionKey: string, text: string): void {
  let buf = recentOutbound.get(sessionKey);
  if (!buf) {
    buf = [];
    recentOutbound.set(sessionKey, buf);
  }
  buf.push(text);
  if (buf.length > RECENT_OUTBOUND_CAP) {
    buf.shift();
  }
}

function getRecentOutboundContext(sessionKey: string): string | undefined {
  const buf = recentOutbound.get(sessionKey);
  if (!buf || buf.length === 0) {
    return undefined;
  }
  const lines = buf.map((t, i) => `[${i + 1}] ${t.slice(0, 200)}`);
  return `Recent messages in this conversation (check for repetitive openings):\n${lines.join("\n")}`;
}

// ── Dispatch pipeline entry point ───────────────────────────────────────────

const MIN_PROOFREAD_LENGTH = 20;

/** Strip [[tts:text]]...[[/tts:text]] directives for display (preserves surrounding text). */
export function stripTtsDirectivesForDisplay(payload: ReplyPayload): ReplyPayload {
  if (!payload.text) {
    return payload;
  }
  const cleaned = payload.text
    .replace(/\[\[tts:text\]\][\s\S]*?\[{1,2}\/tts:text\]\]/gi, "")
    .trim();
  return { ...payload, text: cleaned || payload.text };
}

export async function maybeProofreadPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionKey?: string;
}): Promise<ReplyPayload> {
  const proofCfg: ProofreadConfig | undefined = params.cfg.messages?.proofread;
  if (!proofCfg?.auto) {
    return params.payload;
  }

  const text = params.payload.text?.trim();
  if (!text || text.length < MIN_PROOFREAD_LENGTH) {
    return params.payload;
  }

  if (!params.agentDir) {
    return params.payload;
  }

  // Build conversation context from recent outbound messages for this session.
  const context = params.sessionKey ? getRecentOutboundContext(params.sessionKey) : undefined;

  try {
    const log = getLogger();
    log.info(
      `[proofread] starting: ${text.length} chars via ${proofCfg.model || DEFAULT_PROOFREAD_MODEL}${context ? " (with conversation context)" : ""}`,
    );

    const t0 = Date.now();
    const result = await proofreadText({
      text,
      cfg: params.cfg,
      agentDir: params.agentDir,
      model: proofCfg.model,
      context,
      speakerName: proofCfg.speaker?.name,
      speakerGender: proofCfg.speaker?.gender,
      addresseeName: proofCfg.addressee?.name,
      addresseeGender: proofCfg.addressee?.gender,
    });
    const elapsed = Date.now() - t0;

    if (result.error) {
      log.warn(`[proofread] error (${elapsed}ms): ${result.error}`);
      return params.payload;
    }

    // Track outbound text for future repetition detection.
    if (params.sessionKey) {
      const outText = result.unchanged ? text : result.corrected_text;
      pushOutboundText(params.sessionKey, outText);
    }

    if (result.unchanged) {
      log.info(`[proofread] unchanged (${elapsed}ms)`);
      return params.payload;
    }

    log.info(`[proofread] corrected (${elapsed}ms, ${result.changes.length} changes)`);
    logVerbose(`[proofread] changes: ${result.changes.join("; ")}`);

    // Embed corrected_voice as [[tts:text]] directive so parseTtsDirectives() picks it up for TTS.
    const combined = `${result.corrected_text}\n[[tts:text]]${result.corrected_voice}[[/tts:text]]`;
    return { ...params.payload, text: combined };
  } catch (err) {
    getLogger().warn(`[proofread] failed: ${err instanceof Error ? err.message : String(err)}`);
    return params.payload;
  }
}
