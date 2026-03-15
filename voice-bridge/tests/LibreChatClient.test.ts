/**
 * tests/LibreChatClient.test.ts
 */

jest.mock("../src/config", () => ({
  config: {
    LLM_BASE_URL: "http://localhost:3080/api",
    LLM_API_KEY: "test-key",
    LLM_MODEL: "gpt-4o-mini",
    LLM_MAX_TOKENS: 512,
    LLM_TEMPERATURE: 0.7,
    LLM_SYSTEM_PROMPT: "You are helpful.",
    LOG_LEVEL: "silent",
    LOG_JSON: false,
  },
}));

jest.mock("../src/utils/logger", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { LibreChatClient } from "../src/llm/LibreChatClient";

// ── SSE stream builder helper ─────────────────────────────────────────────────

function makeSSEStream(tokens: string[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const token of tokens) {
        const line = `data: ${JSON.stringify({
          choices: [{ delta: { content: token } }],
        })}\n\n`;
        controller.enqueue(encoder.encode(line));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function mockFetch(tokens: string[], status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    body: makeSSEStream(tokens),
    text: async () => "error body",
  });
}

describe("LibreChatClient", () => {
  let client: LibreChatClient;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new LibreChatClient("test-session");
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it("accumulates all tokens into fullText", async () => {
    global.fetch = mockFetch(["Hello", ", ", "world", "!"]);

    let fullText = "";
    const tokens: string[] = [];

    await client.streamResponse("Hi", {
      onToken: (t) => tokens.push(t),
      onSentence: jest.fn(),
      onComplete: (text) => {
        fullText = text;
      },
      onError: (err) => {
        throw err;
      },
    });

    expect(tokens).toEqual(["Hello", ", ", "world", "!"]);
    expect(fullText).toBe("Hello, world!");
  });

  it("emits onSentence at sentence boundaries", async () => {
    global.fetch = mockFetch([
      "Hello there. ",
      "How are you?",
    ]);

    const sentences: string[] = [];

    await client.streamResponse("test", {
      onToken: jest.fn(),
      onSentence: (s) => sentences.push(s),
      onComplete: jest.fn(),
      onError: (err) => {
        throw err;
      },
    });

    // Should have at least emitted the flushed sentence
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    const combined = sentences.join(" ");
    expect(combined).toContain("Hello there");
  });

  it("calls onError on HTTP failure", async () => {
    global.fetch = mockFetch([], 500);

    const errorSpy = jest.fn();

    await client.streamResponse("test", {
      onToken: jest.fn(),
      onSentence: jest.fn(),
      onComplete: jest.fn(),
      onError: errorSpy,
    });

    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0].message).toContain("500");
  });

  it("cancels in-flight request", async () => {
    let fetchCalled = false;
    global.fetch = jest.fn().mockImplementation(() => {
      fetchCalled = true;
      return new Promise((_, reject) => {
        // The AbortController will reject this
        setTimeout(() => reject(new DOMException("", "AbortError")), 100);
      });
    });

    const completeSpy = jest.fn();

    const streamPromise = client.streamResponse("test", {
      onToken: jest.fn(),
      onSentence: jest.fn(),
      onComplete: completeSpy,
      onError: jest.fn(),
    });

    // Cancel immediately
    client.cancel();
    await streamPromise;

    expect(fetchCalled).toBe(true);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("tracks turn count correctly", async () => {
    global.fetch = mockFetch(["Response."]);

    expect(client.turnCount).toBe(0);

    await client.streamResponse("first message", {
      onToken: jest.fn(),
      onSentence: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    expect(client.turnCount).toBe(1);
  });

  it("resetHistory clears turns", async () => {
    global.fetch = mockFetch(["ok"]);
    await client.streamResponse("hi", {
      onToken: jest.fn(),
      onSentence: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });
    expect(client.turnCount).toBe(1);

    client.resetHistory();
    expect(client.turnCount).toBe(0);
  });
});
