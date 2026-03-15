/**
 * tests/DeepgramAdapter.test.ts
 */

import { EventEmitter } from "events";

// ── Mock @deepgram/sdk before any imports use it ─────────────────────────────

const mockLiveClient = new EventEmitter() as EventEmitter & {
  send: jest.Mock;
  requestClose: jest.Mock;
};
mockLiveClient.send = jest.fn();
mockLiveClient.requestClose = jest.fn();

jest.mock("@deepgram/sdk", () => {
  const LiveTranscriptionEvents = {
    Open: "open",
    Transcript: "transcript",
    Error: "error",
    Close: "close",
  };

  const createClient = jest.fn(() => ({
    listen: {
      live: jest.fn(() => mockLiveClient),
    },
  }));

  return { createClient, LiveTranscriptionEvents };
});

// ── Also mock config so we don't need a real .env ────────────────────────────

jest.mock("../src/config", () => ({
  config: {
    DEEPGRAM_API_KEY: "test-key",
    DEEPGRAM_MODEL: "nova-2",
    DEEPGRAM_LANGUAGE: "en-US",
    STT_SAMPLE_RATE: 16000,
    DEEPGRAM_ENDPOINTING_MS: 400,
    LOG_LEVEL: "silent",
    LOG_JSON: false,
  },
}));

jest.mock("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { DeepgramAdapter } from "../src/adapters/stt/DeepgramAdapter";

describe("DeepgramAdapter", () => {
  let adapter: DeepgramAdapter;

  beforeEach(async () => {
    adapter = new DeepgramAdapter();
    // Simulate open immediately
    const connectPromise = adapter.connect();
    mockLiveClient.emit("open");
    await connectPromise;
  });

  afterEach(async () => {
    await adapter.close();
    jest.clearAllMocks();
  });

  it("reports isConnected = true after open", () => {
    expect(adapter.isConnected).toBe(true);
  });

  it("calls liveClient.send when sendAudio is called", () => {
    const buf = Buffer.alloc(320);
    adapter.sendAudio(buf);
    expect(mockLiveClient.send).toHaveBeenCalledWith(buf);
  });

  it("emits transcript event for interim results", (done) => {
    adapter.on("transcript", (t) => {
      expect(t.isFinal).toBe(false);
      expect(t.text).toBe("hello");
      done();
    });

    mockLiveClient.emit("transcript", {
      is_final: false,
      channel: { alternatives: [{ transcript: "hello", confidence: 0.9 }] },
    });
  });

  it("emits final event for final results", (done) => {
    adapter.on("final", (t) => {
      expect(t.isFinal).toBe(true);
      expect(t.text).toBe("hello world");
      done();
    });

    mockLiveClient.emit("transcript", {
      is_final: true,
      channel: {
        alternatives: [{ transcript: "hello world", confidence: 0.95 }],
      },
    });
  });

  it("ignores empty transcripts", () => {
    const transcriptHandler = jest.fn();
    adapter.on("transcript", transcriptHandler);

    mockLiveClient.emit("transcript", {
      is_final: true,
      channel: { alternatives: [{ transcript: "   ", confidence: 0 }] },
    });

    expect(transcriptHandler).not.toHaveBeenCalled();
  });

  it("sets isConnected = false after close", async () => {
    await adapter.close();
    expect(adapter.isConnected).toBe(false);
  });

  it("queues audio when not connected", () => {
    // Close the adapter (disconnect)
    void adapter.close();

    const buf = Buffer.alloc(320);
    // Reconnecting adapter — not connected yet
    const adapter2 = new DeepgramAdapter();
    adapter2.sendAudio(buf); // Should not throw, queues the buffer
    expect(mockLiveClient.send).not.toHaveBeenCalledWith(buf); // Not sent yet
    void adapter2.close();
  });
});
