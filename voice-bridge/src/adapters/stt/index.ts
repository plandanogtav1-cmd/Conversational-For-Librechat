/**
 * adapters/stt/index.ts
 * Factory that returns the correct STT adapter and handles fallback.
 */

import { DeepgramAdapter } from "./DeepgramAdapter";
import { WhisperAdapter } from "./WhisperAdapter";
import { logger } from "../../utils/logger";
import type { SttAdapter } from "./SttAdapter";

export { type SttAdapter, type SttTranscript } from "./SttAdapter";

/**
 * Create an STT adapter.
 * Tries Deepgram first; wires auto-fallback to Whisper when Deepgram emits
 * DEEPGRAM_UNAVAILABLE.
 */
export async function createSttAdapter(): Promise<SttAdapter> {
  const deepgram = new DeepgramAdapter();

  deepgram.on("error", async (err: Error) => {
    if (err.message === "DEEPGRAM_UNAVAILABLE") {
      logger.warn("Deepgram unavailable — switching to Whisper fallback");
      // The bridge holds a reference to the adapter; we return a whisper instance
      // and the bridge replaces its reference on this signal.
      // We do this by emitting a special event that the bridge listens for.
      deepgram.emit("fallback_requested" as never);
    }
  });

  await deepgram.connect();
  return deepgram;
}

export async function createWhisperAdapter(): Promise<SttAdapter> {
  const whisper = new WhisperAdapter();
  await whisper.connect();
  return whisper;
}
