/**
 * adapters/stt/WhisperAdapter.ts
 *
 * Fallback STT using a locally-running faster-whisper HTTP server.
 * Compatible with: https://github.com/ahmetoner/whisper-asr-webservice
 *
 * Because Whisper is non-streaming we buffer audio, then POST the
 * full segment when the caller calls flush().  This adds ~200–400 ms
 * latency vs Deepgram but works fully offline.
 */

import { EventEmitter } from "events";
import axios from "axios";
import FormData from "form-data"; // node built-in FormData is fine in Node 18+
import { v4 as uuid } from "uuid";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import type { SttAdapter, SttTranscript } from "./SttAdapter";

export class WhisperAdapter extends EventEmitter implements SttAdapter {
  private buffer: Buffer[] = [];
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    // Verify the Whisper service is reachable
    try {
      await axios.get(`${config.WHISPER_URL.replace("/asr", "")}/`, {
        timeout: 3000,
      });
      this._isConnected = true;
      logger.info({ adapter: "whisper" }, "Whisper ASR service reachable");
    } catch {
      logger.warn({ adapter: "whisper" }, "Whisper ASR not reachable; will retry on use");
      this._isConnected = true; // optimistic — allow buffering
    }
  }

  sendAudio(pcm16: Buffer): void {
    this.buffer.push(pcm16);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const pcm = Buffer.concat(this.buffer);
    this.buffer = [];

    // Wrap raw PCM in a minimal WAV header so Whisper can decode it
    const wav = pcmToWav(pcm, config.STT_SAMPLE_RATE, 1);

    try {
      const form = new FormData();
      form.append("audio_file", wav, {
        filename: "audio.wav",
        contentType: "audio/wav",
      });

      const res = await axios.post<{ text: string }>(
        `${config.WHISPER_URL}?task=transcribe&language=${config.DEEPGRAM_LANGUAGE.split("-")[0]}&output=json`,
        form,
        {
          headers: form.getHeaders(),
          timeout: 30000,
        }
      );

      const text = res.data?.text?.trim();
      if (!text) return;

      const t: SttTranscript = {
        speechId: uuid(),
        text,
        isFinal: true,
        receivedAt: Date.now(),
      };

      this.emit("transcript", t);
      this.emit("final", t);
    } catch (err) {
      logger.error({ adapter: "whisper", err }, "Whisper transcription failed");
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  async close(): Promise<void> {
    this.buffer = [];
    this._isConnected = false;
    this.emit("close");
  }
}

// ─── Minimal WAV header builder ───────────────────────────────────────────────

function pcmToWav(pcm16: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // subchunk1 size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm16.length, 40);

  return Buffer.concat([header, pcm16]);
}
