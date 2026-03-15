/**
 * adapters/tts/OpenAITtsAdapter.ts
 *
 * OpenAI TTS via streaming HTTP response.
 * Returns MP3 → decoded to PCM via a lightweight approach.
 *
 * Note: OpenAI streams the audio as a continuous MP3 body.
 * We collect in chunks, decode with the `mp3-decoder` approach,
 * and yield 48 kHz PCM.
 *
 * For lowest latency we use `tts-1` (not tts-1-hd).
 */

import axios, { CancelTokenSource } from "axios";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import { ttsToWebrtc } from "../../audio/resampler";
import type { TtsAdapter, TtsChunk } from "./TtsAdapter";

// OpenAI streams MP3; we receive the raw bytes and publish them as-is
// through LiveKit which handles the codec.  For the PCM path (Piper) we
// do proper resampling.  Here we output the raw mp3 bytes wrapped in the
// TtsChunk.pcm48k field with a note that the bridge must handle codec.
// TODO: decode MP3 → PCM with a lightweight library for strict PCM path.

export class OpenAITtsAdapter implements TtsAdapter {
  readonly name = "openai-tts";
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
        "https://api.openai.com/v1/audio/speech",
        {
          model: config.OPENAI_TTS_MODEL,
          input: text,
          voice: config.OPENAI_TTS_VOICE,
          response_format: "pcm", // 24kHz signed int16 PCM — no codec needed
          speed: 1.0,
        },
        {
          headers: {
            Authorization: `Bearer ${config.OPENAI_API_KEY}`,
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
          // Cancelled — drain and stop
          stream.destroy();
          return;
        }

        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk as ArrayBuffer);

        // OpenAI PCM format = 24 kHz mono int16; resample to 48 kHz for LiveKit
        const pcm48k = ttsToWebrtc(chunk, 24000);

        yield { pcm48k, isFinal: false };
      }

      yield { pcm48k: Buffer.alloc(0), isFinal: true };
    } catch (err) {
      if (axios.isCancel(err)) {
        logger.debug({ adapter: this.name }, "Synthesis cancelled (barge-in)");
        return;
      }
      logger.error({ adapter: this.name, err }, "TTS synthesis failed");
      throw err;
    } finally {
      this.cancelSource = null;
    }
  }
}
