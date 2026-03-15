/**
 * adapters/tts/TtsAdapter.ts
 * Abstract contract every TTS adapter must implement.
 */

export interface TtsChunk {
  /** Raw 48 kHz mono int16 PCM audio data */
  pcm48k: Buffer;
  /** True when this is the last chunk for this utterance */
  isFinal: boolean;
}

/**
 * TtsAdapter — text-to-speech.
 *
 * Call `synthesizeStream(text)` which returns an async generator of PCM chunks.
 * The generator yields chunks as soon as they are available so the caller
 * can start publishing audio before synthesis is complete.
 */
export interface TtsAdapter {
  /**
   * Synthesize `text` and stream back 48 kHz mono int16 PCM chunks.
   * The adapter is responsible for resampling to 48 kHz before yielding.
   */
  synthesizeStream(text: string): AsyncGenerator<TtsChunk>;

  /**
   * Cancel any in-flight synthesis for this adapter instance.
   * Called on barge-in.
   */
  cancel(): void;

  /** Human-readable name for logging */
  readonly name: string;
}
