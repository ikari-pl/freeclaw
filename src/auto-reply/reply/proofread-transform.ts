import { type Api, type Context, complete, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProofreadConfig } from "../../config/types.messages.js";
import type { ReplyPayload } from "../types.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import { logVerbose } from "../../globals.js";

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

Return ONLY a raw JSON object — no markdown code fences, no backticks, no extra text:
{
  "corrected_text": "the corrected text with all emotion/stage direction tags REMOVED",
  "corrected_voice": "the corrected text with emotion/stage direction tags PRESERVED in place",
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
  const openMatch = s.match(/^```(?:json|JSON)?\s*\n?/);
  if (openMatch) {
    s = s.slice(openMatch[0].length);
  }
  if (s.endsWith("```")) {
    s = s.slice(0, -3).trimEnd();
  }
  return s;
}

export function parseProofreadResponse(raw: string, originalText: string): ProofreadResult {
  const stripped = stripCodeFences(raw);
  const jsonMatch = stripped.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch?.[1]?.trim() ?? stripped.trim();
  try {
    const parsed = JSON.parse(jsonStr);
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
  } catch {
    const cleaned = raw.trim() || originalText;
    return {
      corrected_text: stripEmotionTags(cleaned),
      corrected_voice: cleaned,
      changes: ["(could not parse structured response — raw correction returned)"],
      unchanged: false,
    };
  }
}

export function buildUserMessage(params: {
  text: string;
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

  lines.push("");
  lines.push("Text to proofread:");
  lines.push(params.text);
  return lines.join("\n");
}

// ── Standalone cloud call (no tool framework) ───────────────────────────────

export async function proofreadText(params: {
  text: string;
  cfg?: OpenClawConfig;
  agentDir: string;
  model?: string;
  speakerName?: string;
  speakerGender?: string;
  addresseeName?: string;
  addresseeGender?: string;
}): Promise<ProofreadResult> {
  const modelId = params.model || DEFAULT_PROOFREAD_MODEL;

  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  const [provider, model] = modelId.split("/", 2);
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

  const piContext: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage({
          text: params.text,
          speakerName: params.speakerName,
          speakerGender: params.speakerGender,
          addresseeName: params.addresseeName,
          addresseeGender: params.addresseeGender,
        }),
        timestamp: Date.now(),
      },
    ],
  };

  const message = await complete(resolved, piContext, {
    apiKey,
    maxTokens: 2048,
  });

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

  return parseProofreadResponse(responseText, params.text);
}

// ── Dispatch pipeline entry point ───────────────────────────────────────────

const MIN_PROOFREAD_LENGTH = 20;

/** Strip [[tts:text]]...[[/tts:text]] directives for display (preserves surrounding text). */
export function stripTtsDirectivesForDisplay(payload: ReplyPayload): ReplyPayload {
  if (!payload.text) {
    return payload;
  }
  const cleaned = payload.text.replace(/\[\[tts:text\]\][\s\S]*?\[\[\/tts:text\]\]/gi, "").trim();
  return { ...payload, text: cleaned || payload.text };
}

export async function maybeProofreadPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  agentDir?: string;
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

  try {
    logVerbose(
      `proofread-transform: proofreading ${text.length} chars via ${proofCfg.model || DEFAULT_PROOFREAD_MODEL}`,
    );

    const result = await proofreadText({
      text,
      cfg: params.cfg,
      agentDir: params.agentDir,
      model: proofCfg.model,
      speakerName: proofCfg.speaker?.name,
      speakerGender: proofCfg.speaker?.gender,
      addresseeName: proofCfg.addressee?.name,
      addresseeGender: proofCfg.addressee?.gender,
    });

    if (result.error) {
      logVerbose(`proofread-transform: error — ${result.error}`);
      return params.payload;
    }

    if (result.unchanged) {
      logVerbose("proofread-transform: text unchanged");
      return params.payload;
    }

    logVerbose(`proofread-transform: corrected (${result.changes.length} changes)`);

    // Embed corrected_voice as [[tts:text]] directive so parseTtsDirectives() picks it up for TTS.
    const combined = `${result.corrected_text}\n[[tts:text]]${result.corrected_voice}[[/tts:text]]`;
    return { ...params.payload, text: combined };
  } catch (err) {
    logVerbose(`proofread-transform: failed — ${err instanceof Error ? err.message : String(err)}`);
    return params.payload;
  }
}
