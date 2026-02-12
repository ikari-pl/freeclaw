import type { Bot } from "grammy";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { MarkdownTableMode } from "../config/types.base.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { sendTelegramText } from "./bot/delivery.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { markdownToTelegramHtml } from "./format.js";

const DEBOUNCE_MS = 2_000;
const TELEGRAM_TEXT_LIMIT = 4096;
const TRUNCATION_SUFFIX = "...";

export type ToolUpdateTracker = {
  handleToolUpdate(payload: ReplyPayload): Promise<void>;
  /** Flush pending edit, delete the status message, and reset state. */
  cleanup(): Promise<void>;
  /** Clear timers without deleting (abort/error path). */
  stop(): void;
};

type ToolUpdateTrackerOptions = {
  bot: Bot;
  chatId: number;
  thread?: TelegramThreadSpec | null;
  runtime: RuntimeEnv;
  textLimit: number;
  tableMode?: MarkdownTableMode;
  linkPreview?: boolean;
  /** Fallback for media or non-trackable payloads. */
  deliverReplies: (payload: ReplyPayload) => Promise<void>;
};

function hasMedia(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0));
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

export function createToolUpdateTracker(opts: ToolUpdateTrackerOptions): ToolUpdateTracker {
  const { bot, chatId, runtime } = opts;
  const threadParams = buildTelegramThreadParams(opts.thread);

  let activeMessageId: number | null = null;
  let pendingText: string | null = null;
  let lastSentText = "";
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flushEdit = async () => {
    debounceTimer = undefined;
    if (stopped || !activeMessageId || pendingText == null) {
      return;
    }
    const text = pendingText;
    pendingText = null;
    if (text === lastSentText) {
      return;
    }
    const truncated = truncateText(text, TELEGRAM_TEXT_LIMIT);
    const html = markdownToTelegramHtml(truncated);
    lastSentText = text;
    try {
      await withTelegramApiErrorLogging({
        operation: "editMessageText",
        runtime,
        // Suppress "message is not modified" errors silently.
        shouldLog: (err) => !isNotModifiedError(err),
        fn: () =>
          bot.api.editMessageText(chatId, activeMessageId!, html, {
            parse_mode: "HTML",
            ...threadParams,
          }),
      });
    } catch {
      // Best-effort edit; swallow errors (rate limits handled by apiThrottler).
    }
  };

  const resetDebounce = () => {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void flushEdit();
    }, DEBOUNCE_MS);
  };

  const handleToolUpdate = async (payload: ReplyPayload): Promise<void> => {
    if (stopped) {
      return;
    }
    // Media payloads bypass the tracker — deliver as separate messages.
    if (hasMedia(payload)) {
      await opts.deliverReplies(payload);
      return;
    }
    const text = payload.text ?? "";
    if (!text.trim()) {
      return;
    }

    if (activeMessageId == null) {
      // First text tool update: send a new message immediately.
      const truncated = truncateText(text, opts.textLimit);
      const messageId = await sendTelegramText(bot, String(chatId), truncated, runtime, {
        thread: opts.thread,
        linkPreview: opts.linkPreview,
      });
      if (messageId != null) {
        activeMessageId = messageId;
        lastSentText = text;
      }
      return;
    }
    // Subsequent updates: buffer and debounce.
    pendingText = text;
    resetDebounce();
  };

  const cleanup = async (): Promise<void> => {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    // Force-flush any pending edit before deleting.
    if (pendingText != null && activeMessageId != null) {
      const text = pendingText;
      pendingText = null;
      if (text !== lastSentText) {
        const truncated = truncateText(text, TELEGRAM_TEXT_LIMIT);
        const html = markdownToTelegramHtml(truncated);
        try {
          await bot.api.editMessageText(chatId, activeMessageId, html, {
            parse_mode: "HTML",
            ...threadParams,
          });
        } catch {
          // Best-effort.
        }
      }
    }
    // Delete the tool status message.
    if (activeMessageId != null) {
      try {
        await bot.api.deleteMessage(chatId, activeMessageId);
      } catch {
        // Best-effort deletion; message may already be gone.
      }
      activeMessageId = null;
    }
    lastSentText = "";
    pendingText = null;
    stopped = false;
  };

  const stop = (): void => {
    stopped = true;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  };

  return { handleToolUpdate, cleanup, stop };
}

function isNotModifiedError(err: unknown): boolean {
  const msg = formatErrorMessage(err);
  return /message is not modified/i.test(msg);
}
