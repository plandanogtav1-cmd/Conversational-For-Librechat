/**
 * adapters/tts/index.ts
 * Factory: instantiate the configured TTS adapter.
 */

import { config } from "../../config";
import { OpenAITtsAdapter } from "./OpenAITtsAdapter";
import { PiperAdapter } from "./PiperAdapter";
import { ElevenLabsAdapter } from "./ElevenLabsAdapter";
import type { TtsAdapter } from "./TtsAdapter";

export { type TtsAdapter, type TtsChunk } from "./TtsAdapter";

export function createTtsAdapter(): TtsAdapter {
  switch (config.TTS_PROVIDER) {
    case "openai":
      return new OpenAITtsAdapter();
    case "piper":
      return new PiperAdapter();
    case "elevenlabs":
      return new ElevenLabsAdapter();
    default: {
      const _: never = config.TTS_PROVIDER;
      throw new Error(`Unknown TTS_PROVIDER: ${String(_)}`);
    }
  }
}

/**
 * Split a long LLM response into sentence-boundary chunks.
 * TTS sounds more natural when it starts synthesising at the first sentence
 * rather than waiting for the full response.
 */
export function splitIntoSentences(text: string): string[] {
  // Split on . ! ? followed by a space or end of string; preserve trailing punctuation
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
}
