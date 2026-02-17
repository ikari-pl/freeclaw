import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../line/markdown-to-line.js";
import { needsTtsSpeechCleanup, stripInlineTtsTagsForDisplay } from "./tts-core.js";

/**
 * Tests that stripMarkdown (used in the TTS pipeline via maybeApplyTtsToPayload)
 * produces clean text suitable for speech synthesis.
 *
 * The TTS pipeline calls stripMarkdown() before sending text to TTS engines
 * (OpenAI, ElevenLabs, Edge) so that formatting symbols are not read aloud
 * (e.g. "hashtag hashtag hashtag" for ### headers).
 */
describe("TTS text preparation – stripMarkdown", () => {
  it("strips markdown headers before TTS", () => {
    expect(stripMarkdown("### System Design Basics")).toBe("System Design Basics");
    expect(stripMarkdown("## Heading\nSome text")).toBe("Heading\nSome text");
  });

  it("strips bold and italic markers before TTS", () => {
    expect(stripMarkdown("This is **important** and *useful*")).toBe(
      "This is important and useful",
    );
  });

  it("strips inline code markers before TTS", () => {
    expect(stripMarkdown("Use `consistent hashing` for distribution")).toBe(
      "Use consistent hashing for distribution",
    );
  });

  it("handles a typical LLM reply with mixed markdown", () => {
    const input = `## Heading with **bold** and *italic*

> A blockquote with \`code\`

Some ~~deleted~~ content.`;

    const result = stripMarkdown(input);

    expect(result).toBe(`Heading with bold and italic

A blockquote with code

Some deleted content.`);
  });

  it("handles markdown-heavy system design explanation", () => {
    const input = `### B-tree vs LSM-tree

**B-tree** uses _in-place updates_ while **LSM-tree** uses _append-only writes_.

> Key insight: LSM-tree optimizes for write-heavy workloads.

---

Use \`B-tree\` for read-heavy, \`LSM-tree\` for write-heavy.`;

    const result = stripMarkdown(input);

    expect(result).not.toContain("#");
    expect(result).not.toContain("**");
    expect(result).not.toContain("`");
    expect(result).not.toContain(">");
    expect(result).not.toContain("---");
    expect(result).toContain("B-tree vs LSM-tree");
    expect(result).toContain("B-tree uses in-place updates");
  });
});

describe("stripInlineTtsTagsForDisplay", () => {
  it("converts simple emotion tags to italics", () => {
    expect(stripInlineTtsTagsForDisplay("[whispers]")).toBe("*whispers*");
    expect(stripInlineTtsTagsForDisplay("[playful]")).toBe("*playful*");
    expect(stripInlineTtsTagsForDisplay("[laughs softly]")).toBe("*laughs softly*");
  });

  it("converts complex Polish emotion tags to italics", () => {
    expect(
      stripInlineTtsTagsForDisplay("[mruczy namiętnie, z figlarnym zaproszeniem, blisko ucha]"),
    ).toBe("*mruczy namiętnie, z figlarnym zaproszeniem, blisko ucha*");
  });

  it("converts action tags to italics", () => {
    expect(stripInlineTtsTagsForDisplay("[walks toward you slowly]")).toBe(
      "*walks toward you slowly*",
    );
  });

  it("strips language wrapper tags, keeps inner content", () => {
    expect(stripInlineTtsTagsForDisplay("[Icelandic]Josefin[/Icelandic]")).toBe("Josefin");
    expect(stripInlineTtsTagsForDisplay("[Icelandic]Jökulsárlón Glacier[/Icelandic]")).toBe(
      "Jökulsárlón Glacier",
    );
  });

  it("handles language tags with surrounding text", () => {
    expect(
      stripInlineTtsTagsForDisplay(
        "Have you been to [Icelandic]Jökulsárlón[/Icelandic]? It's beautiful!",
      ),
    ).toBe("Have you been to Jökulsárlón? It's beautiful!");
  });

  it("preserves markdown links", () => {
    expect(stripInlineTtsTagsForDisplay("Check [this link](https://example.com)")).toBe(
      "Check [this link](https://example.com)",
    );
  });

  it("handles mixed content: emotions, language tags, and markdown links", () => {
    const input =
      "[whispers] I visited [Icelandic]Reykjavík[/Icelandic] last year. " +
      "See [my photos](https://photos.example.com). [sighs happily]";
    const expected =
      "*whispers* I visited Reykjavík last year. " +
      "See [my photos](https://photos.example.com). *sighs happily*";
    expect(stripInlineTtsTagsForDisplay(input)).toBe(expected);
  });

  it("returns plain text unchanged", () => {
    expect(stripInlineTtsTagsForDisplay("Hello world, no tags here!")).toBe(
      "Hello world, no tags here!",
    );
  });

  it("handles multiple emotion tags in one line", () => {
    expect(stripInlineTtsTagsForDisplay("[playful] Hey! [kiss] Miss you.")).toBe(
      "*playful* Hey! *kiss* Miss you.",
    );
  });

  it("handles language tags spanning multiple words", () => {
    expect(stripInlineTtsTagsForDisplay("[Polish]Dzień dobry, jak się masz?[/Polish]")).toBe(
      "Dzień dobry, jak się masz?",
    );
  });

  it("does not match double-bracket TTS directives", () => {
    // [[tts:...]] directives are handled by parseTtsDirectives, not this function.
    // The inner brackets prevent our regex from matching.
    const input = "Hello [[tts:provider=elevenlabs]] world";
    expect(stripInlineTtsTagsForDisplay(input)).toBe(input);
  });

  it("leaves empty brackets unchanged", () => {
    // Empty brackets aren't meaningful tags — leave them alone.
    expect(stripInlineTtsTagsForDisplay("[]")).toBe("[]");
  });

  it("strips [long pause] entirely from display", () => {
    expect(stripInlineTtsTagsForDisplay("Goodnight. [long pause]")).toBe("Goodnight.");
    expect(stripInlineTtsTagsForDisplay("[whispers] Sweet dreams. [long pause]")).toBe(
      "*whispers* Sweet dreams.",
    );
  });

  it("strips [medium pause] and [short pause] from display", () => {
    expect(stripInlineTtsTagsForDisplay("Wait [medium pause] okay")).toBe("Wait okay");
    expect(stripInlineTtsTagsForDisplay("Hey [short pause] listen")).toBe("Hey listen");
  });

  it("strips pause tags case-insensitively", () => {
    expect(stripInlineTtsTagsForDisplay("Done. [Long Pause]")).toBe("Done.");
  });
});

describe("needsTtsSpeechCleanup", () => {
  it("detects IPv4 addresses", () => {
    expect(needsTtsSpeechCleanup("The server is at 192.168.1.169")).toBe(true);
    expect(needsTtsSpeechCleanup("Connect to 10.0.0.1 for access")).toBe(true);
  });

  it("detects MAC addresses", () => {
    expect(needsTtsSpeechCleanup("Device MAC: aa:bb:cc:dd:ee:ff")).toBe(true);
    expect(needsTtsSpeechCleanup("MAC 00:1A:2B:3C:4D:5E found")).toBe(true);
  });

  it("detects file paths", () => {
    expect(needsTtsSpeechCleanup("Edit /Users/ikari/openclaw/src/tts.ts")).toBe(true);
    expect(needsTtsSpeechCleanup("Config at /etc/nginx/nginx.conf")).toBe(true);
  });

  it("detects URLs", () => {
    expect(needsTtsSpeechCleanup("Visit https://example.com/api/v2")).toBe(true);
    expect(needsTtsSpeechCleanup("See http://localhost:3000")).toBe(true);
  });

  it("detects version numbers", () => {
    expect(needsTtsSpeechCleanup("Upgraded to 4.0.18")).toBe(true);
    expect(needsTtsSpeechCleanup("Running node 22.1.0")).toBe(true);
  });

  it("returns false for normal speech text", () => {
    expect(needsTtsSpeechCleanup("Hello, how are you today?")).toBe(false);
    expect(needsTtsSpeechCleanup("[whispers] I missed you")).toBe(false);
    expect(needsTtsSpeechCleanup("The weather is 23 degrees")).toBe(false);
  });

  it("returns false for simple numbers and decimals", () => {
    expect(needsTtsSpeechCleanup("I scored 9.5 out of 10")).toBe(false);
    expect(needsTtsSpeechCleanup("That costs 19.99 dollars")).toBe(false);
  });
});
