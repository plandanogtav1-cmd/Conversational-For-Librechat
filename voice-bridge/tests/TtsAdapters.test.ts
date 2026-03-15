/**
 * tests/TtsAdapters.test.ts
 * Tests for TTS sentence splitter and adapter selection.
 */

import { splitIntoSentences } from "../src/adapters/tts";

describe("splitIntoSentences", () => {
  it("splits on period", () => {
    const result = splitIntoSentences("Hello there. How are you?");
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("Hello there.");
    expect(result[1]).toBe("How are you?");
  });

  it("handles single sentence without trailing punctuation", () => {
    const result = splitIntoSentences("Hello world");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Hello world");
  });

  it("handles exclamation marks", () => {
    const result = splitIntoSentences("Stop! Don't do that. Please.");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("filters empty strings", () => {
    const result = splitIntoSentences("   ");
    // Either empty array or filtered
    expect(result.every((s) => s.trim().length > 0)).toBe(true);
  });

  it("handles multiple spaces between sentences", () => {
    const result = splitIntoSentences("First sentence.  Second sentence.");
    expect(result.length).toBeGreaterThanOrEqual(1);
    result.forEach((s) => expect(s.trim().length).toBeGreaterThan(0));
  });

  it("preserves question marks", () => {
    const result = splitIntoSentences("What is your name? My name is Alex.");
    expect(result[0]).toContain("?");
    expect(result[1]).toContain(".");
  });

  it("handles quoted sentence endings", () => {
    const result = splitIntoSentences('He said "Hello." Then left.');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("handles long text with many sentences", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1}.`).join(" ");
    const result = splitIntoSentences(text);
    expect(result.length).toBe(10);
  });
});

// ── TTS factory tests ─────────────────────────────────────────────────────────

jest.mock("../src/config", () => ({
  config: {
    TTS_PROVIDER: "piper",
    PIPER_URL: "http://localhost:5000/synthesize",
    PIPER_VOICE: "en_US-lessac-medium",
    OPENAI_API_KEY: "test",
    OPENAI_TTS_VOICE: "alloy",
    OPENAI_TTS_MODEL: "tts-1",
    ELEVENLABS_API_KEY: "test",
    ELEVENLABS_VOICE_ID: "test-id",
    ELEVENLABS_MODEL: "eleven_turbo_v2_5",
  },
}));

jest.mock("../src/utils/logger", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { createTtsAdapter } from "../src/adapters/tts";
import { PiperAdapter } from "../src/adapters/tts/PiperAdapter";
import { OpenAITtsAdapter } from "../src/adapters/tts/OpenAITtsAdapter";

describe("createTtsAdapter", () => {
  it("returns PiperAdapter when TTS_PROVIDER=piper", () => {
    const adapter = createTtsAdapter();
    expect(adapter).toBeInstanceOf(PiperAdapter);
    expect(adapter.name).toBe("piper");
  });
});

describe("PiperAdapter", () => {
  it("has correct name", () => {
    const a = new PiperAdapter();
    expect(a.name).toBe("piper");
  });

  it("cancel() is idempotent", () => {
    const a = new PiperAdapter();
    expect(() => {
      a.cancel();
      a.cancel();
    }).not.toThrow();
  });
});

describe("OpenAITtsAdapter", () => {
  it("has correct name", () => {
    const a = new OpenAITtsAdapter();
    expect(a.name).toBe("openai-tts");
  });

  it("cancel() is idempotent", () => {
    const a = new OpenAITtsAdapter();
    expect(() => {
      a.cancel();
      a.cancel();
    }).not.toThrow();
  });
});
