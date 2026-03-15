/**
 * adapters/stt/DeepgramAdapter.ts
 *
 * Deepgram Nova-2 streaming STT via their SDK.
 * - Opens a persistent WebSocket
 * - Streams 16 kHz mono int16 PCM
 * - Emits interim + final transcripts
 * - Auto-reconnects on disconnect (up to 5 attempts, exp back-off)
 * - Emits "unavailable" when retries exhausted so bridge can fall back
 */

import { EventEmitter } from "events";
import {
  createClient,
  LiveTranscriptionEvents,
  LiveClient,
  DeepgramClient,
} from "@deepgram/sdk";
import { v4 as uuid } from "uuid";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import type { SttAdapter, SttTranscript } from "./SttAdapter";

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;

export class DeepgramAdapter extends EventEmitter implements SttAdapter {
  private client: DeepgramClient;
  private liveClient: LiveClient | null = null;
  private _isConnected = false;
  private retryCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private audioQueue: Buffer[] = [];

  constructor() {
    super();
    this.client = createClient(config.DEEPGRAM_API_KEY);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    this.closing = false;
    return this._connect();
  }

  private async _connect(): Promise<void> {
    logger.info({ adapter: "deepgram" }, "Connecting to Deepgram Realtime…");

    const lc = this.client.listen.live({
      model: config.DEEPGRAM_MODEL,
      language: config.DEEPGRAM_LANGUAGE,
      encoding: "linear16",
      sample_rate: config.STT_SAMPLE_RATE,
      channels: 1,
      interim_results: true,
      endpointing: config.DEEPGRAM_ENDPOINTING_MS,
      utterance_end_ms: config.DEEPGRAM_ENDPOINTING_MS + 200,
      smart_format: true,
      punctuate: true,
      diarize: false,
    });

    this.liveClient = lc;

    lc.on(LiveTranscriptionEvents.Open, () => {
      logger.info({ adapter: "deepgram" }, "Deepgram connection open");
      this._isConnected = true;
      this.retryCount = 0;
      // Drain any queued audio
      while (this.audioQueue.length > 0) {
        const chunk = this.audioQueue.shift();
        if (chunk) lc.send(chunk);
      }
    });

    lc.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data?.channel?.alternatives?.[0];
      if (!alt || !alt.transcript?.trim()) return;

      const isFinal = data.is_final === true;
      const t: SttTranscript = {
        speechId: uuid(),
        text: alt.transcript.trim(),
        isFinal,
        confidence: alt.confidence,
        receivedAt: Date.now(),
      };

      this.emit("transcript", t);
      if (isFinal) this.emit("final", t);
    });

    lc.on(LiveTranscriptionEvents.Error, (err) => {
      logger.error({ adapter: "deepgram", err }, "Deepgram error");
      this._isConnected = false;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      if (!this.closing) this._scheduleReconnect();
    });

    lc.on(LiveTranscriptionEvents.Close, () => {
      logger.warn({ adapter: "deepgram" }, "Deepgram connection closed");
      this._isConnected = false;
      this.emit("close");
      if (!this.closing) this._scheduleReconnect();
    });
  }

  sendAudio(pcm16: Buffer): void {
    if (!this._isConnected || !this.liveClient) {
      // Queue until reconnected (cap at ~4s of 16kHz mono audio)
      if (this.audioQueue.length < 50) this.audioQueue.push(pcm16);
      return;
    }
    try {
      this.liveClient.send(pcm16);
    } catch (err) {
      logger.warn({ adapter: "deepgram", err }, "sendAudio failed");
    }
  }

  async flush(): Promise<void> {
    if (this.liveClient && this._isConnected) {
      // Send a few frames of silence to flush Deepgram's endpointing
      const silenceFrames = Buffer.alloc(config.STT_SAMPLE_RATE * 0.3 * 2); // 300ms
      this.liveClient.send(silenceFrames);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this._isConnected = false;
    if (this.liveClient) {
      try {
        this.liveClient.requestClose();
      } catch {
        // ignore
      }
      this.liveClient = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) {
      logger.error(
        { adapter: "deepgram", retries: this.retryCount },
        "Deepgram max retries exceeded — emitting unavailable"
      );
      this.emit("error", new Error("DEEPGRAM_UNAVAILABLE"));
      return;
    }

    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, this.retryCount);
    this.retryCount++;
    logger.info(
      { adapter: "deepgram", attempt: this.retryCount, delayMs: delay },
      "Scheduling Deepgram reconnect…"
    );
    this.retryTimer = setTimeout(() => {
      void this._connect();
    }, delay);
  }
}
