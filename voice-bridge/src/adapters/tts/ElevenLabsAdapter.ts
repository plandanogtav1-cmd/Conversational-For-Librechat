/**
 * adapters/tts/ElevenLabsAdapter.ts
 *
 * ElevenLabs streaming TTS via their WebSocket API.
 * Returns 44.1 kHz mp3 chunks; we convert to 48 kHz PCM.
 *
 * Uses the streaming endpoint for lowest latency (xi-labs/stream-input).
 */

import axios, { CancelTokenSource } from "axios";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { ttsToWebrtc } from "../../audio/resampler";
import type { TtsAdapter, TtsChunk } from "./TtsAdapter";

export class ElevenLabsAdapter implements TtsAdapter {
  readonly name = "elevenlabs";
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

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}/stream`;

    try {
      const response = await axios.post(
        url,
        {
          text,
          model_id: config.ELEVENLABS_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          output_format: "pcm_44100", // 44100 Hz signed int16 PCM
        },
        {
          headers: {
            "xi-api-key": config.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          responseType: "stream",
          cancelToken: cancelSource.token,
          timeout: 30000,
        }
      );

      const stream = response.data as NodeJS.ReadableStream;

      for await (const rawChunk of stream) {
        if (this.cancelSource === null) {
          stream.destroy();
          return;
        }
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk as ArrayBuffer);

        // ElevenLabs pcm_44100 = 44100 Hz mono int16
        const pcm48k = ttsToWebrtc(chunk, 44100);
        yield { pcm48k, isFinal: false };
      }

      yield { pcm48k: Buffer.alloc(0), isFinal: true };
    } catch (err) {
      if (axios.isCancel(err)) {
        logger.debug({ adapter: this.name }, "Synthesis cancelled (barge-in)");
        return;
      }
      logger.error({ adapter: this.name, err }, "ElevenLabs TTS failed");
      throw err;
    } finally {
      this.cancelSource = null;
    }
  }
}
