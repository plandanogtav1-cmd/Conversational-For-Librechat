/**
 * adapters/tts/PiperAdapter.ts
 *
 * Piper TTS via its HTTP synthesis endpoint.
 * Piper returns raw 22 kHz mono int16 PCM (model-dependent).
 * We resample to 48 kHz before yielding.
 *
 * Compatible with: https://github.com/rhasspy/piper
 * Run with: docker run -p 5000:5000 rhasspy/piper-voices (or our compose)
 *
 * Endpoint: POST /synthesize  { text, voice }  → raw PCM
 */

import axios, { CancelTokenSource } from "axios";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { ttsToWebrtc } from "../../audio/resampler";
import type { TtsAdapter, TtsChunk } from "./TtsAdapter";

// Piper voices output at 22050 Hz typically; some are 16000 Hz.
// We configure per-voice via PIPER_SAMPLE_RATE (default 22050).
const PIPER_NATIVE_RATE = parseInt(process.env["PIPER_SAMPLE_RATE"] ?? "22050", 10);

export class PiperAdapter implements TtsAdapter {
  readonly name = "piper";
  private cancelSource: CancelTokenSource | null = null;

  cancel(): void {
    if (this.cancelSource) {
      this.cancelSource.cancel("barge-in");
      this.cancelSource = null;
    }
  }

  async *synthesizeStream(text: string): AsyncGenerator<TtsChunk> {
    const cancelSource = axios.CancelToken.source();
    this.cancelSource = cancelSource;

    logger.debug({ adapter: this.name, chars: text.length }, "Synthesizing…");

    try {
      const response = await axios.post(
        config.PIPER_URL,
        { text, voice: config.PIPER_VOICE },
        {
          responseType: "stream",
          cancelToken: cancelSource.token,
          timeout: 30000,
          headers: { "Content-Type": "application/json" },
        }
      );

      const stream = response.data as NodeJS.ReadableStream;
      const CHUNK_BYTES = PIPER_NATIVE_RATE * 2 * 0.05; // 50 ms chunks

      let pending = Buffer.alloc(0);

      for await (const rawChunk of stream) {
        if (this.cancelSource === null) {
          stream.destroy();
          return;
        }

        pending = Buffer.concat([
          pending,
          Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as ArrayBuffer),
        ]);

        // Emit in ~50 ms chunks to start playback quickly
        while (pending.length >= CHUNK_BYTES) {
          const slice = pending.subarray(0, CHUNK_BYTES);
          pending = pending.subarray(CHUNK_BYTES);
          const pcm48k = ttsToWebrtc(slice, PIPER_NATIVE_RATE);
          yield { pcm48k, isFinal: false };
        }
      }

      // Flush remainder
      if (pending.length > 0) {
        const pcm48k = ttsToWebrtc(pending, PIPER_NATIVE_RATE);
        yield { pcm48k, isFinal: false };
      }

      yield { pcm48k: Buffer.alloc(0), isFinal: true };
    } catch (err) {
      if (axios.isCancel(err)) {
        logger.debug({ adapter: this.name }, "Synthesis cancelled (barge-in)");
        return;
      }
      logger.error({ adapter: this.name, err }, "Piper TTS failed");
      throw err;
    } finally {
      this.cancelSource = null;
    }
  }
}
