import { type Api, type Context, complete, type Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { getApiKeyForModel, requireApiKey } from "../../../src/agents/model-auth.js";
import { ensureOpenClawModelsJson } from "../../../src/agents/models-config.js";
import { discoverAuthStorage, discoverModels } from "../../../src/agents/pi-model-discovery.js";
import {
  DEFAULT_PROOFREAD_MODEL,
  SYSTEM_PROMPT,
  type ProofreadResult,
  buildUserMessage,
  parseProofreadResponse,
  stripEmotionTags,
} from "../../../src/auto-reply/reply/proofread-transform.js";

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean },
): string {
  const raw = params[key];
  if (typeof raw !== "string" || !raw.trim()) {
    if (opts?.required) {
      throw new Error(`${key} required`);
    }
    return "";
  }
  return raw.trim();
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const ProofreadToolSchema = Type.Object({
  text: Type.String({
    description:
      "The text to proofread and correct (any language — will be proofread in the same language). May include [emotion] tags.",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Brief summary of the conversation context — helps the editor understand tone and intent. Example: 'Intimate late-night chat about shared memories.'",
    }),
  ),
  speaker_name: Type.Optional(
    Type.String({ description: "Name of the speaker (who wrote the text). Example: 'Moisty'." }),
  ),
  speaker_gender: Type.Optional(
    Type.String({
      description:
        "Grammatical gender of the speaker (kobieta/mężczyzna). Helps correct verb forms like zrobiłam vs zrobiłem.",
    }),
  ),
  addressee_name: Type.Optional(
    Type.String({ description: "Name of the person being addressed. Example: 'Ikari'." }),
  ),
  addressee_gender: Type.Optional(
    Type.String({
      description:
        "Grammatical gender of the person being addressed. Helps correct forms like zrobiłeś vs zrobiłaś.",
    }),
  ),
});

export function createProofreadTool(opts?: {
  config?: OpenClawConfig;
  agentDir?: string;
}): AnyAgentTool | null {
  const agentDir = opts?.agentDir?.trim();
  if (!agentDir) {
    return null;
  }

  return {
    label: "Proofread",
    name: "proofread",
    description:
      "Proofread and correct text in any language — fixes grammar, gender, phrasing. Detects the language automatically and proofreads in the same language. Returns corrected_text (clean, for display) and corrected_voice (with [emotion] tags, for TTS). Call before sending messages.",
    parameters: ProofreadToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const context = readStringParam(params, "context");
      const speakerName = readStringParam(params, "speaker_name");
      const speakerGender = readStringParam(params, "speaker_gender");
      const addresseeName = readStringParam(params, "addressee_name");
      const addresseeGender = readStringParam(params, "addressee_gender");

      try {
        await ensureOpenClawModelsJson(opts?.config, agentDir);
        const authStorage = discoverAuthStorage(agentDir);
        const modelRegistry = discoverModels(authStorage, agentDir);

        const [provider, modelId] = DEFAULT_PROOFREAD_MODEL.split("/", 2);
        const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
        if (!model) {
          return jsonResult({
            corrected_text: stripEmotionTags(text),
            corrected_voice: text,
            changes: [],
            unchanged: true,
            error: `Proofread model not found: ${DEFAULT_PROOFREAD_MODEL}`,
          } satisfies ProofreadResult);
        }

        const apiKeyInfo = await getApiKeyForModel({
          model,
          cfg: opts?.config,
          agentDir,
        });
        const apiKey = requireApiKey(apiKeyInfo, model.provider);
        authStorage.setRuntimeApiKey(model.provider, apiKey);

        const piContext: Context = {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildUserMessage({
                text,
                context,
                speakerName,
                speakerGender,
                addresseeName,
                addresseeGender,
              }),
              timestamp: Date.now(),
            },
          ],
        };

        const message = await complete(model, piContext, {
          apiKey,
          maxTokens: 2048,
        });

        if (message.stopReason === "error") {
          return jsonResult({
            corrected_text: stripEmotionTags(text),
            corrected_voice: text,
            changes: [],
            unchanged: true,
            error: message.errorMessage ?? "Cloud model returned an error",
          } satisfies ProofreadResult);
        }

        const responseText = message.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("")
          .trim();

        if (!responseText) {
          return jsonResult({
            corrected_text: stripEmotionTags(text),
            corrected_voice: text,
            changes: [],
            unchanged: true,
            error: "Cloud model returned no text",
          } satisfies ProofreadResult);
        }

        const result = parseProofreadResponse(responseText, text);
        return jsonResult(result);
      } catch (err) {
        // Graceful degradation: return split variants of original text
        return jsonResult({
          corrected_text: stripEmotionTags(text),
          corrected_voice: text,
          changes: [],
          unchanged: true,
          error: `Proofread unavailable: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ProofreadResult);
      }
    },
  };
}
