import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolUpdateTracker } from "./tool-update-tracker.js";

// Stub sendTelegramText — returns a message_id.
vi.mock("./bot/delivery.js", () => ({
  sendTelegramText: vi.fn().mockResolvedValue(42),
}));

// Stub markdownToTelegramHtml — identity.
vi.mock("./format.js", () => ({
  markdownToTelegramHtml: (text: string) => `<html>${text}</html>`,
}));

// Stub withTelegramApiErrorLogging — just calls fn.
vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
}));

import { sendTelegramText } from "./bot/delivery.js";

function createMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  };
}

function createTracker(overrides?: {
  bot?: ReturnType<typeof createMockBot>;
  deliverReplies?: ReturnType<typeof vi.fn>;
}) {
  const bot = overrides?.bot ?? createMockBot();
  const deliverReplies = overrides?.deliverReplies ?? vi.fn().mockResolvedValue(undefined);
  const tracker = createToolUpdateTracker({
    // oxlint-disable-next-line typescript/no-explicit-any
    bot: bot as any,
    chatId: 123,
    thread: null,
    runtime: { log: vi.fn(), error: vi.fn() },
    textLimit: 4096,
    linkPreview: false,
    deliverReplies,
  });
  return { bot, deliverReplies, tracker };
}

describe("ToolUpdateTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends first text tool update as a new message", async () => {
    const { tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Running command..." });
    expect(sendTelegramText).toHaveBeenCalledOnce();
    expect(sendTelegramText).toHaveBeenCalledWith(
      expect.anything(),
      "123",
      "Running command...",
      expect.anything(),
      expect.objectContaining({ linkPreview: false }),
    );
  });

  it("buffers second text update without editing immediately", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });
    await tracker.handleToolUpdate({ text: "Step 2..." });
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });

  it("fires edit after 2s debounce", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });
    await tracker.handleToolUpdate({ text: "Step 2..." });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(bot.api.editMessageText).toHaveBeenCalledOnce();
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      123,
      42,
      "<html>Step 2...</html>",
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("coalesces rapid updates into a single edit", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });

    // 5 rapid updates within 100ms.
    for (let i = 2; i <= 6; i++) {
      await tracker.handleToolUpdate({ text: `Step ${i}...` });
      await vi.advanceTimersByTimeAsync(20);
    }

    // Fire the debounce.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(bot.api.editMessageText).toHaveBeenCalledOnce();
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      123,
      42,
      "<html>Step 6...</html>",
      expect.anything(),
    );
  });

  it("delegates media tool updates to deliverReplies", async () => {
    const { deliverReplies, tracker } = createTracker();
    const mediaPayload = { text: "Image ready", mediaUrl: "https://example.com/photo.jpg" };
    await tracker.handleToolUpdate(mediaPayload);
    expect(deliverReplies).toHaveBeenCalledWith(mediaPayload);
    expect(sendTelegramText).not.toHaveBeenCalled();
  });

  it("delegates mediaUrls tool updates to deliverReplies", async () => {
    const { deliverReplies, tracker } = createTracker();
    const mediaPayload = { text: "Gallery", mediaUrls: ["https://example.com/a.jpg"] };
    await tracker.handleToolUpdate(mediaPayload);
    expect(deliverReplies).toHaveBeenCalledWith(mediaPayload);
  });

  it("cleanup() flushes pending edit then deletes message", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });
    await tracker.handleToolUpdate({ text: "Step 2..." });

    await tracker.cleanup();

    // Should have flushed the pending edit.
    expect(bot.api.editMessageText).toHaveBeenCalledOnce();
    // Then deleted the message.
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(123, 42);
  });

  it("cleanup() is a no-op when no tool updates were sent", async () => {
    const { bot, tracker } = createTracker();
    await tracker.cleanup();
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it("cleanup() deletes even when no pending edit exists", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });
    // No second update — no pending text.
    await tracker.cleanup();
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(123, 42);
  });

  it("stop() clears timers without deleting", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });
    await tracker.handleToolUpdate({ text: "Step 2..." });
    tracker.stop();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(bot.api.editMessageText).not.toHaveBeenCalled();
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it("suppresses 'message is not modified' errors silently", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });
    await tracker.handleToolUpdate({ text: "Step 2..." });

    bot.api.editMessageText.mockRejectedValueOnce(new Error("message is not modified"));

    // Should not throw.
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it("handles deleteMessage failure gracefully", async () => {
    const { bot, tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "Step 1..." });
    bot.api.deleteMessage.mockRejectedValueOnce(new Error("message not found"));

    // Should not throw.
    await tracker.cleanup();
    expect(bot.api.deleteMessage).toHaveBeenCalledOnce();
  });

  it("ignores empty text tool updates", async () => {
    const { tracker } = createTracker();
    await tracker.handleToolUpdate({ text: "  " });
    expect(sendTelegramText).not.toHaveBeenCalled();
  });

  it("ignores tool updates after stop()", async () => {
    const { tracker } = createTracker();
    tracker.stop();
    await tracker.handleToolUpdate({ text: "Should be ignored" });
    expect(sendTelegramText).not.toHaveBeenCalled();
  });
});
